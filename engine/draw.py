"""Interactive Multi-Style Procedural Drawing Engine.

Supports:
  - Art styles: colored-pencil, sketch (academic graphite hatching), and oil (impasto brushwork)
  - 4s (50 frames @ 80ms) or 6s (75 frames @ 80ms) drawing duration
  - Interactive 3-stage order mask painted by the user:
      Stage 1 (Blue in mask):  Early region (drawn first, 0.00 - 0.36)
      Stage 2 (Unpainted):     Main body region (drawn in 0.00 - 0.72 when Finale is present)
      Stage 3 (Red in mask):   Finale / focal region (drawn at the end, 0.70 - 1.00, with full 6-layer quality and zero mask seams)
  - Base sweep direction: top-down, left-right, center-out, edges-in
  - Finale sweep direction: top-down, left-right, center-out
"""
import argparse
import base64
from io import BytesIO
import json
from pathlib import Path
import re
import struct
import sys
from typing import BinaryIO

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, __version__ as pillow_version

# Guard against decompression bomb images (max 64 megapixels)
Image.MAX_IMAGE_PIXELS = 64_000_000


HERE = Path(__file__).resolve().parent
PAPER = (248, 240, 219)
SKETCH_PAPER = (250, 248, 242)
OIL_CANVAS = (232, 223, 204)
STYLES = ("colored-pencil", "sketch", "oil")
SEED = 1702
FRAME_MS = 80
RENDER_EDGE = 1080
MASK_EDGE = 800
WEB_PHOTO_BYTES = 6 * 1024**2
WEB_MASK_BYTES = 3 * 1024**2
FILE_BYTES = 64 * 1024**2
FILE_EDGE = 16_384
FILE_PIXELS = 64_000_000
FILE_FORMATS = ("PNG", "JPEG", "WEBP", "GIF", "BMP", "TIFF")

PASSES = (
    # name, spacing, length, nib, opacity, default_begin, default_end
    ("construction", 1.75, 10.5, 1, 122, 0.00, 0.14),
    ("blocking", 3.6, 19.0, 4, 188, 0.07, 0.68),
    ("body", 2.4, 12.0, 2, 192, 0.15, 0.78),
    ("crosshatch", 2.1, 9.5, 1, 164, 0.22, 0.84),
    ("edge", 1.0, 4.6, 1, 212, 0.14, 0.86),
    ("finale", 0.78, 3.5, 1, 238, 0.76, 1.00),
)

SKETCH_PASSES = (
    # name, spacing, length, nib
    ("construction", 1.75, 10.5, 1),
    ("shading_base", 3.80, 18.5, 3),
    ("hatching", 2.25, 12.0, 2),
    ("crosshatch", 2.15, 9.8, 1),
    ("contour", 1.05, 4.6, 1),
    ("finale", 0.82, 3.6, 1),
)

OIL_PASSES = (
    # name, spacing, length, nib, opacity
    ("underdraw", 1.85, 11.5, 2, 168),
    ("underpaint", 9.50, 34.0, 18, 250),
    ("impasto_body", 5.60, 22.0, 11, 252),
    ("brushwork", 3.50, 14.0, 6, 252),
    ("detail", 1.55, 6.4, 3, 248),
    ("finale", 1.30, 5.0, 4, 252),
)


class InvalidInput(Exception):
    """An invalid picture or incomplete request."""


def check_pillow_version() -> None:
    stable = re.fullmatch(r"(\d+)\.\d+\.\d+(?:\.post\d+)?(?:\+[\w.]+)?", pillow_version)
    if not stable or int(stable.group(1)) < 13:
        raise RuntimeError("Pencil Studio requires Pillow >= 13.0.0. Install requirements.txt first.")


def decode_picture(
    stream: BinaryIO,
    mode: str,
    formats: tuple[str, ...],
    edge_limit: int,
    pixel_limit: int,
) -> Image.Image:
    try:
        with Image.open(stream, formats=formats) as image:
            if max(image.size) > edge_limit or image.width * image.height > pixel_limit:
                raise InvalidInput("Image dimensions exceed the input limit.")
            return image.convert(mode)
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError) as exc:
        raise InvalidInput("Unreadable or unsupported image.") from exc


def read_picture_file(path: Path, mode: str) -> Image.Image:
    with path.open("rb") as stream:
        size = stream.seek(0, 2)
        if not 0 < size <= FILE_BYTES:
            raise InvalidInput("Image file must be between 1 byte and 64 MiB.")
        stream.seek(0)
        return decode_picture(stream, mode, FILE_FORMATS, FILE_EDGE, FILE_PIXELS)


def read_web_pictures(stream: BinaryIO) -> tuple[Image.Image, Image.Image | None]:
    """Read two length-prefixed images from the local bridge and consume the pipe to EOF."""
    header = stream.read(8)
    if len(header) != 8:
        raise InvalidInput("Incomplete image request.")
    photo_size, mask_size = struct.unpack(">II", header)
    if not 0 < photo_size <= WEB_PHOTO_BYTES or mask_size > WEB_MASK_BYTES:
        raise InvalidInput("Image payload exceeds the size limit.")
    photo_data, mask_data = stream.read(photo_size), stream.read(mask_size)
    if len(photo_data) != photo_size or len(mask_data) != mask_size or stream.read(1):
        raise InvalidInput("Image payload does not match its declared size.")
    photo = decode_picture(BytesIO(photo_data), "RGB", ("JPEG", "PNG"), RENDER_EDGE, RENDER_EDGE**2)
    mask = None
    if mask_data:
        mask = decode_picture(BytesIO(mask_data), "RGBA", ("PNG",), MASK_EDGE, MASK_EDGE**2)
    return photo, mask


def colors_from_reference(reference: Image.Image) -> np.ndarray:
    """Translate photograph or digital colors to colored-pencil pigment on warm ivory paper."""
    rgb = np.asarray(reference, dtype=np.float32) / 255.0
    pigments = (rgb ** 0.84) * [215, 206, 188] + [23, 24, 36]
    y = np.mean(rgb, axis=2)
    cool = np.clip((rgb[:, :, 2] - rgb[:, :, 0]) * 3.5 + 0.08, 0, 1)
    pigments += cool[:, :, None] * [-5, 3, 18]
    warm = np.clip((rgb[:, :, 0] - rgb[:, :, 2] - 0.07) * 1.9, 0, 1)
    pigments += warm[:, :, None] * [14, 3, -7]
    pigments += np.sin(np.pi * y)[:, :, None] * [7, 6, 7]
    luminance = np.sum(pigments * [0.30, 0.54, 0.16], axis=2, keepdims=True)
    pigments = luminance + 1.11 * (pigments - luminance)
    return np.uint8(np.clip(pigments, 0, 255))


def sketch_fields_from_reference(reference: Image.Image):
    """Extract graphite tonal value, smooth base tone, darkness, dark-side edge gate, and contour field."""
    rgb = np.asarray(reference, dtype=np.float32)
    raw_y = (0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]) / 255.0
    raw_u8 = np.uint8(np.clip(raw_y * 255.0, 0, 255))
    micro_blur = np.asarray(Image.fromarray(raw_u8).filter(ImageFilter.GaussianBlur(3.2)), dtype=np.float32) / 255.0

    # Subtle micro-contrast + gentle S-curve anchored to graphite range [22, 248]
    local_y = np.clip(raw_y + 0.26 * (raw_y - micro_blur), 0.0, 1.0)
    s_curve = local_y * local_y * (3.0 - 2.0 * local_y)
    y_curve = 0.68 * local_y + 0.32 * s_curve
    g_tone = (22.0 + (y_curve ** 0.92) * 226.0).astype(np.float32)
    darkness = np.clip((248.0 - g_tone) / 226.0, 0.0, 1.0).astype(np.float32)

    tone_img = Image.fromarray(np.uint8(np.clip(g_tone, 0, 255)))
    broad_tone = np.asarray(tone_img.filter(ImageFilter.GaussianBlur(2.2)), dtype=np.float32)
    smooth_tone = np.asarray(tone_img.filter(ImageFilter.GaussianBlur(1.4)), dtype=np.float32)
    on_dark_side = g_tone <= (smooth_tone + 1.5)

    smooth_rgb = np.asarray(reference.filter(ImageFilter.GaussianBlur(1.4)), dtype=np.float32)

    if reference.height > 1:
        dy_t = np.gradient(smooth_tone, axis=0)
        dy_r = np.gradient(smooth_rgb[:, :, 0], axis=0)
        dy_b = np.gradient(smooth_rgb[:, :, 2], axis=0)
    else:
        dy_t = np.zeros_like(smooth_tone)
        dy_r = np.zeros_like(smooth_tone)
        dy_b = np.zeros_like(smooth_tone)

    if reference.width > 1:
        dx_t = np.gradient(smooth_tone, axis=1)
        dx_r = np.gradient(smooth_rgb[:, :, 0], axis=1)
        dx_b = np.gradient(smooth_rgb[:, :, 2], axis=1)
    else:
        dx_t = np.zeros_like(smooth_tone)
        dx_r = np.zeros_like(smooth_tone)
        dx_b = np.zeros_like(smooth_tone)

    p_t = np.hypot(dx_t, dy_t)
    p_r = np.hypot(dx_r, dy_r) * 0.38
    p_b = np.hypot(dx_b, dy_b) * 0.38

    power = p_t
    gx, gy = dx_t, dy_t
    use_r = p_r > power
    power = np.where(use_r, p_r, power)
    gx = np.where(use_r, dx_r, gx)
    gy = np.where(use_r, dy_r, gy)

    use_b = p_b > power
    power = np.where(use_b, p_b, power)
    gx = np.where(use_b, dx_b, gx)
    gy = np.where(use_b, dy_b, gy)

    tangent = np.arctan2(gy, gx) + np.pi / 2
    return g_tone, broad_tone, darkness, on_dark_side, power.astype(np.float32), tangent.astype(np.float32)


def kuwahara_filter(rgb: np.ndarray, radius: int) -> np.ndarray:
    """Edge-preserving 4-quadrant Kuwahara filter that turns smooth gradients into crisp painterly color planes."""
    r = max(1, int(radius))
    win = r + 1
    area = float(win * win)
    pad_rgb = np.pad(rgb, ((r, r), (r, r), (0, 0)), mode="edge")
    lum = 0.299 * pad_rgb[:, :, 0] + 0.587 * pad_rgb[:, :, 1] + 0.114 * pad_rgb[:, :, 2]

    def box_sum(arr: np.ndarray) -> np.ndarray:
        pad_axes = ((1, 0), (1, 0)) + ((0, 0),) * (arr.ndim - 2)
        p = np.pad(arr, pad_axes, mode="constant")
        cs = p.cumsum(axis=0, dtype=np.float64).cumsum(axis=1, dtype=np.float64)
        return cs[win:, win:] - cs[:-win, win:] - cs[win:, :-win] + cs[:-win, :-win]

    mean_rgb = box_sum(pad_rgb) / area
    mean_l = box_sum(lum) / area
    var_l = box_sum(lum * lum) / area - mean_l * mean_l

    h, w, _ = rgb.shape
    quad_vars = np.stack((
        var_l[0:h, 0:w],
        var_l[0:h, r:w + r],
        var_l[r:h + r, 0:w],
        var_l[r:h + r, r:w + r],
    ), axis=0)
    quad_means = np.stack((
        mean_rgb[0:h, 0:w],
        mean_rgb[0:h, r:w + r],
        mean_rgb[r:h + r, 0:w],
        mean_rgb[r:h + r, r:w + r],
    ), axis=0)

    best = np.argmin(quad_vars, axis=0)
    yy, xx = np.mgrid[:h, :w]
    return quad_means[best, yy, xx].astype(np.float32)


def oil_fields_from_reference(reference: Image.Image):
    """Extract Kuwahara-faceted rich oil pigments, flow tangents, and fine contour edges."""
    rgb = np.asarray(reference, dtype=np.float32) / 255.0
    c_rgb = 0.65 * rgb + 0.35 * (rgb * rgb * (3.0 - 2.0 * rgb))
    pigments = [7.0, 7.0, 11.0] + (c_rgb ** 0.93) * [245.0, 244.0, 240.0]

    y01 = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]
    sun = np.maximum(0.0, y01 - 0.50) * 1.65
    shade = np.maximum(0.0, 0.46 - y01) * 1.55
    pigments += sun[:, :, None] * [9.0, 4.0, -6.0]
    pigments += shade[:, :, None] * [-5.0, -1.0, 10.0]

    lum = np.sum(pigments * [0.30, 0.54, 0.16], axis=2, keepdims=True)
    raw_oil = np.clip(lum + 1.28 * (pigments - lum), 6.0, 254.0).astype(np.float32)
    lum2d = lum[:, :, 0].astype(np.float32)

    # Multi-scale Kuwahara painterly color faceting (sharp silhouettes + stepped oil planes)
    scale_r = max(1.0, max(reference.size) / 1080.0)
    broad_oil = kuwahara_filter(raw_oil, max(4, round(8 * scale_r)))
    mid_oil = kuwahara_filter(raw_oil, max(2, round(4 * scale_r)))

    lum_img = Image.fromarray(np.uint8(np.clip(lum2d, 0, 255)))
    flow_lum = np.asarray(lum_img.filter(ImageFilter.GaussianBlur(2.8)), dtype=np.float32)
    fine_lum = np.asarray(lum_img.filter(ImageFilter.GaussianBlur(1.2)), dtype=np.float32)
    on_dark_side = lum2d <= (fine_lum + 1.8)

    if reference.height > 1:
        f_dy = np.gradient(flow_lum, axis=0)
        dy_l = np.gradient(fine_lum, axis=0)
        dy_r = np.gradient(raw_oil[:, :, 0], axis=0)
    else:
        f_dy = np.zeros_like(flow_lum)
        dy_l = np.zeros_like(fine_lum)
        dy_r = np.zeros_like(fine_lum)

    if reference.width > 1:
        f_dx = np.gradient(flow_lum, axis=1)
        dx_l = np.gradient(fine_lum, axis=1)
        dx_r = np.gradient(raw_oil[:, :, 0], axis=1)
    else:
        f_dx = np.zeros_like(flow_lum)
        dx_l = np.zeros_like(fine_lum)
        dx_r = np.zeros_like(fine_lum)

    flow_tangent = (np.arctan2(f_dy, f_dx) + np.pi / 2).astype(np.float32)
    p_l = np.hypot(dx_l, dy_l)
    p_r = np.hypot(dx_r, dy_r) * 0.42
    use_r = p_r > p_l
    fine_power = np.where(use_r, p_r, p_l).astype(np.float32)
    gx = np.where(use_r, dx_r, dx_l)
    gy = np.where(use_r, dy_r, dy_l)
    fine_tangent = (np.arctan2(gy, gx) + np.pi / 2).astype(np.float32)
    return raw_oil, mid_oil, broad_oil, lum2d, on_dark_side, flow_tangent, fine_power, fine_tangent


def oil_canvas_surfaces(width: int, height: int, rng: np.random.Generator):
    """Build primed linen ground, initial weave heightmap, and raw stretched-canvas border mask."""
    y, x = np.mgrid[:height, :width]
    fine = rng.normal(0, 1, (height, width)).astype(np.float32)
    weave = 0.5 * (np.sin(x * (np.pi / 2.4)) ** 2 + np.sin(y * (np.pi / 2.4)) ** 2)

    margin = np.minimum.reduce([x, y, width - 1 - x, height - 1 - y])
    edge = 3.2 + 2.0 * np.sin(x * 0.017 + y * 0.036) + 1.7 * np.cos((x - y) * 0.085)
    border_tooth = np.uint8(np.clip(1.0 - np.clip((margin - edge + fine * 1.8) / 5.5, 0.0, 1.0), 0.0, 1.0) * 255.0)

    thread_tint = (weave - 0.5) * 16.0 + fine * 1.6
    ground_rgb = np.uint8(np.clip(np.asarray(OIL_CANVAS) + thread_tint[:, :, None], 0, 255))
    h_init = np.uint8(np.clip(96.0 + weave * 18.0 + fine * 1.5, 0, 255))
    height_rgb = np.repeat(h_init[:, :, None], 3, axis=2)
    return Image.fromarray(ground_rgb), Image.fromarray(height_rgb), Image.fromarray(border_tooth)


def shade_oil_frame(
    paint_canvas: Image.Image,
    height_canvas: Image.Image,
    ground_img: Image.Image,
    border_mask: Image.Image,
) -> Image.Image:
    """Apply creamy 3D impasto dab-edge relief & wet linseed-oil specular gloss."""
    paint = np.asarray(paint_canvas, dtype=np.float32)
    # Smooth heightfield slightly so dab edges look like thick buttery oil paint rather than sharp 1px stair-steps
    smooth_h_img = height_canvas.convert("L").filter(ImageFilter.GaussianBlur(0.85))
    h = np.asarray(smooth_h_img, dtype=np.float32)

    gx = np.zeros_like(h)
    gy = np.zeros_like(h)
    if h.shape[1] > 2:
        gx[:, 1:-1] = (h[:, 2:] - h[:, :-2]) * 0.5
    if h.shape[0] > 2:
        gy[1:-1, :] = (h[2:, :] - h[:-2, :]) * 0.5

    # Directional gallery spotlight from upper-left (-0.60, -0.75)
    lit = (0.60 * gx + 0.75 * gy) / 24.0
    pos_lit = np.minimum(np.maximum(lit, 0.0), 1.35)
    neg_lit = np.maximum(np.minimum(lit, 0.0), -1.05)

    # Warm sunlit crest + clean impasto shadow lip (gentle on bright skin so pale tones stay luminous, never muddy gray)
    bright_guard = 1.0 - 0.38 * (np.mean(paint, axis=2) / 255.0)
    diffuse = 1.0 + 0.20 * pos_lit + (0.22 * bright_guard) * neg_lit

    # Wet linseed-oil specular sheen on raised dab rims & thick highlight crests
    s = np.clip(lit * 0.80, 0.0, 1.0)
    s2 = s * s
    spec = (s2 * s2) * 0.34

    shaded = np.uint8(np.clip(paint * diffuse[:, :, None] + spec[:, :, None] * [255.0, 250.0, 240.0], 0.0, 255.0))
    return Image.composite(ground_img, Image.fromarray(shaded), border_mask)


def paper_surface(width: int, height: int, rng: np.random.Generator, style: str = "colored-pencil"):
    """Fixed paper tooth, shallow fibres (or woven linen canvas for oil) and an irregular margin."""
    y, x = np.mgrid[:height, :width]
    fine = rng.normal(0, 1, (height, width)).astype(np.float32)

    if style == "oil":
        base_paper = OIL_CANVAS
        # Orthogonal primed linen canvas weave
        weave = 0.5 * (np.sin(x * (np.pi / 2.0)) ** 2 + np.sin(y * (np.pi / 2.0)) ** 2)
        tooth = np.clip(0.010 + 0.026 * weave + 0.010 * fine, 0, 0.068)
        margin = np.minimum.reduce([x, y, width - 1 - x, height - 1 - y])
        edge = 3 + 2 * np.sin(x * 0.017 + y * 0.036) + 1.7 * np.cos((x - y) * 0.085)
        coverage = np.clip((margin - edge + fine * 1.9) / 6.5, 0, 1)
        tooth = 1 - (1 - tooth) * coverage
        thread_tint = (weave - 0.5) * 14.0 + fine * 1.4
        grain = np.uint8(np.clip(np.asarray(base_paper) + thread_tint[:, :, None], 0, 255))
        return np.uint8(tooth * 255), grain

    base_paper = SKETCH_PAPER if style == "sketch" else PAPER
    if style == "sketch":
        tooth = np.clip(0.020 + 0.032 * fine, 0, 0.16)
    else:
        tooth = np.clip(0.028 + 0.040 * fine, 0, 0.21)

    fibres = rng.integers(0, 256, (height // 3 + 1, width // 10 + 1), dtype=np.uint8)
    fibres = np.asarray(Image.fromarray(fibres).resize((width, height), Image.Resampling.BICUBIC))
    tooth += np.clip((fibres.astype(np.float32) - 160) / (540 if style == "sketch" else 450), 0, 0.16)
    margin = np.minimum.reduce([x, y, width - 1 - x, height - 1 - y])
    edge = 3 + 2 * np.sin(x * 0.017 + y * 0.036) + 1.7 * np.cos((x - y) * 0.085)
    coverage = np.clip((margin - edge + fine * 1.9) / 6.5, 0, 1)
    tooth = 1 - (1 - tooth) * coverage
    grain = np.uint8(np.clip(np.asarray(base_paper) + fine[:, :, None] * 1.5, 0, 255))
    return np.uint8(tooth * 255), grain


def surface_print(canvas: Image.Image, tooth: Image.Image, grain: Image.Image) -> Image.Image:
    return Image.composite(grain, canvas, tooth)


def relief(reference: Image.Image):
    """Smoothed tangent field turns marks along architecture, hair strands and facial contours."""
    blurred = reference.filter(ImageFilter.GaussianBlur(1.4)).convert("L")
    values = np.asarray(blurred, dtype=np.float32)
    dy = np.gradient(values, axis=0) if reference.height > 1 else np.zeros_like(values)
    dx = np.gradient(values, axis=1) if reference.width > 1 else np.zeros_like(values)
    return np.hypot(dx, dy), np.arctan2(dy, dx) + np.pi / 2


def positions(width: int, height: int, spacing: float, rng: np.random.Generator):
    rows, cols = np.mgrid[0:height:spacing, 0:width:spacing]
    x = np.minimum(cols + rng.random(cols.shape) * spacing, width - 1)
    y = np.minimum(rows + rng.random(rows.shape) * spacing, height - 1)
    return x.ravel().astype(int), y.ravel().astype(int)


def directional_sweep(
    fx: np.ndarray,
    fy: np.ndarray,
    direction: str,
    cx: float = 0.5,
    cy: float = 0.5,
) -> np.ndarray:
    if direction == "left-right":
        return fx + 0.04 * fy
    if direction == "center-out":
        return np.hypot(fx - cx, fy - cy)
    if direction == "edges-in":
        return -np.hypot(fx - cx, fy - cy)
    # Default: top-down
    return fy + 0.04 * fx


def parse_order_mask(
    mask: Image.Image | None,
    width: int,
    height: int,
    power: np.ndarray,
    *,
    pigment: np.ndarray | None = None,
    darkness: np.ndarray | None = None,
    on_dark_side: np.ndarray | None = None,
):
    """Return soft feathered weights (early_weight, finale_weight, accent_mask, has_user_finale)."""
    early_weight = np.zeros((height, width), dtype=np.float32)
    finale_weight = np.zeros((height, width), dtype=np.float32)
    has_user_finale = False

    if mask is not None:
        resized = mask.resize((width, height), Image.Resampling.BILINEAR)
        arr = np.asarray(resized)
        alpha = arr[:, :, 3] > 40
        raw_finale = (alpha & (arr[:, :, 0] > 150) & (arr[:, :, 0] > arr[:, :, 2])).astype(np.uint8) * 255
        raw_early = (alpha & (arr[:, :, 2] > 150) & (arr[:, :, 2] > arr[:, :, 0])).astype(np.uint8) * 255
        has_user_finale = bool(np.any(raw_finale > 0))
        feather_radius = max(4.0, min(width, height) * 0.015)
        if has_user_finale:
            blurred_f = Image.fromarray(raw_finale).filter(ImageFilter.GaussianBlur(feather_radius))
            finale_weight = np.asarray(blurred_f, dtype=np.float32) / 255.0
        if np.any(raw_early > 0):
            blurred_e = Image.fromarray(raw_early).filter(ImageFilter.GaussianBlur(feather_radius))
            early_weight = np.asarray(blurred_e, dtype=np.float32) / 255.0

    if darkness is not None:
        dark_locus = on_dark_side if on_dark_side is not None else np.ones_like(power, dtype=bool)
        auto_accent = dark_locus & (((darkness > 0.42) & (power > 2.4)) | (power > 6.8))
        if has_user_finale:
            accent_mask = ((finale_weight > 0.25) & dark_locus & (power > 1.6)) | auto_accent
        else:
            accent_mask = auto_accent
    else:
        assert pigment is not None
        r = pigment[:, :, 0].astype(np.float32)
        b = pigment[:, :, 2].astype(np.float32)
        auto_accent = (((r - b) > 38) & (power > 2.2)) | (power > 6.8)
        if has_user_finale:
            accent_mask = ((finale_weight > 0.25) & (power > 1.6)) | auto_accent
        else:
            accent_mask = auto_accent

    return early_weight, finale_weight, accent_mask, has_user_finale


def schedule_moments(
    fx: np.ndarray,
    fy: np.ndarray,
    w_early: np.ndarray,
    w_finale: np.ndarray,
    pass_rank: float,
    direct_rank: float,
    is_construction: bool,
    has_user_finale: bool,
    hold_finale: bool,
    sketch_first: bool,
    base_direction: str,
    finale_direction: str,
    rng: np.random.Generator,
) -> np.ndarray:
    n = len(fx)
    base_sw = directional_sweep(fx, fy, base_direction) + rng.normal(0, 0.015, n)
    b_low, b_high = np.percentile(base_sw, (1.0, 99.0))
    base_sw = np.clip((base_sw - b_low) / max(1e-5, b_high - b_low), 0, 1)

    fin_mask_pts = w_finale > 0.15
    if np.any(fin_mask_pts):
        fin_cx = float(np.mean(fx[fin_mask_pts]))
        fin_cy = float(np.mean(fy[fin_mask_pts]))
        fin_sw = directional_sweep(fx, fy, finale_direction, fin_cx, fin_cy) + rng.normal(0, 0.012, n)
        f_low, f_high = np.percentile(fin_sw[fin_mask_pts], (1.0, 99.0))
    else:
        fin_sw = directional_sweep(fx, fy, finale_direction) + rng.normal(0, 0.012, n)
        f_low, f_high = np.percentile(fin_sw, (1.0, 99.0))
    fin_sw = np.clip((fin_sw - f_low) / max(1e-5, f_high - f_low), 0, 1)

    use_finale_delay = bool(has_user_finale and hold_finale)

    if sketch_first:
        if is_construction:
            moment = 0.00 + 0.24 * base_sw
        else:
            color_norm = np.clip(0.82 * base_sw + 0.18 * pass_rank, 0.0, 1.0)
            color_norm_fin = np.clip(0.84 * fin_sw + 0.16 * pass_rank, 0.0, 1.0)
            if use_finale_delay:
                body_time = 0.25 + color_norm * 0.49 * (1.0 - 0.40 * w_early)
                finale_time = 0.74 + color_norm_fin * 0.26
                moment = (1.0 - w_finale) * body_time + w_finale * finale_time
            else:
                moment = 0.25 + color_norm * 0.75 * (1.0 - 0.35 * w_early)
    else:
        direct_norm = np.clip(0.82 * base_sw + 0.18 * direct_rank, 0.0, 1.0)
        direct_norm_fin = np.clip(0.84 * fin_sw + 0.16 * direct_rank, 0.0, 1.0)
        if use_finale_delay:
            body_time = direct_norm * 0.72 * (1.0 - 0.40 * w_early)
            finale_time = 0.74 + direct_norm_fin * 0.26
            moment = (1.0 - w_finale) * body_time + w_finale * finale_time
        else:
            moment = direct_norm * (1.0 - 0.35 * w_early)

    return np.clip(moment, 0.0, 1.0)


def pencil_pass(
    mode,
    spacing,
    length,
    nib,
    opacity,
    begin,
    end,
    pigment,
    broad,
    power,
    tangent,
    early_weight,
    finale_weight,
    accent_mask,
    has_user_finale,
    hold_finale,
    sketch_first,
    base_direction,
    finale_direction,
    rng,
):
    h, w, _ = pigment.shape
    x, y = positions(w, h, spacing, rng)
    fx, fy = x / w, y / h
    edge = power[y, x]

    keep = np.ones(x.shape, dtype=bool)
    if mode == "construction":
        if sketch_first:
            keep = (edge > 2.6) & (rng.random(len(x)) < np.clip(edge / 11.5, 0.22, 0.88))
        else:
            keep = (edge > 4.2) & (rng.random(len(x)) < np.minimum(edge / 18, 0.68))
    elif mode == "edge":
        keep = (edge > 2.4) & (rng.random(len(x)) < np.clip(edge / 11, 0.22, 0.96))
    elif mode == "finale":
        keep = accent_mask[y, x]

    x, y, fx, fy, edge = (arr[keep] for arr in (x, y, fx, fy, edge))
    n = len(x)
    if n == 0:
        return (
            np.zeros((0, 4), dtype=int),
            np.zeros((0, 4), dtype=np.uint8),
            np.zeros(0, dtype=int),
            np.zeros(0, dtype=np.float32),
        )

    w_early = early_weight[y, x]
    w_finale = finale_weight[y, x]

    field = 0.17 * np.sin(13 * fx + 9 * fy) + 0.08 * np.cos(29 * fx - 15 * fy)
    angle = -0.86 + field
    if mode == "crosshatch":
        angle += 0.76
    edge_weight = np.clip((edge - 1.6) / 9.2, 0, 1)
    target = tangent[y, x]
    angle = 0.5 * np.arctan2(
        (1 - edge_weight) * np.sin(2 * angle) + edge_weight * np.sin(2 * target),
        (1 - edge_weight) * np.cos(2 * angle) + edge_weight * np.cos(2 * target),
    )
    angle += rng.normal(0, 0.09 if mode == "finale" else 0.12, n)
    span = length * rng.uniform(0.56, 1.46, n) / (1 + edge * 0.07)
    if mode == "construction":
        span = rng.uniform(3.6, 11.0, n)
    elif mode == "finale":
        span = rng.uniform(1.8, 4.8, n) / (1 + edge * 0.05)
    span = np.maximum(span, 1.5)
    dx, dy = np.cos(angle) * span / 2, np.sin(angle) * span / 2
    center = pigment[y, x].astype(np.int16)

    def tip(direction):
        reach = np.ones(n, dtype=np.float32)
        threshold = 18 if mode in ("edge", "finale") else 23
        for step in (0.25, 0.50, 0.75, 1.0):
            px = np.clip(np.rint(x + direction * dx * step).astype(int), 0, w - 1)
            py = np.clip(np.rint(y + direction * dy * step).astype(int), 0, h - 1)
            difference = np.abs(pigment[py, px].astype(np.int16) - center)
            crossing = np.max(difference, axis=1) > threshold
            reach[crossing] = np.minimum(reach[crossing], step - 0.2)
        return np.column_stack((x + direction * dx * reach, y + direction * dy * reach)).round().astype(int)

    start, end_pt = tip(-1), tip(1)
    base = (broad if mode == "blocking" else pigment)[y, x].astype(np.float32)
    if mode == "construction":
        if sketch_first:
            base = base * 0.34 + [58, 54, 62]
            opacity = min(230, int(opacity * 1.38))
        else:
            base = base * 0.26 + [66, 63, 74]
    elif mode == "blocking":
        base = 0.89 * base + np.array(PAPER) * 0.11
    spread = {"blocking": 5, "body": 7, "crosshatch": 10, "finale": 2.5}.get(mode, 4)
    base += rng.normal(0, spread, (n, 1))
    leads = np.array([[-5, -2, 7], [7, 1, -6], [1, 3, 4], [0, -4, -3]])
    base += leads[rng.integers(0, len(leads), n)] * (0.45 if mode == "finale" else 1.0)
    if mode == "crosshatch":
        base -= 6
    colors = np.column_stack((base, rng.uniform(opacity * 0.78, opacity, n)))
    colors = np.clip(colors, 0, 255).astype(np.uint8)
    widths = np.clip(np.rint(nib * rng.uniform(0.75, 1.2, n) / (1 + edge / 25)), 1, nib).astype(int)

    pass_rank = {
        "construction": 0.00,
        "blocking": 0.00,
        "body": 0.28,
        "crosshatch": 0.55,
        "edge": 0.78,
        "finale": 1.00,
    }.get(mode, 0.50)
    direct_rank = {
        "construction": 0.00,
        "blocking": 0.16,
        "body": 0.38,
        "crosshatch": 0.60,
        "edge": 0.80,
        "finale": 1.00,
    }.get(mode, 0.50)

    moment = schedule_moments(
        fx,
        fy,
        w_early,
        w_finale,
        pass_rank,
        direct_rank,
        mode == "construction",
        has_user_finale,
        hold_finale,
        sketch_first,
        base_direction,
        finale_direction,
        rng,
    )
    return np.column_stack((start, end_pt)), colors, widths, moment


def sketch_pass(
    mode,
    spacing,
    length,
    nib,
    g_tone,
    broad_tone,
    darkness,
    on_dark_side,
    power,
    tangent,
    early_weight,
    finale_weight,
    accent_mask,
    has_user_finale,
    hold_finale,
    sketch_first,
    base_direction,
    finale_direction,
    rng,
):
    h, w = g_tone.shape
    x, y = positions(w, h, spacing, rng)
    fx, fy = x / w, y / h
    edge = power[y, x]
    dark = darkness[y, x]
    dark_side = on_dark_side[y, x]
    u = rng.random(len(x))

    if mode == "construction":
        min_edge = 2.6 if sketch_first else 4.2
        scale_edge = 11.5 if sketch_first else 18.0
        keep = dark_side & (edge > min_edge) & (u < np.clip(edge / scale_edge, 0.22, 0.88))
    elif mode == "shading_base":
        keep = (dark > 0.11) & (u < np.clip((dark - 0.09) * 1.50, 0.0, 0.94))
    elif mode == "hatching":
        keep = (dark > 0.06) & (u < np.clip((dark - 0.04) * 1.70, 0.08, 0.98))
    elif mode == "crosshatch":
        keep = (dark > 0.24) & (u < np.clip((dark - 0.22) * 1.85, 0.0, 0.96))
    elif mode == "contour":
        keep = dark_side & (edge > 2.4) & (u < np.clip(edge / 11.0, 0.22, 0.96))
    else:  # finale
        deep_core = (dark > 0.64) & (u < np.clip((dark - 0.60) * 2.0, 0.0, 0.88))
        keep = accent_mask[y, x] | deep_core

    x, y, fx, fy, edge, dark = (arr[keep] for arr in (x, y, fx, fy, edge, dark))
    n = len(x)
    if n == 0:
        return (
            np.zeros((0, 4), dtype=int),
            np.zeros((0, 4), dtype=np.uint8),
            np.zeros(0, dtype=int),
            np.zeros(0, dtype=np.float32),
        )

    w_early = early_weight[y, x]
    w_finale = finale_weight[y, x]

    field = 0.14 * np.sin(13 * fx + 9 * fy) + 0.07 * np.cos(29 * fx - 15 * fy)
    target = tangent[y, x]

    if mode in ("construction", "contour"):
        base_angle = -0.84 + field
        ew = np.clip((edge - 1.4) / 6.5, 0.45, 1.0)
        sigma = 0.08
    elif mode == "shading_base":
        base_angle = -0.78 + field * 0.7
        ew = np.clip((edge - 2.0) / 11.0, 0.0, 0.40)
        sigma = 0.07
    elif mode == "crosshatch":
        base_angle = -0.84 + 0.78 + field
        ew = np.clip((edge - 1.8) / 10.0, 0.0, 0.55)
        sigma = 0.09
    elif mode == "finale":
        on_edge = edge > 2.0
        base_angle = np.where(on_edge, -0.84 + field, -0.16 + field)
        ew = np.where(on_edge, np.clip((edge - 1.4) / 6.0, 0.55, 1.0), 0.25)
        sigma = 0.075
    else:  # hatching
        base_angle = -0.84 + field
        ew = np.clip((edge - 1.6) / 9.2, 0.0, 0.85)
        sigma = 0.085

    angle = 0.5 * np.arctan2(
        (1.0 - ew) * np.sin(2.0 * base_angle) + ew * np.sin(2.0 * target),
        (1.0 - ew) * np.cos(2.0 * base_angle) + ew * np.cos(2.0 * target),
    )
    angle += rng.normal(0.0, sigma, n)

    span = length * rng.uniform(0.58, 1.42, n) / (1.0 + edge * 0.07)
    if mode == "construction":
        span = rng.uniform(3.6, 11.0, n)
    elif mode == "finale":
        span = rng.uniform(1.8, 4.6, n) / (1.0 + edge * 0.05)
    span = np.maximum(span, 1.5)
    dx, dy = np.cos(angle) * span / 2.0, np.sin(angle) * span / 2.0
    center_tone = g_tone[y, x]

    def tip(direction):
        reach = np.ones(n, dtype=np.float32)
        threshold = 17.0 if mode in ("contour", "finale") else 22.0
        for step in (0.25, 0.50, 0.75, 1.0):
            px = np.clip(np.rint(x + direction * dx * step).astype(int), 0, w - 1)
            py = np.clip(np.rint(y + direction * dy * step).astype(int), 0, h - 1)
            crossing = np.abs(g_tone[py, px] - center_tone) > threshold
            reach[crossing] = np.minimum(reach[crossing], step - 0.2)
        return np.column_stack((x + direction * dx * reach, y + direction * dy * reach)).round().astype(int)

    start, end_pt = tip(-1), tip(1)
    local_broad = broad_tone[y, x]

    # Tonal-anchored graphite grades so multi-pass hatching converges to true values without muddy halos
    if mode == "construction":
        if sketch_first:
            lead_val = center_tone * 0.42 + 64.0
            alpha_max = np.full(n, 162.0, dtype=np.float32)
        else:
            lead_val = center_tone * 0.55 + 56.0
            alpha_max = np.full(n, 122.0, dtype=np.float32)
    elif mode == "shading_base":
        lead_val = 0.87 * local_broad + 0.13 * SKETCH_PAPER[0]
        alpha_max = np.full(n, 152.0, dtype=np.float32)
    elif mode == "hatching":
        lead_val = center_tone - 8.0 * (1.0 - dark * 0.35)
        alpha_max = np.full(n, 184.0, dtype=np.float32)
    elif mode == "crosshatch":
        lead_val = center_tone - 9.0
        alpha_max = np.full(n, 162.0, dtype=np.float32)
    elif mode == "contour":
        lead_val = center_tone - np.clip(edge * 0.95, 3.0, 18.0)
        alpha_max = np.full(n, 210.0, dtype=np.float32)
    else:  # finale
        lead_val = center_tone - np.clip(edge * 0.85 + dark * 7.0, 3.0, 16.0)
        alpha_max = np.full(n, 232.0, dtype=np.float32)

    spread = {"shading_base": 4.5, "hatching": 6.5, "crosshatch": 8.5, "finale": 2.5}.get(mode, 4.0)
    jitter = rng.normal(0.0, spread, n)
    gr = np.clip(lead_val + jitter - 1.0, 18.0, 242.0)
    gg = np.clip(lead_val + jitter, 18.0, 242.0)
    gb = np.clip(lead_val + jitter + 2.0, 20.0, 245.0)
    ga = alpha_max * rng.uniform(0.78, 1.0, n)
    colors = np.column_stack((gr, gg, gb, ga)).round().clip(0, 255).astype(np.uint8)
    widths = np.clip(np.rint(nib * rng.uniform(0.75, 1.2, n) / (1.0 + edge / 25.0)), 1, nib).astype(int)

    pass_rank = {
        "construction": 0.00,
        "shading_base": 0.00,
        "hatching": 0.28,
        "crosshatch": 0.55,
        "contour": 0.78,
        "finale": 1.00,
    }.get(mode, 0.50)
    direct_rank = {
        "construction": 0.00,
        "shading_base": 0.16,
        "hatching": 0.38,
        "crosshatch": 0.60,
        "contour": 0.80,
        "finale": 1.00,
    }.get(mode, 0.50)

    moment = schedule_moments(
        fx,
        fy,
        w_early,
        w_finale,
        pass_rank,
        direct_rank,
        mode == "construction",
        has_user_finale,
        hold_finale,
        sketch_first,
        base_direction,
        finale_direction,
        rng,
    )
    return np.column_stack((start, end_pt)), colors, widths, moment


def oil_pass(
    mode,
    spacing,
    length,
    nib,
    opacity,
    raw_oil,
    mid_oil,
    broad_oil,
    lum,
    on_dark_side,
    flow_tangent,
    fine_power,
    fine_tangent,
    early_weight,
    finale_weight,
    accent_mask,
    has_user_finale,
    hold_finale,
    sketch_first,
    base_direction,
    finale_direction,
    rng,
):
    h, w, _ = raw_oil.shape
    x, y = positions(w, h, spacing, rng)
    fx, fy = x / w, y / h
    edge = fine_power[y, x]
    l_val = lum[y, x]
    dark_side = on_dark_side[y, x]
    u = rng.random(len(x))

    if mode == "underdraw":
        min_edge = 2.6 if sketch_first else 4.5
        scale_edge = 11.5 if sketch_first else 18.0
        keep = dark_side & (edge > min_edge) & (u < np.clip(edge / scale_edge, 0.24, 0.88))
    elif mode == "brushwork":
        # Multi-scale Hertzmann gating: medium brush refines structural transitions, leaving broad impasto dabs visible on flat planes
        keep = (edge > 2.2) & (u < np.clip(edge / 7.5, 0.25, 0.92))
    elif mode == "detail":
        keep = dark_side & (edge > 3.2) & (u < np.clip(edge / 10.5, 0.30, 0.96))
    elif mode == "finale":
        spec_keep = (l_val > 240.0) & (edge > 3.0) & (u < 0.65)
        keep = (accent_mask[y, x] & (edge > 2.6)) | spec_keep
    else:
        keep = np.ones(x.shape, dtype=bool)

    x, y, fx, fy, edge, l_val = (arr[keep] for arr in (x, y, fx, fy, edge, l_val))
    n = len(x)
    if n == 0:
        return (
            np.zeros((0, 6), dtype=int),
            np.zeros((0, 4), dtype=np.uint8),
            np.zeros(0, dtype=int),
            None,
            np.zeros(0, dtype=np.float32),
        )

    is_specular = (mode == "finale") & (l_val > 240.0)
    w_early = early_weight[y, x]
    w_finale = finale_weight[y, x]

    use_fine = mode in ("underdraw", "detail", "finale")
    swirl = 0.28 * np.sin(8.0 * fx + 6.2 * fy) + 0.15 * np.cos(16.0 * fx - 9.5 * fy)
    default_angle = -0.66 + swirl
    tgt_field = fine_tangent if use_fine else flow_tangent
    tgt = tgt_field[y, x]
    if use_fine:
        ew = np.clip((edge - 1.2) / 5.2, 0.68, 1.0)
        sigma = 0.06
    else:
        ew = np.clip((edge - 0.8) / 5.8, 0.34, 0.96)
        sigma = 0.12

    angle = 0.5 * np.arctan2(
        (1.0 - ew) * np.sin(2.0 * default_angle) + ew * np.sin(2.0 * tgt),
        (1.0 - ew) * np.cos(2.0 * default_angle) + ew * np.cos(2.0 * tgt),
    ) + rng.normal(0.0, sigma, n)

    span = np.maximum(2.5, length * rng.uniform(0.68, 1.36, n) / (1.0 + edge * 0.048))
    half = span * 0.5

    # Broad passes sample Kuwahara painterly color planes; fine passes sample un-erased raw_oil so thin lines stay crisp!
    if mode == "underpaint":
        ref_field = broad_oil
        stop_field = broad_oil
        threshold = 36.0
    elif mode == "impasto_body":
        ref_field = 0.35 * mid_oil + 0.65 * broad_oil
        stop_field = mid_oil
        threshold = 26.0
    elif mode == "brushwork":
        ref_field = mid_oil
        stop_field = raw_oil
        threshold = 21.0
    else:
        ref_field = raw_oil
        stop_field = raw_oil
        threshold = 17.0

    center_rgb = ref_field[y, x]

    def trace_curved_end(direction: float):
        dx1 = np.cos(angle) * half * 0.5 * direction
        dy1 = np.sin(angle) * half * 0.5 * direction
        mx = np.clip(x + dx1, 0, w - 1)
        my = np.clip(y + dy1, 0, h - 1)
        mi_x = np.rint(mx).astype(int)
        mi_y = np.rint(my).astype(int)

        diff1 = np.max(np.abs(stop_field[mi_y, mi_x] - center_rgb), axis=1)
        stop1 = diff1 > threshold

        a2 = tgt_field[mi_y, mi_x].copy()
        low_p = fine_power[mi_y, mi_x] < 1.1
        a2 = np.where(low_p, angle, a2)
        flip = np.cos(a2 - angle) < 0.0
        a2 = np.where(flip, a2 + np.pi, a2)
        blend_a = angle + 0.55 * np.arctan2(np.sin(a2 - angle), np.cos(a2 - angle))

        ex = np.clip(mx + np.cos(blend_a) * half * 0.5 * direction, 0, w - 1)
        ey = np.clip(my + np.sin(blend_a) * half * 0.5 * direction, 0, h - 1)
        ei_x = np.rint(ex).astype(int)
        ei_y = np.rint(ey).astype(int)

        diff2 = np.max(np.abs(stop_field[ei_y, ei_x] - center_rgb), axis=1)
        stop2 = (~stop1) & (diff2 > threshold)

        out_x = np.where(stop1, x + dx1 * 0.45, np.where(stop2, mx, ex))
        out_y = np.where(stop1, y + dy1 * 0.45, np.where(stop2, my, ey))
        return out_x, out_y

    x0, y0 = trace_curved_end(-1.0)
    x1, y1 = trace_curved_end(1.0)
    paths = np.column_stack((x0, y0, x, y, x1, y1)).round().astype(int)

    if mode == "underdraw":
        base = np.column_stack((
            l_val * 0.34 + 84.0,
            l_val * 0.27 + 55.0,
            l_val * 0.21 + 38.0,
        ))
        eff_opacity = 168.0 if sketch_first else 108.0
    else:
        base = center_rgb.copy()
        shifts = np.array([
            [14.0, 5.0, -11.0],
            [-11.0, 3.0, 14.0],
            [8.0, 9.0, -7.0],
            [-8.0, -5.0, 10.0],
            [0.0, 0.0, 0.0],
        ], dtype=np.float32)
        shift_scale = {
            "underpaint": 0.95,
            "impasto_body": 1.15,
            "brushwork": 0.80,
        }.get(mode, 0.25)
        base += shifts[rng.integers(0, len(shifts), n)] * shift_scale
        base += rng.normal(0.0, 3.0 if use_fine else 6.0, (n, 1))
        eff_opacity = float(opacity)

    base_clamped = np.clip(base, 5.0, 255.0)
    alphas = rng.uniform(eff_opacity * 0.94, eff_opacity, n)
    colors = np.column_stack((base_clamped, alphas)).round().clip(0, 255).astype(np.uint8)

    edge_div = 22.0 if use_fine else 42.0
    widths = np.clip(np.rint(nib * rng.uniform(0.84, 1.20, n) / (1.0 + edge / edge_div)), 2 if not use_fine else 1, nib + 3).astype(int)
    if np.any(is_specular):
        widths = np.where(is_specular, np.maximum(widths, 5), widths)

    # Creamy flat-plateau heightfield dab with subtle bristle streak (3D cliff occurs cleanly at outer dab edge!)
    impasto_data = None
    if mode in ("underpaint", "impasto_body", "brushwork") or np.any(is_specular):
        dx_s = x1 - x0
        dy_s = y1 - y0
        s_len = np.hypot(dx_s, dy_s)
        valid = (widths >= 4) & (s_len >= 3.0)
        if mode == "finale":
            valid = valid & is_specular
        if np.any(valid):
            safe_len = np.where(s_len > 1e-4, s_len, 1.0)
            nx = -dy_s / safe_len
            ny = dx_s / safe_len

            off_b = widths * 0.24
            bristle_l = np.column_stack((
                x0 - nx * off_b, y0 - ny * off_b,
                x - nx * off_b, y - ny * off_b,
                x1 - nx * off_b, y1 - ny * off_b,
            )).round().astype(int)
            bristle_r = np.column_stack((
                x0 + nx * off_b, y0 + ny * off_b,
                x + nx * off_b, y + ny * off_b,
                x1 + nx * off_b, y1 + ny * off_b,
            )).round().astype(int)

            streak_warm = np.column_stack((np.clip(base_clamped + [8.0, 6.0, 3.0], 0.0, 255.0), np.full(n, 145.0))).round().astype(np.uint8)
            streak_cool = np.column_stack((np.clip(base_clamped - [7.0, 6.0, 5.0], 0.0, 255.0), np.full(n, 135.0))).round().astype(np.uint8)
            bristle_w = np.where(valid, np.maximum(1, np.rint(widths * 0.20).astype(int)), 0)
            # Randomize each dab's plateau height slightly [172..228] so overlapping dabs step over each other like real palette-knife/brush layers!
            dab_h = rng.integers(172, 232, n, dtype=np.uint8)
            impasto_data = (bristle_l, bristle_r, streak_warm, streak_cool, bristle_w, dab_h)

    pass_rank = {
        "underdraw": 0.00,
        "underpaint": 0.00,
        "impasto_body": 0.28,
        "brushwork": 0.55,
        "detail": 0.78,
        "finale": 1.00,
    }.get(mode, 0.50)
    direct_rank = {
        "underdraw": 0.00,
        "underpaint": 0.16,
        "impasto_body": 0.38,
        "brushwork": 0.60,
        "detail": 0.80,
        "finale": 1.00,
    }.get(mode, 0.50)

    moment = schedule_moments(
        fx,
        fy,
        w_early,
        w_finale,
        pass_rank,
        direct_rank,
        mode == "underdraw",
        has_user_finale,
        hold_finale,
        sketch_first,
        base_direction,
        finale_direction,
        rng,
    )
    return paths, colors, widths, impasto_data, moment


def render(
    reference: Image.Image,
    destination: Path | None,
    mask_path: Path | None = None,
    style: str = "colored-pencil",
    duration_sec: int = 4,
    base_direction: str = "top-down",
    finale_direction: str = "top-down",
    hold_finale: bool = True,
    sketch_first: bool = True,
    *,
    mask: Image.Image | None = None,
):
    if mask_path is not None and mask_path.exists():
        mask = read_picture_file(mask_path, "RGBA")
    style = style if style in STYLES else "colored-pencil"
    duration_sec = 6 if duration_sec == 6 else 4
    frame_count = int((duration_sec * 1000) // FRAME_MS)  # 50 frames (4s) or 75 frames (6s)
    rng = np.random.default_rng(SEED)

    # Cap working dimension to 1080px for crisp detail and fast interactive turnaround
    if max(reference.size) > RENDER_EDGE:
        scale = RENDER_EDGE / max(reference.size)
        new_size = (max(1, round(reference.width * scale)), max(1, round(reference.height * scale)))
        reference = reference.resize(new_size, Image.Resampling.LANCZOS)

    base_paper = SKETCH_PAPER if style == "sketch" else OIL_CANVAS if style == "oil" else PAPER
    height_canvas = None
    h_draw = None
    oil_ground = None
    oil_border = None
    tooth = None
    grain = None

    if style == "oil":
        oil_ground, height_canvas, oil_border = oil_canvas_surfaces(*reference.size, rng)
        canvas = oil_ground.copy()
        pencil = ImageDraw.Draw(canvas, "RGBA")
        h_draw = ImageDraw.Draw(height_canvas, "RGBA")
        frames = [shade_oil_frame(canvas, height_canvas, oil_ground, oil_border)]
    else:
        tooth, grain = (Image.fromarray(a) for a in paper_surface(*reference.size, rng, style=style))
        canvas = Image.new("RGB", reference.size, base_paper)
        pencil = ImageDraw.Draw(canvas, "RGBA")
        frames = [surface_print(canvas, tooth, grain)]

    timeline = [[] for _ in range(frame_count)]
    count = 0

    if style == "sketch":
        g_tone, broad_tone, darkness, on_dark_side, power, tangent = sketch_fields_from_reference(reference)
        early_weight, finale_weight, accent_mask, has_user_finale = parse_order_mask(
            mask,
            reference.width,
            reference.height,
            power,
            darkness=darkness,
            on_dark_side=on_dark_side,
        )
        for name, spacing, length, nib in SKETCH_PASSES:
            paths, colors, widths, moment = sketch_pass(
                name,
                spacing,
                length,
                nib,
                g_tone,
                broad_tone,
                darkness,
                on_dark_side,
                power,
                tangent,
                early_weight,
                finale_weight,
                accent_mask,
                has_user_finale,
                hold_finale,
                sketch_first,
                base_direction,
                finale_direction,
                rng,
            )
            if len(paths) == 0:
                continue
            frame_index = 1 + np.rint(moment * (frame_count - 2)).astype(int)
            frame_index = np.clip(frame_index, 1, frame_count - 1)
            order = np.argsort(moment, kind="stable")
            for index in range(1, frame_count):
                marks = order[frame_index[order] == index]
                if len(marks):
                    timeline[index].append((paths[marks], colors[marks], widths[marks], None))
            count += len(paths)
            print(f"[sketch] {name}: {len(paths):,} marks", file=sys.stderr, flush=True)
    elif style == "oil":
        raw_oil, mid_oil, broad_oil, lum2d, on_dark_side, flow_tangent, fine_power, fine_tangent = oil_fields_from_reference(reference)
        early_weight, finale_weight, accent_mask, has_user_finale = parse_order_mask(
            mask,
            reference.width,
            reference.height,
            fine_power,
            pigment=np.uint8(np.clip(raw_oil, 0, 255)),
        )
        for name, spacing, length, nib, opacity in OIL_PASSES:
            paths, colors, widths, impasto_data, moment = oil_pass(
                name,
                spacing,
                length,
                nib,
                opacity,
                raw_oil,
                mid_oil,
                broad_oil,
                lum2d,
                on_dark_side,
                flow_tangent,
                fine_power,
                fine_tangent,
                early_weight,
                finale_weight,
                accent_mask,
                has_user_finale,
                hold_finale,
                sketch_first,
                base_direction,
                finale_direction,
                rng,
            )
            if len(paths) == 0:
                continue
            frame_index = 1 + np.rint(moment * (frame_count - 2)).astype(int)
            frame_index = np.clip(frame_index, 1, frame_count - 1)
            order = np.argsort(moment, kind="stable")
            for index in range(1, frame_count):
                marks = order[frame_index[order] == index]
                if len(marks):
                    sub_impasto = None
                    if impasto_data is not None:
                        bl, br, sw_c, sc_c, bw, dh = impasto_data
                        sub_impasto = (
                            bl[marks],
                            br[marks],
                            sw_c[marks],
                            sc_c[marks],
                            bw[marks],
                            dh[marks],
                        )
                    timeline[index].append((paths[marks], colors[marks], widths[marks], sub_impasto))
            count += len(paths)
            print(f"[oil] {name}: {len(paths):,} marks", file=sys.stderr, flush=True)
    else:
        pigment = colors_from_reference(reference)
        broad = np.asarray(Image.fromarray(pigment).filter(ImageFilter.GaussianBlur(2.0)))
        power, tangent = relief(reference)
        early_weight, finale_weight, accent_mask, has_user_finale = parse_order_mask(
            mask, reference.width, reference.height, power, pigment=pigment
        )
        for name, spacing, length, nib, opacity, begin, end in PASSES:
            paths, colors, widths, moment = pencil_pass(
                name,
                spacing,
                length,
                nib,
                opacity,
                begin,
                end,
                pigment,
                broad,
                power,
                tangent,
                early_weight,
                finale_weight,
                accent_mask,
                has_user_finale,
                hold_finale,
                sketch_first,
                base_direction,
                finale_direction,
                rng,
            )
            if len(paths) == 0:
                continue
            frame_index = 1 + np.rint(moment * (frame_count - 2)).astype(int)
            frame_index = np.clip(frame_index, 1, frame_count - 1)
            order = np.argsort(moment, kind="stable")
            for index in range(1, frame_count):
                marks = order[frame_index[order] == index]
                if len(marks):
                    timeline[index].append((paths[marks], colors[marks], widths[marks], None))
            count += len(paths)
            print(f"[colored-pencil] {name}: {len(paths):,} marks", file=sys.stderr, flush=True)

    for batch in timeline[1:]:
        for paths, colors, widths, sub_impasto in batch:
            if sub_impasto is None:
                use_joint = "curve" if paths.shape[1] > 4 else None
                for path, color, width in zip(paths.tolist(), colors.tolist(), widths.tolist()):
                    pencil.line(path, fill=tuple(color), width=width, joint=use_joint)
                    if h_draw is not None and width >= 2:
                        h_draw.line(path, fill=(102, 102, 102, 165), width=width + 1, joint=use_joint)
                        h_draw.line(path, fill=(184, 184, 184, 195), width=width, joint=use_joint)
            else:
                assert h_draw is not None
                bl, br, sw_c, sc_c, bw, dh = sub_impasto
                for path, color, width, b_l, b_r, c_warm, c_cool, b_w, d_h in zip(
                    paths.tolist(),
                    colors.tolist(),
                    widths.tolist(),
                    bl.tolist(),
                    br.tolist(),
                    sw_c.tolist(),
                    sc_c.tolist(),
                    bw.tolist(),
                    dh.tolist(),
                ):
                    pencil.line(path, fill=tuple(color), width=width, joint="curve")
                    if b_w > 0:
                        pencil.line(b_l, fill=tuple(c_warm), width=b_w, joint="curve")
                        pencil.line(b_r, fill=tuple(c_cool), width=b_w, joint="curve")
                        # Lay smooth buttery paint plateau (width) inside a pressed perimeter moat (width + 2) so 3D cliff forms cleanly around dab silhouette!
                        h_draw.line(path, fill=(92, 92, 92, 225), width=width + 2, joint="curve")
                        h_draw.line(path, fill=(d_h, d_h, d_h, 242), width=width, joint="curve")
                    else:
                        h_draw.line(path, fill=(154, 154, 154, 175), width=width, joint="curve")

        if style == "oil":
            assert height_canvas is not None and oil_ground is not None and oil_border is not None
            frames.append(shade_oil_frame(canvas, height_canvas, oil_ground, oil_border))
        else:
            assert tooth is not None and grain is not None
            frames.append(surface_print(canvas, tooth, grain))

    movie = BytesIO()
    frames[0].save(
        movie,
        format="WEBP",
        save_all=True,
        append_images=frames[1:],
        duration=FRAME_MS,
        loop=1,
        quality=84,
        method=4,
        minimize_size=False,
    )
    still = BytesIO()
    with Image.open(movie, formats=("WEBP",)) as replay:
        replay.seek(replay.n_frames - 1)
        replay.convert("RGB").save(still, format="PNG")

    summary = {
        "style": style,
        "marks": count,
        "durationMs": len(frames) * FRAME_MS,
        "durationSec": duration_sec,
        "frames": len(frames),
        "width": reference.width,
        "height": reference.height,
        "baseDirection": base_direction,
        "finaleDirection": finale_direction,
        "holdFinale": hold_finale,
        "sketchFirst": sketch_first,
    }
    if destination is None:
        json.dump({
            "ok": True,
            "meta": summary,
            "finishedUrl": "data:image/png;base64," + base64.b64encode(still.getbuffer()).decode("ascii"),
            "processUrl": "data:image/webp;base64," + base64.b64encode(movie.getbuffer()).decode("ascii"),
        }, sys.stdout)
    else:
        destination.mkdir(parents=True, exist_ok=True)
        (destination / "process.webp").write_bytes(movie.getbuffer())
        (destination / "finished.png").write_bytes(still.getbuffer())
        (destination / "meta.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[{style}] {count:,} marks, {len(frames) * FRAME_MS} ms ({duration_sec}s), {reference.width} × {reference.height}", file=sys.stderr, flush=True)
    return summary


def find_default_reference(folder: Path) -> Path:
    for ext in ("png", "jpg", "jpeg", "webp"):
        candidate = folder / f"reference.{ext}"
        if candidate.exists():
            return candidate
    return folder / "reference.png"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path, default=find_default_reference(HERE))
    parser.add_argument("--mask", type=Path)
    parser.add_argument("--output", type=Path, default=HERE)
    parser.add_argument("--style", choices=STYLES, default="colored-pencil")
    parser.add_argument("--duration", type=int, choices=(4, 6), default=4)
    parser.add_argument("--direction", choices=("top-down", "left-right", "center-out", "edges-in"), default="top-down")
    parser.add_argument("--finale-direction", choices=("top-down", "left-right", "center-out"), default="top-down")
    parser.add_argument("--no-hold-finale", action="store_true")
    parser.add_argument("--no-sketch-first", action="store_true")
    args = parser.parse_args()
    pipe_mode = args.reference == Path("-")
    if pipe_mode != (args.output == Path("-")):
        parser.error("Use --reference - and --output - together for the local web bridge.")
    if pipe_mode and args.mask is not None:
        parser.error("The web bridge supplies the mask on stdin.")
    try:
        check_pillow_version()
        mask_path = None
        mask = None
        if pipe_mode:
            reference, mask = read_web_pictures(sys.stdin.buffer)
        else:
            reference = read_picture_file(args.reference, "RGB")
            mask_path = args.mask if args.mask is not None else HERE / "order_mask.png"
        render(
            reference,
            None if pipe_mode else args.output,
            mask_path=mask_path,
            mask=mask,
            style=args.style,
            duration_sec=args.duration,
            base_direction=args.direction,
            finale_direction=args.finale_direction,
            hold_finale=not args.no_hold_finale,
            sketch_first=not args.no_sketch_first,
        )
    except InvalidInput as exc:
        parser.exit(2, f"{exc}\n")
    except (OSError, RuntimeError) as exc:
        parser.exit(1, f"{exc}\n")

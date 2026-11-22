"""Interactive Colored-Pencil Drawing Engine.

Supports:
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


def paper_surface(width: int, height: int, rng: np.random.Generator):
    """Fixed paper tooth, shallow fibres and an irregular unworked paper edge."""
    y, x = np.mgrid[:height, :width]
    fine = rng.normal(0, 1, (height, width)).astype(np.float32)
    tooth = np.clip(0.028 + 0.040 * fine, 0, 0.21)
    fibres = rng.integers(0, 256, (height // 3 + 1, width // 10 + 1), dtype=np.uint8)
    fibres = np.asarray(Image.fromarray(fibres).resize((width, height), Image.Resampling.BICUBIC))
    tooth += np.clip((fibres.astype(np.float32) - 160) / 450, 0, 0.16)
    margin = np.minimum.reduce([x, y, width - 1 - x, height - 1 - y])
    edge = 3 + 2 * np.sin(x * 0.017 + y * 0.036) + 1.7 * np.cos((x - y) * 0.085)
    coverage = np.clip((margin - edge + fine * 1.9) / 6.5, 0, 1)
    tooth = 1 - (1 - tooth) * coverage
    grain = np.uint8(np.clip(np.asarray(PAPER) + fine[:, :, None] * 1.5, 0, 255))
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


def parse_order_mask(mask: Image.Image | None, width: int, height: int, pigment: np.ndarray, power: np.ndarray):
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

    r = pigment[:, :, 0].astype(np.float32)
    b = pigment[:, :, 2].astype(np.float32)
    auto_accent = (((r - b) > 38) & (power > 2.2)) | (power > 6.8)
    if has_user_finale:
        accent_mask = ((finale_weight > 0.25) & (power > 1.6)) | auto_accent
    else:
        accent_mask = auto_accent
    return early_weight, finale_weight, accent_mask, has_user_finale


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
            # Richer, clearer pencil skeleton so the full line-art structure is unmistakable before coloring starts
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
            # Graphite-sepia sketch lead tinted subtly by local hue
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

    # Compute local directional sweep in [0, 1] across the whole canvas
    base_sw = directional_sweep(fx, fy, base_direction) + rng.normal(0, 0.015, n)
    b_low, b_high = np.percentile(base_sw, (1.0, 99.0))
    base_sw = np.clip((base_sw - b_low) / max(1e-5, b_high - b_low), 0, 1)

    # Compute directional sweep normalized specifically over the user's Finale region!
    # This ensures left-right, top-down, and center-out sweep across the actual painted finale box
    # from 0.0 to 1.0 even when the painted region is only 15-20% of the canvas width.
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

    # Layer rank in [0, 1] so each local position lays down blocking -> body -> crosshatch -> edge -> finale
    # while the directional wave (82% weight) clearly sweeps across the chosen direction.
    pass_rank = {
        "construction": 0.00,
        "blocking": 0.00,
        "body": 0.28,
        "crosshatch": 0.55,
        "edge": 0.78,
        "finale": 1.00,
    }.get(mode, 0.50)

    color_norm = np.clip(0.82 * base_sw + 0.18 * pass_rank, 0.0, 1.0)
    color_norm_fin = np.clip(0.84 * fin_sw + 0.16 * pass_rank, 0.0, 1.0)
    use_finale_delay = bool(has_user_finale and hold_finale)

    if sketch_first:
        # MODE A (Sketch-First Checked):
        # 1) 0.00 - 0.24: Sketch the full line-art skeleton across the entire paper along base_direction.
        # 2) 0.25 - 1.00: Sweep color across the skeleton along base_direction (and finale_direction for Stage 3).
        if mode == "construction":
            moment = 0.00 + 0.24 * base_sw
        else:
            if use_finale_delay:
                body_time = 0.25 + color_norm * 0.49 * (1.0 - 0.40 * w_early)
                finale_time = 0.74 + color_norm_fin * 0.26
                moment = (1.0 - w_finale) * body_time + w_finale * finale_time
            else:
                moment = 0.25 + color_norm * 0.75 * (1.0 - 0.35 * w_early)
    else:
        # MODE B (Sketch-First Unchecked):
        # No pre-sketch! Sweep outline + color together directly across the paper along base_direction.
        direct_rank = {
            "construction": 0.00,
            "blocking": 0.16,
            "body": 0.38,
            "crosshatch": 0.60,
            "edge": 0.80,
            "finale": 1.00,
        }.get(mode, 0.50)
        direct_norm = np.clip(0.82 * base_sw + 0.18 * direct_rank, 0.0, 1.0)
        direct_norm_fin = np.clip(0.84 * fin_sw + 0.16 * direct_rank, 0.0, 1.0)
        if use_finale_delay:
            body_time = direct_norm * 0.72 * (1.0 - 0.40 * w_early)
            finale_time = 0.74 + direct_norm_fin * 0.26
            moment = (1.0 - w_finale) * body_time + w_finale * finale_time
        else:
            moment = direct_norm * (1.0 - 0.35 * w_early)

    moment = np.clip(moment, 0.0, 1.0)
    return np.column_stack((start, end_pt)), colors, widths, moment


def render(
    reference: Image.Image,
    destination: Path | None,
    mask_path: Path | None = None,
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
    duration_sec = 6 if duration_sec == 6 else 4
    frame_count = int((duration_sec * 1000) // FRAME_MS)  # 50 frames (4s) or 75 frames (6s)
    rng = np.random.default_rng(SEED)

    # Cap working dimension to 1080px for crisp detail and fast interactive turnaround
    if max(reference.size) > RENDER_EDGE:
        scale = RENDER_EDGE / max(reference.size)
        new_size = (max(1, round(reference.width * scale)), max(1, round(reference.height * scale)))
        reference = reference.resize(new_size, Image.Resampling.LANCZOS)

    pigment = colors_from_reference(reference)
    broad = np.asarray(Image.fromarray(pigment).filter(ImageFilter.GaussianBlur(2.0)))
    power, tangent = relief(reference)
    early_weight, finale_weight, accent_mask, has_user_finale = parse_order_mask(
        mask, reference.width, reference.height, pigment, power
    )

    tooth, grain = (Image.fromarray(a) for a in paper_surface(*reference.size, rng))
    canvas = Image.new("RGB", reference.size, PAPER)
    pencil = ImageDraw.Draw(canvas, "RGBA")
    frames = [surface_print(canvas, tooth, grain)]
    timeline = [[] for _ in range(frame_count)]
    count = 0

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
                timeline[index].append((paths[marks], colors[marks], widths[marks]))
        count += len(paths)
        print(f"{name}: {len(paths):,} marks", file=sys.stderr, flush=True)

    for batch in timeline[1:]:
        for paths, colors, widths in batch:
            for path, color, width in zip(paths.tolist(), colors.tolist(), widths.tolist()):
                pencil.line(path, fill=tuple(color), width=width)
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
    print(f"{count:,} marks, {len(frames) * FRAME_MS} ms ({duration_sec}s), {reference.width} × {reference.height}", file=sys.stderr, flush=True)
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

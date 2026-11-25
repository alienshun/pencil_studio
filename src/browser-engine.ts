import { encodeBestAnimatedImage, encodeMp4Video, type EncodedAnimation } from './media-export'

export type ArtStyle = 'colored-pencil' | 'sketch' | 'oil'
export type SweepDirection = 'top-down' | 'left-right' | 'center-out' | 'edges-in'
export type FinaleDirection = 'top-down' | 'left-right' | 'center-out'

export interface BrowserRenderOptions {
  image: HTMLImageElement
  maskCanvas: HTMLCanvasElement
  style?: ArtStyle
  durationSec: 4 | 6
  baseDirection: SweepDirection
  finaleDirection: FinaleDirection
  holdFinale: boolean
  sketchFirst: boolean
  onProgress?: (percent: number, label: string) => void
}

export interface BrowserRenderResult {
  style: ArtStyle
  frames: HTMLCanvasElement[]
  frameCount: number
  finishedDataUrl: string
  finishedBlob: Blob
  animation: EncodedAnimation | null
  mp4Blob: Blob | null
  marks: number
  durationSec: 4 | 6
  width: number
  height: number
}

interface Stroke {
  x0: number
  y0: number
  xm?: number
  ym?: number
  x1: number
  y1: number
  color: string
  width: number
  impasto?: {
    nx: number
    ny: number
    warmColor: string
    coolColor: string
    bristleWidth: number
    dabHeight: number
  }
  frame: number
  moment: number
}

interface TimelineContext {
  frameCount: number
  baseDirection: SweepDirection
  finaleDirection: FinaleDirection
  holdFinale: boolean
  sketchFirst: boolean
  hasUserFinale: boolean
  earlyWeight: Float32Array
  finaleWeight: Float32Array
  finMinX: number
  finMinY: number
  finSpanX: number
  finSpanY: number
  finCx: number
  finCy: number
  finRadius: number
}

const COLORED_PENCIL_PAPER: [number, number, number] = [248, 240, 219]
const SKETCH_PAPER: [number, number, number] = [250, 248, 242]
const OIL_CANVAS: [number, number, number] = [232, 223, 204]

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val))
}

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function directionalSweep(fx: number, fy: number, dir: SweepDirection | FinaleDirection, cx = 0.5, cy = 0.5): number {
  if (dir === 'left-right') return fx + 0.04 * fy
  if (dir === 'center-out') return Math.hypot(fx - cx, fy - cy) * 1.42
  if (dir === 'edges-in') return 1.0 - Math.hypot(fx - cx, fy - cy) * 1.42
  return fy + 0.04 * fx
}

function boxBlur2D(src: ArrayLike<number>, width: number, height: number, radius: number): Float32Array {
  const r = Math.max(1, Math.round(radius))
  const horiz = new Float32Array(width * height)
  const out = new Float32Array(width * height)

  for (let y = 0; y < height; y++) {
    const row = y * width
    let sum = 0
    let count = 0
    for (let x = 0; x <= Math.min(width - 1, r); x++) {
      sum += src[row + x]
      count++
    }
    for (let x = 0; x < width; x++) {
      horiz[row + x] = sum / count
      const left = x - r
      const right = x + r + 1
      if (left >= 0) {
        sum -= src[row + left]
        count--
      }
      if (right < width) {
        sum += src[row + right]
        count++
      }
    }
  }

  for (let x = 0; x < width; x++) {
    let sum = 0
    let count = 0
    for (let y = 0; y <= Math.min(height - 1, r); y++) {
      sum += horiz[y * width + x]
      count++
    }
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / count
      const top = y - r
      const bottom = y + r + 1
      if (top >= 0) {
        sum -= horiz[top * width + x]
        count--
      }
      if (bottom < height) {
        sum += horiz[bottom * width + x]
        count++
      }
    }
  }
  return out
}

function buildTimelineContext(
  maskData: Uint8ClampedArray,
  width: number,
  height: number,
  frameCount: number,
  baseDirection: SweepDirection,
  finaleDirection: FinaleDirection,
  holdFinale: boolean,
  sketchFirst: boolean,
): TimelineContext {
  const total = width * height
  const earlyMask = new Uint8Array(total)
  const finaleMask = new Uint8Array(total)
  let hasUserEarly = false
  let hasUserFinale = false

  for (let i = 0; i < total; i++) {
    const ma = maskData[i * 4 + 3]
    const mr = maskData[i * 4]
    const mb = maskData[i * 4 + 2]
    if (ma > 40 && mr > 150 && mr > mb) {
      finaleMask[i] = 1
      hasUserFinale = true
    } else if (ma > 40 && mb > 150 && mb > mr) {
      earlyMask[i] = 1
      hasUserEarly = true
    }
  }

  const featherRadius = Math.max(4, Math.min(width, height) * 0.015)
  const earlyWeight = hasUserEarly ? boxBlur2D(earlyMask, width, height, featherRadius) : new Float32Array(total)
  const finaleWeight = hasUserFinale ? boxBlur2D(finaleMask, width, height, featherRadius) : new Float32Array(total)

  let finMinX = 1, finMaxX = 0, finMinY = 1, finMaxY = 0
  for (let i = 0; i < total; i++) {
    if (finaleMask[i] === 1) {
      const fx = (i % width) / width
      const fy = Math.floor(i / width) / height
      if (fx < finMinX) finMinX = fx
      if (fx > finMaxX) finMaxX = fx
      if (fy < finMinY) finMinY = fy
      if (fy > finMaxY) finMaxY = fy
    }
  }
  const finCx = finMaxX >= finMinX ? (finMinX + finMaxX) * 0.5 : 0.5
  const finCy = finMaxY >= finMinY ? (finMinY + finMaxY) * 0.5 : 0.5
  const finSpanX = Math.max(0.05, finMaxX - finMinX)
  const finSpanY = Math.max(0.05, finMaxY - finMinY)
  const finRadius = Math.max(0.05, Math.hypot(finSpanX, finSpanY) * 0.5)

  return {
    frameCount,
    baseDirection,
    finaleDirection,
    holdFinale,
    sketchFirst,
    hasUserFinale,
    earlyWeight,
    finaleWeight,
    finMinX,
    finMinY,
    finSpanX,
    finSpanY,
    finCx,
    finCy,
    finRadius,
  }
}

function scheduleMomentAndFrame(
  fx: number,
  fy: number,
  idx: number,
  rank: number,
  isConstruction: boolean,
  rand: () => number,
  tl: TimelineContext,
): { moment: number; frame: number } {
  const wEarly = tl.earlyWeight[idx]
  const wFinale = tl.finaleWeight[idx]
  const rawBase = clamp(directionalSweep(fx, fy, tl.baseDirection) + (rand() - 0.5) * 0.03, 0, 1)

  let localFin = 0
  if (tl.finaleDirection === 'left-right') {
    localFin = (fx - tl.finMinX) / tl.finSpanX
  } else if (tl.finaleDirection === 'center-out') {
    localFin = Math.hypot(fx - tl.finCx, fy - tl.finCy) / tl.finRadius
  } else {
    localFin = (fy - tl.finMinY) / tl.finSpanY
  }
  const rawFin = clamp(localFin + (rand() - 0.5) * 0.03, 0, 1)
  const useFinaleDelay = tl.hasUserFinale && tl.holdFinale
  const cNorm = clamp(0.82 * rawBase + 0.18 * rank, 0, 1)
  const cNormFin = clamp(0.84 * rawFin + 0.16 * rank, 0, 1)

  let moment: number
  if (tl.sketchFirst) {
    if (isConstruction) {
      moment = 0.00 + 0.24 * rawBase
    } else if (useFinaleDelay) {
      const bodyTime = 0.25 + cNorm * 0.49 * (1 - 0.40 * wEarly)
      const finaleTime = 0.74 + cNormFin * 0.26
      moment = (1 - wFinale) * bodyTime + wFinale * finaleTime
    } else {
      moment = 0.25 + cNorm * 0.75 * (1 - 0.35 * wEarly)
    }
  } else if (useFinaleDelay) {
    const bodyTime = cNorm * 0.72 * (1 - 0.40 * wEarly)
    const finaleTime = 0.74 + cNormFin * 0.26
    moment = (1 - wFinale) * bodyTime + wFinale * finaleTime
  } else {
    moment = cNorm * (1 - 0.35 * wEarly)
  }

  const clampedMoment = clamp(moment, 0, 1)
  const frame = clamp(1 + Math.round(clampedMoment * (tl.frameCount - 2)), 1, tl.frameCount - 1)
  return { moment: clampedMoment, frame }
}

function generateColoredPencilStrokes(
  srcData: Uint8ClampedArray,
  width: number,
  height: number,
  tl: TimelineContext,
  rand: () => number,
): Stroke[] {
  const total = width * height
  const pigment = new Uint8ClampedArray(total * 3)
  const lum = new Float32Array(total)

  for (let i = 0; i < total; i++) {
    const r = srcData[i * 4] / 255
    const g = srcData[i * 4 + 1] / 255
    const b = srcData[i * 4 + 2] / 255
    let pr = (r ** 0.84) * 215 + 23
    let pg = (g ** 0.84) * 206 + 24
    let pb = (b ** 0.84) * 188 + 36
    const y = (r + g + b) / 3
    const cool = clamp((b - r) * 3.5 + 0.08, 0, 1)
    const warm = clamp((r - b - 0.07) * 1.9, 0, 1)
    const lift = Math.sin(Math.PI * y)
    pr += cool * -5 + warm * 14 + lift * 7
    pg += cool * 3 + warm * 3 + lift * 6
    pb += cool * 18 + warm * -7 + lift * 7
    const l = 0.30 * pr + 0.54 * pg + 0.16 * pb
    pigment[i * 3] = clamp(l + 1.11 * (pr - l), 0, 255)
    pigment[i * 3 + 1] = clamp(l + 1.11 * (pg - l), 0, 255)
    pigment[i * 3 + 2] = clamp(l + 1.11 * (pb - l), 0, 255)
    lum[i] = l
  }

  const power = new Float32Array(total)
  const tangent = new Float32Array(total)
  const accentMask = new Uint8Array(total)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x
      const dx = (lum[idx + 1] - lum[idx - 1]) * 0.5
      const dy = (lum[idx + width] - lum[idx - width]) * 0.5
      const p = Math.hypot(dx, dy)
      power[idx] = p
      tangent[idx] = Math.atan2(dy, dx) + Math.PI / 2
      const pr = pigment[idx * 3]
      const pb = pigment[idx * 3 + 2]
      const autoAccent = ((pr - pb) > 38 && p > 2.2) || p > 7.2
      if (tl.hasUserFinale) {
        if ((tl.finaleWeight[idx] > 0.25 && p > 1.6) || autoAccent) accentMask[idx] = 1
      } else if (autoAccent) {
        accentMask[idx] = 1
      }
    }
  }

  const passes = [
    { mode: 'construction', spacing: 2.1, length: 10, nib: 1, opacity: 0.48 },
    { mode: 'blocking', spacing: 4.0, length: 18, nib: 3.6, opacity: 0.72 },
    { mode: 'body', spacing: 2.8, length: 12, nib: 2.1, opacity: 0.74 },
    { mode: 'crosshatch', spacing: 2.5, length: 9.5, nib: 1.1, opacity: 0.64 },
    { mode: 'edge', spacing: 1.3, length: 4.8, nib: 1.0, opacity: 0.82 },
    { mode: 'finale', spacing: 1.0, length: 3.8, nib: 1.1, opacity: 0.92 },
  ]

  const rankMap: Record<string, number> = {
    construction: 0.0,
    blocking: tl.sketchFirst ? 0.0 : 0.16,
    body: tl.sketchFirst ? 0.28 : 0.38,
    crosshatch: tl.sketchFirst ? 0.55 : 0.60,
    edge: tl.sketchFirst ? 0.78 : 0.80,
    finale: 1.0,
  }

  const strokes: Stroke[] = []
  for (const pass of passes) {
    const threshold = pass.mode === 'edge' || pass.mode === 'finale' ? 18 : 23
    const rank = rankMap[pass.mode] ?? 0.5

    for (let gy = 0; gy < height; gy += pass.spacing) {
      for (let gx = 0; gx < width; gx += pass.spacing) {
        const x = Math.min(width - 1, Math.floor(gx + rand() * pass.spacing))
        const y = Math.min(height - 1, Math.floor(gy + rand() * pass.spacing))
        const idx = y * width + x
        const edge = power[idx]

        if (pass.mode === 'construction') {
          const minEdge = tl.sketchFirst ? 2.6 : 4.2
          if (edge <= minEdge || rand() >= Math.min(edge / (tl.sketchFirst ? 11.5 : 18), 0.85)) continue
        } else if (pass.mode === 'edge') {
          if (edge <= 2.6 || rand() >= Math.min(0.95, Math.max(0.22, edge / 11))) continue
        } else if (pass.mode === 'finale') {
          if (accentMask[idx] !== 1) continue
        }

        const fx = x / width
        const fy = y / height
        const field = 0.17 * Math.sin(13 * fx + 9 * fy) + 0.08 * Math.cos(29 * fx - 15 * fy)
        let angle = -0.86 + field + (pass.mode === 'crosshatch' ? 0.76 : 0)
        const ew = clamp((edge - 1.6) / 9.2, 0, 1)
        const tgt = tangent[idx]
        angle = 0.5 * Math.atan2(
          (1 - ew) * Math.sin(2 * angle) + ew * Math.sin(2 * tgt),
          (1 - ew) * Math.cos(2 * angle) + ew * Math.cos(2 * tgt),
        ) + (rand() - 0.5) * 0.22

        const span = Math.max(1.5, (pass.length * (0.58 + rand() * 0.85)) / (1 + edge * 0.07))
        const dx = Math.cos(angle) * span * 0.5
        const dy = Math.sin(angle) * span * 0.5

        const cR = pigment[idx * 3]
        const cG = pigment[idx * 3 + 1]
        const cB = pigment[idx * 3 + 2]

        let reachNeg = 1.0
        let reachPos = 1.0
        for (const step of [0.25, 0.5, 0.75, 1.0]) {
          if (reachNeg === 1.0) {
            const px = clamp(Math.round(x - dx * step), 0, width - 1)
            const py = clamp(Math.round(y - dy * step), 0, height - 1)
            const pIdx = (py * width + px) * 3
            if (
              Math.abs(pigment[pIdx] - cR) > threshold ||
              Math.abs(pigment[pIdx + 1] - cG) > threshold ||
              Math.abs(pigment[pIdx + 2] - cB) > threshold
            ) {
              reachNeg = step - 0.2
            }
          }
          if (reachPos === 1.0) {
            const px = clamp(Math.round(x + dx * step), 0, width - 1)
            const py = clamp(Math.round(y + dy * step), 0, height - 1)
            const pIdx = (py * width + px) * 3
            if (
              Math.abs(pigment[pIdx] - cR) > threshold ||
              Math.abs(pigment[pIdx + 1] - cG) > threshold ||
              Math.abs(pigment[pIdx + 2] - cB) > threshold
            ) {
              reachPos = step - 0.2
            }
          }
        }

        let pr = cR
        let pg = cG
        let pb = cB
        let passOpacity = pass.opacity
        if (pass.mode === 'construction') {
          if (tl.sketchFirst) {
            pr = pr * 0.34 + 58
            pg = pg * 0.34 + 54
            pb = pb * 0.34 + 62
            passOpacity = Math.min(0.9, passOpacity * 1.35)
          } else {
            pr = pr * 0.26 + 66
            pg = pg * 0.26 + 63
            pb = pb * 0.26 + 74
          }
        } else if (pass.mode === 'blocking') {
          pr = pr * 0.89 + COLORED_PENCIL_PAPER[0] * 0.11
          pg = pg * 0.89 + COLORED_PENCIL_PAPER[1] * 0.11
          pb = pb * 0.89 + COLORED_PENCIL_PAPER[2] * 0.11
        }
        const jitter = (rand() - 0.5) * 10
        pr = clamp(Math.round(pr + jitter), 0, 255)
        pg = clamp(Math.round(pg + jitter), 0, 255)
        pb = clamp(Math.round(pb + jitter), 0, 255)
        const alpha = +(passOpacity * (0.8 + rand() * 0.2)).toFixed(2)

        const { moment, frame } = scheduleMomentAndFrame(
          fx,
          fy,
          idx,
          rank,
          pass.mode === 'construction',
          rand,
          tl,
        )

        strokes.push({
          x0: x - dx * reachNeg,
          y0: y - dy * reachNeg,
          x1: x + dx * reachPos,
          y1: y + dy * reachPos,
          color: `rgba(${pr},${pg},${pb},${alpha})`,
          width: Math.max(1, pass.nib / (1 + edge / 25)),
          frame,
          moment,
        })
      }
    }
  }
  return strokes
}

function generateSketchStrokes(
  srcData: Uint8ClampedArray,
  width: number,
  height: number,
  tl: TimelineContext,
  rand: () => number,
): Stroke[] {
  const total = width * height
  const rawLum = new Float32Array(total)
  for (let i = 0; i < total; i++) {
    rawLum[i] = (0.299 * srcData[i * 4] + 0.587 * srcData[i * 4 + 1] + 0.114 * srcData[i * 4 + 2]) / 255
  }

  // Subtle micro-contrast + gentle S-curve anchored to graphite range [22, 248]
  const microBlur = boxBlur2D(rawLum, width, height, 3)
  const gTone = new Float32Array(total)
  const darknessArr = new Float32Array(total)

  for (let i = 0; i < total; i++) {
    const localY = clamp(rawLum[i] + 0.26 * (rawLum[i] - microBlur[i]), 0, 1)
    const sCurve = localY * localY * (3 - 2 * localY)
    const yCurve = 0.68 * localY + 0.32 * sCurve
    const tone = 22 + (yCurve ** 0.92) * 226
    gTone[i] = tone
    darknessArr[i] = clamp((248 - tone) / 226, 0, 1)
  }

  const broadTone = boxBlur2D(gTone, width, height, 2)
  const smoothTone = boxBlur2D(gTone, width, height, 1)
  const onDarkSide = new Uint8Array(total)
  for (let i = 0; i < total; i++) {
    if (gTone[i] <= smoothTone[i] + 1.5) onDarkSide[i] = 1
  }

  const power = new Float32Array(total)
  const tangent = new Float32Array(total)
  const accentMask = new Uint8Array(total)

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x
      const dxT = (smoothTone[idx + 1] - smoothTone[idx - 1]) * 0.5
      const dyT = (smoothTone[idx + width] - smoothTone[idx - width]) * 0.5
      const pT = Math.hypot(dxT, dyT)

      // Chroma-aware edge rescue so distinct colors of equal luminance still receive crisp pencil contours
      const rIdx = idx * 4
      const dxR = (srcData[rIdx + 4] - srcData[rIdx - 4]) * 0.5
      const dyR = (srcData[rIdx + width * 4] - srcData[rIdx - width * 4]) * 0.5
      const dxB = (srcData[rIdx + 6] - srcData[rIdx - 2]) * 0.5
      const dyB = (srcData[rIdx + width * 4 + 2] - srcData[rIdx - width * 4 + 2]) * 0.5
      const pR = Math.hypot(dxR, dyR) * 0.38
      const pB = Math.hypot(dxB, dyB) * 0.38

      let p = pT
      let gx = dxT
      let gy = dyT
      if (pR > p) {
        p = pR
        gx = dxR
        gy = dyR
      }
      if (pB > p) {
        p = pB
        gx = dxB
        gy = dyB
      }

      power[idx] = p
      tangent[idx] = Math.atan2(gy, gx) + Math.PI / 2

      const dark = darknessArr[idx]
      const darkLocus = onDarkSide[idx] === 1
      const autoAccent = darkLocus && ((dark > 0.42 && p > 2.4) || p > 6.8)
      if (tl.hasUserFinale) {
        if ((tl.finaleWeight[idx] > 0.25 && darkLocus && p > 1.6) || autoAccent) {
          accentMask[idx] = 1
        }
      } else if (autoAccent) {
        accentMask[idx] = 1
      }
    }
  }

  const passes = [
    { mode: 'construction', spacing: 2.1, length: 10.2, nib: 1.0 },
    { mode: 'shading_base', spacing: 4.2, length: 18.0, nib: 3.1 },
    { mode: 'hatching', spacing: 2.6, length: 12.0, nib: 1.5 },
    { mode: 'crosshatch', spacing: 2.5, length: 9.8, nib: 1.05 },
    { mode: 'contour', spacing: 1.3, length: 4.8, nib: 1.0 },
    { mode: 'finale', spacing: 1.0, length: 3.8, nib: 1.05 },
  ]

  const rankMap: Record<string, number> = {
    construction: 0.0,
    shading_base: tl.sketchFirst ? 0.0 : 0.16,
    hatching: tl.sketchFirst ? 0.28 : 0.38,
    crosshatch: tl.sketchFirst ? 0.55 : 0.60,
    contour: tl.sketchFirst ? 0.78 : 0.80,
    finale: 1.0,
  }

  const strokes: Stroke[] = []

  for (const pass of passes) {
    const threshold = pass.mode === 'contour' || pass.mode === 'finale' ? 17 : 22
    const rank = rankMap[pass.mode] ?? 0.5

    for (let gy = 0; gy < height; gy += pass.spacing) {
      for (let gx = 0; gx < width; gx += pass.spacing) {
        const x = Math.min(width - 1, Math.floor(gx + rand() * pass.spacing))
        const y = Math.min(height - 1, Math.floor(gy + rand() * pass.spacing))
        const idx = y * width + x
        const edge = power[idx]
        const dark = darknessArr[idx]
        const darkSide = onDarkSide[idx] === 1

        // Paper-as-highlight & dark-side edge gating per academic sketch stage
        if (pass.mode === 'construction') {
          const minEdge = tl.sketchFirst ? 2.6 : 4.2
          if (!darkSide || edge <= minEdge || rand() >= clamp(edge / (tl.sketchFirst ? 11.5 : 18.0), 0.22, 0.88)) continue
        } else if (pass.mode === 'shading_base') {
          if (dark <= 0.11 || rand() >= clamp((dark - 0.09) * 1.50, 0, 0.94)) continue
        } else if (pass.mode === 'hatching') {
          if (dark <= 0.06 || rand() >= clamp((dark - 0.04) * 1.70, 0.08, 0.98)) continue
        } else if (pass.mode === 'crosshatch') {
          if (dark <= 0.24 || rand() >= clamp((dark - 0.22) * 1.85, 0, 0.96)) continue
        } else if (pass.mode === 'contour') {
          if (!darkSide || edge <= 2.4 || rand() >= clamp(edge / 11.0, 0.22, 0.96)) continue
        } else if (pass.mode === 'finale') {
          const deepCore = dark > 0.64 && rand() < clamp((dark - 0.60) * 2.0, 0, 0.88)
          if (accentMask[idx] !== 1 && !deepCore) continue
        }

        const fx = x / width
        const fy = y / height
        const field = 0.14 * Math.sin(13 * fx + 9 * fy) + 0.07 * Math.cos(29 * fx - 15 * fy)
        const tgt = tangent[idx]

        let baseAngle = -0.84 + field
        let ew = clamp((edge - 1.6) / 9.2, 0, 0.85)
        let jitterSpan = 0.17

        if (pass.mode === 'construction' || pass.mode === 'contour') {
          ew = clamp((edge - 1.4) / 6.5, 0.45, 1.0)
          jitterSpan = 0.16
        } else if (pass.mode === 'shading_base') {
          baseAngle = -0.78 + field * 0.7
          ew = clamp((edge - 2.0) / 11.0, 0, 0.40)
          jitterSpan = 0.14
        } else if (pass.mode === 'crosshatch') {
          baseAngle = -0.84 + 0.78 + field
          ew = clamp((edge - 1.8) / 10.0, 0, 0.55)
          jitterSpan = 0.18
        } else if (pass.mode === 'finale') {
          if (edge > 2.0) {
            ew = clamp((edge - 1.4) / 6.0, 0.55, 1.0)
            jitterSpan = 0.15
          } else {
            baseAngle = -0.16 + field
            ew = 0.25
            jitterSpan = 0.15
          }
        }

        const angle = 0.5 * Math.atan2(
          (1 - ew) * Math.sin(2 * baseAngle) + ew * Math.sin(2 * tgt),
          (1 - ew) * Math.cos(2 * baseAngle) + ew * Math.cos(2 * tgt),
        ) + (rand() - 0.5) * jitterSpan

        const span = Math.max(1.5, (pass.length * (0.58 + rand() * 0.84)) / (1 + edge * 0.07))
        const dx = Math.cos(angle) * span * 0.5
        const dy = Math.sin(angle) * span * 0.5

        const centerTone = gTone[idx]
        let reachNeg = 1.0
        let reachPos = 1.0
        for (const step of [0.25, 0.5, 0.75, 1.0]) {
          if (reachNeg === 1.0) {
            const px = clamp(Math.round(x - dx * step), 0, width - 1)
            const py = clamp(Math.round(y - dy * step), 0, height - 1)
            if (Math.abs(gTone[py * width + px] - centerTone) > threshold) {
              reachNeg = step - 0.2
            }
          }
          if (reachPos === 1.0) {
            const px = clamp(Math.round(x + dx * step), 0, width - 1)
            const py = clamp(Math.round(y + dy * step), 0, height - 1)
            if (Math.abs(gTone[py * width + px] - centerTone) > threshold) {
              reachPos = step - 0.2
            }
          }
        }

        // Tonal-anchored graphite grades so multi-pass hatching converges to true values without muddy halos
        let leadVal = centerTone
        let passOpacity = 0.68
        if (pass.mode === 'construction') {
          leadVal = tl.sketchFirst ? centerTone * 0.42 + 64 : centerTone * 0.55 + 56
          passOpacity = tl.sketchFirst ? 0.64 : 0.48
        } else if (pass.mode === 'shading_base') {
          leadVal = 0.87 * broadTone[idx] + 0.13 * SKETCH_PAPER[0]
          passOpacity = 0.60
        } else if (pass.mode === 'hatching') {
          leadVal = centerTone - 8 * (1 - dark * 0.35)
          passOpacity = 0.72
        } else if (pass.mode === 'crosshatch') {
          leadVal = centerTone - 9
          passOpacity = 0.64
        } else if (pass.mode === 'contour') {
          leadVal = centerTone - clamp(edge * 0.95, 3, 18)
          passOpacity = 0.82
        } else if (pass.mode === 'finale') {
          leadVal = centerTone - clamp(edge * 0.85 + dark * 7, 3, 16)
          passOpacity = 0.91
        }

        const jitter = (rand() - 0.5) * 10
        const gr = clamp(Math.round(leadVal + jitter - 1), 18, 242)
        const gg = clamp(Math.round(leadVal + jitter), 18, 242)
        const gb = clamp(Math.round(leadVal + jitter + 2), 20, 245)
        const alpha = +(passOpacity * (0.8 + rand() * 0.2)).toFixed(2)

        const { moment, frame } = scheduleMomentAndFrame(
          fx,
          fy,
          idx,
          rank,
          pass.mode === 'construction',
          rand,
          tl,
        )

        strokes.push({
          x0: x - dx * reachNeg,
          y0: y - dy * reachNeg,
          x1: x + dx * reachPos,
          y1: y + dy * reachPos,
          color: `rgba(${gr},${gg},${gb},${alpha})`,
          width: Math.max(0.9, pass.nib / (1 + edge / 25)),
          frame,
          moment,
        })
      }
    }
  }
  return strokes
}

function paintLinenCanvasGround(
  ctx: CanvasRenderingContext2D,
  hCtx: CanvasRenderingContext2D,
  width: number,
  height: number,
) {
  ctx.fillStyle = `rgb(${OIL_CANVAS[0]},${OIL_CANVAS[1]},${OIL_CANVAS[2]})`
  ctx.fillRect(0, 0, width, height)
  ctx.lineWidth = 1
  ctx.strokeStyle = 'rgba(196, 184, 160, 0.24)'
  ctx.beginPath()
  for (let y = 1; y < height; y += 4) {
    ctx.moveTo(0, y + 0.5)
    ctx.lineTo(width, y + 0.5)
  }
  for (let x = 1; x < width; x += 4) {
    ctx.moveTo(x + 0.5, 0)
    ctx.lineTo(x + 0.5, height)
  }
  ctx.stroke()

  ctx.strokeStyle = 'rgba(248, 242, 228, 0.20)'
  ctx.beginPath()
  for (let y = 3; y < height; y += 4) {
    ctx.moveTo(0, y + 0.5)
    ctx.lineTo(width, y + 0.5)
  }
  for (let x = 3; x < width; x += 4) {
    ctx.moveTo(x + 0.5, 0)
    ctx.lineTo(x + 0.5, height)
  }
  ctx.stroke()

  // Initialize woven linen heightmap
  hCtx.fillStyle = 'rgb(96,96,96)'
  hCtx.fillRect(0, 0, width, height)
  hCtx.lineWidth = 1
  hCtx.strokeStyle = 'rgb(112,112,112)'
  hCtx.beginPath()
  for (let y = 1; y < height; y += 4) {
    hCtx.moveTo(0, y + 0.5)
    hCtx.lineTo(width, y + 0.5)
  }
  for (let x = 1; x < width; x += 4) {
    hCtx.moveTo(x + 0.5, 0)
    hCtx.lineTo(x + 0.5, height)
  }
  hCtx.stroke()
}

function kuwaharaFilterRGB(
  rIn: Float32Array,
  gIn: Float32Array,
  bIn: Float32Array,
  width: number,
  height: number,
  radius: number,
): [Float32Array, Float32Array, Float32Array] {
  const r = Math.max(1, Math.round(radius))
  const win = r + 1
  const area = win * win
  const pw = width + 2 * r
  const ph = height + 2 * r
  const sw = pw + 1
  const sh = ph + 1
  const satLen = sw * sh

  const satR = new Float64Array(satLen)
  const satG = new Float64Array(satLen)
  const satB = new Float64Array(satLen)
  const satL = new Float64Array(satLen)
  const satL2 = new Float64Array(satLen)

  for (let py = 0; py < ph; py++) {
    const sy = clamp(py - r, 0, height - 1)
    const rowOff = (py + 1) * sw
    const prevOff = py * sw
    for (let px = 0; px < pw; px++) {
      const sx = clamp(px - r, 0, width - 1)
      const sIdx = sy * width + sx
      const rv = rIn[sIdx]
      const gv = gIn[sIdx]
      const bv = bIn[sIdx]
      const lv = 0.299 * rv + 0.587 * gv + 0.114 * bv
      const c = rowOff + px + 1
      const up = prevOff + px + 1
      const lf = rowOff + px
      const ul = prevOff + px

      satR[c] = rv + satR[up] + satR[lf] - satR[ul]
      satG[c] = gv + satG[up] + satG[lf] - satG[ul]
      satB[c] = bv + satB[up] + satB[lf] - satB[ul]
      satL[c] = lv + satL[up] + satL[lf] - satL[ul]
      satL2[c] = lv * lv + satL2[up] + satL2[lf] - satL2[ul]
    }
  }

  const outR = new Float32Array(width * height)
  const outG = new Float32Array(width * height)
  const outB = new Float32Array(width * height)
  const qOffs: [number, number][] = [
    [0, 0],
    [0, r],
    [r, 0],
    [r, r],
  ]

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let bestVar = Infinity
      let bestR = 0
      let bestG = 0
      let bestB = 0
      for (let q = 0; q < 4; q++) {
        const qy = y + qOffs[q][0]
        const qx = x + qOffs[q][1]
        const br = (qy + win) * sw + (qx + win)
        const tr = qy * sw + (qx + win)
        const bl = (qy + win) * sw + qx
        const tl = qy * sw + qx
        const mL = (satL[br] - satL[tr] - satL[bl] + satL[tl]) / area
        const vL = (satL2[br] - satL2[tr] - satL2[bl] + satL2[tl]) / area - mL * mL
        if (vL < bestVar) {
          bestVar = vL
          bestR = (satR[br] - satR[tr] - satR[bl] + satR[tl]) / area
          bestG = (satG[br] - satG[tr] - satG[bl] + satG[tl]) / area
          bestB = (satB[br] - satB[tr] - satB[bl] + satB[tl]) / area
        }
      }
      const idx = y * width + x
      outR[idx] = bestR
      outG[idx] = bestG
      outB[idx] = bestB
    }
  }
  return [outR, outG, outB]
}

function shadeOilFrame(
  paintCtx: CanvasRenderingContext2D,
  hCtx: CanvasRenderingContext2D,
  snapCtx: CanvasRenderingContext2D,
  width: number,
  height: number,
  hHorizBuf: Float32Array,
  hSmoothBuf: Float32Array,
) {
  const paintImg = paintCtx.getImageData(0, 0, width, height)
  const pData = paintImg.data
  const hData = hCtx.getImageData(0, 0, width, height).data

  // Fast 3x3 binomial smooth ([1, 2, 1] / 4 separable) so dab edges look like creamy oil paint
  for (let y = 0; y < height; y++) {
    const row = y * width
    hHorizBuf[row] = (hData[row * 4] * 3 + hData[(row + 1) * 4]) * 0.25
    for (let x = 1; x < width - 1; x++) {
      const i = row + x
      hHorizBuf[i] = (hData[(i - 1) * 4] + 2 * hData[i * 4] + hData[(i + 1) * 4]) * 0.25
    }
    const last = row + width - 1
    hHorizBuf[last] = (hData[(last - 1) * 4] + hData[last * 4] * 3) * 0.25
  }
  for (let x = 0; x < width; x++) {
    hSmoothBuf[x] = (hHorizBuf[x] * 3 + hHorizBuf[width + x]) * 0.25
    const bot = (height - 1) * width + x
    hSmoothBuf[bot] = (hHorizBuf[(height - 2) * width + x] + hHorizBuf[bot] * 3) * 0.25
  }
  for (let y = 1; y < height - 1; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      const i = row + x
      hSmoothBuf[i] = (hHorizBuf[i - width] + 2 * hHorizBuf[i] + hHorizBuf[i + width]) * 0.25
    }
  }

  for (let y = 1; y < height - 1; y++) {
    const row = y * width
    for (let x = 1; x < width - 1; x++) {
      const i = row + x
      const gx = (hSmoothBuf[i + 1] - hSmoothBuf[i - 1]) * 0.5
      const gy = (hSmoothBuf[i + width] - hSmoothBuf[i - width]) * 0.5
      const lit = (0.60 * gx + 0.75 * gy) / 23.0

      const pIdx = i * 4
      const pr = pData[pIdx]
      const pg = pData[pIdx + 1]
      const pb = pData[pIdx + 2]

      let diffuse: number
      if (lit >= 0) {
        diffuse = 1.0 + 0.21 * Math.min(lit, 1.35)
      } else {
        const brightGuard = 1.0 - 0.38 * ((pr + pg + pb) / 765.0)
        diffuse = 1.0 + 0.22 * brightGuard * Math.max(lit, -1.05)
      }

      const s = lit > 0 ? Math.min(1.0, lit * 0.80) : 0.0
      const s2 = s * s
      const spec = s2 * s2 * 0.35

      pData[pIdx] = clamp(Math.round(pr * diffuse + spec * 255), 0, 255)
      pData[pIdx + 1] = clamp(Math.round(pg * diffuse + spec * 250), 0, 255)
      pData[pIdx + 2] = clamp(Math.round(pb * diffuse + spec * 240), 0, 255)
    }
  }
  snapCtx.putImageData(paintImg, 0, 0)
}

function generateOilStrokes(
  srcData: Uint8ClampedArray,
  width: number,
  height: number,
  tl: TimelineContext,
  rand: () => number,
): Stroke[] {
  const total = width * height
  const rawR = new Float32Array(total)
  const rawG = new Float32Array(total)
  const rawB = new Float32Array(total)
  const lum = new Float32Array(total)

  for (let i = 0; i < total; i++) {
    const r = srcData[i * 4] / 255
    const g = srcData[i * 4 + 1] / 255
    const b = srcData[i * 4 + 2] / 255

    const cR = 0.65 * r + 0.35 * r * r * (3 - 2 * r)
    const cG = 0.65 * g + 0.35 * g * g * (3 - 2 * g)
    const cB = 0.65 * b + 0.35 * b * b * (3 - 2 * b)

    let pr = 7 + (cR ** 0.93) * 245
    let pg = 7 + (cG ** 0.93) * 244
    let pb = 11 + (cB ** 0.93) * 240

    const y01 = 0.299 * r + 0.587 * g + 0.114 * b
    const sun = Math.max(0, y01 - 0.50) * 1.65
    const shade = Math.max(0, 0.46 - y01) * 1.55
    pr += sun * 9 - shade * 5
    pg += sun * 4 - shade * 1
    pb += -sun * 6 + shade * 10

    const l = 0.30 * pr + 0.54 * pg + 0.16 * pb
    rawR[i] = clamp(l + 1.28 * (pr - l), 6, 254)
    rawG[i] = clamp(l + 1.28 * (pg - l), 6, 254)
    rawB[i] = clamp(l + 1.28 * (pb - l), 6, 254)
    lum[i] = l
  }

  // Multi-scale Kuwahara painterly color faceting (sharp silhouettes + stepped oil color planes)
  const [broadR, broadG, broadB] = kuwaharaFilterRGB(rawR, rawG, rawB, width, height, 5)
  const [midR, midG, midB] = kuwaharaFilterRGB(rawR, rawG, rawB, width, height, 3)

  const flowLum = boxBlur2D(lum, width, height, 2)
  const fineLum = boxBlur2D(lum, width, height, 1)

  const onDarkSide = new Uint8Array(total)
  for (let i = 0; i < total; i++) {
    if (lum[i] <= fineLum[i] + 1.8) onDarkSide[i] = 1
  }

  const flowTangent = new Float32Array(total)
  const finePower = new Float32Array(total)
  const fineTangent = new Float32Array(total)
  const accentMask = new Uint8Array(total)

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x
      const fdx = (flowLum[idx + 1] - flowLum[idx - 1]) * 0.5
      const fdy = (flowLum[idx + width] - flowLum[idx - width]) * 0.5
      flowTangent[idx] = Math.atan2(fdy, fdx) + Math.PI / 2

      const dxL = (fineLum[idx + 1] - fineLum[idx - 1]) * 0.5
      const dyL = (fineLum[idx + width] - fineLum[idx - width]) * 0.5
      const pL = Math.hypot(dxL, dyL)

      const dxR = (rawR[idx + 1] - rawR[idx - 1]) * 0.42
      const dyR = (rawR[idx + width] - rawR[idx - width]) * 0.42
      const pR = Math.hypot(dxR, dyR)

      const p = Math.max(pL, pR)
      finePower[idx] = p
      fineTangent[idx] = pR > pL ? Math.atan2(dyR, dxR) + Math.PI / 2 : Math.atan2(dyL, dxL) + Math.PI / 2

      const autoAccent = ((rawR[idx] - rawB[idx]) > 36 && p > 2.2) || p > 6.8
      if (tl.hasUserFinale) {
        if ((tl.finaleWeight[idx] > 0.25 && p > 1.5) || autoAccent) accentMask[idx] = 1
      } else if (autoAccent) {
        accentMask[idx] = 1
      }
    }
  }

  const passes = [
    { mode: 'underdraw', spacing: 1.9, length: 10.5, nib: 1.5, opacity: 0.65 },
    { mode: 'underpaint', spacing: 7.2, length: 24.0, nib: 12.5, opacity: 0.97 },
    { mode: 'impasto_body', spacing: 4.3, length: 16.0, nib: 7.8, opacity: 0.98 },
    { mode: 'brushwork', spacing: 2.8, length: 10.5, nib: 4.4, opacity: 0.98 },
    { mode: 'detail', spacing: 1.35, length: 5.2, nib: 2.1, opacity: 0.96 },
    { mode: 'finale', spacing: 1.15, length: 4.2, nib: 2.8, opacity: 0.98 },
  ]

  const rankMap: Record<string, number> = {
    underdraw: 0.0,
    underpaint: tl.sketchFirst ? 0.0 : 0.16,
    impasto_body: tl.sketchFirst ? 0.28 : 0.38,
    brushwork: tl.sketchFirst ? 0.55 : 0.60,
    detail: tl.sketchFirst ? 0.78 : 0.80,
    finale: 1.0,
  }

  const paletteShifts: [number, number, number][] = [
    [14, 5, -11],
    [-11, 3, 14],
    [8, 9, -7],
    [-8, -5, 10],
    [0, 0, 0],
  ]

  const strokes: Stroke[] = []

  for (const pass of passes) {
    const threshold =
      pass.mode === 'underpaint'
        ? 36
        : pass.mode === 'impasto_body'
          ? 26
          : pass.mode === 'brushwork'
            ? 21
            : 17
    const rank = rankMap[pass.mode] ?? 0.5

    const stopR = pass.mode === 'underpaint' ? broadR : pass.mode === 'impasto_body' ? midR : rawR
    const stopG = pass.mode === 'underpaint' ? broadG : pass.mode === 'impasto_body' ? midG : rawG
    const stopB = pass.mode === 'underpaint' ? broadB : pass.mode === 'impasto_body' ? midB : rawB

    for (let gy = 0; gy < height; gy += pass.spacing) {
      for (let gx = 0; gx < width; gx += pass.spacing) {
        const x = Math.min(width - 1, Math.floor(gx + rand() * pass.spacing))
        const y = Math.min(height - 1, Math.floor(gy + rand() * pass.spacing))
        const idx = y * width + x
        const edge = finePower[idx]
        const lVal = lum[idx]
        const darkSide = onDarkSide[idx] === 1

        let isSpecularDab = false
        if (pass.mode === 'underdraw') {
          const minEdge = tl.sketchFirst ? 2.6 : 4.5
          if (!darkSide || edge <= minEdge || rand() >= clamp(edge / (tl.sketchFirst ? 11.5 : 18.0), 0.24, 0.88)) continue
        } else if (pass.mode === 'brushwork') {
          if (edge <= 2.2 || rand() >= clamp(edge / 7.5, 0.25, 0.92)) continue
        } else if (pass.mode === 'detail') {
          if (!darkSide || edge <= 3.2 || rand() >= clamp(edge / 10.5, 0.30, 0.96)) continue
        } else if (pass.mode === 'finale') {
          isSpecularDab = lVal > 240 && edge > 3.0 && rand() < 0.65
          if (!(accentMask[idx] === 1 && edge > 2.6) && !isSpecularDab) continue
        }

        const fx = x / width
        const fy = y / height
        const swirl = 0.28 * Math.sin(8.0 * fx + 6.2 * fy) + 0.15 * Math.cos(16 * fx - 9.5 * fy)
        const useFine = pass.mode === 'underdraw' || pass.mode === 'detail' || pass.mode === 'finale'
        const tgt = useFine ? fineTangent[idx] : flowTangent[idx]
        const ew = useFine ? clamp((edge - 1.2) / 5.2, 0.68, 1.0) : clamp((edge - 0.8) / 5.8, 0.34, 0.96)
        const defaultAngle = -0.66 + swirl
        const angle = 0.5 * Math.atan2(
          (1 - ew) * Math.sin(2 * defaultAngle) + ew * Math.sin(2 * tgt),
          (1 - ew) * Math.cos(2 * defaultAngle) + ew * Math.cos(2 * tgt),
        ) + (rand() - 0.5) * (useFine ? 0.12 : 0.24)

        const span = Math.max(2.2, (pass.length * (0.68 + rand() * 0.68)) / (1 + edge * 0.048))
        const half = span * 0.5

        const cR = pass.mode === 'underpaint' ? broadR[idx] : pass.mode === 'impasto_body' ? 0.35 * midR[idx] + 0.65 * broadR[idx] : pass.mode === 'brushwork' ? midR[idx] : rawR[idx]
        const cG = pass.mode === 'underpaint' ? broadG[idx] : pass.mode === 'impasto_body' ? 0.35 * midG[idx] + 0.65 * broadG[idx] : pass.mode === 'brushwork' ? midG[idx] : rawG[idx]
        const cB = pass.mode === 'underpaint' ? broadB[idx] : pass.mode === 'impasto_body' ? 0.35 * midB[idx] + 0.65 * broadB[idx] : pass.mode === 'brushwork' ? midB[idx] : rawB[idx]

        const traceEnd = (dir: -1 | 1): [number, number] => {
          const dx1 = Math.cos(angle) * half * 0.5 * dir
          const dy1 = Math.sin(angle) * half * 0.5 * dir
          const mx = clamp(x + dx1, 0, width - 1)
          const my = clamp(y + dy1, 0, height - 1)
          const mIdx = Math.round(my) * width + Math.round(mx)
          if (
            Math.abs(stopR[mIdx] - cR) > threshold ||
            Math.abs(stopG[mIdx] - cG) > threshold ||
            Math.abs(stopB[mIdx] - cB) > threshold
          ) {
            return [x + dx1 * 0.45, y + dy1 * 0.45]
          }
          let a2 = useFine ? fineTangent[mIdx] : flowTangent[mIdx]
          if (finePower[mIdx] < 1.1) a2 = angle
          else if (Math.cos(a2 - angle) < 0) a2 += Math.PI
          const blendA = angle + 0.55 * Math.atan2(Math.sin(a2 - angle), Math.cos(a2 - angle))
          const ex = clamp(mx + Math.cos(blendA) * half * 0.5 * dir, 0, width - 1)
          const ey = clamp(my + Math.sin(blendA) * half * 0.5 * dir, 0, height - 1)
          const eIdx = Math.round(ey) * width + Math.round(ex)
          if (
            Math.abs(stopR[eIdx] - cR) > threshold ||
            Math.abs(stopG[eIdx] - cG) > threshold ||
            Math.abs(stopB[eIdx] - cB) > threshold
          ) {
            return [mx, my]
          }
          return [ex, ey]
        }

        const [x0, y0] = traceEnd(-1)
        const [x1, y1] = traceEnd(1)
        const xm = 2 * x - 0.5 * (x0 + x1)
        const ym = 2 * y - 0.5 * (y0 + y1)

        let pr = cR
        let pg = cG
        let pb = cB
        let passOpacity = pass.opacity

        if (pass.mode === 'underdraw') {
          pr = lVal * 0.34 + 84
          pg = lVal * 0.27 + 55
          pb = lVal * 0.21 + 38
          passOpacity = tl.sketchFirst ? 0.65 : 0.42
        } else {
          const shiftScale = pass.mode === 'underpaint' ? 0.95 : pass.mode === 'impasto_body' ? 1.15 : pass.mode === 'brushwork' ? 0.80 : 0.25
          const shift = paletteShifts[Math.floor(rand() * paletteShifts.length)]
          const jitter = (rand() - 0.5) * (useFine ? 6 : 12)
          pr += shift[0] * shiftScale + jitter
          pg += shift[1] * shiftScale + jitter
          pb += shift[2] * shiftScale + jitter
        }

        const rInt = clamp(Math.round(pr), 5, 255)
        const gInt = clamp(Math.round(pg), 5, 255)
        const bInt = clamp(Math.round(pb), 5, 255)
        const alpha = +(passOpacity * (0.94 + rand() * 0.06)).toFixed(2)

        let strokeWidth = Math.max(useFine ? 1.3 : 2.2, (pass.nib * (0.84 + rand() * 0.36)) / (1 + (useFine ? edge / 22 : edge / 42)))
        if (isSpecularDab) {
          strokeWidth = Math.max(strokeWidth, 3.6)
        }

        let impasto: Stroke['impasto']
        const strokeLen = Math.hypot(x1 - x0, y1 - y0)
        const wantImpasto =
          (pass.mode === 'underpaint' || pass.mode === 'impasto_body' || pass.mode === 'brushwork' || isSpecularDab) &&
          strokeWidth >= 3.0 &&
          strokeLen >= 2.5
        if (wantImpasto) {
          const nx = -(y1 - y0) / strokeLen
          const ny = (x1 - x0) / strokeLen
          const wR = clamp(rInt + 8, 0, 255)
          const wG = clamp(gInt + 6, 0, 255)
          const wB = clamp(bInt + 3, 0, 255)
          const cR2 = clamp(rInt - 7, 0, 255)
          const cG2 = clamp(gInt - 6, 0, 255)
          const cB2 = clamp(bInt - 5, 0, 255)
          impasto = {
            nx,
            ny,
            warmColor: `rgba(${wR},${wG},${wB},0.56)`,
            coolColor: `rgba(${cR2},${cG2},${cB2},0.52)`,
            bristleWidth: Math.max(1, strokeWidth * 0.20),
            dabHeight: Math.round(172 + rand() * 58),
          }
        }

        const { moment, frame } = scheduleMomentAndFrame(
          fx,
          fy,
          idx,
          rank,
          pass.mode === 'underdraw',
          rand,
          tl,
        )

        strokes.push({
          x0,
          y0,
          xm,
          ym,
          x1,
          y1,
          color: `rgba(${rInt},${gInt},${bInt},${alpha})`,
          width: strokeWidth,
          impasto,
          frame,
          moment,
        })
      }
    }
  }
  return strokes
}

export async function renderInBrowser(opts: BrowserRenderOptions): Promise<BrowserRenderResult> {
  const {
    image,
    maskCanvas,
    style = 'colored-pencil',
    durationSec,
    baseDirection,
    finaleDirection,
    holdFinale,
    sketchFirst,
    onProgress,
  } = opts

  const maxDim = 720
  const scale = Math.min(1, maxDim / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height))
  // Prefer even dimensions so H.264 MP4 encoding needs zero extra padding/resizing
  const rawWidth = Math.max(2, Math.round((image.naturalWidth || image.width) * scale))
  const rawHeight = Math.max(2, Math.round((image.naturalHeight || image.height) * scale))
  const width = rawWidth > 2 ? rawWidth & ~1 : rawWidth
  const height = rawHeight > 2 ? rawHeight & ~1 : rawHeight
  const frameCount = durationSec === 6 ? 75 : 50
  const rand = mulberry32(1702)

  onProgress?.(
    10,
    style === 'sketch'
      ? '正在采样原图明暗层次与结构轮廓…'
      : style === 'oil'
        ? '正在调配油彩冷暖色盘与曲面笔触流场…'
        : '正在采样原图色彩与轮廓梯度…',
  )
  await new Promise(r => setTimeout(r, 16))

  const srcCanvas = document.createElement('canvas')
  srcCanvas.width = width
  srcCanvas.height = height
  const srcCtx = srcCanvas.getContext('2d')!
  srcCtx.drawImage(image, 0, 0, width, height)
  const srcData = srcCtx.getImageData(0, 0, width, height).data

  const maskTmp = document.createElement('canvas')
  maskTmp.width = width
  maskTmp.height = height
  const maskCtx = maskTmp.getContext('2d')!
  maskCtx.drawImage(maskCanvas, 0, 0, width, height)
  const maskData = maskCtx.getImageData(0, 0, width, height).data

  const timeline = buildTimelineContext(
    maskData,
    width,
    height,
    frameCount,
    baseDirection,
    finaleDirection,
    holdFinale,
    sketchFirst,
  )

  onProgress?.(
    35,
    style === 'sketch'
      ? '正在排布 6 层铅笔素描排线与叙事时间轴…'
      : style === 'oil'
        ? '正在排布 6 层厚涂油画笔触与叙事时间轴…'
        : '正在排布 6 层彩铅笔触与叙事时间轴…',
  )
  await new Promise(r => setTimeout(r, 16))

  const strokes =
    style === 'sketch'
      ? generateSketchStrokes(srcData, width, height, timeline, rand)
      : style === 'oil'
        ? generateOilStrokes(srcData, width, height, timeline, rand)
        : generateColoredPencilStrokes(srcData, width, height, timeline, rand)

  strokes.sort((a, b) => a.moment - b.moment)
  const batches: Stroke[][] = Array.from({ length: frameCount }, () => [])
  for (const s of strokes) {
    batches[s.frame].push(s)
  }

  const paper = style === 'sketch' ? SKETCH_PAPER : style === 'oil' ? OIL_CANVAS : COLORED_PENCIL_PAPER
  onProgress?.(
    68,
    style === 'sketch'
      ? `正在逐帧渲染 ${frameCount} 帧素描纸面…`
      : style === 'oil'
        ? `正在逐帧渲染 ${frameCount} 帧亚麻油画布…`
        : `正在逐帧渲染 ${frameCount} 帧彩铅纸面…`,
  )
  await new Promise(r => setTimeout(r, 16))

  const work = document.createElement('canvas')
  work.width = width
  work.height = height
  const ctx = work.getContext('2d', { alpha: false })!

  let heightWork: HTMLCanvasElement | null = null
  let hCtx: CanvasRenderingContext2D | null = null
  let hHorizBuf: Float32Array | null = null
  let hSmoothBuf: Float32Array | null = null

  if (style === 'oil') {
    heightWork = document.createElement('canvas')
    heightWork.width = width
    heightWork.height = height
    hCtx = heightWork.getContext('2d', { alpha: false, willReadFrequently: true })!
    hCtx.lineCap = 'round'
    hCtx.lineJoin = 'round'
    hHorizBuf = new Float32Array(width * height)
    hSmoothBuf = new Float32Array(width * height)
    paintLinenCanvasGround(ctx, hCtx, width, height)
  } else {
    ctx.fillStyle = `rgb(${paper[0]},${paper[1]},${paper[2]})`
    ctx.fillRect(0, 0, width, height)
  }
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  const frames: HTMLCanvasElement[] = []
  for (let f = 0; f < frameCount; f++) {
    for (const s of batches[f]) {
      ctx.strokeStyle = s.color
      ctx.lineWidth = s.width
      ctx.beginPath()
      ctx.moveTo(s.x0, s.y0)
      if (s.xm !== undefined && s.ym !== undefined) {
        ctx.quadraticCurveTo(s.xm, s.ym, s.x1, s.y1)
      } else {
        ctx.lineTo(s.x1, s.y1)
      }
      ctx.stroke()

      if (s.impasto && s.xm !== undefined && s.ym !== undefined && hCtx) {
        const offX = s.impasto.nx * s.width * 0.24
        const offY = s.impasto.ny * s.width * 0.24
        ctx.lineWidth = s.impasto.bristleWidth
        ctx.strokeStyle = s.impasto.warmColor
        ctx.beginPath()
        ctx.moveTo(s.x0 - offX, s.y0 - offY)
        ctx.quadraticCurveTo(s.xm - offX, s.ym - offY, s.x1 - offX, s.y1 - offY)
        ctx.stroke()

        ctx.strokeStyle = s.impasto.coolColor
        ctx.beginPath()
        ctx.moveTo(s.x0 + offX, s.y0 + offY)
        ctx.quadraticCurveTo(s.xm + offX, s.ym + offY, s.x1 + offX, s.y1 + offY)
        ctx.stroke()

        // Carve buttery plateau dab inside pressed perimeter moat on heightmap
        hCtx.strokeStyle = 'rgba(92,92,92,0.88)'
        hCtx.lineWidth = s.width + 2
        hCtx.beginPath()
        hCtx.moveTo(s.x0, s.y0)
        hCtx.quadraticCurveTo(s.xm, s.ym, s.x1, s.y1)
        hCtx.stroke()

        const dh = s.impasto.dabHeight
        hCtx.strokeStyle = `rgba(${dh},${dh},${dh},0.95)`
        hCtx.lineWidth = s.width
        hCtx.beginPath()
        hCtx.moveTo(s.x0, s.y0)
        hCtx.quadraticCurveTo(s.xm, s.ym, s.x1, s.y1)
        hCtx.stroke()
      } else if (hCtx && s.width >= 1.8 && s.xm !== undefined && s.ym !== undefined) {
        hCtx.strokeStyle = 'rgba(102,102,102,0.65)'
        hCtx.lineWidth = s.width + 1
        hCtx.beginPath()
        hCtx.moveTo(s.x0, s.y0)
        hCtx.quadraticCurveTo(s.xm, s.ym, s.x1, s.y1)
        hCtx.stroke()

        hCtx.strokeStyle = 'rgba(184,184,184,0.78)'
        hCtx.lineWidth = s.width
        hCtx.beginPath()
        hCtx.moveTo(s.x0, s.y0)
        hCtx.quadraticCurveTo(s.xm, s.ym, s.x1, s.y1)
        hCtx.stroke()
      }
    }
    const snap = document.createElement('canvas')
    snap.width = width
    snap.height = height
    const snapCtx = snap.getContext('2d', { alpha: false })!
    if (style === 'oil' && hCtx && hHorizBuf && hSmoothBuf) {
      shadeOilFrame(ctx, hCtx, snapCtx, width, height, hHorizBuf, hSmoothBuf)
    } else {
      snapCtx.drawImage(work, 0, 0)
    }
    frames.push(snap)
  }

  const lastFrame = frames[frames.length - 1]
  const finishedDataUrl = lastFrame.toDataURL('image/png')
  const finishedBlob =
    (await new Promise<Blob | null>(r => lastFrame.toBlob(r, 'image/png'))) ??
    (await (await fetch(finishedDataUrl)).blob())

  onProgress?.(90, '正在生成动态回放与视频文件…')
  await new Promise(r => setTimeout(r, 16))

  const animation = await encodeBestAnimatedImage(frames, width, height, 80, onProgress)
  const mp4Blob = await encodeMp4Video(frames, width, height, 80, onProgress)

  // Free ~100MB of offscreen canvas backing stores on mobile once animated Blob is ready
  let retainedFrames: HTMLCanvasElement[] = frames
  if (animation) {
    for (const snap of frames) {
      snap.width = 0
      snap.height = 0
    }
    retainedFrames = []
  }

  if (heightWork) {
    heightWork.width = 0
    heightWork.height = 0
  }
  work.width = 0
  work.height = 0
  srcCanvas.width = 0
  srcCanvas.height = 0
  maskTmp.width = 0
  maskTmp.height = 0

  onProgress?.(100, '完成')
  return {
    style,
    frames: retainedFrames,
    frameCount,
    finishedDataUrl,
    finishedBlob,
    animation,
    mp4Blob,
    marks: strokes.length,
    durationSec,
    width,
    height,
  }
}

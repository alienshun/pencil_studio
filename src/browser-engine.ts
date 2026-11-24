import { encodeBestAnimatedImage, encodeMp4Video, type EncodedAnimation } from './media-export'

export type SweepDirection = 'top-down' | 'left-right' | 'center-out' | 'edges-in'
export type FinaleDirection = 'top-down' | 'left-right' | 'center-out'

export interface BrowserRenderOptions {
  image: HTMLImageElement
  maskCanvas: HTMLCanvasElement
  durationSec: 4 | 6
  baseDirection: SweepDirection
  finaleDirection: FinaleDirection
  holdFinale: boolean
  sketchFirst: boolean
  onProgress?: (percent: number, label: string) => void
}

export interface BrowserRenderResult {
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

const PAPER: [number, number, number] = [248, 240, 219]

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

function featherMask(src: Uint8Array, width: number, height: number, radius: number): Float32Array {
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

export async function renderInBrowser(opts: BrowserRenderOptions): Promise<BrowserRenderResult> {
  const { image, maskCanvas, durationSec, baseDirection, finaleDirection, holdFinale, sketchFirst, onProgress } = opts
  const maxDim = 720
  const scale = Math.min(1, maxDim / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height))
  // Prefer even dimensions so H.264 MP4 encoding needs zero extra padding/resizing
  const rawWidth = Math.max(2, Math.round((image.naturalWidth || image.width) * scale))
  const rawHeight = Math.max(2, Math.round((image.naturalHeight || image.height) * scale))
  const width = rawWidth > 2 ? rawWidth & ~1 : rawWidth
  const height = rawHeight > 2 ? rawHeight & ~1 : rawHeight
  const frameCount = durationSec === 6 ? 75 : 50
  const rand = mulberry32(1702)

  onProgress?.(10, '正在采样原图色彩与轮廓梯度…')
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

  const pigment = new Uint8ClampedArray(width * height * 3)
  const lum = new Float32Array(width * height)
  const earlyMask = new Uint8Array(width * height)
  const finaleMask = new Uint8Array(width * height)
  let hasUserEarly = false
  let hasUserFinale = false

  for (let i = 0; i < width * height; i++) {
    const r = srcData[i * 4] / 255
    const g = srcData[i * 4 + 1] / 255
    const b = srcData[i * 4 + 2] / 255
    let pr = (r ** 0.84) * 215 + 23
    let pg = (g ** 0.84) * 206 + 24
    let pb = (b ** 0.84) * 188 + 36
    const y = (r + g + b) / 3
    const cool = Math.max(0, Math.min(1, (b - r) * 3.5 + 0.08))
    const warm = Math.max(0, Math.min(1, (r - b - 0.07) * 1.9))
    const lift = Math.sin(Math.PI * y)
    pr += cool * -5 + warm * 14 + lift * 7
    pg += cool * 3 + warm * 3 + lift * 6
    pb += cool * 18 + warm * -7 + lift * 7
    const l = 0.30 * pr + 0.54 * pg + 0.16 * pb
    pigment[i * 3] = Math.max(0, Math.min(255, l + 1.11 * (pr - l)))
    pigment[i * 3 + 1] = Math.max(0, Math.min(255, l + 1.11 * (pg - l)))
    pigment[i * 3 + 2] = Math.max(0, Math.min(255, l + 1.11 * (pb - l)))
    lum[i] = l

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
  const earlyWeight = hasUserEarly ? featherMask(earlyMask, width, height, featherRadius) : new Float32Array(width * height)
  const finaleWeight = hasUserFinale ? featherMask(finaleMask, width, height, featherRadius) : new Float32Array(width * height)

  let finMinX = 1, finMaxX = 0, finMinY = 1, finMaxY = 0
  for (let i = 0; i < width * height; i++) {
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

  const power = new Float32Array(width * height)
  const tangent = new Float32Array(width * height)
  const accentMask = new Uint8Array(width * height)
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
      if (hasUserFinale) {
        if ((finaleWeight[idx] > 0.25 && p > 1.6) || autoAccent) accentMask[idx] = 1
      } else if (autoAccent) {
        accentMask[idx] = 1
      }
    }
  }

  onProgress?.(35, '正在排布 6 层彩铅笔触与叙事时间轴…')
  await new Promise(r => setTimeout(r, 16))

  interface Stroke {
    x0: number
    y0: number
    x1: number
    y1: number
    color: string
    width: number
    frame: number
    moment: number
  }

  const passes = [
    { mode: 'construction', spacing: 2.1, length: 10, nib: 1, opacity: 0.48 },
    { mode: 'blocking', spacing: 4.0, length: 18, nib: 3.6, opacity: 0.72 },
    { mode: 'body', spacing: 2.8, length: 12, nib: 2.1, opacity: 0.74 },
    { mode: 'crosshatch', spacing: 2.5, length: 9.5, nib: 1.1, opacity: 0.64 },
    { mode: 'edge', spacing: 1.3, length: 4.8, nib: 1.0, opacity: 0.82 },
    { mode: 'finale', spacing: 1.0, length: 3.8, nib: 1.1, opacity: 0.92 },
  ]

  const strokes: Stroke[] = []
  for (const pass of passes) {
    const threshold = pass.mode === 'edge' || pass.mode === 'finale' ? 18 : 23
    for (let gy = 0; gy < height; gy += pass.spacing) {
      for (let gx = 0; gx < width; gx += pass.spacing) {
        const x = Math.min(width - 1, Math.floor(gx + rand() * pass.spacing))
        const y = Math.min(height - 1, Math.floor(gy + rand() * pass.spacing))
        const idx = y * width + x
        const edge = power[idx]
        const wEarly = earlyWeight[idx]
        const wFinale = finaleWeight[idx]

        if (pass.mode === 'construction') {
          const minEdge = sketchFirst ? 2.6 : 4.2
          if (edge <= minEdge || rand() >= Math.min(edge / (sketchFirst ? 11.5 : 18), 0.85)) continue
        } else if (pass.mode === 'edge') {
          if (edge <= 2.6 || rand() >= Math.min(0.95, Math.max(0.22, edge / 11))) continue
        } else if (pass.mode === 'finale') {
          if (accentMask[idx] !== 1) continue
        }

        const fx = x / width
        const fy = y / height
        const field = 0.17 * Math.sin(13 * fx + 9 * fy) + 0.08 * Math.cos(29 * fx - 15 * fy)
        let angle = -0.86 + field + (pass.mode === 'crosshatch' ? 0.76 : 0)
        const ew = Math.max(0, Math.min(1, (edge - 1.6) / 9.2))
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

        // Edge-stopping stroke clipping (prevents color bleeding across sharp boundaries)
        let reachNeg = 1.0
        let reachPos = 1.0
        for (const step of [0.25, 0.5, 0.75, 1.0]) {
          if (reachNeg === 1.0) {
            const px = Math.max(0, Math.min(width - 1, Math.round(x - dx * step)))
            const py = Math.max(0, Math.min(height - 1, Math.round(y - dy * step)))
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
            const px = Math.max(0, Math.min(width - 1, Math.round(x + dx * step)))
            const py = Math.max(0, Math.min(height - 1, Math.round(y + dy * step)))
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
          if (sketchFirst) {
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
          pr = pr * 0.89 + PAPER[0] * 0.11
          pg = pg * 0.89 + PAPER[1] * 0.11
          pb = pb * 0.89 + PAPER[2] * 0.11
        }
        const jitter = (rand() - 0.5) * 10
        pr = Math.max(0, Math.min(255, Math.round(pr + jitter)))
        pg = Math.max(0, Math.min(255, Math.round(pg + jitter)))
        pb = Math.max(0, Math.min(255, Math.round(pb + jitter)))
        const alpha = +(passOpacity * (0.8 + rand() * 0.2)).toFixed(2)

        const rawBase = Math.max(0, Math.min(1, directionalSweep(fx, fy, baseDirection) + (rand() - 0.5) * 0.03))
        let localFin = 0
        if (finaleDirection === 'left-right') {
          localFin = (fx - finMinX) / finSpanX
        } else if (finaleDirection === 'center-out') {
          localFin = Math.hypot(fx - finCx, fy - finCy) / finRadius
        } else {
          localFin = (fy - finMinY) / finSpanY
        }
        const rawFin = Math.max(0, Math.min(1, localFin + (rand() - 0.5) * 0.03))
        const useFinaleDelay = hasUserFinale && holdFinale
        const rankMap: Record<string, number> = {
          construction: 0.0,
          blocking: sketchFirst ? 0.0 : 0.16,
          body: sketchFirst ? 0.28 : 0.38,
          crosshatch: sketchFirst ? 0.55 : 0.60,
          edge: sketchFirst ? 0.78 : 0.80,
          finale: 1.0,
        }
        const rank = rankMap[pass.mode] ?? 0.5
        const cNorm = Math.max(0, Math.min(1, 0.82 * rawBase + 0.18 * rank))
        const cNormFin = Math.max(0, Math.min(1, 0.84 * rawFin + 0.16 * rank))
        let moment: number
        if (sketchFirst) {
          if (pass.mode === 'construction') {
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
        const frame = Math.max(1, Math.min(frameCount - 1, 1 + Math.round(moment * (frameCount - 2))))

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

  strokes.sort((a, b) => a.moment - b.moment)
  const batches: Stroke[][] = Array.from({ length: frameCount }, () => [])
  for (const s of strokes) {
    batches[s.frame].push(s)
  }

  onProgress?.(68, `正在逐帧渲染 ${frameCount} 帧彩铅纸面…`)
  await new Promise(r => setTimeout(r, 16))

  const work = document.createElement('canvas')
  work.width = width
  work.height = height
  const ctx = work.getContext('2d', { alpha: false })!
  ctx.fillStyle = `rgb(${PAPER[0]},${PAPER[1]},${PAPER[2]})`
  ctx.fillRect(0, 0, width, height)
  ctx.lineCap = 'round'

  const frames: HTMLCanvasElement[] = []
  for (let f = 0; f < frameCount; f++) {
    for (const s of batches[f]) {
      ctx.strokeStyle = s.color
      ctx.lineWidth = s.width
      ctx.beginPath()
      ctx.moveTo(s.x0, s.y0)
      ctx.lineTo(s.x1, s.y1)
      ctx.stroke()
    }
    const snap = document.createElement('canvas')
    snap.width = width
    snap.height = height
    snap.getContext('2d', { alpha: false })!.drawImage(work, 0, 0)
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

  work.width = 0
  work.height = 0
  srcCanvas.width = 0
  srcCanvas.height = 0
  maskTmp.width = 0
  maskTmp.height = 0

  onProgress?.(100, '完成')
  return {
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

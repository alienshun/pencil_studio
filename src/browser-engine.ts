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
  finishedDataUrl: string
  processBlob: Blob | null
  marks: number
  durationSec: 4 | 6
  width: number
  height: number
}

function writeUInt24LE(buf: Uint8Array, offset: number, value: number) {
  buf[offset] = value & 0xff
  buf[offset + 1] = (value >>> 8) & 0xff
  buf[offset + 2] = (value >>> 16) & 0xff
}

function extractWebpFramePayload(webpBytes: Uint8Array): Uint8Array | null {
  if (webpBytes.byteLength < 20) return null
  const tag = String.fromCharCode(webpBytes[0], webpBytes[1], webpBytes[2], webpBytes[3])
  const fmt = String.fromCharCode(webpBytes[8], webpBytes[9], webpBytes[10], webpBytes[11])
  if (tag !== 'RIFF' || fmt !== 'WEBP') return null

  const view = new DataView(webpBytes.buffer, webpBytes.byteOffset, webpBytes.byteLength)
  let offset = 12
  while (offset + 8 <= webpBytes.byteLength) {
    const fourCC = String.fromCharCode(
      webpBytes[offset],
      webpBytes[offset + 1],
      webpBytes[offset + 2],
      webpBytes[offset + 3],
    )
    const chunkSize = view.getUint32(offset + 4, true)
    const paddedSize = chunkSize + (chunkSize & 1)
    if (offset + 8 + paddedSize > webpBytes.byteLength) break
    if (fourCC === 'VP8 ' || fourCC === 'VP8L') {
      return webpBytes.subarray(offset, offset + 8 + paddedSize)
    }
    offset += 8 + paddedSize
  }
  return null
}

async function encodeAnimatedWebp(
  frames: HTMLCanvasElement[],
  width: number,
  height: number,
  frameMs = 80,
  onProgress?: (percent: number, label: string) => void,
): Promise<Blob | null> {
  const framePayloads: Uint8Array[] = []
  for (let i = 0; i < frames.length; i++) {
    if (i % 10 === 0) {
      onProgress?.(92 + Math.round((i / frames.length) * 7), '正在打包 WebP 动态回放…')
    }
    const blob = await new Promise<Blob | null>(resolve => frames[i].toBlob(resolve, 'image/webp', 0.84))
    if (!blob || blob.type !== 'image/webp') return null
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const payload = extractWebpFramePayload(bytes)
    if (!payload) return null
    framePayloads.push(payload)
  }

  // RIFF header (12) + VP8X chunk (18) + ANIM chunk (14) + sum of ANMF chunks (24 + payload)
  const anmfTotal = framePayloads.reduce((sum, p) => sum + 24 + p.byteLength, 0)
  const totalBytes = 12 + 18 + 14 + anmfTotal
  const out = new Uint8Array(totalBytes)
  const view = new DataView(out.buffer)

  // 'RIFF' + fileSize + 'WEBP'
  out.set([0x52, 0x49, 0x46, 0x46], 0)
  view.setUint32(4, totalBytes - 8, true)
  out.set([0x57, 0x45, 0x42, 0x50], 8)

  // 'VP8X' chunk (10-byte payload)
  out.set([0x56, 0x50, 0x38, 0x58], 12)
  view.setUint32(16, 10, true)
  out[20] = 0x02 // Animation flag
  writeUInt24LE(out, 24, width - 1)
  writeUInt24LE(out, 27, height - 1)

  // 'ANIM' chunk (6-byte payload: BGRA paper background + loopCount = 1)
  out.set([0x41, 0x4e, 0x49, 0x4d], 30)
  view.setUint32(34, 6, true)
  out.set([219, 240, 248, 255], 38)
  view.setUint16(42, 1, true)

  let pos = 44
  for (const payload of framePayloads) {
    // 'ANMF' chunk header (16-byte frame header + bitstream payload)
    out.set([0x41, 0x4e, 0x4d, 0x46], pos)
    view.setUint32(pos + 4, 16 + payload.byteLength, true)
    writeUInt24LE(out, pos + 8, 0) // frameX = 0
    writeUInt24LE(out, pos + 11, 0) // frameY = 0
    writeUInt24LE(out, pos + 14, width - 1)
    writeUInt24LE(out, pos + 17, height - 1)
    writeUInt24LE(out, pos + 20, frameMs)
    out[pos + 23] = 0x02 // Do not alpha-blend (full opaque frame overwrite)
    out.set(payload, pos + 24)
    pos += 24 + payload.byteLength
  }

  return new Blob([out], { type: 'image/webp' })
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

export async function renderInBrowser(opts: BrowserRenderOptions): Promise<BrowserRenderResult> {
  const { image, maskCanvas, durationSec, baseDirection, finaleDirection, holdFinale, sketchFirst, onProgress } = opts
  const maxDim = 720
  const scale = Math.min(1, maxDim / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height))
  const width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale))
  const height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale))
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
    }
  }

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
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x
      const dx = (lum[idx + 1] - lum[idx - 1]) * 0.5
      const dy = (lum[idx + width] - lum[idx - width]) * 0.5
      const p = Math.hypot(dx, dy)
      power[idx] = p
      tangent[idx] = Math.atan2(dy, dx) + Math.PI / 2
      if (!hasUserFinale) {
        const pr = pigment[idx * 3]
        const pb = pigment[idx * 3 + 2]
        if (((pr - pb) > 38 && p > 2.2) || p > 7.2) {
          finaleMask[idx] = 1
        }
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
    { mode: 'construction', spacing: 2.1, length: 10, nib: 1, opacity: 0.48, begin: 0.00, end: 0.14 },
    { mode: 'blocking', spacing: 4.0, length: 18, nib: 3.6, opacity: 0.72, begin: 0.07, end: 0.68 },
    { mode: 'body', spacing: 2.8, length: 12, nib: 2.1, opacity: 0.74, begin: 0.15, end: 0.78 },
    { mode: 'crosshatch', spacing: 2.5, length: 9.5, nib: 1.1, opacity: 0.64, begin: 0.22, end: 0.84 },
    { mode: 'edge', spacing: 1.3, length: 4.8, nib: 1.0, opacity: 0.82, begin: 0.14, end: 0.83 },
    { mode: 'finale', spacing: 1.0, length: 3.8, nib: 1.1, opacity: 0.92, begin: 0.76, end: 1.00 },
  ]

  const strokes: Stroke[] = []
  for (const pass of passes) {
    for (let gy = 0; gy < height; gy += pass.spacing) {
      for (let gx = 0; gx < width; gx += pass.spacing) {
        const x = Math.min(width - 1, Math.floor(gx + rand() * pass.spacing))
        const y = Math.min(height - 1, Math.floor(gy + rand() * pass.spacing))
        const idx = y * width + x
        const edge = power[idx]
        const isEarly = earlyMask[idx] === 1
        const isFinale = finaleMask[idx] === 1

        if (pass.mode === 'construction') {
          const minEdge = sketchFirst ? 2.6 : 4.2
          if (edge <= minEdge || rand() >= Math.min(edge / (sketchFirst ? 11.5 : 18), 0.85)) continue
        } else if (pass.mode === 'edge') {
          if (edge <= 2.6 || rand() >= Math.min(0.95, Math.max(0.22, edge / 11))) continue
        } else if (pass.mode === 'finale') {
          if (!isFinale) continue
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

        let pr = pigment[idx * 3]
        let pg = pigment[idx * 3 + 1]
        let pb = pigment[idx * 3 + 2]
        if (pass.mode === 'construction') {
          pr = pr * 0.26 + 66
          pg = pg * 0.26 + 63
          pb = pb * 0.26 + 74
        } else if (pass.mode === 'blocking') {
          pr = pr * 0.89 + PAPER[0] * 0.11
          pg = pg * 0.89 + PAPER[1] * 0.11
          pb = pb * 0.89 + PAPER[2] * 0.11
        }
        const jitter = (rand() - 0.5) * 10
        pr = Math.max(0, Math.min(255, Math.round(pr + jitter)))
        pg = Math.max(0, Math.min(255, Math.round(pg + jitter)))
        pb = Math.max(0, Math.min(255, Math.round(pb + jitter)))
        const alpha = +(pass.opacity * (0.8 + rand() * 0.2)).toFixed(2)

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
          blocking: 0.0,
          body: 0.28,
          crosshatch: 0.55,
          edge: 0.78,
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
            moment = isFinale ? 0.74 + cNormFin * 0.26 : 0.25 + cNorm * 0.49 * (isEarly ? 0.6 : 1)
          } else {
            moment = 0.25 + cNorm * 0.75 * (isEarly ? 0.65 : 1)
          }
        } else if (useFinaleDelay) {
          moment = isFinale ? 0.74 + cNormFin * 0.26 : cNorm * 0.72 * (isEarly ? 0.6 : 1)
        } else {
          moment = cNorm * (isEarly ? 0.65 : 1)
        }
        const frame = Math.max(1, Math.min(frameCount - 1, 1 + Math.round(moment * (frameCount - 2))))

        strokes.push({
          x0: x - dx,
          y0: y - dy,
          x1: x + dx,
          y1: y + dy,
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

  onProgress?.(70, `正在逐帧渲染 ${frameCount} 帧彩铅纸面…`)
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

  onProgress?.(92, '正在打包 WebP 动态回放…')
  await new Promise(r => setTimeout(r, 16))
  const processBlob = await encodeAnimatedWebp(frames, width, height, 80, onProgress)

  onProgress?.(100, '完成')
  return {
    frames,
    finishedDataUrl: frames[frames.length - 1].toDataURL('image/png'),
    processBlob,
    marks: strokes.length,
    durationSec,
    width,
    height,
  }
}

export type ProgressCallback = (percent: number, label: string) => void

export interface EncodedAnimation {
  blob: Blob
  ext: 'webp' | 'gif'
  mime: 'image/webp' | 'image/gif'
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

/**
 * Pack frames into an animated WebP container using native Canvas WebP encoding.
 * Returns null immediately on browsers (such as iOS/macOS WebKit) where canvas.toBlob('image/webp')
 * silently falls back to 'image/png'.
 */
export async function encodeAnimatedWebp(
  frames: HTMLCanvasElement[],
  width: number,
  height: number,
  frameMs = 80,
  onProgress?: ProgressCallback,
): Promise<Blob | null> {
  if (frames.length === 0) return null
  const framePayloads: Uint8Array[] = []
  for (let i = 0; i < frames.length; i++) {
    if (i % 12 === 0) {
      onProgress?.(90 + Math.round((i / frames.length) * 4), '正在打包 WebP 动态回放…')
    }
    const blob = await new Promise<Blob | null>(resolve => frames[i].toBlob(resolve, 'image/webp', 0.84))
    if (!blob || blob.type !== 'image/webp') return null
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const payload = extractWebpFramePayload(bytes)
    if (!payload) return null
    framePayloads.push(payload)
  }

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
    out.set([0x41, 0x4e, 0x4d, 0x46], pos)
    view.setUint32(pos + 4, 16 + payload.byteLength, true)
    writeUInt24LE(out, pos + 8, 0)
    writeUInt24LE(out, pos + 11, 0)
    writeUInt24LE(out, pos + 14, width - 1)
    writeUInt24LE(out, pos + 17, height - 1)
    writeUInt24LE(out, pos + 20, frameMs)
    out[pos + 23] = 0x02 // Overwrite full opaque frame
    out.set(payload, pos + 24)
    pos += 24 + payload.byteLength
  }

  return new Blob([out], { type: 'image/webp' })
}

// ---------------------------------------------------------------------------
// Pure TypeScript GIF89a Encoder (Universal fallback for iOS/Safari & HTTP LAN)
// ---------------------------------------------------------------------------

interface ColorBucket {
  pixels: Uint8Array // [r, g, b, r, g, b, ...]
  count: number
}

function bucketChannelRange(bucket: ColorBucket): { axis: 0 | 1 | 2; span: number } {
  const { pixels, count } = bucket
  if (count <= 1) return { axis: 0, span: 0 }
  let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0
  for (let i = 0; i < count * 3; i += 3) {
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2]
    if (r < rMin) rMin = r
    if (r > rMax) rMax = r
    if (g < gMin) gMin = g
    if (g > gMax) gMax = g
    if (b < bMin) bMin = b
    if (b > bMax) bMax = b
  }
  const rSpan = rMax - rMin
  const gSpan = gMax - gMin
  const bSpan = bMax - bMin
  if (gSpan >= rSpan && gSpan >= bSpan) return { axis: 1, span: gSpan }
  if (rSpan >= bSpan) return { axis: 0, span: rSpan }
  return { axis: 2, span: bSpan }
}

function buildMedianCutPalette(samples: Uint8Array, maxColors = 255): Uint8Array {
  const totalPixels = Math.floor(samples.length / 3)
  const palette = new Uint8Array(256 * 3)
  if (totalPixels === 0) return palette

  const buckets: ColorBucket[] = [{ pixels: samples.slice(0, totalPixels * 3), count: totalPixels }]

  while (buckets.length < maxColors) {
    let bestIdx = -1
    let bestScore = 0
    let bestAxis: 0 | 1 | 2 = 0
    for (let i = 0; i < buckets.length; i++) {
      if (buckets[i].count < 2) continue
      const { axis, span } = bucketChannelRange(buckets[i])
      const score = span * Math.sqrt(buckets[i].count)
      if (span > 0 && score > bestScore) {
        bestScore = score
        bestIdx = i
        bestAxis = axis
      }
    }
    if (bestIdx === -1) break

    const target = buckets[bestIdx]
    const indices = new Uint32Array(target.count)
    for (let i = 0; i < target.count; i++) indices[i] = i
    const px = target.pixels
    const ax = bestAxis
    indices.sort((a, b) => px[a * 3 + ax] - px[b * 3 + ax])

    const mid = target.count >> 1
    const leftPx = new Uint8Array(mid * 3)
    const rightPx = new Uint8Array((target.count - mid) * 3)
    for (let i = 0; i < mid; i++) {
      const src = indices[i] * 3
      leftPx[i * 3] = px[src]
      leftPx[i * 3 + 1] = px[src + 1]
      leftPx[i * 3 + 2] = px[src + 2]
    }
    for (let i = mid; i < target.count; i++) {
      const src = indices[i] * 3
      const dst = (i - mid) * 3
      rightPx[dst] = px[src]
      rightPx[dst + 1] = px[src + 1]
      rightPx[dst + 2] = px[src + 2]
    }
    buckets[bestIdx] = { pixels: leftPx, count: mid }
    buckets.push({ pixels: rightPx, count: target.count - mid })
  }

  // Always reserve slot 0 for exact warm paper color if present, and slots 0..254 for opaque colors.
  // Slot 255 is reserved as transparent index for inter-frame delta compression.
  for (let i = 0; i < buckets.length && i < maxColors; i++) {
    const { pixels, count } = buckets[i]
    let rSum = 0, gSum = 0, bSum = 0
    for (let j = 0; j < count * 3; j += 3) {
      rSum += pixels[j]
      gSum += pixels[j + 1]
      bSum += pixels[j + 2]
    }
    palette[i * 3] = Math.round(rSum / count)
    palette[i * 3 + 1] = Math.round(gSum / count)
    palette[i * 3 + 2] = Math.round(bSum / count)
  }

  return palette
}

function buildRgb15Lookup(palette: Uint8Array, colorCount: number): Uint8Array {
  const lut = new Uint8Array(32768)
  for (let r5 = 0; r5 < 32; r5++) {
    const r = (r5 << 3) | (r5 >> 2)
    for (let g5 = 0; g5 < 32; g5++) {
      const g = (g5 << 3) | (g5 >> 2)
      for (let b5 = 0; b5 < 32; b5++) {
        const b = (b5 << 3) | (b5 >> 2)
        let bestIdx = 0
        let bestDist = 0x7fffffff
        for (let c = 0; c < colorCount; c++) {
          const dr = r - palette[c * 3]
          const dg = g - palette[c * 3 + 1]
          const db = b - palette[c * 3 + 2]
          const dist = dr * dr * 2 + dg * dg * 4 + db * db
          if (dist < bestDist) {
            bestDist = dist
            bestIdx = c
            if (dist === 0) break
          }
        }
        lut[(r5 << 10) | (g5 << 5) | b5] = bestIdx
      }
    }
  }
  return lut
}

class GifByteWriter {
  private buf = new Uint8Array(256 * 1024)
  private pos = 0

  private ensure(extra: number) {
    if (this.pos + extra <= this.buf.length) return
    let nextLen = this.buf.length * 2
    while (nextLen < this.pos + extra) nextLen *= 2
    const next = new Uint8Array(nextLen)
    next.set(this.buf.subarray(0, this.pos))
    this.buf = next
  }

  writeByte(v: number) {
    this.ensure(1)
    this.buf[this.pos++] = v & 0xff
  }

  writeU16LE(v: number) {
    this.ensure(2)
    this.buf[this.pos++] = v & 0xff
    this.buf[this.pos++] = (v >>> 8) & 0xff
  }

  writeBytes(arr: ArrayLike<number>) {
    this.ensure(arr.length)
    this.buf.set(arr, this.pos)
    this.pos += arr.length
  }

  toUint8Array(): Uint8Array {
    return this.buf.subarray(0, this.pos)
  }
}

export function encodeGifFromRgbaFrames(
  rgbaFrames: Uint8ClampedArray[],
  width: number,
  height: number,
  frameMs = 80,
  finalHoldMs = 800,
): Blob {
  const frameCount = rgbaFrames.length
  const pixelCount = width * height

  // Sample colors across early sketch, mid-coloring, and final frame + warm ivory paper color
  const sampleFrames = Array.from(new Set([
    0,
    Math.min(frameCount - 1, Math.floor(frameCount * 0.22)),
    Math.min(frameCount - 1, Math.floor(frameCount * 0.55)),
    frameCount - 1,
  ]))
  const stride = Math.max(1, Math.floor((pixelCount * sampleFrames.length) / 9000))
  const sampleBuf: number[] = [248, 240, 219]
  for (const fi of sampleFrames) {
    const rgba = rgbaFrames[fi]
    for (let p = 0; p < pixelCount; p += stride) {
      const o = p * 4
      sampleBuf.push(rgba[o], rgba[o + 1], rgba[o + 2])
    }
  }

  const colorCount = 255 // Index 255 reserved for transparency
  const palette = buildMedianCutPalette(new Uint8Array(sampleBuf), colorCount)
  const lut = buildRgb15Lookup(palette, colorCount)

  const out = new GifByteWriter()
  // Header: GIF89a
  out.writeBytes([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  // Logical Screen Descriptor
  out.writeU16LE(width)
  out.writeU16LE(height)
  out.writeByte(0xf7) // Global Color Table, 8-bit, 256 entries
  out.writeByte(0x00)
  out.writeByte(0x00)
  // Global Color Table (768 bytes)
  out.writeBytes(palette)
  // NETSCAPE2.0 Infinite Loop Application Extension
  out.writeBytes([
    0x21, 0xff, 0x0b,
    0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30,
    0x03, 0x01, 0x00, 0x00, 0x00,
  ])

  // Reusable O(1) LZW dictionary structures (4096 prefixes * 256 suffixes)
  const dictCode = new Int16Array(4096 * 256)
  const dictStamp = new Int32Array(4096 * 256)
  let stampGen = 1
  const subBlock = new Uint8Array(255)

  const prevIndexed = new Uint8Array(pixelCount)
  const currIndexed = new Uint8Array(pixelCount)
  const normalDelayCs = Math.max(2, Math.round(frameMs / 10))
  const finalDelayCs = Math.max(normalDelayCs, Math.round(finalHoldMs / 10))

  for (let f = 0; f < frameCount; f++) {
    const rgba = rgbaFrames[f]
    for (let p = 0; p < pixelCount; p++) {
      const o = p * 4
      currIndexed[p] = lut[((rgba[o] >> 3) << 10) | ((rgba[o + 1] >> 3) << 5) | (rgba[o + 2] >> 3)]
    }

    let subX = 0, subY = 0, subW = width, subH = height
    let indices: Uint8Array
    let useTransparency = false

    if (f === 0) {
      indices = currIndexed
      prevIndexed.set(currIndexed)
    } else {
      let minX = width, minY = height, maxX = -1, maxY = -1
      for (let y = 0; y < height; y++) {
        const row = y * width
        for (let x = 0; x < width; x++) {
          const p = row + x
          if (currIndexed[p] !== prevIndexed[p]) {
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
          }
        }
      }
      useTransparency = true
      if (maxX < minX) {
        subX = 0
        subY = 0
        subW = 1
        subH = 1
        indices = new Uint8Array([255])
      } else {
        subX = minX
        subY = minY
        subW = maxX - minX + 1
        subH = maxY - minY + 1
        indices = new Uint8Array(subW * subH)
        let k = 0
        for (let y = minY; y <= maxY; y++) {
          const row = y * width
          for (let x = minX; x <= maxX; x++) {
            const p = row + x
            const c = currIndexed[p]
            if (c === prevIndexed[p]) {
              indices[k++] = 255
            } else {
              indices[k++] = c
              prevIndexed[p] = c
            }
          }
        }
      }
    }

    // Graphic Control Extension
    const delayCs = f === frameCount - 1 ? finalDelayCs : normalDelayCs
    out.writeBytes([
      0x21, 0xf9, 0x04,
      useTransparency ? 0x05 : 0x04, // disposal = 1 (do not dispose), transparent flag
    ])
    out.writeU16LE(delayCs)
    out.writeByte(255) // transparent color index
    out.writeByte(0x00)

    // Image Descriptor
    out.writeByte(0x2c)
    out.writeU16LE(subX)
    out.writeU16LE(subY)
    out.writeU16LE(subW)
    out.writeU16LE(subH)
    out.writeByte(0x00)

    // LZW Minimum Code Size = 8
    const minCodeSize = 8
    const clearCode = 256
    const eoiCode = 257
    out.writeByte(minCodeSize)

    let codeSize = 9
    let nextCode = 258
    stampGen++
    if (stampGen >= 0x7ffffff0) {
      dictStamp.fill(0)
      stampGen = 1
    }

    let bitBuf = 0
    let bitCount = 0
    let subLen = 0

    const emitCode = (code: number) => {
      bitBuf |= code << bitCount
      bitCount += codeSize
      while (bitCount >= 8) {
        subBlock[subLen++] = bitBuf & 0xff
        if (subLen === 255) {
          out.writeByte(255)
          out.writeBytes(subBlock)
          subLen = 0
        }
        bitBuf >>>= 8
        bitCount -= 8
      }
    }

    emitCode(clearCode)
    let prefix = indices[0]
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i]
      const key = (prefix << 8) | k
      if (dictStamp[key] === stampGen) {
        prefix = dictCode[key]
      } else {
        emitCode(prefix)
        if (nextCode < 4096) {
          dictStamp[key] = stampGen
          dictCode[key] = nextCode++
          if (nextCode > (1 << codeSize) && codeSize < 12) {
            codeSize++
          }
        } else {
          emitCode(clearCode)
          codeSize = 9
          nextCode = 258
          stampGen++
          if (stampGen >= 0x7ffffff0) {
            dictStamp.fill(0)
            stampGen = 1
          }
        }
        prefix = k
      }
    }
    emitCode(prefix)
    emitCode(eoiCode)

    if (bitCount > 0) {
      subBlock[subLen++] = bitBuf & 0xff
    }
    if (subLen > 0) {
      out.writeByte(subLen)
      out.writeBytes(subBlock.subarray(0, subLen))
    }
    out.writeByte(0x00) // Block terminator
  }

  // GIF Trailer
  out.writeByte(0x3b)
  return new Blob([out.toUint8Array() as Uint8Array<ArrayBuffer>], { type: 'image/gif' })
}

export async function encodeAnimatedGif(
  frames: HTMLCanvasElement[],
  width: number,
  height: number,
  frameMs = 80,
  onProgress?: ProgressCallback,
): Promise<Blob | null> {
  if (frames.length === 0) return null
  onProgress?.(92, '正在生成全平台兼容 GIF 动态回放…')
  await new Promise(r => setTimeout(r, 0))
  const rgbaFrames = frames.map(f => f.getContext('2d')!.getImageData(0, 0, width, height).data)
  return encodeGifFromRgbaFrames(rgbaFrames, width, height, frameMs, 800)
}

export async function encodeBestAnimatedImage(
  frames: HTMLCanvasElement[],
  width: number,
  height: number,
  frameMs = 80,
  onProgress?: ProgressCallback,
): Promise<EncodedAnimation | null> {
  const webp = await encodeAnimatedWebp(frames, width, height, frameMs, onProgress)
  if (webp) {
    return { blob: webp, ext: 'webp', mime: 'image/webp' }
  }
  const gif = await encodeAnimatedGif(frames, width, height, frameMs, onProgress)
  if (gif) {
    return { blob: gif, ext: 'gif', mime: 'image/gif' }
  }
  return null
}

// ---------------------------------------------------------------------------
// ISO BMFF (MP4) Muxer + WebCodecs H.264 Encoder (iOS 16.4+, Android, Desktop)
// ---------------------------------------------------------------------------

export interface AvcSample {
  data: Uint8Array
  isKey: boolean
  durationMs: number
}

function u16BE(v: number): Uint8Array {
  return new Uint8Array([(v >>> 8) & 0xff, v & 0xff])
}

function u32BE(v: number): Uint8Array {
  return new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff])
}

function asciiBytes(s: string): Uint8Array {
  const arr = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i) & 0x7f
  return arr
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((acc, p) => acc + p.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.byteLength
  }
  return out
}

function mp4Box(type: string, ...payloads: Uint8Array[]): Uint8Array {
  const bodyLen = payloads.reduce((acc, p) => acc + p.byteLength, 0)
  return concatBytes(u32BE(8 + bodyLen), asciiBytes(type), ...payloads)
}

function mp4FullBox(type: string, version: number, flags: number, ...payloads: Uint8Array[]): Uint8Array {
  const vf = new Uint8Array([
    version & 0xff,
    (flags >>> 16) & 0xff,
    (flags >>> 8) & 0xff,
    flags & 0xff,
  ])
  return mp4Box(type, vf, ...payloads)
}

/**
 * Mux length-prefixed H.264 (AVC) samples + avcC configuration record into a faststart MP4 container
 * compatible with iOS Safari / Photos (AVFoundation), Android Gallery, WeChat, and desktop players.
 */
export function muxAvcMp4(
  width: number,
  height: number,
  avcCBytes: Uint8Array,
  samples: AvcSample[],
): Uint8Array {
  const timescale = 1000 // 1 unit = 1 ms
  const totalDurationMs = samples.reduce((sum, s) => sum + Math.max(1, Math.round(s.durationMs)), 0)

  const ftyp = mp4Box(
    'ftyp',
    asciiBytes('isom'),
    u32BE(0x00000200),
    asciiBytes('isomiso2avc1mp41'),
  )

  const unityMatrix = concatBytes(
    u32BE(0x00010000), u32BE(0), u32BE(0),
    u32BE(0), u32BE(0x00010000), u32BE(0),
    u32BE(0), u32BE(0), u32BE(0x40000000),
  )

  const buildMoov = (mdatPayloadOffset: number): Uint8Array => {
    const mvhd = mp4FullBox(
      'mvhd', 0, 0,
      u32BE(0), // creation_time
      u32BE(0), // modification_time
      u32BE(timescale),
      u32BE(totalDurationMs),
      u32BE(0x00010000), // rate = 1.0
      u16BE(0x0100), // volume = 1.0
      new Uint8Array(10), // reserved
      unityMatrix,
      new Uint8Array(24), // pre_defined
      u32BE(2), // next_track_ID
    )

    const tkhd = mp4FullBox(
      'tkhd', 0, 0x000003, // track_enabled | track_in_movie
      u32BE(0), // creation_time
      u32BE(0), // modification_time
      u32BE(1), // track_ID
      u32BE(0), // reserved
      u32BE(totalDurationMs),
      new Uint8Array(8), // reserved
      u16BE(0), // layer
      u16BE(0), // alternate_group
      u16BE(0), // volume = 0 for video
      u16BE(0), // reserved
      unityMatrix,
      u32BE(width * 65536), // 16.16 fixed-point width
      u32BE(height * 65536), // 16.16 fixed-point height
    )

    const mdhd = mp4FullBox(
      'mdhd', 0, 0,
      u32BE(0),
      u32BE(0),
      u32BE(timescale),
      u32BE(totalDurationMs),
      u16BE(0x55c4), // 'und'
      u16BE(0),
    )

    const hdlr = mp4FullBox(
      'hdlr', 0, 0,
      u32BE(0),
      asciiBytes('vide'),
      new Uint8Array(12),
      asciiBytes('VideoHandler\0'),
    )

    const vmhd = mp4FullBox('vmhd', 0, 0x000001, new Uint8Array(8))
    const dref = mp4FullBox('dref', 0, 0, u32BE(1), mp4FullBox('url ', 0, 0x000001))
    const dinf = mp4Box('dinf', dref)

    // VisualSampleEntry ('avc1'): 78 fixed bytes + child boxes ('avcC', 'pasp')
    const avc1Header = concatBytes(
      new Uint8Array(6), // reserved
      u16BE(1), // data_reference_index
      new Uint8Array(16), // pre_defined + reserved
      u16BE(width),
      u16BE(height),
      u32BE(0x00480000), // horizresolution = 72 dpi
      u32BE(0x00480000), // vertresolution = 72 dpi
      u32BE(0), // reserved
      u16BE(1), // frame_count = 1
      new Uint8Array(32), // compressorname
      u16BE(0x0018), // depth = 24
      u16BE(0xffff), // pre_defined = -1
    )
    const avc1 = mp4Box(
      'avc1',
      avc1Header,
      mp4Box('avcC', avcCBytes),
      mp4Box('pasp', u32BE(1), u32BE(1)),
    )
    const stsd = mp4FullBox('stsd', 0, 0, u32BE(1), avc1)

    // Run-length encode sample durations for 'stts'
    const runs: Array<{ count: number; delta: number }> = []
    for (const s of samples) {
      const delta = Math.max(1, Math.round(s.durationMs))
      const last = runs[runs.length - 1]
      if (last && last.delta === delta) {
        last.count++
      } else {
        runs.push({ count: 1, delta })
      }
    }
    const sttsEntries = runs.map(r => concatBytes(u32BE(r.count), u32BE(r.delta)))
    const stts = mp4FullBox('stts', 0, 0, u32BE(runs.length), ...sttsEntries)

    // Sync sample table ('stss') — 1-based keyframe indices
    const keyIndices: Uint8Array[] = []
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].isKey) keyIndices.push(u32BE(i + 1))
    }
    const stss = mp4FullBox('stss', 0, 0, u32BE(keyIndices.length), ...keyIndices)

    // All samples stored contiguously in single chunk #1
    const stsc = mp4FullBox('stsc', 0, 0, u32BE(1), u32BE(1), u32BE(samples.length), u32BE(1))
    const stsz = mp4FullBox(
      'stsz', 0, 0,
      u32BE(0),
      u32BE(samples.length),
      ...samples.map(s => u32BE(s.data.byteLength)),
    )
    const stco = mp4FullBox('stco', 0, 0, u32BE(1), u32BE(mdatPayloadOffset))

    const stbl = mp4Box('stbl', stsd, stts, stss, stsc, stsz, stco)
    const minf = mp4Box('minf', vmhd, dinf, stbl)
    const mdia = mp4Box('mdia', mdhd, hdlr, minf)
    const trak = mp4Box('trak', tkhd, mdia)
    return mp4Box('moov', mvhd, trak)
  }

  const placeholderMoov = buildMoov(0)
  const mdatPayloadOffset = ftyp.byteLength + placeholderMoov.byteLength + 8
  const moov = buildMoov(mdatPayloadOffset)

  const mdatBodyLen = samples.reduce((sum, s) => sum + s.data.byteLength, 0)
  const totalLen = ftyp.byteLength + moov.byteLength + 8 + mdatBodyLen
  const fileBytes = new Uint8Array(totalLen)
  fileBytes.set(ftyp, 0)
  fileBytes.set(moov, ftyp.byteLength)

  const mdatHeaderPos = ftyp.byteLength + moov.byteLength
  fileBytes.set(u32BE(8 + mdatBodyLen), mdatHeaderPos)
  fileBytes.set(asciiBytes('mdat'), mdatHeaderPos + 4)

  let cursor = mdatHeaderPos + 8
  for (const s of samples) {
    fileBytes.set(s.data, cursor)
    cursor += s.data.byteLength
  }
  return fileBytes
}

/**
 * Encode canvas frames into an H.264 MP4 Blob using WebCodecs VideoEncoder when available
 * (supported on iOS Safari 16.4+, Android Chrome, macOS Safari/Chrome, Windows Chrome/Edge/Firefox).
 * Safely returns null when unavailable (e.g. non-HTTPS LAN origins or older browsers).
 */
export async function encodeMp4Video(
  frames: Array<CanvasImageSource & { width: number; height: number }>,
  width: number,
  height: number,
  frameMs = 80,
  onProgress?: ProgressCallback,
): Promise<Blob | null> {
  if (frames.length === 0) return null
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    return null
  }

  // H.264 YUV 4:2:0 requires even dimensions >= 16
  const mp4Width = Math.max(16, width & ~1)
  const mp4Height = Math.max(16, height & ~1)
  const codecs = ['avc1.42001f', 'avc1.42e01f', 'avc1.4d001f', 'avc1.420028']

  let chosenConfig: VideoEncoderConfig | null = null
  for (const codec of codecs) {
    const candidate: VideoEncoderConfig = {
      codec,
      width: mp4Width,
      height: mp4Height,
      bitrate: 2_400_000,
      framerate: 1000 / frameMs,
      avc: { format: 'avc' },
      latencyMode: 'realtime',
    }
    try {
      const support = await VideoEncoder.isConfigSupported(candidate)
      if (support.supported) {
        chosenConfig = support.config ?? candidate
        break
      }
    } catch {
      // Try next profile
    }
  }
  if (!chosenConfig) return null

  let encoder: VideoEncoder | null = null
  try {
    onProgress?.(95, '正在编码高清 MP4 绘画视频…')
    let avcCBytes: Uint8Array | null = null
    let encodeFailed = false
    const rawChunks: Array<{ data: Uint8Array; isKey: boolean; timestampUs: number }> = []

    encoder = new VideoEncoder({
      output: (chunk, meta) => {
        // Cache decoderConfig on single read (Safari WebKit quirk guard)
        const decoderConfig = meta?.decoderConfig
        if (decoderConfig?.description && !avcCBytes) {
          const desc = decoderConfig.description
          if (desc instanceof ArrayBuffer) {
            avcCBytes = new Uint8Array(desc.slice(0))
          } else if (ArrayBuffer.isView(desc)) {
            avcCBytes = new Uint8Array(desc.buffer.slice(desc.byteOffset, desc.byteOffset + desc.byteLength))
          }
        }
        const data = new Uint8Array(chunk.byteLength)
        chunk.copyTo(data)
        rawChunks.push({
          data,
          isKey: chunk.type === 'key',
          timestampUs: chunk.timestamp,
        })
      },
      error: () => {
        encodeFailed = true
      },
    })

    encoder.configure({
      ...chosenConfig,
      avc: { format: 'avc' },
    })

    const needEvenPad = mp4Width !== width || mp4Height !== height
    let evenCanvas: HTMLCanvasElement | null = null
    let evenCtx: CanvasRenderingContext2D | null = null
    if (needEvenPad) {
      evenCanvas = document.createElement('canvas')
      evenCanvas.width = mp4Width
      evenCanvas.height = mp4Height
      evenCtx = evenCanvas.getContext('2d', { alpha: false })
    }

    const frameUs = frameMs * 1000
    const finalHoldMs = 720

    for (let i = 0; i < frames.length; i++) {
      if (encodeFailed) break
      let src: CanvasImageSource = frames[i]
      if (evenCanvas && evenCtx) {
        evenCtx.drawImage(src, 0, 0, mp4Width, mp4Height)
        src = evenCanvas
      }
      const vf = new VideoFrame(src, {
        timestamp: i * frameUs,
        duration: (i === frames.length - 1 ? finalHoldMs * 1000 : frameUs),
      })
      try {
        encoder.encode(vf, { keyFrame: i === 0 || i % 25 === 0 })
      } finally {
        vf.close()
      }
    }

    if (!encodeFailed) {
      await encoder.flush()
    }
    encoder.close()
    encoder = null

    if (encodeFailed || !avcCBytes || rawChunks.length === 0) {
      return null
    }

    // Ensure non-decreasing timestamps and compute accurate sample durations
    const samples: AvcSample[] = rawChunks.map((chunk, idx) => {
      const next = rawChunks[idx + 1]
      const deltaMs = next
        ? Math.max(1, Math.round((next.timestampUs - chunk.timestampUs) / 1000))
        : finalHoldMs
      return {
        data: chunk.data,
        isKey: chunk.isKey,
        durationMs: deltaMs,
      }
    })

    const mp4Bytes = muxAvcMp4(mp4Width, mp4Height, avcCBytes, samples)
    return new Blob([mp4Bytes as Uint8Array<ArrayBuffer>], { type: 'video/mp4' })
  } catch {
    try {
      encoder?.close()
    } catch {
      // Ignore secondary close error
    }
    return null
  }
}

interface MinimalImageDecoder {
  tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } | null }
  decode(opts: { frameIndex: number }): Promise<{ image: VideoFrame }>
  close(): void
}

/**
 * Optional helper for Local Python mode: transcode an animated WebP Blob into H.264 MP4
 * when both ImageDecoder and VideoEncoder are supported by the browser.
 */
export async function encodeMp4FromWebpBlob(
  webpBlob: Blob,
  frameMs = 80,
): Promise<Blob | null> {
  const DecoderCtor = (globalThis as unknown as {
    ImageDecoder?: new (init: { data: BufferSource; type: string }) => MinimalImageDecoder
  }).ImageDecoder
  if (!DecoderCtor || typeof VideoEncoder === 'undefined') return null

  let decoder: MinimalImageDecoder | null = null
  const canvases: HTMLCanvasElement[] = []
  try {
    const bytes = new Uint8Array(await webpBlob.arrayBuffer())
    decoder = new DecoderCtor({ data: bytes, type: 'image/webp' })
    await decoder.tracks.ready
    const count = decoder.tracks.selectedTrack?.frameCount ?? 0
    if (count < 2) {
      decoder.close()
      return null
    }
    let width = 0
    let height = 0
    for (let i = 0; i < count; i++) {
      const { image } = await decoder.decode({ frameIndex: i })
      try {
        if (i === 0) {
          width = image.displayWidth
          height = image.displayHeight
        }
        const c = document.createElement('canvas')
        c.width = width
        c.height = height
        c.getContext('2d', { alpha: false })!.drawImage(image, 0, 0, width, height)
        canvases.push(c)
      } finally {
        image.close()
      }
    }
    decoder.close()
    decoder = null
    return await encodeMp4Video(canvases, width, height, frameMs)
  } catch {
    try {
      decoder?.close()
    } catch {
      // Ignore close error
    }
    return null
  } finally {
    for (const c of canvases) {
      c.width = 0
      c.height = 0
    }
  }
}

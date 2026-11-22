import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const ENGINE_SCRIPT = path.join(ROOT, 'engine', 'draw.py')

const MAX_BODY_BYTES = 14 * 1024 * 1024 // 14 MB JSON body cap
const MAX_PHOTO_BYTES = 6 * 1024 * 1024
const MAX_MASK_BYTES = 3 * 1024 * 1024
const RENDER_TIMEOUT_MS = 35_000
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

let activeRenderCount = 0
let pingCheckPromise: Promise<boolean> | null = null

function resolvePythonExecutable(): string {
  const candidates = [
    path.join(ROOT, '.venv', 'bin', 'python'),
    path.join(ROOT, '.venv', 'Scripts', 'python.exe'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return 'python3'
}

function canRunLocalPython(): Promise<boolean> {
  if (pingCheckPromise) return pingCheckPromise
  pingCheckPromise = new Promise<boolean>(resolve => {
    const py = spawn(
      resolvePythonExecutable(),
      ['-c', 'import sys, numpy; from engine.draw import check_pillow_version; assert sys.version_info >= (3, 11); check_pillow_version()'],
      { cwd: ROOT, stdio: 'ignore' },
    )
    const timer = setTimeout(() => {
      py.kill('SIGKILL')
      resolve(false)
    }, 5_000)
    py.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    py.on('close', code => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  }).finally(() => {
    pingCheckPromise = null
  })
  return pingCheckPromise
}

function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false
  const hostname = hostHeader.startsWith('[')
    ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
    : hostHeader.split(':')[0]
  return ALLOWED_HOSTS.has(hostname.toLowerCase())
}

function isSameOriginLoopbackRequest(req: import('node:http').IncomingMessage, requireOrigin: boolean): boolean {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false
  const host = req.headers.host
  if (!isLoopbackHostHeader(host)) return false

  const secFetchSite = req.headers['sec-fetch-site']
  if (typeof secFetchSite === 'string' && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    return false
  }

  const origin = req.headers.origin
  if (requireOrigin && typeof origin !== 'string') return false
  if (typeof origin === 'string') {
    try {
      const parsed = new URL(origin)
      if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase()) || parsed.host.toLowerCase() !== host?.toLowerCase()) {
        return false
      }
    } catch {
      return false
    }
  }
  return true
}

function decodePngDataUrl(dataUrl: string, maxBytes: number, maxEdge: number): Buffer {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
    throw new Error('Invalid PNG data URL')
  }
  const base64 = dataUrl.slice('data:image/png;base64,'.length)
  const buf = Buffer.from(base64, 'base64')
  if (buf.length < 24 || buf.length > maxBytes || !buf.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new Error('Invalid PNG header or size')
  }
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  if (width < 1 || height < 1 || width > maxEdge || height > maxEdge || width * height > maxEdge * maxEdge) {
    throw new Error('Image dimensions out of bounds')
  }
  return buf
}

function pencilPythonBridge(): Plugin {
  return {
    name: 'pencil-python-bridge',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ? new URL(req.url, 'http://localhost') : null
        if (!url || (url.pathname !== '/api/ping' && url.pathname !== '/api/render')) return next()

        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('Content-Type', 'application/json; charset=utf-8')

        if (req.method === 'GET' && url.pathname === '/api/ping') {
          if (!isSameOriginLoopbackRequest(req, false)) {
            res.statusCode = 403
            res.end(JSON.stringify({ ok: false, error: '仅允许本机同源页面访问。' }))
            return
          }
          const ok = await canRunLocalPython()
          res.end(JSON.stringify({ ok, mode: ok ? 'local-python' : 'browser' }))
          return
        }

        if (req.method === 'POST' && url.pathname === '/api/render') {
          if (!isSameOriginLoopbackRequest(req, true)) {
            res.statusCode = 403
            res.end(JSON.stringify({ ok: false, error: '仅允许本机同源页面调用绘制接口。' }))
            return
          }

          const contentType = String(req.headers['content-type'] || '').toLowerCase()
          if (!contentType.startsWith('application/json')) {
            res.statusCode = 415
            res.end(JSON.stringify({ ok: false, error: '请求内容类型不受支持。' }))
            return
          }

          if (activeRenderCount >= 1) {
            res.statusCode = 429
            res.end(JSON.stringify({ ok: false, error: '已有绘制任务正在进行，请稍候再试。' }))
            return
          }

          const chunks: Buffer[] = []
          let totalBytes = 0
          let aborted = false

          req.on('error', () => {
            aborted = true
          })

          req.on('data', (chunk: Buffer) => {
            if (aborted) return
            totalBytes += chunk.length
            if (totalBytes > MAX_BODY_BYTES) {
              aborted = true
              res.statusCode = 413
              res.end(JSON.stringify({ ok: false, error: '上传的图像数据超出大小限制。' }))
              req.destroy()
              return
            }
            chunks.push(Buffer.from(chunk))
          })

          req.on('end', () => {
            if (aborted) return

            let photoBuf: Buffer
            let maskBuf: Buffer
            let args: string[]

            try {
              const payload = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
              const duration = Number(payload.duration) === 6 ? 6 : 4
              const baseDirection = ['top-down', 'left-right', 'center-out', 'edges-in'].includes(payload.baseDirection)
                ? payload.baseDirection
                : 'top-down'
              const finaleDirection = ['top-down', 'left-right', 'center-out'].includes(payload.finaleDirection)
                ? payload.finaleDirection
                : 'top-down'
              const holdFinale = payload.holdFinale !== false
              const sketchFirst = payload.sketchFirst !== false

              photoBuf = decodePngDataUrl(String(payload.imageDataUrl), MAX_PHOTO_BYTES, 1080)
              maskBuf = payload.maskDataUrl
                ? decodePngDataUrl(String(payload.maskDataUrl), MAX_MASK_BYTES, 800)
                : Buffer.alloc(0)

              args = [
                ENGINE_SCRIPT,
                '--reference', '-',
                '--output', '-',
                '--duration', String(duration),
                '--direction', baseDirection,
                '--finale-direction', finaleDirection,
              ]
              if (!holdFinale) args.push('--no-hold-finale')
              if (!sketchFirst) args.push('--no-sketch-first')
            } catch {
              res.statusCode = 400
              res.end(JSON.stringify({ ok: false, error: '提交的图像格式无效，请重新选择照片。' }))
              return
            }

            activeRenderCount++
            let released = false
            let timedOut = false
            const py = spawn(resolvePythonExecutable(), args, {
              cwd: ROOT,
              stdio: ['pipe', 'pipe', 'ignore'],
            })

            const release = () => {
              if (!released) {
                released = true
                activeRenderCount = Math.max(0, activeRenderCount - 1)
              }
            }

            const timer = setTimeout(() => {
              timedOut = true
              if (!py.killed) py.kill('SIGKILL')
            }, RENDER_TIMEOUT_MS)

            res.on('close', () => {
              clearTimeout(timer)
              if (!res.writableEnded && !py.killed) {
                py.kill('SIGKILL')
              }
              release()
            })

            const header = Buffer.alloc(8)
            header.writeUInt32BE(photoBuf.length, 0)
            header.writeUInt32BE(maskBuf.length, 4)
            py.stdin.on('error', () => {
              // Ignore broken pipe if child exits early
            })
            py.stdin.write(header)
            py.stdin.write(photoBuf)
            if (maskBuf.length > 0) py.stdin.write(maskBuf)
            py.stdin.end()

            const outChunks: Buffer[] = []
            let outBytes = 0
            const MAX_STDOUT_BYTES = 28 * 1024 * 1024

            py.stdout.on('data', (chunk: Buffer) => {
              outBytes += chunk.length
              if (outBytes > MAX_STDOUT_BYTES) {
                if (!py.killed) py.kill('SIGKILL')
                return
              }
              outChunks.push(Buffer.from(chunk))
            })

            py.on('error', () => {
              clearTimeout(timer)
              release()
              if (!res.writableEnded) {
                res.statusCode = 500
                res.end(JSON.stringify({ ok: false, error: '本机 Python 引擎未能启动。' }))
              }
            })

            py.on('close', code => {
              clearTimeout(timer)
              release()
              if (res.writableEnded) return
              if (timedOut) {
                res.statusCode = 504
                res.end(JSON.stringify({ ok: false, error: '本机 Python 绘制超时，请换一张尺寸较小的照片再试。' }))
                return
              }
              if (code === 2) {
                res.statusCode = 400
                res.end(JSON.stringify({ ok: false, error: '无法解析这张照片，请换一张照片再试。' }))
                return
              }
              if (code !== 0) {
                res.statusCode = 500
                res.end(JSON.stringify({ ok: false, error: '本机 Python 绘制未完成，请稍后再试。' }))
                return
              }
              try {
                const rawOut = Buffer.concat(outChunks).toString('utf-8')
                const parsed = JSON.parse(rawOut)
                if (!parsed?.ok) throw new Error('Invalid render output')
                res.end(rawOut)
              } catch {
                res.statusCode = 500
                res.end(JSON.stringify({ ok: false, error: '本机 Python 返回的数据不完整，请重试。' }))
              }
            })
          })
          return
        }

        next()
      })
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [pencilPythonBridge()],
})

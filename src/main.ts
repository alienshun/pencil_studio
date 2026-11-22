import { renderInBrowser, type FinaleDirection, type SweepDirection } from './browser-engine'
import './styles.css'

type BrushStage = 'finale' | 'early' | 'erase'
type ToolShape = 'brush' | 'rect'
type Photo = { image: HTMLImageElement; baseName: string }
type Artwork = { finishedUrl: string; playback: HTMLCanvasElement[] | Blob; durationSec: 4 | 6 }

const app = document.querySelector<HTMLElement>('#app')!

let localPythonAvailable = false
let brushStage: BrushStage = 'finale'
let toolShape: ToolShape = 'rect'
let brushSize = 28
let durationSec: 4 | 6 = 4
let selectedPhoto: Photo | null = null
let photoObjectUrl = ''
let activeRender: AbortController | null = null
let artwork: Artwork | null = null
let replayTimer: number | undefined
let playbackObjectUrl = ''
let downloadWebpObjectUrl = ''

app.innerHTML = `
  <header class="site-header">
    <div class="wrap header-inner">
      <div class="brand">
        <h1>Pencil Studio · 彩铅画工坊</h1>
      </div>
      <div class="coord-badge" aria-label="Geographic coordinates 31°50'N, 117°16'E">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
          <circle cx="10" cy="10" r="7.2" />
          <path d="M10 2.8v14.4M2.8 10h14.4M10 6.2 11.4 10 10 13.8 8.6 10Z" />
        </svg>
        <span>31°50'N, 117°16'E</span>
      </div>
    </div>
  </header>

  <main class="wrap studio-grid">
    <section class="panel">
      <div class="panel-head">
        <h2>1. 选择照片与涂抹落笔顺序</h2>
        <span class="step-tag">交互式笔序画板</span>
      </div>

      <p class="mode-note" id="processing-mode" role="status">照片和作品只在当前浏览器标签页内处理。</p>
      <div class="upload-bar">
        <label class="file-btn">
          <span>📷 选择本地照片 / 拖拽图片到下方</span>
          <input id="file-input" type="file" accept="image/*" aria-describedby="processing-mode" hidden />
        </label>
        <button id="clear-mask-btn" class="ghost-btn" type="button" disabled>清空顺序标记</button>
      </div>

      <div class="order-toolbar">
        <div class="tool-row">
          <span class="tool-label">选择先后顺序层：</span>
          <button type="button" class="chip-btn" data-brush="finale" aria-pressed="true">
            <i class="dot-finale"></i>
            <span>③ 最后点睛区（文字 / 五官 / 焦点）</span>
          </button>
          <button type="button" class="chip-btn" data-brush="early" aria-pressed="false">
            <i class="dot-early"></i>
            <span>① 先画区（天空 / 远景铺底）</span>
          </button>
          <button type="button" class="chip-btn" data-brush="erase" aria-pressed="false">
            <i class="dot-body"></i>
            <span>橡皮擦（恢复为默认 ② 主体区）</span>
          </button>
        </div>
        <div class="tool-row">
          <span class="tool-label">标记工具：</span>
          <button type="button" class="chip-btn" data-shape="rect" aria-pressed="true">🔲 矩形框选（一拉框住区域）</button>
          <button type="button" class="chip-btn" data-shape="brush" aria-pressed="false">🖌️ 画笔涂抹</button>
          <label class="tool-label" style="margin-left:auto;display:inline-flex;align-items:center;gap:6px;">
            <span>画笔粗细</span>
            <input id="brush-size" type="range" min="8" max="80" value="28" style="width:90px;" />
          </label>
        </div>
      </div>

      <div class="editor-stage" id="drop-zone">
        <div class="empty-hint" id="empty-hint">
          点击左上角「选择本地照片」，或直接把照片拖进这里。<br />
          选好照片后，可在画面上框选或涂抹 <b>🔴 ③ 最后点睛区</b>（如对话框文字、眼睛、招牌）与 <b>🔵 ① 先画区</b>。<br />
          未涂抹的区域默认作为 <b>② 主体区</b> 在中间阶段完成。
        </div>
        <div class="canvas-stack" id="canvas-stack" hidden>
          <canvas id="photo-canvas"></canvas>
          <canvas id="mask-canvas"></canvas>
        </div>
      </div>

      <p class="legend-note">
        💡 <b>提示</b>：如果你希望“先把人物画完，最后才写出气泡里的字”，只需用 <b>🔴 ③ 最后点睛区 + 🔲 矩形框选</b> 把文字区域框起来即可！
      </p>

      <div class="settings-grid">
        <div class="field full">
          <label>绘画回放时长</label>
          <div class="duration-group">
            <button type="button" class="chip-btn" data-duration="4" aria-pressed="true" style="justify-content:center;">⏱️ 4 秒（50 帧）</button>
            <button type="button" class="chip-btn" data-duration="6" aria-pressed="false" style="justify-content:center;">⏱️ 6 秒（75 帧）</button>
          </div>
        </div>

        <div class="field">
          <label for="base-direction">① & ② 整体落笔推进方向</label>
          <select id="base-direction">
            <option value="top-down">从上到下（天空 → 地面）</option>
            <option value="left-right">从左到右（横向展开）</option>
            <option value="center-out">从中心向四周（视觉焦点向外）</option>
            <option value="edges-in">从四周向中心（外框向内收拢）</option>
          </select>
        </div>

        <div class="field">
          <label for="finale-direction">🔴 ③ 最后点睛区落笔方向</label>
          <select id="finale-direction">
            <option value="top-down">自上而下（适合竖排文字 / 全身细节）</option>
            <option value="left-right">自左向右（适合横排招牌 / 标题字）</option>
            <option value="center-out">从中心向外（适合眼睛 / 花朵高光）</option>
          </select>
        </div>

        <div class="field full">
          <label class="checkbox-row">
            <input id="sketch-first" type="checkbox" checked />
            <span><b>✏️ 先画出全图线稿骨架，再逐步填色</b>（前 24% 时间先在白纸上勾出包含五官的完整铅笔素描骨架，再按 ① → ② → ③ 顺序层层上色）</span>
          </label>
        </div>
      </div>

      <button id="render-btn" class="primary-btn" type="button" disabled>
        ✨ 开始生成彩铅画与绘画过程
      </button>
    </section>

    <div class="right-column">
      <section class="panel">
        <div class="panel-head">
          <h2>2. 彩铅成图与绘画过程回放</h2>
          <span class="step-tag" id="preview-meta-tag">等待生成</span>
        </div>

        <div class="preview-stage" id="preview-stage">
          <div class="empty-hint" id="preview-empty">
            左侧选好照片并点击「开始生成」后，<br />
            这里会自动播放 4 秒或 6 秒的逐笔彩铅绘画过程，播完展示高清静态成图。
          </div>
          <div class="preview-frame" id="preview-frame" hidden></div>
        </div>

        <div class="preview-toolbar">
          <div class="action-group">
            <button id="replay-btn" class="ghost-btn" type="button" disabled>🔄 重播绘画过程</button>
            <button id="compare-btn" class="ghost-btn" type="button" disabled>👁️ 按住对比原图</button>
          </div>
          <div class="action-group">
            <a id="download-png" class="file-btn" download="finished.png" hidden>⬇️ 下载彩铅成图 (.png)</a>
            <a id="download-webp" class="file-btn" download="process.webp" hidden>⬇️ 下载回放动画 (.webp)</a>
          </div>
        </div>

        <div class="status-box" id="status-box">
          就绪。选择一张本地图片即可开始制作。
        </div>
      </section>

      <aside class="starlight-corner" aria-label="作者签名与安全提示">
        <p class="security-tip">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M10 2.5 16 5v4.6c0 4.1-2.6 7.3-6 8.4-3.4-1.1-6-4.3-6-8.4V5l6-2.5Z" />
            <path d="m7.6 10.1 1.7 1.7 3.4-3.5" />
          </svg>
          <span>为了您的数据安全更建议您到 <a href="https://github.com/alienshun/pencil_studio" target="_blank" rel="noopener noreferrer">GitHub仓库</a> 下载源码本地部署该网页</span>
        </p>

        <div class="starry-signature-card">
          <svg class="starry-sky-svg" viewBox="0 0 520 126" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="alienshun 星空签名">
            <defs>
              <linearGradient id="sig-gold" x1="120" y1="20" x2="420" y2="100" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stop-color="#F6E6BC" />
                <stop offset="48%" stop-color="#D9B773" />
                <stop offset="100%" stop-color="#9CC2F5" />
              </linearGradient>
              <linearGradient id="constellation-line" x1="0" y1="0" x2="520" y2="126" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stop-color="#F6E6BC" stop-opacity="0.08" />
                <stop offset="50%" stop-color="#D9B773" stop-opacity="0.32" />
                <stop offset="100%" stop-color="#9CC2F5" stop-opacity="0.12" />
              </linearGradient>
              <filter id="star-glow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="1.6" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            <!-- Constellation lines -->
            <path d="M34 32 L78 22 L126 42 L176 26 L238 38 M332 28 L386 19 L438 39 L486 24" stroke="url(#constellation-line)" stroke-width="0.85" stroke-dasharray="2.5 2.5" />
            <path d="M52 94 L112 82 L164 98 M366 96 L422 80 L476 92" stroke="url(#constellation-line)" stroke-width="0.75" />

            <!-- Star field -->
            <g fill="#FFF8E7">
              <circle cx="34" cy="32" r="1.4" opacity="0.85" />
              <circle cx="78" cy="22" r="1.9" opacity="0.95" filter="url(#star-glow)" />
              <circle cx="126" cy="42" r="1.2" opacity="0.7" />
              <circle cx="176" cy="26" r="1.6" opacity="0.9" />
              <circle cx="238" cy="38" r="1.1" opacity="0.65" />
              <circle cx="288" cy="18" r="1.5" opacity="0.8" />
              <circle cx="332" cy="28" r="1.3" opacity="0.75" />
              <circle cx="386" cy="19" r="2.0" opacity="0.95" filter="url(#star-glow)" />
              <circle cx="438" cy="39" r="1.3" opacity="0.8" />
              <circle cx="486" cy="24" r="1.6" opacity="0.9" />
              <circle cx="52" cy="94" r="1.2" opacity="0.7" />
              <circle cx="112" cy="82" r="1.5" opacity="0.85" />
              <circle cx="164" cy="98" r="1.1" opacity="0.6" />
              <circle cx="366" cy="96" r="1.2" opacity="0.65" />
              <circle cx="422" cy="80" r="1.7" opacity="0.9" filter="url(#star-glow)" />
              <circle cx="476" cy="92" r="1.2" opacity="0.75" />
              <circle cx="24" cy="66" r="0.9" opacity="0.5" />
              <circle cx="496" cy="62" r="1.0" opacity="0.55" />
            </g>

            <!-- Four-point Polaris sparkle stars -->
            <path d="M78 14 L79.4 20.6 L86 22 L79.4 23.4 L78 30 L76.6 23.4 L70 22 L76.6 20.6 Z" fill="#F6E6BC" opacity="0.88" />
            <path d="M386 11 L387.3 17.7 L394 19 L387.3 20.3 L386 27 L384.7 20.3 L378 19 L384.7 17.7 Z" fill="#BFD7FF" opacity="0.88" />
            <path d="M262 24 L262.9 28.1 L267 29 L262.9 29.9 L262 34 L261.1 29.9 L257 29 L261.1 28.1 Z" fill="#F6E6BC" opacity="0.75" />

            <!-- Handwritten starry calligraphy signature: alienshun -->
            <text
              x="260"
              y="74"
              text-anchor="middle"
              fill="url(#sig-gold)"
              filter="url(#star-glow)"
              font-family="'Snell Roundhand', 'Apple Chancery', 'Brush Script MT', 'Baskerville', Georgia, serif"
              font-style="italic"
              font-size="42"
              letter-spacing="1.5"
            >alienshun</text>

            <!-- Subtle orbit underline beneath signature -->
            <path d="M148 88 Q260 101 372 84" stroke="url(#sig-gold)" stroke-width="1.15" stroke-linecap="round" opacity="0.78" />
            <circle cx="372" cy="84" r="2.1" fill="#F6E6BC" filter="url(#star-glow)" />
          </svg>
        </div>
      </aside>
    </div>
  </main>

  <footer class="site-footer">
    <span>Copyright © 2026 alienshun</span>
  </footer>
`

const fileInput = document.querySelector<HTMLInputElement>('#file-input')!
const clearMaskBtn = document.querySelector<HTMLButtonElement>('#clear-mask-btn')!
const brushSizeInput = document.querySelector<HTMLInputElement>('#brush-size')!
const dropZone = document.querySelector<HTMLElement>('#drop-zone')!
const emptyHint = document.querySelector<HTMLElement>('#empty-hint')!
const canvasStack = document.querySelector<HTMLElement>('#canvas-stack')!
const photoCanvas = document.querySelector<HTMLCanvasElement>('#photo-canvas')!
const maskCanvas = document.querySelector<HTMLCanvasElement>('#mask-canvas')!
const baseDirSelect = document.querySelector<HTMLSelectElement>('#base-direction')!
const finaleDirSelect = document.querySelector<HTMLSelectElement>('#finale-direction')!
const sketchFirstInput = document.querySelector<HTMLInputElement>('#sketch-first')!
const renderBtn = document.querySelector<HTMLButtonElement>('#render-btn')!

const previewMetaTag = document.querySelector<HTMLElement>('#preview-meta-tag')!
const previewEmpty = document.querySelector<HTMLElement>('#preview-empty')!
const previewFrame = document.querySelector<HTMLElement>('#preview-frame')!
const replayBtn = document.querySelector<HTMLButtonElement>('#replay-btn')!
const compareBtn = document.querySelector<HTMLButtonElement>('#compare-btn')!
const downloadPng = document.querySelector<HTMLAnchorElement>('#download-png')!
const downloadWebp = document.querySelector<HTMLAnchorElement>('#download-webp')!
const statusBox = document.querySelector<HTMLElement>('#status-box')!

const loopbackDevelopment = import.meta.env.DEV && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
let checkingMode = loopbackDevelopment

function updateRenderButton() {
  renderBtn.disabled = !selectedPhoto || checkingMode || activeRender !== null
}

if (loopbackDevelopment) {
  const modeLabel = document.querySelector<HTMLElement>('#processing-mode')!
  modeLabel.textContent = '正在检查本机 Python 服务。选图时照片留在当前标签页。'
  void (async () => {
    try {
      const response = await fetch('./api/ping', {
        mode: 'same-origin', redirect: 'error', cache: 'no-store', credentials: 'omit',
        signal: AbortSignal.timeout(12_000),
      })
      localPythonAvailable = response.ok && (await response.json()).mode === 'local-python'
    } catch {
      localPythonAvailable = false
    } finally {
      modeLabel.textContent = localPythonAvailable
        ? `点击生成时，照片像素和笔序蒙版将发给本机 Python 服务（${location.host}）。原文件及其拍摄信息留在本页。`
        : '照片和作品只在当前浏览器标签页内处理。'
      checkingMode = false
      updateRenderButton()
    }
  })()
}

const committedMask = document.createElement('canvas')

function syncOverlayDisplay() {
  const ctx = maskCanvas.getContext('2d')!
  ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height)
  ctx.drawImage(committedMask, 0, 0)
}

function clearMask() {
  const ctx = committedMask.getContext('2d')!
  ctx.clearRect(0, 0, committedMask.width, committedMask.height)
  syncOverlayDisplay()
}

function maskHasContent(): boolean {
  if (!committedMask.width || !committedMask.height) return false
  const data = committedMask.getContext('2d')!.getImageData(0, 0, committedMask.width, committedMask.height).data
  for (let i = 3; i < data.length; i += 16) {
    if (data[i] > 20) return true
  }
  return false
}

function scaledSize(image: HTMLImageElement, maxDimension: number) {
  const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight))
  return {
    width: Math.max(1, Math.round(image.naturalWidth * scale)),
    height: Math.max(1, Math.round(image.naturalHeight * scale)),
  }
}

async function loadPhotoFile(file: File) {
  activeRender?.abort()
  activeRender = null
  selectedPhoto = null
  clearResult()
  clearMaskBtn.disabled = true
  updateRenderButton()
  canvasStack.hidden = true
  emptyHint.hidden = false
  activePointer = null
  startPt = null
  lastPt = null
  for (const canvas of [photoCanvas, maskCanvas, committedMask]) canvas.width = 0
  statusBox.textContent = '正在读取照片…'

  if (photoObjectUrl) URL.revokeObjectURL(photoObjectUrl)
  const url = URL.createObjectURL(file)
  photoObjectUrl = url
  const image = new Image()
  image.src = url
  try {
    await image.decode()
    if (photoObjectUrl !== url) return
    const { width, height } = scaledSize(image, 800)
    for (const canvas of [photoCanvas, maskCanvas, committedMask]) {
      canvas.width = width
      canvas.height = height
    }
    photoCanvas.getContext('2d')!.drawImage(image, 0, 0, width, height)
    const baseName = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]+/g, '-') || 'drawing'
    selectedPhoto = { image, baseName }
    emptyHint.hidden = true
    canvasStack.hidden = false
    clearMaskBtn.disabled = false
    updateRenderButton()
    statusBox.textContent = `已载入图片「${file.name}」（${image.naturalWidth} × ${image.naturalHeight}）。可在图上框选或涂抹，也可直接生成。`
  } catch {
    if (photoObjectUrl !== url) return
    URL.revokeObjectURL(url)
    photoObjectUrl = ''
    statusBox.textContent = '无法读取这张照片，请选择浏览器支持的图片文件。'
  }
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0]
  fileInput.value = ''
  if (file) void loadPhotoFile(file)
})

dropZone.addEventListener('dragover', event => {
  event.preventDefault()
})
dropZone.addEventListener('drop', event => {
  event.preventDefault()
  const file = event.dataTransfer?.files?.[0]
  if (file && file.type.startsWith('image/')) void loadPhotoFile(file)
})

clearMaskBtn.addEventListener('click', () => {
  clearMask()
  statusBox.textContent = '已清空顺序标记，整张画默认按「② 主体区」与你选择的方向绘制。'
})

document.querySelectorAll<HTMLButtonElement>('[data-brush]').forEach(btn => {
  btn.addEventListener('click', () => {
    brushStage = btn.dataset.brush as BrushStage
    document.querySelectorAll<HTMLButtonElement>('[data-brush]').forEach(b => {
      b.setAttribute('aria-pressed', String(b === btn))
    })
  })
})

document.querySelectorAll<HTMLButtonElement>('[data-shape]').forEach(btn => {
  btn.addEventListener('click', () => {
    toolShape = btn.dataset.shape as ToolShape
    document.querySelectorAll<HTMLButtonElement>('[data-shape]').forEach(b => {
      b.setAttribute('aria-pressed', String(b === btn))
    })
  })
})

document.querySelectorAll<HTMLButtonElement>('[data-duration]').forEach(btn => {
  btn.addEventListener('click', () => {
    durationSec = Number(btn.dataset.duration) === 6 ? 6 : 4
    document.querySelectorAll<HTMLButtonElement>('[data-duration]').forEach(b => {
      b.setAttribute('aria-pressed', String(b === btn))
    })
  })
})

brushSizeInput.addEventListener('input', () => {
  brushSize = brushSizeInput.valueAsNumber
})

for (const control of [baseDirSelect, finaleDirSelect, sketchFirstInput]) {
  control.addEventListener('change', () => {
    if (selectedPhoto && !activeRender) {
      statusBox.textContent = '绘画顺序设置已更新，请点击「✨ 开始生成彩铅画与绘画过程」查看新效果。'
    }
  })
}

let activePointer: number | null = null
let startPt: { x: number; y: number } | null = null
let lastPt: { x: number; y: number } | null = null

function canvasCoords(event: PointerEvent): { x: number; y: number } {
  const rect = maskCanvas.getBoundingClientRect()
  return {
    x: ((event.clientX - rect.left) / rect.width) * maskCanvas.width,
    y: ((event.clientY - rect.top) / rect.height) * maskCanvas.height,
  }
}

function stageFillStyle(stage: BrushStage): string {
  return stage === 'finale' ? 'rgba(220, 58, 58, 0.48)' : 'rgba(38, 120, 195, 0.48)'
}

function applyBrushStroke(ctx: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }) {
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = brushSize
  if (brushStage === 'erase') {
    ctx.globalCompositeOperation = 'destination-out'
    ctx.strokeStyle = 'rgba(0,0,0,1)'
  } else {
    ctx.globalCompositeOperation = 'source-over'
    ctx.strokeStyle = stageFillStyle(brushStage)
  }
  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.lineTo(to.x, to.y)
  ctx.stroke()
  ctx.restore()
}

function applyRect(ctx: CanvasRenderingContext2D, a: { x: number; y: number }, b: { x: number; y: number }) {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const w = Math.abs(b.x - a.x)
  const h = Math.abs(b.y - a.y)
  ctx.save()
  if (brushStage === 'erase') {
    ctx.globalCompositeOperation = 'destination-out'
    ctx.fillStyle = 'rgba(0,0,0,1)'
  } else {
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = stageFillStyle(brushStage)
  }
  ctx.fillRect(x, y, w, h)
  ctx.restore()
}

maskCanvas.addEventListener('pointerdown', event => {
  if (!selectedPhoto || activePointer !== null || event.button !== 0) return
  event.preventDefault()
  activePointer = event.pointerId
  maskCanvas.setPointerCapture(activePointer)
  const pt = canvasCoords(event)
  startPt = pt
  lastPt = pt
  if (toolShape === 'brush') {
    const cCtx = committedMask.getContext('2d')!
    applyBrushStroke(cCtx, pt, pt)
    syncOverlayDisplay()
  }
})

maskCanvas.addEventListener('pointermove', event => {
  if (event.pointerId !== activePointer || !startPt || !lastPt) return
  const pt = canvasCoords(event)
  if (toolShape === 'brush') {
    const cCtx = committedMask.getContext('2d')!
    applyBrushStroke(cCtx, lastPt, pt)
    lastPt = pt
    syncOverlayDisplay()
  } else {
    syncOverlayDisplay()
    const previewCtx = maskCanvas.getContext('2d')!
    applyRect(previewCtx, startPt, pt)
    previewCtx.save()
    previewCtx.strokeStyle = brushStage === 'finale' ? '#d14949' : brushStage === 'early' ? '#2c7bb6' : '#555'
    previewCtx.lineWidth = 1.5
    previewCtx.setLineDash([5, 4])
    previewCtx.strokeRect(
      Math.min(startPt.x, pt.x),
      Math.min(startPt.y, pt.y),
      Math.abs(pt.x - startPt.x),
      Math.abs(pt.y - startPt.y),
    )
    previewCtx.restore()
    lastPt = pt
  }
})

function finishPointer(event: PointerEvent) {
  if (event.pointerId !== activePointer) return
  if (toolShape === 'rect' && startPt && lastPt) {
    const cCtx = committedMask.getContext('2d')!
    applyRect(cCtx, startPt, lastPt)
    syncOverlayDisplay()
  }
  activePointer = null
  startPt = null
  lastPt = null
}

maskCanvas.addEventListener('pointerup', finishPointer)
maskCanvas.addEventListener('pointercancel', finishPointer)

function exportCleanMaskDataUrl(): string | null {
  if (!maskHasContent()) return null
  const out = document.createElement('canvas')
  out.width = committedMask.width
  out.height = committedMask.height
  const oCtx = out.getContext('2d')!
  const src = committedMask.getContext('2d')!.getImageData(0, 0, out.width, out.height)
  const dst = oCtx.createImageData(out.width, out.height)
  for (let i = 0; i < src.data.length; i += 4) {
    const r = src.data[i]
    const b = src.data[i + 2]
    const a = src.data[i + 3]
    if (a > 20) {
      if (r >= b) {
        dst.data[i] = 255
        dst.data[i + 3] = 255
      } else {
        dst.data[i + 2] = 255
        dst.data[i + 3] = 255
      }
    }
  }
  oCtx.putImageData(dst, 0, 0)
  return out.toDataURL('image/png')
}

function stopPlayback() {
  window.clearTimeout(replayTimer)
  window.clearInterval(replayTimer)
  replayTimer = undefined
  if (playbackObjectUrl) URL.revokeObjectURL(playbackObjectUrl)
  playbackObjectUrl = ''
}

function clearResult() {
  stopPlayback()
  if (downloadWebpObjectUrl) {
    URL.revokeObjectURL(downloadWebpObjectUrl)
    downloadWebpObjectUrl = ''
  }
  artwork = null
  previewFrame.replaceChildren()
  previewFrame.hidden = true
  previewEmpty.hidden = false
  previewMetaTag.textContent = '等待生成'
  replayBtn.disabled = true
  compareBtn.disabled = true
  for (const link of [downloadPng, downloadWebp]) {
    link.hidden = true
    link.removeAttribute('href')
    link.removeAttribute('download')
  }
}

function playPreview() {
  stopPlayback()
  if (!artwork) return
  const { finishedUrl, playback, durationSec } = artwork
  previewEmpty.hidden = true
  previewFrame.hidden = false

  if (playback instanceof Blob) {
    const still = new Image()
    still.src = finishedUrl
    still.alt = '彩铅静态成图'

    const anim = new Image()
    anim.alt = '彩铅绘画过程'
    playbackObjectUrl = URL.createObjectURL(playback)
    anim.src = playbackObjectUrl
    previewFrame.replaceChildren(anim)
    replayTimer = window.setTimeout(() => {
      stopPlayback()
      previewFrame.replaceChildren(still)
    }, durationSec * 1000)
    return
  }

  const display = document.createElement('canvas')
  display.width = playback[0].width
  display.height = playback[0].height
  const ctx = display.getContext('2d')!
  previewFrame.replaceChildren(display)
  let index = 0
  ctx.drawImage(playback[index], 0, 0)
  replayTimer = window.setInterval(() => {
    if (++index >= playback.length) {
      stopPlayback()
      return
    }
    ctx.drawImage(playback[index], 0, 0)
  }, 80)
}

replayBtn.addEventListener('click', () => {
  playPreview()
})

function showOriginalOverlay(show: boolean) {
  if (!selectedPhoto || !artwork || previewFrame.hidden) return
  const existing = previewFrame.querySelector<HTMLImageElement>('.compare-overlay')
  if (show) {
    if (!existing) {
      const orig = new Image()
      orig.src = selectedPhoto.image.src
      orig.className = 'compare-overlay'
      orig.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;'
      previewFrame.append(orig)
    }
  } else {
    existing?.remove()
  }
}

compareBtn.addEventListener('pointerdown', () => showOriginalOverlay(true))
window.addEventListener('pointerup', () => showOriginalOverlay(false))
window.addEventListener('pointercancel', () => showOriginalOverlay(false))

renderBtn.addEventListener('click', async () => {
  if (!selectedPhoto || activeRender || checkingMode) return
  const { image, baseName } = selectedPhoto
  const duration = durationSec
  const options = {
    baseDirection: baseDirSelect.value as SweepDirection,
    finaleDirection: finaleDirSelect.value as FinaleDirection,
    holdFinale: true,
    sketchFirst: sketchFirstInput.checked,
  }
  const job = new AbortController()
  activeRender = job
  clearResult()
  updateRenderButton()
  try {
    let result: Artwork
    let marks: number
    let frameCount: number
    let processUrl: string | undefined
    if (import.meta.env.DEV && localPythonAvailable) {
      statusBox.textContent = `本机 Python 正在绘制 ${duration} 秒彩铅画与绘画过程…`
      previewMetaTag.textContent = '绘制中…'
      const pixels = document.createElement('canvas')
      const { width, height } = scaledSize(image, 1080)
      pixels.width = width
      pixels.height = height
      pixels.getContext('2d')!.drawImage(image, 0, 0, width, height)
      const response = await fetch('./api/render', {
        method: 'POST',
        mode: 'same-origin',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal: job.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageDataUrl: pixels.toDataURL('image/png'),
          maskDataUrl: exportCleanMaskDataUrl(),
          duration,
          ...options,
        }),
      })
      const data = await response.json()
      if (!response.ok || !data.ok) throw new Error(data.error || '本机 Python 绘制失败。')
      if (!data.finishedUrl?.startsWith('data:image/png;base64,') ||
          !data.processUrl?.startsWith('data:image/webp;base64,')) {
        throw new Error('本机 Python 返回的图像格式无效。')
      }
      const playback = await (await fetch(data.processUrl, { signal: job.signal })).blob()
      result = {
        finishedUrl: data.finishedUrl, playback, durationSec: duration,
      }
      processUrl = data.processUrl
      marks = data.meta.marks
      frameCount = data.meta.frames
    } else {
      const mask = document.createElement('canvas')
      mask.width = committedMask.width
      mask.height = committedMask.height
      mask.getContext('2d')!.drawImage(committedMask, 0, 0)
      const drawing = await renderInBrowser({
        image,
        maskCanvas: mask,
        durationSec: duration,
        ...options,
        onProgress(percent, label) {
          job.signal.throwIfAborted()
          previewMetaTag.textContent = `${percent}%`
          statusBox.textContent = label
        },
      })
      result = {
        finishedUrl: drawing.finishedDataUrl,
        playback: drawing.processBlob ?? drawing.frames,
        durationSec: duration,
      }
      if (drawing.processBlob && !job.signal.aborted) {
        downloadWebpObjectUrl = URL.createObjectURL(drawing.processBlob)
        processUrl = downloadWebpObjectUrl
      }
      marks = drawing.marks
      frameCount = drawing.frames.length
    }

    if (job.signal.aborted) return
    artwork = result
    const formattedMarks = marks.toLocaleString()
    previewMetaTag.textContent = `${formattedMarks} 笔 · ${duration} 秒（${frameCount} 帧）`
    statusBox.textContent = `✅ 绘制完成！共 ${formattedMarks} 笔彩铅，时长 ${duration} 秒。可点击上方按钮重播或下载。`
    downloadPng.href = result.finishedUrl
    downloadPng.download = `${baseName}-finished.png`
    downloadPng.hidden = false
    if (processUrl) {
      downloadWebp.href = processUrl
      downloadWebp.download = `${baseName}-process-${duration}s.webp`
      downloadWebp.hidden = false
    }
    replayBtn.disabled = false
    compareBtn.disabled = false
    playPreview()
  } catch (err) {
    if (!job.signal.aborted) {
      statusBox.textContent = `❌ 生成出错：${err instanceof Error ? err.message : '请重新选择照片后再试。'}`
      previewMetaTag.textContent = '生成出错'
    }
  } finally {
    if (activeRender === job) {
      activeRender = null
      updateRenderButton()
    }
  }
})

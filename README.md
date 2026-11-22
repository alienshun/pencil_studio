# Pencil Studio · 交互式程序彩铅画工坊

选择一张照片，在画板上框选或涂抹「① 先画区 → ② 主体区 → ③ 最后点睛区」，即可生成彩铅画和 4 秒（50 帧）或 6 秒（75 帧）的绘画回放。

## 在线使用 · GitHub Pages

打开网站就能绘制。照片、笔序蒙版和作品都在当前浏览器标签页内处理。两个人即使同时打开同一个网址，也各自在自己的设备上绘制。GitHub Pages 负责提供 HTML、JavaScript 和样式文件。选择照片、绘制和回放均不会触发 GitHub Actions。

在线版在浏览器内直接生成并可下载 PNG 静态成图与多帧 WebP 回放动画（`process.webp`）。想保留作品，请在换图或关闭网页前下载；想使用 1080px 更高精度与纸齿压印，可使用下面的本地 Python 模式。

### 构建和发布

在装有 Node.js 和 npm 的环境中运行：

```sh
npm ci
npm run build
```

将生成的 `dist/` 内容作为 Pages 发布产物。项目使用相对资源路径，可部署在仓库名对应的子路径下。`npm run preview` 可以在本机预览同一份静态网页。使用 GitHub Actions 发布时，构建命令和产物目录相同。[Vite 的 GitHub Pages 部署指南](https://vite.dev/guide/static-deploy.html#github-pages)

## 本地使用 · Python 引擎

安装 Node.js 和 Python 3.11 或更高版本后，macOS 用户可双击 [open-studio.command](open-studio.command)。首次运行会安装项目依赖并打开本机网页。也可以在 macOS 或 Linux 终端运行：

```sh
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm run dev -- --host 127.0.0.1
```

打开终端显示的本机网址。页面会标明处理方式。本机 Python 可用时，点击「开始生成」会将重新编码的图像像素（长边最多 1080 像素）和可选的笔序蒙版送给本机 Python 进程。原文件、文件名和原始 EXIF 元数据留在标签页内。照片和作品在内存中处理，可从页面下载 PNG 成图和 WebP 动画。网页不会创建作品归档目录。

本机 Python 依赖未就绪时，页面仍可使用浏览器绘制。通过局域网地址打开开发网页时，也使用浏览器绘制。

## 源码

- [交互画板](src/main.ts) 管理选图、笔序、预览和下载。
- [浏览器引擎](src/browser-engine.ts) 为在线版绘制彩铅画和回放帧。
- [本地服务](vite.config.ts) 把本机网页的绘制请求交给 [Python 引擎](engine/draw.py)。

Python 命令行也可将成图、动画和绘制参数写入指定目录，例如：

```sh
.venv/bin/python engine/draw.py --reference photo.jpg --output works/example
```

`works/` 及约定的生成文件名已列入 [.gitignore](.gitignore)。

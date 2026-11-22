# Pencil Studio

Choose a photo, then box-select or paint on the canvas the “① First-drawn area → ② Main subject area → ③ Final accent area” to generate a colored pencil drawing and a 4-second (50-frame) or 6-second (75-frame) drawing playback.

## Online Use · GitHub Pages

Open the website and you can draw. Photos, stroke-order masks, and artworks are all processed within the current browser tab. Even if two people open the same URL at the same time, each draws on their own device. GitHub Pages serves the HTML, JavaScript, and stylesheet files. Selecting photos, drawing, and playback do not trigger GitHub Actions.

The online version generates directly in the browser and can download a static PNG image and a multi-frame WebP playback animation (`process.webp`). To keep your artwork, download it before changing the photo or closing the webpage; to use higher 1080px precision and paper-tooth embossing, use the local Python mode below.

### Build and Publish

Run in an environment with Node.js and npm installed:

```sh
npm ci
npm run build
```

Use the generated `dist/` contents as the Pages deployment artifact. The project uses relative asset paths, so it can be deployed under a subpath corresponding to the repository name. `npm run preview` lets you preview the same static webpage locally. When publishing with GitHub Actions, the build command and artifact directory are the same. [Vite's GitHub Pages deployment guide](https://vite.dev/guide/static-deploy.html#github-pages)

## Local Use · Python Engine

After installing Node.js and Python 3.11 or later, macOS users can double-click [open-studio.command](open-studio.command). The first run installs project dependencies and opens the local webpage. You can also run the following in a macOS or Linux terminal:

```sh
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm run dev -- --host 127.0.0.1
```

Open the local URL shown in the terminal. The page will indicate the processing method. When local Python is available, clicking “Start Generation” sends the re-encoded image pixels (long edge up to 1080 pixels) and the optional stroke-order mask to the local Python process. The original file, filename, and original EXIF metadata stay within the tab. Photos and artworks are processed in memory, and the PNG image and WebP animation can be downloaded from the page. The webpage does not create an artwork archive directory.

When local Python dependencies are not ready, the page can still use browser drawing. When the development webpage is opened via a LAN address, browser drawing is also used.

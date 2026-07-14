// Dev-only asset generator. Not shipped to the profile.
// Drives plug/?record=1 through window.__renderAt() and assembles the
// resulting frames into assets/plug-loop.webp (+ .gif fallback).
//
// Usage: node tools/capture.mjs

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FRAMES_DIR = path.join(ROOT, '.capture-frames');
const ASSETS_DIR = path.join(ROOT, 'assets');

const WIDTH = 640;
const HEIGHT = 480;
const FPS = 20;
const LOOP_DURATION_MS = 3200; // must match main.js LOOP_DURATION
const FRAME_COUNT = Math.round((LOOP_DURATION_MS / 1000) * FPS);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const filePath = path.join(ROOT, urlPath === '/' ? '/index.html' : urlPath);
      try {
        const data = await readFile(filePath);
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  await rm(FRAMES_DIR, { recursive: true, force: true });
  await mkdir(FRAMES_DIR, { recursive: true });
  await mkdir(ASSETS_DIR, { recursive: true });

  const server = startServer ? await startServer() : null;
  const port = server.address().port;

  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });

  page.on('console', (msg) => console.log('[page]', msg.text()));
  page.on('pageerror', (err) => console.error('[pageerror]', err));

  await page.goto(`http://127.0.0.1:${port}/index.html?record=1&w=${WIDTH}&h=${HEIGHT}`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.__renderAt === 'function', { timeout: 10000 });

  console.log(`Capturing ${FRAME_COUNT} frames at ${WIDTH}x${HEIGHT}, ${FPS}fps...`);

  for (let i = 0; i < FRAME_COUNT; i++) {
    const tMs = (i / FRAME_COUNT) * LOOP_DURATION_MS;
    const dataUrl = await page.evaluate((t) => {
      window.__renderAt(t);
      return document.getElementById('scene').toDataURL('image/png');
    }, tMs);
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    const framePath = path.join(FRAMES_DIR, `frame_${String(i).padStart(4, '0')}.png`);
    await writeFile(framePath, Buffer.from(base64, 'base64'));
  }

  await browser.close();
  server.close();

  console.log('Encoding webp...');
  await run('ffmpeg', [
    '-y', '-framerate', String(FPS),
    '-i', path.join(FRAMES_DIR, 'frame_%04d.png'),
    '-c:v', 'libwebp_anim',
    '-loop', '0', '-lossless', '0', '-q:v', '75', '-compression_level', '6',
    path.join(ASSETS_DIR, 'plug-loop.webp'),
  ]);

  console.log('Encoding gif fallback...');
  const paletteePath = path.join(FRAMES_DIR, 'palette.png');
  const GIF_SCALE = 'scale=300:225';
  const GIF_FPS = 12;
  await run('ffmpeg', [
    '-y', '-framerate', String(FPS),
    '-i', path.join(FRAMES_DIR, 'frame_%04d.png'),
    '-vf', `fps=${GIF_FPS},${GIF_SCALE}:flags=lanczos,palettegen=stats_mode=diff`,
    paletteePath,
  ]);
  await run('ffmpeg', [
    '-y', '-framerate', String(FPS),
    '-i', path.join(FRAMES_DIR, 'frame_%04d.png'),
    '-i', paletteePath,
    '-lavfi', `fps=${GIF_FPS},${GIF_SCALE}:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer`,
    '-loop', '0',
    path.join(ASSETS_DIR, 'plug-loop.gif'),
  ]);

  await rm(FRAMES_DIR, { recursive: true, force: true });

  console.log('Done: assets/plug-loop.webp, assets/plug-loop.gif');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Headless capture via Playwright recordVideo (canvas only, UI hidden).
 *
 * Usage:
 *   npm run preview -- --host --port 4173
 *   node record-from-path.js
 *
 * Requires:
 *   npm i -D playwright
 *   npx playwright install chromium
 *   ffmpeg in PATH
 */

import { chromium } from 'playwright';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import url from 'url';

const URL = 'http://localhost:4173';
const WIDTH = 1280;
const HEIGHT = 720;
const DURATION_MS = 30000; // total capture time (approx run length)
const RAW = 'fly.webm';
const OUT = 'final.mp4';
const PRE_F_WAIT_MS = 8000; // wait after canvas ready before pressing F (scene load)
const TRIM_DURATION = 0; // seconds to keep after trim (0 => keep full)
const TRIM_HEAD_PAD = 1.0; // seconds kept before F press when trimming

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(cmd) {
  console.log('[ffmpeg]', cmd);
  execSync(`ffmpeg ${cmd}`, { stdio: 'inherit' });
}

async function waitForStatus(page, regex, timeout = 90000) {
  try {
    await page.waitForFunction(
      (re) => {
        const el = document.querySelector('#status');
        if (!el) return false;
        const text = el.textContent || '';
        return re.test(text);
      },
      regex,
      { timeout },
    );
    return true;
  } catch {
    return false;
  }
}

async function capture() {
  fs.rmSync('videos', { recursive: true, force: true });
  fs.rmSync(RAW, { force: true });

  const browser = await chromium.launch({ headless: true });
  const recordStart = Date.now();
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    recordVideo: { dir: 'videos', size: { width: WIDTH, height: HEIGHT } },
  });
  await context.addInitScript(() => {
    window.__AUTO_RECORD = false; // disable auto-flight, we'll press F manually
    const style = document.createElement('style');
    style.textContent = `
      header, .controls, #status { display:none !important; }
      body, html { margin:0!important; padding:0!important; overflow:hidden!important; background:#000!important; }
      #viewer { position:fixed!important; inset:0!important; width:100%!important; height:100%!important; }
      .loading-screen, #viewer .loading-screen, .loading, .loader, .loading-container { display:none !important; }
    `;
    document.addEventListener('DOMContentLoaded', () => {
      document.head.appendChild(style);
    });
  });
  const page = await context.newPage();
  page.on('console', (msg) => {
    console.log('[page]', msg.text());
  });
  await page.goto(URL, { waitUntil: 'networkidle' });
  const canvasReady = await page.waitForFunction(() => !!document.querySelector('canvas'), { timeout: 90000 });
  if (!canvasReady) throw new Error('Canvas not found');
  console.log('[capture] canvas ready');
  console.log('[capture] give scene time to load (12s)');
  await sleep(12000);

  // focus the viewer so "F" is received
  console.log('[capture] focusing viewer');
  await page.bringToFront();
  console.log('[capture] bringToFront done');
  console.log('[capture] wait for precomputed path (60s max)');
  await page.waitForFunction(() => window.__PRE_READY === true, { timeout: 60000 }).catch(() => {});
  const preCount = await page.evaluate(() => window.__PRE_PATH || 0);
  console.log('[capture] precomputed count:', preCount);
  // force snap to first waypoint via local file if flag not set
  let firstPoint = null;
  try {
    const basePath = path.join(path.dirname(url.fileURLToPath(import.meta.url)), 'public', 'ConferenceHall.path.json');
    const json = JSON.parse(fs.readFileSync(basePath, 'utf-8'));
    if (Array.isArray(json) && json.length > 0) {
      firstPoint = json[0];
    }
  } catch {
    // ignore
  }
  if (firstPoint) {
    await page.evaluate((fp) => {
      try {
        const cam = window.viewer?.camera;
        const controls = window.viewer?.controls;
        if (cam && fp.pos) {
          cam.position.set(fp.pos[0], fp.pos[1], fp.pos[2]);
          const dir = fp.dir || [0, 0, -1];
          const dirVec = new window.THREE.Vector3(dir[0], dir[1], dir[2]).normalize();
          controls?.target.copy(cam.position.clone().addScaledVector(dirVec, 2));
          controls?.update();
          window.viewer.updateView?.(true, true);
          window.viewer.render?.();
          window.__CAM_READY = true;
          window.__CAM_POS = cam.position.toArray();
          window.__CAM_DIR = dirVec.toArray();
        }
      } catch (e) {
        console.error('snap failed', e);
      }
    }, firstPoint);
  }
  const camReady = await page.waitForFunction(() => window.__CAM_READY === true, { timeout: 10000 }).catch(() => false);
  const statusBefore = await page.evaluate(() => document.querySelector('#status')?.textContent || '');
  const flyingBefore = await page.evaluate(() => window.__FLYING === true);
  console.log('[capture] status before flight:', statusBefore.trim(), 'flying:', flyingBefore, 'camReady:', !!camReady);
  // ensure flight started (retry F up to 5 times if not already flying)
  let started = flyingBefore || /playing precomputed path/i.test(statusBefore);
  for (let i = 0; i < 5 && !started; i += 1) {
    await page.keyboard.press('KeyF');
    await sleep(500);
    started = (await page.evaluate(() => window.__FLYING === true)) || started;
    console.log('[capture] ensureFlight attempt', i + 1, 'flying:', started);
  }
  const statusAfter = await page.evaluate(() => document.querySelector('#status')?.textContent || '');
  console.log('[capture] status after ensure:', statusAfter.trim());
  if (!started && /playing precomputed path/i.test(statusAfter)) {
    started = true;
  }
  const flightStart = Date.now();
  if (!started) {
    console.warn('[capture] flight flag not seen, continuing anyway');
  } else {
    console.log('[capture] flight started flag seen');
  }
  // wait for finish flag or fallback timeout
  const finished = await page.waitForFunction(() => window.__FLYING === false, { timeout: 30000 }).catch(() => false);
  console.log('[capture] flight finished flag seen:', !!finished);
  await sleep(5000); // allow extra frames after finish

  const videoPath = await page.video().path();
  await browser.close();

  const target = path.join(process.cwd(), RAW);
  fs.copyFileSync(videoPath, target);
  console.log('[capture] saved', RAW);
  return { recordStart, flightStart };
}

async function main() {
  console.log('[main] capture start');
  const { recordStart, flightStart } = await capture();
  if (!fs.existsSync(RAW)) throw new Error('fly.webm not saved');
  if (TRIM_DURATION > 0) {
    const trimStart = Math.max(0, (flightStart - recordStart) / 1000 - TRIM_HEAD_PAD);
    const maxDuration = Math.max(5, DURATION_MS / 1000 - trimStart);
    const trimKeep = Math.min(TRIM_DURATION, maxDuration);
    console.log(`[main] trimming from ${trimStart.toFixed(2)}s keep ${trimKeep.toFixed(2)}s`);
    if (trimKeep <= 0) {
      console.warn('[main] trimKeep <= 0, exporting full capture instead');
      run(`-y -i ${RAW} -r 60 -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p ${OUT}`);
    } else {
      run(
        `-y -ss ${trimStart.toFixed(2)} -i ${RAW} -t ${trimKeep.toFixed(2)} -r 60 -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p ${OUT}`,
      );
    }
  } else {
    console.log('[main] no trimming, full capture export');
    run(`-y -i ${RAW} -r 60 -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p ${OUT}`);
  }
  console.log('[main] Done:', OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

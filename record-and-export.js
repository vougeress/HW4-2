/**
 * Fast capture via Playwright built-in video recording + simple export.
 *
 * Usage:
 *   npm run preview -- --host --port 4173
 *   node record-and-export.js
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

const URL = 'http://localhost:4173';
const WIDTH = 1280;
const HEIGHT = 720;
const DURATION_MS = 20000; // shorten if needed

async function captureVideo() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    recordVideo: { dir: 'videos', size: { width: WIDTH, height: HEIGHT } },
  });
  const page = await context.newPage();
  await page.goto(URL);
  await page.waitForTimeout(3000);
  await page.keyboard.press('KeyF');
  await page.waitForTimeout(DURATION_MS);
  const videoPath = await page.video().path();
  await browser.close();
  const target = 'fly.webm';
  fs.copyFileSync(videoPath, target);
  return target;
}

function run(cmd) {
  console.log('ffmpeg', cmd);
  execSync(`ffmpeg ${cmd}`, { stdio: 'inherit' });
}

async function main() {
  console.log('Capturing...');
  const webm = await captureVideo();
  console.log('Captured:', webm);

  // Optional: skip stabilization if not needed
  run("-y -i fly.webm -c:v libvpx -b:v 6M fly_clean.webm");
  run("-y -i fly_clean.webm -vf minterpolate='mi_mode=mci:mc_mode=aobmc:vsbmc=1:fps=60' interp.mp4");
  run("-y -i interp.mp4 -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p -c:a aac -b:a 192k final.mp4");

  console.log('Done: fly.webm, fly_clean.webm, interp.mp4, final.mp4');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

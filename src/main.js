import './style.css';
import * as GaussianSplats3D from 'gaussian-splats-3d';
import { Quaternion, Vector3 } from 'three';
import * as THREE from 'three';

const viewerRoot = document.getElementById('viewer');
const sceneSelect = document.getElementById('scene-select');
const customPathInput = document.getElementById('custom-path');
const loadButton = document.getElementById('load-button');
const statusEl = document.getElementById('status');
const recStartBtn = document.getElementById('rec-start');
const recStopBtn = document.getElementById('rec-stop');
const defaultOrientationPreset = 'flip-z';
if (typeof window !== 'undefined') {
  window.__PRE_READY = false;
  window.__PRE_PATH = 0;
  window.__CAM_READY = false;
  window.__FLYING = false;
  window.__CAM_POS = null;
  window.__CAM_DIR = null;
}
const autoRecord = window.__AUTO_RECORD === true;
let autoFlightQueued = false;

const defaultCamera = {
  position: [-2, -8, 3],
  lookAt: [0, 0, 0],
  up: [0, 1, 0],
};

let viewer;
let keys = {};
let flythrough = { active: false, idx: 0, path: [], speed: 1.0, start: null, startDir: null };
let firstFramePending = false;
let sceneInfo = null;
let userStart = null;
let userEnd = null;
let flyStartState = { pos: null, dir: null };
let precomputedPath = null;
let firstWaypoint = null;
let recorder = { mediaRecorder: null, chunks: [], recording: false };

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.dataset.state = isError ? 'error' : 'ok';
}

function createViewer() {
  if (viewer) {
    viewer.stop();
  }
  viewerRoot.innerHTML = '';
  viewer = new GaussianSplats3D.Viewer({
    rootElement: viewerRoot,
    cameraUp: defaultCamera.up,
    initialCameraPosition: defaultCamera.position,
    initialCameraLookAt: defaultCamera.lookAt,
    ignoreDevicePixelRatio: false,
  });
  attachKeyboardControls();
  enableExternalUpdateLoop();
}

function attachKeyboardControls() {
  window.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (e.shiftKey && e.code === 'KeyR') {
      startRecording();
    }
    if (e.shiftKey && e.code === 'KeyS') {
      stopRecording();
    }
    if (e.code === 'KeyF') {
      triggerPlayPath();
    }
    if (e.code === 'Digit1') {
      userStart = viewer.camera.position.clone();
      setStatus(`Start set (${userStart.x.toFixed(2)}, ${userStart.y.toFixed(2)}, ${userStart.z.toFixed(2)}).`);
    }
    if (e.code === 'Digit2') {
      userEnd = viewer.camera.position.clone();
      setStatus(`End set (${userEnd.x.toFixed(2)}, ${userEnd.y.toFixed(2)}, ${userEnd.z.toFixed(2)}).`);
    }
    if (e.code === 'KeyP') {
      const cam = viewer?.camera;
      if (!cam) return;
      const dir = cam.getWorldDirection(new THREE.Vector3());
      console.log('Pose', { pos: cam.position.toArray(), dir: dir.toArray() });
      setStatus(`Pose logged to console`);
    }
  });
  window.addEventListener('keyup', (e) => {
    keys[e.code] = false;
  });
}

function lerpVec(a, b, t) {
  return a.clone().lerp(b, t);
}

function updateFlythrough(delta) {
  if (!flythrough.active || !viewer?.camera || flythrough.path.length === 0) return;
  const cam = viewer.camera;
  const targetPoint = flythrough.path[flythrough.idx];
  if (!targetPoint) return;
  const dir = targetPoint.pos.clone().sub(cam.position);
  const dist = dir.length();
  if (dist < 0.15) {
    flythrough.idx += 1;
    if (flythrough.idx >= flythrough.path.length) {
      flythrough.active = false;
      flythrough.idx = 0;
      if (flyStartState.pos) cam.position.copy(flyStartState.pos);
      const forward = flyStartState.dir ? flyStartState.dir.clone().normalize() : new THREE.Vector3(0, 0, -1);
      viewer.controls?.target.copy(cam.position).addScaledVector(forward, 1);
      viewer.controls?.update();
      viewer.updateView?.(true, true);
      viewer.render?.();
      if (typeof window !== 'undefined') {
        window.__FLYING = false;
      }
      setStatus('Flythrough finished');
      return;
    }
    return;
  }
  dir.normalize();
  const step = flythrough.speed * delta;
  cam.position.addScaledVector(dir, Math.min(step, dist));

  const currentDir = viewer.controls?.target.clone().sub(cam.position).normalize() || new THREE.Vector3(0, 0, 1);
  const desiredDir = targetPoint.dir ? targetPoint.dir.clone().normalize() : dir.clone();
  const smoothDir = currentDir.lerp(desiredDir, Math.min(delta * 3, 1));
  viewer.controls?.target.copy(cam.position).addScaledVector(smoothDir, 2);
  viewer.controls?.update();
}

function updateKeyboard(delta) {
  if (!viewer?.camera || !viewer?.controls) return;
  const cam = viewer.camera;
  const target = viewer.controls.target;
  const dir = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  dir.copy(target).sub(cam.position);
  if (dir.lengthSq() < 1e-4) {
    dir.copy(flyStartState.dir || new THREE.Vector3(0, 0, -1)).normalize();
  } else {
    dir.normalize();
  }
  right.copy(dir).cross(up).normalize();
  const move = new THREE.Vector3();
  const speed = (keys.ShiftLeft || keys.ShiftRight ? 6 : 2) * delta;
  if (keys.KeyW) move.addScaledVector(dir, speed);
  if (keys.KeyS) move.addScaledVector(dir, -speed);
  if (keys.KeyA) move.addScaledVector(right, -speed);
  if (keys.KeyD) move.addScaledVector(right, speed);
  if (keys.KeyE) move.addScaledVector(up, speed);
  if (keys.KeyQ) move.addScaledVector(up, -speed);
  cam.position.add(move);
  target.add(move);
  if (move.lengthSq() > 0) {
    viewer.updateView?.(true, true);
    viewer.render?.();
  }
}

function getCanvas() {
  return viewer?.renderer?.domElement || viewerRoot.querySelector('canvas');
}

function startRecording() {
  if (recorder.recording) {
    setStatus('Recording already in progress');
    return;
  }
  const canvas = getCanvas();
  if (!canvas || !canvas.captureStream) {
    setStatus('Recording not supported (canvas unavailable)', true);
    return;
  }
  const stream = canvas.captureStream(30);
  const mimeCandidates = ['video/mp4;codecs=h264', 'video/webm;codecs=vp9', 'video/webm'];
  const mimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m));
  if (!mimeType) {
    setStatus('No supported MediaRecorder mime type', true);
    return;
  }
  const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
  const mr = new MediaRecorder(stream, { mimeType });
  recorder = { mediaRecorder: mr, chunks: [], recording: true, ext };
  mr.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recorder.chunks.push(e.data);
  };
  mr.onstop = () => {
    const blob = new Blob(recorder.chunks, { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `capture.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    recorder = { mediaRecorder: null, chunks: [], recording: false };
    setStatus(`Recording saved (capture.${ext})`);
  };
  mr.start();
  setStatus(`Recording started (canvas only, ${mimeType})`);
}

function stopRecording() {
  if (!recorder.recording || !recorder.mediaRecorder) {
    setStatus('No active recording to stop', true);
    return;
  }
  recorder.mediaRecorder.stop();
}

function enableExternalUpdateLoop() {
  if (!viewer) return;
  viewer.selfDrivenMode = false;
  let last = performance.now();
  function loop() {
    const now = performance.now();
    const delta = (now - last) / 1000;
    last = now;
    updateKeyboard(delta);
    updateFlythrough(delta);
    const ready =
      viewer?.splatMesh &&
      viewer?.inIndexArray &&
      viewer?.outIndexArray &&
      viewer?.sortWorker;
    if (ready) {
      if (firstFramePending) {
        viewer.updateView?.(true, true);
        firstFramePending = false;
        setStatus('Rendering...');
      }
      viewer.update?.();
      viewer.render?.();
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

function assertCrossOriginIsolation() {
  if (!window.crossOriginIsolated) {
    const instruction = `Enable COOP/COEP by running "npm run dev" or "npm run preview" and open ${window.location.origin} (not file://). SharedArrayBuffer sorting will fail otherwise.`;
    setStatus(instruction, true);
    console.error(instruction);
    return false;
  }
  return true;
}

function selectedPath() {
  if (sceneSelect.value === '__custom') {
    return customPathInput.value.trim();
  }
  return sceneSelect.value;
}

function normalizePath(rawPath) {
  if (!rawPath) return rawPath;
  if (/^https?:\/\//i.test(rawPath)) return rawPath;
  // avoid leading slash so it works when served from a subpath or from file:// builds
  return rawPath.replace(/^\/+/, '');
}

function buildCandidatePaths(normalizedPath) {
  const candidates = new Set();
  if (!normalizedPath) return [];
  const absoluteFromPage = new URL(normalizedPath, window.location.href).toString();
  const absoluteFromOrigin = new URL(normalizedPath, window.location.origin + window.location.pathname).toString();
  candidates.add(normalizedPath);
  candidates.add(`/${normalizedPath}`);
  candidates.add(absoluteFromPage);
  candidates.add(absoluteFromOrigin);
  return Array.from(candidates);
}

async function fetchWithFallback(paths) {
  let lastError;
  for (const path of paths) {
    try {
      const response = await fetch(path);
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const buffer = await response.arrayBuffer();
      return { buffer, resolvedPath: path };
    } catch (error) {
      console.warn('[loadScene] fetch failed for candidate', path, error);
      lastError = error;
    }
  }
  throw lastError || new Error('No path candidates succeeded');
}

function orientationFromPreset(preset) {
  const q = new Quaternion();
  const axisX = new Vector3(1, 0, 0);
  const axisZ = new Vector3(0, 0, 1);
  switch (preset) {
    case 'flip-x':
      q.setFromAxisAngle(axisX, Math.PI);
      break;
    case 'flip-z':
      q.setFromAxisAngle(axisZ, Math.PI);
      break;
    case 'identity':
    default:
      q.identity();
  }
  return q;
}

function buildOccupancy(splatBuffer, orientation, voxelSize = 0.8, sampleStep = 32) {
  const count = splatBuffer.getSplatCount();
  const posArray = new Float32Array(count * 3);
  splatBuffer.fillPositionArray(posArray);
  const rot = orientation || new Quaternion();
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i += sampleStep) {
    v.set(posArray[i * 3], posArray[i * 3 + 1], posArray[i * 3 + 2]);
    v.applyQuaternion(rot);
    min.min(v);
    max.max(v);
  }
  const padding = voxelSize * 2;
  min.subScalar(padding);
  max.addScalar(padding);

  const blocked = new Set();
  const cellKey = (x, y, z) => `${x},${y},${z}`;
  const quantize = (vec) => vec.clone().sub(min).divideScalar(voxelSize).floor();

  const dilate = [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(0, 0, -1),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, -1, 0),
  ];

  for (let i = 0; i < count; i += sampleStep) {
    v.set(posArray[i * 3], posArray[i * 3 + 1], posArray[i * 3 + 2]);
    v.applyQuaternion(rot);
    const c = quantize(v);
    blocked.add(cellKey(c.x, c.y, c.z));
    for (const d of dilate) {
      blocked.add(cellKey(c.x + d.x, c.y + d.y, c.z + d.z));
    }
  }

  return {
    voxelSize,
    origin: min,
    blocked,
    quantize,
    cellKey,
    dequantize: (c) =>
      new THREE.Vector3(
        c.x * voxelSize + voxelSize * 0.5 + min.x,
        c.y * voxelSize + voxelSize * 0.5 + min.y,
        c.z * voxelSize + voxelSize * 0.5 + min.z,
      ),
    inBounds: (c) => true, // sparse grid
  };
}

function isFreeCell(cell, grid) {
  return !grid.blocked.has(grid.cellKey(cell.x, cell.y, cell.z));
}

function computeBounds(splatBuffer, orientation) {
  const count = splatBuffer.getSplatCount();
  const posArray = new Float32Array(count * 3);
  splatBuffer.fillPositionArray(posArray);
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  const rot = orientation || new Quaternion();
  const v = new THREE.Vector3();
  // sample for median XZ
  const xs = [];
  const zs = [];
  const step = Math.max(1, Math.floor(count / 50000)); // cap to ~50k samples
  for (let i = 0; i < count; i++) {
    v.set(posArray[i * 3], posArray[i * 3 + 1], posArray[i * 3 + 2]);
    v.applyQuaternion(rot);
    min.min(v);
    max.max(v);
    if (i % step === 0) {
      xs.push(v.x);
      zs.push(v.z);
    }
  }
  xs.sort((a, b) => a - b);
  zs.sort((a, b) => a - b);
  const median = (arr) => arr.length ? arr[Math.floor(arr.length / 2)] : 0;
  const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
  const medianXZ = new THREE.Vector3(median(xs), center.y, median(zs));
  return { min, max, center, medianXZ };
}

function buildStraightPath(start, bounds, cameraDir, durationSec = 15) {
  const extents = new THREE.Vector3().subVectors(bounds.max, bounds.min);
  const forward = cameraDir.clone().setY(0);
  if (forward.lengthSq() < 1e-4) {
    const dominant = extents.x > extents.z ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    forward.copy(dominant);
  }
  forward.normalize();
  const lateral = new THREE.Vector3(forward.z, 0, -forward.x);
  const span = Math.max(extents.x, extents.z) * 0.4;
  const usableSpan = Math.min(Math.max(span, 5), 30);
  const sideOffset = Math.max(Math.min(extents.length() * 0.01, 1), 0.1);

  const anchor = start.clone(); // keep exact height

  const points = [
    anchor.clone(),
    anchor.clone().addScaledVector(forward, usableSpan * 0.3).addScaledVector(lateral, sideOffset * 0.2),
    anchor.clone().addScaledVector(forward, usableSpan * 0.6),
    anchor.clone().addScaledVector(forward, usableSpan * 0.9).addScaledVector(lateral, -sideOffset * 0.2),
    anchor.clone().addScaledVector(forward, usableSpan * 1.3),
  ];
  const cumulative = [0];
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    total += a.distanceTo(b);
    cumulative.push(total);
  }
  return { points, cumulative, length: total, duration: durationSec, forward: forward.clone() };
}

function triggerPlayPath() {
  if (!viewer?.camera) return;
  if (!precomputedPath || precomputedPath.length === 0) {
    setStatus('No precomputed path loaded. Set start (1) and end (2) then press F to play straight.', true);
    if (userStart && userEnd) {
      startFlyFrom(userStart, userEnd);
    }
    return;
  }
  // snap to first waypoint to avoid starting inside geometry
  const first = precomputedPath[0] || firstWaypoint;
  if (first?.pos) {
    const dirVec = first.dir ? first.dir.clone().normalize() : new THREE.Vector3(0, 0, -1);
    viewer.camera.position.copy(first.pos);
    viewer.controls?.target.copy(first.pos.clone().addScaledVector(dirVec, 2));
    viewer.controls?.update();
    viewer.updateView?.(true, true);
    viewer.render?.();
    if (typeof window !== 'undefined') {
      window.__CAM_READY = true;
      window.__CAM_POS = viewer.camera.position.toArray();
      window.__CAM_DIR = dirVec.toArray();
    }
  }
  flyStartState = { pos: viewer.camera.position.clone(), dir: viewer.camera.getWorldDirection(new THREE.Vector3()) };
  flythrough = { active: true, idx: 0, path: precomputedPath, speed: flythrough.speed };
  if (typeof window !== 'undefined') {
    window.__FLYING = true;
  }
  setStatus('Playing precomputed path');
}

function maybeAutoStartPath() {
  if (!autoRecord || autoFlightQueued) return;
  if (precomputedPath && precomputedPath.length > 0 && viewer?.camera) {
    autoFlightQueued = true;
    console.log('[auto] starting precomputed path (auto record)');
    setTimeout(() => {
      triggerPlayPath();
    }, 500);
  }
}

function startFlyFrom(startVec, endVec) {
  const start = startVec || viewer?.camera?.position;
  const end =
    endVec ||
    start.clone().add((viewer?.camera?.getWorldDirection(new THREE.Vector3()) || new THREE.Vector3(0, 0, -1)).setY(0).normalize().multiplyScalar(8));
  if (!sceneInfo?.bounds || !start) {
    setStatus('Load a scene first.', true);
    return;
  }
  const dir = end.clone().sub(start);
  if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
  const fwd = dir.clone().normalize();
  const mid1 = start.clone().lerp(end, 0.33);
  const mid2 = start.clone().lerp(end, 0.66);
  const pathWorld = [start.clone(), mid1, mid2, end.clone()].map((p) => ({ pos: p, dir: fwd.clone() }));
  flyStartState = { pos: start.clone(), dir: fwd.clone() };
  flythrough = {
    active: true,
    idx: 0,
    path: pathWorld,
    speed: flythrough.speed,
    start: start.clone(),
    startDir: fwd.clone(),
  };
  setStatus(
    `Flythrough started from (${start.x.toFixed(2)}, ${start.y.toFixed(2)}, ${start.z.toFixed(2)}) to (${end.x.toFixed(2)}, ${end.y.toFixed(2)}, ${end.z.toFixed(2)})`,
  );
}

async function loadScene() {
  const rawPath = selectedPath();
  const path = normalizePath(rawPath);
  if (!path) {
    setStatus('Please provide a path to a .ply file', true);
    return;
  }

  if (!assertCrossOriginIsolation()) {
    return;
  }

  if (!viewer) {
    createViewer();
  }

  viewer.stop();
  autoFlightQueued = false;
  if (typeof window !== 'undefined') {
    window.__PRE_READY = false;
    window.__PRE_PATH = 0;
  }
  setStatus(`Fetching ${path}...`);

  try {
    const candidates = buildCandidatePaths(path);
    const { buffer, resolvedPath } = await fetchWithFallback(candidates);
    setStatus(`Processing ${resolvedPath}...`);
    console.log('[loadScene] fetched', resolvedPath);
    const parser = new GaussianSplats3D.PlyParser(buffer);
    const splatBuffer = parser.parseToSplatBuffer(0, 1);
    const orientation = orientationFromPreset(defaultOrientationPreset);
    const bounds = computeBounds(splatBuffer, orientation);
    let occupancy = null;
    const prePathPromise = (async () => {
      const pathUrl = resolvedPath.replace(/\.ply$/, '.path.json');
      console.log('[loadScene] precomputed fetch attempt', pathUrl);
      const resp = await fetch(pathUrl);
      console.log('[loadScene] precomputed fetch', pathUrl, resp.status);
      if (!resp.ok) return null;
      const data = await resp.json();
      if (!Array.isArray(data) || data.length === 0) return null;
      return data
        .map((item) => {
          if (Array.isArray(item)) {
            return { pos: new THREE.Vector3(...item), dir: null };
          }
          if (item.pos && Array.isArray(item.pos)) {
            const d = item.dir && Array.isArray(item.dir) ? new THREE.Vector3(...item.dir) : null;
            return { pos: new THREE.Vector3(...item.pos), dir: d };
          }
          return null;
        })
        .filter(Boolean);
    })();
    prePathPromise.then((path) => {
      if (path && path.length && typeof window !== 'undefined') {
        window.__PRE_READY = true;
        window.__PRE_PATH = path.length;
      }
    }).catch(() => {});
    // collision map off for stability; straight path only
    sceneInfo = { bounds, occupancy, orientation };
  userStart = null;
  flythrough = { active: false, idx: 0, path: [], speed: 1.0, start: null, startDir: null };
    if (typeof window !== 'undefined') {
      window.__CAM_READY = false;
      window.__FLYING = false;
      window.__PRE_READY = false;
      window.__PRE_PATH = 0;
    }
  await viewer.loadSplatBuffer(splatBuffer, {
    splatAlphaRemovalThreshold: 5,
      halfPrecisionCovariancesOnGPU: true,
      showLoadingSpinner: !autoRecord,
      orientation,
    });
    firstFramePending = true;
    setStatus(`Loaded ${resolvedPath} (${defaultOrientationPreset}) - initializing sort...`);
    console.log('[loadScene] attempting precomputed load...');
    try {
      const loadedPath = await prePathPromise;
      if (loadedPath && loadedPath.length > 0) {
        precomputedPath = loadedPath;
        firstWaypoint = precomputedPath[0] || null;
        if (firstWaypoint?.pos) {
          const dirVec = firstWaypoint.dir ? firstWaypoint.dir.clone().normalize() : new THREE.Vector3(0, 0, -1);
          viewer.camera.position.copy(firstWaypoint.pos);
          viewer.controls?.target.copy(firstWaypoint.pos.clone().addScaledVector(dirVec, 2));
          viewer.controls?.update();
          viewer.updateView?.(true, true);
          viewer.render?.();
          if (typeof window !== 'undefined') {
            window.__CAM_READY = true;
          }
        }
        setStatus(`Loaded ${resolvedPath} with precomputed path (${precomputedPath.length} points).`);
        console.log('[loadScene] precomputed path loaded', precomputedPath.length);
        if (typeof window !== 'undefined') {
          window.__PRE_READY = true;
          window.__PRE_PATH = precomputedPath.length;
        }
        maybeAutoStartPath();
      } else {
        if (typeof window !== 'undefined') {
          window.__PRE_READY = false;
          window.__PRE_PATH = 0;
        }
      }
    } catch (err) {
      console.warn('[loadScene] precomputed path fetch failed', err);
      if (typeof window !== 'undefined') {
        window.__PRE_READY = false;
        window.__PRE_PATH = 0;
      }
    }
  } catch (error) {
    console.error(error);
    setStatus(
      `Failed to load ${path}. (${error?.message || 'unknown error'}) 1) Make sure the file is converted with \"npm run convert -- input-data/<file>.ply public/<file>.ply -w\" 2) Use a relative path like \"outdoor-drone.ply\" (no leading slash) when running from ${window.location.origin}.`,
      true,
    );
  }
}

function onSceneSelectChange() {
  const isCustom = sceneSelect.value === '__custom';
  customPathInput.toggleAttribute('disabled', !isCustom);
  if (!isCustom) {
    customPathInput.value = '';
  }
}

function recenterTarget() {
  if (!viewer?.camera || !viewer?.controls) return;
  const dir = viewer.camera.getWorldDirection(new THREE.Vector3()).normalize();
  viewer.controls.target.copy(viewer.camera.position).addScaledVector(dir, 2);
  viewer.controls.update();
}

loadButton.addEventListener('click', loadScene);
sceneSelect.addEventListener('change', onSceneSelectChange);
customPathInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    sceneSelect.value = '__custom';
    onSceneSelectChange();
    loadScene();
  }
});
viewerRoot.addEventListener('pointerdown', recenterTarget);
recStartBtn?.addEventListener('click', startRecording);
recStopBtn?.addEventListener('click', stopRecording);

window.addEventListener('DOMContentLoaded', () => {
  createViewer();
  onSceneSelectChange();
  loadScene();
});

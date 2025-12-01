// Offline path planner using gaussian-splats-3d PlyParser.
// Usage:
//   node plan-path.js sx sy sz ex ey ez
// Produces: public/ConferenceHall.path.json (list of [x,y,z] points)
//
// Notes:
// - Orientation is fixed to Flip Z (matching viewer).
// - Grid is 2D (XZ) with dilation to avoid columns; height is kept from start.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Quaternion, Vector3 } from 'three';
import { PlyParser } from 'gaussian-splats-3d/build/gaussian-splats-3d.module.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INPUT = path.join(__dirname, 'public', 'ConferenceHall.ply');
const OUTPUT = path.join(__dirname, 'public', 'ConferenceHall.path.json');
const VOXEL = 0.6; // grid size (meters)
const SAMPLE_STEP = 200;
const MAX_NODES = 80000;

const flipZ = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI);

function loadPositions(plyPath) {
  const buf = fs.readFileSync(plyPath);
  const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const parser = new PlyParser(arrayBuf);
  const splatBuffer = parser.parseToSplatBuffer(0, 1);
  const count = splatBuffer.getSplatCount();
  const positions = new Float32Array(count * 3);
  splatBuffer.fillPositionArray(positions);
  return positions;
}

function buildGrid(posArray) {
  const rot = flipZ;
  const min = new Vector3(Infinity, 0, Infinity);
  const max = new Vector3(-Infinity, 0, -Infinity);
  const v = new Vector3();
  const total = posArray.length / 3;
  for (let i = 0; i < total; i += SAMPLE_STEP) {
    v.set(posArray[i * 3], posArray[i * 3 + 1], posArray[i * 3 + 2]).applyQuaternion(rot);
    min.x = Math.min(min.x, v.x);
    min.z = Math.min(min.z, v.z);
    max.x = Math.max(max.x, v.x);
    max.z = Math.max(max.z, v.z);
  }
  min.x -= VOXEL * 2;
  min.z -= VOXEL * 2;
  max.x += VOXEL * 2;
  max.z += VOXEL * 2;

  const blocked = new Set();
  const key = (x, z) => `${x},${z}`;
  const quantize = (vec) =>
    new Vector3(
      Math.floor((vec.x - min.x) / VOXEL),
      0,
      Math.floor((vec.z - min.z) / VOXEL),
    );
  for (let i = 0; i < total; i += SAMPLE_STEP) {
    v.set(posArray[i * 3], posArray[i * 3 + 1], posArray[i * 3 + 2]).applyQuaternion(rot);
    const c = quantize(v);
    blocked.add(key(c.x, c.z));
  }

  return {
    origin: min,
    key,
    quantize,
    blocked,
    dequantize: (cell, y) =>
      new Vector3(
        cell.x * VOXEL + VOXEL * 0.5 + min.x,
        y,
        cell.z * VOXEL + VOXEL * 0.5 + min.z,
      ),
  };
}

function isFree(cell, grid) {
  return !grid.blocked.has(grid.key(cell.x, cell.z));
}

function clearCorridor(grid, startWorld, endWorld, radiusCells = 2) {
  const steps = 200;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = startWorld.clone().lerp(endWorld, t);
    const c = grid.quantize(p);
    for (let dx = -radiusCells; dx <= radiusCells; dx++) {
      for (let dz = -radiusCells; dz <= radiusCells; dz++) {
        grid.blocked.delete(grid.key(c.x + dx, c.z + dz));
      }
    }
  }
}

function aStar(grid, startCell, goalCell, maxNodes) {
  const open = [{ c: startCell, f: 0 }];
  const came = new Map();
  const gScore = new Map([[grid.key(startCell.x, startCell.z), 0]]);
  const neighbors = [
    new Vector3(1, 0, 0),
    new Vector3(-1, 0, 0),
    new Vector3(0, 0, 1),
    new Vector3(0, 0, -1),
  ];
  const h = (c) => Math.abs(c.x - goalCell.x) + Math.abs(c.z - goalCell.z);

  let explored = 0;
  while (open.length && explored < maxNodes) {
    open.sort((a, b) => a.f - b.f);
    const current = open.shift().c;
    const ck = grid.key(current.x, current.z);
    if (current.x === goalCell.x && current.z === goalCell.z) {
      const path = [];
      let k = ck;
      let c = current;
      while (k) {
        path.push(c);
        const prev = came.get(k);
        if (!prev) break;
        c = prev.c;
        k = prev.k;
      }
      return path.reverse();
    }
    explored++;
    for (const n of neighbors) {
      const nc = new Vector3(current.x + n.x, 0, current.z + n.z);
      const nk = grid.key(nc.x, nc.z);
      if (!isFree(nc, grid)) continue;
      const tentative = (gScore.get(ck) || 0) + 1;
      if (tentative < (gScore.get(nk) || Infinity)) {
        came.set(nk, { k: ck, c: current });
        gScore.set(nk, tentative);
        const fScore = tentative + h(nc);
        if (!open.find((o) => grid.key(o.c.x, o.c.z) === nk)) open.push({ c: nc, f: fScore });
      }
    }
  }
  return null;
}

function main() {
  const args = process.argv.slice(2).map(Number);
  if (args.length !== 6 || args.some((n) => Number.isNaN(n))) {
    console.error('Usage: node plan-path.js sx sy sz ex ey ez');
    process.exit(1);
  }
  const [sx, sy, sz, ex, ey, ez] = args;
  console.log('Reading positions...');
  const positions = loadPositions(INPUT);
  console.log('Positions:', positions.length / 3, 'splats (sampled)');
  console.log('Building grid...');
  const grid = buildGrid(positions);
  const startWorld = new Vector3(sx, sy, sz).applyQuaternion(flipZ);
  const endWorld = new Vector3(ex, ey, ez).applyQuaternion(flipZ);
  const startCell = grid.quantize(startWorld);
  const endCell = grid.quantize(endWorld);
  grid.blocked.delete(grid.key(startCell.x, startCell.z));
  grid.blocked.delete(grid.key(endCell.x, endCell.z));
  clearCorridor(grid, startWorld, endWorld, 3);
  console.log('Running A*...');
  const cells = aStar(grid, startCell, endCell, MAX_NODES);
  if (!cells) {
    console.error('No path found.');
    process.exit(1);
  }
  const pathPoints = cells.map((c) => grid.dequantize(c, sy).applyQuaternion(flipZ.invert()));
  // Save as simple array of arrays
  const arr = pathPoints.map((p) => [p.x, p.y, p.z]);
  fs.writeFileSync(OUTPUT, JSON.stringify(arr, null, 2));
  console.log(`Saved ${arr.length} points to ${OUTPUT}`);
}

main();

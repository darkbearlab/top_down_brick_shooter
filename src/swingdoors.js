// ---------- 推門（地圖字元 d） ----------
// 一片繞著門軸轉的門板：人走過去會把它推開、停在推開的角度；打得爛
// 關著的門板擋視線和子彈；尋路當作走得過（敵人會自己推門）
import * as THREE from 'three';
import { sfx } from './audio.js';
import { UNIT_BOX, WALL_H, WOOD } from './core.js';
import { burst, sparks } from './fx.js';
import { W, H, isSolidTile, level } from './world.js';

const LEN = 0.94, HALF = 0.05, MAX_A = 1.75, DOOR_HP = 90;
const doorMat = new THREE.MeshLambertMaterial({ color: 0x8a5a32 });
const knobMat = new THREE.MeshLambertMaterial({ color: 0xd8c070 });

export function addSwingDoor(c, r) {
  // 左右都是牆 → 門板橫的（擋南北），軸在左邊；否則直的，軸在上面
  const horiz = isSolidTile(c - 1, r) && isSolidTile(c + 1, r);
  const hx = c - W / 2 + (horiz ? 0.03 : 0.5), hz = r - H / 2 + (horiz ? 0.5 : 0.03);
  const base = horiz ? 0 : Math.PI / 2;
  const g = new THREE.Group();
  const panel = new THREE.Mesh(UNIT_BOX, doorMat);
  panel.scale.set(LEN, WALL_H * 0.9, HALF * 2);
  panel.position.set(LEN / 2, WALL_H * 0.45, 0);
  panel.castShadow = panel.receiveShadow = true;
  const knob = new THREE.Mesh(UNIT_BOX, knobMat);
  knob.scale.set(0.07, 0.07, HALF * 2 + 0.08);
  knob.position.set(LEN - 0.12, WALL_H * 0.42, 0);
  g.add(panel, knob);
  g.position.set(hx, 0, hz);
  level.group.add(g);
  const d = { c, r, hx, hz, base, a: 0, w: 0, hp: DOOR_HP, g, alive: true };
  setAngle(d, 0);
  level.swings.push(d);
}

function setAngle(d, a) {
  d.a = Math.max(-MAX_A, Math.min(MAX_A, a));
  const phi = d.base + d.a;
  d.ux = Math.cos(phi); d.uz = Math.sin(phi);
  d.g.rotation.y = -phi;
}

export function updateSwingDoors(dt) {
  for (const d of level.swings) {
    if (!d.alive || Math.abs(d.w) < 1e-3) continue;
    const before = d.a;
    setAngle(d, d.a + d.w * dt);
    if (d.a === before || Math.abs(d.a) >= MAX_A) d.w = 0;
    d.w *= Math.exp(-5 * dt);
  }
}

// 點到門板（線段）的最近距離
function closest(d, x, z) {
  const t = Math.max(0, Math.min(LEN, (x - d.hx) * d.ux + (z - d.hz) * d.uz));
  const px = d.hx + d.ux * t, pz = d.hz + d.uz * t;
  return { t, px, pz, dist: Math.hypot(x - px, z - pz) };
}

// 圓形撞到門板：大部分推力拿去轉門，剩下的把人推開；巨型殭屍衝撞直接撞爛
export function collideSwings(o, rad) {
  for (const d of level.swings) {
    if (!d.alive || Math.abs(o.x - d.hx) > 1.6 || Math.abs(o.z - d.hz) > 1.6) continue;
    const q = closest(d, o.x, o.z), min = rad + HALF;
    if (q.dist >= min) continue;
    if (o.state === 'dash' && (o.def?.mass ?? 1) >= 4) { breakSwing(d, o.lx ?? 0, o.lz ?? 0); continue; }
    const pen = min - q.dist;
    let nx, nz;
    if (q.dist > 1e-4) { nx = (o.x - q.px) / q.dist; nz = (o.z - q.pz) / q.dist; }
    else { nx = -d.uz; nz = d.ux; }
    // 人在門板哪一側：往另一側推
    const side = Math.sign((o.x - d.hx) * -d.uz + (o.z - d.hz) * d.ux) || 1;
    const lever = Math.max(q.t, 0.3);
    const before = d.a;
    setAngle(d, d.a - side * pen * 0.85 / lever);
    const turned = Math.abs(d.a - before) * lever;
    d.w = (d.a - before) * 15;   // 推完還會再晃一點
    const rest = Math.max(0, pen - turned * 0.95);
    o.x += nx * rest; o.z += nz * rest;
    if (Math.abs(d.a - before) > 0.05 && !d.creak) { d.creak = true; sfx.doorHit(); }
    if (Math.abs(d.a) < 0.05) d.creak = false;
  }
}

// 射線打到哪片門板：回傳距離（沒打到 = Infinity）
export function raySwings(ox, oz, dx, dz, max) {
  let best = Infinity;
  if (!level?.swings) return best;
  for (const d of level.swings) {
    if (!d.alive) continue;
    // 兩條線段求交：o + t*dir 和 h + s*u
    const den = dx * d.uz - dz * d.ux;
    if (Math.abs(den) < 1e-6) continue;
    const ex = d.hx - ox, ez = d.hz - oz;
    const t = (ex * d.uz - ez * d.ux) / den;
    const s = (ex * dz - ez * dx) / den;
    if (t >= 0 && t <= max && s >= 0 && s <= LEN && t < best) best = t;
  }
  return best;
}

// 子彈每一小步檢查：打到門板就扣血、把門推一下
export function bulletHitsSwing(b) {
  for (const d of level.swings) {
    if (!d.alive || Math.abs(b.x - d.hx) > 1.1 || Math.abs(b.z - d.hz) > 1.1) continue;
    const q = closest(d, b.x, b.z);
    if (q.dist > HALF + 0.03 || q.t < 0.02) continue;
    const side = Math.sign((b.x - b.dx * 0.2 - d.hx) * -d.uz + (b.z - b.dz * 0.2 - d.hz) * d.ux) || 1;
    d.w -= side * 1.2 / Math.max(q.t, 0.3);
    d.hp -= b.owner === 'p' ? b.dmg : 20;
    burst(b.x, 0.9, b.z, WOOD, 2, 2, -b.dx, -b.dz);
    sparks(b.x - b.dx * 0.05, 0.9, b.z - b.dz * 0.05, 0xffd090, 3, -b.dx, -b.dz);
    if (b.owner === 'p') sfx.doorHit();
    if (d.hp <= 0) breakSwing(d, b.dx, b.dz);
    return true;
  }
  return false;
}

export function breakSwing(d, dx = 0, dz = 0) {
  if (!d.alive) return;
  d.alive = false;
  level.group.remove(d.g);
  const mx = d.hx + d.ux * LEN / 2, mz = d.hz + d.uz * LEN / 2;
  burst(mx, 0.8, mz, WOOD, 14, 5, dx * 6, dz * 6);
  sfx.breach();
}

// 門板大致關著（拿來算聲音被悶住）
export function swingClosedAt(c, r) {
  for (const d of level.swings) if (d.alive && d.c === c && d.r === r) return Math.abs(d.a) < 0.35;
  return false;
}

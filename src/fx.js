import * as THREE from 'three';
import { sampleVoxels } from './voxel.js';
import { CAM_PITCH, DEBRIS_GEO, FLASH_GEO, UNIT_BOX, WALL_H, addMat, debrisMat, scene } from './core.js';

// 粒子撞牆判定由地圖模組在啟動時注入，fx 不直接依賴遊戲模組
let wallTest = () => false;
export function setWallTest(fn) { wallTest = fn; }

// ---------- 雷射 ----------
export function makeLaser(color) {
  const g = new THREE.Group();
  const core = new THREE.Mesh(UNIT_BOX, addMat(0xffffff));
  const glow = new THREE.Mesh(UNIT_BOX, addMat(color));
  const dot = new THREE.Mesh(FLASH_GEO, glow.material);
  dot.scale.setScalar(0.45);
  g.add(core, glow, dot);
  g.visible = false;
  scene.add(g);
  return { g, core, glow, dot };
}
export function setLaser(L, ox, oz, dx, dz, len, y, alpha, w) {
  L.g.visible = true;
  L.g.position.set(ox + dx * len / 2, y, oz + dz * len / 2);
  L.g.rotation.set(0, Math.atan2(dx, dz), 0);
  L.core.scale.set(w * 0.35, w * 0.35, len);
  L.glow.scale.set(w, w, len);
  L.dot.position.set(0, 0, len / 2);
  L.core.material.opacity = alpha;
  L.glow.material.opacity = alpha * 0.6;
}
export function freeLaser(L) { scene.remove(L.g); L.core.material.dispose(); L.glow.material.dispose(); }

// ---------- 頭上進度條（換彈）與驚覺標記 ----------
export const BAR_GEO = new THREE.PlaneGeometry(1, 1);
export const BAR_FILL_GEO = new THREE.PlaneGeometry(1, 1).translate(0.5, 0, 0);
export function makeBar(color) {
  const g = new THREE.Group();
  const bg = new THREE.Mesh(BAR_GEO, new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6, depthTest: false }));
  bg.scale.set(0.9, 0.13, 1);
  const fill = new THREE.Mesh(BAR_FILL_GEO, new THREE.MeshBasicMaterial({ color, depthTest: false, toneMapped: false }));
  fill.position.set(-0.42, 0, 0.001);
  fill.scale.set(0.84, 0.07, 1);
  bg.renderOrder = 10; fill.renderOrder = 11;
  g.add(bg, fill);
  g.rotation.x = -CAM_PITCH;   // 面向攝影機
  g.visible = false;
  scene.add(g);
  return { g, fill };
}
export function setBar(b, x, y, z, k) {
  b.g.visible = true;
  b.g.position.set(x, y, z);
  b.fill.scale.x = 0.84 * Math.max(0.001, Math.min(1, k));
}
export function freeBar(b) { scene.remove(b.g); }

export function textTexture(text, color) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  g.font = '900 54px system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 8; g.strokeStyle = '#000';
  g.strokeText(text, 32, 35);
  g.fillStyle = color; g.fillText(text, 32, 35);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
export const ALERT_TEX = textTexture('!', '#ffd23a');
export const markers = [];
export function showMarker(e) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: ALERT_TEX, depthTest: false, transparent: true }));
  s.renderOrder = 12;
  scene.add(s);
  markers.push({ s, e, life: 0.9 });
}
export function updateMarkers(dt) {
  for (let i = markers.length - 1; i >= 0; i--) {
    const m = markers[i];
    m.life -= dt;
    if (m.life <= 0 || m.e.dead) {
      scene.remove(m.s); m.s.material.dispose(); markers.splice(i, 1); continue;
    }
    const t = 1 - m.life / 0.9;
    const sc = t < 0.12 ? (t / 0.12) * 0.9 : 0.75;
    m.s.scale.set(sc, sc, 1);
    m.s.position.set(m.e.x, 2.1 * m.e.def.scale, m.e.z);
    m.s.material.opacity = m.life < 0.3 ? m.life / 0.3 : 1;
  }
}

// ---------- 粒子 ----------
export const debris = [], fx = [];
export function burst(x, y, z, colors, n, power, bx = 0, bz = 0) {
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(DEBRIS_GEO, debrisMat(colors[i % colors.length]));
    const s = 0.7 + Math.random() * 1.3;
    m.scale.setScalar(s);
    m.position.set(x + (Math.random() - 0.5) * 0.4, y + (Math.random() - 0.5) * 0.6, z + (Math.random() - 0.5) * 0.4);
    m.castShadow = true;
    scene.add(m);
    const a = Math.random() * Math.PI * 2, p = power * (0.4 + Math.random() * 0.8);
    debris.push({
      m, s, life: 1.6 + Math.random() * 1.2,
      vx: Math.cos(a) * p + bx, vy: 3 + Math.random() * power, vz: Math.sin(a) * p + bz,
      sx: (Math.random() - 0.5) * 20, sz: (Math.random() - 0.5) * 20,
    });
  }
}
// 角色 / 武器爆開：直接拿身上的方塊噴出去
export function voxelBurst(root, n, power, bx = 0, bz = 0) {
  const cx = root.position.x, cz = root.position.z;
  for (const v of sampleVoxels(root, n)) {
    const m = new THREE.Mesh(DEBRIS_GEO, debrisMat(v.c));
    const s = 0.6 + Math.random() * 0.5;
    m.scale.setScalar(s);
    m.position.set(v.x, v.y, v.z);
    m.castShadow = true;
    scene.add(m);
    let ox = v.x - cx, oz = v.z - cz;
    const ol = Math.hypot(ox, oz) || 1;
    ox /= ol; oz /= ol;
    const p = power * (0.4 + Math.random() * 0.8);
    debris.push({
      m, s, life: 1.6 + Math.random() * 1.2,
      vx: ox * p + (Math.random() - 0.5) * 2 + bx, vy: 2 + Math.random() * power * 0.9 + v.y, vz: oz * p + (Math.random() - 0.5) * 2 + bz,
      sx: (Math.random() - 0.5) * 20, sz: (Math.random() - 0.5) * 20,
    });
  }
}
export function sparks(x, y, z, color, n, nx = 0, nz = 0) {
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(UNIT_BOX, addMat(color));
    m.scale.setScalar(0.07);
    m.position.set(x, y, z);
    scene.add(m);
    const a = Math.random() * Math.PI * 2, p = 3 + Math.random() * 6;
    fx.push({ m, life: 0.12 + Math.random() * 0.15, max: 0.27,
      vx: Math.cos(a) * p + nx * 5, vy: Math.random() * 4, vz: Math.sin(a) * p + nz * 5 });
  }
}
export function muzzleFlash(x, y, z, color) {
  const m = new THREE.Mesh(FLASH_GEO, addMat(color));
  m.position.set(x, y, z);
  m.rotation.set(Math.random() * 3, Math.random() * 3, 0);
  scene.add(m);
  fx.push({ m, life: 0.05, max: 0.05, vx: 0, vy: 0, vz: 0, grow: true });
}
export function updateParticles(dt) {
  for (let i = debris.length - 1; i >= 0; i--) {
    const d = debris[i], p = d.m.position;
    d.vy -= 24 * dt;
    p.x += d.vx * dt; p.y += d.vy * dt; p.z += d.vz * dt;
    d.m.rotation.x += d.sx * dt; d.m.rotation.z += d.sz * dt;
    if (p.y < 0.08) {
      p.y = 0.08; d.vy *= -0.35; d.vx *= 0.55; d.vz *= 0.55; d.sx *= 0.5; d.sz *= 0.5;
    }
    if (wallTest(p.x, p.z) && p.y < WALL_H) { d.vx *= -0.4; d.vz *= -0.4; p.x += d.vx * dt * 2; p.z += d.vz * dt * 2; }
    d.life -= dt;
    if (d.life < 0.4) d.m.scale.setScalar(d.s * Math.max(0, d.life / 0.4));
    if (d.life <= 0) { scene.remove(d.m); debris.splice(i, 1); }
  }
  for (let i = fx.length - 1; i >= 0; i--) {
    const f = fx[i], p = f.m.position;
    p.x += f.vx * dt; p.y += f.vy * dt; p.z += f.vz * dt;
    f.life -= dt;
    const k = Math.max(0, f.life / f.max);
    if (f.grow) f.m.scale.setScalar(0.55 + (1 - k) * 0.4); else f.m.scale.setScalar(0.07 * (0.3 + k));
    f.m.material.opacity = k;
    if (f.life <= 0) { scene.remove(f.m); f.m.material.dispose(); fx.splice(i, 1); }
  }
}

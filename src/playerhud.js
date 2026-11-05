// ---------- 角色身上的 HUD（極簡） ----------
// 生命：頭上一排菱形方塊（紅 = 還在、淡白 = 掉了；護甲是接在後面的灰藍菱形），被打時掉的那格閃一下
// 彈數：腳下一條橫條，從左往右一發一格；彈匣太大（> 20 發）就改成連續的條
//       空格是淡白色；子彈少於 1/4 變橘紅；換彈時整條變淡，藍色從左往右填滿
import * as THREE from 'three';
import { CAM_PITCH, G, MAX_HITS, scene } from './core.js';
import { curSlot, player } from './player.js';

const flat = (color, opacity = 1) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, depthTest: false, toneMapped: false });

// ---- 頭上的生命：菱形 ----
const PIP = 0.17, PIP_STEP = 0.31;   // 方塊邊長、相鄰兩顆中心距離
const PIP_GEO = new THREE.PlaneGeometry(PIP, PIP);
const M = { hp: flat(0xff4a5a), lost: flat(0xffffff, 0.2), armor: flat(0xb8c6dc), flash: flat(0xffffff) };
const head = new THREE.Group();
head.rotation.x = -CAM_PITCH;   // 面向攝影機
scene.add(head);
let headKey = '', hitFlash = 0, lastHits = 0;
function buildHead() {
  head.clear();
  const n = MAX_HITS + player.armor;
  for (let i = 0; i < n; i++) {
    const armor = i >= MAX_HITS, lost = !armor && i >= MAX_HITS - player.hits;
    const m = new THREE.Mesh(PIP_GEO, armor ? M.armor : lost ? M.lost : M.hp);
    m.position.x = (i - (n - 1) / 2) * PIP_STEP;
    m.rotation.z = Math.PI / 4;
    m.renderOrder = 20;
    m.userData.justLost = lost && i === MAX_HITS - player.hits;
    head.add(m);
  }
}

// ---- 腳下的彈數：橫條 ----
const BAR_W = 1.05, BAR_H = 0.1;
// spans = [[x0, x1], ...]（0~1），回傳一排長方形
function barGeo(spans) {
  const pos = [], y0 = -BAR_H / 2, y1 = BAR_H / 2;
  for (const [a, b] of spans) {
    const x0 = (a - 0.5) * BAR_W, x1 = (b - 0.5) * BAR_W;
    pos.push(x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y0, 0, x1, y1, 0, x0, y1, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}
const A = { full: flat(0xe8f6ff, 0.92), low: flat(0xff7a40, 0.95), empty: flat(0xffffff, 0.18), reload: flat(0x5adcff, 0.95) };
const ammoBar = new THREE.Group();
ammoBar.rotation.x = -CAM_PITCH;   // 面向攝影機
scene.add(ammoBar);
const barOn = new THREE.Mesh(new THREE.BufferGeometry(), A.full), barOff = new THREE.Mesh(new THREE.BufferGeometry(), A.empty);
barOn.renderOrder = barOff.renderOrder = 20;
ammoBar.add(barOff, barOn);
let ammoKey = '';
function buildAmmo(s, reloadK) {
  const mag = s.stats.mag, on = [], off = [];
  if (reloadK != null) {
    off.push([0, 1]);
    if (reloadK > 0) on.push([0, reloadK]);
  } else if (mag <= 20) {
    const step = 1 / mag, gap = Math.min(0.025, step * 0.3);
    for (let i = 0; i < mag; i++) (i < s.ammo ? on : off).push([i * step + gap / 2, (i + 1) * step - gap / 2]);
  } else {
    const k = s.ammo / mag;
    if (k > 0) on.push([0, k]);
    if (k < 1) off.push([k, 1]);
  }
  barOn.geometry.dispose(); barOff.geometry.dispose();
  barOn.geometry = barGeo(on); barOff.geometry = barGeo(off);
  barOn.material = reloadK != null ? A.reload : s.ammo <= Math.ceil(mag / 4) ? A.low : A.full;
}

export function updatePlayerHud(dt) {
  const p = player, s = curSlot();
  const show = !!s && p.alive && p.man.root.visible && (G.state === 'play' || G.state === 'paused' || G.state === 'complete' || G.state === 'transition');
  head.visible = ammoBar.visible = show;
  if (!show) return;
  // 生命
  const hk = `${p.hits}|${p.armor}`;
  if (hk !== headKey) {
    headKey = hk;
    buildHead();
    if (p.hits > lastHits) hitFlash = 0.45;
    lastHits = p.hits;
  }
  if (hitFlash > 0) {
    hitFlash -= dt;
    for (const m of head.children) if (m.userData.justLost) {
      const on = hitFlash > 0 && Math.floor(hitFlash * 16) % 2 === 0;
      m.material = on ? M.flash : M.lost;
      m.scale.setScalar(1 + Math.max(0, hitFlash) * 1.2);
    }
  }
  head.position.set(p.x, 2.75, p.z);
  // 彈數
  const reloadK = s.reloadT > 0 ? 1 - s.reloadT / s.stats.reload : null;
  const ak = `${p.cur}|${s.ammo}|${s.stats.mag}|${reloadK == null ? '-' : Math.floor(reloadK * 48)}`;
  if (ak !== ammoKey) { ammoKey = ak; buildAmmo(s, reloadK); }
  // 畫面上在腳的正下方
  ammoBar.position.set(p.x, 0.05, p.z + 0.75);
}

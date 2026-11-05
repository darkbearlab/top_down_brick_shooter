// ---------- 道具 ----------
// 兩種來源：
// - 地圖重生型：關卡 def.items 排好時間；開場就在地上標出位置，到點從地板冒出方塊組裝成道具，閃一下才撿得到；計時型被撿走後會在原地再組裝 respawn 次
// - 敵人掉落型：def.drops = 掉落機率；掉在地上 DROP_LIFE 秒沒撿就消失（最後幾秒閃爍）
// 效果：
// - 急救包、護甲：撿了就是你的，帶到下一關（不會重生）
// - 加速、強攻、快換：限時 buff，剩餘時間不帶到下一關
import * as THREE from 'three';
import { sfx } from './audio.js';
import { G, addMat } from './core.js';
import { sparks } from './fx.js';
import { player } from './player.js';
import { level, randomFloorSpot } from './world.js';
import { showToast, updateHud } from './main.js';

export const MAX_ARMOR = 2;
export const ITEM_KINDS = {
  heal: { name: '急救包', color: 0x40e070, timed: false, can: () => player.hits > 0,
    apply() { player.hits = Math.max(0, player.hits - 1); updateHud(); } },
  armor: { name: '護甲 +1', color: 0x9aa8bc, timed: false, can: () => player.armor < MAX_ARMOR,
    apply() { player.armor = Math.min(MAX_ARMOR, player.armor + 1); updateHud(); } },
  speed: { name: '加速', color: 0x40d8ff, timed: true, dur: 8, buff: 'speed' },
  power: { name: '強攻', color: 0xff6a30, timed: true, dur: 8, buff: 'power' },
  quick: { name: '快換', color: 0xffd040, timed: true, dur: 10, buff: 'quick' },
};
export const BUFF_LABEL = { speed: '加速', power: '強攻', quick: '快換' };
const DROP_LIFE = 12;
// 敵人掉落的種類與權重
const DROP_TABLE = [['heal', 2], ['speed', 3], ['power', 3], ['quick', 3], ['armor', 1]];

const BOX = new THREE.BoxGeometry(0.34, 0.34, 0.34);
const CROSS_A = new THREE.BoxGeometry(0.36, 0.1, 0.12), CROSS_B = new THREE.BoxGeometry(0.12, 0.1, 0.36);
const RING = new THREE.RingGeometry(0.34, 0.42, 28);
const mats = new Map();
const matOf = c => { if (!mats.has(c)) mats.set(c, new THREE.MeshLambertMaterial({ color: c, emissive: c, emissiveIntensity: 0.45 })); return mats.get(c); };
const WHITE = new THREE.MeshBasicMaterial({ color: 0xffffff });

function makeMesh(kind) {
  const k = ITEM_KINDS[kind];
  const g = new THREE.Group();
  const box = new THREE.Mesh(BOX, matOf(k.color));
  box.castShadow = true;
  // 頂面一個白色十字，在亮的地板上也看得出是道具
  const ca = new THREE.Mesh(CROSS_A, WHITE), cb = new THREE.Mesh(CROSS_B, WHITE);
  ca.position.y = cb.position.y = 0.18;
  const spin = new THREE.Group();
  spin.add(box, ca, cb);
  const ring = new THREE.Mesh(RING, addMat(k.color, 0.6));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  g.add(spin, ring);
  return { g, spin, ring };
}

export function spawnItem(kind, x, z, opts = {}) {
  const m = makeMesh(kind);
  m.g.position.set(x, 0, z);
  level.group.add(m.g);
  const it = { kind, x, z, ...m, life: opts.life ?? Infinity, slot: opts.slot ?? null, t: 0 };
  level.items.push(it);
  if (!opts.quiet) sparks(x, 0.5, z, ITEM_KINDS[kind].color, 8);
  return it;
}

// ---------- 地圖重生型：開場就在地上標出位置 ----------
// 每個 slot 一塊地標（同色淡圈 + 四個角括號），到時間就從地板冒出方塊組裝成道具，閃一下才撿得到
// 計時型被撿走後地標留著，過 every 秒在原地再組裝一次（respawn 次）；用完地標才消失
const ASSEMBLE = 1.0;
const PAD_RING = new THREE.RingGeometry(0.44, 0.5, 32);
const CORNER = new THREE.PlaneGeometry(0.2, 0.05);
const CUBE = new THREE.BoxGeometry(0.08, 0.08, 0.08);
function makePad(kind, x, z) {
  const color = ITEM_KINDS[kind].color;
  const g = new THREE.Group();
  const mat = addMat(color, 0.3);
  const ring = new THREE.Mesh(PAD_RING, mat);
  ring.rotation.x = -Math.PI / 2;
  g.add(ring);
  // 四個 L 形角括號，圍成一個方框
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const ax = new THREE.Mesh(CORNER, mat), az = new THREE.Mesh(CORNER, mat);
    ax.rotation.x = az.rotation.x = -Math.PI / 2;
    az.rotation.z = Math.PI / 2;
    ax.position.set(sx * 0.31, 0, sz * 0.4);
    az.position.set(sx * 0.4, 0, sz * 0.31);
    g.add(ax, az);
  }
  g.position.set(x, 0.025, z);
  level.group.add(g);
  return { g, mat };
}

export function initItems(def) {
  level.items = [];
  level.itemClock = 0;
  level.slots = [];
  // 位置開場就決定：離玩家起點 4～12 格、彼此至少隔 3 格
  for (const s of def.items ?? []) {
    let spot = null;
    for (let k = 0; k < 30; k++) {
      const c = randomFloorSpot(4, 12);
      if (c && level.slots.every(o => Math.hypot(o.x - c.x, o.z - c.z) >= 3)) { spot = c; break; }
    }
    if (!spot) continue;
    level.slots.push({
      kind: s.kind, x: spot.x, z: spot.z, at: s.at, state: 'wait',
      respawn: s.respawn ?? (ITEM_KINDS[s.kind].timed ? 1 : 0), every: s.every ?? 20,
      pad: makePad(s.kind, spot.x, spot.z), cubes: null, item: null, t: 0,
    });
  }
}

function startBuild(sl) {
  sl.state = 'build'; sl.t = 0;
  const it = spawnItem(sl.kind, sl.x, sl.z, { slot: sl, quiet: true });
  it.building = true;
  it.g.visible = false;
  sl.item = it;
  const color = ITEM_KINDS[sl.kind].color;
  sl.cubes = Array.from({ length: 18 }, (_, i) => {
    const mesh = new THREE.Mesh(CUBE, i % 3 ? matOf(color) : WHITE_CUBE);
    const a = Math.random() * Math.PI * 2, r = 0.35 + Math.random() * 0.5;
    const from = [sl.x + Math.cos(a) * r, 0.03, sl.z + Math.sin(a) * r];
    const to = [sl.x + (Math.random() - 0.5) * 0.3, 0.3 + Math.random() * 0.3, sl.z + (Math.random() - 0.5) * 0.3];
    mesh.position.set(...from);
    mesh.visible = false;
    level.group.add(mesh);
    return { mesh, from, to, arrive: 0.35 + Math.random() * 0.55 };
  });
  sfx.assemble?.();
}
const WHITE_CUBE = new THREE.MeshBasicMaterial({ color: 0xffffff });
function updateBuild(sl, dt) {
  sl.t += dt;
  const k = Math.min(1, sl.t / ASSEMBLE);
  for (const c of sl.cubes) {
    const u = Math.max(0, Math.min(1, (k - (c.arrive - 0.35)) / 0.35));
    c.mesh.visible = u > 0 && u < 1;
    const e = 1 - (1 - u) ** 3;
    c.mesh.position.set(c.from[0] + (c.to[0] - c.from[0]) * e, c.from[1] + (c.to[1] - c.from[1]) * e + Math.sin(u * Math.PI) * 0.2, c.from[2] + (c.to[2] - c.from[2]) * e);
    c.mesh.rotation.set(u * 7, u * 5, 0);
  }
  sl.pad.mat.opacity = 0.4 + 0.4 * Math.abs(Math.sin(sl.t * 14));
  if (k < 1) return;
  // 組好了：閃一下，現在才撿得到
  for (const c of sl.cubes) level.group.remove(c.mesh);
  sl.cubes = null;
  sl.state = 'ready';
  const it = sl.item;
  it.building = false;
  it.g.visible = true;
  it.flash = 0.15;
  sparks(sl.x, 0.5, sl.z, ITEM_KINDS[sl.kind].color, 12);
  sparks(sl.x, 0.5, sl.z, 0xffffff, 6);
  sfx.assembleDone?.();
}

export function maybeDrop(e) {
  const p = level?.def?.drops ?? 0;
  if (!p || Math.random() >= p) return;
  const pool = DROP_TABLE.filter(([k]) => ITEM_KINDS[k].timed || ITEM_KINDS[k].can());
  let v = Math.random() * pool.reduce((a, [, w]) => a + w, 0);
  for (const [k, w] of pool) if ((v -= w) < 0) { spawnItem(k, e.x, e.z, { life: DROP_LIFE }); return; }
}

function pickUp(it) {
  const k = ITEM_KINDS[it.kind];
  if (k.timed) { player.buffs[k.buff] = k.dur; renderBuffs(); }
  else k.apply();
  sparks(it.x, 0.6, it.z, k.color, 14);
  sfx.pickup?.();
  showToast(k.name, 'item');
  level.group.remove(it.g);
  // 地圖道具：還有重生次數就等下一次，用完就拿掉地標
  const sl = it.slot;
  if (!sl) return;
  sl.item = null;
  if (sl.respawn > 0) { sl.respawn--; sl.state = 'wait'; sl.at = level.itemClock + sl.every; }
  else { sl.state = 'done'; level.group.remove(sl.pad.g); }
}

export function updateItems(dt) {
  if (!level?.items || G.state !== 'play') return;
  level.itemClock += dt;
  const T = level.itemClock;
  for (const sl of level.slots) {
    if (sl.state === 'wait') {
      // 快出現時地標閃得越來越快
      const left = sl.at - T;
      sl.pad.mat.opacity = left < 3 ? 0.3 + 0.35 * Math.abs(Math.sin(T * (6 + (3 - left) * 4))) : 0.22 + 0.08 * Math.sin(T * 2);
      if (left <= 0) startBuild(sl);
    } else if (sl.state === 'build') updateBuild(sl, dt);
    else if (sl.state === 'ready') sl.pad.mat.opacity = 0.3;
  }
  for (let i = level.items.length - 1; i >= 0; i--) {
    const it = level.items[i];
    if (it.building) continue;
    it.t += dt;
    it.spin.position.y = 0.42 + Math.sin(it.t * 3) * 0.07;
    it.spin.rotation.y += dt * 1.8;
    it.ring.material.opacity = 0.35 + 0.3 * Math.abs(Math.sin(it.t * 4));
    if (it.flash > 0) { it.flash -= dt; it.spin.scale.setScalar(1 + it.flash * 3); } else it.spin.scale.setScalar(1);
    it.life -= dt;
    if (it.life < 3) it.g.visible = it.life > 0 && Math.floor(it.life * 8) % 2 === 0;
    if (it.life <= 0) { level.group.remove(it.g); level.items.splice(i, 1); continue; }
    if (!player.alive || Math.hypot(player.x - it.x, player.z - it.z) > 0.65) continue;
    const k = ITEM_KINDS[it.kind];
    if (!k.timed && !k.can()) continue;   // 滿血 / 護甲滿就留在地上
    level.items.splice(i, 1);
    pickUp(it);
  }
  // buff 倒數
  let changed = false;
  for (const b in player.buffs) {
    if (player.buffs[b] <= 0) continue;
    const before = Math.ceil(player.buffs[b]);
    player.buffs[b] = Math.max(0, player.buffs[b] - dt);
    if (Math.ceil(player.buffs[b]) !== before) changed = true;
  }
  if (changed) renderBuffs();
}

export function renderBuffs() {
  const el = document.getElementById('buffs');
  if (!el) return;
  el.innerHTML = Object.entries(player.buffs).filter(([, t]) => t > 0)
    .map(([b, t]) => `<span class="buff buff-${b}">${BUFF_LABEL[b]} ${Math.ceil(t)}</span>`).join('');
}

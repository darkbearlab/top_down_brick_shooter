// ---------- 道具 ----------
// 兩種來源：
// - 地圖重生型：關卡 def.items 排好時間，到點就出現在離玩家 4～12 格的空地；計時型被撿走後會在原地再出現 respawn 次
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
  const it = { kind, x, z, ...m, life: opts.life ?? Infinity, respawn: opts.respawn ?? 0, every: opts.every ?? 20, t: 0 };
  level.items.push(it);
  sparks(x, 0.5, z, ITEM_KINDS[kind].color, 8);
  return it;
}

// 關卡開始：排好地圖道具的出現時間
export function initItems(def) {
  level.items = [];
  level.itemQueue = (def.items ?? []).map(s => ({ ...s })).sort((a, b) => a.at - b.at);
  level.itemClock = 0;
  level.respawns = [];
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
  // 計時型的地圖道具：過一陣子在原地再出現（次數有限）
  if (it.respawn > 0) level.respawns.push({ kind: it.kind, x: it.x, z: it.z, at: level.itemClock + it.every, respawn: it.respawn - 1, every: it.every });
}

export function updateItems(dt) {
  if (!level?.items || G.state !== 'play') return;
  level.itemClock += dt;
  const T = level.itemClock;
  while (level.itemQueue.length && level.itemQueue[0].at <= T) {
    const s = level.itemQueue.shift();
    const spot = randomFloorSpot(4, 12);
    if (spot) spawnItem(s.kind, spot.x, spot.z, { respawn: s.respawn ?? (ITEM_KINDS[s.kind].timed ? 1 : 0), every: s.every ?? 20 });
  }
  for (let i = level.respawns.length - 1; i >= 0; i--) {
    const r = level.respawns[i];
    if (r.at > T) continue;
    level.respawns.splice(i, 1);
    spawnItem(r.kind, r.x, r.z, { respawn: r.respawn, every: r.every });
  }
  for (let i = level.items.length - 1; i >= 0; i--) {
    const it = level.items[i];
    it.t += dt;
    it.spin.position.y = 0.42 + Math.sin(it.t * 3) * 0.07;
    it.spin.rotation.y += dt * 1.8;
    it.ring.material.opacity = 0.35 + 0.3 * Math.abs(Math.sin(it.t * 4));
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

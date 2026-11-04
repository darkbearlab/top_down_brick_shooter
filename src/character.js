// ---------- 角色造型（look）：分部位的方塊資料 ----------
// 每個部位有自己的格子空間（w × h × d，單位 1/16）和一塊「骨架核心」：
// 核心的方塊刪不掉（只能換顏色），動作、碰撞、拿槍位置都以核心為準；
// 空間裡其他地方隨便堆，跟著這個部位一起動
// 座標：x 往角色的左手邊、y 往上、z 往前（角色面朝 +z）
import { V, VoxelSet, buildVoxelMesh } from './voxel.js';

// size = 空間大小；core = [x, y, z, w, h, d]；anchor = 空間裡對到掛載點的位置（格線座標）；
// at = 掛載點在身體裡的位置；limb = 繞掛載點轉的四肢
export const LOOK_PARTS = {
  head: { name: '頭', size: [9, 10, 9], core: [2, 1, 2, 5, 5, 5], anchor: [4.5, 1, 4.5], at: [0, 1.3 - 2.5 * V, -0.5 * V] },
  torso: { name: '身體', size: [12, 12, 11], core: [2, 1, 3, 8, 9, 5], anchor: [6, 5.5, 5.5], at: [0, 0.85, 0] },
  armR: { name: '右手', size: [6, 10, 6], core: [2, 1, 2, 2, 7, 2], anchor: [3, 8, 3], at: [-0.3125, 1.08, 0], limb: true, twin: 'armL' },
  armL: { name: '左手', size: [6, 10, 6], core: [2, 1, 2, 2, 7, 2], anchor: [3, 8, 3], at: [0.3125, 1.08, 0], limb: true, twin: 'armR' },
  legR: { name: '右腳', size: [5, 10, 6], core: [1, 0, 1, 3, 9, 3], anchor: [2.5, 9, 2.5], at: [-0.125, 0.58, 0], limb: true, twin: 'legL' },
  legL: { name: '左腳', size: [5, 10, 6], core: [1, 0, 1, 3, 9, 3], anchor: [2.5, 9, 2.5], at: [0.125, 0.58, 0], limb: true, twin: 'legR' },
};
export const PART_KEYS = Object.keys(LOOK_PARTS);
export const MAX_VOXELS = 3000;
export const PLAYER_COLORS = { shirt: 0x2f8cff, pants: 0x23324d, helmet: 0x1f5fa8 };

export const key = (x, y, z) => `${x},${y},${z}`;
export const inSpace = (p, x, y, z) => { const s = LOOK_PARTS[p].size; return x >= 0 && y >= 0 && z >= 0 && x < s[0] && y < s[1] && z < s[2]; };
export const inCore = (p, x, y, z) => {
  const [cx, cy, cz, w, h, d] = LOOK_PARTS[p].core;
  return x >= cx && y >= cy && z >= cz && x < cx + w && y < cy + h && z < cz + d;
};
// 左右鏡像（空間都是對核心中心對稱的）
export const mirrorX = (p, x) => LOOK_PARTS[p].size[0] - 1 - x;

// 空間的 (0,0,0) 角落在身體座標裡的位置
export function partOrigin(p) {
  const P = LOOK_PARTS[p];
  return [P.at[0] - P.anchor[0] * V, P.at[1] - P.anchor[1] * V, P.at[2] - P.anchor[2] * V];
}

// look = { parts: { head: Map(key → [x, y, z, hex]), ... } }
function emptyLook() { return { parts: Object.fromEntries(PART_KEYS.map(p => [p, new Map()])) }; }
function put(look, p, x, y, z, c) { look.parts[p].set(key(x, y, z), [x, y, z, c]); }
function coreBox(look, p, fn) {
  const [cx, cy, cz, w, h, d] = LOOK_PARTS[p].core;
  for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) for (let k = 0; k < d; k++) put(look, p, cx + i, cy + j, cz + k, fn(i, j, k));
}

// 用顏色組出原本那種方塊人（敵人、人質都用這個；玩家沒自訂時也是）
export function defaultLook({ skin = 0xf0c9a0, shirt = 0x888888, pants = 0x2b2f3a, boots = 0x1b1c22, helmet = null } = {}) {
  const L = emptyLook();
  coreBox(L, 'torso', (i, j) => j === 0 ? 0x2a2420 : shirt);
  coreBox(L, 'head', (i, j, k) => k === 4 && j === 2 && (i === 1 || i === 3) ? 0x111111 : skin);
  if (helmet !== null) {
    const [cx, cy, cz] = LOOK_PARTS.head.core;
    for (let i = 0; i < 5; i++) for (let k = 0; k < 5; k++) for (let j = 4; j < 6; j++) put(L, 'head', cx + i, cy + j, cz + k, helmet);
    for (let i = 0; i < 5; i++) put(L, 'head', cx + i, cy + 4, cz + 5, helmet);
  }
  for (const p of ['armR', 'armL']) coreBox(L, p, (i, j) => j < 2 ? skin : shirt);
  for (const p of ['legR', 'legL']) coreBox(L, p, (i, j) => j < 2 ? boots : pants);
  return L;
}
export const playerDefaultLook = () => defaultLook(PLAYER_COLORS);

// 核心缺的格子補回來（匯入的資料或舊存檔）
function fillCore(L) {
  const def = playerDefaultLook();
  for (const p of PART_KEYS) {
    const [cx, cy, cz, w, h, d] = LOOK_PARTS[p].core;
    for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) for (let k = 0; k < d; k++) {
      const kk = key(cx + i, cy + j, cz + k);
      if (!L.parts[p].has(kk)) L.parts[p].set(kk, def.parts[p].get(kk));
    }
  }
  return L;
}

export const cloneLook = L => ({ parts: Object.fromEntries(PART_KEYS.map(p => [p, new Map([...L.parts[p]].map(([k, v]) => [k, [...v]]))])) });
export const countVoxels = L => PART_KEYS.reduce((n, p) => n + L.parts[p].size, 0);

// 存檔 / 造型碼：{ v: 1, pal: [hex...], parts: { head: [[x, y, z, 色號], ...] } }
export function serializeLook(L) {
  const pal = [], idx = new Map();
  const parts = {};
  for (const p of PART_KEYS) parts[p] = [...L.parts[p].values()].map(([x, y, z, c]) => {
    if (!idx.has(c)) { idx.set(c, pal.length); pal.push(c); }
    return [x, y, z, idx.get(c)];
  });
  return { v: 1, pal, parts };
}
export function parseLook(data) {
  const o = typeof data === 'string' ? JSON.parse(data) : data;
  if (!o || o.v !== 1 || !Array.isArray(o.pal) || typeof o.parts !== 'object') throw new Error('不是造型碼');
  const L = emptyLook();
  let n = 0;
  for (const p of PART_KEYS) for (const v of o.parts[p] ?? []) {
    const [x, y, z, ci] = v.map(Number);
    const c = Number(o.pal[ci]);
    if (!inSpace(p, x, y, z) || !Number.isFinite(c) || ++n > MAX_VOXELS) continue;
    put(L, p, x, y, z, c & 0xffffff);
  }
  return fillCore(L);
}

const STORE = 'brickshooter.look.v1';
export function loadPlayerLook() {
  try { const s = localStorage.getItem(STORE); if (s) return parseLook(s); } catch { /* 壞掉就用預設 */ }
  return playerDefaultLook();
}
export function savePlayerLook(L) {
  try { localStorage.setItem(STORE, JSON.stringify(serializeLook(L))); } catch { /* 存不了就只影響這次 */ }
}

// 一個部位的方塊網格：網格原點 = 掛載點
export function buildPartMesh(L, p, mat) {
  const set = new VoxelSet();
  for (const [x, y, z, c] of L.parts[p].values()) set.set(x, y, z, c);
  const mesh = buildVoxelMesh(set, mat);
  const a = LOOK_PARTS[p].anchor;
  mesh.position.set(-a[0] * V, -a[1] * V, -a[2] * V);
  return mesh;
}

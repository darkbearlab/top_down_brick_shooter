// 武器組裝系統：彈種 → 槍機 → 配件（槍托、彈匣、槍管、前握把）
// 每個零件 = 數值修正 + 互斥規則 + 方塊外型
import { V, VoxelSet } from './voxel.js';

export const WEAPON_PAL = {
  metal: 0x2b2e34, metal2: 0x41464f, poly: 0x1c1d21, steel: 0x6d7480,
  hg: 0x3b4034, tan: 0x8a7350, mag: 0x30333a, lens: 0x46cfff,
};

export const CALIBERS = {
  '9mm': { name: '9mm 手槍彈', damage: 30, range: 13, speed: 30, kick: 1, noise: 9 },
  '556': { name: '5.56 步槍彈', damage: 44, range: 22, speed: 38, kick: 1.2, noise: 11 },
};

// kick = 每發後座力（度）；turn = 轉向速度（度/秒）
// sockets 的座標是方塊整數座標，原點 = 握把（手）的位置，+z 朝前
export const RECEIVERS = {
  pistol: {
    name: '手槍', caliber: '9mm', desc: '輕、甩槍快、射速慢',
    fireInterval: 0.15, kick: 4, turn: 900, reload: 0.9, mag: 13, weight: 0.8, spread: 0.04, damage: 1, range: 0.9,
    compact: true, noSlots: ['stock', 'grip'],
    sockets: { barrel: { z: 6, y: 2 }, mag: { z: -2, y: -5 } },
    shape(s) {
      s.box(-1, 1, -3, 2, 3, 9, 'metal2');   // 滑套
      s.box(-1, 0, -2, 2, 1, 7, 'metal');    // 槍身
      s.box(-1, -5, -2, 2, 5, 3, 'poly');    // 握把
      s.box(-1, -2, 1, 2, 1, 2, 'metal');    // 扳機護弓
    },
  },
  smg: {
    name: '衝鋒槍', caliber: '9mm', desc: '射速快、後座小、射程短',
    fireInterval: 0.07, kick: 2.2, turn: 680, reload: 1.3, mag: 25, weight: 2, spread: 0.09, damage: 0.95, range: 1,
    sockets: { stock: { z: -4, y: 1 }, barrel: { z: 8, y: 1 }, mag: { z: 4, y: 0 } },
    shape(s) {
      s.box(-1, 0, -4, 2, 4, 12, 'metal');
      s.box(-1, 4, -2, 2, 1, 6, 'metal2');
      s.box(-1, -5, -1, 2, 5, 3, 'poly');
      s.box(-1, -2, 2, 2, 1, 1, 'metal');
    },
  },
  carbine: {
    name: '卡賓槍', caliber: '556', desc: '全能型',
    fireInterval: 0.1, kick: 2.4, turn: 540, reload: 1.5, mag: 30, weight: 3, spread: 0.05, damage: 1, range: 1,
    sockets: { stock: { z: -5, y: 1 }, barrel: { z: 9, y: 1 }, mag: { z: 3, y: 0 } },
    shape(s) {
      s.box(-1, 0, -5, 2, 4, 14, 'metal');
      s.box(-1, 4, -3, 2, 1, 10, 'metal2');  // 上方滑軌
      s.box(-1, -5, -2, 2, 5, 3, 'poly');
      s.box(-1, -2, 1, 2, 1, 1, 'metal');
    },
  },
  dmr: {
    name: '精確射手步槍', caliber: '556', desc: '高威力、遠射程、射速慢、轉向慢',
    fireInterval: 0.26, kick: 6, turn: 400, reload: 1.7, mag: 15, weight: 4, spread: 0.015, damage: 1.65, range: 1.35,
    sockets: { stock: { z: -6, y: 1 }, barrel: { z: 10, y: 1 }, mag: { z: 3, y: 0 } },
    shape(s) {
      s.box(-1, 0, -6, 2, 4, 16, 'metal');
      s.box(-1, 4, -4, 2, 1, 12, 'metal2');
      s.box(-1, 5, -2, 2, 2, 7, 'poly');     // 瞄準鏡
      s.box(-1, 5, 5, 2, 2, 1, 'lens');
      s.box(-1, -5, -2, 2, 5, 3, 'poly');
      s.box(-1, -2, 1, 2, 1, 1, 'metal');
    },
  },
};

export const SLOTS = [
  { key: 'stock', label: '槍托' },
  { key: 'mag', label: '彈匣' },
  { key: 'barrel', label: '槍管' },
  { key: 'grip', label: '前握把' },
];

// mods：乘法修正（weight 是加法）
// excludeRec：哪些槍機不能用；excludeParts：跟哪些其他零件互斥
export const PARTS = {
  stock: [
    { id: 'none', name: '無槍托', mods: { kick: 1.45, turn: 1.2 },
      excludeRec: ['dmr'], reason: '精確射手步槍必須裝槍托', shape() {} },
    { id: 'fold', name: '摺疊槍托', mods: { kick: 1.12, turn: 1.08, weight: 0.3 },
      shape(s, k) {
        s.box(-1, k.y + 2, k.z - 9, 2, 1, 9, 'metal2');
        s.box(-1, k.y - 1, k.z - 9, 2, 1, 9, 'metal2');
        s.box(-1, k.y - 2, k.z - 10, 2, 6, 1, 'poly');
      } },
    { id: 'full', name: '固定槍托', mods: { kick: 0.7, turn: 0.9, weight: 0.8 },
      shape(s, k) {
        s.box(-1, k.y - 1, k.z - 9, 2, 4, 9, 'poly');
        s.box(-1, k.y - 3, k.z - 11, 2, 6, 2, 'poly');
      } },
  ],
  mag: [
    { id: 'short', name: '短彈匣', mods: { mag: 0.6, reload: 0.75, turn: 1.05 },
      shape(s, k, rec) { if (!rec.compact) s.box(-1, k.y - 3, k.z, 2, 3, 3, 'mag'); } },
    { id: 'std', name: '標準彈匣', mods: {},
      shape(s, k, rec) {
        if (rec.compact) { s.box(-1, k.y - 1, k.z, 2, 1, 3, 'metal'); return; }
        s.box(-1, k.y - 4, k.z, 2, 4, 3, 'mag');
        s.box(-1, k.y - 7, k.z + 1, 2, 3, 3, 'mag');
      } },
    { id: 'ext', name: '加長彈匣', mods: { mag: 1.5, reload: 1.15, turn: 0.97, weight: 0.3 },
      shape(s, k, rec) {
        if (rec.compact) { s.box(-1, k.y - 4, k.z, 2, 4, 3, 'mag'); s.box(-1, k.y - 5, k.z, 2, 1, 3, 'metal'); return; }
        s.box(-1, k.y - 5, k.z, 2, 5, 3, 'mag');
        s.box(-1, k.y - 10, k.z + 1, 2, 5, 3, 'mag');
      } },
    { id: 'drum', name: '彈鼓', mods: { mag: 2.4, reload: 1.7, turn: 0.85, weight: 1.2 },
      excludeRec: ['pistol', 'dmr'],
      shape(s, k) {
        s.box(-1, k.y - 2, k.z, 2, 2, 3, 'mag');
        s.box(-2, k.y - 8, k.z - 1, 4, 6, 6, (i, j, kk) =>
          (j === 0 || j === 5) && (kk === 0 || kk === 5) ? null : 'metal2');
      } },
  ],
  barrel: [
    { id: 'short', name: '短槍管', mods: { range: 0.7, damage: 0.9, turn: 1.15, kick: 1.1, spread: 1.3, noise: 1.1 },
      shape(s, k, rec) { const n = rec.compact ? 1 : 4; s.box(-1, k.y, k.z, 2, 2, n, 'steel'); return { len: n, hg: 0 }; } },
    { id: 'std', name: '標準槍管', mods: {},
      shape(s, k, rec) {
        if (rec.compact) { s.box(-1, k.y, k.z, 2, 2, 4, 'steel'); return { len: 4, hg: 0 }; }
        s.box(-1, k.y - 1, k.z, 2, 4, 6, 'hg');
        s.box(-1, k.y, k.z + 6, 2, 2, 5, 'steel');
        return { len: 11, hg: 6 };
      } },
    { id: 'long', name: '長槍管', mods: { range: 1.4, damage: 1.12, turn: 0.78, kick: 0.9, spread: 0.7, weight: 0.6 },
      excludeRec: ['pistol'],
      shape(s, k) {
        s.box(-1, k.y - 1, k.z, 2, 4, 8, 'hg');
        s.box(-1, k.y, k.z + 8, 2, 2, 11, 'steel');
        return { len: 19, hg: 8 };
      } },
  ],
  grip: [
    { id: 'none', name: '無', mods: {}, shape() {} },
    { id: 'vert', name: '垂直握把', mods: { kick: 0.78, turn: 0.95, weight: 0.2 },
      excludeParts: { barrel: ['short'] }, reason: '短槍管沒有護木可以裝前握把',
      shape(s, k) { s.box(-1, -5, k.z + 2, 2, 5, 2, 'poly'); } },
    { id: 'angled', name: '斜握把', mods: { kick: 0.88, turn: 1.07, weight: 0.15 },
      excludeParts: { barrel: ['short'] }, reason: '短槍管沒有護木可以裝前握把',
      shape(s, k) {
        s.box(-1, -1, k.z + 1, 2, 1, 5, 'poly');
        s.box(-1, -2, k.z + 1, 2, 1, 3, 'poly');
        s.box(-1, -3, k.z + 1, 2, 1, 1, 'poly');
      } },
  ],
};

export const DEFAULT_LOADOUT = [
  { caliber: '556', receiver: 'carbine', stock: 'full', mag: 'std', barrel: 'std', grip: 'vert' },
  { caliber: '9mm', receiver: 'pistol', stock: 'none', mag: 'std', barrel: 'short', grip: 'none' },
];

const SLOT_LABEL = Object.fromEntries(SLOTS.map(s => [s.key, s.label]));
export const partOf = (slot, id) => PARTS[slot].find(p => p.id === id);

// 不能裝的原因；可以裝就回傳 null
export function blockReason(slot, part, build) {
  const rec = RECEIVERS[build.receiver];
  if (rec.noSlots?.includes(slot) && part.id !== 'none') return `${rec.name}沒有${SLOT_LABEL[slot]}接口`;
  if (part.excludeRec?.includes(build.receiver)) return part.reason ?? `${rec.name}不支援`;
  for (const [s, ids] of Object.entries(part.excludeParts ?? {})) {
    if (ids.includes(build[s])) return part.reason ?? `跟${partOf(s, build[s]).name}互斥`;
  }
  return null;
}

// 修正不合法的組合：回傳修好的 build 跟被自動換掉的說明
export function validate(input) {
  const b = { ...DEFAULT_LOADOUT[0], ...input };
  const notes = [];
  if (!CALIBERS[b.caliber]) b.caliber = '556';
  if (!RECEIVERS[b.receiver] || RECEIVERS[b.receiver].caliber !== b.caliber) {
    b.receiver = Object.keys(RECEIVERS).find(k => RECEIVERS[k].caliber === b.caliber);
  }
  // 槍管先處理，前握把的規則依賴槍管
  for (const slot of ['stock', 'mag', 'barrel', 'grip']) {
    const cur = partOf(slot, b[slot]);
    const why = cur ? blockReason(slot, cur, b) : '不存在';
    if (!why) continue;
    const ok = PARTS[slot].find(p => !blockReason(slot, p, b));
    if (cur) notes.push(`${cur.name}已換成${ok.name}：${why}`);
    b[slot] = ok.id;
  }
  return { build: b, notes };
}

export function computeStats(build) {
  const cal = CALIBERS[build.caliber], rec = RECEIVERS[build.receiver];
  const s = {
    damage: cal.damage * rec.damage, range: cal.range * rec.range, speed: cal.speed,
    fireInterval: rec.fireInterval, mag: rec.mag, reload: rec.reload,
    kick: rec.kick * cal.kick, turn: rec.turn, weight: rec.weight, spread: rec.spread, noise: cal.noise,
  };
  for (const { key } of SLOTS) {
    const m = partOf(key, build[key]).mods;
    for (const k in m) {
      if (k === 'weight') s.weight += m[k];
      else s[k] *= m[k];
    }
  }
  s.mag = Math.max(1, Math.round(s.mag));
  s.rpm = 60 / s.fireInterval;
  s.name = rec.name;
  s.caliberName = cal.name;
  return s;
}

// 依組裝結果堆出方塊，並算出槍口位置（單位：世界座標）
export function buildWeapon(build) {
  const rec = RECEIVERS[build.receiver];
  const s = new VoxelSet();
  rec.shape(s);
  const so = rec.sockets;
  const bk = so.barrel;
  const bi = partOf('barrel', build.barrel).shape(s, bk, rec);
  if (so.stock) partOf('stock', build.stock).shape(s, so.stock, rec);
  partOf('mag', build.mag).shape(s, so.mag, rec);
  if (!rec.noSlots?.includes('grip')) partOf('grip', build.grip).shape(s, bk, rec);
  return { set: s, muzzleZ: (bk.z + bi.len) * V, muzzleY: (bk.y + 1) * V };
}

// 切換武器時間 = 基本 0.2 秒 + 收起那把和拿出那把的重量
export const swapTime = statsList => 0.2 + 0.06 * statsList.reduce((t, s) => t + s.weight, 0);

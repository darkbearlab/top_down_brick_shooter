import * as THREE from 'three';
import { sfx } from './audio.js';
import { ARENA_ROOMS, BREACH_LEVELS, DARK_LEVELS } from './rooms.js';
import { CUSTOM_LEVELS } from './custom_levels.js';
import { makeBlockMan } from './models.js';
import { CAM_PITCH, FLASH_GEO, G, GUN_Y, UNIT_BOX, WALL_H, WOOD, addMat, addTrauma, camTarget, scene, setLighting } from './core.js';
import { burst, freeBar, fx, makeBar, setBar, sparks, voxelBurst } from './fx.js';
import { player, resetPlayer } from './player.js';
import { alertNoise, enemies, spawnEnemy } from './enemies.js';
import { clearEntities, leaveLabel, leaveLevel, retryLevel, showPanel, showToast, updateHud } from './main.js';

export let W = 13, H = 19;          // 依地圖改變

// ---------- 地圖與碰撞 ----------
export let level = null;   // { group, grid, doorOpen, doorMeshes, exitMeshes, doors, mode, index }
export const toWorldX = c => c - W / 2 + 0.5;
export const toWorldZ = r => r - H / 2 + 0.5;
export const tileC = x => Math.floor(x + W / 2);
export const tileR = z => Math.floor(z + H / 2);

// 實心的格子（不含可破壞的格子）
export function isSolidTile(c, r) {
  if (c < 0 || r < 0 || c >= W || r >= H) return true;
  const ch = level.grid[r][c];
  if (ch === '#' || ch === 'V') return true;
  if (ch === 'D') return !level.doorOpen;
  if (ch === '=') return !level.doors.get(c + r * W).open;
  return false;
}
// 尋路與粗略判定用：可破壞的格子要打出夠大的洞才算走得過
export function isWallTile(c, r) {
  if (isSolidTile(c, r)) return true;
  const cell = level.cells.get(c + r * W);
  return !!cell && !cell.passable;
}
export const inMap = (c, r) => c >= 0 && r >= 0 && c < W && r < H;
export const doorAt = (c, r) => inMap(c, r) ? level.doors.get(c + r * W) : undefined;
export const cellAt = (c, r) => inMap(c, r) ? level.cells.get(c + r * W) : undefined;

// ---------- 可破壞的格子 ----------
// 一格切成 4x4 根小柱，每根各自有血量，打爛就消失並噴出碎塊。木門、磚牆、半掩體都用這套
export const SUB = 4, COL = 1 / SUB;
export const colIndex = (cell, x, z) => {
  const i = Math.min(SUB - 1, Math.max(0, Math.floor((x - (cell.c - W / 2)) * SUB)));
  const j = Math.min(SUB - 1, Math.max(0, Math.floor((z - (cell.r - H / 2)) * SUB)));
  return i + j * SUB;
};
export const colPos = (cell, k) => ({
  x: cell.c - W / 2 + ((k % SUB) + 0.5) * COL,
  z: cell.r - H / 2 + (((k / SUB) | 0) + 0.5) * COL,
});
// 離 (x, z) 最近、還在的柱子；回傳柱子編號、距離、從點指向柱子的方向
export function nearestColumn(cell, x, z) {
  let best = null;
  for (let k = 0; k < SUB * SUB; k++) {
    if (cell.hp[k] <= 0) continue;
    const minX = cell.c - W / 2 + (k % SUB) * COL, minZ = cell.r - H / 2 + ((k / SUB) | 0) * COL;
    const dx = Math.max(minX, Math.min(x, minX + COL)) - x, dz = Math.max(minZ, Math.min(z, minZ + COL)) - z;
    const d = Math.hypot(dx, dz);
    if (!best || d < best.d) best = { k, d, dx, dz };
  }
  return best;
}
export const wallAt = (x, z) => isWallTile(tileC(x), tileR(z));

// 圓形 vs 方塊，推出去
export function pushOutBox(o, rad, minX, minZ, size) {
  const px = Math.max(minX, Math.min(o.x, minX + size));
  const pz = Math.max(minZ, Math.min(o.z, minZ + size));
  const dx = o.x - px, dz = o.z - pz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= rad * rad) return;
  if (d2 > 1e-8) {
    const d = Math.sqrt(d2), k = (rad - d) / d;
    o.x += dx * k; o.z += dz * k;
  } else {
    // 中心卡進方塊裡：往最近的邊推
    const cx = minX + size / 2, cz = minZ + size / 2;
    if (Math.abs(o.x - cx) > Math.abs(o.z - cz)) o.x = o.x > cx ? minX + size + rad : minX - rad;
    else o.z = o.z > cz ? minZ + size + rad : minZ - rad;
  }
}
// 圓形 vs 方格牆；可破壞的格子逐根柱子算
export function collide(o, rad) {
  const c0 = tileC(o.x), r0 = tileR(o.z);
  for (let r = r0 - 1; r <= r0 + 1; r++) {
    for (let c = c0 - 1; c <= c0 + 1; c++) {
      const minX = c - W / 2, minZ = r - H / 2;
      if (isSolidTile(c, r)) { pushOutBox(o, rad, minX, minZ, 1); continue; }
      const cell = cellAt(c, r);
      if (!cell) continue;
      for (let k = 0; k < SUB * SUB; k++) {
        if (cell.hp[k] > 0) pushOutBox(o, rad, minX + (k % SUB) * COL, minZ + ((k / SUB) | 0) * COL, COL);
      }
    }
  }
}

// 方格 DDA 射線，回傳撞牆距離
export function castRay(ox, oz, dx, dz, max) {
  const x = ox + W / 2, z = oz + H / 2;
  let cx = Math.floor(x), cz = Math.floor(z);
  if (isSolidTile(cx, cz)) return 0;
  const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
  const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tmx = dx > 0 ? (cx + 1 - x) * tdx : dx < 0 ? (x - cx) * tdx : Infinity;
  let tmz = dz > 0 ? (cz + 1 - z) * tdz : dz < 0 ? (z - cz) * tdz : Infinity;
  let t = 0;
  let hit = rayCell(cx, cz, ox, oz, dx, dz, 0, Math.min(tmx, tmz, max));
  if (hit !== null) return hit;
  while (t < max) {
    if (tmx < tmz) { cx += sx; t = tmx; tmx += tdx; } else { cz += sz; t = tmz; tmz += tdz; }
    if (isSolidTile(cx, cz)) return Math.min(t, max);
    hit = rayCell(cx, cz, ox, oz, dx, dz, t, Math.min(tmx, tmz, max));
    if (hit !== null) return hit;
  }
  return max;
}
// 射線穿過可破壞的格子：一小步一小步找第一根還在的實心柱（半掩體不擋視線和雷射）
export function rayCell(c, r, ox, oz, dx, dz, t0, t1) {
  const cell = cellAt(c, r);
  if (!cell || !cell.full) return null;
  for (let t = t0; t <= t1 + 1e-6; t += 0.04) {
    if (cell.hp[colIndex(cell, ox + dx * t, oz + dz * t)] > 0) return t;
  }
  return null;
}

export function rayCircle(ox, oz, dx, dz, cx, cz, r) {
  const fx = ox - cx, fz = oz - cz;
  const b = fx * dx + fz * dz;
  const c = fx * fx + fz * fz - r * r;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : (c < 0 ? 0 : Infinity);
}

export function hasLOS(ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, d = Math.hypot(dx, dz);
  if (d < 1e-4) return true;
  return castRay(ax, az, dx / d, dz / d, d) >= d - 0.01;
}

export const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// 從玩家所在格做 BFS，敵人看不到玩家時沿著它走；也拿來算槍聲傳多遠（關著的門會擋）
// zflow 給殭屍用：關著的門也算走得通，殭屍會走到門前一直敲
export let flow = new Int16Array(W * H), zflow = new Int16Array(W * H);
export function bfs(field, pass) {
  field.fill(-1);
  const sc = tileC(player.x), sr = tileR(player.z);
  if (isWallTile(sc, sr)) return;
  const q = [sc + sr * W];
  field[q[0]] = 0;
  for (let i = 0; i < q.length; i++) {
    const c = q[i] % W, r = (q[i] / W) | 0, d = field[q[i]];
    for (const [dc, dr] of DIRS4) {
      const nc = c + dc, nr = r + dr;
      if (!pass(nc, nr) || field[nc + nr * W] !== -1) continue;
      field[nc + nr * W] = d + 1;
      q.push(nc + nr * W);
    }
  }
}
export function buildFlow() {
  bfs(flow, (c, r) => !isWallTile(c, r));
  bfs(zflow, (c, r) => !isWallTile(c, r) || doorAt(c, r)?.open === false || cellAt(c, r)?.kind === 'door');
}
export const fieldAt = (field, c, r) => (c >= 0 && c < W && r >= 0 && r < H) ? field[c + r * W] : -1;
export const flowAt = (x, z) => {
  const c = tileC(x), r = tileR(z);
  return (c >= 0 && c < W && r >= 0 && r < H) ? flow[c + r * W] : -1;
};
export function navDir(e, field = flow) {
  const c = tileC(e.x), r = tileR(e.z);
  let best = null, bestD = fieldAt(field, c, r);
  if (bestD < 0) bestD = 9999;
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dc && !dr) continue;
    const nc = c + dc, nr = r + dr;
    const d = fieldAt(field, nc, nr);
    if (d < 0) continue;
    if (dc && dr && (fieldAt(field, c + dc, r) < 0 || fieldAt(field, c, r + dr) < 0)) continue; // 不切牆角
    if (d < bestD) { bestD = d; best = [nc, nr]; }
  }
  const tx = best ? toWorldX(best[0]) : player.x, tz = best ? toWorldZ(best[1]) : player.z;
  const dx = tx - e.x, dz = tz - e.z, d = Math.hypot(dx, dz) || 1;
  return { x: dx / d, z: dz / d };
}

// 換彈時找最近一個玩家看不到的格子（6 步內），回傳路徑
export function findCoverPath(e) {
  const sc = tileC(e.x), sr = tileR(e.z);
  const start = sc + sr * W;
  const prev = new Map([[start, -1]]);
  const depth = new Map([[start, 0]]);
  const q = [start];
  for (let i = 0; i < q.length; i++) {
    const k = q[i], c = k % W, r = (k / W) | 0;
    if (k !== start && !hasLOS(toWorldX(c), toWorldZ(r), player.x, player.z)) {
      const path = [];
      for (let n = k; n !== start; n = prev.get(n)) path.unshift({ x: toWorldX(n % W), z: toWorldZ((n / W) | 0) });
      return path;
    }
    if (depth.get(k) >= 6) continue;
    for (const [dc, dr] of DIRS4) {
      const nc = c + dc, nr = r + dr, nk = nc + nr * W;
      if (isWallTile(nc, nr) || prev.has(nk)) continue;
      prev.set(nk, k); depth.set(nk, depth.get(k) + 1);
      q.push(nk);
    }
  }
  return null;
}

// ---------- 關卡建造 ----------
export function makeFloorTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  g.fillStyle = '#262b36'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#2c3240'; g.fillRect(3, 3, 58, 58);
  g.fillStyle = '#1d212a'; g.fillRect(0, 0, 64, 2); g.fillRect(0, 0, 2, 64);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
export const floorTex = makeFloorTexture();

// 牆：頂面亮、側面暗（頂點顏色）
export function shadedBox(h, sideHex, topHex) {
  const geo = new THREE.BoxGeometry(1, h, 1);
  const n = geo.attributes.position.count, col = new Float32Array(n * 3);
  const side = new THREE.Color(sideHex), top = new THREE.Color(topHex);
  for (let i = 0; i < n; i++) {
    const c = (i >= 8 && i < 12) ? top : side;  // BoxGeometry 第 3 面 = +Y
    col.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}
export const wallGeo = shadedBox(WALL_H, 0x3a4256, 0x8a96b0);
export const gateGeo = shadedBox(WALL_H * 0.95, 0x4c5462, 0xc8a438);    // 鐵捲門：頂面黃色
export const ventGeo = shadedBox(WALL_H, 0x2c3140, 0x15171c);            // 通風口：殭屍從這裡爬出來
export const GATE_COLORS = [0x4c5462, 0xc8a438, 0x2a2e36];

// 可破壞格子的種類：h 柱高、hp 每根柱子的血量、full 是否擋子彈和視線（半掩體只在貼著時擋）
export const CELL_KINDS = {
  door: { h: WALL_H * 0.92, hp: 45, full: true, colors: WOOD, sound: 'doorHit' },
  wall: { h: WALL_H, hp: 120, full: true, colors: [0x6a4a3a, 0x7a5644, 0x5c4034, 0x84604c], sound: 'wall' },
  cover: { h: 0.62, hp: 1, full: false, colors: [0x8a7a55, 0x7c6c4a, 0x948460, 0x6e6044], sound: 'wall' },
};
export const COL_GEO = new THREE.BoxGeometry(COL, 1, COL);
export const cellMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
export const ZERO_MTX = new THREE.Matrix4().makeScale(0, 0, 0);
export const COVER_BLOCK = 0.75;        // 目標貼著半掩體時，子彈被擋下的機率
export const COVER_BLOCK_FIRING = 0.2;  // 貼著但正在開火（探出身子）時的機率
export const FIRING_WINDOW = 0.3;       // 開槍後幾秒內算「正在開火」
export const SWITCH_TIME = 0.9;
export const wallMat = new THREE.MeshLambertMaterial({ vertexColors: true });
export const doorMat = new THREE.MeshLambertMaterial({ color: 0x40242a, emissive: 0xff2040, emissiveIntensity: 0.35 });
export const exitMat = addMat(0x30ff90, 0.55);

// 關卡池：test = 編輯器正在測試的那一關
let testLevel = null;
export function setTestLevel(def) { testLevel = def; }
export const MODE_NAMES = { breach: '破門', dark: '黑暗', custom: '自訂', test: '測試' };
export const levelDefs = mode => ({
  arena: ARENA_ROOMS.map(map => ({ map, aware: true })),
  breach: BREACH_LEVELS,
  dark: DARK_LEVELS.map(d => ({ dark: true, ...d })),
  custom: CUSTOM_LEVELS,
  test: [testLevel],
})[mode];
export function levelLabel() {
  if (!level) return '';
  if (level.mode === 'arena') return `ROOM ${level.index + 1}`;
  if (level.mode === 'test') return `測試　${level.def.name ?? ''}`;
  const defs = levelDefs(level.mode);
  return `${MODE_NAMES[level.mode]} ${level.index + 1}/${defs.length}　${defs[level.index].name}`;
}
// 地圖可以是一整串字（rooms.js）或一行一個字串的陣列（編輯器的 JSON）
export const mapRows = def => (Array.isArray(def.map) ? def.map : def.map.split('\n')).map(s => s.trim()).filter(Boolean);

// 吊燈：燈具 + 不投影的點光源；l = 會閃；可以被子彈打掉，也可以接在開關上
export const LAMP_R = 3.3, LAMP_Y = 2.0;
// 燈泡在高處，畫面上看起來的位置 = 子彈高度往後退一點；打燈泡用這個位置判定
export const LAMP_HIT_DZ = -(LAMP_Y - GUN_Y) / Math.tan(CAM_PITCH);
export const lampMat = addMat(0xffe2a8, 0.95);
export const deadBulbMat = new THREE.MeshLambertMaterial({ color: 0x3a3a40 });
export function addLamp(x, z, flicker, group = null, powered = true) {
  const light = new THREE.PointLight(0xffd9a0, 0, LAMP_R + 2, 1.3);
  light.position.set(x, LAMP_Y, z);
  const bulb = new THREE.Mesh(FLASH_GEO, lampMat);
  bulb.position.set(x, LAMP_Y, z);
  bulb.scale.setScalar(0.9);
  const dead = new THREE.Mesh(FLASH_GEO, deadBulbMat);
  dead.position.copy(bulb.position);
  dead.scale.setScalar(0.7);
  level.group.add(light, bulb, dead);
  level.lamps.push({ x, z, light, bulb, dead, flicker, group, powered, broken: false, on: 1, t: 0, lit: false });
}
export function updateLamps(dt) {
  for (const l of level.lamps) {
    if (l.flicker) {
      l.t -= dt;
      if (l.t <= 0) { l.on = l.on ? 0 : 1; l.t = l.on ? 0.3 + Math.random() * 2.2 : 0.04 + Math.random() * 0.25; }
    }
    l.lit = !!l.on && l.powered && !l.broken;
    l.light.intensity = l.lit ? 9 : 0;
    l.bulb.visible = l.lit;
    l.dead.visible = !l.lit && !l.broken;
  }
}
export function breakLamp(l) {
  l.broken = true;
  sparks(l.x, LAMP_Y, l.z, 0xffe2a8, 12);
  burst(l.x, LAMP_Y, l.z, [0xd8dce4, 0x8a8f98], 4, 2);
  sfx.glass();
}

// 鐵捲門：開關控制開 / 關；關的時候殭屍會一直敲，敲爛就關不起來了
export function addGate(c, r, x, z, group, open) {
  const horiz = level.grid[r][c - 1] === '#' || level.grid[r][c + 1] === '#';
  const m = new THREE.Mesh(gateGeo, wallMat);
  m.scale.set(horiz ? 1 : 0.4, 1, horiz ? 0.4 : 1);
  m.position.set(x, open ? -WALL_H * 0.42 : WALL_H * 0.475, z);
  m.castShadow = m.receiveShadow = true;
  level.group.add(m);
  level.doors.set(c + r * W, { c, r, x, z, mesh: m, hp: 260, open, want: open, kind: 'gate', group, broken: false, colors: GATE_COLORS });
}
export function updateGates(dt) {
  for (const d of level.doors.values()) {
    if (d.kind !== 'gate' || d.broken) continue;
    if (d.want !== d.open) {
      // 門下有人（玩家或殭屍）就等他離開再關
      const minX = d.c - W / 2, minZ = d.r - H / 2;
      const inside = o => o.x > minX - o.r && o.x < minX + 1 + o.r && o.z > minZ - o.r && o.z < minZ + 1 + o.r;
      if (d.want || !((player.alive && inside(player)) || enemies.some(inside))) {
        d.open = d.want;
        sfx.gate();
        buildFlow();
      }
    }
    const ty = d.open ? -WALL_H * 0.42 : WALL_H * 0.475;
    d.mesh.position.y += (ty - d.mesh.position.y) * (1 - Math.exp(-10 * dt));
  }
}

// 殭屍推門：門擋在前面就一直敲，敲爛為止
export function bangDoor(e, dx, dz, dps, dt) {
  const c = tileC(e.x + dx * (e.r + 0.25)), r = tileR(e.z + dz * (e.r + 0.25));
  const cell = cellAt(c, r);
  if (cell && cell.kind === 'door') {
    const n = nearestColumn(cell, e.x, e.z);
    if (!n || n.d > e.r + 0.15) return;
    cell.hp[n.k] -= dps * 2.5 * dt;
    cell.bangT = (cell.bangT ?? 0) - dt;
    if (cell.bangT <= 0) { cell.bangT = 0.3 + Math.random() * 0.3; sfx.doorHit(); burst(e.x + n.dx, 0.8, e.z + n.dz, WOOD, 1, 2); }
    if (cell.hp[n.k] <= 0) destroyColumn(cell, n.k, dx, dz);
    return;
  }
  const d = doorAt(c, r);
  if (!d || d.open) return;
  d.hp -= dps * dt;
  d.bangT = (d.bangT ?? 0) - dt;
  if (d.bangT <= 0) {
    d.bangT = 0.3 + Math.random() * 0.3;
    sfx.doorHit();
    burst(d.x - dx * 0.4, 0.8, d.z - dz * 0.4, d.colors, 1, 2);
  }
  if (d.hp <= 0) destroyDoor(d, dx, dz);
}
export function destroyDoor(d, dx, dz) {
  d.broken = true;
  breachDoor(d, false, dx, dz);
}

// 建一格可破壞的格子；門只有中間兩排柱子（順著牆的方向）
export function addCell(c, r, kind) {
  const kd = CELL_KINDS[kind];
  const horiz = level.grid[r][c - 1] === '#' || level.grid[r][c + 1] === '#';
  const has = kind !== 'door' ? () => true : horiz ? (i, j) => j === 1 || j === 2 : (i, j) => i === 1 || i === 2;
  const cell = {
    id: level.cells.size, c, r, kind, full: kd.full, passable: false,
    hp: new Float32Array(SUB * SUB), inst: new Int32Array(SUB * SUB).fill(-1),
  };
  for (let j = 0; j < SUB; j++) for (let i = 0; i < SUB; i++) {
    if (!has(i, j)) continue;
    const k = i + j * SUB;
    cell.hp[k] = kd.hp;
    cell.inst[k] = level.cellCols.length;
    level.cellCols.push({ cell, k, color: kd.colors[Math.floor(Math.random() * kd.colors.length)] });
  }
  level.cells.set(c + r * W, cell);
}
export function buildCellMesh() {
  const cols = level.cellCols;
  if (!cols.length) return;
  const mesh = new THREE.InstancedMesh(COL_GEO, cellMat, cols.length);
  const m = new THREE.Matrix4(), col = new THREE.Color();
  cols.forEach(({ cell, k, color }, n) => {
    const p = colPos(cell, k), h = CELL_KINDS[cell.kind].h;
    mesh.setMatrixAt(n, m.makeScale(1, h, 1).setPosition(p.x, h / 2, p.z));
    mesh.setColorAt(n, col.setHex(color));
  });
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  level.group.add(mesh);
  level.cellMesh = mesh;
}

// 打出夠寬（3 根柱子）的通道才算走得過
export function updatePassable(cell) {
  const empty = (i, j) => cell.hp[i + j * SUB] <= 0;
  const lineI = i => [0, 1, 2, 3].every(j => empty(i, j));
  const lineJ = j => [0, 1, 2, 3].every(i => empty(i, j));
  let pass = false;
  for (let a = 0; a + 2 < SUB && !pass; a++) {
    pass = (lineI(a) && lineI(a + 1) && lineI(a + 2)) || (lineJ(a) && lineJ(a + 1) && lineJ(a + 2));
  }
  if (pass !== cell.passable) { cell.passable = pass; buildFlow(); }
}
export function destroyColumn(cell, k, dx = 0, dz = 0, n = 3) {
  if (cell.inst[k] < 0) return;
  cell.hp[k] = 0;
  level.cellMesh.setMatrixAt(cell.inst[k], ZERO_MTX);
  level.cellMesh.instanceMatrix.needsUpdate = true;
  cell.inst[k] = -1;
  const p = colPos(cell, k), kd = CELL_KINDS[cell.kind];
  burst(p.x, kd.h * 0.5, p.z, kd.colors, n, 2.5, dx * 3, dz * 3);
  updatePassable(cell);
}
// 子彈打中柱子
export function hitColumn(cell, k, dmg, dx, dz, hx, hz) {
  const kd = CELL_KINDS[cell.kind];
  cell.hp[k] -= dmg;
  sparks(hx, Math.min(GUN_Y, kd.h * 0.8), hz, 0xffd090, 3, -dx, -dz);
  sfx[kd.sound]();
  if (cell.hp[k] <= 0) destroyColumn(cell, k, dx, dz);
  else burst(hx, Math.min(GUN_Y, kd.h * 0.8), hz, kd.colors, 1, 2);
}
// 半掩體：子彈從上面飛過去；目標正貼在後面時才有機會擋下
// 擋下的那發會打掉彈著點的柱子；那裡已經沒柱子了，子彈就照樣飛過去
// 每顆子彈對每格掩體只擲一次；決定擋下就停在路徑上第一根還在的柱子
export function coverStops(b, cell) {
  if (b.coverCell !== cell.id) {
    b.coverCell = cell.id;
    const cx = toWorldX(cell.c), cz = toWorldZ(cell.r);
    const targets = b.owner === 'p' ? enemies : (player.alive ? [player] : []);
    const hug = targets.find(t => {
      const tx = t.x - cx, tz = t.z - cz, along = tx * b.dx + tz * b.dz;
      return along > 0 && along < 1.3 && Math.abs(tx * b.dz - tz * b.dx) < t.r + 0.4;
    });
    // 貼著掩體但正在開火 = 探出身子，大多擋不到
    const chance = hug && G.now - (hug.lastShot ?? -9) < FIRING_WINDOW ? COVER_BLOCK_FIRING : COVER_BLOCK;
    // 開槍的人自己靠著掩體往外打，不受影響
    b.coverBlock = !!hug && b.traveled > 0.9 && Math.random() < chance;
  }
  return b.coverBlock;
}
// 整格打爛（踹門）
export function smashCell(cell, kicked, dx = 0, dz = 0) {
  for (let k = 0; k < SUB * SUB; k++) if (cell.hp[k] > 0) destroyColumn(cell, k, dx * 2, dz * 2, 2);
  const x = toWorldX(cell.c), z = toWorldZ(cell.r);
  sparks(x, 0.9, z, 0xffd090, 8);
  sfx.breach();
  addTrauma(kicked ? 0.6 : 0.4);
  alertNoise(9);
  if (kicked) {
    G.slowMo = Math.max(G.slowMo, 1.3);
    showToast('BREACH!', 'breach');
    navigator.vibrate?.(40);
  }
}
// 巨型殭屍撞擊：撞點附近的柱子全部打爛
export function smashArea(x, z, rad, dx, dz) {
  let n = 0;
  for (let r = tileR(z) - 1; r <= tileR(z) + 1; r++) for (let c = tileC(x) - 1; c <= tileC(x) + 1; c++) {
    const cell = cellAt(c, r);
    if (!cell) continue;
    for (let k = 0; k < SUB * SUB; k++) {
      if (cell.hp[k] <= 0) continue;
      const p = colPos(cell, k);
      if (Math.hypot(p.x - x, p.z - z) < rad) { destroyColumn(cell, k, dx * 2, dz * 2, 2); n++; }
    }
  }
  if (n) { sfx.breach(); addTrauma(0.5); alertNoise(8); }
  return n;
}

// 開關：站上去一下就切換；要離開再站上去才會再切一次
export function addSwitch(x, z) {
  const idx = level.switches.length;
  const mat = new THREE.MeshBasicMaterial({ color: 0xff5030, toneMapped: false });
  const base = new THREE.Mesh(UNIT_BOX, new THREE.MeshLambertMaterial({ color: 0x2a2e36 }));
  base.scale.set(0.62, 0.1, 0.62);
  base.position.set(x, 0.05, z);
  const lamp = new THREE.Mesh(UNIT_BOX, mat);
  lamp.scale.set(0.34, 0.06, 0.34);
  lamp.position.set(x, 0.12, z);
  level.group.add(base, lamp);
  level.switches.push({ x, z, mat, lamp, groups: level.def.switches?.[idx] ?? [], on: false, prog: 0, latched: false, bar: makeBar(0x40ff90) });
}
export function updateSwitches(dt) {
  for (const s of level.switches) {
    const near = player.alive && Math.abs(player.x - s.x) < 0.5 && Math.abs(player.z - s.z) < 0.5;
    if (near && !s.latched) {
      s.prog += dt / SWITCH_TIME;
      if (s.prog >= 1) { s.prog = 0; s.latched = true; flipSwitch(s); }
    } else if (!near) { s.latched = false; s.prog = Math.max(0, s.prog - dt * 3); }
    if (s.prog > 0) setBar(s.bar, s.x, 1.3, s.z, s.prog); else s.bar.g.visible = false;
    s.mat.color.setHex(s.on ? 0x40ff90 : 0xff5030);
    s.lamp.scale.y = 0.06 * (1 + 0.5 * Math.sin(G.now * 5));
  }
}
export function flipSwitch(s) {
  s.on = !s.on;
  sfx.switchOn();
  for (const g of s.groups) {
    for (const d of level.doors.values()) if (d.group === g) d.want = !d.want;
    for (const l of level.lamps) if (l.group === g) l.powered = !l.powered;
  }
}

// 通風口：持續冒出殭屍（撐住、撤離時）
export function startSpawner(cfg) {
  level.spawner = { left: cfg.count ?? Infinity, every: cfg.every ?? 1.8, brute: cfg.brute ?? 0, max: cfg.max ?? 16, t: 0.5 };
}
export function updateSpawner(dt) {
  const sp = level.spawner;
  if (!sp || sp.left <= 0 || !level.vents.length) return;
  sp.t -= dt;
  if (sp.t > 0 || enemies.length >= sp.max) return;
  sp.t = sp.every * (0.7 + Math.random() * 0.6);
  // 優先挑離玩家遠一點的通風口
  const far = level.vents.filter(v => Math.hypot(v.sx - player.x, v.sz - player.z) > 4.5);
  const v = (far.length ? far : level.vents)[Math.floor(Math.random() * (far.length || level.vents.length))];
  const type = Math.random() < sp.brute ? 'G' : 'Z';
  spawnEnemy(type, v.sx, v.sz, 0, true);
  const e = enemies[enemies.length - 1];
  e.state = 'chase'; e.t = 0;
  burst(v.x, 0.9, v.z, [0x2c3140, 0x15171c], 3, 2);
  if (G.now - G.lastGroan > 0.6) { G.lastGroan = G.now; type === 'G' ? sfx.roar() : sfx.groan(); }
  sp.left--;
}

// 人質：雙手舉高站著；只有玩家的子彈會打到他
export function addHostage(x, z) {
  const man = makeBlockMan({ shirt: 0xe8e4da, pants: 0x5a5a66, skin: 0xf0c9a0 });
  man.root.position.set(x, 0, z);
  man.armL.rotation.x = man.armR.rotation.x = -2.9;
  level.group.add(man.root);
  level.hostage = { man, x, z, r: 0.32, alive: true, saved: false };
}
export function killHostage(dx, dz) {
  const h = level.hostage;
  h.alive = false;
  voxelBurst(h.man.root, 60, 4, dx * 4, dz * 4);
  level.group.remove(h.man.root);
  sparks(h.x, 1, h.z, 0xff3030, 16);
  sfx.die();
  G.slowMo = 1.1;
  G.state = 'failed';
  player.laser.g.visible = player.guide.g.visible = false;
  setTimeout(() => {
    if (G.state !== 'failed') return;
    showPanel('任務失敗', `${levelLabel()}<br>人質被你打中了`, [
      { label: '重來這關', primary: true, run: retryLevel },
      { label: leaveLabel(), run: leaveLevel },
    ]);
  }, 1100);
}

// 撤離物資：發光的箱子，拿到後出口打開、通風口開始冒殭屍
export const itemMat = addMat(0x40e0ff, 0.9);
export function addItem(x, z) {
  const g = new THREE.Group();
  const box = new THREE.Mesh(UNIT_BOX, new THREE.MeshLambertMaterial({ color: 0x2a3a48, emissive: 0x104050 }));
  box.scale.set(0.5, 0.32, 0.36);
  const glow = new THREE.Mesh(UNIT_BOX, itemMat);
  glow.scale.set(0.56, 0.06, 0.42);
  glow.position.y = 0.17;
  g.add(box, glow);
  g.position.set(x, 0.35, z);
  level.group.add(g);
  level.item = { x, z, g, taken: false };
}

// ---------- 關卡目標 ----------
// clear 清光敵人、activate 開關全部打開、hold 撐住幾秒、extract 拿到物資撤離、rescue 清光敵人後碰到人質
export function updateObjectives(dt) {
  const L = level, goal = L.goal;
  if (G.state !== 'play') return;
  if (L.item && !L.item.taken) {
    L.item.g.position.y = 0.35 + Math.sin(G.now * 3) * 0.06;
    L.item.g.rotation.y += dt * 1.5;
    if (Math.hypot(player.x - L.item.x, player.z - L.item.z) < 0.6) {
      L.item.taken = true;
      L.group.remove(L.item.g);
      sparks(L.item.x, 0.6, L.item.z, 0x40e0ff, 14);
      sfx.reloadDone();
      if (L.def.wave) startSpawner(L.def.wave);
      openExit('撤離！');
    }
  }
  const h = L.hostage;
  if (h?.alive) {
    // 玩家不能穿過人質
    const dx = player.x - h.x, dz = player.z - h.z, d = Math.hypot(dx, dz), min = player.r + h.r;
    if (d < min && d > 1e-4) { player.x = h.x + dx / d * min; player.z = h.z + dz / d * min; }
    if (!h.saved && enemies.length === 0 && d < min + 0.35) {
      h.saved = true;
      h.man.armL.rotation.x = h.man.armR.rotation.x = 0;
      sfx.reloadDone();
      openExit('人質救出');
    }
  }
  if (L.doorOpen) return;
  if (goal === 'clear' && enemies.length === 0) openExit();
  else if (goal === 'activate' && L.switches.length && L.switches.every(s => s.on)) openExit('全部啟動');
  else if (goal === 'hold') {
    L.holdT -= dt;
    if (L.holdT <= 0) { L.holdT = 0; if (L.spawner) L.spawner.left = 0; openExit('撐住了！'); }
  }
}
export function goalText() {
  const L = level;
  if (!L || G.state === 'menu') return '';
  if (L.doorOpen) return L.goal === 'hold' || L.goal === 'extract' ? '快跑到出口' : '前往出口';
  switch (L.goal) {
    case 'activate': return `打開開關 ${L.switches.filter(s => s.on).length}/${L.switches.length}`;
    case 'hold': return `撐住 ${Math.ceil(L.holdT)} 秒`;
    case 'extract': return '找到物資';
    case 'rescue': return enemies.length ? `清除敵人・剩 ${enemies.length}` : '去碰人質';
    default: return `清除敵人・剩 ${enemies.length}`;
  }
}

export function loadLevel(mode, index) {
  clearEntities();
  if (level) { scene.remove(level.group); for (const s of level.switches) freeBar(s.bar); }
  const defs = levelDefs(mode);
  const def = defs[index % defs.length];
  const rows = mapRows(def), w = Math.max(...rows.map(r => r.length));
  const grid = rows.map(s => [...s.padEnd(w, '#')]);
  H = grid.length; W = w;
  flow = new Int16Array(W * H); zflow = new Int16Array(W * H);
  level = {
    group: new THREE.Group(), grid, doorOpen: false, doorMeshes: [], exitMeshes: [],
    doors: new Map(), mode, index, dark: !!def.dark, lamps: [], def,
    switches: [], vents: [], cells: new Map(), cellCols: [], cellMesh: null, spawner: null, hostage: null, item: null,
    goal: def.goal ?? 'clear', holdT: def.hold ?? 0,
  };
  setLighting(level.dark);
  scene.add(level.group);

  floorTex.repeat.set(W, H);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshLambertMaterial({ map: floorTex }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  level.group.add(floor);

  const walls = [];
  const loop = mode === 'arena' ? Math.floor(index / defs.length) : 0;
  const aware = !!def.aware;    // 清房模式敵人一開始就知道你在哪
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const ch = grid[r][c] || '#';
    const x = toWorldX(c), z = toWorldZ(r);
    if (ch >= '1' && ch <= '9') {
      // 數字 = 接在開關上的東西，種類寫在關卡的 links
      const kind = def.links?.[ch] ?? 'gate';
      if (kind.startsWith('gate')) { grid[r][c] = '='; addGate(c, r, x, z, ch, kind === 'gateOpen'); }
      else { grid[r][c] = '.'; addLamp(x, z, false, ch, kind === 'lampOn'); }
      continue;
    }
    if (ch === '#') walls.push([x, z]);
    else if (ch === 'V') {
      const m = new THREE.Mesh(ventGeo, wallMat);
      m.position.set(x, WALL_H / 2, z);
      m.castShadow = m.receiveShadow = true;
      level.group.add(m);
      // 殭屍從相鄰的地板格冒出來
      const [dc, dr] = DIRS4.find(([dc, dr]) => '.PZGKLlX'.includes(grid[r + dr]?.[c + dc] ?? '#')) ?? [0, 0];
      level.vents.push({ x, z, sx: toWorldX(c + dc), sz: toWorldZ(r + dr) });
    }
    else if (ch === 'W') addCell(c, r, 'wall');
    else if (ch === 'h') addCell(c, r, 'cover');
    else if (ch === 'K') addSwitch(x, z);
    else if (ch === 'X') addItem(x, z);
    else if (ch === 'Q') addHostage(x, z);
    else if (ch === 'D') {
      const m = new THREE.Mesh(wallGeo, doorMat);
      m.position.set(x, WALL_H / 2, z);
      m.castShadow = m.receiveShadow = true;
      level.group.add(m);
      level.doorMeshes.push(m);
    } else if (ch === 'B') addCell(c, r, 'door');
    else if (ch === 'P') { player.x = x; player.z = z; }
    else if ('RSHZG'.includes(ch)) spawnEnemy(ch, x, z, loop, aware);
    else if (ch === 'L' || ch === 'l') addLamp(x, z, ch === 'l');
  }
  buildCellMesh();
  const inst = new THREE.InstancedMesh(wallGeo, wallMat, walls.length);
  const mtx = new THREE.Matrix4();
  walls.forEach(([x, z], i) => inst.setMatrixAt(i, mtx.makeTranslation(x, WALL_H / 2, z)));
  inst.castShadow = inst.receiveShadow = true;
  level.group.add(inst);

  resetPlayer();
  buildFlow();
  if (level.goal === 'hold' && def.wave) startSpawner(def.wave);
  updateLamps(0);
  G.slowMo = 0; G.hitStop = 0;
  G.state = 'play';
  camTarget.set(player.x, 0, player.z - 1);
  document.getElementById('room').textContent = levelLabel();
  updateHud();
}

export function openExit(text = 'CLEAR') {
  level.doorOpen = true;
  for (const m of level.doorMeshes) {
    level.group.remove(m);
    const e = new THREE.Mesh(new THREE.PlaneGeometry(0.96, 0.96), exitMat);
    e.rotation.x = -Math.PI / 2;
    e.position.set(m.position.x, 0.02, m.position.z);
    level.group.add(e);
    level.exitMeshes.push(e);
    burst(m.position.x, 0.7, m.position.z, [0x40242a, 0xff2040], 6, 4);
  }
  sfx.door();
  showToast(text, 'clear');
  buildFlow();
}

// 破門：踹開（慢動作）或打爛（沒有慢動作）
export function breachDoor(d, kicked, dx = 0, dz = 0) {
  if (d.open) return;
  d.open = true;
  level.group.remove(d.mesh);
  burst(d.x, 0.7, d.z, d.colors, kicked ? 16 : 10, 5, dx * 7, dz * 7);
  sparks(d.x, 0.9, d.z, 0xffd090, 8);
  sfx.breach();
  addTrauma(kicked ? 0.6 : 0.4);
  buildFlow();
  alertNoise(9);
  if (kicked) {
    G.slowMo = Math.max(G.slowMo, 1.3);
    showToast('BREACH!', 'breach');
    navigator.vibrate?.(40);
  }
}

import * as THREE from 'three';
import { Input } from './input.js';
import { sfx, unlockAudio } from './audio.js';
import { ARENA_ROOMS, BREACH_LEVELS, DARK_LEVELS } from './rooms.js';
import { makeBlockMan, animateMan, setFlash, setHand, addGlowEyes } from './models.js';
import { computeStats, buildWeapon, swapTime, WEAPON_PAL } from './weapons.js';
import { buildVoxelMesh, sampleVoxels } from './voxel.js';
import { loadLoadout, openLoadout } from './loadout.js';

const DEG = Math.PI / 180;

let W = 13, H = 19;          // 依地圖改變
const MAX_HITS = 3;
const GUN_Y = 0.95;

// ---------- 基本場景 ----------
const container = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d12);

const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 120);
const CAM_PITCH = THREE.MathUtils.degToRad(62);
let camDist = 20;
function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  // 直式：至少看到 ~9.5 格寬；橫式：至少看到 ~16 格高
  camDist = Math.max(4.75 / (t * camera.aspect), 8 / t);
}
addEventListener('resize', resize);
resize();

const hemi = new THREE.HemisphereLight(0xc8d8ff, 0x2a2018, 1.4);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2e0, 2.4);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 1, far: 60 });
sun.shadow.bias = -0.0008;
scene.add(sun, sun.target);

// 黑暗模式的光：手電筒（跟著槍口實際方向）、身邊一小圈、開槍的火光
const FLASH_RANGE = 11, FLASH_ANGLE = 0.42, BODY_LIGHT_R = 1.9;
const flashlight = new THREE.SpotLight(0xfff1d6, 0, FLASH_RANGE + 2, FLASH_ANGLE, 0.45, 1);
flashlight.castShadow = true;
flashlight.shadow.mapSize.set(1024, 1024);
flashlight.shadow.camera.near = 0.1;
flashlight.shadow.bias = -0.0006;
const bodyLight = new THREE.PointLight(0x9fb4e0, 0, 3, 1);
const muzzleLight = new THREE.PointLight(0xffb050, 0, 7, 1.2);
scene.add(flashlight, flashlight.target, bodyLight, muzzleLight);
let muzzleGlow = 0;   // 開槍後短暫照亮四周的剩餘時間

function setLighting(dark) {
  hemi.intensity = dark ? 0.09 : 1.4;
  sun.visible = !dark;
  flashlight.visible = bodyLight.visible = muzzleLight.visible = dark;
  scene.background.setHex(dark ? 0x030406 : 0x0b0d12);
}

// ---------- 共用幾何與材質 ----------
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const DEBRIS_GEO = new THREE.BoxGeometry(0.15, 0.15, 0.15);
const FLASH_GEO = new THREE.IcosahedronGeometry(0.2, 0);
const addMat = (color, opacity = 1) => new THREE.MeshBasicMaterial({
  color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
});
const TRACER = {
  player: { core: addMat(0xfff6d0), glow: addMat(0xffa020, 0.55), maxLen: 1.7 },
  enemy: { core: addMat(0xffe0e0), glow: addMat(0xff2a2a, 0.6), maxLen: 1.1 },
  heavy: { core: addMat(0xf0e0ff), glow: addMat(0xb050ff, 0.6), maxLen: 0.9 },
};
const debrisMats = new Map();
const debrisMat = c => {
  if (!debrisMats.has(c)) debrisMats.set(c, new THREE.MeshLambertMaterial({ color: c }));
  return debrisMats.get(c);
};
const WOOD = [0x7a5230, 0x5a3a20, 0x9a6a40];

// ---------- 地圖與碰撞 ----------
let level = null;   // { group, grid, doorOpen, doorMeshes, exitMeshes, doors, mode, index }
const toWorldX = c => c - W / 2 + 0.5;
const toWorldZ = r => r - H / 2 + 0.5;
const tileC = x => Math.floor(x + W / 2);
const tileR = z => Math.floor(z + H / 2);

function isWallTile(c, r) {
  if (c < 0 || r < 0 || c >= W || r >= H) return true;
  const ch = level.grid[r][c];
  if (ch === '#' || ch === 'V' || ch === 'W') return true;
  if (ch === 'D') return !level.doorOpen;
  if (ch === 'B' || ch === '=') return !level.doors.get(c + r * W).open;
  return false;
}
const doorAt = (c, r) => (c >= 0 && r >= 0 && c < W && r < H) ? level.doors.get(c + r * W) : undefined;
const wallAt = (x, z) => isWallTile(tileC(x), tileR(z));

// 圓形 vs 方格牆，推出去
function collide(o, rad) {
  const c0 = tileC(o.x), r0 = tileR(o.z);
  for (let r = r0 - 1; r <= r0 + 1; r++) {
    for (let c = c0 - 1; c <= c0 + 1; c++) {
      if (!isWallTile(c, r)) continue;
      const minX = c - W / 2, minZ = r - H / 2;
      const px = Math.max(minX, Math.min(o.x, minX + 1));
      const pz = Math.max(minZ, Math.min(o.z, minZ + 1));
      const dx = o.x - px, dz = o.z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 < rad * rad) {
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2), k = (rad - d) / d;
          o.x += dx * k; o.z += dz * k;
        } else {
          // 中心卡進牆裡：往最近的邊推
          const cx = minX + 0.5, cz = minZ + 0.5;
          if (Math.abs(o.x - cx) > Math.abs(o.z - cz)) o.x = o.x > cx ? minX + 1 + rad : minX - rad;
          else o.z = o.z > cz ? minZ + 1 + rad : minZ - rad;
        }
      }
    }
  }
}

// 方格 DDA 射線，回傳撞牆距離
function castRay(ox, oz, dx, dz, max) {
  const x = ox + W / 2, z = oz + H / 2;
  let cx = Math.floor(x), cz = Math.floor(z);
  if (isWallTile(cx, cz)) return 0;
  const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
  const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tmx = dx > 0 ? (cx + 1 - x) * tdx : dx < 0 ? (x - cx) * tdx : Infinity;
  let tmz = dz > 0 ? (cz + 1 - z) * tdz : dz < 0 ? (z - cz) * tdz : Infinity;
  let t = 0;
  while (t < max) {
    if (tmx < tmz) { cx += sx; t = tmx; tmx += tdx; } else { cz += sz; t = tmz; tmz += tdz; }
    if (isWallTile(cx, cz)) return Math.min(t, max);
  }
  return max;
}

function rayCircle(ox, oz, dx, dz, cx, cz, r) {
  const fx = ox - cx, fz = oz - cz;
  const b = fx * dx + fz * dz;
  const c = fx * fx + fz * fz - r * r;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : (c < 0 ? 0 : Infinity);
}

function hasLOS(ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, d = Math.hypot(dx, dz);
  if (d < 1e-4) return true;
  return castRay(ax, az, dx / d, dz / d, d) >= d - 0.01;
}

const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// 從玩家所在格做 BFS，敵人看不到玩家時沿著它走；也拿來算槍聲傳多遠（關著的門會擋）
// zflow 給殭屍用：關著的門也算走得通，殭屍會走到門前一直敲
let flow = new Int16Array(W * H), zflow = new Int16Array(W * H), flowTimer = 0;
function bfs(field, pass) {
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
function buildFlow() {
  bfs(flow, (c, r) => !isWallTile(c, r));
  bfs(zflow, (c, r) => !isWallTile(c, r) || doorAt(c, r)?.open === false);
}
const fieldAt = (field, c, r) => (c >= 0 && c < W && r >= 0 && r < H) ? field[c + r * W] : -1;
const flowAt = (x, z) => {
  const c = tileC(x), r = tileR(z);
  return (c >= 0 && c < W && r >= 0 && r < H) ? flow[c + r * W] : -1;
};
function navDir(e, field = flow) {
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
function findCoverPath(e) {
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
function makeFloorTexture() {
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
const floorTex = makeFloorTexture();

// 牆：頂面亮、側面暗（頂點顏色）
const WALL_H = 1.4;
function shadedBox(h, sideHex, topHex) {
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
const wallGeo = shadedBox(WALL_H, 0x3a4256, 0x8a96b0);
const breachGeo = shadedBox(WALL_H * 0.92, 0x5a3a20, 0xa47a4a);
const gateGeo = shadedBox(WALL_H * 0.95, 0x4c5462, 0xc8a438);    // 鐵捲門：頂面黃色
const crackGeo = shadedBox(WALL_H, 0x4a4238, 0x8a7c66);           // 有裂痕的牆：巨型殭屍撞得破
const ventGeo = shadedBox(WALL_H, 0x2c3140, 0x15171c);            // 通風口：殭屍從這裡爬出來
const GATE_COLORS = [0x4c5462, 0xc8a438, 0x2a2e36];
const WALL_COLORS = [0x4a4238, 0x8a7c66, 0x3a4256];
const SWITCH_TIME = 0.9;
const wallMat = new THREE.MeshLambertMaterial({ vertexColors: true });
const doorMat = new THREE.MeshLambertMaterial({ color: 0x40242a, emissive: 0xff2040, emissiveIntensity: 0.35 });
const exitMat = addMat(0x30ff90, 0.55);

const levelDefs = mode => mode === 'arena' ? ARENA_ROOMS.map(map => ({ map })) : mode === 'dark' ? DARK_LEVELS : BREACH_LEVELS;
function levelLabel() {
  if (!level) return '';
  if (level.mode === 'arena') return `ROOM ${level.index + 1}`;
  const defs = levelDefs(level.mode);
  return `${level.mode === 'dark' ? '黑暗' : '破門'} ${level.index + 1}/${defs.length}　${defs[level.index].name}`;
}

// 吊燈：燈具 + 不投影的點光源；l = 會閃；可以被子彈打掉，也可以接在開關上
const LAMP_R = 3.3, LAMP_Y = 2.0;
// 燈泡在高處，畫面上看起來的位置 = 子彈高度往後退一點；打燈泡用這個位置判定
const LAMP_HIT_DZ = -(LAMP_Y - GUN_Y) / Math.tan(CAM_PITCH);
const lampMat = addMat(0xffe2a8, 0.95);
const deadBulbMat = new THREE.MeshLambertMaterial({ color: 0x3a3a40 });
function addLamp(x, z, flicker, group = null, powered = true) {
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
function updateLamps(dt) {
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
function breakLamp(l) {
  l.broken = true;
  sparks(l.x, LAMP_Y, l.z, 0xffe2a8, 12);
  burst(l.x, LAMP_Y, l.z, [0xd8dce4, 0x8a8f98], 4, 2);
  sfx.glass();
}

// 鐵捲門：開關控制開 / 關；關的時候殭屍會一直敲，敲爛就關不起來了
function addGate(c, r, x, z, group, open) {
  const horiz = level.grid[r][c - 1] === '#' || level.grid[r][c + 1] === '#';
  const m = new THREE.Mesh(gateGeo, wallMat);
  m.scale.set(horiz ? 1 : 0.4, 1, horiz ? 0.4 : 1);
  m.position.set(x, open ? -WALL_H * 0.42 : WALL_H * 0.475, z);
  m.castShadow = m.receiveShadow = true;
  level.group.add(m);
  level.doors.set(c + r * W, { c, r, x, z, mesh: m, hp: 260, open, want: open, kind: 'gate', group, broken: false, colors: GATE_COLORS });
}
function updateGates(dt) {
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
function bangDoor(e, dx, dz, dps, dt) {
  const d = doorAt(tileC(e.x + dx * (e.r + 0.25)), tileR(e.z + dz * (e.r + 0.25)));
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
function destroyDoor(d, dx, dz) {
  d.broken = true;
  breachDoor(d, false, dx, dz);
}

// 有裂痕的牆被巨型殭屍撞破
function breakWall(c, r, dx, dz) {
  level.grid[r][c] = '.';
  const m = level.cracks.get(c + r * W);
  if (m) level.group.remove(m);
  const x = toWorldX(c), z = toWorldZ(r);
  burst(x, 0.7, z, WALL_COLORS, 16, 5, dx * 6, dz * 6);
  sfx.breach();
  addTrauma(0.5);
  buildFlow();
  alertNoise(8);
}

// 開關：站上去一下就切換；要離開再站上去才會再切一次
function addSwitch(x, z) {
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
function updateSwitches(dt) {
  for (const s of level.switches) {
    const near = player.alive && Math.abs(player.x - s.x) < 0.5 && Math.abs(player.z - s.z) < 0.5;
    if (near && !s.latched) {
      s.prog += dt / SWITCH_TIME;
      if (s.prog >= 1) { s.prog = 0; s.latched = true; flipSwitch(s); }
    } else if (!near) { s.latched = false; s.prog = Math.max(0, s.prog - dt * 3); }
    if (s.prog > 0) setBar(s.bar, s.x, 1.3, s.z, s.prog); else s.bar.g.visible = false;
    s.mat.color.setHex(s.on ? 0x40ff90 : 0xff5030);
    s.lamp.scale.y = 0.06 * (1 + 0.5 * Math.sin(now * 5));
  }
}
function flipSwitch(s) {
  s.on = !s.on;
  sfx.switchOn();
  for (const g of s.groups) {
    for (const d of level.doors.values()) if (d.group === g) d.want = !d.want;
    for (const l of level.lamps) if (l.group === g) l.powered = !l.powered;
  }
}

// 通風口：持續冒出殭屍（撐住、撤離時）
function startSpawner(cfg) {
  level.spawner = { left: cfg.count ?? Infinity, every: cfg.every ?? 1.8, brute: cfg.brute ?? 0, max: cfg.max ?? 16, t: 0.5 };
}
function updateSpawner(dt) {
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
  if (now - lastGroan > 0.6) { lastGroan = now; type === 'G' ? sfx.roar() : sfx.groan(); }
  sp.left--;
}

// 人質：雙手舉高站著；只有玩家的子彈會打到他
function addHostage(x, z) {
  const man = makeBlockMan({ shirt: 0xe8e4da, pants: 0x5a5a66, skin: 0xf0c9a0 });
  man.root.position.set(x, 0, z);
  man.armL.rotation.x = man.armR.rotation.x = -2.9;
  level.group.add(man.root);
  level.hostage = { man, x, z, r: 0.32, alive: true, saved: false };
}
function killHostage(dx, dz) {
  const h = level.hostage;
  h.alive = false;
  voxelBurst(h.man.root, 60, 4, dx * 4, dz * 4);
  level.group.remove(h.man.root);
  sparks(h.x, 1, h.z, 0xff3030, 16);
  sfx.die();
  slowMo = 1.1;
  state = 'failed';
  player.laser.g.visible = player.guide.g.visible = false;
  setTimeout(() => {
    if (state !== 'failed') return;
    showPanel('任務失敗', `${levelLabel()}<br>人質被你打中了`, [
      { label: '重來這關', primary: true, run: retryLevel },
      { label: '回主選單', run: showMenu },
    ]);
  }, 1100);
}

// 撤離物資：發光的箱子，拿到後出口打開、通風口開始冒殭屍
const itemMat = addMat(0x40e0ff, 0.9);
function addItem(x, z) {
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
function updateObjectives(dt) {
  const L = level, goal = L.goal;
  if (state !== 'play') return;
  if (L.item && !L.item.taken) {
    L.item.g.position.y = 0.35 + Math.sin(now * 3) * 0.06;
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
function goalText() {
  const L = level;
  if (!L || state === 'menu') return '';
  if (L.doorOpen) return L.goal === 'hold' || L.goal === 'extract' ? '快跑到出口' : '前往出口';
  switch (L.goal) {
    case 'activate': return `打開開關 ${L.switches.filter(s => s.on).length}/${L.switches.length}`;
    case 'hold': return `撐住 ${Math.ceil(L.holdT)} 秒`;
    case 'extract': return '找到物資';
    case 'rescue': return enemies.length ? `清除敵人・剩 ${enemies.length}` : '去碰人質';
    default: return `清除敵人・剩 ${enemies.length}`;
  }
}

function loadLevel(mode, index) {
  clearEntities();
  if (level) { scene.remove(level.group); for (const s of level.switches) freeBar(s.bar); }
  const defs = levelDefs(mode);
  const def = defs[index % defs.length];
  const grid = def.map.split('\n').map(s => [...s.trim()]);
  H = grid.length; W = grid[0].length;
  flow = new Int16Array(W * H); zflow = new Int16Array(W * H);
  level = {
    group: new THREE.Group(), grid, doorOpen: false, doorMeshes: [], exitMeshes: [],
    doors: new Map(), mode, index, dark: mode === 'dark', lamps: [], def,
    switches: [], vents: [], cracks: new Map(), spawner: null, hostage: null, item: null,
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
  const aware = mode === 'arena';    // 清房模式敵人一開始就知道你在哪
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
    else if (ch === 'W' || ch === 'V') {
      const m = new THREE.Mesh(ch === 'W' ? crackGeo : ventGeo, wallMat);
      m.position.set(x, WALL_H / 2, z);
      m.castShadow = m.receiveShadow = true;
      level.group.add(m);
      if (ch === 'W') level.cracks.set(c + r * W, m);
      else {
        // 殭屍從相鄰的地板格冒出來
        const [dc, dr] = DIRS4.find(([dc, dr]) => '.PZGKLlX'.includes(grid[r + dr]?.[c + dc] ?? '#')) ?? [0, 0];
        level.vents.push({ x, z, sx: toWorldX(c + dc), sz: toWorldZ(r + dr) });
      }
    }
    else if (ch === 'K') addSwitch(x, z);
    else if (ch === 'X') addItem(x, z);
    else if (ch === 'Q') addHostage(x, z);
    else if (ch === 'D') {
      const m = new THREE.Mesh(wallGeo, doorMat);
      m.position.set(x, WALL_H / 2, z);
      m.castShadow = m.receiveShadow = true;
      level.group.add(m);
      level.doorMeshes.push(m);
    } else if (ch === 'B') {
      // 門板順著牆的方向：左右是牆 → 橫門
      const horiz = grid[r][c - 1] === '#' || grid[r][c + 1] === '#';
      const m = new THREE.Mesh(breachGeo, wallMat);
      m.scale.set(horiz ? 1 : 0.35, 1, horiz ? 0.35 : 1);
      m.position.set(x, WALL_H * 0.46, z);
      m.castShadow = m.receiveShadow = true;
      level.group.add(m);
      level.doors.set(c + r * W, { c, r, x, z, mesh: m, hp: 130, open: false, kind: 'breach', colors: WOOD });
    } else if (ch === 'P') { player.x = x; player.z = z; }
    else if ('RSHZG'.includes(ch)) spawnEnemy(ch, x, z, loop, aware);
    else if (ch === 'L' || ch === 'l') addLamp(x, z, ch === 'l');
  }
  const inst = new THREE.InstancedMesh(wallGeo, wallMat, walls.length);
  const mtx = new THREE.Matrix4();
  walls.forEach(([x, z], i) => inst.setMatrixAt(i, mtx.makeTranslation(x, WALL_H / 2, z)));
  inst.castShadow = inst.receiveShadow = true;
  level.group.add(inst);

  resetPlayer();
  buildFlow();
  if (level.goal === 'hold' && def.wave) startSpawner(def.wave);
  updateLamps(0);
  slowMo = 0; hitStop = 0;
  state = 'play';
  camTarget.set(player.x, 0, player.z - 1);
  document.getElementById('room').textContent = levelLabel();
  updateHud();
}

function openExit(text = 'CLEAR') {
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
function breachDoor(d, kicked, dx = 0, dz = 0) {
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
    slowMo = Math.max(slowMo, 1.3);
    showToast('BREACH!', 'breach');
    navigator.vibrate?.(40);
  }
}

// ---------- 雷射 ----------
function makeLaser(color) {
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
function setLaser(L, ox, oz, dx, dz, len, y, alpha, w) {
  L.g.visible = true;
  L.g.position.set(ox + dx * len / 2, y, oz + dz * len / 2);
  L.g.rotation.set(0, Math.atan2(dx, dz), 0);
  L.core.scale.set(w * 0.35, w * 0.35, len);
  L.glow.scale.set(w, w, len);
  L.dot.position.set(0, 0, len / 2);
  L.core.material.opacity = alpha;
  L.glow.material.opacity = alpha * 0.6;
}
function freeLaser(L) { scene.remove(L.g); L.core.material.dispose(); L.glow.material.dispose(); }

// ---------- 頭上進度條（換彈）與驚覺標記 ----------
const BAR_GEO = new THREE.PlaneGeometry(1, 1);
const BAR_FILL_GEO = new THREE.PlaneGeometry(1, 1).translate(0.5, 0, 0);
function makeBar(color) {
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
function setBar(b, x, y, z, k) {
  b.g.visible = true;
  b.g.position.set(x, y, z);
  b.fill.scale.x = 0.84 * Math.max(0.001, Math.min(1, k));
}
function freeBar(b) { scene.remove(b.g); }

function textTexture(text, color) {
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
const ALERT_TEX = textTexture('!', '#ffd23a');
const markers = [];
function showMarker(e) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: ALERT_TEX, depthTest: false, transparent: true }));
  s.renderOrder = 12;
  scene.add(s);
  markers.push({ s, e, life: 0.9 });
}
function updateMarkers(dt) {
  for (let i = markers.length - 1; i >= 0; i--) {
    const m = markers[i];
    m.life -= dt;
    if (m.life <= 0 || !enemies.includes(m.e)) {
      scene.remove(m.s); m.s.material.dispose(); markers.splice(i, 1); continue;
    }
    const t = 1 - m.life / 0.9;
    const sc = t < 0.12 ? (t / 0.12) * 0.9 : 0.75;
    m.s.scale.set(sc, sc, 1);
    m.s.position.set(m.e.x, 2.1 * m.e.def.scale, m.e.z);
    m.s.material.opacity = m.life < 0.3 ? m.life / 0.3 : 1;
  }
}

// ---------- 子彈（曳光彈） ----------
const bullets = [];
function spawnBullet(owner, style, x, z, dx, dz, speed, range = 30, dmg = 1) {
  const st = TRACER[style];
  const g = new THREE.Group();
  const core = new THREE.Mesh(UNIT_BOX, st.core);
  const glow = new THREE.Mesh(UNIT_BOX, st.glow);
  core.scale.set(0.06, 0.06, 1);
  glow.scale.set(0.2, 0.2, 1);
  g.add(core, glow);
  g.scale.z = 0.001;
  scene.add(g);
  bullets.push({ g, owner, x, z, dx, dz, speed, range, dmg, traveled: 0, len: 0, maxLen: st.maxLen, dying: false });
}

function updateBullets(dt) {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    if (!b.dying) {
      const total = b.speed * dt;
      const steps = Math.max(1, Math.ceil(total / 0.2));
      const step = total / steps;
      for (let s = 0; s < steps && !b.dying; s++) {
        b.x += b.dx * step; b.z += b.dz * step; b.traveled += step;
        const c = tileC(b.x), r = tileR(b.z);
        if (isWallTile(c, r)) {
          b.dying = true;
          const door = level.grid[r]?.[c] === 'B' ? level.doors.get(c + r * W) : null;
          if (door) {
            // 門可以打爛
            burst(b.x - b.dx * 0.1, GUN_Y, b.z - b.dz * 0.1, WOOD, 1, 2);
            sfx.doorHit();
            if (b.owner === 'p' && (door.hp -= b.dmg) <= 0) breachDoor(door, false, b.dx, b.dz);
          } else {
            sparks(b.x - b.dx * 0.1, GUN_Y, b.z - b.dz * 0.1, b.owner === 'p' ? 0xffc060 : 0xff6050, 4, -b.dx, -b.dz);
            if (b.owner === 'p') sfx.wall();
          }
          break;
        }
        if (b.owner === 'p') {
          for (const e of enemies) {
            const ddx = e.x - b.x, ddz = e.z - b.z;
            if (ddx * ddx + ddz * ddz < (e.r + 0.08) ** 2) { b.dying = true; damageEnemy(e, b); break; }
          }
          const h = level.hostage;
          if (!b.dying && h?.alive && (h.x - b.x) ** 2 + (h.z - b.z) ** 2 < (h.r + 0.06) ** 2) { b.dying = true; killHostage(b.dx, b.dz); }
          for (const l of level.lamps) {
            if (!l.broken && (l.x - b.x) ** 2 + (l.z + LAMP_HIT_DZ - b.z) ** 2 < 0.22 * 0.22) breakLamp(l);
          }
        } else if (player.alive && player.inv <= 0) {
          const ddx = player.x - b.x, ddz = player.z - b.z;
          if (ddx * ddx + ddz * ddz < 0.3 * 0.3) { b.dying = true; hurtPlayer(b.dx, b.dz); }
        }
      }
      if (b.traveled > b.range) b.dying = true;
      b.len = Math.min(b.traveled, b.maxLen);
    } else {
      // 彈頭停住，尾巴繼續往前收：曳光拖尾
      b.len -= b.speed * dt;
      if (b.len <= 0) { scene.remove(b.g); bullets.splice(i, 1); continue; }
    }
    b.g.position.set(b.x - b.dx * b.len / 2, GUN_Y, b.z - b.dz * b.len / 2);
    b.g.rotation.y = Math.atan2(b.dx, b.dz);
    b.g.scale.z = Math.max(0.001, b.len);
  }
}

// ---------- 粒子 ----------
const debris = [], fx = [];
function burst(x, y, z, colors, n, power, bx = 0, bz = 0) {
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
function voxelBurst(root, n, power, bx = 0, bz = 0) {
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
function sparks(x, y, z, color, n, nx = 0, nz = 0) {
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
function muzzleFlash(x, y, z, color) {
  const m = new THREE.Mesh(FLASH_GEO, addMat(color));
  m.position.set(x, y, z);
  m.rotation.set(Math.random() * 3, Math.random() * 3, 0);
  scene.add(m);
  fx.push({ m, life: 0.05, max: 0.05, vx: 0, vy: 0, vz: 0, grow: true });
}
function updateParticles(dt) {
  for (let i = debris.length - 1; i >= 0; i--) {
    const d = debris[i], p = d.m.position;
    d.vy -= 24 * dt;
    p.x += d.vx * dt; p.y += d.vy * dt; p.z += d.vz * dt;
    d.m.rotation.x += d.sx * dt; d.m.rotation.z += d.sz * dt;
    if (p.y < 0.08) {
      p.y = 0.08; d.vy *= -0.35; d.vx *= 0.55; d.vz *= 0.55; d.sx *= 0.5; d.sz *= 0.5;
    }
    if (wallAt(p.x, p.z) && p.y < WALL_H) { d.vx *= -0.4; d.vz *= -0.4; p.x += d.vx * dt * 2; p.z += d.vz * dt * 2; }
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

// ---------- 玩家 ----------
const player = {
  man: makeBlockMan({ shirt: 0x2f8cff, pants: 0x23324d, helmet: 0x1f5fa8 }),
  x: 0, z: 0, vx: 0, vz: 0, r: 0.33, fx: 0, fz: -1,
  aimA: Math.PI, recoil: 0, kickSign: 1,   // aimA = 實際槍口角度；recoil = 後座力造成的偏移
  hits: 0, inv: 0, fireCd: 0, alive: true, kick: 0,
  slots: [], cur: 0, swapT: 0, swapDur: 1, swapped: true,
  laser: makeLaser(0x40d8ff), guide: makeLaser(0xffffff), bar: makeBar(0x5adcff),
};
scene.add(player.man.root);
const swapTimeOf = () => swapTime(player.slots.map(s => s.stats));
const curSlot = () => player.slots[player.cur];

// 依裝備建出兩把槍的方塊模型；手上一把、背上一把
function equipLoadout(lo) {
  for (const s of player.slots) { s.mesh.parent?.remove(s.mesh); s.mesh.dispose(); }
  player.slots = lo.map(build => {
    const w = buildWeapon(build);
    const stats = computeStats(build);
    const mesh = buildVoxelMesh(w.set, player.man.mats.main, WEAPON_PAL);
    return { build, stats, mesh, muzzleZ: w.muzzleZ, muzzleY: w.muzzleY, ammo: stats.mag, reloadT: 0 };
  });
  player.cur = 0;
  mountWeapons();
}
function mountWeapons() {
  const m = player.man;
  player.slots.forEach((s, i) => {
    if (i === player.cur) { m.gun.add(s.mesh); m.gun.position.y = GUN_Y - s.muzzleY; }
    else m.back.add(s.mesh);
  });
}

function resetPlayer() {
  const p = player;
  p.vx = p.vz = 0; p.fx = 0; p.fz = -1; p.aimA = Math.PI; p.recoil = 0;
  p.inv = 0.6; p.fireCd = 0; p.alive = true; p.kick = 0;
  if (p.cur !== 0) { p.cur = 0; mountWeapons(); }
  for (const s of p.slots) { s.ammo = s.stats.mag; s.reloadT = 0; }
  p.swapT = 0; p.swapped = true;
  p.man.root.visible = true;
  p.man.root.position.set(p.x, 0, p.z);
  p.bar.g.visible = false;
  updateAmmoHud();
}

function startReload() {
  const p = player, s = curSlot();
  if (!p.alive || p.swapT > 0 || s.reloadT > 0 || s.ammo >= s.stats.mag) return;
  s.reloadT = s.stats.reload;
  sfx.reloadStart();
  updateAmmoHud();
}

function startSwap() {
  const p = player;
  if (!p.alive || p.swapT > 0 || p.slots.length < 2) return;
  curSlot().reloadT = 0;   // 切槍會中斷換彈
  p.swapDur = p.swapT = swapTimeOf(); p.swapped = false;
  sfx.reloadStart();
  updateAmmoHud();
}

// fwd = 槍口離身體中心往前多遠；hand = 1 右手、-1 左手
const muzzleOf = (x, z, fx, fz, s = 1, fwd = 0.67, hand = 1) => ({
  x: x + (fz * 0.2 * hand + fx * fwd) * s,
  z: z + (-fx * 0.2 * hand + fz * fwd) * s,
});
const playerMuzzle = () => muzzleOf(player.x, player.z, player.fx, player.fz, 1, 0.22 + curSlot().muzzleZ, player.man.hand);

// 換持槍手，記在瀏覽器裡
const HAND_KEY = 'brickshooter.hand';
function toggleHand() {
  setHand(player.man, -player.man.hand);
  try { localStorage.setItem(HAND_KEY, player.man.hand); } catch { /* 存不了就只影響這次 */ }
  updateAmmoHud();
}

const angleDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
function approachAngle(a, t, maxStep) {
  const d = angleDiff(a, t);
  return Math.abs(d) <= maxStep ? t : a + Math.sign(d) * maxStep;
}

const raycaster = new THREE.Raycaster();
const aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -GUN_Y);
const tmpV = new THREE.Vector3(), ndc = new THREE.Vector2();

function updatePlayer(dt) {
  const p = player, slot = curSlot(), st = slot.stats;
  if (!p.alive) { p.laser.g.visible = p.guide.g.visible = p.bar.g.visible = false; return; }
  const mode = input.aimMode;
  const firing = mode === 'fire';
  const spd = 5.6 * (firing ? 0.78 : 1) * (slot.reloadT > 0 ? 0.9 : 1) * (1 - st.weight * 0.035);
  const k = 1 - Math.exp(-18 * dt);
  p.vx += (input.move.x * spd - p.vx) * k;
  p.vz += (input.move.y * spd - p.vz) * k;
  p.x += p.vx * dt; p.z += p.vz * dt;
  collide(p, p.r);

  // 踹門：貼著門往門的方向推 0.15 秒
  const ml = Math.hypot(input.move.x, input.move.y);
  let kicking = null;
  if (ml > 0.5) {
    for (const d of level.doors.values()) {
      if (d.open || d.kind === 'gate') continue;
      const minX = d.c - W / 2, minZ = d.r - H / 2;
      const dx = Math.max(minX, Math.min(p.x, minX + 1)) - p.x;
      const dz = Math.max(minZ, Math.min(p.z, minZ + 1)) - p.z;
      const dd = Math.hypot(dx, dz);
      if (dd < p.r + 0.08 && dd > 1e-4 && (dx * input.move.x + dz * input.move.y) / (dd * ml) > 0.5) { kicking = d; break; }
    }
  }
  if (kicking) {
    p.kick += dt;
    if (p.kick >= 0.15) { breachDoor(kicking, true, input.move.x / ml, input.move.y / ml); p.kick = 0; }
  } else p.kick = 0;

  // 目標方向（游標 / 右搖桿）
  let ax = 0, az = 0, aiming = mode !== 'none';
  if (aiming) {
    if (input.source === 'touch') { ax = input.aimVec.x; az = input.aimVec.y; }
    else {
      ndc.set(input.mouse.x / innerWidth * 2 - 1, -(input.mouse.y / innerHeight) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      if (raycaster.ray.intersectPlane(aimPlane, tmpV)) {
        ax = tmpV.x - p.x; az = tmpV.z - p.z;
        const d = Math.hypot(ax, az);
        if (d > 0.05) {
          ax /= d; az /= d;
          // 從槍口重新對準游標，讓雷射剛好落在游標上
          const m = muzzleOf(p.x, p.z, ax, az, 1, 0.22 + slot.muzzleZ, p.man.hand);
          const mx = tmpV.x - m.x, mz = tmpV.z - m.z, md = Math.hypot(mx, mz);
          if (d > 1.5 && md > 0.01) { ax = mx / md; az = mz / md; }
        } else aiming = false;
      } else aiming = false;
    }
  }
  let targetA = null;
  if (aiming) targetA = Math.atan2(ax, az);
  else if (ml > 0.2) targetA = Math.atan2(input.move.x, input.move.y);

  // 實際槍口以「轉向速度」追目標；後座力偏移也以轉向速度相關的速率回正
  if (targetA !== null) p.aimA = approachAngle(p.aimA, targetA, st.turn * DEG * (aiming ? 1 : 1.3) * dt);
  p.recoil *= Math.exp(-dt * st.turn / 90);
  const actA = p.aimA + p.recoil;
  p.fx = Math.sin(actA); p.fz = Math.cos(actA);

  const m = playerMuzzle();
  if (aiming) {
    let len = castRay(m.x, m.z, p.fx, p.fz, st.range);
    for (const e of enemies) len = Math.min(len, rayCircle(m.x, m.z, p.fx, p.fz, e.x, e.z, e.r));
    const pulse = 0.85 + Math.sin(now * 30) * 0.15;
    const alpha = (slot.reloadT > 0 || p.swapT > 0) ? 0.3 : firing ? 0.35 : 0.8 * pulse;
    setLaser(p.laser, m.x, m.z, p.fx, p.fz, len, GUN_Y, alpha, firing ? 0.05 : 0.07);
    // 槍口還沒轉到位：用淡白線標出目標方向
    if (Math.abs(angleDiff(actA, targetA)) > 0.035) {
      const tx = Math.sin(targetA), tz = Math.cos(targetA);
      setLaser(p.guide, m.x, m.z, tx, tz, Math.min(4, castRay(m.x, m.z, tx, tz, 4)), GUN_Y, 0.22, 0.03);
    } else p.guide.g.visible = false;
  } else p.laser.g.visible = p.guide.g.visible = false;

  // 切槍
  if (input.swapPressed) startSwap();
  if (input.handPressed) toggleHand();
  if (p.swapT > 0) {
    p.swapT -= dt;
    if (!p.swapped && p.swapT <= p.swapDur / 2) {
      // 換手的那一刻：手上的槍放背上、背上的拿到手上
      p.swapped = true;
      p.man.gun.remove(slot.mesh); p.man.back.remove(p.slots[p.cur ^ 1].mesh);
      p.cur ^= 1;
      mountWeapons();
      updateAmmoHud();
    }
    if (p.swapT <= 0) { p.swapT = 0; updateAmmoHud(); }
  }

  // 換彈
  const cs = curSlot(), cst = cs.stats;
  if (input.reloadPressed) startReload();
  if (cs.reloadT > 0) {
    cs.reloadT -= dt;
    if (cs.reloadT <= 0) { cs.reloadT = 0; cs.ammo = cst.mag; sfx.reloadDone(); }
    updateAmmoHud();
  }

  p.fireCd -= dt;
  if (firing && p.fireCd <= 0 && cs.reloadT <= 0 && p.swapT <= 0) {
    if (cs.ammo <= 0) { sfx.empty(); startReload(); p.fireCd = 0.2; }
    else {
      p.fireCd = cst.fireInterval;
      const mm = playerMuzzle();
      const sp = (Math.random() - 0.5) * cst.spread;
      spawnBullet('p', 'player', mm.x, mm.z, Math.sin(actA + sp), Math.cos(actA + sp), cst.speed, cst.range, cst.damage);
      muzzleFlash(mm.x, GUN_Y, mm.z, 0xffc040);
      muzzleGlow = 0.07;
      // 後座力：把實際槍口踢偏，方向大多延續上一發
      if (Math.random() < 0.3) p.kickSign *= -1;
      p.recoil = Math.max(-0.45, Math.min(0.45, p.recoil + cst.kick * DEG * p.kickSign * (0.6 + Math.random() * 0.4)));
      p.vx -= p.fx * cst.kick * 0.35; p.vz -= p.fz * cst.kick * 0.35;
      addTrauma(0.03 + cst.kick * 0.012);
      sfx.shoot();
      cs.ammo--;
      alertNoise(cst.noise);
      if (cs.ammo <= 0) startReload();   // 打空自動換彈
      updateAmmoHud();
    }
  }

  if (cs.reloadT > 0) setBar(p.bar, p.x, 1.95, p.z, 1 - cs.reloadT / cst.reload);
  else if (p.swapT > 0) setBar(p.bar, p.x, 1.95, p.z, 1 - p.swapT / p.swapDur);
  else p.bar.g.visible = false;

  if (p.inv > 0) p.inv -= dt;
  p.man.root.visible = p.inv > 0 ? Math.floor(p.inv * 18) % 2 === 0 : true;
  p.man.root.position.set(p.x, 0, p.z);
  p.man.body.rotation.y = actA;
  const busy = cs.reloadT > 0 || p.swapT > 0;
  animateMan(p.man, Math.min(1, Math.hypot(p.vx, p.vz) / 5.6), dt, aiming && !busy);
  p.man.gun.rotation.x = busy ? 0.7 : 0;

  // 走進出口
  if (level.doorOpen && level.grid[tileR(p.z)]?.[tileC(p.x)] === 'D') nextLevel();
}

function hurtPlayer(dx, dz) {
  const p = player;
  if (!p.alive || p.inv > 0) return;
  p.hits++;
  p.inv = 1.0;
  p.vx += dx * 9; p.vz += dz * 9;
  setFlash(p.man, true); setTimeout(() => setFlash(p.man, false), 90);
  burst(p.x, 1, p.z, [0x2f8cff, 0xf0c9a0], 5, 3);
  sparks(p.x, 1, p.z, 0xff4040, 10);
  hitStop = Math.max(hitStop, 0.14);
  addTrauma(0.75);
  flashEl.style.transition = 'none'; flashEl.style.opacity = 1;
  requestAnimationFrame(() => { flashEl.style.transition = 'opacity .45s'; flashEl.style.opacity = 0; });
  navigator.vibrate?.(p.hits >= MAX_HITS ? 250 : 70);
  updateHud();
  if (p.hits >= MAX_HITS) killPlayer();
  else sfx.hurt();
}

function killPlayer() {
  const p = player;
  p.alive = false;
  p.man.root.visible = false;
  p.laser.g.visible = p.guide.g.visible = false;
  p.bar.g.visible = false;
  voxelBurst(p.man.root, 80, 5);
  sparks(p.x, 1, p.z, 0xff3030, 20);
  sfx.die();
  slowMo = 1.1;
  state = 'dead';
  setTimeout(() => {
    if (state !== 'dead') return;
    showPanel('YOU DIED', `${levelLabel()}<br>被擊中 ${MAX_HITS} 次`, [
      { label: '重來這關', primary: true, run: retryLevel },
      { label: '回主選單', run: showMenu },
    ]);
  }, 1100);
}

// ---------- 敵人 ----------
// mag = 幾發後要換彈；seekCover = 換彈時躲到玩家看不到的地方；react = 發現玩家後幾秒才行動
const ETYPES = {
  R: { hp: 60, r: 0.36, speed: 4.1, shirt: 0xd8433b, pants: 0x4a1c1c, helmet: null, scale: 1, gun: false, react: 0.45 },
  S: { hp: 100, r: 0.36, speed: 2.6, shirt: 0xe0892a, pants: 0x3a3022, helmet: 0x6b4a1f, scale: 1, gun: true,
    mag: 6, reload: 1.7, seekCover: true, aimTime: 0.85, react: 0.55,
    build: { caliber: '556', receiver: 'carbine', stock: 'fold', mag: 'std', barrel: 'std', grip: 'none' } },
  H: { hp: 320, r: 0.48, speed: 1.7, shirt: 0x7b4fcf, pants: 0x2b2240, helmet: 0x3a2a66, scale: 1.3, gun: true,
    mag: 2, reload: 2.4, seekCover: false, aimTime: 1.1, react: 0.75,
    build: { caliber: '9mm', receiver: 'smg', stock: 'full', mag: 'drum', barrel: 'long', grip: 'vert' } },
  // 黑暗模式：殭屍只會走過來碰你；巨型殭屍會衝撞，衝撞路上的殭屍會被撞開
  Z: { hp: 60, r: 0.34, speed: 1.7, shirt: 0x56606a, pants: 0x2e3328, helmet: null, scale: 1, gun: false, react: 0.35,
    zombie: true, skin: 0x8aa37a, eye: 0xd8ff50, sight: 8, kb: 3.4 },
  G: { hp: 420, r: 0.56, speed: 1.9, shirt: 0x3a3440, pants: 0x24202a, helmet: null, scale: 1.5, gun: false, react: 0.5,
    zombie: true, skin: 0x9a9888, eye: 0xff3a20, sight: 9, kb: 0.5, mass: 4 },
};
const ZOMBIE_SHIRTS = [0x56606a, 0x6a4f42, 0x46543a, 0x5c5c66, 0x70604a];
const enemyGuns = {};   // 每種敵人的槍只算一次方塊
const enemyGunOf = type => enemyGuns[type] ??= buildWeapon(ETYPES[type].build);
const enemies = [];
function spawnEnemy(type, x, z, loop, aware) {
  const def = ETYPES[type];
  const shirt = type === 'Z' ? ZOMBIE_SHIRTS[Math.floor(Math.random() * ZOMBIE_SHIRTS.length)] : def.shirt;
  const man = makeBlockMan({ shirt, pants: def.pants, helmet: def.helmet, scale: def.scale, skin: def.skin ?? 0xd9b48c });
  if (def.zombie) {
    addGlowEyes(man, def.eye);
    man.root.traverse(o => { o.castShadow = false; });   // 殭屍多，省掉陰影
  }
  let muzzleFwd = 0.67;
  if (def.gun) {
    const w = enemyGunOf(type);
    man.gun.add(buildVoxelMesh(w.set, man.mats.main, WEAPON_PAL));
    man.gun.position.y = GUN_Y - w.muzzleY;
    muzzleFwd = 0.22 + w.muzzleZ;
  }
  man.root.position.set(x, 0, z);
  scene.add(man.root);
  // 沒察覺的敵人隨機朝向
  const a = aware ? 0 : Math.floor(Math.random() * 4) * Math.PI / 2;
  const e = {
    type, def, man, x, z, vx: 0, vz: 0, hp: def.hp * (1 + loop * 0.2), r: def.r, muzzleFwd,
    fx: Math.sin(a), fz: Math.cos(a), state: 'idle', t: 0.7 + Math.random() * 0.6, ax: 0, az: 1, lx: 0, lz: 1,
    aware, react: -1, ammo: def.mag || 0, coverPath: null,
    burstLeft: 0, strafe: Math.random() < 0.5 ? -1 : 1, flash: 0,
    speedMul: (1 + loop * 0.15) * (type === 'Z' ? 0.85 + Math.random() * 0.3 : 1),
    seed: Math.random() * 10, cd: 0, stun: 0, vis: 1, blink: 2 + Math.random() * 4, wander: 0, wx: 0, wz: 0,
    laser: def.gun ? makeLaser(type === 'H' ? 0xc040ff : 0xff2020) : null,
    bar: def.gun ? makeBar(0xffd23a) : null,
  };
  man.body.rotation.y = a;
  enemies.push(e);
}

function becomeAware(e) {
  if (e.aware) return;
  e.aware = true;
  e.state = e.type === 'R' || e.def.zombie ? 'chase' : 'move';
  e.t = 0.15 + Math.random() * 0.3;
  if (!e.def.zombie) { showMarker(e); sfx.alert(); return; }
  // 殭屍：發出低吼，附近看得到牠的同伴跟著醒來
  if (now - lastGroan > 0.35) { lastGroan = now; e.type === 'G' ? sfx.roar() : sfx.groan(); }
  for (const o of enemies) {
    if (o.aware || o.react >= 0 || !o.def.zombie) continue;
    if (Math.hypot(o.x - e.x, o.z - e.z) < 4.5 && hasLOS(o.x, o.z, e.x, e.z)) o.react = 0.25 + Math.random() * 0.5;
  }
}
let lastGroan = 0;
// 槍聲 / 破門聲：沿著走得到的路傳（關著的門會擋）
function alertNoise(range) {
  for (const e of enemies) {
    if (e.aware || e.react >= 0) continue;
    const d = flowAt(e.x, e.z);
    if (d >= 0 && d <= range) e.react = e.def.react * (0.9 + Math.random() * 0.5);
  }
}

function damageEnemy(e, b) {
  const f = b.traveled / b.range;
  e.hp -= b.dmg * (f < 0.6 ? 1 : 1 - (f - 0.6) / 0.4 * 0.5);
  e.flash = 0.07;
  const kb = e.def.kb ?? (e.type === 'H' ? 1.2 : 3.2);
  e.vx += b.dx * kb; e.vz += b.dz * kb;
  sparks(b.x, GUN_Y, b.z, 0xffe080, 5, -b.dx, -b.dz);
  burst(b.x, GUN_Y, b.z, [e.def.shirt], 1, 2);
  if (e.hp <= 0) killEnemy(e, b.dx, b.dz);
  else {
    sfx.hit();
    if (!e.aware && (e.react < 0 || e.react > 0.2)) e.react = 0.2;
  }
}

function freeEnemy(e) {
  scene.remove(e.man.root);
  if (e.laser) freeLaser(e.laser);
  if (e.bar) freeBar(e.bar);
}

function killEnemy(e, dx, dz) {
  const i = enemies.indexOf(e);
  if (i < 0) return;
  enemies.splice(i, 1);
  voxelBurst(e.man.root, Math.round(45 * e.def.scale ** 1.5), 4, dx * 4, dz * 4);   // 身上的方塊往子彈方向噴
  freeEnemy(e);
  sparks(e.x, 1, e.z, 0xffd060, 12);
  sfx.kill();
  const big = e.def.scale > 1.2;
  hitStop = Math.max(hitStop, big ? 0.09 : e.type === 'Z' ? 0.035 : 0.055);
  addTrauma(big ? 0.5 : e.type === 'Z' ? 0.18 : 0.3);
}

function rotateToward(ax, az, tx, tz, maxA) {
  const a = Math.atan2(ax, az), t = Math.atan2(tx, tz);
  let d = t - a;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  const n = a + Math.max(-maxA, Math.min(maxA, d));
  return [Math.sin(n), Math.cos(n)];
}
function lerpAngle(a, b, k) {
  let d = b - a;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return a + d * k;
}

function startEnemyReload(e) {
  e.state = 'reload';
  e.t = e.def.reload;
  e.coverPath = e.def.seekCover ? findCoverPath(e) : null;
  sfx.enemyReload();
}

function updateEnemies(dt) {
  for (const e of enemies.slice()) {
    if (!enemies.includes(e)) continue;
    e.t -= dt;
    const tx = player.x - e.x, tz = player.z - e.z;
    const dist = Math.hypot(tx, tz) || 0.001;
    const nx = tx / dist, nz = tz / dist;
    const los = player.alive && hasLOS(e.x, e.z, player.x, player.z);
    const spd = e.def.speed * e.speedMul;
    let wx = 0, wz = 0, faceX = e.fx, faceZ = e.fz, aiming = false, direct = false;
    let laserOn = false;

    if (!e.aware) {
      // 還沒發現玩家：看到就開始反應倒數，倒數時會轉頭
      if (e.react < 0 && los && dist < (e.def.sight ?? 13)) e.react = e.def.react * (0.8 + Math.random() * 0.5);
      if (e.def.zombie && e.react < 0) {
        // 殭屍沒發現玩家時慢慢亂晃
        e.wander -= dt;
        if (e.wander <= 0) {
          e.wander = 1.5 + Math.random() * 2.5;
          const wa = Math.random() * Math.PI * 2, moving = Math.random() < 0.6;
          e.wx = moving ? Math.sin(wa) : 0; e.wz = moving ? Math.cos(wa) : 0;
        }
        wx = e.wx * spd * 0.3; wz = e.wz * spd * 0.3;
        if (e.wx || e.wz) { faceX = e.wx; faceZ = e.wz; }
      }
      if (e.react >= 0) {
        e.react -= dt;
        faceX = nx; faceZ = nz;
        if (e.react <= 0) becomeAware(e);
      }
    } else if (e.type === 'Z') {
      // 殭屍：直直走過來，碰到就算一次被彈；被巨型殭屍撞開時會暈一下
      aiming = true;
      if (e.stun > 0) e.stun -= dt;
      else if (e.state === 'recover') { if (e.t <= 0) e.state = 'chase'; }
      else if (player.alive) {
        const d = los ? { x: nx, z: nz } : navDir(e, zflow);
        const s = spd * (0.75 + 0.35 * Math.max(0, Math.sin(now * 3 + e.seed)));   // 一頓一頓地拖著走
        wx = d.x * s; wz = d.z * s; faceX = d.x; faceZ = d.z;
        if (!los) bangDoor(e, d.x, d.z, 18, dt);
      }
      if (e.state !== 'recover' && e.stun <= 0 && player.alive && player.inv <= 0 && dist < e.r + player.r + 0.08) {
        hurtPlayer(nx, nz);
        e.state = 'recover'; e.t = 0.6; e.vx = -nx * 3; e.vz = -nz * 3;
      }
    } else if (e.type === 'G') {
      // 巨型殭屍：慢慢逼近，距離夠就蓄力衝撞；撞牆會暈
      switch (e.state) {
        case 'idle': case 'chase': {
          if (!player.alive) break;
          const d = los ? { x: nx, z: nz } : navDir(e, zflow);
          wx = d.x * spd; wz = d.z * spd; faceX = d.x; faceZ = d.z;
          if (!los) bangDoor(e, d.x, d.z, 70, dt);
          e.cd -= dt;
          if (los && dist < 5.5 && dist > 1.4 && e.cd <= 0) {
            e.state = 'wind'; e.t = 0.85; e.lx = nx; e.lz = nz; sfx.roar();
          }
          break;
        }
        case 'wind':
          // 前段還會跟著轉，最後 0.3 秒鎖定方向
          if (e.t > 0.3) [e.lx, e.lz] = rotateToward(e.lx, e.lz, nx, nz, 2 * dt);
          faceX = e.lx; faceZ = e.lz;
          e.man.body.position.x = (Math.random() - 0.5) * 0.1;
          if (e.t <= 0) { e.state = 'dash'; e.t = 0.42; e.man.body.position.x = 0; }
          break;
        case 'dash': {
          e.vx = e.lx * 10.5 * e.speedMul; e.vz = e.lz * 10.5 * e.speedMul; direct = true; aiming = true;
          faceX = e.lx; faceZ = e.lz;
          // 撞開路上的殭屍
          for (const o of enemies) {
            if (o === e || o.type !== 'Z') continue;
            const ox = o.x - e.x, oz = o.z - e.z, od = Math.hypot(ox, oz);
            if (od > e.r + o.r + 0.35) continue;
            const side = (e.lx * oz - e.lz * ox) > 0 ? 1 : -1;
            o.vx = -e.lz * side * 8 + e.lx * 5; o.vz = e.lx * side * 8 + e.lz * 5;
            if (o.stun <= 0) burst(o.x, 0.9, o.z, [0x56606a, ETYPES.Z.skin], 2, 3);
            o.stun = 0.7;
            if (!o.aware) becomeAware(o);
          }
          if (e.t <= 0) { e.state = 'recover'; e.t = 0.8; }
          break;
        }
        case 'recover': if (e.t <= 0) { e.state = 'chase'; e.cd = 1.3; } break;
      }
      if (player.alive && player.inv <= 0 && e.state !== 'recover' && dist < e.r + player.r + 0.08) {
        const dash = e.state === 'dash';
        hurtPlayer(dash ? e.lx : nx, dash ? e.lz : nz);
        if (dash) { player.vx += e.lx * 6; player.vz += e.lz * 6; }
        e.state = 'recover'; e.t = 0.9; e.vx = e.vz = 0;
      }
    } else if (e.type === 'R') {
      switch (e.state) {
        case 'idle': if (e.t <= 0) e.state = 'chase'; break;
        case 'chase': {
          if (!player.alive) break;
          const d = los ? { x: nx, z: nz } : navDir(e);
          wx = d.x * spd; wz = d.z * spd; faceX = d.x; faceZ = d.z;
          if (los && dist < 2.9) { e.state = 'wind'; e.t = 0.55; e.lx = nx; e.lz = nz; sfx.lunge(); }
          break;
        }
        case 'wind':   // 衝刺前蹲一下、發紅 = 預告
          faceX = e.lx; faceZ = e.lz;
          e.man.body.position.x = (Math.random() - 0.5) * 0.08;
          if (e.t <= 0) { e.state = 'dash'; e.t = 0.32; e.man.body.position.x = 0; }
          break;
        case 'dash':
          e.vx = e.lx * 9.5 * e.speedMul; e.vz = e.lz * 9.5 * e.speedMul; direct = true;
          faceX = e.lx; faceZ = e.lz;
          if (e.t <= 0) { e.state = 'recover'; e.t = 0.5; }
          break;
        case 'recover': if (e.t <= 0) e.state = 'chase'; break;
      }
      if (e.state !== 'idle' && player.alive && player.inv <= 0 && dist < e.r + player.r + 0.06) {
        hurtPlayer(nx, nz);
        e.state = 'recover'; e.t = 0.7; e.vx = -nx * 5; e.vz = -nz * 5;
      }
    } else {
      const heavy = e.type === 'H';
      aiming = e.state !== 'idle' && e.state !== 'reload';
      switch (e.state) {
        case 'idle': if (e.t <= 0) { e.state = 'move'; e.t = 0.4 + Math.random() * 0.8; } break;
        case 'move': {
          if (!player.alive) break;
          let d;
          if (!los || dist > 9) d = navDir(e);
          else if (dist < 3.8) d = { x: -nx, z: -nz };
          else d = { x: -nz * e.strafe + nx * 0.2, z: nx * e.strafe + nz * 0.2 };
          wx = d.x * spd; wz = d.z * spd;
          if (los) { faceX = nx; faceZ = nz; } else { faceX = d.x; faceZ = d.z; }
          if (e.t <= 0) {
            if (los && dist < 12) {
              e.state = 'aim'; e.t = e.def.aimTime;
              e.ax = nx; e.az = nz; sfx.telegraph();
            } else e.t = 0.3;
          }
          break;
        }
        case 'aim': {
          // 前段追蹤玩家，最後 0.25 秒鎖定 → 玩家有機會閃
          if (e.t > 0.25) [e.ax, e.az] = rotateToward(e.ax, e.az, nx, nz, (heavy ? 1.6 : 2.4) * dt);
          faceX = e.ax; faceZ = e.az; laserOn = true;
          if (e.t <= 0) { e.state = 'fire'; e.burstLeft = heavy ? 1 : Math.min(3, e.ammo); e.t = 0; }
          break;
        }
        case 'fire': {
          faceX = e.ax; faceZ = e.az;
          if (e.t <= 0 && e.burstLeft > 0) {
            const m = muzzleOf(e.x, e.z, e.ax, e.az, e.def.scale, e.muzzleFwd);
            if (heavy) {
              for (let k = 0; k < 7; k++) {
                const a = Math.atan2(e.ax, e.az) + (k - 3) * 0.11 + (Math.random() - 0.5) * 0.04;
                spawnBullet('e', 'heavy', m.x, m.z, Math.sin(a), Math.cos(a), (8 + Math.random() * 1.5) * e.speedMul, 16);
              }
              sfx.heavyShoot();
              e.vx -= e.ax * 3; e.vz -= e.az * 3;
              e.t = 0.45;
            } else {
              const a = Math.atan2(e.ax, e.az) + (Math.random() - 0.5) * 0.06;
              spawnBullet('e', 'enemy', m.x, m.z, Math.sin(a), Math.cos(a), 12 * e.speedMul);
              sfx.enemyShoot();
              e.t = 0.11;
            }
            muzzleFlash(m.x, GUN_Y * e.def.scale, m.z, heavy ? 0xc060ff : 0xff5030);
            e.burstLeft--;
            e.ammo--;
          }
          if (e.burstLeft <= 0 && e.t <= 0) {
            if (e.ammo <= 0) startEnemyReload(e);
            else {
              e.state = 'move'; e.t = 1.0 + Math.random() * 0.9;
              if (Math.random() < 0.5) e.strafe *= -1;
            }
          }
          break;
        }
        case 'reload': {
          // 射手換彈時躲到掩體後；重砲手邊換邊慢慢逼近
          let d = null;
          const path = e.coverPath;
          if (path && path.length) {
            const n = path[0], ddx = n.x - e.x, ddz = n.z - e.z, dd = Math.hypot(ddx, ddz);
            if (dd < 0.25) path.shift();
            else d = { x: ddx / dd, z: ddz / dd, s: spd * 1.2 };
          } else if (heavy && player.alive) {
            const nd = los ? { x: nx, z: nz } : navDir(e);
            d = { x: nd.x, z: nd.z, s: spd * 0.6 };
          }
          if (d) { wx = d.x * d.s; wz = d.z * d.s; faceX = d.x; faceZ = d.z; }
          if (e.t <= 0) {
            e.ammo = e.def.mag; e.coverPath = null;
            e.state = 'move'; e.t = 0.3 + Math.random() * 0.5;
          }
          break;
        }
      }
      if (e.laser) {
        if (laserOn) {
          const m = muzzleOf(e.x, e.z, e.ax, e.az, e.def.scale, e.muzzleFwd);
          let len = castRay(m.x, m.z, e.ax, e.az, 22);
          if (player.alive) len = Math.min(len, rayCircle(m.x, m.z, e.ax, e.az, player.x, player.z, player.r));
          const locked = e.t <= 0.25;
          const prog = 1 - e.t / e.def.aimTime;
          const blink = locked ? (Math.floor(e.t * 40) % 2 ? 1 : 0.35) : 1;
          setLaser(e.laser, m.x, m.z, e.ax, e.az, len, GUN_Y * e.def.scale,
            (0.3 + prog * 0.6) * blink, locked ? 0.12 : 0.05 + prog * 0.04);
        } else e.laser.g.visible = false;
      }
      if (e.state === 'reload') setBar(e.bar, e.x, 2.05 * e.def.scale, e.z, 1 - e.t / e.def.reload);
      else e.bar.g.visible = false;
      e.man.gun.rotation.x = e.state === 'reload' ? 0.7 : 0;
    }

    if (!direct) {
      const k = 1 - Math.exp(-10 * dt);
      e.vx += (wx - e.vx) * k; e.vz += (wz - e.vz) * k;
    }
    const bx = e.x, bz = e.z;
    e.x += e.vx * dt; e.z += e.vz * dt;
    // 互相推開：越重的越不會被推
    const em = e.def.mass ?? 1;
    for (const o of enemies) {
      if (o === e) continue;
      const dx = e.x - o.x, dz = e.z - o.z, d = Math.hypot(dx, dz), min = e.r + o.r;
      if (d < min && d > 1e-4) {
        const om = o.def.mass ?? 1, p = (min - d) / d * om / (em + om);
        e.x += dx * p; e.z += dz * p;
      }
    }
    if (player.alive && (e.type !== 'R' || !e.aware) && e.state !== 'dash') {
      const dx = e.x - player.x, dz = e.z - player.z, d = Math.hypot(dx, dz), min = e.r + player.r;
      if (d < min && d > 1e-4) { const p = (min - d) / d; e.x += dx * p; e.z += dz * p; }
    }
    collide(e, e.r);
    // 巨型殭屍衝撞時撞到牆：暈一下（衝撞第一幀速度還沒起來，不算）
    if (e.type === 'G' && e.state === 'dash' && e.t < 0.38 && Math.hypot(e.x - bx, e.z - bz) < 10.5 * dt * 0.35) {
      // 撞到裂牆或門就撞破，暈得比較短
      const hc = tileC(e.x + e.lx * (e.r + 0.3)), hr = tileR(e.z + e.lz * (e.r + 0.3));
      const door = doorAt(hc, hr);
      let broke = true;
      if (level.grid[hr]?.[hc] === 'W') breakWall(hc, hr, e.lx, e.lz);
      else if (door && !door.open) destroyDoor(door, e.lx, e.lz);
      else broke = false;
      e.state = 'recover'; e.t = broke ? 0.6 : 1.4; e.vx = -e.lx * 2; e.vz = -e.lz * 2;
      sfx.thud(); addTrauma(0.35);
      burst(e.x + e.lx * e.r, 1, e.z + e.lz * e.r, [0x3a4256, 0x8a96b0], 6, 3);
    }

    const ca = Math.atan2(e.fx, e.fz), ta = Math.atan2(faceX, faceZ);
    const a = e.state === 'aim' || e.state === 'fire' || e.state === 'dash' ? ta : lerpAngle(ca, ta, 1 - Math.exp(-10 * dt));
    e.fx = Math.sin(a); e.fz = Math.cos(a);
    e.man.root.position.set(e.x, 0, e.z);
    e.man.body.rotation.y = a;
    animateMan(e.man, Math.min(1, Math.hypot(e.vx, e.vz) / (spd || 1)), dt, aiming || e.state === 'dash');

    if (e.flash > 0) { e.flash -= dt; setFlash(e.man, e.flash > 0); }
    else if (e.state === 'wind') {
      for (const k in e.man.mats) e.man.mats[k].emissive.setHex(Math.floor(e.t * 30) % 2 ? 0xff2000 : 0x000000);
    } else if (e.state === 'dash' || e.state === 'recover') setFlash(e.man, false);

    if (level.dark) updateEnemyVisibility(e, dt);
  }
}

// ---------- 黑暗模式的可見度 ----------
// 判定跟畫面上的光一致：手電筒光錐、身邊一圈、開槍火光、亮著的吊燈
function isLit(x, z, rad = 0) {
  if (player.alive) {
    const dx = x - player.x, dz = z - player.z, d = Math.hypot(dx, dz);
    if (d < BODY_LIGHT_R + rad) return true;
    if (muzzleGlow > 0 && d < 5.5 && hasLOS(player.x, player.z, x, z)) return true;
    if (d < FLASH_RANGE + rad && d > 1e-3) {
      const cosA = (dx * player.fx + dz * player.fz) / d;
      if (cosA > Math.cos(FLASH_ANGLE + Math.atan(rad / d)) && hasLOS(player.x, player.z, x, z)) return true;
    }
  }
  for (const l of level.lamps) {
    if (l.lit && Math.hypot(x - l.x, z - l.z) < LAMP_R + rad && hasLOS(l.x, l.z, x, z)) return true;
  }
  return false;
}

// 照到才看得見身體；黑暗中只剩發光的眼睛（偶爾眨一下）
function updateEnemyVisibility(e, dt) {
  const lit = isLit(e.x, e.z, e.r);
  e.vis += ((lit ? 1 : 0) - e.vis) * (1 - Math.exp(-(lit ? 14 : 4) * dt));
  const mat = e.man.mats.main;
  mat.transparent = e.vis < 0.99;
  mat.opacity = e.vis;
  for (const c of e.man.body.children) if (c !== e.man.eyes) c.visible = e.vis > 0.03;
  e.blink -= dt;
  if (e.blink < -0.12) e.blink = 2 + Math.random() * 4;
  if (e.man.eyes) e.man.eyes.visible = e.blink > 0;
}

// ---------- 遊戲流程 ----------
let state = 'menu', hitStop = 0, slowMo = 0, trauma = 0, now = 0;
const camTarget = new THREE.Vector3();
const $ = id => document.getElementById(id);
const flashEl = $('flash'), fadeEl = $('fade'), hudEl = $('hud');
const menuEl = $('menu'), panelEl = $('panel'), toastEl = $('toast'), goalEl = $('goal');

function clearEntities() {
  for (const e of enemies) freeEnemy(e);
  enemies.length = 0;
  for (const b of bullets) scene.remove(b.g);
  bullets.length = 0;
  for (const d of debris) scene.remove(d.m);
  debris.length = 0;
  for (const f of fx) { scene.remove(f.m); f.m.material.dispose(); }
  fx.length = 0;
  for (const m of markers) { scene.remove(m.s); m.s.material.dispose(); }
  markers.length = 0;
}

function nextLevel() {
  if (state !== 'play') return;
  const defs = levelDefs(level.mode), mode = level.mode;
  const last = mode !== 'arena' && level.index + 1 >= defs.length;
  if (last) {
    state = 'complete';
    player.laser.g.visible = player.guide.g.visible = false;
    showPanel('任務完成', `${defs.length} 個${mode === 'dark' ? '黑暗' : '破門'}關卡全部清除`, [
      { label: '再玩一次', primary: true, run: () => startGame(mode, 0) },
      { label: '回主選單', run: showMenu },
    ]);
    return;
  }
  state = 'transition';
  player.laser.g.visible = player.guide.g.visible = false;
  fadeEl.style.opacity = 1;
  setTimeout(() => {
    if (level.mode !== 'arena') player.hits = 0;   // 破門、黑暗模式每關重新給 3 次
    loadLevel(level.mode, level.index + 1);
    fadeEl.style.opacity = 0;
  }, 260);
}

function retryLevel() {
  hidePanel();
  player.hits = 0;   // 死了就在同一關重來，被彈次數歸零
  loadLevel(level.mode, level.index);
}

function startGame(mode, index) {
  menuEl.classList.add('hidden');
  hidePanel();
  hudEl.classList.remove('hidden');
  player.hits = 0;
  loadLevel(mode, index);
}

function updateHud() {
  const el = $('hits');
  el.innerHTML = '';
  for (let i = 0; i < MAX_HITS; i++) {
    const d = document.createElement('div');
    d.className = 'pip' + (i < player.hits ? ' lost' : '');
    el.appendChild(d);
  }
  updateAmmoHud();
}

const ammoEl = $('ammo'), ammoFill = $('ammoBar').firstElementChild, swapBtn = $('swapBtn');
function updateAmmoHud() {
  const p = player, s = curSlot();
  if (!s) return;
  const st = s.stats, other = p.slots[p.cur ^ 1];
  const reloading = s.reloadT > 0;
  $('wName').textContent = st.name;
  $('ammoNum').textContent = reloading ? 'RELOAD' : `${s.ammo}/${st.mag}`;
  ammoFill.style.width = (reloading ? (1 - s.reloadT / st.reload) : s.ammo / st.mag) * 100 + '%';
  ammoEl.classList.toggle('reloading', reloading);
  ammoEl.classList.toggle('low', !reloading && s.ammo <= Math.ceil(st.mag / 4));
  $('wAlt').textContent = other ? `${other.stats.name} ${other.ammo}/${other.stats.mag}` : '';
  swapBtn.classList.toggle('busy', p.swapT > 0);
  $('handBtn').textContent = p.man.hand > 0 ? '右手持槍' : '左手持槍';
}

function showToast(text, cls) {
  toastEl.textContent = text;
  toastEl.className = '';
  void toastEl.offsetWidth;   // 重新觸發動畫
  toastEl.className = 'show ' + cls;
}

function showPanel(title, html, buttons) {
  $('panelTitle').textContent = title;
  $('panelText').innerHTML = html;
  const box = $('panelButtons');
  box.innerHTML = '';
  for (const b of buttons) {
    const el = document.createElement('button');
    el.className = 'btn' + (b.primary ? ' primary' : '');
    el.textContent = b.label;
    el.addEventListener('click', () => { unlockAudio(); sfx.click(); b.run(); });
    box.appendChild(el);
  }
  panelEl.classList.remove('hidden');
}
function hidePanel() { panelEl.classList.add('hidden'); }

function pauseGame() {
  if (state !== 'play') return;
  state = 'paused';
  showPanel('暫停', levelLabel(), [
    { label: '繼續', primary: true, run: resumeGame },
    { label: '重來這關', run: retryLevel },
    { label: '回主選單', run: showMenu },
  ]);
}
function resumeGame() {
  hidePanel();
  if (state === 'paused') state = 'play';
}

const HELP_HTML = `<div class="keys">
<b>手機</b><br>
左半邊拖曳：移動<br>
右半邊拖曳：雷射瞄準，推過虛線圈：開火<br>
右半邊快速點一下：換彈<br>
左上角 ⇄ 按鈕：切換武器<br><br>
<b>電腦</b><br>
WASD 移動・滑鼠瞄準・左鍵開火<br>
R 換彈・Q 或滾輪切換武器・Esc 暫停<br><br>
<b>武器</b><br>
淡白線＝你想瞄的方向，雷射＝槍口實際方向<br>
越重的槍轉得越慢、切換也越慢<br><br>
<b>破門</b><br>
貼著木門往前推＝踹門，觸發慢動作<br>
也可以把門打爛，但沒有慢動作<br>
開槍會驚動附近的敵人<br><br>
<b>黑暗模式</b><br>
手電筒照向槍口實際的方向，轉得慢的槍掃得也慢<br>
黑暗中只看得到殭屍發光的眼睛，開槍的火光會短暫照亮四周<br>
巨型殭屍蓄力後會衝撞，引牠去撞牆會暈一下<br><br>
<b>關卡機關</b><br>
站在開關上一下：切換鐵捲門或燈<br>
殭屍會一直敲門，敲爛的鐵捲門就關不起來了<br>
有裂痕的牆擋不住巨型殭屍的衝撞<br>
吊燈打得掉，打掉那一區就暗了
</div>`;

// 進入畫面的功能清單：之後新增功能只要加一筆
const MENU_ITEMS = [
  { label: '清房模式', sub: '一間一間清，無限循環、越來越難', run: () => startGame('arena', 0) },
  { label: '破門攻堅', sub: `${BREACH_LEVELS.length} 個關卡・踹門慢動作・敵人在門後待命`, run: () => startGame('breach', 0) },
  { label: '黑暗模式', sub: `${DARK_LEVELS.length} 個關卡・只有手電筒和吊燈・殭屍成群`, run: () => startGame('dark', 0) },
  { label: '武器與裝備', sub: () => player.slots.map(s => s.stats.name).join(' ＋ '), run: showLoadout },
  { label: '操作說明', sub: '搖桿、換彈、破門', run: () => showPanel('操作說明', HELP_HTML, [{ label: '返回', primary: true, run: hidePanel }]) },
];
function buildMenu() {
  const box = $('menuButtons');
  box.innerHTML = '';
  MENU_ITEMS.forEach((it, i) => {
    const el = document.createElement('button');
    el.className = 'btn' + (i === 0 ? ' primary' : '');
    el.disabled = !!it.disabled;
    el.innerHTML = `${it.label}<small>${(typeof it.sub === 'function' ? it.sub() : it.sub) || ''}</small>`;
    el.addEventListener('click', () => { unlockAudio(); sfx.click(); it.run(); });
    box.appendChild(el);
  });
}

function showLoadout() {
  menuEl.classList.add('hidden');
  openLoadout(lo => {
    equipLoadout(lo);
    buildMenu();
    menuEl.classList.remove('hidden');
  });
}

function showMenu() {
  hidePanel();
  hudEl.classList.add('hidden');
  menuEl.classList.remove('hidden');
  loadLevel('breach', 0);   // 當背景
  state = 'menu';
  player.man.root.visible = false;
}

$('pauseBtn').addEventListener('click', pauseGame);
swapBtn.addEventListener('pointerdown', e => { e.preventDefault(); input.swapPressed = true; });
$('handBtn').addEventListener('pointerdown', e => { e.preventDefault(); input.handPressed = true; });
addEventListener('visibilitychange', () => { if (document.hidden && !TICK) pauseGame(); });

const input = new Input(container);
input.onFireStage = src => { if (src === 'touch') navigator.vibrate?.(8); };

function addTrauma(v) { trauma = Math.min(1, trauma + v); }

window.__dbg = { player, enemies, bullets, get level() { return level; }, startGame, spawnBullet, killEnemy };  // 除錯用

try { if (localStorage.getItem(HAND_KEY) === '-1') setHand(player.man, -1); } catch { /* 用預設右手 */ }
equipLoadout(loadLoadout());
buildMenu();
showMenu();

// ?tick：用計時器跑主迴圈（除錯用，視窗被藏起來時 requestAnimationFrame 不會跑）
const TICK = location.search.includes('tick');
const nextFrame = TICK ? cb => setTimeout(() => cb(performance.now()), 16) : requestAnimationFrame;
let last = performance.now();
function frame(t) {
  nextFrame(frame);
  const raw = Math.min(0.05, (t - last) / 1000);
  last = t;
  now += raw;
  input.update();
  if (input.pausePressed) { if (state === 'play') pauseGame(); else if (state === 'paused') resumeGame(); }
  input.pausePressed = false;

  let dt = (window.__dbg.paused || state === 'paused') ? 0 : raw;
  if (dt > 0 && hitStop > 0) { hitStop -= raw; dt = 0; }
  if (dt > 0 && slowMo > 0) { slowMo -= raw; dt *= 0.32; }

  if (dt > 0 && (state === 'play' || state === 'dead')) {
    flowTimer -= dt;
    if (flowTimer <= 0 && player.alive) { buildFlow(); flowTimer = 0.2; }
    updatePlayer(dt);
    updateEnemies(dt);
    updateBullets(dt);
    updateMarkers(dt);
    updateSwitches(dt);
    updateGates(dt);
    updateSpawner(dt);
    updateObjectives(dt);
  }
  if (dt > 0) updateParticles(dt);
  input.reloadPressed = false;
  input.swapPressed = false;
  input.handPressed = false;

  updateLamps(raw);
  const gt = goalText();
  if (goalEl.textContent !== gt) goalEl.textContent = gt;
  if (level.dark) {
    if (dt > 0) muzzleGlow -= dt;
    const on = player.alive && state !== 'menu';
    const mm = playerMuzzle();
    flashlight.intensity = on ? 26 : 0;
    flashlight.position.set(mm.x, GUN_Y + 0.05, mm.z);
    flashlight.target.position.set(mm.x + player.fx * 6, 0.2, mm.z + player.fz * 6);
    bodyLight.intensity = on ? 1.2 : 0;
    bodyLight.position.set(player.x, 1.6, player.z);
    muzzleLight.intensity = muzzleGlow > 0 ? 14 : 0;
    muzzleLight.position.set(mm.x, GUN_Y + 0.2, mm.z);
  }

  // 出口閃爍
  for (const m of level.exitMeshes) m.material.opacity = 0.35 + Math.sin(now * 6) * 0.2;

  // 攝影機：跟玩家、往瞄準方向前探、直式時讓角色偏下方；選單時慢慢飄
  const portrait = innerHeight > innerWidth;
  let lx, lz;
  if (state === 'menu') {
    lx = Math.sin(now * 0.15) * 2;
    lz = Math.sin(now * 0.1) * (H / 2 - 4);
  } else {
    const aimingNow = player.alive && player.laser.g.visible;
    lx = player.x + (aimingNow ? player.fx * 1.8 : 0);
    lz = player.z + (aimingNow ? player.fz * 1.8 : 0) - (portrait ? 1.6 : 0.5);
  }
  const ck = 1 - Math.exp(-(state === 'menu' ? 1 : 6) * raw);
  camTarget.x += (lx - camTarget.x) * ck;
  camTarget.z += (lz - camTarget.z) * ck;
  trauma = Math.max(0, trauma - raw * 1.8);
  const sh = trauma * trauma * 0.55;
  const ox = (Math.random() - 0.5) * sh, oz = (Math.random() - 0.5) * sh;
  camera.position.set(camTarget.x + ox, Math.sin(CAM_PITCH) * camDist, camTarget.z + Math.cos(CAM_PITCH) * camDist + oz);
  camera.lookAt(camTarget.x + ox, 0, camTarget.z + oz);
  sun.position.set(camTarget.x - 6, 16, camTarget.z + 4);
  sun.target.position.set(camTarget.x, 0, camTarget.z);

  renderer.render(scene, camera);
}
nextFrame(frame);

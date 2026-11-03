import * as THREE from 'three';
import { Input } from './input.js';
import { sfx, unlockAudio } from './audio.js';
import { ROOMS } from './rooms.js';
import { makeBlockMan, animateMan, setFlash } from './models.js';

const W = 13, H = 19;
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

scene.add(new THREE.HemisphereLight(0xc8d8ff, 0x2a2018, 1.4));
const sun = new THREE.DirectionalLight(0xfff2e0, 2.4);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 1, far: 60 });
sun.shadow.bias = -0.0008;
scene.add(sun, sun.target);

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

// ---------- 地圖與碰撞 ----------
let room = null;   // { group, grid, doorOpen, doorMeshes, index }
const toWorldX = c => c - W / 2 + 0.5;
const toWorldZ = r => r - H / 2 + 0.5;
const tileC = x => Math.floor(x + W / 2);
const tileR = z => Math.floor(z + H / 2);

function isWallTile(c, r) {
  if (c < 0 || r < 0 || c >= W || r >= H) return true;
  const ch = room.grid[r][c];
  return ch === '#' || (ch === 'D' && !room.doorOpen);
}
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

// 從玩家所在格做 BFS，敵人看不到玩家時沿著它走
let flow = new Int16Array(W * H), flowTimer = 0;
function buildFlow() {
  flow.fill(-1);
  const sc = tileC(player.x), sr = tileR(player.z);
  if (isWallTile(sc, sr)) return;
  const q = [sc + sr * W];
  flow[q[0]] = 0;
  for (let i = 0; i < q.length; i++) {
    const c = q[i] % W, r = (q[i] / W) | 0, d = flow[q[i]];
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = c + dc, nr = r + dr;
      if (isWallTile(nc, nr) || flow[nc + nr * W] !== -1) continue;
      flow[nc + nr * W] = d + 1;
      q.push(nc + nr * W);
    }
  }
}
function navDir(e) {
  const c = tileC(e.x), r = tileR(e.z);
  let best = null, bestD = (c >= 0 && c < W && r >= 0 && r < H) ? flow[c + r * W] : -1;
  if (bestD < 0) bestD = 9999;
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dc && !dr) continue;
    const nc = c + dc, nr = r + dr;
    if (isWallTile(nc, nr)) continue;
    if (dc && dr && (isWallTile(c + dc, r) || isWallTile(c, r + dr))) continue; // 不切牆角
    const d = flow[nc + nr * W];
    if (d >= 0 && d < bestD) { bestD = d; best = [nc, nr]; }
  }
  const tx = best ? toWorldX(best[0]) : player.x, tz = best ? toWorldZ(best[1]) : player.z;
  const dx = tx - e.x, dz = tz - e.z, d = Math.hypot(dx, dz) || 1;
  return { x: dx / d, z: dz / d };
}

// ---------- 房間建造 ----------
function makeFloorTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  g.fillStyle = '#262b36'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#2c3240'; g.fillRect(3, 3, 58, 58);
  g.fillStyle = '#1d212a'; g.fillRect(0, 0, 64, 2); g.fillRect(0, 0, 2, 64);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(W, H);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
const floorTex = makeFloorTexture();

// 牆：頂面亮、側面暗（頂點顏色）
const WALL_H = 1.4;
const wallGeo = new THREE.BoxGeometry(1, WALL_H, 1);
{
  const n = wallGeo.attributes.position.count, col = new Float32Array(n * 3);
  const side = new THREE.Color(0x3a4256), top = new THREE.Color(0x8a96b0);
  for (let i = 0; i < n; i++) {
    const c = (i >= 8 && i < 12) ? top : side;  // BoxGeometry 第 3 面 = +Y
    col.set([c.r, c.g, c.b], i * 3);
  }
  wallGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}
const wallMat = new THREE.MeshLambertMaterial({ vertexColors: true });
const doorMat = new THREE.MeshLambertMaterial({ color: 0x40242a, emissive: 0xff2040, emissiveIntensity: 0.35 });
const exitMat = addMat(0x30ff90, 0.55);

function loadRoom(index) {
  clearEntities();
  if (room) scene.remove(room.group);
  const grid = ROOMS[index % ROOMS.length].split('\n').map(s => s.trim());
  room = { group: new THREE.Group(), grid, doorOpen: false, doorMeshes: [], exitMeshes: [], index };
  scene.add(room.group);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshLambertMaterial({ map: floorTex }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  room.group.add(floor);

  const walls = [];
  const loop = Math.floor(index / ROOMS.length);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const ch = grid[r][c] || '#';
    const x = toWorldX(c), z = toWorldZ(r);
    if (ch === '#') walls.push([x, z]);
    else if (ch === 'D') {
      const m = new THREE.Mesh(wallGeo, doorMat);
      m.position.set(x, WALL_H / 2, z);
      m.castShadow = m.receiveShadow = true;
      room.group.add(m);
      room.doorMeshes.push(m);
    } else if (ch === 'P') { player.x = x; player.z = z; }
    else if ('RSH'.includes(ch)) spawnEnemy(ch, x, z, loop);
  }
  const inst = new THREE.InstancedMesh(wallGeo, wallMat, walls.length);
  const mtx = new THREE.Matrix4();
  walls.forEach(([x, z], i) => inst.setMatrixAt(i, mtx.makeTranslation(x, WALL_H / 2, z)));
  inst.castShadow = inst.receiveShadow = true;
  room.group.add(inst);

  resetPlayer();
  roomTime = 0;
  state = 'play';
  camTarget.set(player.x, 0, player.z - 1);
  document.getElementById('room').textContent = `ROOM ${index + 1}`;
  updateHud();
}

function openDoors() {
  room.doorOpen = true;
  for (const m of room.doorMeshes) {
    room.group.remove(m);
    const e = new THREE.Mesh(new THREE.PlaneGeometry(0.96, 0.96), exitMat);
    e.rotation.x = -Math.PI / 2;
    e.position.set(m.position.x, 0.02, m.position.z);
    room.group.add(e);
    room.exitMeshes.push(e);
    burst(m.position.x, 0.7, m.position.z, [0x40242a, 0xff2040], 6, 4);
  }
  sfx.door();
  buildFlow();
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

// ---------- 子彈（曳光彈） ----------
const bullets = [];
function spawnBullet(owner, style, x, z, dx, dz, speed, range = 30) {
  const st = TRACER[style];
  const g = new THREE.Group();
  const core = new THREE.Mesh(UNIT_BOX, st.core);
  const glow = new THREE.Mesh(UNIT_BOX, st.glow);
  core.scale.set(0.06, 0.06, 1);
  glow.scale.set(0.2, 0.2, 1);
  g.add(core, glow);
  g.scale.z = 0.001;
  scene.add(g);
  bullets.push({ g, owner, x, z, dx, dz, speed, range, traveled: 0, len: 0, maxLen: st.maxLen, dying: false });
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
        if (wallAt(b.x, b.z)) {
          b.dying = true;
          sparks(b.x - b.dx * 0.1, GUN_Y, b.z - b.dz * 0.1, b.owner === 'p' ? 0xffc060 : 0xff6050, 4, -b.dx, -b.dz);
          if (b.owner === 'p') sfx.wall();
          break;
        }
        if (b.owner === 'p') {
          for (const e of enemies) {
            const ddx = e.x - b.x, ddz = e.z - b.z;
            if (ddx * ddx + ddz * ddz < (e.r + 0.08) ** 2) { b.dying = true; damageEnemy(e, b); break; }
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
function burst(x, y, z, colors, n, power) {
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
      vx: Math.cos(a) * p, vy: 3 + Math.random() * power, vz: Math.sin(a) * p,
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
  man: makeBlockMan({ shirt: 0x2f8cff, pants: 0x23324d, helmet: 0x1f5fa8, gun: 0x1a1a1a }),
  x: 0, z: 0, vx: 0, vz: 0, r: 0.33, fx: 0, fz: -1,
  hits: 0, inv: 0, fireCd: 0, alive: true, laser: makeLaser(0x40d8ff),
};
scene.add(player.man.root);

function resetPlayer() {
  player.vx = player.vz = 0; player.fx = 0; player.fz = -1;
  player.inv = 0.6; player.fireCd = 0; player.alive = true;
  player.man.root.visible = true;
  player.man.root.position.set(player.x, 0, player.z);
}

const muzzleOf = (x, z, fx, fz, s = 1) => ({
  x: x + (fz * 0.2 + fx * 0.67) * s,
  z: z + (-fx * 0.2 + fz * 0.67) * s,
});

const raycaster = new THREE.Raycaster();
const aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -GUN_Y);
const tmpV = new THREE.Vector3(), ndc = new THREE.Vector2();

function updatePlayer(dt) {
  const p = player;
  if (!p.alive) { p.laser.g.visible = false; return; }
  const mode = input.aimMode;
  const firing = mode === 'fire';
  const spd = 5.6 * (firing ? 0.78 : 1);
  const k = 1 - Math.exp(-18 * dt);
  p.vx += (input.move.x * spd - p.vx) * k;
  p.vz += (input.move.y * spd - p.vz) * k;
  p.x += p.vx * dt; p.z += p.vz * dt;
  collide(p, p.r);

  // 瞄準方向
  let ax = 0, az = 0, aiming = mode !== 'none';
  if (aiming) {
    if (input.source === 'touch') { ax = input.aimVec.x; az = input.aimVec.y; }
    else {
      ndc.set(input.mouse.x / innerWidth * 2 - 1, -(input.mouse.y / innerHeight) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      if (raycaster.ray.intersectPlane(aimPlane, tmpV)) {
        ax = tmpV.x - p.x; az = tmpV.z - p.z;
        let d = Math.hypot(ax, az);
        if (d > 0.05) {
          ax /= d; az /= d;
          // 從槍口重新對準游標，讓雷射剛好落在游標上
          const m = muzzleOf(p.x, p.z, ax, az);
          const mx = tmpV.x - m.x, mz = tmpV.z - m.z, md = Math.hypot(mx, mz);
          if (d > 1.2 && md > 0.01) { ax = mx / md; az = mz / md; }
        } else aiming = false;
      } else aiming = false;
    }
  }
  if (aiming) { p.fx = ax; p.fz = az; }
  else if (Math.hypot(input.move.x, input.move.y) > 0.2) {
    const t = Math.atan2(input.move.x, input.move.y), c = Math.atan2(p.fx, p.fz);
    const a = lerpAngle(c, t, 1 - Math.exp(-14 * dt));
    p.fx = Math.sin(a); p.fz = Math.cos(a);
  }

  const m = muzzleOf(p.x, p.z, p.fx, p.fz);
  if (aiming) {
    let len = castRay(m.x, m.z, p.fx, p.fz, 22);
    for (const e of enemies) len = Math.min(len, rayCircle(m.x, m.z, p.fx, p.fz, e.x, e.z, e.r));
    const pulse = 0.85 + Math.sin(now * 30) * 0.15;
    setLaser(p.laser, m.x, m.z, p.fx, p.fz, len, GUN_Y, firing ? 0.35 : 0.8 * pulse, firing ? 0.05 : 0.07);
  } else p.laser.g.visible = false;

  p.fireCd -= dt;
  if (firing && p.fireCd <= 0) {
    p.fireCd = 0.1;
    const sp = (Math.random() - 0.5) * 0.07;
    const c = Math.cos(sp), s = Math.sin(sp);
    const dx = p.fx * c - p.fz * s, dz = p.fx * s + p.fz * c;
    spawnBullet('p', 'player', m.x, m.z, dx, dz, 34);
    muzzleFlash(m.x, GUN_Y, m.z, 0xffc040);
    p.vx -= p.fx * 1.6; p.vz -= p.fz * 1.6;     // 後座力
    addTrauma(0.07);
    sfx.shoot();
  }

  if (p.inv > 0) p.inv -= dt;
  p.man.root.visible = p.inv > 0 ? Math.floor(p.inv * 18) % 2 === 0 : true;
  p.man.root.position.set(p.x, 0, p.z);
  p.man.body.rotation.y = Math.atan2(p.fx, p.fz);
  animateMan(p.man, Math.min(1, Math.hypot(p.vx, p.vz) / 5.6), dt, aiming);

  // 走進出口
  if (room.doorOpen && room.grid[tileR(p.z)]?.[tileC(p.x)] === 'D') nextRoom();
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
  p.laser.g.visible = false;
  burst(p.x, 0.9, p.z, [0x2f8cff, 0x23324d, 0xf0c9a0, 0x1f5fa8, 0x1a1a1a], 22, 6);
  sparks(p.x, 1, p.z, 0xff3030, 20);
  sfx.die();
  slowMo = 1.1;
  state = 'dead';
  setTimeout(() => showOverlay('YOU DIED', `ROOM ${room.index + 1}　被擊中 ${MAX_HITS} 次`, '點擊重來'), 1100);
}

// ---------- 敵人 ----------
const ETYPES = {
  R: { hp: 2, r: 0.36, speed: 4.1, shirt: 0xd8433b, pants: 0x4a1c1c, helmet: null, scale: 1, gun: false },
  S: { hp: 3, r: 0.36, speed: 2.6, shirt: 0xe0892a, pants: 0x3a3022, helmet: 0x6b4a1f, scale: 1, gun: true },
  H: { hp: 9, r: 0.48, speed: 1.7, shirt: 0x7b4fcf, pants: 0x2b2240, helmet: 0x3a2a66, scale: 1.3, gun: true },
};
const enemies = [];
function spawnEnemy(type, x, z, loop) {
  const def = ETYPES[type];
  const man = makeBlockMan({ shirt: def.shirt, pants: def.pants, helmet: def.helmet, scale: def.scale, skin: 0xd9b48c });
  man.gun.visible = def.gun;
  man.root.position.set(x, 0, z);
  scene.add(man.root);
  enemies.push({
    type, def, man, x, z, vx: 0, vz: 0, hp: def.hp + loop, r: def.r,
    fx: 0, fz: 1, state: 'idle', t: 0.7 + Math.random() * 0.6, ax: 0, az: 1, lx: 0, lz: 1,
    burstLeft: 0, strafe: Math.random() < 0.5 ? -1 : 1, flash: 0,
    speedMul: 1 + loop * 0.15, laser: def.gun ? makeLaser(type === 'H' ? 0xc040ff : 0xff2020) : null,
  });
}

function damageEnemy(e, b) {
  e.hp -= 1;
  e.flash = 0.07;
  const kb = e.type === 'H' ? 1.2 : 3.2;
  e.vx += b.dx * kb; e.vz += b.dz * kb;
  sparks(b.x, GUN_Y, b.z, 0xffe080, 5, -b.dx, -b.dz);
  burst(b.x, GUN_Y, b.z, [e.def.shirt], 1, 2);
  if (e.hp <= 0) killEnemy(e, b.dx, b.dz);
  else sfx.hit();
}

function killEnemy(e, dx, dz) {
  const i = enemies.indexOf(e);
  if (i < 0) return;
  enemies.splice(i, 1);
  scene.remove(e.man.root);
  if (e.laser) freeLaser(e.laser);
  const cols = [e.def.shirt, e.def.pants, 0xd9b48c];
  if (e.def.helmet) cols.push(e.def.helmet);
  const n = e.type === 'H' ? 26 : 16;
  burst(e.x + dx * 0.2, 0.9, e.z + dz * 0.2, cols, n, 5);
  for (const d of debris.slice(-n)) { d.vx += dx * 4; d.vz += dz * 4; }  // 碎片往子彈方向噴
  sparks(e.x, 1, e.z, 0xffd060, 12);
  sfx.kill();
  hitStop = Math.max(hitStop, e.type === 'H' ? 0.09 : 0.055);
  addTrauma(e.type === 'H' ? 0.5 : 0.3);
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

function updateEnemies(dt) {
  for (const e of enemies.slice()) {
    if (!enemies.includes(e)) continue;
    e.t -= dt;
    const tx = player.x - e.x, tz = player.z - e.z;
    const dist = Math.hypot(tx, tz) || 0.001;
    const nx = tx / dist, nz = tz / dist;
    const los = player.alive && hasLOS(e.x, e.z, player.x, player.z);
    const spd = e.def.speed * e.speedMul;
    let wx = 0, wz = 0, faceX = e.fx, faceZ = e.fz, aiming = e.def.gun && e.state !== 'idle', direct = false;
    let laserOn = false;

    if (e.type === 'R') {
      switch (e.state) {
        case 'idle': if (e.t <= 0) e.state = 'chase'; break;
        case 'chase': {
          if (!player.alive) break;
          const d = los ? { x: nx, z: nz } : navDir(e);
          wx = d.x * spd; wz = d.z * spd; faceX = d.x; faceZ = d.z;
          if (los && dist < 2.9) { e.state = 'wind'; e.t = 0.32; e.lx = nx; e.lz = nz; sfx.lunge(); }
          break;
        }
        case 'wind':   // 衝刺前蹲一下、發紅 = 預告
          faceX = e.lx; faceZ = e.lz;
          e.man.body.position.x = (Math.random() - 0.5) * 0.08;
          if (e.t <= 0) { e.state = 'dash'; e.t = 0.28; e.man.body.position.x = 0; }
          break;
        case 'dash':
          e.vx = e.lx * 12 * e.speedMul; e.vz = e.lz * 12 * e.speedMul; direct = true;
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
              e.state = 'aim'; e.t = heavy ? 1.1 : 0.85;
              e.ax = nx; e.az = nz; sfx.telegraph();
            } else e.t = 0.3;
          }
          break;
        }
        case 'aim': {
          // 前段追蹤玩家，最後 0.25 秒鎖定 → 玩家有機會閃
          if (e.t > 0.25) [e.ax, e.az] = rotateToward(e.ax, e.az, nx, nz, (heavy ? 1.6 : 2.4) * dt);
          faceX = e.ax; faceZ = e.az; laserOn = true;
          if (e.t <= 0) { e.state = 'fire'; e.burstLeft = heavy ? 2 : 3; e.t = 0; }
          break;
        }
        case 'fire': {
          faceX = e.ax; faceZ = e.az;
          if (e.t <= 0 && e.burstLeft > 0) {
            const m = muzzleOf(e.x, e.z, e.ax, e.az, e.def.scale);
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
          }
          if (e.burstLeft <= 0 && e.t <= 0) {
            e.state = 'move'; e.t = 1.0 + Math.random() * 0.9;
            if (Math.random() < 0.5) e.strafe *= -1;
          }
          break;
        }
      }
      if (e.laser) {
        if (laserOn) {
          const m = muzzleOf(e.x, e.z, e.ax, e.az, e.def.scale);
          let len = castRay(m.x, m.z, e.ax, e.az, 22);
          if (player.alive) len = Math.min(len, rayCircle(m.x, m.z, e.ax, e.az, player.x, player.z, player.r));
          const locked = e.t <= 0.25;
          const prog = 1 - e.t / (heavy ? 1.1 : 0.85);
          const blink = locked ? (Math.floor(e.t * 40) % 2 ? 1 : 0.35) : 1;
          setLaser(e.laser, m.x, m.z, e.ax, e.az, len, GUN_Y * e.def.scale,
            (0.3 + prog * 0.6) * blink, locked ? 0.12 : 0.05 + prog * 0.04);
        } else e.laser.g.visible = false;
      }
    }

    if (!direct) {
      const k = 1 - Math.exp(-10 * dt);
      e.vx += (wx - e.vx) * k; e.vz += (wz - e.vz) * k;
    }
    e.x += e.vx * dt; e.z += e.vz * dt;
    // 互相推開
    for (const o of enemies) {
      if (o === e) continue;
      const dx = e.x - o.x, dz = e.z - o.z, d = Math.hypot(dx, dz), min = e.r + o.r;
      if (d < min && d > 1e-4) { const p = (min - d) / d * 0.5; e.x += dx * p; e.z += dz * p; }
    }
    if (player.alive && e.type !== 'R') {
      const dx = e.x - player.x, dz = e.z - player.z, d = Math.hypot(dx, dz), min = e.r + player.r;
      if (d < min && d > 1e-4) { const p = (min - d) / d; e.x += dx * p; e.z += dz * p; }
    }
    collide(e, e.r);

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
  }
}

// ---------- 遊戲流程 ----------
let state = 'title', roomTime = 0, hitStop = 0, slowMo = 0, trauma = 0, now = 0;
const camTarget = new THREE.Vector3();
const flashEl = document.getElementById('flash');
const fadeEl = document.getElementById('fade');
const overlay = document.getElementById('overlay');

function clearEntities() {
  for (const e of enemies) { scene.remove(e.man.root); if (e.laser) freeLaser(e.laser); }
  enemies.length = 0;
  for (const b of bullets) scene.remove(b.g);
  bullets.length = 0;
  for (const d of debris) scene.remove(d.m);
  debris.length = 0;
  for (const f of fx) { scene.remove(f.m); f.m.material.dispose(); }
  fx.length = 0;
}

function nextRoom() {
  if (state !== 'play') return;
  state = 'transition';
  player.laser.g.visible = false;
  fadeEl.style.opacity = 1;
  setTimeout(() => { loadRoom(room.index + 1); fadeEl.style.opacity = 0; }, 260);
}

function updateHud() {
  const el = document.getElementById('hits');
  el.innerHTML = '';
  for (let i = 0; i < MAX_HITS; i++) {
    const d = document.createElement('div');
    d.className = 'pip' + (i < player.hits ? ' lost' : '');
    el.appendChild(d);
  }
}

function showOverlay(title, text, hint) {
  document.getElementById('ovTitle').textContent = title;
  document.getElementById('ovText').innerHTML = text;
  document.getElementById('ovHint').textContent = hint;
  overlay.classList.remove('hidden');
}

overlay.addEventListener('pointerdown', e => {
  e.preventDefault();
  unlockAudio();
  if (state === 'title') {
    overlay.classList.add('hidden');
    player.hits = 0;
    loadRoom(0);
  } else if (state === 'dead') {
    overlay.classList.add('hidden');
    player.hits = 0;   // 死了就在同一間重來，被彈次數歸零
    loadRoom(room.index);
  }
});

const input = new Input(container);
input.onFireStage = src => { if (src === 'touch') navigator.vibrate?.(8); };

function addTrauma(v) { trauma = Math.min(1, trauma + v); }

window.__dbg = { player, enemies, bullets };  // 除錯用

// 預先放一個房間當標題背景
loadRoom(0);
state = 'title';

let last = performance.now();
function frame(t) {
  requestAnimationFrame(frame);
  const raw = Math.min(0.05, (t - last) / 1000);
  last = t;
  now += raw;
  input.update();

  let dt = window.__dbg.paused ? 0 : raw;
  if (hitStop > 0) { hitStop -= raw; dt = 0; }
  if (slowMo > 0) { slowMo -= raw; dt *= 0.3; }

  if (dt > 0 && (state === 'play' || state === 'dead')) {
    roomTime += dt;
    flowTimer -= dt;
    if (flowTimer <= 0 && player.alive) { buildFlow(); flowTimer = 0.2; }
    updatePlayer(dt);
    updateEnemies(dt);
    updateBullets(dt);
    if (state === 'play' && !room.doorOpen && enemies.length === 0) openDoors();
  }
  if (dt > 0) updateParticles(dt);

  // 出口閃爍
  for (const m of room.exitMeshes) m.material.opacity = 0.35 + Math.sin(now * 6) * 0.2;

  // 攝影機：跟玩家、往瞄準方向前探、直式時讓角色偏下方
  const aimingNow = player.alive && player.laser.g.visible;
  const portrait = innerHeight > innerWidth;
  const lx = player.x + (aimingNow ? player.fx * 1.8 : 0);
  const lz = player.z + (aimingNow ? player.fz * 1.8 : 0) - (portrait ? 1.6 : 0.5);
  camTarget.x += (lx - camTarget.x) * (1 - Math.exp(-6 * raw));
  camTarget.z += (lz - camTarget.z) * (1 - Math.exp(-6 * raw));
  trauma = Math.max(0, trauma - raw * 1.8);
  const sh = trauma * trauma * 0.55;
  const ox = (Math.random() - 0.5) * sh, oz = (Math.random() - 0.5) * sh;
  camera.position.set(camTarget.x + ox, Math.sin(CAM_PITCH) * camDist, camTarget.z + Math.cos(CAM_PITCH) * camDist + oz);
  camera.lookAt(camTarget.x + ox, 0, camTarget.z + oz);
  sun.position.set(camTarget.x - 6, 16, camTarget.z + 4);
  sun.target.position.set(camTarget.x, 0, camTarget.z);

  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

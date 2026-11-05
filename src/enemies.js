import { sfx } from './audio.js';
import { makeBlockMan, animateMan, setFlash, addGlowEyes } from './models.js';
import { buildWeapon, WEAPON_PAL } from './weapons.js';
import { buildVoxelMesh } from './voxel.js';
import { BODY_LIGHT_R, FLASH_ANGLE, FLASH_RANGE, G, GUN_Y, addTrauma, scene } from './core.js';
import { burst, freeBar, makeBar, muzzleFlash, setBar, showMarker, sparks, voxelBurst } from './fx.js';
import { H, LAMP_R, W, bangDoor, collide, destroyDoor, doorAt, findCoverPath, hasLOS, level, navDir, seekDir, smashArea, soundField, tileC, tileR, zflow } from './world.js';
import { spawnPellet } from './bullets.js';
import { hurtPlayer, muzzleOf, player } from './player.js';

// ---------- 敵人 ----------
// mag = 幾輪攻擊後要換彈；seekCover = 換彈時躲到玩家看不到的地方；react = 發現玩家後幾秒才行動
export const ETYPES = {
  R: { hp: 60, r: 0.36, speed: 4.1, shirt: 0xd8433b, pants: 0x4a1c1c, helmet: null, scale: 1, gun: false, react: 0.45 },
  S: { hp: 100, r: 0.36, speed: 2.6, shirt: 0xe0892a, pants: 0x3a3022, helmet: 0x6b4a1f, scale: 1, gun: true,
    mag: 3, reload: 1.7, seekCover: true, react: 0.55, pats: ['burst', 'spread3'],
    build: { caliber: '556', receiver: 'carbine', stock: 'fold', mag: 'std', barrel: 'std', grip: 'none' } },
  H: { hp: 320, r: 0.48, speed: 1.7, shirt: 0x7b4fcf, pants: 0x2b2240, helmet: 0x3a2a66, scale: 1.3, gun: true,
    mag: 3, reload: 2.4, seekCover: false, react: 0.75, pats: ['fan', 'ring', 'homing'],
    build: { caliber: '9mm', receiver: 'smg', stock: 'full', mag: 'drum', barrel: 'long', grip: 'vert' } },
  // 黑暗模式：殭屍只會走過來碰你；巨型殭屍會衝撞，衝撞路上的殭屍會被撞開
  Z: { hp: 60, r: 0.34, speed: 1.7, shirt: 0x56606a, pants: 0x2e3328, helmet: null, scale: 1, gun: false, react: 0.35,
    zombie: true, skin: 0x8aa37a, eye: 0xd8ff50, sight: 8, kb: 3.4 },
  G: { hp: 420, r: 0.56, speed: 1.9, shirt: 0x3a3440, pants: 0x24202a, helmet: null, scale: 1.5, gun: false, react: 0.5,
    zombie: true, skin: 0x9a9888, eye: 0xff3a20, sight: 9, kb: 0.5, mass: 4 },
};
export const ZOMBIE_SHIRTS = [0x56606a, 0x6a4f42, 0x46543a, 0x5c5c66, 0x70604a];
export const enemyGuns = {};   // 每種敵人的槍只算一次方塊
export const enemyGunOf = type => enemyGuns[type] ??= buildWeapon(ETYPES[type].build);
export const enemies = [];
export function spawnEnemy(type, x, z, loop, aware) {
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
    burstLeft: 0, pat: Math.floor(Math.random() * 3), strafe: Math.random() < 0.5 ? -1 : 1, flash: 0,
    speedMul: (1 + loop * 0.15) * (type === 'Z' ? 0.85 + Math.random() * 0.3 : 1),
    seed: Math.random() * 10, cd: 0, stun: 0, vis: 1, blink: 2 + Math.random() * 4, wander: 0, wx: 0, wz: 0,
    bar: def.gun ? makeBar(0xffd23a) : null,
  };
  man.body.rotation.y = a;
  enemies.push(e);
}

export function becomeAware(e) {
  if (e.aware) return;
  e.aware = true;
  e.state = e.type === 'R' || e.def.zombie ? 'chase' : 'move';
  e.t = 0.15 + Math.random() * 0.3;
  if (!e.def.zombie) {
    showMarker(e); sfx.alert();
    // 喊人：附近（聲音傳得到）的同伴也跟著警戒；被喊醒的不會再往外喊
    if (!e.byShout) alertNoise(SHOUT_RANGE, e.x, e.z, true);
    return;
  }
  // 殭屍：發出低吼，附近看得到牠的同伴跟著醒來
  if (G.now - G.lastGroan > 0.35) { G.lastGroan = G.now; e.type === 'G' ? sfx.roar() : sfx.groan(); }
  for (const o of enemies) {
    if (o.aware || o.react >= 0 || !o.def.zombie) continue;
    if (Math.hypot(o.x - e.x, o.z - e.z) < 4.5 && hasLOS(o.x, o.z, e.x, e.z)) o.react = 0.25 + Math.random() * 0.5;
  }
}
// 槍聲 / 破門聲 / 喊人：沿著走得到的路傳，關著的門會悶住一些（見 soundField）
// 聽到的敵人過一下就進入警戒，往聲音來源（玩家）移動；路被門擋住就在門後守著
export const SHOUT_RANGE = 10;
export function alertNoise(range, x = player.x, z = player.z, shout = false) {
  if (!enemies.some(e => !e.aware && e.react < 0)) return;
  const f = soundField(x, z, range);
  for (const e of enemies) {
    if (e.aware || e.react >= 0) continue;
    const c = tileC(e.x), r = tileR(e.z);
    const d = c >= 0 && r >= 0 && c < W && r < H ? f[c + r * W] : -1;
    // 殭屍比較遲鈍，隔著門比較聽不到
    if (d < 0 || d > (e.def.zombie ? range * 0.7 : range)) continue;
    e.react = e.def.react * (shout ? 1.2 : 0.9) + Math.random() * (shout ? 0.6 : 0.4) + d * 0.03;
    e.byShout = shout;
  }
}

export function damageEnemy(e, b) {
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

export function freeEnemy(e) {
  e.dead = true;
  scene.remove(e.man.root);
  if (e.bar) freeBar(e.bar);
}

export function killEnemy(e, dx, dz) {
  const i = enemies.indexOf(e);
  if (i < 0) return;
  enemies.splice(i, 1);
  voxelBurst(e.man.root, Math.round(45 * e.def.scale ** 1.5), 4, dx * 4, dz * 4);   // 身上的方塊往子彈方向噴
  freeEnemy(e);
  sparks(e.x, 1, e.z, 0xffd060, 12);
  sfx.kill();
  const big = e.def.scale > 1.2;
  G.hitStop = Math.max(G.hitStop, big ? 0.09 : e.type === 'Z' ? 0.035 : 0.055);
  addTrauma(big ? 0.5 : e.type === 'Z' ? 0.18 : 0.3);
}

export function rotateToward(ax, az, tx, tz, maxA) {
  const a = Math.atan2(ax, az), t = Math.atan2(tx, tz);
  let d = t - a;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  const n = a + Math.max(-maxA, Math.min(maxA, d));
  return [Math.sin(n), Math.cos(n)];
}
export function lerpAngle(a, b, k) {
  let d = b - a;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return a + d * k;
}

export function startEnemyReload(e) {
  e.state = 'reload';
  e.t = e.def.reload;
  e.coverPath = e.def.seekCover ? findCoverPath(e) : null;
  sfx.enemyReload();
}

// ---------- 彈幕 ----------
// 每種攻擊：waves 幾波、gap 每波間隔（秒）；fire 回傳下一波前的等待時間
// 射手：瞄準三連發 / 三向散射；重砲手輪流：扇形、環形、追蹤彈
const rot = (dx, dz, a) => [dx * Math.cos(a) + dz * Math.sin(a), -dx * Math.sin(a) + dz * Math.cos(a)];
export const PATTERNS = {
  burst: { waves: 3, gap: 0.17, fire(e, m, k) {
    const [dx, dz] = rot(e.ax, e.az, (Math.random() - 0.5) * 0.08);
    spawnPellet('enemy', m.x, m.z, dx, dz, 6.5 * k);
    sfx.enemyShoot();
  } },
  spread3: { waves: 2, gap: 0.45, fire(e, m, k) {
    for (let i = -1; i <= 1; i++) { const [dx, dz] = rot(e.ax, e.az, i * 0.26); spawnPellet('enemy', m.x, m.z, dx, dz, 6 * k); }
    sfx.enemyShoot();
  } },
  fan: { waves: 2, gap: 0.55, fire(e, m, k, wave) {
    const n = 9, off = wave % 2 ? 0.075 : 0;   // 第二波錯開半格，留縫給你鑽
    for (let i = 0; i < n; i++) { const [dx, dz] = rot(e.ax, e.az, (i - (n - 1) / 2) * 0.15 + off); spawnPellet('heavy', m.x, m.z, dx, dz, 4.8 * k); }
    sfx.heavyShoot(); e.vx -= e.ax * 2; e.vz -= e.az * 2;
  } },
  ring: { waves: 3, gap: 0.42, fire(e, m, k, wave) {
    const n = 18, a0 = Math.atan2(e.ax, e.az) + (wave % 2) * Math.PI / n;
    for (let i = 0; i < n; i++) {
      const a = a0 + i * Math.PI * 2 / n, dx = Math.sin(a), dz = Math.cos(a);
      spawnPellet('heavy', e.x + dx * 0.55, e.z + dz * 0.55, dx, dz, 4 * k);
    }
    sfx.heavyShoot();
  } },
  homing: { waves: 1, gap: 0.6, fire(e, m, k) {
    for (let i = -1; i <= 1; i++) { const [dx, dz] = rot(e.ax, e.az, i * 0.7); spawnPellet('homing', m.x, m.z, dx, dz, 3.6 * k, { home: 1.7, homeT: 1.8, range: 14 }); }
    sfx.heavyShoot();
  } },
};
function firePattern(e, m, name) {
  const p = PATTERNS[name];
  const wave = p.waves - e.burstLeft;
  p.fire(e, m, Math.min(1.4, e.speedMul), wave);
  return p.gap;
}
function startAttack(e, nx, nz) {
  const pats = e.def.pats;
  e.pat = e.type === 'H' ? (e.pat + 1) % pats.length : (Math.random() < 0.65 ? 0 : 1);
  e.state = 'fire'; e.t = 0;
  e.ax = nx; e.az = nz;
  e.burstLeft = PATTERNS[pats[e.pat]].waves;
}

export function updateEnemies(dt) {
  for (const e of enemies.slice()) {
    if (!enemies.includes(e)) continue;
    e.t -= dt;
    const tx = player.x - e.x, tz = player.z - e.z;
    const dist = Math.hypot(tx, tz) || 0.001;
    const nx = tx / dist, nz = tz / dist;
    const los = player.alive && hasLOS(e.x, e.z, player.x, player.z);
    const spd = e.def.speed * e.speedMul;
    let wx = 0, wz = 0, faceX = e.fx, faceZ = e.fz, aiming = false, direct = false;

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
        const s = spd * (0.75 + 0.35 * Math.max(0, Math.sin(G.now * 3 + e.seed)));   // 一頓一頓地拖著走
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
          const d = los ? { x: nx, z: nz } : seekDir(e);
          const ds = d.hold ? 0 : spd;
          wx = d.x * ds; wz = d.z * ds; faceX = d.x; faceZ = d.z;
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
          if (!los || dist > 9) d = seekDir(e);
          else if (dist < 3.8) d = { x: -nx, z: -nz };
          else d = { x: -nz * e.strafe + nx * 0.2, z: nx * e.strafe + nz * 0.2 };
          const ds = d.hold ? 0 : spd;   // 門後守著
          wx = d.x * ds; wz = d.z * ds;
          if (los) { faceX = nx; faceZ = nz; } else { faceX = d.x; faceZ = d.z; }
          if (e.t <= 0) {
            if (los && dist < 13) startAttack(e, nx, nz);
            else e.t = 0.3;
          }
          break;
        }
        case 'fire': {
          // 一輪攻擊 = 好幾波彈丸；每一波重新對準玩家。射手邊打邊慢慢橫移，重砲手站定
          if (los) { e.ax = nx; e.az = nz; }
          faceX = e.ax; faceZ = e.az;
          if (!heavy) { wx = -e.az * e.strafe * spd * 0.3; wz = e.ax * e.strafe * spd * 0.3; }
          if (e.t <= 0 && e.burstLeft > 0) {
            const m = muzzleOf(e.x, e.z, e.ax, e.az, e.def.scale, e.muzzleFwd);
            e.t = firePattern(e, m, e.def.pats[e.pat]);
            muzzleFlash(m.x, GUN_Y * e.def.scale, m.z, heavy ? 0xc060ff : 0xff5030);
            e.burstLeft--;
            if (G.now - (e.lastShot ?? -9) > 1) alertNoise(heavy ? 16 : 14, e.x, e.z);
            e.lastShot = G.now;
          }
          if (e.burstLeft <= 0 && e.t <= 0) {
            e.ammo--;
            if (e.ammo <= 0) startEnemyReload(e);
            else {
              e.state = 'move'; e.t = (heavy ? 1.0 : 0.8) + Math.random() * 0.9;
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
      // 撞到可破壞的東西或鐵捲門就撞破，暈得比較短
      const ix = e.x + e.lx * (e.r + 0.4), iz = e.z + e.lz * (e.r + 0.4);
      const door = doorAt(tileC(e.x + e.lx * (e.r + 0.15)), tileR(e.z + e.lz * (e.r + 0.15)));
      let broke = smashArea(ix, iz, 0.8, e.lx, e.lz) > 0;
      if (door && !door.open) { destroyDoor(door, e.lx, e.lz); broke = true; }
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
export function isLit(x, z, rad = 0) {
  if (player.alive) {
    const dx = x - player.x, dz = z - player.z, d = Math.hypot(dx, dz);
    if (d < BODY_LIGHT_R + rad) return true;
    if (G.muzzleGlow > 0 && d < 5.5 && hasLOS(player.x, player.z, x, z)) return true;
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
export function updateEnemyVisibility(e, dt) {
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

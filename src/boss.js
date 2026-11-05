// ---------- 頭目（暫定） ----------
// 超巨大的方塊人，輪流用各種攻擊（不會連續兩次同一招）；子彈顏色 = 那一招在小兵身上的顏色
//   連射（紅）：瞄準的三向彈，打好幾波
//   扇形（紫）：七發扇形，兩波交錯
//   環形（黃）：一圈彈丸，每圈轉半格
//   螺旋（青）：站著不動，兩條（暴怒三條）旋轉彈流
//   狙擊（綠雷射）：雷射預告後一發快速彈，連打 2～3 發
//   衝撞：發紅蓄力後直線衝過來，撞牆會暈
//   召喚：血量掉到 2/3、1/3 時，叫兩個小兵從地板組裝出來
// 血量剩一半以下暴怒：招式間隔變短、彈丸變多
// 登場：組裝比一般敵人久，畫面上方的血條跟著一格一格組起來；受傷時掉的那幾格會碎掉噴開
import { sfx } from './audio.js';
import { G, GUN_Y, addTrauma } from './core.js';
import { burst, muzzleFlash, setLaser, sparks } from './fx.js';
import { castRay, isWallTile, rayCircle, seekDir, tileC, tileR } from './world.js';
import { spawnBullet, spawnPellet } from './bullets.js';
import { hurtPlayer, muzzleOf, player } from './player.js';
import { enemies, killEnemy, rotateToward, spawnEnemy } from './enemies.js';
import { showToast } from './main.js';

export const BOSS_ASSEMBLE = 3.4;
const ATTACKS = ['volley', 'fan', 'ring', 'spiral', 'snipe', 'charge'];
const rot = (dx, dz, a) => [dx * Math.cos(a) + dz * Math.sin(a), -dx * Math.sin(a) + dz * Math.cos(a)];

export function spawnBoss(x, z, hp) {
  const e = spawnEnemy('B', x, z, 0, true, { assemble: BOSS_ASSEMBLE, hp });
  e.boss = { atk: null, last: null, n: 0, ang: 0, summoned: 0 };
  bossBarStart(e.def.name);
  e.onAssemble = k => {
    bossBarFill(k);
    if (k >= 1) bossBarReady();
  };
  showToast('頭目出現', 'breach');
  sfx.roar();
  return e;
}

// 回傳這一幀想怎麼動，給 updateEnemies 統一處理移動、碰撞、轉身
export function updateBoss(e, dt, nx, nz, dist, los, spd) {
  const B = e.boss, rage = e.hp < e.maxHp * 0.5;
  const o = { wx: 0, wz: 0, faceX: nx, faceZ: nz, aiming: true, direct: false };
  let laserOn = false;
  e.bar.g.visible = false;
  e.man.gun.rotation.x = 0;
  const m = () => muzzleOf(e.x, e.z, e.ax, e.az, e.def.scale, e.muzzleFwd);
  const s = rage ? 1.15 : 1;   // 暴怒時彈速快一點點

  switch (e.state) {
    case 'idle': case 'move': {
      // 保持中距離，繞著玩家慢慢橫移
      let d;
      if (!los) d = seekDir(e);
      else if (dist > 8) d = { x: nx, z: nz };
      else if (dist < 4.5) d = { x: -nx, z: -nz };
      else d = { x: -nz * e.strafe + nx * 0.15, z: nx * e.strafe + nz * 0.15 };
      const ds = d.hold ? 0 : spd * (rage ? 1.2 : 1);
      o.wx = d.x * ds; o.wz = d.z * ds;
      if (e.t <= 0 && player.alive) pickAttack(e, B, rage, nx, nz, dist, los);
      break;
    }
    case 'atk': {
      o.faceX = e.ax; o.faceZ = e.az;
      if (e.t > 0) break;
      const left = --B.n;
      switch (B.atk) {
        case 'volley': {
          if (los) { e.ax = nx; e.az = nz; }
          const mm = m();
          for (let i = -1; i <= 1; i++) { const [dx, dz] = rot(e.ax, e.az, i * 0.2 + (Math.random() - 0.5) * 0.05); spawnPellet('enemy', mm.x, mm.z, dx, dz, 6.2 * s); }
          muzzleFlash(mm.x, GUN_Y * e.def.scale, mm.z, 0xff4030);
          sfx.enemyShoot();
          e.t = 0.3;
          break;
        }
        case 'fan': {
          if (los) { e.ax = nx; e.az = nz; }
          const mm = m(), off = left % 2 ? 0.08 : -0.08;
          for (let i = 0; i < 7; i++) { const [dx, dz] = rot(e.ax, e.az, (i - 3) * 0.17 + off); spawnPellet('heavy', mm.x, mm.z, dx, dz, 4.6 * s); }
          muzzleFlash(mm.x, GUN_Y * e.def.scale, mm.z, 0x9a50ff);
          sfx.heavyShoot(); e.vx -= e.ax * 1.5; e.vz -= e.az * 1.5;
          e.t = 0.65;
          break;
        }
        case 'ring': {
          const n = rage ? 16 : 14, a0 = Math.atan2(nx, nz) + Math.PI / n * (1 + (left % 2));
          for (let i = 0; i < n; i++) {
            const a = a0 + i * Math.PI * 2 / n, dx = Math.sin(a), dz = Math.cos(a);
            spawnPellet('ring', e.x + dx * 1.2, e.z + dz * 1.2, dx, dz, 4.0 * s);
          }
          sfx.heavyShoot(); addTrauma(0.08);
          e.t = 0.75;
          break;
        }
        case 'spiral': {
          const arms = rage ? 3 : 2;
          B.ang += 0.3 * B.dir;
          for (let k = 0; k < arms; k++) {
            const a = B.ang + k * Math.PI * 2 / arms, dx = Math.sin(a), dz = Math.cos(a);
            spawnPellet('spread', e.x + dx * 1.2, e.z + dz * 1.2, dx, dz, 4.3 * s);
          }
          if (left % 3 === 0) sfx.enemyShoot();
          e.t = 0.12;
          break;
        }
      }
      if (B.n <= 0) endAttack(e, rage);
      break;
    }
    case 'aim': {
      // 狙擊：前段跟著轉，最後 0.3 秒鎖定（雷射閃）→ 側移就閃得掉
      if (e.t > 0.3) [e.ax, e.az] = rotateToward(e.ax, e.az, nx, nz, 1.6 * dt);
      o.faceX = e.ax; o.faceZ = e.az; laserOn = true;
      if (e.t <= 0) {
        const mm = m();
        spawnBullet('e', 'enemy', mm.x, mm.z, e.ax, e.az, 26, 30);
        muzzleFlash(mm.x, GUN_Y * e.def.scale, mm.z, 0x80ff50);
        sfx.enemyShoot();
        if (--B.n > 0) { e.t = 0.6; e.aimT = 0.6; sfx.telegraph(); }
        else endAttack(e, rage);
      }
      break;
    }
    case 'wind':
      // 衝撞蓄力：前段跟著轉，最後 0.3 秒鎖定方向（身體閃紅由 updateEnemies 處理）
      if (e.t > 0.3) [e.lx, e.lz] = rotateToward(e.lx, e.lz, nx, nz, 2 * dt);
      o.faceX = e.lx; o.faceZ = e.lz;
      e.man.body.position.x = (Math.random() - 0.5) * 0.15;
      if (e.t <= 0) { e.state = 'dash'; e.t = 0.55; e.man.body.position.x = 0; addTrauma(0.2); }
      break;
    case 'dash':
      e.vx = e.lx * 11; e.vz = e.lz * 11; o.direct = true;
      o.faceX = e.lx; o.faceZ = e.lz;
      if (e.t <= 0) { e.state = 'recover'; e.t = 0.7; }
      break;
    case 'recover':
      if (e.t <= 0) { e.state = 'move'; e.t = rage ? 0.6 : 1.0; }
      break;
    case 'summon':
      if (e.t <= 0) endAttack(e, rage);
      break;
  }

  // 碰到就受傷（衝撞中撞到會被撞飛）
  if (player.alive && player.inv <= 0 && dist < e.r + player.r + 0.08) {
    hurtPlayer(nx, nz);
    const f = e.state === 'dash' ? 9 : 5;
    player.vx += nx * f; player.vz += nz * f;
    if (e.state === 'dash') { e.state = 'recover'; e.t = 0.8; e.vx = e.vz = 0; }
  }

  if (laserOn) {
    const mm = m();
    let len = castRay(mm.x, mm.z, e.ax, e.az, 26);
    if (player.alive) len = Math.min(len, rayCircle(mm.x, mm.z, e.ax, e.az, player.x, player.z, player.r));
    const locked = e.t <= 0.3, prog = 1 - e.t / (e.aimT ?? e.def.aimTime);
    const blink = locked ? (Math.floor(e.t * 40) % 2 ? 1 : 0.35) : 1;
    setLaser(e.laser, mm.x, mm.z, e.ax, e.az, len, GUN_Y * e.def.scale, (0.3 + prog * 0.6) * blink, locked ? 0.16 : 0.06 + prog * 0.06);
  } else e.laser.g.visible = false;
  return o;
}

function pickAttack(e, B, rage, nx, nz, dist, los) {
  e.ax = nx; e.az = nz;
  // 血量掉到 2/3、1/3：先叫小兵
  const th = e.hp < e.maxHp / 3 ? 2 : e.hp < e.maxHp * 2 / 3 ? 1 : 0;
  if (B.summoned < th) {
    B.summoned++;
    summon(e);
    e.state = 'summon'; e.t = 1.2;
    return;
  }
  let pool = ATTACKS.filter(a => a !== B.last);
  if (!los) pool = pool.filter(a => a === 'ring' || a === 'spiral');
  if (dist > 10) pool = pool.filter(a => a !== 'charge');
  const atk = pool[Math.floor(Math.random() * pool.length)] ?? 'ring';
  B.last = B.atk = atk;
  switch (atk) {
    case 'volley': B.n = rage ? 5 : 4; break;
    case 'fan': B.n = rage ? 3 : 2; break;
    case 'ring': B.n = rage ? 3 : 2; break;
    case 'spiral': B.n = rage ? 22 : 18; B.ang = Math.atan2(nx, nz); B.dir = Math.random() < 0.5 ? -1 : 1; break;
    case 'snipe': B.n = rage ? 3 : 2; e.state = 'aim'; e.t = e.aimT = e.def.aimTime; sfx.telegraph(); return;
    case 'charge': e.state = 'wind'; e.t = rage ? 0.75 : 0.95; e.lx = nx; e.lz = nz; sfx.roar(); return;
  }
  e.state = 'atk'; e.t = 0.35;   // 出招前頓一下
}
function endAttack(e, rage) {
  e.state = 'move';
  e.t = (rage ? 0.8 : 1.3) + Math.random() * 0.6;
  if (Math.random() < 0.5) e.strafe *= -1;
}
function summon(e) {
  sfx.roar(); addTrauma(0.3);
  for (const side of [-1, 1]) {
    // 頭目兩側的空地（牆裡就往內縮）
    for (const d of [2.4, 1.7]) {
      const x = e.x - e.fz * side * d, z = e.z + e.fx * side * d;
      if (isWallTile(tileC(x), tileR(z))) continue;
      spawnEnemy(Math.random() < 0.5 ? 'R' : 'S', x, z, 0, true, { assemble: true });
      break;
    }
  }
}

export function bossKilled(e) {
  G.slowMo = Math.max(G.slowMo, 1.2);
  addTrauma(0.9);
  sparks(e.x, 2, e.z, 0xff4050, 30);
  burst(e.x, 1.5, e.z, [0x34343f, 0xc02a3a, 0x1c1c24], 18, 7);
  bossBarSet(0);
  setTimeout(bossBarHide, 900);
  // 召喚出來的小兵跟著倒
  setTimeout(() => { for (const o of enemies.slice()) if (o !== e) killEnemy(o, 0, 0); }, 350);
}

// ---------- 頭目血條（畫面上方，一格一格的方塊） ----------
const SEGS = 30;
const barEl = document.getElementById('bossBar');
const segBox = barEl?.querySelector('.bb-segs');
let segs = [], shown = 0, lastF = 1, chipT = 0;
export function bossBarStart(name) {
  if (!barEl) return;
  barEl.querySelector('.bb-name').textContent = name;
  segBox.innerHTML = '';
  segs = Array.from({ length: SEGS }, () => {
    const d = document.createElement('div');
    d.className = 'bb-seg';
    d.innerHTML = '<i></i>';
    segBox.appendChild(d);
    return d;
  });
  shown = 0; lastF = 1;
  barEl.classList.remove('hidden', 'ready');
  document.body.classList.add('boss-on');
}
// 登場時：從左到右一格一格組起來
export function bossBarFill(k) {
  const n = Math.min(SEGS, Math.floor(Math.max(0, (k - 0.1) / 0.85) * SEGS + 0.001));
  while (shown < n) segs[shown++].classList.add('on');
}
function bossBarReady() {
  while (shown < SEGS) segs[shown++]?.classList.add('on');
  barEl?.classList.add('ready');
}
export function bossBarHide() { barEl?.classList.add('hidden'); document.body.classList.remove('boss-on'); }
export function hideBossBarNow() { bossBarHide(); segs = []; }

// 受傷：掉光的格子碎掉噴開；最後一格依剩餘比例縮短，打到時噴一點碎屑
export function bossBarSet(f) {
  if (!segs.length) return;
  const exact = f * SEGS, full = Math.ceil(exact - 1e-6);
  for (let i = full; i < SEGS; i++) {
    const s = segs[i];
    if (!s.classList.contains('on') || s.classList.contains('broken')) continue;
    s.classList.add('broken');
    shatter(s, 7, 1);
  }
  const cur = segs[full - 1];
  if (cur) {
    cur.style.setProperty('--f', Math.max(0.08, exact - (full - 1)).toFixed(3));
    if (f < lastF && G.now - chipT > 0.05) { chipT = G.now; shatter(cur, 2, 0.45); }
  }
  lastF = f;
}
function shatter(seg, n, power) {
  const r = seg.getBoundingClientRect(), br = barEl.getBoundingClientRect();
  for (let i = 0; i < n; i++) {
    const p = document.createElement('div');
    p.className = 'bb-shard';
    const sz = 3 + Math.random() * 5 * power;
    p.style.cssText = `left:${r.left - br.left + Math.random() * r.width}px;top:${r.top - br.top + Math.random() * r.height}px;width:${sz}px;height:${sz}px;` +
      `--dx:${((Math.random() - 0.5) * 90 * power).toFixed(0)}px;--dy:${(-20 - Math.random() * 60 * power).toFixed(0)}px;--r:${((Math.random() - 0.5) * 720).toFixed(0)}deg`;
    p.addEventListener('animationend', () => p.remove());
    barEl.appendChild(p);
  }
}

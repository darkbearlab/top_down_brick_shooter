import * as THREE from 'three';
import { sfx } from './audio.js';
import { makeBlockMan, animateMan, setFlash, setHand } from './models.js';
import { computeStats, buildWeapon, swapTime, WEAPON_PAL } from './weapons.js';
import { buildVoxelMesh } from './voxel.js';
import { DEG, G, GUN_Y, MAX_HITS, addTrauma, camera, input, scene } from './core.js';
import { burst, fx, makeBar, makeLaser, muzzleFlash, setBar, setLaser, sparks, voxelBurst } from './fx.js';
import { castRay, collide, hostageReady, level, levelLabel, nearestColumn, rayCircle, smashCell, tileC, tileR } from './world.js';
import { spawnBullet } from './bullets.js';
import { alertNoise, enemies } from './enemies.js';
import { flashEl, showToast, leaveLabel, leaveLevel, nextLevel, retryLevel, showPanel, updateAmmoHud, updateHud } from './main.js';

// ---------- 玩家 ----------
export const player = {
  man: makeBlockMan({ shirt: 0x2f8cff, pants: 0x23324d, helmet: 0x1f5fa8 }),
  x: 0, z: 0, vx: 0, vz: 0, r: 0.33, fx: 0, fz: -1,
  aimA: Math.PI, recoil: 0, kickSign: 1,   // aimA = 實際槍口角度；recoil = 後座力造成的偏移
  hits: 0, inv: 0, fireCd: 0, alive: true, kick: 0,
  slots: [], cur: 0, swapT: 0, swapDur: 1, swapped: true,
  laser: makeLaser(0x40d8ff), guide: makeLaser(0xffffff), bar: makeBar(0x5adcff),
};
scene.add(player.man.root);
export const swapTimeOf = () => swapTime(player.slots.map(s => s.stats));
export const curSlot = () => player.slots[player.cur];

// 依裝備建出兩把槍的方塊模型；手上一把、背上一把
export function equipLoadout(lo) {
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
export function mountWeapons() {
  const m = player.man;
  player.slots.forEach((s, i) => {
    if (i === player.cur) { m.gun.add(s.mesh); m.gun.position.y = GUN_Y - s.muzzleY; }
    else m.back.add(s.mesh);
  });
}

export function resetPlayer() {
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

export function startReload() {
  const p = player, s = curSlot();
  if (!p.alive || p.swapT > 0 || s.reloadT > 0 || s.ammo >= s.stats.mag) return;
  s.reloadT = s.stats.reload;
  sfx.reloadStart();
  updateAmmoHud();
}

export function startSwap() {
  const p = player;
  if (!p.alive || p.swapT > 0 || p.slots.length < 2) return;
  curSlot().reloadT = 0;   // 切槍會中斷換彈
  p.swapDur = p.swapT = swapTimeOf(); p.swapped = false;
  sfx.reloadStart();
  updateAmmoHud();
}

// fwd = 槍口離身體中心往前多遠；hand = 1 右手、-1 左手
export const muzzleOf = (x, z, fx, fz, s = 1, fwd = 0.67, hand = 1) => ({
  x: x + (fz * 0.2 * hand + fx * fwd) * s,
  z: z + (-fx * 0.2 * hand + fz * fwd) * s,
});
export const playerMuzzle = () => muzzleOf(player.x, player.z, player.fx, player.fz, 1, 0.22 + curSlot().muzzleZ, player.man.hand);

// 換持槍手，記在瀏覽器裡
export const HAND_KEY = 'brickshooter.hand';
export function toggleHand() {
  setHand(player.man, -player.man.hand);
  try { localStorage.setItem(HAND_KEY, player.man.hand); } catch { /* 存不了就只影響這次 */ }
  updateAmmoHud();
}

export const angleDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
export function approachAngle(a, t, maxStep) {
  const d = angleDiff(a, t);
  return Math.abs(d) <= maxStep ? t : a + Math.sign(d) * maxStep;
}

export const raycaster = new THREE.Raycaster();
export const aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -GUN_Y);
export const tmpV = new THREE.Vector3(), ndc = new THREE.Vector2();

export function updatePlayer(dt) {
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
    for (const cell of level.cells.values()) {
      if (cell.kind !== 'door' || cell.passable) continue;
      const n = nearestColumn(cell, p.x, p.z);
      if (n && n.d < p.r + 0.08 && n.d > 1e-4 && (n.dx * input.move.x + n.dz * input.move.y) / (n.d * ml) > 0.5) { kicking = cell; break; }
    }
  }
  if (kicking) {
    p.kick += dt;
    if (p.kick >= 0.15) { smashCell(kicking, true, input.move.x / ml, input.move.y / ml); p.kick = 0; }
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
    const pulse = 0.85 + Math.sin(G.now * 30) * 0.15;
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
      G.muzzleGlow = 0.07;
      p.lastShot = G.now;
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
  if (level.doorOpen && level.grid[tileR(p.z)]?.[tileC(p.x)] === 'D') {
    if (hostageReady()) nextLevel();
    else if (G.now - (p.waitToast ?? -9) > 2) { p.waitToast = G.now; showToast('等人質跟上', ''); }
  }
}

export function hurtPlayer(dx, dz) {
  const p = player;
  if (!p.alive || p.inv > 0) return;
  p.hits++;
  p.inv = 1.0;
  p.vx += dx * 9; p.vz += dz * 9;
  setFlash(p.man, true); setTimeout(() => setFlash(p.man, false), 90);
  burst(p.x, 1, p.z, [0x2f8cff, 0xf0c9a0], 5, 3);
  sparks(p.x, 1, p.z, 0xff4040, 10);
  G.hitStop = Math.max(G.hitStop, 0.14);
  addTrauma(0.75);
  flashEl.style.transition = 'none'; flashEl.style.opacity = 1;
  requestAnimationFrame(() => { flashEl.style.transition = 'opacity .45s'; flashEl.style.opacity = 0; });
  navigator.vibrate?.(p.hits >= MAX_HITS ? 250 : 70);
  updateHud();
  if (p.hits >= MAX_HITS) killPlayer();
  else sfx.hurt();
}

export function killPlayer() {
  const p = player;
  p.alive = false;
  p.man.root.visible = false;
  p.laser.g.visible = p.guide.g.visible = false;
  p.bar.g.visible = false;
  voxelBurst(p.man.root, 80, 5);
  sparks(p.x, 1, p.z, 0xff3030, 20);
  sfx.die();
  G.slowMo = 1.1;
  G.state = 'dead';
  setTimeout(() => {
    if (G.state !== 'dead') return;
    showPanel('YOU DIED', `${levelLabel()}<br>被擊中 ${MAX_HITS} 次`, [
      { label: '重來這關', primary: true, run: retryLevel },
      { label: leaveLabel(), run: leaveLevel },
    ]);
  }, 1100);
}

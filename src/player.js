import * as THREE from 'three';
import { sfx } from './audio.js';
import { loadPlayerLook } from './character.js';
import { makeBlockMan, animateMan, setFlash, setHand } from './models.js';
import { computeStats, buildWeapon, swapTime, WEAPON_PAL } from './weapons.js';
import { buildVoxelMesh } from './voxel.js';
import { DEG, G, GUN_Y, MAX_HITS, addMat, addTrauma, camDist, camRestZ, camTarget, camera, input, scene } from './core.js';
import { burst, fx, makeBar, makeLaser, muzzleFlash, setBar, setLaser, sparks, voxelBurst } from './fx.js';
import { castRay, collide, hostageReady, level, levelLabel, nearestColumn, rayCircle, smashCell, tileC, tileR } from './world.js';
import { spawnBullet } from './bullets.js';
import { showRunOver } from './run.js';
import { renderBuffs } from './items.js';
import { alertNoise, enemies } from './enemies.js';
import { endAssembly, startAssembly, stepAssembly } from './assemble.js';
import { flashEl, showToast, leaveLabel, leaveLevel, nextLevel, retryLevel, showPanel, updateAmmoHud, updateHud } from './main.js';

// ---------- 玩家 ----------
export const player = {
  man: makeBlockMan({ look: loadPlayerLook() }),
  x: 0, z: 0, vx: 0, vz: 0, r: 0.33, fx: 0, fz: -1,
  aimA: Math.PI, recoil: 0, kickSign: 1,   // aimA = 實際槍口角度；recoil = 後座力造成的偏移
  hits: 0, inv: 0, fireCd: 0, alive: true, kick: 0,
  lookX: 0, lookZ: 0,
  roll: 0, rollI: 0, rollCd: 0, rdx: 0, rdz: 1,   // 翻滾：剩餘時間、無敵時間、冷卻、方向
  armor: 0,                                        // 護甲：擋一次傷害，闖關中帶到下一關
  buffs: { speed: 0, power: 0, quick: 0 },          // 限時 buff 剩幾秒，換關歸零
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
  p.roll = p.rollI = p.rollCd = 0; resetRollPose();
  p.lookX = p.lookZ = 0;
  p.buffs.speed = p.buffs.power = p.buffs.quick = 0; renderBuffs();
  if (p.cur !== 0) { p.cur = 0; mountWeapons(); }
  for (const s of p.slots) { s.ammo = s.stats.mag; s.reloadT = 0; }
  p.swapT = 0; p.swapped = true;
  p.man.root.visible = true;
  p.man.root.position.set(p.x, 0, p.z);
  p.bar.g.visible = false;
  updateAmmoHud();
}

// ---------- 登場：每一關開始時鏡頭拉近，玩家從地板冒出方塊組裝起來 ----------
// 組裝中（G.state = 'intro'）整個世界停住；組好閃一下才能動，鏡頭同時慢慢拉回原本的距離
export const INTRO_TIME = 1.15, INTRO_ZOOM = 0.42;
let intro = null;
export function startPlayerIntro() {
  cancelPlayerIntro();
  const p = player;
  p.man.body.rotation.y = Math.atan2(p.fx, p.fz);
  p.man.root.position.set(p.x, 0, p.z);
  p.laser.g.visible = p.guide.g.visible = p.bar.g.visible = false;
  intro = { t: 0, A: startAssembly(p.man, { x: p.x, z: p.z, color: 0x5adcff }) };
  G.state = 'intro';
  G.camMul = INTRO_ZOOM;
  sfx.assemble?.();
}
export function updatePlayerIntro(dt) {
  if (!intro) { G.state = 'play'; return; }
  intro.t += dt;
  const k = Math.min(1, intro.t / INTRO_TIME);
  stepAssembly(intro.A, k, intro.t);
  animateMan(player.man, 0, dt, false);
  if (k < 1) return;
  cancelPlayerIntro();
  const p = player;
  setFlash(p.man, true); setTimeout(() => setFlash(p.man, false), 120);
  sparks(p.x, 1, p.z, 0x5adcff, 16);
  sparks(p.x, 1, p.z, 0xffffff, 8);
  burst(p.x, 0.2, p.z, [0x5adcff, 0x8a8070], 4, 3);
  sfx.assembleDone?.();
  addTrauma(0.15);
  G.state = 'play';
  // 關卡登場後要做的事（頭目登場）
  const f = level.onStart;
  level.onStart = null;
  f?.();
}
export function cancelPlayerIntro() {
  if (!intro) return;
  endAssembly(intro.A);
  intro = null;
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
  x: x + (-fz * 0.2 * hand + fx * fwd) * s,
  z: z + (fx * 0.2 * hand + fz * fwd) * s,
});
export const playerMuzzle = () => muzzleOf(player.x, player.z, player.fx, player.fz, 1, 0.22 + curSlot().muzzleZ, player.man.hand);

// 換持槍手，記在瀏覽器裡
export const HAND_KEY = 'brickshooter.hand';
export function toggleHand(hand = -player.man.hand) {
  if (player.man.hand === hand) return;
  setHand(player.man, hand);
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

// ---------- 翻滾閃避 ----------
// 往移動方向（沒在動就往面對的方向）滾一段；前段無敵，彈丸會直接穿過去；翻滾中不能開槍
export const LOOK_AHEAD = 2.6;   // 鏡頭往瞄準方向最多偏幾格（乘上關卡 zoom）
// ROLL_CD = 翻滾結束後要等多久才能再滾
export const ROLL_TIME = 0.42, ROLL_IFRAME = 0.3, ROLL_CD = 0.75, ROLL_SPEED = 9.5;
function startRoll() {
  const p = player, ml = Math.hypot(input.move.x, input.move.y);
  if (ml > 0.2) { p.rdx = input.move.x / ml; p.rdz = input.move.y / ml; }
  else { p.rdx = p.fx; p.rdz = p.fz; }
  p.roll = ROLL_TIME; p.rollI = ROLL_IFRAME; p.rollCd = ROLL_TIME + ROLL_CD;
  sfx.roll?.();
  // 強化「滾裝」：翻滾時直接裝滿
  const cs = curSlot();
  if (cs.stats.rollReload && cs.ammo < cs.stats.mag && p.swapT <= 0) { cs.ammo = cs.stats.mag; cs.reloadT = 0; sfx.reloadDone(); updateAmmoHud(); }
  burst(p.x, 0.15, p.z, [0x8a8070, 0x6a6458], 3, 1.5, -p.rdx * 2, -p.rdz * 2);
}
// 身體繞腰（離地 0.7）往前翻一圈
const ROLL_PIVOT = 0.7;
function rollPose(t01) {
  const b = player.man.body, th = t01 * Math.PI * 2;
  b.rotation.order = 'YXZ';
  b.rotation.y = Math.atan2(player.rdx, player.rdz);
  b.rotation.x = th;
  const fwd = -ROLL_PIVOT * Math.sin(th);
  b.position.set(player.rdx * fwd, ROLL_PIVOT - ROLL_PIVOT * Math.cos(th), player.rdz * fwd);
}
function resetRollPose() {
  const b = player.man.body;
  b.rotation.x = 0; b.position.set(0, 0, 0);
}

// 翻滾冷卻：腳下一圈淡淡的環，冷卻中從大縮到小，好了閃一下
const rollRing = new THREE.Mesh(new THREE.RingGeometry(0.46, 0.52, 32), addMat(0x5adcff, 0.5));
rollRing.rotation.x = -Math.PI / 2;
rollRing.visible = false;
scene.add(rollRing);
const rollBtn = document.getElementById('rollBtn');
let rollReadyFlash = 0;
function updateRollIndicator(dt) {
  const p = player, total = ROLL_TIME + ROLL_CD;
  const cooling = p.alive && p.rollCd > 0;
  rollRing.position.set(p.x, 0.04, p.z);
  if (cooling) {
    rollRing.visible = true;
    rollRing.scale.setScalar(0.4 + 0.6 * p.rollCd / total);
    rollRing.material.opacity = 0.45;
    rollReadyFlash = 0.18;
  } else if (rollReadyFlash > 0 && p.alive) {
    rollReadyFlash -= dt;
    rollRing.visible = true;
    rollRing.scale.setScalar(1.1);
    rollRing.material.opacity = rollReadyFlash * 4;
  } else rollRing.visible = false;
  if (rollBtn) rollBtn.style.setProperty('--cd', cooling ? (p.rollCd / total).toFixed(3) : 0);
}

export function updatePlayer(dt) {
  const p = player, slot = curSlot(), st = slot.stats;
  if (!p.alive) { p.laser.g.visible = p.guide.g.visible = p.bar.g.visible = false; return; }
  p.rollCd -= dt; p.rollI -= dt;
  updateRollIndicator(dt);
  if (input.rollPressed && p.roll <= 0 && p.rollCd <= 0) startRoll();
  const mode = p.roll > 0 ? 'none' : input.aimMode;
  const firing = mode === 'fire';
  if (p.roll > 0) {
    p.roll -= dt;
    const s = ROLL_SPEED * (0.55 + 0.45 * p.roll / ROLL_TIME);   // 一開始最快，慢慢收
    p.vx = p.rdx * s; p.vz = p.rdz * s;
  } else {
    const spd = 5.6 * (p.buffs.speed > 0 ? 1.3 : 1) * (firing ? 0.78 : 1) * (slot.reloadT > 0 ? 0.9 : 1) * (1 - st.weight * 0.035);
    const k = 1 - Math.exp(-18 * dt);
    p.vx += (input.move.x * spd - p.vx) * k;
    p.vz += (input.move.y * spd - p.vz) * k;
  }
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

  // 鏡頭往瞄準的方向偏，多看一點前面：手機看右搖桿有沒有推，電腦看游標離角色多遠（游標在角色身上 = 回正）
  p.lookX = p.lookZ = 0;
  if (input.aimMode !== 'none') {
    const max = LOOK_AHEAD * (level.def?.zoom ?? 1);
    if (input.source === 'touch') { p.lookX = input.aimVec.x * max; p.lookZ = input.aimVec.y * max; }
    else {
      ndc.set(input.mouse.x / innerWidth * 2 - 1, -(input.mouse.y / innerHeight) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      if (raycaster.ray.intersectPlane(aimPlane, tmpV)) {
        // 扣掉鏡頭目前已經偏掉的量 = 鏡頭沒偏時游標指在哪；這樣鏡頭移動不會反過來推著游標跑
        const rest = camRestZ(camDist * (level.def?.zoom ?? 1) * (G.camMul ?? 1));
        const dx = tmpV.x - (camTarget.x - p.x) - p.x, dz = tmpV.z - (camTarget.z - (p.z + rest)) - p.z, d = Math.hypot(dx, dz);
        const k = d > 0.01 ? Math.min(d * 0.45, max) / d : 0;
        p.lookX = dx * k; p.lookZ = dz * k;
      }
    }
  }

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
    for (const e of enemies) if (!e.asm) len = Math.min(len, rayCircle(m.x, m.z, p.fx, p.fz, e.x, e.z, e.r));
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
  if (input.slotSet >= 0 && input.slotSet !== p.cur && p.swapT <= 0) startSwap();
  if (input.handPressed) toggleHand();
  if (input.handSet) toggleHand(input.handSet);
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
    cs.reloadT -= dt * (p.buffs.quick > 0 ? 2 : 1);   // 快換：換彈速度兩倍
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
      spawnBullet('p', 'player', mm.x, mm.z, Math.sin(actA + sp), Math.cos(actA + sp), cst.speed, cst.range, cst.damage * (p.buffs.power > 0 ? 1.5 : 1), cst);
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
      alertNoise(cst.noise * 2.5);   // 室內槍聲很大聲：大概整層樓都聽得到
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
  const busy = cs.reloadT > 0 || p.swapT > 0;
  if (p.roll > 0) { rollPose(1 - p.roll / ROLL_TIME); animateMan(p.man, 0, dt, false); }
  else {
    if (p.man.body.rotation.x) resetRollPose();
    p.man.body.rotation.y = actA;
    animateMan(p.man, Math.min(1, Math.hypot(p.vx, p.vz) / 5.6), dt, aiming && !busy);
  }
  p.man.gun.rotation.x = busy ? 0.7 : 0;

  // 走進出口
  if (level.doorOpen && level.grid[tileR(p.z)]?.[tileC(p.x)] === 'D') {
    if (hostageReady()) nextLevel();
    else if (G.now - (p.waitToast ?? -9) > 2) { p.waitToast = G.now; showToast('等人質跟上', ''); }
  }
}

export function hurtPlayer(dx, dz) {
  const p = player;
  if (!p.alive || p.inv > 0 || p.rollI > 0) return;
  // 護甲先吃掉這一下：一樣有無敵時間和擊退，但不扣命
  if (p.armor > 0) {
    p.armor--;
    p.inv = 1.0;
    p.vx += dx * 7; p.vz += dz * 7;
    sparks(p.x, 1, p.z, 0xc8d4e8, 14);
    burst(p.x, 1, p.z, [0x9aa8bc, 0x6a7484], 6, 3);
    G.hitStop = Math.max(G.hitStop, 0.08);
    addTrauma(0.4);
    sfx.armor?.();
    updateHud();
    return;
  }
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
    if (level.mode === 'run') { showRunOver(); return; }
    showPanel('YOU DIED', `${levelLabel()}<br>被擊中 ${MAX_HITS} 次`, [
      { label: '重來這關', primary: true, run: retryLevel },
      { label: leaveLabel(), run: leaveLevel },
    ]);
  }, 1100);
}

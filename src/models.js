import * as THREE from 'three';
import { V } from './voxel.js';
import { LOOK_PARTS, PART_KEYS, buildPartMesh, defaultLook } from './character.js';

// 方塊人：全部由 1/16 的小方塊組成，每格各自有顏色
// root 只管位置，body 管朝向（local +z = 前方，所以 local -x 是他的右手邊）
// 外觀來自 look（character.js，分部位的方塊資料）；沒給就用顏色組出預設造型
// 之後敵人要自訂造型，只要傳 look 進來
export function makeBlockMan({ skin = 0xf0c9a0, shirt, pants = 0x2b2f3a, boots = 0x1b1c22, helmet = null, scale = 1, look = null }) {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const mats = { main: mat };
  const root = new THREE.Group();
  const body = new THREE.Group();
  body.scale.setScalar(scale);
  root.add(body);

  // 每個部位一個 Group，放在掛載點；四肢繞掛載點轉
  const part = p => {
    const g = new THREE.Group();
    g.position.set(...LOOK_PARTS[p].at);
    body.add(g);
    return g;
  };
  const torso = part('torso'), head = part('head');
  const legL = part('legL'), legR = part('legR'), armL = part('armL'), armR = part('armR');

  // 手上的槍（原點 = 握把位置）與背上的備用槍
  const gun = new THREE.Group();
  gun.position.set(-0.2, 0.825, 0.22);
  body.add(gun);
  const back = new THREE.Group();
  back.position.set(0.05, 0.95, -0.24);
  back.rotation.set(-Math.PI / 2 + 0.25, 0, -0.7);
  body.add(back);

  const m = { root, body, torso, head, legL, legR, armL, armR, gun, back, mats, walk: 0, hand: 1, parts: { torso, head, legL, legR, armL, armR } };
  applyLook(m, look ?? lookOf({ skin, shirt, pants, boots, helmet }));
  return m;
}

// 同一組顏色的預設造型只算一次（殭屍很多）
const lookCache = new Map();
function lookOf(colors) {
  const k = JSON.stringify(colors);
  if (!lookCache.has(k)) lookCache.set(k, defaultLook(colors));
  return lookCache.get(k);
}

// 換造型：每個部位重建方塊網格（槍、動作都不受影響）
export function applyLook(m, look) {
  for (const p of PART_KEYS) {
    const g = m.parts[p];
    for (const c of [...g.children]) { g.remove(c); c.dispose?.(); }
    g.add(buildPartMesh(look, p, m.mats.main));
  }
}

// 持槍手：1 = 右手、-1 = 左手；手上的槍和背上的槍左右對調
export function setHand(m, hand) {
  m.hand = hand;
  m.gun.position.x = -0.2 * hand;
  m.back.position.x = 0.05 * hand;
  m.back.rotation.z = -0.7 * hand;
}

// 走路 + 舉槍姿勢；拿著槍的那隻手固定握槍，不跟著走路擺動
export function animateMan(m, speed01, dt, aiming) {
  m.walk += dt * (4 + 9 * speed01) * (speed01 > 0.05 ? 1 : 0);
  const sw = Math.sin(m.walk) * 0.7 * speed01;
  m.legL.rotation.x = sw;
  m.legR.rotation.x = -sw;
  const holding = m.gun.children.length > 0;
  const [gunArm, offArm, offSign] = m.hand > 0 ? [m.armR, m.armL, 1] : [m.armL, m.armR, -1];
  gunArm.rotation.x = holding || aiming ? -1.45 : -sw * offSign * 0.8;
  gunArm.rotation.z = 0;
  offArm.rotation.x = aiming ? -1.25 : sw * offSign * 0.8;
  offArm.rotation.z = aiming ? 0.35 * offSign : 0;
  m.torso.position.y = 0.85 + Math.abs(Math.sin(m.walk)) * 0.04 * speed01;
}

// 黑暗中發光的眼睛：蓋在眼睛方塊上，外面再一層淡淡的光暈
const EYE_GEO = new THREE.BoxGeometry(1, 1, 1);
const eyeMats = new Map();
const eyeMat = (color, opacity) => {
  const k = color + ':' + opacity;
  if (!eyeMats.has(k)) eyeMats.set(k, new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  return eyeMats.get(k);
};
export function addGlowEyes(m, color) {
  const g = new THREE.Group();
  g.position.set(0, m.head.position.y + 2.5 * V, m.head.position.z + 2.1 * V);
  for (const sx of [-1, 1]) {
    const core = new THREE.Mesh(EYE_GEO, eyeMat(color, 1));
    core.scale.setScalar(1.6 * V);
    const halo = new THREE.Mesh(EYE_GEO, eyeMat(color, 0.35));
    halo.scale.set(4.5 * V, 3.5 * V, V);
    core.position.x = halo.position.x = sx * V;
    g.add(core, halo);
  }
  m.body.add(g);
  m.eyes = g;
  return g;
}

// 受傷閃白
export function setFlash(m, on) {
  for (const k in m.mats) m.mats[k].emissive.setHex(on ? 0xffffff : 0x000000);
}

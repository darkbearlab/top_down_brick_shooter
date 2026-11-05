import * as THREE from 'three';
import { Input } from './input.js';


export const DEG = Math.PI / 180;

export const MAX_HITS = 3;
export const GUN_Y = 0.95;

// ---------- 基本場景 ----------
export const container = document.getElementById('game');
export const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d12);

export const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 120);
export const CAM_PITCH = THREE.MathUtils.degToRad(62);
// 鏡頭沒往瞄準方向偏時，鏡頭中心在玩家前後多遠（世界 z，正 = 鏡頭中心在玩家下方）
// 橫式：玩家略偏下；直式（手機）：玩家離上、左、右邊差不多遠（離上緣 = 半個螢幕寬），下面留給手指操作區和下方的敵人
export function camRestZ(dist) {
  if (innerHeight <= innerWidth) return -0.5 * dist / camDist;
  const ny = 1 - 2 * Math.min(0.5, innerWidth / 2 / innerHeight);   // 玩家在畫面上的 NDC y
  const a = Math.atan(ny * Math.tan(camera.fov * Math.PI / 360));
  return dist * (Math.sin(CAM_PITCH) / Math.tan(CAM_PITCH - a) - Math.cos(CAM_PITCH));
}
// 畫面上緣、下緣（正中央那條線）落在地上的位置，相對鏡頭中心的 z
export function camEdgesZ(dist) {
  const f = camera.fov * Math.PI / 360, P = CAM_PITCH;
  const at = a => dist * (Math.cos(P) - Math.sin(P) / Math.tan(P - a));
  return [at(f), at(-f)];
}
export let camDist = 20;
export function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  // 直式：至少看到 ~9.5 格寬；橫式：至少看到 ~16 格高
  camDist = Math.max(4.75 / (t * camera.aspect), 8 / t);
}
addEventListener('resize', resize);
resize();

export const hemi = new THREE.HemisphereLight(0xc8d8ff, 0x2a2018, 1.4);
scene.add(hemi);
export const sun = new THREE.DirectionalLight(0xfff2e0, 2.4);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 1, far: 60 });
sun.shadow.bias = -0.0008;
scene.add(sun, sun.target);

// 黑暗模式的光：手電筒（跟著槍口實際方向）、身邊一小圈、開槍的火光
export const FLASH_RANGE = 11, FLASH_ANGLE = 0.42, BODY_LIGHT_R = 1.9;
export const flashlight = new THREE.SpotLight(0xfff1d6, 0, FLASH_RANGE + 2, FLASH_ANGLE, 0.45, 1);
flashlight.castShadow = true;
flashlight.shadow.mapSize.set(1024, 1024);
flashlight.shadow.camera.near = 0.1;
flashlight.shadow.bias = -0.0006;
export const bodyLight = new THREE.PointLight(0x9fb4e0, 0, 3, 1);
export const muzzleLight = new THREE.PointLight(0xffb050, 0, 7, 1.2);
scene.add(flashlight, flashlight.target, bodyLight, muzzleLight);

export function setLighting(dark) {
  hemi.intensity = dark ? 0.09 : 1.4;
  sun.visible = !dark;
  flashlight.visible = bodyLight.visible = muzzleLight.visible = dark;
  scene.background.setHex(dark ? 0x030406 : 0x0b0d12);
}

// ---------- 共用幾何與材質 ----------
export const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
export const DEBRIS_GEO = new THREE.BoxGeometry(0.15, 0.15, 0.15);
export const FLASH_GEO = new THREE.IcosahedronGeometry(0.2, 0);
export const addMat = (color, opacity = 1) => new THREE.MeshBasicMaterial({
  color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
});
export const TRACER = {
  player: { core: addMat(0xfff6d0), glow: addMat(0xffa020, 0.55), maxLen: 1.7 },
  enemy: { core: addMat(0xffe0e0), glow: addMat(0xff2a2a, 0.6), maxLen: 1.1 },
  heavy: { core: addMat(0xf0e0ff), glow: addMat(0xb050ff, 0.6), maxLen: 0.9 },
};
// 敵人的彈丸：慢速方塊，亮芯 + 深色外殼，在亮的地板上也讀得到（scale = 半邊長）
export const PELLET_GEO = new THREE.BoxGeometry(2, 2, 2);
const solid = c => new THREE.MeshBasicMaterial({ color: c, toneMapped: false });
export const PELLET = {
  enemy: { r: 0.13, core: solid(0xffd0b0), rim: solid(0xc81e14) },
  heavy: { r: 0.17, core: solid(0xf0d8ff), rim: solid(0x7a28d0) },
  spread: { r: 0.13, core: solid(0xc8fff4), rim: solid(0x0e8a7c) },
  ring: { r: 0.15, core: solid(0xfff4b0), rim: solid(0xb8900a) },
};
export const debrisMats = new Map();
export const debrisMat = c => {
  if (!debrisMats.has(c)) debrisMats.set(c, new THREE.MeshLambertMaterial({ color: c }));
  return debrisMats.get(c);
};
export const WOOD = [0x7a5230, 0x5a3a20, 0x9a6a40];


export const WALL_H = 1.4;

// ---------- 共用的遊戲狀態（很多模組都會改） ----------
// camMul = 鏡頭距離倍率（登場時拉近，之後慢慢回到 1）
export const G = { state: 'menu', hitStop: 0, slowMo: 0, trauma: 0, now: 0, muzzleGlow: 0, lastGroan: 0, camMul: 1 };
export const camTarget = new THREE.Vector3();
export function addTrauma(v) { G.trauma = Math.min(1, G.trauma + v); }

export const input = new Input(container);
input.onFireStage = src => { if (src === 'touch') navigator.vibrate?.(8); };

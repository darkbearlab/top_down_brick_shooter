import * as THREE from 'three';

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);

// 方塊人：root 只管位置，body 管朝向（local +z = 前方）
export function makeBlockMan({ skin = 0xf0c9a0, shirt, pants = 0x2b2f3a, gun = 0x222222, scale = 1, helmet = null }) {
  const mats = {
    skin: new THREE.MeshLambertMaterial({ color: skin }),
    shirt: new THREE.MeshLambertMaterial({ color: shirt }),
    pants: new THREE.MeshLambertMaterial({ color: pants }),
    gun: new THREE.MeshLambertMaterial({ color: gun }),
  };
  const root = new THREE.Group();
  const body = new THREE.Group();
  body.scale.setScalar(scale);
  root.add(body);

  const mesh = (g, m, x, y, z, parent = body) => {
    const o = new THREE.Mesh(g, m);
    o.position.set(x, y, z);
    o.castShadow = true;
    parent.add(o);
    return o;
  };

  const torso = mesh(box(0.5, 0.55, 0.3), mats.shirt, 0, 0.85, 0);
  const head = mesh(box(0.32, 0.32, 0.32), mats.skin, 0, 1.3, 0);
  // 眼睛（讓朝向一眼看得出來）
  const eyeM = new THREE.MeshBasicMaterial({ color: 0x111111 });
  mesh(box(0.06, 0.06, 0.02), eyeM, -0.08, 1.33, 0.165);
  mesh(box(0.06, 0.06, 0.02), eyeM, 0.08, 1.33, 0.165);
  if (helmet !== null) {
    mats.helmet = new THREE.MeshLambertMaterial({ color: helmet });
    mesh(box(0.38, 0.14, 0.38), mats.helmet, 0, 1.47, -0.01);
  }

  const limb = (x, y, w, h, m) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    body.add(pivot);
    mesh(box(w, h, w), m, 0, -h / 2, 0, pivot);
    return pivot;
  };
  const legL = limb(-0.13, 0.58, 0.19, 0.55, mats.pants);
  const legR = limb(0.13, 0.58, 0.19, 0.55, mats.pants);
  const armL = limb(-0.33, 1.08, 0.15, 0.45, mats.shirt);
  const armR = limb(0.33, 1.08, 0.15, 0.45, mats.shirt);

  // 槍掛在右手前方（舉槍時手臂朝前）
  const gunG = new THREE.Group();
  gunG.position.set(0.2, 0.95, 0.25);
  body.add(gunG);
  mesh(box(0.1, 0.12, 0.55), mats.gun, 0, 0, 0.12, gunG);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, 0.42);
  gunG.add(muzzle);

  return { root, body, torso, head, legL, legR, armL, armR, gun: gunG, muzzle, mats, walk: 0 };
}

// 走路 + 舉槍姿勢
export function animateMan(m, speed01, dt, aiming) {
  m.walk += dt * (4 + 9 * speed01) * (speed01 > 0.05 ? 1 : 0);
  const sw = Math.sin(m.walk) * 0.7 * speed01;
  m.legL.rotation.x = sw;
  m.legR.rotation.x = -sw;
  m.armL.rotation.x = aiming ? -1.25 : -sw * 0.8;
  m.armR.rotation.x = aiming ? -1.45 : sw * 0.8;
  m.armL.rotation.z = aiming ? -0.35 : 0;
  m.torso.position.y = 0.85 + Math.abs(Math.sin(m.walk)) * 0.04 * speed01;
}

// 受傷閃白
export function setFlash(m, on) {
  for (const k in m.mats) {
    const mat = m.mats[k];
    mat.emissive.setHex(on ? 0xffffff : 0x000000);
  }
}

// ---------- 組裝演出：從地板冒出方塊，往上組成一個方塊人 ----------
// 敵人增援、玩家登場、頭目登場共用；身體用 clipping plane 從腳往上長出來，方塊從腳邊地板飛到身上的位置，低的先到
import * as THREE from 'three';
import { DEBRIS_GEO, addMat, debrisMat, renderer, scene } from './core.js';
import { sampleVoxels } from './voxel.js';

renderer.localClippingEnabled = true;
const RING_GEO = new THREE.RingGeometry(0.5, 0.62, 32);

// cubes = 體型 1 時飛幾顆方塊；spread = 方塊從多遠的地板飛過來
export function startAssembly(man, { x, z, scale = 1, color, cubes = 60, spread = 1 }) {
  const plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
  man.mats.main.clippingPlanes = [plane];
  man.mats.main.clipShadows = true;
  const H = 2.1 * scale;
  const list = sampleVoxels(man.root, Math.round(cubes * scale ** 1.5)).map(v => {
    const mesh = new THREE.Mesh(DEBRIS_GEO, debrisMat(v.c));
    const ang = Math.random() * Math.PI * 2, rad = (0.5 + Math.random() * 0.9) * spread;
    const from = { x: v.x + Math.sin(ang) * rad, y: 0.02, z: v.z + Math.cos(ang) * rad };
    mesh.position.set(from.x, from.y, from.z);
    mesh.scale.setScalar(0.5);
    mesh.visible = false;
    scene.add(mesh);
    const arrive = 0.25 + (v.y / H) * 0.65 + Math.random() * 0.08;   // 抵達時間（0~1）
    return { mesh, from, to: v, arrive };
  });
  const ring = new THREE.Mesh(RING_GEO, addMat(color, 0.8));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, 0.03, z);
  ring.scale.setScalar(scale);
  scene.add(ring);
  return { man, plane, cubes: list, ring, H, scale };
}

// k = 進度 0~1，t = 經過秒數（地上的圈跟著閃）
export function stepAssembly(A, k, t) {
  A.plane.constant = Math.max(0, (k - 0.25) / 0.65) * A.H;
  for (const c of A.cubes) {
    const st = c.arrive - 0.3, u = Math.max(0, Math.min(1, (k - st) / 0.3));
    c.mesh.visible = u > 0 && u < 1;
    const ease = 1 - (1 - u) ** 3;
    c.mesh.position.set(c.from.x + (c.to.x - c.from.x) * ease, c.from.y + (c.to.y - c.from.y) * ease + Math.sin(u * Math.PI) * 0.25 * A.scale, c.from.z + (c.to.z - c.from.z) * ease);
    c.mesh.rotation.set(u * 6, u * 4, 0);
  }
  A.ring.material.opacity = 0.35 + 0.45 * Math.abs(Math.sin(t * 9));
  A.ring.scale.setScalar(A.scale * (1.2 - 0.3 * k));
}

export function endAssembly(A) {
  for (const c of A.cubes) scene.remove(c.mesh);
  scene.remove(A.ring); A.ring.material.dispose();
  A.man.mats.main.clippingPlanes = null;
}

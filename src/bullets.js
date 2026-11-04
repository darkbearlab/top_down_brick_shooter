import * as THREE from 'three';
import { sfx } from './audio.js';
import { GUN_Y, TRACER, UNIT_BOX, scene } from './core.js';
import { sparks } from './fx.js';
import { LAMP_HIT_DZ, breakLamp, cellAt, colIndex, coverStops, hitColumn, isSolidTile, killHostage, level, tileC, tileR } from './world.js';
import { hurtPlayer, player } from './player.js';
import { damageEnemy, enemies } from './enemies.js';

// ---------- 子彈（曳光彈） ----------
export const bullets = [];
export function spawnBullet(owner, style, x, z, dx, dz, speed, range = 30, dmg = 1) {
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

export function updateBullets(dt) {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    if (!b.dying) {
      const total = b.speed * dt;
      const steps = Math.max(1, Math.ceil(total / 0.1));   // 柱子只有 0.25 寬，步子要夠細
      const step = total / steps;
      for (let s = 0; s < steps && !b.dying; s++) {
        b.x += b.dx * step; b.z += b.dz * step; b.traveled += step;
        const c = tileC(b.x), r = tileR(b.z);
        if (isSolidTile(c, r)) {
          b.dying = true;
          sparks(b.x - b.dx * 0.1, GUN_Y, b.z - b.dz * 0.1, b.owner === 'p' ? 0xffc060 : 0xff6050, 4, -b.dx, -b.dz);
          if (b.owner === 'p') sfx.wall();
          break;
        }
        // 可破壞的格子：打到還在的柱子就扣它的血（半掩體看有沒有人貼在後面）
        const cell = cellAt(c, r);
        if (cell) {
          const k = colIndex(cell, b.x, b.z);
          if (cell.hp[k] > 0 && (cell.full || coverStops(b, cell))) {
            b.dying = true;
            hitColumn(cell, k, b.dmg, b.dx, b.dz, b.x - b.dx * 0.05, b.z - b.dz * 0.05);
            break;
          }
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

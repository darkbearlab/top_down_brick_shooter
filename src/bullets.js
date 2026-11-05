import * as THREE from 'three';
import { sfx } from './audio.js';
import { GUN_Y, PELLET, PELLET_GEO, TRACER, UNIT_BOX, scene } from './core.js';
import { sparks } from './fx.js';
import { LAMP_HIT_DZ, breakLamp, cellAt, colIndex, coverStops, hitColumn, hurtHostage, isSolidTile, killHostage, level, tileC, tileR } from './world.js';
import { hurtPlayer, player } from './player.js';
import { damageEnemy, enemies } from './enemies.js';
import { bulletHitsSwing } from './swingdoors.js';

// ---------- 子彈：玩家是快速曳光彈，敵人是慢速彈丸 ----------
export const bullets = [];
// 玩家被彈丸打中的判定半徑（比身體小，擦過去不算）
export const PLAYER_HIT_R = 0.17;
// 敵人的彈丸：一律直線飛
export function spawnPellet(style, x, z, dx, dz, speed, { range = 20 } = {}) {
  const st = PELLET[style];
  const g = new THREE.Group();
  const rim = new THREE.Mesh(PELLET_GEO, st.rim);
  const core = new THREE.Mesh(PELLET_GEO, st.core);
  rim.scale.setScalar(st.r);
  core.scale.setScalar(st.r * 0.62);
  core.position.y = st.r * 0.42;   // 鏡頭從斜上方看：亮的芯放上面一點
  g.add(rim, core);
  g.position.set(x, GUN_Y, z);
  scene.add(g);
  bullets.push({ g, owner: 'e', pellet: true, style, r: st.r, x, z, dx, dz, speed, range, dmg: 1, traveled: 0, dying: false });
}
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
          if (!b.pellet) sparks(b.x - b.dx * 0.1, GUN_Y, b.z - b.dz * 0.1, 0xffc060, 4, -b.dx, -b.dz);
          if (b.owner === 'p') sfx.wall();
          break;
        }
        // 可破壞的格子：打到還在的柱子就扣它的血（半掩體看有沒有人貼在後面）
        const cell = cellAt(c, r);
        if (cell) {
          const k = colIndex(cell, b.x, b.z);
          // 彈丸一定會被半掩體擋下（看得到就要合理），順便把掩體一點一點啃掉；離開槍口太近的不算
          const stop = cell.full || (b.pellet ? b.traveled > 0.9 : coverStops(b, cell));
          if (cell.hp[k] > 0 && stop) {
            b.dying = true;
            hitColumn(cell, k, b.dmg, b.dx, b.dz, b.x - b.dx * 0.05, b.z - b.dz * 0.05, b.pellet);
            break;
          }
        }
        if (level.swings.length && bulletHitsSwing(b)) { b.dying = true; break; }
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
        } else {
          // 翻滾中的無敵時間：彈丸直接穿過去
          if (player.alive && player.inv <= 0 && player.rollI <= 0) {
            const ddx = player.x - b.x, ddz = player.z - b.z, hr = b.pellet ? PLAYER_HIT_R + b.r : 0.3;
            if (ddx * ddx + ddz * ddz < hr * hr) { b.dying = true; hurtPlayer(b.dx, b.dz); break; }
          }
          // 救出來跟著走的人質會被敵人的流彈打到
          const h = level.hostage;
          if (h?.alive && h.saved && (h.x - b.x) ** 2 + (h.z - b.z) ** 2 < (h.r + 0.04) ** 2) { b.dying = true; hurtHostage(b.dx, b.dz); }
        }
      }
      if (b.traveled > b.range) b.dying = true;
      if (b.pellet) {
        b.g.position.set(b.x, GUN_Y, b.z);
        b.g.rotation.y += dt * 5;   // 方塊慢慢自轉
        continue;
      }
      b.len = Math.min(b.traveled, b.maxLen);
    } else if (b.pellet) {
      // 彈丸打到東西：原地縮掉就好，不噴火花（看起來才不會像反彈）
      b.pop = (b.pop ?? 0.09) - dt;
      if (b.pop <= 0) { scene.remove(b.g); bullets.splice(i, 1); continue; }
      b.g.scale.setScalar(b.pop / 0.09);
      continue;
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

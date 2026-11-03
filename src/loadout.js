// 武器與裝備畫面：兩個欄位，各自組一把槍，存在瀏覽器裡
import * as THREE from 'three';
import {
  CALIBERS, RECEIVERS, PARTS, SLOTS, DEFAULT_LOADOUT, WEAPON_PAL,
  blockReason, validate, computeStats, buildWeapon, swapTime,
} from './weapons.js';
import { buildVoxelMesh } from './voxel.js';

const KEY = 'brickshooter.loadout.v1';

export function loadLoadout() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (Array.isArray(raw) && raw.length === 2) return raw.map(b => validate(b).build);
  } catch { /* 沒存過或壞掉就用預設 */ }
  return DEFAULT_LOADOUT.map(b => ({ ...b }));
}
function saveLoadout(lo) {
  try { localStorage.setItem(KEY, JSON.stringify(lo)); } catch { /* 無痕模式等情況存不了，不影響這次遊玩 */ }
}

// 數值條：better = 'high' 越高越好，'low' 越低越好
const STAT_ROWS = [
  { key: 'damage', label: '威力', max: 80, better: 'high', fmt: v => v.toFixed(0) },
  { key: 'range', label: '射程', max: 35, better: 'high', fmt: v => v.toFixed(1) },
  { key: 'rpm', label: '射速', max: 900, better: 'high', fmt: v => v.toFixed(0) },
  { key: 'mag', label: '彈匣', max: 75, better: 'high', fmt: v => v.toFixed(0) },
  { key: 'reload', label: '換彈', max: 3, better: 'low', fmt: v => v.toFixed(2) + 's' },
  { key: 'kick', label: '後座力', max: 10, better: 'low', fmt: v => v.toFixed(1) + '°' },
  { key: 'turn', label: '轉向', max: 900, better: 'high', fmt: v => v.toFixed(0) + '°/s' },
  { key: 'weight', label: '重量', max: 7, better: 'low', fmt: v => v.toFixed(1) },
];

const $ = id => document.getElementById(id);
let preview = null;   // 第一次打開才建立預覽用的 renderer

function makePreview(el) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  el.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xdde6ff, 0x30281e, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(2, 4, 3);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
  const pivot = new THREE.Group();
  scene.add(pivot);
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const p = { renderer, scene, camera, pivot, mat, mesh: null, el, raf: 0, size: 1 };
  const loop = () => {
    p.raf = requestAnimationFrame(loop);
    const w = el.clientWidth, h = el.clientHeight;
    if (renderer.domElement.width !== Math.floor(w * renderer.getPixelRatio())) {
      renderer.setSize(w, h);
      camera.aspect = w / h; camera.updateProjectionMatrix();
    }
    pivot.rotation.y += 0.008;
    const d = p.size / (2 * Math.tan(THREE.MathUtils.degToRad(15)) * Math.min(1, camera.aspect)) * 0.8;
    camera.position.set(0, d * 0.35, d);
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
  };
  p.start = () => { if (!p.raf) loop(); };
  p.stop = () => { cancelAnimationFrame(p.raf); p.raf = 0; };
  return p;
}

function showWeapon(build) {
  if (preview.mesh) { preview.pivot.remove(preview.mesh); preview.mesh.dispose(); }
  const w = buildWeapon(build);
  const mesh = buildVoxelMesh(w.set, preview.mat, WEAPON_PAL, { x: 'center', y: 'center', z: 'center' });
  // 槍身側面朝鏡頭
  mesh.rotation.y = Math.PI / 2;
  preview.pivot.add(mesh);
  preview.mesh = mesh;
  let mn = Infinity, mx = -Infinity;
  for (const v of mesh.userData.voxels) { mn = Math.min(mn, v.z); mx = Math.max(mx, v.z); }
  preview.size = Math.max(0.8, mx - mn + 0.1);
  preview.pivot.rotation.y = -0.5;
}

export function openLoadout(onDone) {
  const lo = loadLoadout();
  let slot = 0, prev = null, notes = [];
  const screen = $('loadout');
  if (!preview) preview = makePreview($('loPreview'));

  function set(key, val) {
    prev = computeStats(lo[slot]);
    const next = { ...lo[slot], [key]: val };
    const r = validate(next);
    lo[slot] = r.build;
    notes = r.notes;
    render();
  }

  function chips(label, items, cur, key) {
    const row = document.createElement('div');
    row.className = 'lo-row';
    row.innerHTML = `<div class="lo-label">${label}</div>`;
    const box = document.createElement('div');
    box.className = 'lo-chips';
    for (const it of items) {
      const b = document.createElement('button');
      b.className = 'chip' + (it.id === cur ? ' on' : '');
      b.disabled = !!it.why;
      b.innerHTML = it.name + (it.why ? `<small>${it.why}</small>` : '');
      b.addEventListener('click', () => set(key, it.id));
      box.appendChild(b);
    }
    row.appendChild(box);
    return row;
  }

  function render() {
    const b = lo[slot];
    document.querySelectorAll('#loTabs button').forEach((t, i) => {
      t.classList.toggle('on', i === slot);
      t.querySelector('small').textContent = computeStats(lo[i]).name;
    });
    const st = computeStats(b);
    $('loName').innerHTML = `${st.caliberName}・${st.name}<small>兩把槍切換時間 ${swapTime(lo.map(computeStats)).toFixed(2)} 秒（看兩把的重量）</small>`;

    $('loStats').innerHTML = STAT_ROWS.map(r => {
      const v = st[r.key], pv = prev ? prev[r.key] : v;
      const diff = v - pv;
      const good = Math.abs(diff) < 1e-6 ? '' : ((diff > 0) === (r.better === 'high') ? 'up' : 'down');
      const pct = Math.min(100, v / r.max * 100);
      const ppct = Math.min(100, pv / r.max * 100);
      return `<div class="st ${good}"><span class="sl">${r.label}</span>
        <span class="sb"><i style="width:${pct}%"></i>${good ? `<b style="left:${Math.min(pct, ppct)}%;width:${Math.abs(pct - ppct)}%"></b>` : ''}</span>
        <span class="sv">${good ? `<s>${r.fmt(pv)}</s> ` : ''}${r.fmt(v)}</span></div>`;
    }).join('');
    $('loNote').innerHTML = notes.map(n => `<div>${n}</div>`).join('');

    const rows = $('loRows');
    rows.innerHTML = '';
    rows.appendChild(chips('彈種', Object.entries(CALIBERS).map(([id, c]) => ({ id, name: c.name })), b.caliber, 'caliber'));
    rows.appendChild(chips('槍機', Object.entries(RECEIVERS).filter(([, r]) => r.caliber === b.caliber)
      .map(([id, r]) => ({ id, name: r.name, why: null, desc: r.desc })), b.receiver, 'receiver'));
    for (const s of SLOTS) {
      rows.appendChild(chips(s.label, PARTS[s.key].map(p => ({ id: p.id, name: p.name, why: blockReason(s.key, p, b) })), b[s.key], s.key));
    }
    showWeapon(b);
  }

  document.querySelectorAll('#loTabs button').forEach((t, i) => {
    t.onclick = () => { slot = i; prev = null; notes = []; render(); };
  });
  $('loDone').onclick = () => {
    saveLoadout(lo);
    screen.classList.add('hidden');
    preview.stop();
    onDone(lo);
  };
  screen.classList.remove('hidden');
  screen.scrollTop = 0;
  render();
  preview.start();
}

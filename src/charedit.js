// ---------- 角色工坊：分部位堆方塊（電腦操作） ----------
// 中間是編輯視窗：目前部位實心、其他部位半透明當參考；右邊是會動的預覽
import * as THREE from 'three';
import { sfx } from './audio.js';
import { GUN_Y } from './core.js';
import { V } from './voxel.js';
import {
  LOOK_PARTS, PART_KEYS, MAX_VOXELS, key, inSpace, inCore, mirrorX, partOrigin,
  cloneLook, countVoxels, serializeLook, parseLook, loadPlayerLook, savePlayerLook, playerDefaultLook,
} from './character.js';
import { makeBlockMan, animateMan, applyLook, setHand } from './models.js';
import { buildMenu } from './main.js';
import { player } from './player.js';

const $ = id => document.getElementById(id);
const PALETTE = [
  0x111111, 0x3a3d45, 0x6b6f7a, 0xa4a9b4, 0xe8eaee, 0xffffff, 0x2a2420, 0x5a3a22,
  0x8a5a32, 0xc08a50, 0xf0c9a0, 0xd9b48c, 0xa8744c, 0x6e4630, 0xffd8b0, 0xffb0a0,
  0x8a1c1c, 0xd8342c, 0xff6a3d, 0xffa630, 0xffd84a, 0xfff2a0, 0x2f6b2a, 0x4caf50,
  0x9be36a, 0x1f5fa8, 0x2f8cff, 0x7cc8ff, 0x23324d, 0x6a3fb0, 0xc070ff, 0xff70c0,
];
const TOOLS = { place: '堆方塊（B）', paint: '上色（F）', pick: '吸顏色（I）' };
const ANIMS = { idle: '站著', walk: '走路', aim: '舉槍走' };

let look = null, cur = 'head', tool = 'place', color = 0x2f8cff, anim = 'aim', brush = 1;
let undo = [], redo = [];
let view = null, prev = null;

// ---------- 編輯視窗 ----------
function makeView() {
  const el = $('ceView');
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x161a22);
  el.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xe6ecff, 0x40352a, 1.7));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(1.5, 3, 2.5);
  scene.add(sun);
  const back = new THREE.DirectionalLight(0xffffff, 0.6);
  back.position.set(-2, 1, -2);
  scene.add(back);
  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 30);
  const v = {
    el, renderer, scene, camera, yaw: 0.55, pitch: 0.35, dist: 1, target: new THREE.Vector3(),
    root: new THREE.Group(), solidMat: new THREE.MeshLambertMaterial({ color: 0xffffff }),
    ghostMat: new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, depthWrite: false }),
    inst: null, coords: [], hover: null, raf: 0,
  };
  scene.add(v.root);
  // 滑鼠指到的地方：要放的方塊（半透明）、指到的方塊（框）
  v.ghost = new THREE.Mesh(new THREE.BoxGeometry(V, V, V), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false }));
  v.outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(V * 1.04, V * 1.04, V * 1.04)), new THREE.LineBasicMaterial({ color: 0xffd060 }));
  v.ghost.visible = v.outline.visible = false;
  scene.add(v.ghost, v.outline);
  v.ray = new THREE.Raycaster();
  bindView(v);
  const loop = () => {
    v.raf = requestAnimationFrame(loop);
    const w = el.clientWidth, h = el.clientHeight;
    if (w && renderer.domElement.width !== Math.floor(w * renderer.getPixelRatio())) {
      renderer.setSize(w, h);
      camera.aspect = w / h; camera.updateProjectionMatrix();
    }
    camera.position.set(
      v.target.x + v.dist * Math.sin(v.yaw) * Math.cos(v.pitch),
      v.target.y + v.dist * Math.sin(v.pitch),
      v.target.z + v.dist * Math.cos(v.yaw) * Math.cos(v.pitch));
    camera.lookAt(v.target);
    renderer.render(scene, camera);
  };
  v.start = () => { if (!v.raf) loop(); };
  v.stop = () => { cancelAnimationFrame(v.raf); v.raf = 0; };
  return v;
}

const boxEdges = (w, h, d, color, opacity) => {
  const g = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
  return g;
};

function instOf(p, mat, keepCoords) {
  const vox = [...look.parts[p].values()];
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(V, V, V), mat, Math.max(1, vox.length));
  mesh.count = vox.length;
  const m = new THREE.Matrix4(), c = new THREE.Color();
  vox.forEach(([x, y, z, hex], i) => {
    m.makeTranslation((x + 0.5) * V, (y + 0.5) * V, (z + 0.5) * V);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, c.setHex(hex));
  });
  if (keepCoords) mesh.userData.coords = vox.map(([x, y, z]) => [x, y, z]);
  mesh.computeBoundingSphere();
  return mesh;
}

// 整個角色重畫（方塊數不多，每次改都整個重建就好）
function rebuildView() {
  const v = view;
  for (const c of [...v.root.children]) { v.root.remove(c); c.geometry?.dispose(); }
  for (const p of PART_KEYS) {
    const g = new THREE.Group();
    g.position.set(...partOrigin(p));
    const mesh = instOf(p, p === cur ? v.solidMat : v.ghostMat, p === cur);
    g.add(mesh);
    if (p === cur) {
      v.inst = mesh;
      const P = LOOK_PARTS[p], [sw, sh, sd] = P.size, [cx, cy, cz, cw, chh, cd] = P.core;
      const space = boxEdges(sw * V, sh * V, sd * V, 0xffffff, 0.35);
      space.position.set(sw * V / 2, sh * V / 2, sd * V / 2);
      // 核心常常被包在裡面：框線畫在最上層，隔著方塊也看得到
      const core = boxEdges(cw * V + 0.004, chh * V + 0.004, cd * V + 0.004, 0xff9a40, 1);
      core.material.depthTest = false; core.renderOrder = 10;
      core.position.set((cx + cw / 2) * V, (cy + chh / 2) * V, (cz + cd / 2) * V);
      // 空間底面的格線
      const pts = [];
      for (let i = 0; i <= sw; i++) pts.push(i * V, 0, 0, i * V, 0, sd * V);
      for (let k = 0; k <= sd; k++) pts.push(0, 0, k * V, sw * V, 0, k * V);
      const gg = new THREE.BufferGeometry();
      gg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const grid = new THREE.LineSegments(gg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12 }));
      g.add(space, core, grid);
      v.partGroup = g;
    }
    v.root.add(g);
  }
  v.root.updateMatrixWorld(true);
  updateHover();
}

function focusPart() {
  const P = LOOK_PARTS[cur], o = partOrigin(cur);
  view.target.set(o[0] + P.size[0] * V / 2, o[1] + P.size[1] * V / 2, o[2] + P.size[2] * V / 2);
  // 依視窗比例拉遠，整個部位的空間都放得下
  const aspect = view.camera.aspect || 1;
  view.dist = Math.max(P.size[1], P.size[0] / Math.min(1, aspect), P.size[2]) * V * 3.4;
}

// ---------- 滑鼠 ----------
// 左鍵按在方塊上 = 一筆（拖曳就連續畫）；按在空白處或中鍵 = 轉視角
// 放方塊 / 挖方塊的一筆會鎖在第一下的那一層，才不會一路往鏡頭疊過來
let mouse = null;   // { sx, sy, x, y, mode: 'orbit' | 'stroke' | 'none', st }
const opOf = (btn, e) => btn === 2 ? 'erase' : e.altKey ? 'pick' : e.shiftKey ? 'paint' : tool;
function bindView(v) {
  const c = v.renderer.domElement;
  const setNdc = e => {
    const r = c.getBoundingClientRect();
    v.ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    v.mods = { shift: e.shiftKey, alt: e.altKey };
  };
  c.addEventListener('pointerdown', e => {
    setNdc(e);
    c.setPointerCapture(e.pointerId);
    mouse = { sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, mode: 'orbit' };
    const h = e.button === 1 ? null : pickVoxel();
    if (h) {
      const op = opOf(e.button, e);
      if (op === 'pick') {
        setColor(look.parts[cur].get(key(h.x, h.y, h.z))[3]);
        if (tool === 'pick') setTool('place');
        mouse.mode = 'none';
      } else {
        mouse.mode = 'stroke';
        mouse.st = startStroke(op, h);
      }
    }
    updateHover();
  });
  c.addEventListener('pointermove', e => {
    setNdc(e);
    if (mouse?.mode === 'orbit' && Math.hypot(e.clientX - mouse.sx, e.clientY - mouse.sy) > 3) {
      v.el.classList.add('drag');
      v.yaw -= (e.clientX - mouse.x) * 0.008;
      v.pitch = Math.max(-1.4, Math.min(1.4, v.pitch + (e.clientY - mouse.y) * 0.008));
    } else if (mouse?.mode === 'stroke') continueStroke(mouse.st);
    if (mouse) { mouse.x = e.clientX; mouse.y = e.clientY; }
    updateHover();
  });
  const up = () => {
    if (mouse?.mode === 'stroke') endStroke(mouse.st);
    mouse = null; v.el.classList.remove('drag');
    updateHover();
  };
  c.addEventListener('pointerup', e => { setNdc(e); up(); });
  c.addEventListener('pointercancel', up);
  c.addEventListener('pointerleave', () => { if (!mouse) { v.ndc = null; updateHover(); } });
  c.addEventListener('wheel', e => {
    e.preventDefault();
    v.dist = Math.max(0.25, Math.min(6, v.dist * (e.deltaY > 0 ? 1.12 : 1 / 1.12)));
  }, { passive: false });
}

// 指到哪一顆、哪一面（axis 0/1/2 = x/y/z，sign = 面朝哪邊）
function pickVoxel() {
  const v = view;
  if (!v.ndc || !v.inst) return null;
  v.camera.updateMatrixWorld();
  v.ray.setFromCamera(v.ndc, v.camera);
  const hit = v.ray.intersectObject(v.inst)[0];
  if (!hit || hit.instanceId === undefined) return null;
  const [x, y, z] = v.inst.userData.coords[hit.instanceId];
  const n = [Math.round(hit.face.normal.x), Math.round(hit.face.normal.y), Math.round(hit.face.normal.z)];
  const axis = n.findIndex(a => a !== 0);
  return { x, y, z, nx: x + n[0], ny: y + n[1], nz: z + n[2], axis, sign: n[axis] };
}

// 滑鼠射線打到「某一軸 = coord」那個平面的哪一格（部位的格子座標）
function rayOnPlane(axis, coord) {
  const v = view;
  if (!v.ndc) return null;
  v.camera.updateMatrixWorld();
  v.ray.setFromCamera(v.ndc, v.camera);
  const o = partOrigin(cur);
  const ro = v.ray.ray.origin, rd = v.ray.ray.direction;
  const O = [(ro.x - o[0]) / V, (ro.y - o[1]) / V, (ro.z - o[2]) / V], D = [rd.x, rd.y, rd.z];
  if (Math.abs(D[axis]) < 1e-6) return null;
  const t = (coord - O[axis]) / D[axis];
  if (t < 0) return null;
  return [0, 1, 2].map(a => Math.floor(O[a] + D[a] * t));
}

// 筆刷：size × size（放 / 挖是立方體，上色是一個面）
function brushCells(cx, cy, cz, axis, sign, op) {
  const n = brush, lo = -Math.floor((n - 1) / 2);
  const out = [];
  const depth = op === 'paint' ? 1 : n;
  const dir = op === 'erase' ? -sign : sign;   // 挖：往裡面；放：往外面
  const [b, c] = [0, 1, 2].filter(a => a !== axis);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let d = 0; d < depth; d++) {
    const p = [cx, cy, cz];
    p[b] += lo + i; p[c] += lo + j; p[axis] += dir * d;
    out.push(p);
  }
  return out;
}

// 這次操作要動到哪些格子：左右對稱、左右手腳一起改
function targets(x, y, z) {
  const out = [[cur, x, y, z]];
  if ($('ceMirror').checked) out.push([cur, mirrorX(cur, x), y, z]);
  const twin = LOOK_PARTS[cur].twin;
  if (twin && $('ceTwin').checked) for (const [, tx, ty, tz] of [...out]) out.push([twin, mirrorX(twin, tx), ty, tz]);
  return out;
}

// 套用一次筆刷；回傳有沒有改到
function applyBrush(op, cells) {
  const seen = new Set();
  const ts = [];
  for (const [x, y, z] of cells) for (const t of targets(x, y, z)) {
    const k = t.join();
    if (seen.has(k) || !inSpace(t[0], t[1], t[2], t[3])) continue;
    seen.add(k); ts.push(t);
  }
  let changed = false;
  if (op === 'place') {
    const add = ts.filter(([p, x, y, z]) => !look.parts[p].has(key(x, y, z)));
    if (countVoxels(look) + add.length > MAX_VOXELS) { msg(`方塊上限 ${MAX_VOXELS} 顆`); return false; }
    for (const [p, x, y, z] of add) { look.parts[p].set(key(x, y, z), [x, y, z, color]); changed = true; }
  } else if (op === 'erase') {
    for (const [p, x, y, z] of ts) if (!inCore(p, x, y, z) && look.parts[p].delete(key(x, y, z))) changed = true;
  } else if (op === 'paint') {
    for (const [p, x, y, z] of ts) {
      const vx = look.parts[p].get(key(x, y, z));
      if (vx && vx[3] !== color) { vx[3] = color; changed = true; }
    }
  }
  return changed;
}

function startStroke(op, h) {
  const st = { op, before: cloneLook(look), changed: false, done: new Set(), axis: h.axis, sign: h.sign };
  // 鎖定的那一層：放方塊 = 點到那面外面一層；挖 = 點到的那顆那一層
  const hit = [h.x, h.y, h.z];
  const c0 = op === 'place' ? [h.nx, h.ny, h.nz] : hit;
  st.layer = c0[h.axis];
  st.plane = h.sign > 0 ? hit[h.axis] + 1 : hit[h.axis];
  if (op === 'place' && !inSpace(cur, ...c0)) { msg('超出這個部位能堆的範圍'); st.dead = true; return st; }
  if (op === 'erase' && brush === 1 && inCore(cur, h.x, h.y, h.z)) msg('骨架核心刪不掉，只能換顏色');
  strokeAt(st, c0, h.axis, h.sign);
  return st;
}
function strokeAt(st, c, axis, sign) {
  const k = c.join() + '|' + axis + sign;
  if (st.done.has(k)) return;
  st.done.add(k);
  if (applyBrush(st.op, brushCells(c[0], c[1], c[2], axis, sign, st.op))) {
    st.changed = true;
    rebuildView();
    renderCount();
  }
}
function continueStroke(st) {
  if (st.dead) return;
  if (st.op === 'paint') {
    const h = pickVoxel();
    if (h) strokeAt(st, [h.x, h.y, h.z], h.axis, h.sign);
    return;
  }
  const c = rayOnPlane(st.axis, st.plane);
  if (!c) return;
  c[st.axis] = st.layer;
  strokeAt(st, c, st.axis, st.sign);
}
function endStroke(st) {
  if (!st.changed) return;
  undo.push(st.before); if (undo.length > 100) undo.shift();
  redo = [];
  sfx.click();
  refresh();
}

// 滑鼠指著的地方：畫出筆刷會動到的範圍
function updateHover() {
  const v = view;
  if (!v) return;
  v.ghost.visible = v.outline.visible = false;
  if (mouse && mouse.mode !== 'stroke') return;
  const h = pickVoxel();
  if (!h) return;
  const op = mouse?.st?.op ?? (v.mods?.alt ? 'pick' : v.mods?.shift ? 'paint' : tool);
  const o = partOrigin(cur);
  const fit = (cells, obj) => {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const p of cells) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], p[a]); mx[a] = Math.max(mx[a], p[a]); }
    obj.position.set(o[0] + (mn[0] + mx[0] + 1) / 2 * V, o[1] + (mn[1] + mx[1] + 1) / 2 * V, o[2] + (mn[2] + mx[2] + 1) / 2 * V);
    obj.scale.set(mx[0] - mn[0] + 1, mx[1] - mn[1] + 1, mx[2] - mn[2] + 1);
    obj.visible = true;
  };
  if (op === 'place' && inSpace(cur, h.nx, h.ny, h.nz)) {
    fit(brushCells(h.nx, h.ny, h.nz, h.axis, h.sign, 'place'), v.ghost);
    v.ghost.material.color.setHex(color);
  }
  fit(op === 'pick' ? [[h.x, h.y, h.z]] : brushCells(h.x, h.y, h.z, h.axis, h.sign, op === 'place' ? 'paint' : op), v.outline);
}

let msgT = 0;
function msg(t) {
  const el = $('ceMsg');
  el.textContent = t; el.classList.add('show');
  clearTimeout(msgT); msgT = setTimeout(() => el.classList.remove('show'), 1400);
}

// ---------- 右邊的預覽：會走路、舉槍 ----------
function makePrev() {
  const el = $('cePreview');
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  el.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xdde6ff, 0x30281e, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(2, 4, 3);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
  camera.position.set(0, 1.6, 4.2);
  camera.lookAt(0, 0.8, 0);
  const p = { el, renderer, scene, camera, man: null, raf: 0, last: 0, spin: 0.6 };
  const loop = t => {
    p.raf = requestAnimationFrame(loop);
    const dt = Math.min(0.05, (t - (p.last || t)) / 1000); p.last = t;
    const w = el.clientWidth, h = el.clientHeight;
    if (w && renderer.domElement.width !== Math.floor(w * renderer.getPixelRatio())) {
      renderer.setSize(w, h);
      camera.aspect = w / h; camera.updateProjectionMatrix();
    }
    if (p.man) {
      p.spin += dt * 0.6;
      p.man.body.rotation.y = p.spin;
      animateMan(p.man, anim === 'idle' ? 0 : 0.7, dt, anim === 'aim');
    }
    renderer.render(scene, camera);
  };
  p.start = () => { if (!p.raf) { p.last = 0; p.raf = requestAnimationFrame(loop); } };
  p.stop = () => { cancelAnimationFrame(p.raf); p.raf = 0; };
  return p;
}
function rebuildPrev() {
  if (!prev.man) {
    prev.man = makeBlockMan({ look });
    prev.scene.add(prev.man.root);
    // 拿著玩家目前的槍
    const s = player.slots[player.cur];
    if (s) { prev.man.gun.add(s.mesh.clone()); prev.man.gun.position.y = GUN_Y - s.muzzleY; }
    setHand(prev.man, player.man.hand);
  } else applyLook(prev.man, look);
}

// ---------- 左右兩欄 ----------
function chips(boxId, items, isOn, onTap) {
  const box = $(boxId);
  box.innerHTML = '';
  for (const [k, name] of Object.entries(items)) {
    const b = document.createElement('button');
    b.className = 'chip' + (isOn(k) ? ' on' : '');
    b.textContent = name;
    b.onclick = () => { sfx.click(); onTap(k); };
    box.appendChild(b);
  }
}
function setPart(p) { cur = p; focusPart(); refresh(); }
function setTool(t) { tool = t; renderSide(); }
function setColor(c) { color = c; $('ceColor').value = '#' + c.toString(16).padStart(6, '0'); renderSide(); updateHover(); }
function swatches(boxId, list) {
  const box = $(boxId);
  box.innerHTML = '';
  for (const c of list) {
    const b = document.createElement('button');
    b.style.background = '#' + c.toString(16).padStart(6, '0');
    b.title = b.style.background;
    if (c === color) b.className = 'on';
    b.onclick = () => setColor(c);
    box.appendChild(b);
  }
}
function renderSide() {
  chips('ceParts', Object.fromEntries(PART_KEYS.map((p, i) => [p, `${i + 1} ${LOOK_PARTS[p].name}`])), p => p === cur, setPart);
  chips('ceTools', TOOLS, t => t === tool, setTool);
  chips('ceAnim', ANIMS, a => a === anim, a => { anim = a; renderSide(); });
  $('ceHex').textContent = '#' + color.toString(16).padStart(6, '0');
  swatches('cePalette', PALETTE);
  const used = new Set();
  for (const p of PART_KEYS) for (const v of look.parts[p].values()) used.add(v[3]);
  swatches('ceUsed', [...used].slice(0, 32));
  chips('ceBrush', { 1: '1', 2: '2', 3: '3', 4: '4', 5: '5' }, b => +b === brush, b => { brush = +b; renderSide(); updateHover(); });
  renderCount();
}
function renderCount() { $('ceCount').textContent = `方塊 ${countVoxels(look)} / ${MAX_VOXELS}`; }
function refresh() { rebuildView(); rebuildPrev(); renderSide(); }

function doUndo() { if (!undo.length) return; redo.push(cloneLook(look)); look = undo.pop(); refresh(); }
function doRedo() { if (!redo.length) return; undo.push(cloneLook(look)); look = redo.pop(); refresh(); }
function change(fn) { undo.push(cloneLook(look)); redo = []; fn(); refresh(); }

function onKey(e) {
  if ($('charEdit').classList.contains('hidden') || e.target.tagName === 'TEXTAREA') return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); doRedo(); return; }
  if (e.ctrlKey || e.metaKey) return;
  if (k === 'b') setTool('place');
  else if (k === 'f') setTool('paint');
  else if (k === 'i') setTool('pick');
  else if (k === 'm') { $('ceMirror').checked = !$('ceMirror').checked; }
  else if (k === '[' || k === ']') { brush = Math.max(1, Math.min(5, brush + (k === ']' ? 1 : -1))); renderSide(); updateHover(); }
  else if (k >= '1' && k <= '6') setPart(PART_KEYS[+k - 1]);
  else if (e.key === 'Shift' || e.key === 'Alt') { view.mods = { shift: e.shiftKey, alt: e.altKey }; updateHover(); }
  if (e.key === 'Alt') e.preventDefault();
}
function onKeyUp(e) {
  if (view && (e.key === 'Shift' || e.key === 'Alt')) { view.mods = { shift: e.shiftKey, alt: e.altKey }; updateHover(); }
}

// ---------- 開關 ----------
let onClose = null;
export function openCharEdit(done) {
  onClose = done;
  if (!view) { view = makeView(); prev = makePrev(); wire(); }
  look = loadPlayerLook();
  undo = []; redo = [];
  $('menu').classList.add('hidden');
  $('charEdit').classList.remove('hidden');
  $('ceCode').value = '';
  const el = $('ceView');
  view.camera.aspect = (el.clientWidth / el.clientHeight) || 1;
  focusPart();
  refresh();
  setColor(color);
  view.start(); prev.start();
}
function close(save) {
  if (save) { savePlayerLook(look); applyLook(player.man, look); }
  view.stop(); prev.stop();
  $('charEdit').classList.add('hidden');
  buildMenu();
  $('menu').classList.remove('hidden');
  onClose?.();
}

function wire() {
  $('ceDone').onclick = () => { sfx.click(); close(true); };
  $('ceCancel').onclick = () => { sfx.click(); close(false); };
  $('ceUndo').onclick = doUndo;
  $('ceRedo').onclick = doRedo;
  $('ceColor').oninput = e => setColor(parseInt(e.target.value.slice(1), 16));
  $('ceClearPart').onclick = () => change(() => {
    for (const [k, [x, y, z]] of [...look.parts[cur]]) if (!inCore(cur, x, y, z)) look.parts[cur].delete(k);
  });
  $('ceReset').onclick = () => change(() => { look = playerDefaultLook(); });
  $('ceCopy').onclick = () => {
    const s = JSON.stringify(serializeLook(look));
    $('ceCode').value = s;
    navigator.clipboard?.writeText(s).then(() => msg('已複製造型碼'), () => {});
  };
  $('ceImport').onclick = () => {
    try { const L = parseLook($('ceCode').value.trim()); change(() => { look = L; }); msg('匯入完成'); }
    catch { msg('造型碼看不懂'); }
  };
  wireRef();
  addEventListener('keydown', onKey);
  addEventListener('keyup', onKeyUp);
}

// ---------- 參考圖：放在編輯視窗旁邊，點一下吸色 ----------
const REF_KEY = 'brickshooter.ceref';
const refCanvas = document.createElement('canvas');
let refCtx = null;
function showRef(src, remember) {
  const img = $('ceRefImg');
  img.onload = () => {
    refCanvas.width = img.naturalWidth; refCanvas.height = img.naturalHeight;
    refCtx = refCanvas.getContext('2d', { willReadFrequently: true });
    refCtx.drawImage(img, 0, 0);
    $('ceRef').classList.remove('hidden');
    if (remember) { try { localStorage.setItem(REF_KEY, src); } catch { /* 圖太大存不了，只影響下次打開 */ } }
  };
  img.src = src;
}
function loadRefFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const r = new FileReader();
  r.onload = () => showRef(r.result, true);
  r.readAsDataURL(file);
}
function refColorAt(e) {
  const img = $('ceRefImg');
  if (!refCtx) return null;
  const rc = img.getBoundingClientRect();
  const x = Math.floor((e.clientX - rc.left) / rc.width * img.naturalWidth);
  const y = Math.floor((e.clientY - rc.top) / rc.height * img.naturalHeight);
  if (x < 0 || y < 0 || x >= img.naturalWidth || y >= img.naturalHeight) return null;
  const [r, g, b, a] = refCtx.getImageData(x, y, 1, 1).data;
  return a < 10 ? null : (r << 16) | (g << 8) | b;
}
function wireRef() {
  $('ceRefLoad').onclick = () => $('ceRefFile').click();
  $('ceRefFile').onchange = e => { loadRefFile(e.target.files[0]); e.target.value = ''; };
  $('ceRefClose').onclick = () => { $('ceRef').classList.add('hidden'); try { localStorage.removeItem(REF_KEY); } catch { /* 沒差 */ } };
  const img = $('ceRefImg');
  img.addEventListener('pointermove', e => {
    const c = refColorAt(e);
    $('ceRefSw').style.background = c === null ? 'transparent' : '#' + c.toString(16).padStart(6, '0');
  });
  img.addEventListener('click', e => { const c = refColorAt(e); if (c !== null) { setColor(c); sfx.click(); } });
  // 拖著標題列移動面板
  const bar = $('ceRef').querySelector('.ce-ref-bar');
  bar.addEventListener('pointerdown', e => {
    if (e.target.tagName === 'BUTTON') return;
    const panel = $('ceRef'), box = panel.parentElement.getBoundingClientRect(), pr = panel.getBoundingClientRect();
    const ox = e.clientX - pr.left, oy = e.clientY - pr.top;
    bar.setPointerCapture(e.pointerId);
    const mv = ev => {
      panel.style.left = Math.max(0, Math.min(box.width - 60, ev.clientX - box.left - ox)) + 'px';
      panel.style.top = Math.max(0, Math.min(box.height - 30, ev.clientY - box.top - oy)) + 'px';
      panel.style.right = 'auto';
    };
    const upH = () => { bar.removeEventListener('pointermove', mv); bar.removeEventListener('pointerup', upH); };
    bar.addEventListener('pointermove', mv);
    bar.addEventListener('pointerup', upH);
  });
  // 拖檔案進來、Ctrl+V 貼上
  const ce = $('charEdit');
  ce.addEventListener('dragover', e => e.preventDefault());
  ce.addEventListener('drop', e => { e.preventDefault(); loadRefFile(e.dataTransfer.files[0]); });
  addEventListener('paste', e => {
    if (ce.classList.contains('hidden') || e.target.tagName === 'TEXTAREA') return;
    const item = [...(e.clipboardData?.items ?? [])].find(i => i.type.startsWith('image/'));
    if (item) loadRefFile(item.getAsFile());
  });
  try { const s = localStorage.getItem(REF_KEY); if (s) showRef(s, false); } catch { /* 沒存過 */ }
}

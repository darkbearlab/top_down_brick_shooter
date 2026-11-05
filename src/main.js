import { sfx, unlockAudio } from './audio.js';
import { BREACH_LEVELS, DARK_LEVELS } from './rooms.js';
import { setHand } from './models.js';
import { loadLoadout, openLoadout } from './loadout.js';
import { endRunGear, showRewards, startRun } from './run.js';
import { updateItems } from './items.js';
import { CUSTOM_LEVELS } from './custom_levels.js';
import { openEditor } from './editor.js';
import { openMissionSetup, playRandom } from './missionsetup.js';
import { openCharEdit } from './charedit.js';
import { updateSwingDoors } from './swingdoors.js';
import { setLighting, CAM_PITCH, G, GUN_Y, MAX_HITS, bodyLight, camDist, camTarget, camera, flashlight, input, muzzleLight, renderer, scene, sun } from './core.js';
import { debris, fx, markers, setWallTest, updateMarkers, updateParticles } from './fx.js';
import { MODE_NAMES, setTestLevel, W, H, wallAt, buildFlow, goalText, level, levelDefs, levelLabel, loadLevel, updateGates, updateLamps, updateObjectives, updateSpawner, updateSwitches } from './world.js';
import { bullets, spawnBullet, updateBullets } from './bullets.js';
import { HAND_KEY, curSlot, equipLoadout, player, playerMuzzle, updatePlayer } from './player.js';
import { enemies, freeEnemy, killEnemy, updateEnemies } from './enemies.js';

// ---------- 遊戲流程 ----------
export let flowTimer = 0;
export const $ = id => document.getElementById(id);
export const flashEl = $('flash'), fadeEl = $('fade'), hudEl = $('hud');
export const menuEl = $('menu'), panelEl = $('panel'), toastEl = $('toast'), goalEl = $('goal');

export function clearEntities() {
  for (const e of enemies) freeEnemy(e);
  enemies.length = 0;
  for (const b of bullets) scene.remove(b.g);
  bullets.length = 0;
  for (const d of debris) scene.remove(d.m);
  debris.length = 0;
  for (const f of fx) { scene.remove(f.m); f.m.material.dispose(); }
  fx.length = 0;
  for (const m of markers) { scene.remove(m.s); m.s.material.dispose(); }
  markers.length = 0;
}

export function nextLevel() {
  if (G.state !== 'play') return;
  const defs = levelDefs(level.mode), mode = level.mode;
  if (mode === 'run') {
    G.state = 'complete';
    player.laser.g.visible = player.guide.g.visible = false;
    showRewards();
    return;
  }
  const last = mode !== 'arena' && level.index + 1 >= defs.length;
  if (last && mode === 'random') {
    G.state = 'complete';
    player.laser.g.visible = player.guide.g.visible = false;
    showPanel('任務完成', level.def.name, [
      { label: '下一張地圖', primary: true, run: () => playRandom() },
      { label: '重玩這張', run: () => startGame('random', 0) },
      { label: '回主選單', run: showMenu },
    ]);
    return;
  }
  if (last) {
    G.state = 'complete';
    player.laser.g.visible = player.guide.g.visible = false;
    const msg = mode === 'test' ? '這關打得過' : `${defs.length} 個${MODE_NAMES[mode]}關卡全部清除`;
    showPanel(mode === 'test' ? '測試完成' : '任務完成', msg, [
      { label: mode === 'test' ? '再測一次' : '再玩一次', primary: true, run: () => startGame(mode, 0) },
      { label: leaveLabel(), run: leaveLevel },
    ]);
    return;
  }
  G.state = 'transition';
  player.laser.g.visible = player.guide.g.visible = false;
  fadeEl.style.opacity = 1;
  setTimeout(() => {
    if (level.mode !== 'arena') player.hits = 0;   // 破門、黑暗模式每關重新給 3 次
    loadLevel(level.mode, level.index + 1);
    fadeEl.style.opacity = 0;
  }, 260);
}

export function retryLevel() {
  hidePanel();
  player.hits = 0;   // 死了就在同一關重來，被彈次數歸零
  loadLevel(level.mode, level.index);
}

export function startGame(mode, index) {
  if (mode !== 'run') endRunGear();
  player.armor = 0;
  $('previewBar').classList.add('hidden');
  $('editor').classList.add('hidden');
  menuEl.classList.add('hidden');
  hidePanel();
  hudEl.classList.remove('hidden');
  player.hits = 0;
  loadLevel(mode, index);
}

export function updateHud() {
  const el = $('hits');
  el.innerHTML = '';
  for (let i = 0; i < MAX_HITS; i++) {
    const d = document.createElement('div');
    d.className = 'pip' + (i < player.hits ? ' lost' : '');
    el.appendChild(d);
  }
  for (let i = 0; i < player.armor; i++) {
    const d = document.createElement('div');
    d.className = 'pip armor';
    el.appendChild(d);
  }
  updateAmmoHud();
}

export const ammoEl = $('ammo'), ammoFill = $('ammoBar').firstElementChild, swapBtn = $('swapBtn');
export function updateAmmoHud() {
  const p = player, s = curSlot();
  if (!s) return;
  const st = s.stats, other = p.slots[p.cur ^ 1];
  const reloading = s.reloadT > 0;
  $('wName').textContent = st.name;
  $('ammoNum').textContent = reloading ? 'RELOAD' : `${s.ammo}/${st.mag}`;
  ammoFill.style.width = (reloading ? (1 - s.reloadT / st.reload) : s.ammo / st.mag) * 100 + '%';
  ammoEl.classList.toggle('reloading', reloading);
  ammoEl.classList.toggle('low', !reloading && s.ammo <= Math.ceil(st.mag / 4));
  $('wAlt').textContent = other ? `${other.stats.name} ${other.ammo}/${other.stats.mag}` : '';
  swapBtn.classList.toggle('busy', p.swapT > 0);
  $('handBtn').textContent = p.man.hand > 0 ? '右手持槍' : '左手持槍';
}

export function showToast(text, cls) {
  toastEl.textContent = text;
  toastEl.className = '';
  void toastEl.offsetWidth;   // 重新觸發動畫
  toastEl.className = 'show ' + cls;
}

export function showPanel(title, html, buttons) {
  $('panelTitle').textContent = title;
  $('panelText').innerHTML = html;
  const box = $('panelButtons');
  box.innerHTML = '';
  for (const b of buttons) {
    const el = document.createElement('button');
    el.className = 'btn' + (b.primary ? ' primary' : '');
    el.textContent = b.label;
    el.addEventListener('click', () => { unlockAudio(); sfx.click(); b.run(); });
    box.appendChild(el);
  }
  panelEl.classList.remove('hidden');
}
export function hidePanel() { panelEl.classList.add('hidden'); }

export function pauseGame() {
  if (G.state !== 'play') return;
  G.state = 'paused';
  showPanel('暫停', levelLabel(), [
    { label: '繼續', primary: true, run: resumeGame },
    { label: '重來這關', run: retryLevel },
    { label: leaveLabel(), run: leaveLevel },
  ]);
}
export function resumeGame() {
  hidePanel();
  if (G.state === 'paused') G.state = 'play';
}

export const HELP_HTML = `<div class="keys">
<b>手機</b><br>
左半邊拖曳：移動<br>
右半邊拖曳：雷射瞄準，推過虛線圈：開火<br>
右半邊快速點一下：換彈<br>
右側「滾」按鈕：翻滾閃避（有冷卻，按鈕變暗時不能滾）<br>
左上角 ⇄ 按鈕：切換武器<br><br>
<b>電腦</b><br>
WASD 移動・滑鼠瞄準・左鍵開火<br>
空白鍵、Shift 或右鍵 翻滾閃避（翻滾前段無敵，之後冷卻約 0.75 秒，腳下的圈縮完就能再滾）<br>
R 換彈・滾輪或 1 / 2 切換武器<br>Q 左手持槍・E 右手持槍・Esc 暫停<br><br>
<b>敵人的子彈</b><br>
敵人打的是看得到的慢速彈丸，用走位和翻滾閃過去<br>
彈丸會被沙包擋下，但沙包也會被一點一點打掉<br><br>
<b>武器</b><br>
淡白線＝你想瞄的方向，雷射＝槍口實際方向<br>
越重的槍轉得越慢、切換也越慢<br><br>
<b>破門</b><br>
貼著木門往前推＝踹門，觸發慢動作<br>
也可以把門打爛，但沒有慢動作<br>
開槍會驚動附近的敵人<br><br>
<b>黑暗模式</b><br>
手電筒照向槍口實際的方向，轉得慢的槍掃得也慢<br>
黑暗中只看得到殭屍發光的眼睛，開槍的火光會短暫照亮四周<br>
巨型殭屍蓄力後會衝撞，引牠去撞牆會暈一下<br><br>
<b>關卡機關</b><br>
站在開關上一下：切換鐵捲門或燈<br>
殭屍會一直敲門，敲爛的鐵捲門就關不起來了<br>
磚牆、木門、沙包都打得爛，打穿的洞子彈和視線都過得去<br>
沙包（矮的）擋路不擋子彈；貼著沙包時，對面打來的子彈大多會被擋下並打掉一塊<br>
巨型殭屍一撞就能撞出大洞<br>
吊燈打得掉，打掉那一區就暗了
</div>`;

// 進入畫面的功能清單：之後新增功能只要加一筆
// 有 items 的是第二層選單
export const MENU_ITEMS = [
  { label: '闖關模式', sub: '從手槍開始・敵人組裝增援・每張圖打完三選一', run: () => startRun() },
  { label: '任務模式', sub: '彈幕試玩・清房・破門攻堅・黑暗・隨機任務', items: [
    { label: '彈幕試玩場', sub: '一間房・射手和重砲手的彈幕・試翻滾手感', run: () => startGame('trial', 0) },
    { label: '清房模式', sub: '一間一間清，無限循環、越來越難', run: () => startGame('arena', 0) },
    { label: '破門攻堅', sub: `${BREACH_LEVELS.length} 個關卡・踹門慢動作・敵人在門後待命`, run: () => startGame('breach', 0) },
    { label: '黑暗模式', sub: `${DARK_LEVELS.length} 個關卡・只有手電筒和吊燈・殭屍成群`, run: () => startGame('dark', 0) },
    { label: '隨機任務', sub: '自訂地圖大小、敵人數量、可能抽到的任務', run: openMissionSetup },
  ] },
  { label: '自訂戰鬥', sub: CUSTOM_LEVELS.length ? `${CUSTOM_LEVELS.length} 個關卡・用編輯器做的` : '還沒有關卡', run: showCustomList },
  { label: '關卡編輯器', sub: '擺物件、測試、複製 JSON（建議用電腦）', run: openEditor },
  { label: '角色工坊', sub: '用方塊一顆顆堆出自己的角色（電腦操作）', run: () => openCharEdit() },
  { label: '武器與裝備', sub: () => player.slots.map(s => s.stats.name).join(' ＋ '), run: showLoadout },
  { label: '操作說明', sub: '搖桿、換彈、破門', run: () => showPanel('操作說明', HELP_HTML, [{ label: '返回', primary: true, run: hidePanel }]) },
];
export function buildMenu(items = MENU_ITEMS) {
  const box = $('menuButtons');
  box.innerHTML = '';
  const list = items === MENU_ITEMS ? items : [...items, { label: '← 返回', run: () => buildMenu() }];
  list.forEach((it, i) => {
    const el = document.createElement('button');
    el.className = 'btn' + (i === 0 ? ' primary' : '');
    el.disabled = !!it.disabled;
    const sub = (typeof it.sub === 'function' ? it.sub() : it.sub) || '';
    el.innerHTML = `${it.label}${sub ? `<small>${sub}</small>` : ''}`;
    el.addEventListener('click', () => { unlockAudio(); sfx.click(); it.items ? buildMenu(it.items) : it.run(); });
    box.appendChild(el);
  });
}

export function showLoadout() {
  menuEl.classList.add('hidden');
  openLoadout(lo => {
    equipLoadout(lo);
    buildMenu();
    menuEl.classList.remove('hidden');
  });
}

// 從關卡回去：測試中的關卡回編輯器，其他回主選單
export const leaveLabel = () => level?.mode === 'test' ? '回編輯器' : '回主選單';
export function leaveLevel() { if (level?.mode === 'test') openEditor(); else showMenu(); }

// 編輯器：直接開打或只看地圖
export function testLevel(def) { setTestLevel(def); startGame('test', 0); }
export function previewLevel(def) {
  setTestLevel(def);
  hidePanel();
  menuEl.classList.add('hidden');
  hudEl.classList.add('hidden');
  $('editor').classList.add('hidden');
  loadLevel('test', 0);
  setLighting(false);   // 預覽一律全亮，看得清楚
  G.state = 'preview';
  $('previewBar').classList.remove('hidden');
}

function showCustomList() {
  if (!CUSTOM_LEVELS.length) {
    showPanel('自訂戰鬥', '還沒有自訂關卡<br>用「關卡編輯器」做好關卡，按「複製 JSON」貼給 Claude 就會加進來', [
      { label: '去關卡編輯器', primary: true, run: () => { hidePanel(); openEditor(); } },
      { label: '返回', run: hidePanel },
    ]);
    return;
  }
  showPanel('自訂戰鬥', '選一關開始，過關會接著打下一關', [
    ...CUSTOM_LEVELS.map((d, i) => ({ label: `${i + 1}. ${d.name ?? '未命名'}`, primary: i === 0, run: () => startGame('custom', i) })),
    { label: '返回', run: hidePanel },
  ]);
}

export function showMenu() {
  endRunGear();
  $('genSetup').classList.add('hidden');
  $('charEdit').classList.add('hidden');
  $('previewBar').classList.add('hidden');
  $('editor').classList.add('hidden');
  hidePanel();
  hudEl.classList.add('hidden');
  buildMenu();
  menuEl.classList.remove('hidden');
  loadLevel('breach', 0);   // 當背景
  G.state = 'menu';
  player.man.root.visible = false;
}

$('pauseBtn').addEventListener('click', pauseGame);
$('previewBack').addEventListener('click', openEditor);
$('previewPlay').addEventListener('click', () => startGame('test', 0));
swapBtn.addEventListener('pointerdown', e => { e.preventDefault(); input.swapPressed = true; });
$('handBtn').addEventListener('pointerdown', e => { e.preventDefault(); input.handPressed = true; });
$('rollBtn').addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); input.rollPressed = true; });
addEventListener('visibilitychange', () => { if (document.hidden && !TICK) pauseGame(); });



window.__dbg = { player, enemies, bullets, get level() { return level; }, startGame, spawnBullet, killEnemy: (e, dx = 0, dz = 0) => killEnemy(e, dx, dz) };  // 除錯用

try { if (localStorage.getItem(HAND_KEY) === '-1') setHand(player.man, -1); } catch { /* 用預設右手 */ }
setWallTest(wallAt);
equipLoadout(loadLoadout());
buildMenu();
showMenu();

// ?tick：用計時器跑主迴圈（除錯用，視窗被藏起來時 requestAnimationFrame 不會跑）
export const TICK = location.search.includes('tick');
export const nextFrame = TICK ? cb => setTimeout(() => cb(performance.now()), 16) : requestAnimationFrame;
export let last = performance.now();
export function frame(t) {
  nextFrame(frame);
  const raw = Math.min(0.05, (t - last) / 1000);
  last = t;
  G.now += raw;
  input.update();
  if (input.pausePressed) { if (G.state === 'play') pauseGame(); else if (G.state === 'paused') resumeGame(); }
  input.pausePressed = false;

  let dt = (window.__dbg.paused || G.state === 'paused') ? 0 : raw;
  if (dt > 0 && G.hitStop > 0) { G.hitStop -= raw; dt = 0; }
  if (dt > 0 && G.slowMo > 0) { G.slowMo -= raw; dt *= 0.32; }

  if (dt > 0 && (G.state === 'play' || G.state === 'dead')) {
    flowTimer -= dt;
    if (flowTimer <= 0 && player.alive) { buildFlow(); flowTimer = 0.2; }
    updatePlayer(dt);
    updateEnemies(dt);
    updateBullets(dt);
    updateMarkers(dt);
    updateSwitches(dt);
    updateSwingDoors(dt);
    updateGates(dt);
    updateSpawner(dt);
    updateItems(dt);
    updateObjectives(dt);
  }
  if (dt > 0) updateParticles(dt);
  input.reloadPressed = false;
  input.swapPressed = false;
  input.handPressed = false;
  input.handSet = 0;
  input.slotSet = -1;
  input.rollPressed = false;

  updateLamps(raw);
  const gt = goalText();
  if (goalEl.textContent !== gt) goalEl.textContent = gt;
  if (level.dark) {
    if (dt > 0) G.muzzleGlow -= dt;
    const on = player.alive && G.state !== 'menu';
    const mm = playerMuzzle();
    flashlight.intensity = on ? 26 : 0;
    flashlight.position.set(mm.x, GUN_Y + 0.05, mm.z);
    flashlight.target.position.set(mm.x + player.fx * 6, 0.2, mm.z + player.fz * 6);
    bodyLight.intensity = on ? 1.2 : 0;
    bodyLight.position.set(player.x, 1.6, player.z);
    muzzleLight.intensity = G.muzzleGlow > 0 ? 14 : 0;
    muzzleLight.position.set(mm.x, GUN_Y + 0.2, mm.z);
  }

  // 出口閃爍
  for (const m of level.exitMeshes) m.material.opacity = 0.35 + Math.sin(G.now * 6) * 0.2;

  // 攝影機：跟玩家、往瞄準方向前探、直式時讓角色偏下方；選單時慢慢飄
  const portrait = innerHeight > innerWidth;
  let lx, lz;
  // 關卡可以設 zoom：彈幕關卡拉遠一點，看得到更多彈丸
  const zoom = G.state === 'menu' ? 1 : level?.def?.zoom ?? 1;
  let dist = camDist * zoom;
  if (G.state === 'menu') {
    lx = Math.sin(G.now * 0.15) * 2;
    lz = Math.sin(G.now * 0.1) * (H / 2 - 4);
  } else if (G.state === 'preview') {
    // 預覽：整張地圖放進畫面
    const t = Math.tan(camera.fov * Math.PI / 360);
    lx = 0; lz = 0.6;
    dist = Math.max((W / 2 + 0.8) / (t * camera.aspect), (H / 2 + 0.8) * Math.sin(CAM_PITCH) / t);
  } else {
    const look = player.alive ? 1 : 0;
    lx = player.x + player.lookX * look;
    lz = player.z + player.lookZ * look - (portrait ? 1.6 : 0.5) * zoom;
  }
  const ck = G.state === 'preview' ? 1 : 1 - Math.exp(-(G.state === 'menu' ? 1 : 6) * raw);
  camTarget.x += (lx - camTarget.x) * ck;
  camTarget.z += (lz - camTarget.z) * ck;
  G.trauma = Math.max(0, G.trauma - raw * 1.8);
  const sh = G.trauma * G.trauma * 0.55;
  const ox = (Math.random() - 0.5) * sh, oz = (Math.random() - 0.5) * sh;
  camera.position.set(camTarget.x + ox, Math.sin(CAM_PITCH) * dist, camTarget.z + Math.cos(CAM_PITCH) * dist + oz);
  camera.lookAt(camTarget.x + ox, 0, camTarget.z + oz);
  // 陰影範圍跟著拉遠的鏡頭放大
  if (sun.shadow.camera.right !== 14 * zoom) {
    Object.assign(sun.shadow.camera, { left: -14 * zoom, right: 14 * zoom, top: 14 * zoom, bottom: -14 * zoom });
    sun.shadow.camera.updateProjectionMatrix();
  }
  sun.position.set(camTarget.x - 6, 16, camTarget.z + 4);
  sun.target.position.set(camTarget.x, 0, camTarget.z);

  renderer.render(scene, camera);
}
nextFrame(frame);

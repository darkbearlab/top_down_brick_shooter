// 關卡編輯器：在格子上擺物件，接開關線路，設定目標，預覽或直接測試，最後複製 JSON
import { ARENA_ROOMS, BREACH_LEVELS, DARK_LEVELS } from './rooms.js';
import { CUSTOM_LEVELS } from './custom_levels.js';
import { G } from './core.js';
import { mapRows } from './world.js';
import { previewLevel, testLevel, showMenu, hidePanel } from './main.js';

const KEY = 'brickshooter.editor.v1';
const MAX_SIZE = 60;   // 地圖寬高上限
const $ = id => document.getElementById(id);

// 調色盤：ch = 地圖字元；wire = 接在開關上的物件（地圖上存成 '*'，輸出時換成數字）
const PALETTE = [
  { group: '地形', items: [
    { ch: '.', name: '地板', bg: '#2c3240' },
    { ch: '#', name: '牆', bg: '#8a96b0' },
    { ch: 'D', name: '出口', bg: '#c8243c', glyph: '⇧' },
    { ch: 'W', name: '磚牆', bg: '#7a5644', glyph: '▦' },
    { ch: 'B', name: '木門', bg: '#a47a4a', glyph: '▭' },
    { ch: 'h', name: '沙包', bg: '#8a7a55', glyph: '▬' },
    { ch: 'V', name: '通風口', bg: '#15171c', glyph: '≡' },
  ] },
  { group: '物件', items: [
    { ch: 'P', name: '玩家', bg: '#2f8cff', glyph: '▲' },
    { ch: 'K', name: '開關', bg: '#2a2e36', glyph: '◉', fg: '#ff5030' },
    { ch: 'X', name: '物資', bg: '#2a3a48', glyph: '▣', fg: '#40e0ff' },
    { ch: 'Q', name: '人質', bg: '#e8e4da', glyph: '☺', fg: '#333' },
    { ch: 'L', name: '吊燈', bg: '#2c3240', glyph: '✦', fg: '#ffe2a8' },
    { ch: 'l', name: '閃爍燈', bg: '#2c3240', glyph: '✧', fg: '#ffe2a8' },
  ] },
  { group: '敵人', items: [
    { ch: 'R', name: '衝鋒兵', bg: '#d8433b', glyph: 'R' },
    { ch: 'S', name: '射手', bg: '#e0892a', glyph: 'S' },
    { ch: 'H', name: '重砲手', bg: '#7b4fcf', glyph: 'H' },
    { ch: 'Z', name: '殭屍', bg: '#5f7a52', glyph: 'Z' },
    { ch: 'G', name: '巨型殭屍', bg: '#6a6858', glyph: 'G' },
  ] },
  { group: '連動（接在開關上）', items: [
    { wire: 'gate', name: '鐵捲門・關', bg: '#4c5462', glyph: '▤' },
    { wire: 'gateOpen', name: '鐵捲門・開', bg: '#2c3240', glyph: '▤', fg: '#c8a438' },
    { wire: 'lamp', name: '燈・沒電', bg: '#2c3240', glyph: '✦', fg: '#777' },
    { wire: 'lampOn', name: '燈・有電', bg: '#2c3240', glyph: '✦', fg: '#ffe2a8' },
  ] },
];
const TILE = Object.fromEntries(PALETTE.flatMap(g => g.items).filter(i => i.ch).map(i => [i.ch, i]));
const WIRE = Object.fromEntries(PALETTE.flatMap(g => g.items).filter(i => i.wire).map(i => [i.wire, i]));
const WIRE_COLORS = ['#ff5a4a', '#ffb040', '#ffe040', '#60e070', '#40d0ff', '#4a7aff', '#b070ff', '#ff60c0', '#e8e8e8'];
const GOALS = [
  ['clear', '清光敵人'], ['activate', '打開所有開關'], ['hold', '撐住幾秒'], ['extract', '拿到物資撤離'], ['rescue', '清光後救人質'],
];

// ---------- 關卡資料 ----------
// doc = { name, w, h, dark, aware, goal, hold, wave, grid[r][c], wires{"r,c": {kind, group}}, sw{"r,c": [group...]} }
function newDoc(w = 13, h = 20) {
  const grid = Array.from({ length: h }, (_, r) => Array.from({ length: w }, (_, c) =>
    r === 0 || r === h - 1 || c === 0 || c === w - 1 ? '#' : '.'));
  const mid = Math.floor(w / 2);
  for (let c = mid - 1; c <= mid + 1; c++) grid[0][c] = 'D';
  grid[h - 3][mid] = 'P';
  return { name: '新關卡', w, h, dark: false, aware: false, goal: 'clear', hold: 60,
    wave: { on: false, count: '', every: 1.5, brute: 10, max: 16 }, grid, wires: {}, sw: {} };
}

// 遊戲用的關卡格式 → 編輯器資料
function fromDef(def, opts = {}) {
  const rows = mapRows(def);
  const w = Math.max(...rows.map(r => r.length)), h = rows.length;
  const d = newDoc(w, h);
  d.name = def.name ?? '未命名';
  d.dark = def.dark ?? !!opts.dark;
  d.aware = def.aware ?? !!opts.aware;
  d.goal = def.goal ?? 'clear';
  d.hold = def.hold ?? 60;
  if (def.wave) d.wave = { on: true, count: def.wave.count ?? '', every: def.wave.every ?? 1.5, brute: Math.round((def.wave.brute ?? 0) * 100), max: def.wave.max ?? 16 };
  const groupOf = dg => def.groups?.[dg] ?? +dg;
  let k = 0;
  d.grid = rows.map((row, r) => [...row.padEnd(w, '#')].map((ch, c) => {
    if (ch >= '1' && ch <= '9') { d.wires[`${r},${c}`] = { kind: def.links?.[ch] ?? 'gate', group: groupOf(ch) }; return '*'; }
    if (ch === 'K') d.sw[`${r},${c}`] = [...new Set((def.switches?.[k++] ?? []).map(groupOf))];
    return ch;
  }));
  return d;
}

// 編輯器資料 → 遊戲用的關卡格式，順便檢查問題
function toDef(d) {
  const errors = [], warns = [];
  const pairs = new Map();   // "種類:線路" → 數字
  const map = d.grid.map((row, r) => row.map((ch, c) => {
    if (ch !== '*') return ch;
    const w = d.wires[`${r},${c}`];
    const key = w.kind + ':' + w.group;
    if (!pairs.has(key)) pairs.set(key, String(pairs.size + 1));
    return pairs.get(key);
  }).join(''));
  if (pairs.size > 9) errors.push(`連動物件的「種類＋線路」組合有 ${pairs.size} 種，最多 9 種`);
  const links = {}, groups = {};
  for (const [key, dg] of pairs) { const [kind, g] = key.split(':'); links[dg] = kind; groups[dg] = +g; }
  const switches = [], usedGroups = new Set();
  d.grid.forEach((row, r) => row.forEach((ch, c) => {
    if (ch !== 'K') return;
    const gs = d.sw[`${r},${c}`] ?? [];
    gs.forEach(g => usedGroups.add(g));
    switches.push(Object.keys(groups).filter(dg => gs.includes(groups[dg])));
  }));

  const all = map.join('');
  const count = ch => all.split(ch).length - 1;
  if (count('P') !== 1) errors.push('要放剛好一個玩家');
  if (!count('D')) warns.push('沒有出口：達成目標也走不出去');
  const enemies = [...'RSHZG'].reduce((n, ch) => n + count(ch), 0);
  if (d.goal === 'clear' && !enemies) warns.push('目標是清光敵人，但地圖上沒有敵人（一進場就過關）');
  if (d.goal === 'activate' && !count('K')) errors.push('目標是打開開關，但沒有開關');
  if (d.goal === 'extract' && !count('X')) errors.push('目標是撤離，但沒有物資');
  if (d.goal === 'rescue' && !count('Q')) errors.push('目標是救人質，但沒有人質');
  if ((d.goal === 'hold' || d.goal === 'extract') && d.wave.on && !count('V')) warns.push('有設定通風口出怪，但地圖上沒有通風口');
  const loose = [...new Set(Object.values(d.wires).map(w => w.group))].filter(g => !usedGroups.has(g));
  if (loose.length) warns.push(`線路 ${loose.join('、')} 沒有接到任何開關`);
  if (!d.dark && count('L') + count('l')) warns.push('吊燈只有在黑暗關卡才看得出效果');

  const def = { name: d.name || '未命名', dark: d.dark, aware: d.aware, goal: d.goal };
  if (d.goal === 'hold') def.hold = +d.hold || 60;
  if ((d.goal === 'hold' || d.goal === 'extract') && d.wave.on) {
    def.wave = { every: +d.wave.every || 1.5, brute: (+d.wave.brute || 0) / 100, max: +d.wave.max || 16 };
    if (d.wave.count !== '' && +d.wave.count > 0) def.wave.count = +d.wave.count;
  }
  if (pairs.size) Object.assign(def, { links, groups, switches });
  def.map = map;
  return { def, errors, warns };
}

// JSON：地圖一行一列，方便看
function prettyJson(def) {
  const { map, ...rest } = def;
  const head = JSON.stringify(rest, null, 2).slice(0, -2);
  return `${head},\n  "map": [\n${map.map(r => '    ' + JSON.stringify(r)).join(',\n')}\n  ]\n}`;
}

function resizeDoc(d, w, h) {
  w = Math.max(7, Math.min(MAX_SIZE, w | 0)); h = Math.max(7, Math.min(MAX_SIZE, h | 0));
  const old = d.grid;
  d.grid = Array.from({ length: h }, (_, r) => Array.from({ length: w }, (_, c) => old[r]?.[c] ?? '.'));
  for (const key of Object.keys(d.wires)) { const [r, c] = key.split(',').map(Number); if (r >= h || c >= w) delete d.wires[key]; }
  for (const key of Object.keys(d.sw)) { const [r, c] = key.split(',').map(Number); if (r >= h || c >= w) delete d.sw[key]; }
  d.w = w; d.h = h;
}

// ---------- 狀態 ----------
let doc = null, tool = { ch: '#' }, wireGroup = 1, painting = false, erasing = false, lastCell = null, built = false;
let zoom = null;            // 每格幾 px；null = 自動塞滿畫面
let pan = null, spaceDown = false;   // 拖曳檢視

function loadDraft() {
  try { const d = JSON.parse(localStorage.getItem(KEY)); if (d?.grid) return d; } catch { /* 沒存過就開新的 */ }
  return newDoc();
}
function saveDraft() { try { localStorage.setItem(KEY, JSON.stringify(doc)); } catch { /* 存不了就算了 */ } }

// ---------- 畫面 ----------
function build() {
  built = true;
  const pal = $('edPalette');
  pal.innerHTML = '';
  for (const g of PALETTE) {
    const row = document.createElement('div');
    row.className = 'ed-pal-row';
    row.innerHTML = `<div class="ed-pal-label">${g.group}</div>`;
    const box = document.createElement('div');
    box.className = 'ed-pal-items';
    for (const it of g.items) {
      const b = document.createElement('button');
      b.className = 'ed-tool';
      b.innerHTML = `<i style="background:${it.bg};color:${it.fg ?? '#fff'}">${it.glyph ?? ''}</i>${it.name}`;
      b.onclick = () => { tool = it.ch ? { ch: it.ch } : { wire: it.wire }; renderTools(); };
      b.dataset.key = it.ch ?? 'w:' + it.wire;
      box.appendChild(b);
    }
    row.appendChild(box);
    pal.appendChild(row);
  }
  // 線路：選號碼；「接線」工具點開關就把這條線路接上 / 拆掉
  const wire = $('edWire');
  wire.innerHTML = '<div class="ed-pal-label">線路</div>';
  const wbox = document.createElement('div');
  wbox.className = 'ed-pal-items';
  for (let g = 1; g <= 9; g++) {
    const b = document.createElement('button');
    b.className = 'ed-wire';
    b.textContent = g;
    b.style.setProperty('--wc', WIRE_COLORS[g - 1]);
    b.onclick = () => { wireGroup = g; renderTools(); };
    b.dataset.g = g;
    wbox.appendChild(b);
  }
  const link = document.createElement('button');
  link.className = 'ed-tool';
  link.dataset.key = 'link';
  link.innerHTML = '<i style="background:#1b2a3a;color:#40d0ff">⚡</i>接線';
  link.onclick = () => { tool = { link: true }; renderTools(); };
  wbox.append(link);
  wire.appendChild(wbox);

  $('edGoal').innerHTML = GOALS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  const pool = [
    ...BREACH_LEVELS.map((d, i) => ['破門', d, {}, i]),
    ...DARK_LEVELS.map((d, i) => ['黑暗', d, { dark: true }, i]),
    ...ARENA_ROOMS.map((m, i) => ['清房', { name: `房間 ${i + 1}`, map: m }, { aware: true }, i]),
    ...CUSTOM_LEVELS.map((d, i) => ['自訂', d, {}, i]),
  ];
  $('edPool').innerHTML = '<option value="">從現有關卡載入…</option>' +
    pool.map(([tag, d], i) => `<option value="${i}">${tag}・${d.name ?? '未命名'}</option>`).join('');
  $('edPool').onchange = e => {
    const p = pool[+e.target.value];
    if (p) { doc = fromDef(p[1], p[2]); afterLoad(); }
    e.target.value = '';
  };

  const grid = $('edGrid');
  // 拖曳檢視：中鍵拖曳，或按住空白鍵再用左鍵拖曳
  const wrap = $('edGridWrap');
  wrap.addEventListener('pointerdown', e => {
    if (e.button !== 1 && !(e.button === 0 && spaceDown)) return;
    e.preventDefault(); e.stopPropagation();
    pan = { x: e.clientX, y: e.clientY, sl: wrap.scrollLeft, st: wrap.scrollTop };
    wrap.classList.add('panning');
  }, true);
  addEventListener('pointermove', e => {
    if (!pan) return;
    wrap.scrollLeft = pan.sl - (e.clientX - pan.x);
    wrap.scrollTop = pan.st - (e.clientY - pan.y);
  });
  addEventListener('pointerup', () => { if (pan) { pan = null; wrap.classList.remove('panning'); } });
  wrap.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });   // 不要瀏覽器的自動捲動
  // Ctrl + 滾輪縮放
  wrap.addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(cellSize() * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
  }, { passive: false });
  $('edZoomIn').onclick = () => setZoom(cellSize() * 1.25);
  $('edZoomOut').onclick = () => setZoom(cellSize() / 1.25);
  $('edZoomFit').onclick = () => setZoom(null);

  // 左鍵畫、右鍵擦掉（畫成地板）
  grid.addEventListener('pointerdown', e => {
    if (pan) return;
    const cell = e.target.closest('.ed-cell');
    if (!cell) return;
    e.preventDefault();
    painting = true; erasing = e.button === 2; lastCell = null;
    apply(cell);
  });
  grid.addEventListener('pointermove', e => {
    if (!painting || (tool.link && !erasing)) return;
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('.ed-cell');
    if (el) apply(el);
  });
  addEventListener('pointerup', () => { if (painting) { painting = false; erasing = false; saveDraft(); renderMeta(); } });
  // 數字鍵換線路、空白鍵按住拖曳（在輸入框打字時不算）
  addEventListener('keydown', e => {
    if ($('editor').classList.contains('hidden') || e.target.closest?.('input, textarea, select')) return;
    if (e.key >= '1' && e.key <= '9') { wireGroup = +e.key; renderTools(); }
    if (e.code === 'Space') {
      e.preventDefault();
      if (document.activeElement?.tagName === 'BUTTON') document.activeElement.blur();   // 不要觸發剛點過的按鈕
      spaceDown = true; wrap.classList.add('grab');
    }
  });
  addEventListener('keyup', e => {
    if (e.code !== 'Space') return;
    spaceDown = false; wrap.classList.remove('grab');
    if (!$('editor').classList.contains('hidden') && !e.target.closest?.('input, textarea, select')) e.preventDefault();
  });
  addEventListener('resize', () => { if (!$('editor').classList.contains('hidden')) renderGrid(); });

  $('edName').oninput = e => { doc.name = e.target.value; saveDraft(); };
  $('edDark').onchange = e => { doc.dark = e.target.checked; changed(); };
  $('edAware').onchange = e => { doc.aware = e.target.checked; changed(); };
  $('edGoal').onchange = e => { doc.goal = e.target.value; changed(); };
  $('edHold').oninput = e => { doc.hold = e.target.value; changed(); };
  $('edWaveOn').onchange = e => { doc.wave.on = e.target.checked; changed(); };
  for (const k of ['count', 'every', 'brute', 'max']) {
    $('edWave_' + k).oninput = e => { doc.wave[k] = e.target.value; changed(); };
  }
  $('edResize').onclick = () => { resizeDoc(doc, +$('edW').value, +$('edH').value); afterLoad(); };
  $('edNew').onclick = () => { if (confirm('清空目前的地圖，開一張新的？')) { doc = newDoc(); afterLoad(); } };
  $('edBack').onclick = () => { saveDraft(); showMenu(); };
  $('edPreview').onclick = () => { const r = toDef(doc); if (!r.errors.length) previewLevel(r.def); };
  $('edTest').onclick = () => { const r = toDef(doc); if (!r.errors.length) testLevel(r.def); };
  $('edCopy').onclick = copyJson;
  $('edImport').onclick = () => {
    try {
      doc = fromDef(JSON.parse($('edJson').value));
      afterLoad();
      flash('已匯入');
    } catch (err) { flash('JSON 格式不對：' + err.message); }
  };
}

function changed() { saveDraft(); renderMeta(); }
function afterLoad() { zoom = null; saveDraft(); render(); }

function flash(text) {
  const el = $('edMsg');
  el.textContent = text;
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
}

async function copyJson() {
  const r = toDef(doc);
  const json = prettyJson(r.def);
  const ta = $('edJson');
  ta.value = json;
  try { await navigator.clipboard.writeText(json); flash('已複製 JSON，直接貼給 Claude'); }
  catch { ta.focus(); ta.select(); flash('請手動複製下面的 JSON'); }
}

// 在一格上套用目前的工具
const currentTool = () => tool;
function apply(el) {
  const r = +el.dataset.r, c = +el.dataset.c, key = `${r},${c}`;
  if (lastCell === key) return;
  lastCell = key;
  const g = doc.grid;
  const tool = erasing ? { ch: '.' } : currentTool();
  if (tool.link) {
    if (g[r][c] === 'K') {
      const list = doc.sw[key] ??= [];
      const i = list.indexOf(wireGroup);
      if (i >= 0) list.splice(i, 1); else list.push(wireGroup);
    } else if (g[r][c] === '*') doc.wires[key].group = wireGroup;
    else return;
    drawCell(r, c);
    return;
  }
  if (tool.ch === 'P') {
    // 玩家只能有一個
    g.forEach((row, rr) => row.forEach((ch, cc) => { if (ch === 'P') { row[cc] = '.'; drawCell(rr, cc); } }));
  }
  delete doc.wires[key];
  if (tool.ch !== 'K') delete doc.sw[key];
  if (tool.wire) { g[r][c] = '*'; doc.wires[key] = { kind: tool.wire, group: wireGroup }; }
  else g[r][c] = tool.ch;
  drawCell(r, c);
}

// 格子大小：塞得進中間那欄就好，最大 40px
function fitSize() {
  const box = document.querySelector('#editor .ed-center');
  // 扣掉內距與格線（每格 1px）
  const aw = box.clientWidth - 30 - doc.w, ah = innerWidth > 900 ? box.clientHeight - 30 - doc.h : Infinity;
  return Math.max(12, Math.min(40, Math.floor(aw / doc.w), Math.floor(ah / doc.h)));
}
const cellSize = () => zoom ?? fitSize();

// 縮放：以畫面中央為準，縮放後捲回同一個位置
function setZoom(z) {
  const wrap = $('edGridWrap'), old = cellSize();
  const cx = (wrap.scrollLeft + wrap.clientWidth / 2) / (old + 1), cy = (wrap.scrollTop + wrap.clientHeight / 2) / (old + 1);
  zoom = z === null ? null : Math.max(8, Math.min(48, Math.round(z)));
  renderGrid();
  const s = cellSize() + 1;
  wrap.scrollLeft = cx * s - wrap.clientWidth / 2;
  wrap.scrollTop = cy * s - wrap.clientHeight / 2;
  $('edZoomLabel').textContent = zoom === null ? '符合畫面' : `${zoom}px`;
}

function drawCell(r, c) {
  const el = $('edGrid').children[r * doc.w + c];
  const ch = doc.grid[r][c], key = `${r},${c}`;
  let it = TILE[ch], badge = '';
  if (ch === '*') {
    const w = doc.wires[key];
    it = WIRE[w.kind];
    badge = `<b style="background:${WIRE_COLORS[w.group - 1]}">${w.group}</b>`;
  } else if (ch === 'K') {
    badge = (doc.sw[key] ?? []).map(gg => `<u style="background:${WIRE_COLORS[gg - 1]}"></u>`).join('');
    if (badge) badge = `<span class="ed-sw">${badge}</span>`;
  }
  it ??= { bg: '#f0f', glyph: ch };
  el.style.background = it.bg;
  el.style.color = it.fg ?? '#fff';
  el.innerHTML = (it.glyph ?? '') + badge;
}

function renderGrid() {
  const grid = $('edGrid'), s = cellSize();
  grid.style.gridTemplateColumns = `repeat(${doc.w}, ${s}px)`;
  grid.style.fontSize = Math.round(s * 0.55) + 'px';
  grid.innerHTML = '';
  for (let r = 0; r < doc.h; r++) for (let c = 0; c < doc.w; c++) {
    const el = document.createElement('div');
    el.className = 'ed-cell';
    el.style.width = el.style.height = s + 'px';
    el.dataset.r = r; el.dataset.c = c;
    grid.appendChild(el);
  }
  for (let r = 0; r < doc.h; r++) for (let c = 0; c < doc.w; c++) drawCell(r, c);
}

function renderTools() {
  const key = tool.ch ?? (tool.wire ? 'w:' + tool.wire : 'link');
  document.querySelectorAll('#editor .ed-tool').forEach(b => b.classList.toggle('on', b.dataset.key === key));
  document.querySelectorAll('#editor .ed-wire').forEach(b => b.classList.toggle('on', +b.dataset.g === wireGroup));
  $('edHint').textContent = tool.link ? `接線：點開關接上 / 拆掉線路 ${wireGroup}，點連動物件改成線路 ${wireGroup}`
    : tool.wire ? `畫上去的物件接在線路 ${wireGroup}，用「接線」把開關接到同一條線路`
    : '點或拖曳來畫';
}

function renderMeta() {
  const r = toDef(doc);
  $('edWarn').innerHTML = [...r.errors.map(t => `<div class="err">✕ ${t}</div>`), ...r.warns.map(t => `<div>! ${t}</div>`)].join('');
  $('edPreview').disabled = $('edTest').disabled = r.errors.length > 0;
  $('edHoldRow').style.display = doc.goal === 'hold' ? '' : 'none';
  $('edWaveBox').style.display = doc.goal === 'hold' || doc.goal === 'extract' ? '' : 'none';
}

function render() {
  $('edName').value = doc.name;
  $('edDark').checked = doc.dark;
  $('edAware').checked = doc.aware;
  $('edGoal').value = doc.goal;
  $('edHold').value = doc.hold;
  $('edWaveOn').checked = doc.wave.on;
  for (const k of ['count', 'every', 'brute', 'max']) $('edWave_' + k).value = doc.wave[k];
  $('edW').value = doc.w; $('edH').value = doc.h;
  $('edZoomLabel').textContent = zoom === null ? '符合畫面' : `${zoom}px`;
  renderGrid();
  renderTools();
  renderMeta();
}

export function openEditor() {
  if (!built) build();
  doc ??= loadDraft();
  hidePanel();
  ['menu', 'hud', 'previewBar'].forEach(id => $(id).classList.add('hidden'));
  $('editor').classList.remove('hidden');
  G.state = 'menu';
  render();
}

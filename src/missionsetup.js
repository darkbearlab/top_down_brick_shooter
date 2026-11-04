// ---------- 隨機任務設定畫面 ----------
import { sfx, unlockAudio } from './audio.js';
import { GEN_DENSITY, GEN_GOALS, GEN_SIZES, generateLevel } from './generator.js';
import { setRandomLevel } from './world.js';
import { buildMenu, startGame } from './main.js';

// main.js 也 import 這個檔：這裡不能在載入時用 main.js 的常數
const $ = id => document.getElementById(id);

const KEY = 'brickshooter.gen.v1';
const ENVS = { lit: '一般', dark: '黑暗', mixed: '隨機' };
const GOAL_NOTE = { clear: '全部清光才開出口', rescue: '救出人質帶到出口', extract: '拿到物資撤離', activate: '找到開關全部打開', hold: '通風口冒殭屍，撐到時間到' };
let opts = { size: 'M', enemies: 'normal', goals: ['clear', 'rescue', 'extract', 'activate'], env: 'lit' };
try { Object.assign(opts, JSON.parse(localStorage.getItem(KEY)) ?? {}); } catch { /* 用預設 */ }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(opts)); } catch { /* 存不了就算了 */ } };

// 依目前設定產生一張新地圖並開打（seed 不填 = 隨機）
export function playRandom(seed) {
  setRandomLevel(generateLevel({ ...opts, seed }));
  startGame('random', 0);
}

function row(label, items, isOn, onTap, note) {
  const box = document.createElement('div');
  box.className = 'lo-row';
  box.innerHTML = `<div class="lo-label">${label}</div><div class="lo-chips"></div>`;
  const chips = box.lastChild;
  for (const [k, name] of Object.entries(items)) {
    const b = document.createElement('button');
    b.className = 'chip' + (isOn(k) ? ' on' : '');
    b.innerHTML = name + (note?.(k) ? `<small>${note(k)}</small>` : '');
    b.onclick = () => { sfx.click(); onTap(k); render(); };
    chips.appendChild(b);
  }
  return box;
}

function render() {
  const box = $('genRows');
  box.innerHTML = '';
  box.append(
    row('地圖大小', Object.fromEntries(Object.entries(GEN_SIZES).map(([k, s]) => [k, s.name])), k => opts.size === k, k => { opts.size = k; },
      k => `${GEN_SIZES[k].w}×${GEN_SIZES[k].h}`),
    row('敵人數量', Object.fromEntries(Object.entries(GEN_DENSITY).map(([k, s]) => [k, s.name])), k => opts.enemies === k, k => { opts.enemies = k; }),
    row('可能抽到的任務（可複選）', GEN_GOALS, k => opts.goals.includes(k), k => {
      if (opts.goals.includes(k)) { if (opts.goals.length > 1) opts.goals = opts.goals.filter(g => g !== k); }
      else opts.goals = [...opts.goals, k];
    }, k => GOAL_NOTE[k]),
    row('環境', ENVS, k => opts.env === k, k => { opts.env = k; },
      k => ({ lit: '一般敵人', dark: '手電筒＋殭屍', mixed: '每張圖抽一次' })[k]),
  );
  save();
}

export function openMissionSetup() {
  $('menu').classList.add('hidden');
  $('genSeed').value = '';
  render();
  $('genSetup').classList.remove('hidden');
}

$('genBack').onclick = () => { sfx.click(); $('genSetup').classList.add('hidden'); buildMenu(); $('menu').classList.remove('hidden'); };
$('genStart').onclick = () => {
  unlockAudio(); sfx.click();
  const s = parseInt($('genSeed').value, 10);
  $('genSetup').classList.add('hidden');
  playRandom(Number.isFinite(s) ? s : undefined);
};

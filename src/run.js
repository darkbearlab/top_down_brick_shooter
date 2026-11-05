// ---------- 闖關模式：一局 = 連續的隨機地圖 ----------
// 從一把手槍開始；每張圖清完（含增援）後三選一：撿槍、回血…（之後可以再加別的獎勵，各自有權重）
// 最多帶兩把槍，撿到新槍要選放哪一欄，被換掉的那把就沒了；死了這一局就結束
import { MAX_HITS } from './core.js';
import { generateArena } from './generator.js';
import { loadLoadout } from './loadout.js';
import { CALIBERS, PERKS, RARITY, computeStats, randomBuild } from './weapons.js';
import { loadLevel, setRunLevel } from './world.js';
import { equipLoadout, player } from './player.js';
import { fadeEl, hidePanel, showMenu, showPanel, startGame, updateHud } from './main.js';

export const RUN = { active: false, depth: 0, best: 0 };
const START_GUN = { caliber: '9mm', receiver: 'pistol', stock: 'none', mag: 'std', barrel: 'std', grip: 'none' };
// 增援會出現的敵人與權重
const WAVE_TYPES = [['R', 0.24], ['S', 0.4], ['F', 0.12], ['H', 0.07], ['C', 0.05], ['A', 0.12]];

// 開放場地 + 多波增援：一波人不多，但從不同方向來；場上快清光或過了 every 秒就來下一波（場上人數有上限）
function mapDef(depth) {
  const def = generateArena({ depth });
  def.zoom = 1.3;
  // 第一層手上只有手槍，先不出防彈衣
  def.armor = depth <= 1 ? 0 : Math.min(0.4, (depth - 1) * 0.07);
  def.waves = {
    count: Math.min(7, 3 + Math.floor(depth / 2)),
    size: Math.min(5, 2 + Math.floor(depth / 3)),
    every: Math.max(9, 16 - depth),
    maxAlive: Math.min(9, 4 + depth),
    types: WAVE_TYPES,
  };
  // 地圖道具：計時 buff 會在原地再出現一次；護甲 / 急救包只出現一次
  const timed = ['speed', 'power', 'quick'];
  const pickT = () => timed[Math.floor(Math.random() * timed.length)];
  def.items = [
    { kind: pickT(), at: 8 + Math.random() * 6 },
    { kind: pickT(), at: 30 + Math.random() * 15 },
  ];
  if (depth >= 2 && Math.random() < 0.6) def.items.push({ kind: Math.random() < 0.5 ? 'armor' : 'heal', at: 20 + Math.random() * 20 });
  def.drops = 0.08;   // 每個敵人死掉有 8% 掉道具
  def.name = `第 ${depth} 層`;
  return def;
}

export function startRun() {
  RUN.active = true;
  RUN.depth = 1;
  player.armor = 0;
  equipLoadout([{ ...START_GUN }]);
  setRunLevel(mapDef(1));
  startGame('run', 0);
}

// 離開闖關（回主選單、玩別的模式）：換回「武器與裝備」裡的那兩把
export function endRunGear() {
  if (!RUN.active) return;
  RUN.active = false;
  equipLoadout(loadLoadout());
}

function nextMap() {
  RUN.depth++;
  hidePanel();
  fadeEl.style.opacity = 1;
  setTimeout(() => {
    setRunLevel(mapDef(RUN.depth));
    loadLevel('run', 0);
    fadeEl.style.opacity = 0;
  }, 260);
}

// ---------- 獎勵：三選一 ----------
// weight 回傳 0 = 這次不會出現；once = 三個選項裡最多一個
export const REWARDS = [
  { id: 'gun', weight: () => 6, make: d => gunReward(d) },
  { id: 'heal', once: true, weight: () => player.hits > 0 ? 5 : 0,
    make: () => ({ kind: 'heal', amount: 1, title: '急救包', tag: '補給', color: '#5adc8a', lines: ['回復 1 格生命'] }) },
  { id: 'healFull', once: true, weight: () => player.hits >= 2 ? 1.5 : 0,
    make: () => ({ kind: 'heal', amount: MAX_HITS, title: '醫療箱', tag: '補給', color: '#5adc8a', lines: ['生命全部回滿'] }) },
];
function rollRarity(depth) {
  const v = Math.random();
  const epic = Math.min(0.3, 0.04 + depth * 0.04), rare = Math.min(0.5, 0.25 + depth * 0.05);
  return v < epic ? 2 : v < epic + rare ? 1 : 0;
}
function gunReward(depth) {
  const build = randomBuild(rollRarity(depth));
  const s = computeStats(build), r = RARITY[build.rarity];
  return {
    kind: 'gun', build, title: s.name, tag: r.name, color: r.color,
    lines: [
      `${CALIBERS[build.caliber].name}${s.ap ? '・<b class="ap">穿甲</b>' : ''}`,
      `威力 ${s.damage.toFixed(0)}・射速 ${s.rpm.toFixed(0)}・彈匣 ${s.mag}`,
      ...build.perks.map(id => `<b>${PERKS[id].name}</b>：${PERKS[id].desc}`),
    ],
  };
}
function drawRewards(n = 3) {
  const out = [], used = new Set();
  for (let k = 0; k < 30 && out.length < n; k++) {
    const pool = REWARDS.filter(r => !(r.once && used.has(r.id))).map(r => [r, r.weight()]).filter(([, w]) => w > 0);
    let v = Math.random() * pool.reduce((a, [, w]) => a + w, 0);
    for (const [r, w] of pool) {
      if ((v -= w) >= 0) continue;
      used.add(r.id);
      out.push(r.make(RUN.depth));
      break;
    }
  }
  return out;
}
const cardHtml = (o, i) => `<button class="rw-card" data-i="${i}" style="--rc:${o.color}">
  <span class="rw-tag">${o.tag}</span><span class="rw-title">${o.title}</span>
  ${o.lines.map(l => `<span class="rw-line">${l}</span>`).join('')}</button>`;

export function showRewards() {
  const opts = drawRewards();
  showPanel(`第 ${RUN.depth} 層 清除`, `<div class="rw-sub">選一個帶走</div><div class="rw-cards">${opts.map(cardHtml).join('')}</div>`, []);
  document.querySelectorAll('#panelText .rw-card').forEach(el => {
    el.onclick = () => takeReward(opts[+el.dataset.i]);
  });
}
function takeReward(o) {
  if (o.kind === 'heal') {
    player.hits = Math.max(0, player.hits - o.amount);
    updateHud();
    nextMap();
    return;
  }
  // 槍：選要放哪一欄
  const builds = player.slots.map(s => s.build);
  const put = i => { const b = [...builds]; b[i] = o.build; equipLoadout(b); nextMap(); };
  const buttons = builds.map((b, i) => ({ label: `換掉${i ? '副' : '主'}武器：${computeStats(b).name}`, run: () => put(i) }));
  if (builds.length < 2) buttons.unshift({ label: '放進副武器欄（空的）', primary: true, run: () => put(1) });
  buttons.push({ label: '不要了，直接出發', run: nextMap });
  showPanel('放進哪一欄？', `<div class="rw-cards">${cardHtml(o, 0)}</div><div class="rw-sub">被換掉的那把就沒了</div>`, buttons);
}

// 死了：這一局結束
export function showRunOver() {
  RUN.best = Math.max(RUN.best, RUN.depth);
  showPanel('這一局結束', `到達第 ${RUN.depth} 層　最佳：第 ${RUN.best} 層`, [
    { label: '再來一局', primary: true, run: startRun },
    { label: '回主選單', run: showMenu },
  ]);
}

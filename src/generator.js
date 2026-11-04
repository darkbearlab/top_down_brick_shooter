// ---------- 隨機任務：產生關卡 ----------
// 用 BSP 把地圖一直切成房間，每條切線上開門（破門 B / 推門 d / 門洞），
// 再擺掩體、敵人、任務目標；同一個種子一定產生同一張圖
// 回傳的格式和 rooms.js 的關卡一樣（map 是一行一個字串的陣列）

export const GEN_SIZES = {
  S: { name: '小', w: 15, h: 19, room: 6 },
  M: { name: '中', w: 21, h: 27, room: 7 },
  L: { name: '大', w: 29, h: 35, room: 8 },
  XL: { name: '特大', w: 41, h: 45, room: 9 },
};
// 每多少格地板放一個敵人
export const GEN_DENSITY = {
  few: { name: '少', per: 46 },
  normal: { name: '普通', per: 30 },
  many: { name: '多', per: 20 },
  swarm: { name: '滿', per: 13 },
};
export const GEN_GOALS = {
  clear: '清除敵人',
  rescue: '救人質',
  extract: '搶物資',
  activate: '啟動開關',
  hold: '撐住',
};

function mulberry32(a) {
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const MIN = 3;   // 房間內部最小寬度

// opts: { size, enemies, goals: [...], env: 'lit'|'dark'|'mixed', seed }
export function generateLevel(opts) {
  const seed = opts.seed ?? Math.floor(Math.random() * 1e6);
  const rnd = mulberry32(seed);
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));   // a..b
  const pick = arr => arr[Math.floor(rnd() * arr.length)];
  const shuffle = arr => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };

  const S = GEN_SIZES[opts.size] ?? GEN_SIZES.M;
  const W = S.w, H = S.h;
  const dark = opts.env === 'dark' || (opts.env === 'mixed' && rnd() < 0.5);
  const goals = opts.goals?.length ? opts.goals : ['clear'];
  const goal = pick(goals);

  const g = Array.from({ length: H }, (_, r) => Array.from({ length: W }, (_, c) => (r === 0 || c === 0 || r === H - 1 || c === W - 1) ? '#' : '.'));
  const at = (c, r) => g[r]?.[c] ?? '#';

  // ---- 切房間 ----
  const rooms = [], splits = [];
  function split(x0, y0, x1, y1, depth) {
    const iw = x1 - x0 - 1, ih = y1 - y0 - 1;
    const canV = iw >= MIN * 2 + 1, canH = ih >= MIN * 2 + 1;
    const big = iw > S.room || ih > S.room;
    // 偶爾留一間大廳不切
    if ((!canV && !canH) || (!big && rnd() < 0.55) || (depth > 1 && iw * ih <= S.room * S.room * 2.2 && rnd() < 0.15)) {
      rooms.push({ x0, y0, x1, y1 });
      return;
    }
    const vert = canV && (!canH || iw > ih * 1.2 || (ih <= iw * 1.2 && rnd() < 0.5));
    if (vert) {
      const s = x0 + 1 + MIN + ri(0, iw - 2 * MIN - 1);
      for (let r = y0; r <= y1; r++) g[r][s] = '#';
      split(x0, y0, s, y1, depth + 1); split(s, y0, x1, y1, depth + 1);
      splits.push({ vert, s, a: y0, b: y1 });
    } else {
      const s = y0 + 1 + MIN + ri(0, ih - 2 * MIN - 1);
      for (let c = x0; c <= x1; c++) g[s][c] = '#';
      split(x0, y0, x1, s, depth + 1); split(x0, s, x1, y1, depth + 1);
      splits.push({ vert, s, a: x0, b: x1 });
    }
  }
  split(0, 0, W - 1, H - 1, 0);

  // ---- 每條切線開門（子房間的牆先畫好，才不會開在 T 字路口） ----
  const doors = [];
  const doorType = () => { const v = rnd(); return v < 0.45 ? 'B' : v < 0.85 ? 'd' : '.'; };
  for (const sp of splits) {
    const cands = [];
    for (let t = sp.a + 1; t < sp.b; t++) {
      const [c, r] = sp.vert ? [sp.s, t] : [t, sp.s];
      const [a1, a2, w1, w2] = sp.vert
        ? [at(c - 1, r), at(c + 1, r), at(c, r - 1), at(c, r + 1)]
        : [at(c, r - 1), at(c, r + 1), at(c - 1, r), at(c + 1, r)];
      if (a1 === '.' && a2 === '.' && w1 === '#' && w2 === '#') cands.push([c, r]);
    }
    // 長的牆可能開兩扇門，但兩扇門要隔開
    shuffle(cands);
    const n = cands.length > 9 && rnd() < 0.5 ? 2 : 1;
    const made = [];
    for (const [c, r] of cands) {
      if (made.length >= n) break;
      if (made.some(([mc, mr]) => Math.abs(mc - c) + Math.abs(mr - r) < 4)) continue;
      g[r][c] = doorType();
      made.push([c, r]);
      doors.push({ c, r, vert: sp.vert });
    }
  }
  const nearDoor = (c, r, d = 1) => doors.some(o => Math.abs(o.c - c) <= d && Math.abs(o.r - r) <= d);

  // 部分隔間牆換成打得爛的磚牆
  for (const sp of splits) {
    if (rnd() > 0.3) continue;
    const len = ri(2, 4), t0 = ri(sp.a + 1, Math.max(sp.a + 1, sp.b - len));
    for (let t = t0; t < t0 + len && t < sp.b; t++) {
      const [c, r] = sp.vert ? [sp.s, t] : [t, sp.s];
      const [a1, a2] = sp.vert ? [at(c - 1, r), at(c + 1, r)] : [at(c, r - 1), at(c, r + 1)];
      if (g[r][c] === '#' && a1 !== '#' && a2 !== '#' && !nearDoor(c, r)) g[r][c] = 'W';
    }
  }

  // ---- 房間資料 ----
  for (const rm of rooms) {
    rm.cells = [];
    for (let r = rm.y0 + 1; r < rm.y1; r++) for (let c = rm.x0 + 1; c < rm.x1; c++) rm.cells.push([c, r]);
    rm.cx = (rm.x0 + rm.x1) / 2; rm.cy = (rm.y0 + rm.y1) / 2;
  }

  // 玩家從最下面一排的某個房間進場
  const bottom = rooms.filter(rm => rm.y1 === H - 1);
  const start = pick(bottom.length ? bottom : rooms);
  const pc = Math.round(start.cx), pr = start.y1 - 2;
  g[pr][pc] = 'P';

  // 走得到的距離（門算走得過，磚牆不算）
  const dist = () => {
    const D = new Int16Array(W * H).fill(-1);
    const q = [pc + pr * W]; D[q[0]] = 0;
    for (let i = 0; i < q.length; i++) {
      const k = q[i], c = k % W, r = (k - c) / W;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = c + dc, nr = r + dr, nk = nc + nr * W;
        if (nc < 0 || nr < 0 || nc >= W || nr >= H || D[nk] >= 0) continue;
        if ('#WhVD'.includes(g[nr][nc])) continue;
        D[nk] = D[k] + 1; q.push(nk);
      }
    }
    return D;
  };
  let D = dist();
  for (const rm of rooms) rm.d = Math.min(...rm.cells.map(([c, r]) => D[c + r * W] < 0 ? 9999 : D[c + r * W]));
  const byFar = [...rooms].sort((a, b) => b.d - a.d);

  // ---- 出口：開在離起點最遠、貼著外牆的房間 ----
  const edgeRooms = byFar.filter(rm => rm !== start && (rm.x0 === 0 || rm.y0 === 0 || rm.x1 === W - 1 || rm.y1 === H - 1));
  const exitRoom = edgeRooms[0] ?? byFar[0];
  {
    const sides = [];
    if (exitRoom.y0 === 0) sides.push('N');
    if (exitRoom.x0 === 0) sides.push('W');
    if (exitRoom.x1 === W - 1) sides.push('E');
    if (exitRoom.y1 === H - 1 && exitRoom !== start) sides.push('S');
    const side = sides.includes('N') ? 'N' : pick(sides.length ? sides : ['N']);
    const horiz = side === 'N' || side === 'S';
    const lo = (horiz ? exitRoom.x0 : exitRoom.y0) + 1, hi = (horiz ? exitRoom.x1 : exitRoom.y1) - 1;
    const len = Math.min(3, hi - lo + 1), mid = Math.round((lo + hi) / 2), t0 = mid - Math.floor((len - 1) / 2);
    for (let t = t0; t < t0 + len; t++) {
      if (side === 'N') g[0][t] = 'D';
      else if (side === 'S') g[H - 1][t] = 'D';
      else if (side === 'W') g[t][0] = 'D';
      else g[t][W - 1] = 'D';
    }
  }

  // ---- 放東西的工具：不擋門口、不把路堵死 ----
  const reachKeys = () => {
    // 要走得到的東西：所有門、目標、敵人
    const keys = [];
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if ('Bd'.includes(g[r][c]) || 'KXQRSHZG'.includes(g[r][c])) keys.push(c + r * W);
    return keys;
  };
  const allReachable = () => {
    const DD = dist();
    for (const k of reachKeys()) {
      const c = k % W, r = (k - c) / W;
      // 物件本身算地板；看四周有沒有一格走得到
      if (DD[k] >= 0) continue;
      if (![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dc, dr]) => DD[(c + dc) + (r + dr) * W] >= 0)) return false;
    }
    // 出口內側要走得到
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (g[r][c] === 'D' &&
      ![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dc, dr]) => DD[(c + dc) + (r + dr) * W] >= 0)) return false;
    return true;
  };
  const freeCell = (c, r) => g[r]?.[c] === '.' && !nearDoor(c, r) && !(Math.abs(c - pc) <= 1 && Math.abs(r - pr) <= 1);
  const freeCellsOf = rm => rm.cells.filter(([c, r]) => freeCell(c, r));
  function place(cells, ch) {
    // cells 全部放上去，堵路就還原
    if (!cells.every(([c, r]) => freeCell(c, r))) return false;
    for (const [c, r] of cells) g[r][c] = ch;
    if (allReachable()) return true;
    for (const [c, r] of cells) g[r][c] = '.';
    return false;
  }
  const placeIn = (rm, ch, tries = 30, filter = () => true) => {
    const cells = shuffle(freeCellsOf(rm)).filter(filter);
    for (let i = 0; i < Math.min(tries, cells.length); i++) if (place([cells[i]], ch)) return cells[i];
    return null;
  };

  // ---- 任務目標 ----
  const def = { name: '', dark, goal, aware: false, map: null, gen: { ...opts, seed } };
  const farRooms = byFar.filter(rm => rm !== start);
  if (goal === 'rescue') {
    // 人質關在遠處（但不一定跟出口同一間）
    placeIn(farRooms[Math.min(farRooms.length - 1, rnd() < 0.5 ? 0 : 1)] ?? start, 'Q');
  } else if (goal === 'extract') {
    placeIn(farRooms[0] ?? start, 'X');
  } else if (goal === 'activate') {
    const n = Math.min(farRooms.length, rooms.length >= 8 ? 3 : 2);
    const pool = shuffle(farRooms.slice(0, Math.max(n, Math.ceil(farRooms.length * 0.6)))).slice(0, n);
    for (const rm of pool) placeIn(rm, 'K');
    def.switches = pool.map(() => []);
  } else if (goal === 'hold') {
    def.hold = { S: 40, M: 50, L: 60, XL: 75 }[opts.size] ?? 50;
  }

  // 撐住、或黑暗裡搶物資：外牆上開通風口冒殭屍
  if (goal === 'hold' || (goal === 'extract' && dark)) {
    const vents = [];
    for (let c = 1; c < W - 1; c++) { vents.push([c, 0, 0, 1]); vents.push([c, H - 1, 0, -1]); }
    for (let r = 1; r < H - 1; r++) { vents.push([0, r, 1, 0]); vents.push([W - 1, r, -1, 0]); }
    const nV = { S: 3, M: 4, L: 6, XL: 8 }[opts.size] ?? 4;
    let made = 0;
    for (const [c, r, dc, dr] of shuffle(vents)) {
      if (made >= nV) break;
      if (g[r][c] !== '#' || g[r + dr][c + dc] !== '.' || Math.abs(c - pc) + Math.abs(r - pr) < 8) continue;
      // 通風口兩側都要是牆，不要開在角落
      const side = dr ? [at(c - 1, r), at(c + 1, r)] : [at(c, r - 1), at(c, r + 1)];
      if (side.some(ch => ch !== '#')) continue;
      g[r][c] = 'V'; made++;
    }
    const brute = dark ? 0.1 : 0.05;
    def.wave = goal === 'hold'
      ? { every: { S: 1.8, M: 1.5, L: 1.2, XL: 1 }[opts.size] ?? 1.5, brute, max: { S: 10, M: 14, L: 18, XL: 22 }[opts.size] ?? 14 }
      : { count: { S: 8, M: 12, L: 16, XL: 22 }[opts.size] ?? 12, every: 1, brute, max: 18 };
  }

  // ---- 掩體 ----
  for (const rm of rooms) {
    const iw = rm.x1 - rm.x0 - 1, ih = rm.y1 - rm.y0 - 1;
    const area = iw * ih;
    const n = area < 16 ? 0 : Math.min(5, Math.floor(area / 18) + ri(0, 1));
    for (let i = 0; i < n; i++) {
      const v = rnd();
      const c = ri(rm.x0 + 2, rm.x1 - 2), r = ri(rm.y0 + 2, rm.y1 - 2);
      if (v < 0.55) {
        // 沙包一排 2~3 格
        const len = ri(2, 3), hz = rnd() < 0.6;
        place(Array.from({ length: len }, (_, k) => hz ? [c + k, r] : [c, r + k]), 'h');
      } else if (v < 0.85) {
        // 柱子 / 短牆
        const len = ri(1, 2), hz = rnd() < 0.5;
        place(Array.from({ length: len }, (_, k) => hz ? [c + k, r] : [c, r + k]), '#');
      } else {
        place([[c, r], [c + 1, r]], 'W');
      }
    }
  }

  // ---- 敵人 ----
  D = dist();
  let floor = 0;
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (g[r][c] !== '#') floor++;
  const per = (GEN_DENSITY[opts.enemies] ?? GEN_DENSITY.normal).per;
  let count = Math.max(2, Math.round(floor / per * (dark ? 1.5 : 1) * (goal === 'hold' ? 0.5 : 1)));
  const types = dark ? [['Z', 0.85], ['G', 0.15]] : [['R', 0.33], ['S', 0.47], ['H', 0.2]];
  const pickType = () => { let v = rnd(); for (const [t, w] of types) { if ((v -= w) < 0) return t; } return types[0][0]; };
  const spawnRooms = rooms.filter(rm => rm !== start);
  const weight = rm => freeCellsOf(rm).filter(([c, r]) => D[c + r * W] > 7).length;
  let guard = 0;
  while (count > 0 && guard++ < 400) {
    // 照房間大小抽一間，再抽一格；離玩家太近不放
    const ws = spawnRooms.map(weight), tot = ws.reduce((a, b) => a + b, 0);
    if (!tot) break;
    let v = rnd() * tot, rm = spawnRooms[0];
    for (let i = 0; i < spawnRooms.length; i++) { if ((v -= ws[i]) < 0) { rm = spawnRooms[i]; break; } }
    const crowded = ([c, r]) => {
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if ('RSHZG'.includes(at(c + dc, r + dr))) return true;
      return false;
    };
    if (placeIn(rm, pickType(), 12, ([c, r]) => D[c + r * W] > 7 && !crowded([c, r]))) count--;
  }
  // 救人質：人質旁邊一定有人看守
  if (goal === 'rescue' && !dark) {
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (g[r][c] === 'Q') {
      for (const [dc, dr] of shuffle([[2, 0], [-2, 0], [0, 2], [0, -2], [2, 1], [-2, -1]])) if (place([[c + dc, r + dr]], 'S')) break;
    }
  }

  // ---- 黑暗：每間房一盞吊燈（有些會閃，有些壞掉） ----
  if (dark) {
    for (const rm of rooms) {
      const v = rnd();
      if (v < 0.15) continue;
      const c = Math.round(rm.cx), r = Math.round(rm.cy);
      if (g[r][c] === '.') g[r][c] = v < 0.35 ? 'l' : 'L';
    }
  }

  def.map = g.map(row => row.join(''));
  def.name = `${S.name}・${GEN_GOALS[goal]}${dark ? '・黑暗' : ''}　#${seed}`;
  return def;
}

// 統一輸入：觸控雙搖桿 / 鍵盤滑鼠
// 輸出：move（螢幕方向，y 往下為正）、aim（模式 + 方向來源）

const STICK_R = 65;          // 搖桿半徑（px），對應 CSS
const FIRE_T = 0.68;         // 右搖桿超過這個比例 = 第二段開火
const AIM_DEAD = 0.18;       // 小於這個比例不算瞄準

export class Input {
  constructor(el) {
    this.el = el;
    this.move = { x: 0, y: 0 };
    this.aimMode = 'none';     // 'none' | 'laser' | 'fire'
    this.aimVec = { x: 0, y: 0 }; // 觸控時的瞄準向量（螢幕方向，已正規化）
    this.source = 'touch';     // 'touch' | 'mouse'
    this.mouse = { x: innerWidth / 2, y: innerHeight / 2, down: false, seen: false };
    this.keys = new Set();
    this.onFireStage = null;   // 進入開火段時的回呼（震動用）
    this.reloadPressed = false; // 單次事件，遊戲讀完要清掉
    this.pausePressed = false;
    this.swapPressed = false;
    this.handPressed = false;   // 觸控按鈕：換另一手
    this.handSet = 0;           // Q = -1 左手、E = 1 右手（重複按不會換手）
    this.slotSet = -1;          // 數字鍵 1 / 2 直接選主 / 副武器
    el.addEventListener('wheel', e => { if (Math.abs(e.deltaY) > 10) this.swapPressed = true; }, { passive: true });

    this.left = { id: null, ox: 0, oy: 0, x: 0, y: 0, el: document.getElementById('stickL') };
    this.right = { id: null, ox: 0, oy: 0, x: 0, y: 0, el: document.getElementById('stickR') };
    const ring = this.right.el.querySelector('.ring');
    const rs = STICK_R * 2 * FIRE_T;
    Object.assign(ring.style, { width: rs + 'px', height: rs + 'px', margin: `${-rs / 2}px 0 0 ${-rs / 2}px` });

    const opt = { passive: false };
    el.addEventListener('touchstart', e => this.touchStart(e), opt);
    el.addEventListener('touchmove', e => this.touchMove(e), opt);
    el.addEventListener('touchend', e => this.touchEnd(e), opt);
    el.addEventListener('touchcancel', e => this.touchEnd(e), opt);

    addEventListener('mousemove', e => {
      this.mouse.x = e.clientX; this.mouse.y = e.clientY; this.mouse.seen = true;
      this.source = 'mouse';
    });
    el.addEventListener('mousedown', e => { if (e.button === 0) { this.mouse.down = true; this.source = 'mouse'; this.mouse.seen = true; } });
    addEventListener('mouseup', e => { if (e.button === 0) this.mouse.down = false; });
    addEventListener('contextmenu', e => e.preventDefault());
    addEventListener('keydown', e => {
      this.keys.add(e.code);
      if (e.repeat) return;
      if (e.code === 'KeyR') this.reloadPressed = true;
      if (e.code === 'KeyQ') this.handSet = -1;
      if (e.code === 'KeyE') this.handSet = 1;
      if (e.code === 'Digit1') this.slotSet = 0;
      if (e.code === 'Digit2') this.slotSet = 1;
      if (e.code === 'Escape' || e.code === 'KeyP') this.pausePressed = true;
    });
    addEventListener('keyup', e => { this.keys.delete(e.code); });
    addEventListener('blur', () => { this.keys.clear(); this.mouse.down = false; });
  }

  touchStart(e) {
    e.preventDefault();
    this.source = 'touch';
    for (const t of e.changedTouches) {
      const s = t.clientX < innerWidth / 2 ? this.left : this.right;
      if (s.id !== null) continue;
      s.id = t.identifier; s.ox = s.x = t.clientX; s.oy = s.y = t.clientY;
      s.t0 = performance.now(); s.maxM = 0;
      s.el.style.left = s.ox + 'px'; s.el.style.top = s.oy + 'px';
      s.el.classList.add('on');
      this.setKnob(s, 0, 0);
    }
  }
  touchMove(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      for (const s of [this.left, this.right]) {
        if (s.id !== t.identifier) continue;
        s.x = t.clientX; s.y = t.clientY;
        let dx = s.x - s.ox, dy = s.y - s.oy;
        const d = Math.hypot(dx, dy);
        // 拉超過範圍時，讓搖桿底座跟著手指走（避免手指一直超出）
        if (d > STICK_R * 1.25) {
          const k = (d - STICK_R * 1.25) / d;
          s.ox += dx * k; s.oy += dy * k;
          s.el.style.left = s.ox + 'px'; s.el.style.top = s.oy + 'px';
          dx = s.x - s.ox; dy = s.y - s.oy;
        }
        s.maxM = Math.max(s.maxM, Math.hypot(dx, dy) / STICK_R);
        this.setKnob(s, dx, dy);
      }
    }
  }
  touchEnd(e) {
    for (const t of e.changedTouches) {
      for (const s of [this.left, this.right]) {
        if (s.id !== t.identifier) continue;
        // 右半邊快速點一下（沒推動）= 換彈
        if (s === this.right && performance.now() - s.t0 < 250 && s.maxM < AIM_DEAD) this.reloadPressed = true;
        s.id = null; s.el.classList.remove('on', 'laser', 'fire');
      }
    }
  }
  setKnob(s, dx, dy) {
    const d = Math.hypot(dx, dy);
    const k = d > STICK_R ? STICK_R / d : 1;
    s.el.querySelector('.knob').style.transform = `translate(${dx * k}px, ${dy * k}px)`;
  }

  stickVec(s) {
    if (s.id === null) return { x: 0, y: 0, m: 0 };
    const dx = s.x - s.ox, dy = s.y - s.oy;
    const d = Math.hypot(dx, dy);
    const m = Math.min(1, d / STICK_R);
    return d > 0 ? { x: dx / d, y: dy / d, m } : { x: 0, y: 0, m: 0 };
  }

  update() {
    const prevMode = this.aimMode;
    if (this.source === 'touch') {
      const l = this.stickVec(this.left);
      const lm = l.m < 0.12 ? 0 : (l.m - 0.12) / 0.88;
      this.move.x = l.x * lm; this.move.y = l.y * lm;

      const r = this.stickVec(this.right);
      const rel = this.right.el;
      if (r.m < AIM_DEAD) {
        // 搖桿剛按下還沒推：保留上一個方向，不顯示雷射
        this.aimMode = 'none';
      } else {
        this.aimVec.x = r.x; this.aimVec.y = r.y;
        this.aimMode = r.m >= FIRE_T ? 'fire' : 'laser';
      }
      rel.classList.toggle('laser', this.aimMode === 'laser');
      rel.classList.toggle('fire', this.aimMode === 'fire');
    } else {
      let x = 0, y = 0;
      const k = this.keys;
      if (k.has('KeyA') || k.has('ArrowLeft')) x -= 1;
      if (k.has('KeyD') || k.has('ArrowRight')) x += 1;
      if (k.has('KeyW') || k.has('ArrowUp')) y -= 1;
      if (k.has('KeyS') || k.has('ArrowDown')) y += 1;
      const d = Math.hypot(x, y) || 1;
      this.move.x = x / d; this.move.y = y / d;
      this.aimMode = !this.mouse.seen ? 'none' : (this.mouse.down || k.has('Space')) ? 'fire' : 'laser';
    }
    // 鍵盤也可在觸控模式下切回（有按鍵就視為電腦）
    if (this.source === 'touch' && this.keys.size) this.source = 'mouse';
    if (this.aimMode === 'fire' && prevMode !== 'fire' && this.onFireStage) this.onFireStage(this.source);
  }
}

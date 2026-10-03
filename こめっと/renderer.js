/* 動画の再生時刻に同期する10種類の弾幕。乱数や実時間に依存せずシークで再現する。 */
(function (root) {
  'use strict';
  const C = root.CometCore;
  const PALETTES = {
    neon: ['#ff28cc', '#ffffff', '#3af7ff'], rainbow: C.COLORS,
    flame: ['#ff381c', '#ffb321', '#fff4a6'], ice: ['#2495ff', '#d9ffff', '#68fff2'],
    gold: ['#ff9900', '#fff9ba', '#ffd23a'], comic: ['#ff367d', '#fff238', '#ffffff'],
    glitch: ['#ff245f', '#ffffff', '#00ffff'], wave: ['#52ffbf', '#ffffff', '#65b9ff'],
    spotlight: ['#b354ff', '#ffffff', '#ff79dc'], laser: ['#24ebff', '#ffffff', '#bcff43']
  };
  class CometRenderer {
    constructor(canvas, video) {
      this.canvas = canvas;
      this.container = canvas.parentElement || canvas.getRootNode().host;
      this.video = video;
      this.ctx = canvas.getContext('2d');
      this.events = []; this.opts = C.settings(); this.items = []; this.bursts = [];
      this.width = 0; this.height = 0; this.lastFrame = 0; this.stopped = false;
      this.motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
      this.reduced = this.motionQuery.matches;
      this.motionChanged = event => { this.reduced = event.matches; this.lastDraw = undefined; };
      this.motionQuery.addEventListener('change', this.motionChanged);
      this.frame = this.frame.bind(this);
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.container);
      this.resize();
      this.raf = requestAnimationFrame(this.frame);
    }
    resize() {
      const { width, height } = this.container.getBoundingClientRect();
      if (width === this.width && height === this.height) return;
      this.width = width; this.height = height;
      const dpr = Math.min(devicePixelRatio || 1, 2);
      this.canvas.width = Math.round(width * dpr); this.canvas.height = Math.round(height * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.rebuild();
    }
    set(events, opts) { this.events = events; this.opts = C.settings(opts); this.rebuild(); }
    font(size) { this.ctx.font = `900 ${size}px "Noto Sans JP", "Yu Gothic", system-ui, sans-serif`; }
    rebuild() {
      if (!this.ctx || !this.width) return;
      this.filtered = C.filtered(this.events, this.opts, this.video.duration || Infinity);
      this.items = C.schedule(this.filtered, this.opts, this.width, this.height, (text, size) => {
        this.font(size); return this.ctx.measureText(text).width;
      });
      for (const item of this.items) if (item.effect === 'wave') {
        this.font(item.size);
        let offset = 0;
        item.glyphs = Array.from(item.label).map(letter => {
          const glyph = { letter, offset }; offset += this.ctx.measureText(letter).width; return glyph;
        });
      }
      this.bursts = C.bursts(this.filtered);
      this.lastDraw = undefined;
    }
    frame(now) {
      if (this.stopped) return;
      this.raf = requestAnimationFrame(this.frame);
      if (now - this.lastFrame < 30 || document.hidden) return;
      this.lastFrame = now;
      const time = this.video.currentTime || 0;
      if (time === this.lastDraw) return;
      this.draw(time);
    }
    active(time) {
      // 二分探索で表示中の区間だけ取り出す。長い動画でも全件を毎フレーム走査しない。
      let lo = 0, hi = this.items.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.items[mid].time < time - this.opts.duration) lo = mid + 1; else hi = mid; }
      const active = [];
      for (let i = lo; i < this.items.length && this.items[i].time <= time; i++) active.push(this.items[i]);
      return active;
    }
    draw(time) {
      const { ctx, width: w, height: h, opts } = this;
      this.lastDraw = time;
      ctx.clearRect(0, 0, w, h);
      if (!opts.enabled || !w || !h) return;
      const active = this.active(time);
      ctx.save(); ctx.lineJoin = 'round'; ctx.textBaseline = 'alphabetic';
      for (const item of active) this.drawItem(item, time - item.time, active.length);
      if (opts.festival && !this.reduced) {
        // コンボの装飾は同時に2件まで。密集した場面でも描画量を一定に保つ。
        const bursts = this.bursts.filter(b => time >= b.time && time < b.time + 2.8).slice(-2);
        for (const burst of bursts) this.drawBurst(burst, time - burst.time);
      }
      ctx.restore();
    }
    drawItem(item, elapsed, count) {
      const { ctx, width: w, opts } = this;
      const x = this.reduced ? Math.max(16, (w - item.width) / 2) : w - item.speed * elapsed + 16;
      const y = Math.min(this.height - 44, item.y);
      const baseAlpha = opts.opacity / 100 * Math.min(1, (opts.duration - elapsed) / .35);
      ctx.save(); ctx.globalAlpha = baseAlpha; this.font(item.size);
      if (!opts.festival || this.reduced) {
        ctx.lineWidth = 4; ctx.strokeStyle = '#090a17'; ctx.fillStyle = this.reduced ? item.color : '#ffffff';
        ctx.strokeText(item.label, x, y); ctx.fillText(item.label, x, y); ctx.restore(); return;
      }
      const effect = item.effect;
      const palette = PALETTES[effect];
      const tw = item.width - 32;
      const entrance = Math.min(1, elapsed / .48);
      const center = x + tw / 2;
      this.drawAccent(item, x, y, tw, elapsed, count > 12 ? 5 : 10, baseAlpha);
      ctx.translate(center, y - item.size * .36);
      // 文字の拡大は予約幅以内。レーンの衝突回避を壊さず、演出ごとに動きを変える。
      let scale = 1;
      if (effect === 'comic') scale = .64 + .36 * (1 - Math.pow(1 - entrance, 3));
      if (effect === 'spotlight') scale = .88 + .12 * (1 - Math.pow(1 - entrance, 2));
      if (effect === 'ice') ctx.scale(.65 + .35 * entrance, 1);
      if (effect === 'laser') ctx.transform(1, 0, -.12 * (1 - entrance), 1, 0, 0);
      if (effect === 'flame') ctx.translate(0, Math.sin(elapsed * 5 + item.seed) * 3);
      if (effect === 'rainbow') ctx.translate(0, Math.sin(elapsed * 3 + item.seed) * 4);
      if (effect === 'gold') ctx.translate(0, -Math.sin(Math.min(1, elapsed / 1.2) * Math.PI) * 5);
      ctx.scale(scale, scale);
      const tx = -tw / 2, ty = item.size * .36;
      ctx.shadowColor = palette[0]; ctx.shadowBlur = effect === 'neon' ? 22 : 12;
      ctx.lineWidth = effect === 'comic' ? 9 : 7; ctx.strokeStyle = '#07091c';
      this.paint(item, tx, ty, elapsed, true);
      ctx.shadowBlur = 0;
      if (effect === 'glitch') {
        ctx.globalAlpha = baseAlpha * .6;
        ctx.fillStyle = '#00ffff'; ctx.fillText(item.label, tx - 3, ty - 2);
        ctx.fillStyle = '#ff245f'; ctx.fillText(item.label, tx + 3, ty + 2);
        ctx.globalAlpha = baseAlpha;
      }
      ctx.lineWidth = 2; ctx.strokeStyle = palette[0]; this.paint(item, tx, ty, elapsed, true);
      const gradient = ctx.createLinearGradient(tx, ty - item.size, tx + (effect === 'rainbow' ? Math.max(1, tw) : 0), ty + 5);
      palette.forEach((color, i) => gradient.addColorStop(i / (palette.length - 1), color));
      ctx.fillStyle = gradient;
      this.paint(item, tx, ty, elapsed, false);
      ctx.restore();
    }
    paint(item, x, y, elapsed, stroke) {
      const ctx = this.ctx;
      const method = stroke ? 'strokeText' : 'fillText';
      if (item.effect === 'wave') {
        for (let i = 0; i < item.glyphs.length; i++) {
          const glyph = item.glyphs[i];
          ctx[method](glyph.letter, x + glyph.offset, y + Math.sin(elapsed * 4 - i * .65) * 5);
        }
      } else ctx[method](item.label, x, y);
    }
    star(x, y, radius, color) {
      const ctx = this.ctx;
      ctx.fillStyle = color; ctx.beginPath();
      ctx.moveTo(x - radius, y); ctx.lineTo(x - radius * .2, y - radius * .2);
      ctx.lineTo(x, y - radius); ctx.lineTo(x + radius * .2, y - radius * .2);
      ctx.lineTo(x + radius, y); ctx.lineTo(x + radius * .2, y + radius * .2);
      ctx.lineTo(x, y + radius); ctx.lineTo(x - radius * .2, y + radius * .2);
      ctx.closePath(); ctx.fill();
    }
    drawAccent(item, x, y, tw, elapsed, amount, alpha) {
      const { ctx, opts } = this;
      const palette = PALETTES[item.effect], size = item.size;
      ctx.save(); ctx.globalAlpha = alpha;
      const end = x + tw;
      if (item.effect === 'comic') {
        ctx.fillStyle = '#ff347d'; ctx.globalAlpha *= .38; ctx.beginPath();
        for (let i = 0; i < 20; i++) {
          const a = i / 20 * Math.PI * 2, r = i % 2 ? 1 : 1.15;
          const px = x + tw / 2 + Math.cos(a) * (tw / 2 + 15) * r;
          const py = y - size * .4 + Math.sin(a) * size * .72 * r;
          if (!i) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath(); ctx.fill(); ctx.globalAlpha = alpha;
      } else if (item.effect === 'spotlight') {
        const beam = ctx.createLinearGradient(x, y + 28, x, y - size * 1.25);
        beam.addColorStop(0, '#b354ff00'); beam.addColorStop(1, '#b354ff');
        ctx.fillStyle = beam; ctx.globalAlpha *= .23;
        ctx.beginPath(); ctx.moveTo(x + tw / 2, y + 28); ctx.lineTo(x - 20, y - size * 1.25);
        ctx.lineTo(end + 20, y - size * 1.25); ctx.closePath(); ctx.fill(); ctx.globalAlpha = alpha;
      } else if (item.effect === 'laser' || item.effect === 'glitch') {
        ctx.strokeStyle = palette[0]; ctx.lineWidth = 2; ctx.shadowColor = palette[0]; ctx.shadowBlur = 12;
        for (let i = 0; i < 3; i++) {
          const dy = y - size * (i / 3) - 2;
          ctx.beginPath(); ctx.moveTo(end + 8, dy); ctx.lineTo(end + 25 + i * 18 + Math.sin(elapsed * 4) * 8, dy); ctx.stroke();
        }
        ctx.shadowBlur = 0;
      } else if (item.effect === 'neon' || item.effect === 'rainbow') {
        ctx.strokeStyle = palette[0]; ctx.lineWidth = 2; ctx.globalAlpha *= .65;
        ctx.beginPath(); ctx.moveTo(x, y + 6); ctx.lineTo(end, y + 6); ctx.stroke();
        ctx.globalAlpha = alpha;
      }
      if (opts.confetti) for (let i = 0; i < amount; i++) {
        const seed = C.hash(`${item.id}:spark:${i}`);
        const phase = (elapsed * .55 + (seed % 100) / 100) % 1;
        const px = x + (seed % 1000) / 1000 * tw + Math.sin(i + elapsed * 2) * 8;
        const py = y - size * .5 + (i % 2 ? -1 : 1) * (size * .45 + phase * 18);
        ctx.globalAlpha = alpha * (1 - phase) * .8;
        const color = palette[i % palette.length];
        if (item.effect === 'flame') {
          ctx.fillStyle = color; ctx.beginPath();
          ctx.moveTo(px - 4, py + 5); ctx.quadraticCurveTo(px - 8, py - 5, px + 2, py - 15 - phase * 12);
          ctx.quadraticCurveTo(px + 10, py + 5, px - 4, py + 5); ctx.fill();
        } else if (item.effect === 'ice') {
          ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(px, py - 7); ctx.lineTo(px + 4, py);
          ctx.lineTo(px, py + 7); ctx.lineTo(px - 4, py); ctx.closePath(); ctx.fill();
        } else this.star(px, py, 3 + seed % 5, color);
      }
      ctx.restore();
    }
    drawBurst(burst, elapsed) {
      const { ctx, width: w, height: h, opts } = this;
      const fade = Math.min(1, elapsed * 5, (2.8 - elapsed) * 2);
      const seed = C.hash(`${burst.time}:${burst.label}`);
      ctx.save(); ctx.globalAlpha = fade * opts.opacity / 100;
      if (opts.confetti) {
        const mode = seed % 3;
        const amount = Math.min(72, burst.count * 10);
        for (let i = 0; i < amount; i++) {
          const s = C.hash(`${seed}:${i}`), a = i * 2.39996;
          const color = C.COLORS[i % C.COLORS.length];
          const px = mode === 0 ? (s % 1000) / 1000 * w + Math.sin(i) * elapsed * 24 : w * .5 + Math.cos(a) * elapsed * (60 + s % 160);
          const py = mode === 0 ? elapsed * (40 + s % 95) + elapsed * elapsed * 25 : h * .55 + Math.sin(a) * elapsed * (40 + s % 120) + elapsed * elapsed * 20;
          if (mode === 2) this.star(px, py, 4 + s % 6, color);
          else {
            ctx.save(); ctx.translate(px, py); ctx.rotate(i + elapsed * 1.3); ctx.fillStyle = color;
            ctx.fillRect(-3, -5, 6, i % 2 ? 12 : 6); ctx.restore();
          }
        }
      }
      const size = Math.max(18, Math.min(38, w / 24));
      this.font(size);
      const text = `${burst.label}  ×${burst.count}`, tw = ctx.measureText(text).width;
      const x = (w - tw) / 2, y = h * .88;
      ctx.translate(w / 2, y); const scale = .8 + .2 * Math.min(1, elapsed * 4); ctx.scale(scale, scale); ctx.translate(-w / 2, -y);
      ctx.fillStyle = '#140c27df'; ctx.beginPath(); ctx.roundRect(x - 20, y - size - 10, tw + 40, size + 30, 12); ctx.fill();
      ctx.strokeStyle = C.COLORS[seed % C.COLORS.length]; ctx.lineWidth = 3; ctx.stroke();
      ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = 16;
      ctx.lineWidth = 6; ctx.strokeStyle = '#080917'; ctx.strokeText(text, x, y);
      ctx.fillStyle = '#fff481'; ctx.fillText(text, x, y);
      ctx.restore();
    }
    destroy() {
      this.stopped = true; cancelAnimationFrame(this.raf); this.resizeObserver.disconnect();
      this.motionQuery.removeEventListener('change', this.motionChanged);
      this.ctx.clearRect(0, 0, this.width, this.height);
    }
  }
  root.CometRenderer = CometRenderer;
})(globalThis);

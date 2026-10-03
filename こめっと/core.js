/* タイムコード解析・重なりを避けるレーン配置・演出の割り当て。 */
(function (root) {
  'use strict';
  const DEFAULTS = Object.freeze({
    enabled: true, festival: true, fontSize: 32, opacity: 100, duration: 8,
    lanes: 12, hideChapters: true, ngWords: '', minLikes: 0, confetti: true, includeUntimed: true
  });
  const COLORS = ['#ff5fba', '#85ffdc', '#ffe66d', '#b6a0ff', '#65d8ff', '#ffad72'];
  const EFFECTS = Object.freeze(['neon', 'rainbow', 'flame', 'ice', 'gold', 'comic', 'glitch', 'wave', 'spotlight', 'laser']);
  const timelineCache=new WeakMap();
  function settings(value = {}) {
    const result = { ...DEFAULTS };
    for (const key of ['enabled', 'festival', 'hideChapters', 'confetti', 'includeUntimed']) {
      if (typeof value[key] === 'boolean') result[key] = value[key];
    }
    const ranges = { fontSize: [18, 46], opacity: [25, 100], duration: [4, 14], lanes: [4, 18], minLikes: [0, 1000000] };
    for (const [key, [lo, hi]] of Object.entries(ranges)) {
      if (Number.isFinite(Number(value[key]))) result[key] = Math.min(hi, Math.max(lo, Number(value[key])));
    }
    result.ngWords = typeof value.ngWords === 'string' ? value.ngWords.slice(0, 1000) : '';
    return result;
  }
  function timestamps(text) {
    const normalized = String(text).replace(/[０-９：]/g, c => c === '：' ? ':' : String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    const matches = [];
    const pattern = /(?<![\d:])(\d{1,3}):(\d{2})(?::(\d{2}))?(?![\d:])/g;
    for (const match of normalized.matchAll(pattern)) {
      const [, a, b, c] = match;
      if (Number(b) > 59 || (c !== undefined && (Number(c) > 59 || Number(a) > 99))) continue;
      matches.push({ time: c === undefined ? Number(a) * 60 + Number(b) : Number(a) * 3600 + Number(b) * 60 + Number(c), index: match.index, length: match[0].length });
    }
    return { normalized, matches };
  }
  function parseComment(raw, id = '') {
    const text = typeof raw === 'string' ? raw : raw.text;
    if (!text) return [];
    const meta = typeof raw === 'string' ? {} : raw;
    const { normalized, matches } = timestamps(text);
    const chapters = (meta.source || 'youtube') === 'youtube' && matches.length >= 5 && normalized.split('\n').length >= 3;
    const results = [];
    const seen = new Set();
    for (const match of matches) {
      if (seen.has(match.time)) continue;
      seen.add(match.time);
      const start = normalized.lastIndexOf('\n', match.index) + 1;
      const next = normalized.indexOf('\n', match.index);
      const end = next < 0 ? normalized.length : next;
      const line = normalized.slice(start, end);
      const display = line.replace(/(?<![\d:])\d{1,3}:\d{2}(?::\d{2})?(?![\d:])/g, '').replace(/^[\s\-–—|:：]+|[\s\-–—|:：]+$/g, '').replace(/\s+/g, ' ');
      if (!display) continue;
      results.push({ id: `${id || hash(normalized)}:${match.time}`, time: match.time, text: Array.from(display).slice(0, 110).join(''), likes: Math.max(0, Number(meta.likes) || 0), author: String(meta.author || ''), source: meta.source || 'youtube', chapters });
    }
    return results;
  }
  function hash(text) {
    let n = 2166136261;
    for (const c of String(text)) { n ^= c.codePointAt(0); n = Math.imul(n, 16777619); }
    return n >>> 0;
  }
  function parseLikes(text) {
    const s = String(text || '').normalize('NFKC').replace(/,/g, '').trim().toLowerCase();
    const m = s.match(/(\d+(?:\.\d+)?)\s*(万|千|k|m)?/);
    if (!m) return 0;
    return Math.round(Number(m[1]) * ({ 万: 10000, 千: 1000, k: 1000, m: 1000000 }[m[2]] || 1));
  }
  function untimedComment(raw, id) {
    if (timestamps(raw.text).matches.length) return [];
    const text = Array.from(String(raw.text || '').replace(/\s+/g, ' ').trim()).slice(0, 110).join('');
    return text ? [{ id, text, time: null, untimed: true, source: 'youtube', likes: raw.likes || 0, author: raw.author || '', chapters: false }] : [];
  }
  function timeline(comments, opts, duration = Infinity, currentTime = 0, sampleAll = false) {
    let byOptions=timelineCache.get(comments);
    if(!byOptions){byOptions=new WeakMap();timelineCache.set(comments,byOptions);}
    let prepared=byOptions.get(opts);
    if(!prepared){
      const words=opts.ngWords.split(/[,，\n]/).map(w=>w.trim().toLocaleLowerCase()).filter(Boolean);
      prepared={timed:comments.filter(e=>!e.untimed),ordinary:comments.filter(e=>e.untimed&&e.likes>=opts.minLikes&&!words.some(w=>e.text.toLocaleLowerCase().includes(w)))};
      byOptions.set(opts,prepared);
    }
    const {timed,ordinary}=prepared;
    if(!opts.includeUntimed)return timed;
    if (!ordinary.length) return timed;
    // 時刻なしは2.5秒ごとに既存コメントを順番に循環。現在時刻の前後だけを生成する。
    const interval = 2.5;
    const first = Math.max(0, Math.floor((currentTime - opts.duration - interval) / interval));
    const last = Math.ceil(Math.min(currentTime + 20, duration) / interval);
    const flow = [];
    for (let slot = first; slot <= last; slot++) {
      const time = slot * interval + .15;
      if (time > duration) continue;
      // 大量取得後は先頭の数十件だけでなく、取得済みの全体から選んで表示する。
      const index=sampleAll?hash(`${ordinary[0].id}:slot:${slot}`)%ordinary.length:slot%ordinary.length;
      const comment = ordinary[index];
      flow.push({ ...comment, id: `${comment.id}:flow:${slot}`, time });
    }
    return timed.concat(flow);
  }
  function filtered(events, opts, duration = Infinity) {
    const words = opts.ngWords.split(/[,，\n]/).map(x => x.trim().toLocaleLowerCase()).filter(Boolean);
    return events.filter(e => Number.isFinite(e.time) && e.time >= 0 && e.time <= duration && (!opts.hideChapters || !e.chapters) && (e.source === 'local' || e.likes >= opts.minLikes) && !words.some(w => e.text.toLocaleLowerCase().includes(w))).sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  }
  function styleFor(event, opts) {
    const funny = /草|[wｗ]{2,}|笑|🤣|😂/i.test(event.text);
    const god = /神|天才|最高|すご|優勝|🔥/.test(event.text);
    const big = opts.festival && (event.likes >= 50 || god || event.source === 'local');
    const seed = hash(event.id);
    return { color: !opts.festival ? '#ffffff' : funny ? '#85ffb5' : COLORS[seed % COLORS.length], size: Math.round(opts.fontSize * (big ? 1.32 : 1.08)), funny, god, big, seed, effect: opts.festival ? EFFECTS[seed % EFFECTS.length] : 'plain' };
  }
  function schedule(events, opts, width, height, measure) {
    const rowHeight = opts.fontSize * (opts.festival ? 1.32 : 1.08) + 24;
    const lanes = Math.max(1, Math.min(Math.floor(opts.lanes), Math.floor((height * .72) / rowHeight)));
    const occupied = Array.from({ length: lanes }, () => []);
    const items = [];
    let previousEffect;
    for (const event of events) {
      const style = styleFor(event, opts);
      const label = `${event.source === 'local' ? '✦ ' : event.likes >= 50 ? '★ ' : ''}${event.text}`;
      const textWidth = measure(label, style.size) + 32;
      const speed = (width + textWidth) / opts.duration;
      const start = event.time;
      const end = start + opts.duration;
      const preferred = hash(event.id) % lanes;
      let lane = -1;
      for (let offset = 0; offset < lanes; offset++) {
        const index = (preferred + offset) % lanes;
        occupied[index] = occupied[index].filter(old => old.end > start);
        const safe = occupied[index].every(old => {
          const gapAtStart = old.speed * (start - old.time) - old.width;
          const gapAtExit = width - speed * (old.end - start);
          return gapAtStart >= 32 && gapAtExit >= 32;
        });
        if (safe) { lane = index; break; }
      }
      if (lane < 0) continue;
      if (opts.festival && style.effect === previousEffect) style.effect = EFFECTS[(EFFECTS.indexOf(style.effect) + 1 + style.seed % (EFFECTS.length - 1)) % EFFECTS.length];
      previousEffect = style.effect;
      const item = { ...event, ...style, label, width: textWidth, speed, end, lane, y: height * .10 + rowHeight + lane * rowHeight };
      occupied[lane].push(item);
      items.push(item);
    }
    return items;
  }
  function bursts(events) {
    const buckets = new Map();
    for (const e of events) {
      const t = Math.floor(e.time / 2) * 2;
      if (!buckets.has(t)) buckets.set(t, []);
      buckets.get(t).push(e);
    }
    return [...buckets].filter(([, es]) => es.length >= 3).map(([, es]) => ({ time: Math.max(...es.map(e => e.time)), count: es.length, label: es.filter(e => /草|[wｗ]{2,}|笑/i.test(e.text)).length >= 2 ? '草 祭 り' : es.some(e => /神|天才|最高/.test(e.text)) ? '神 回 確 定' : 'こ こ、祭 り。' }));
  }
  function histogram(events, duration, bins = 70) {
    const values = Array(bins).fill(0);
    if (!(duration > 0) || !Number.isFinite(duration)) return values;
    for (const event of events) if (event.time >= 0 && event.time <= duration) values[Math.min(bins - 1, Math.floor(event.time / duration * bins))]++;
    return values;
  }
  function formatTime(time) {
    const seconds = Math.max(0, Math.floor(time || 0));
    return seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
  const api = { DEFAULTS, COLORS, EFFECTS, settings, timestamps, parseComment, parseLikes, hash, untimedComment, timeline, filtered, styleFor, schedule, bursts, histogram, formatTime };
  root.CometCore = Object.freeze(api);
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

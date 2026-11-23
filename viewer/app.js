'use strict';
/* Sleep-Mirror synthetic study viewer. Vanilla JS + canvas. See SPEC.md for data formats. */
const Q = new URLSearchParams(location.search);
const FIX = Q.has('fixture');
const STUDY = FIX ? 'fixture/' : '../data/study/';
const DS = '../data/dataset/';
const STAGES = ['W', 'N1', 'N2', 'N3', 'R', 'DISC'];
const CODE = {0: 'W', 1: 'N1', 2: 'N2', 3: 'N3', 4: 'R', 8: 'DISC'};
const LEVEL = {W: 0, R: 1, N1: 2, N2: 3, N3: 4, DISC: 5};
const ALLCH = ['PSG_F3', 'PSG_F4', 'PSG_C3', 'PSG_C4', 'PSG_O1', 'PSG_O2', 'PSG_EOG', 'PSG_EMG', 'PSG_THER', 'PSG_THOR', 'PSG_ABD'];
const DEFCH = ['PSG_F4', 'PSG_C4', 'PSG_O2', 'PSG_EOG', 'PSG_EMG'];
const TOOLS = ['goto_epoch', 'pan', 'zoom', 'toggle_channel', 'set_scale', 'apply_filter', 'measure', 'show_hypnogram', 'show_spectrogram', 'set_label', 'mark_event', 'add_comment', 'undo', 'next_flagged'];
const TOOLCOL = {goto_epoch: '#4e79a7', pan: '#76b7b2', zoom: '#59a14f', toggle_channel: '#edc948', set_scale: '#b6992d', apply_filter: '#9c755f', measure: '#f28e2b', show_hypnogram: '#bab0ac', show_spectrogram: '#86bcb6', set_label: '#e15759', mark_event: '#b07aa1', add_comment: '#ff9da7', undo: '#d37295', next_flagged: '#a0cbe8'};

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const fmt = (x, d = 2) => (x == null || x === '' || isNaN(x)) ? '–' : (+x).toFixed(d);
const mmss = s => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600); return (h ? h + ':' : '') + String(Math.floor(s % 3600 / 60)).padStart(h ? 2 : 1, '0') + ':' + String(s % 60).padStart(2, '0'); };
const mean = a => { a = a.filter(x => x != null && !isNaN(x)); return a.length ? a.reduce((p, c) => p + c, 0) / a.length : NaN; };

/* ---- colors (CSS vars → canvas) ---- */
let COL = {};
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const g = n => cs.getPropertyValue(n).trim();
  COL = {};
  for (const k of ['bg', 'panel', 'panel2', 'fg', 'dim', 'line', 'accent', 'bad', 'warn', 'trace']) COL[k] = g('--' + k);
  for (const s of STAGES) COL[s] = g('--c-' + s);
}
readColors();
matchMedia('(prefers-color-scheme:dark)').addEventListener('change', () => { readColors(); redrawAll(); });

function fit(c, h) {
  const dpr = window.devicePixelRatio || 1, w = Math.max(100, c.parentElement.clientWidth);
  if (c._w !== w || c._h !== h || c._d !== dpr) {
    c.style.width = w + 'px'; c.style.height = h + 'px';
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    c._w = w; c._h = h; c._d = dpr;
  }
  const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  return {g, w, h};
}
const tip = $('#tip');
function showTip(ev, txt) { tip.hidden = false; tip.textContent = txt; tip.style.left = Math.min(ev.clientX + 12, innerWidth - 300) + 'px'; tip.style.top = (ev.clientY + 14) + 'px'; }
function hideTip() { tip.hidden = true; }

/* ---- data loading ---- */
async function fetchText(u) { try { const r = await fetch(u); return r.ok ? await r.text() : null; } catch (e) { return null; } }
async function fetchJSON(u) { const t = await fetchText(u); if (t == null) return null; try { return JSON.parse(t); } catch (e) { return null; } }
function parseTSV(t) {
  if (!t) return [];
  const L = t.split(/\r?\n/).filter(x => x.length); const H = L[0].split('\t');
  return L.slice(1).map(l => { const p = l.split('\t'), o = {}; H.forEach((h, i) => { const v = p[i] ?? ''; o[h] = v === '' ? '' : (isNaN(+v) ? v : +v); }); return o; });
}
function parseJSONL(t) {
  const ev = []; for (const l of (t || '').split(/\r?\n/)) { if (!l.trim()) continue; try { ev.push(JSON.parse(l)); } catch (e) { } }
  ev.sort((a, b) => (a.t - b.t) || ((a.seq || 0) - (b.seq || 0))); return ev;
}
const cache = {night: {}, ann: {}, sess: {}};
const D = {index: [], annotators: {}, assign: null, nights: {}, parts: {}};

async function loadNight(n) {
  if (cache.night[n]) return cache.night[n];
  const p = cache.night[n] = (async () => {
    const [ev, ya, fe] = await Promise.all([
      fetchText(`${DS}${n}/${n}_task-Sleep_acq-psg_events.tsv`), fetchText(`${DS}${n}/${n}_yasa.tsv`), fetchText(`${DS}${n}/${n}_epoch_features.tsv`)]);
    const evr = parseTSV(ev), yasa = parseTSV(ya), feat = parseTSV(fe);
    const cons = evr.map(r => CODE[r.stage_hum] || 'DISC');
    return {n, ne: cons.length, cons, yasa, feat, ystage: yasa.map(r => r.yasa_stage), meta: D.nights[n] || {}};
  })();
  return p;
}
async function loadAnn(a, n) {
  const k = a + '_' + n; if (k in cache.ann) return cache.ann[k];
  const t = await fetchText(`${STUDY}annotations/${k}.tsv`);
  if (t == null) return cache.ann[k] = null;
  const rows = parseTSV(t), N = await loadNight(n), fin = new Array(N.ne).fill(null), src = new Array(N.ne).fill(''), flag = new Array(N.ne).fill(0), chg = new Array(N.ne).fill(0);
  for (const r of rows) { fin[r.epoch] = r.final_stage; src[r.epoch] = r.source; flag[r.epoch] = r.flagged ? 1 : 0; chg[r.epoch] = r.n_label_changes || 0; }
  return cache.ann[k] = {rows, fin, src, flag, chg};
}
async function loadSession(path) {
  if (cache.sess[path]) return cache.sess[path];
  return cache.sess[path] = parseJSONL(await fetchText(STUDY + path));
}

/* ---- stats ---- */
function kappa(a, b) {
  const n = Math.min(a.length, b.length), cats = {}; let agree = 0, cnt = 0; const A = {}, B = {};
  for (let i = 0; i < n; i++) { if (a[i] == null || b[i] == null) continue; cnt++; if (a[i] === b[i]) agree++; A[a[i]] = (A[a[i]] || 0) + 1; B[b[i]] = (B[b[i]] || 0) + 1; cats[a[i]] = cats[b[i]] = 1; }
  if (!cnt) return NaN; let pe = 0; for (const c in cats) pe += ((A[c] || 0) / cnt) * ((B[c] || 0) / cnt);
  const po = agree / cnt; return pe >= 1 ? 1 : (po - pe) / (1 - pe);
}
function fleiss(raters) { // raters: array of label arrays
  const n = raters.length; if (n < 2) return NaN; const N = Math.min(...raters.map(r => r.length)); const tot = {}; let Pbar = 0, cnt = 0;
  for (let i = 0; i < N; i++) {
    const c = {}; let ok = true; for (const r of raters) { if (r[i] == null) { ok = false; break; } c[r[i]] = (c[r[i]] || 0) + 1; }
    if (!ok) continue; cnt++; let s = 0; for (const k in c) { s += c[k] * c[k]; tot[k] = (tot[k] || 0) + c[k]; } Pbar += (s - n) / (n * (n - 1));
  }
  Pbar /= cnt; let Pe = 0; for (const k in tot) Pe += (tot[k] / (cnt * n)) ** 2; return Pe >= 1 ? 1 : (Pbar - Pe) / (1 - Pe);
}

/* =========================================================
   Synthetic PSG rendering (deterministic, from epoch features)
   ========================================================= */
const FS = 100, EPN = 30 * FS, TAU = 2 * Math.PI;
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { return () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(TAU * r()); }
const gb = (t, c, w) => Math.exp(-(((t - c) / w) ** 2));
const layoutCache = new Map(), sigCache = new Map();

function epochLayout(night, ep, f) { // shared event timing across channels
  const k = night + '|' + ep; if (layoutCache.has(k)) return layoutCache.get(k);
  const r = rng(hash('L' + k)), L = {};
  const spread = n => { const a = []; for (let i = 0; i < n; i++) a.push(2 + (26 * (i + r() * 0.8)) / Math.max(n, 1)); return a; };
  L.spindles = spread(f.spindles | 0).map(c => ({c, dur: 0.6 + r() * 0.9, hz: 12 + r() * 3}));
  L.kc = spread(f.k_complexes | 0); L.vertex = spread(f.vertex_waves | 0); L.rem = spread(f.rem_count | 0).map(c => ({c, s: r() < 0.5 ? -1 : 1}));
  L.sw = {dur: 30 * (f.slow_wave_pct || 0) / 100, start: 0, per: 0.8 + r() * 0.5}; L.sw.start = r() * Math.max(0, 30 - L.sw.dur);
  L.saw = f.sawtooth ? [2 + r() * 6, 15 + r() * 8].map(c => ({c, dur: 4 + r() * 4})) : [];
  L.blinks = (f.stage_true === 'W' || f.rel_alpha > 0.3) ? spread(2 + Math.floor(r() * 4)) : [];
  L.arO = f.arousal && f.arousal_onset_s !== '' ? +f.arousal_onset_s : null; L.arD = 3.5 + r() * 2.5;
  L.art = {kind: f.artifact || 'none', on: 3 + r() * 18, dur: 2.5 + r() * 3.5, chs: String(f.artifact_channels || '').split(',').map(s => s.trim()).filter(Boolean)};
  layoutCache.set(k, L); return L;
}
const REG = {F: {d: 1.2, t: 1, a: 0.8, s: 0.9, b: 1, kc: 1.2, v: 0.6, sw: 1.15}, C: {d: 1, t: 1, a: 1, s: 1.3, b: 1, kc: 1, v: 1, sw: 1}, O: {d: 0.75, t: 0.9, a: 1.7, s: 0.6, b: 0.9, kc: 0.4, v: 0.2, sw: 0.6}};

function synthChannel(night, ep, ch, f) {
  const key = night + '|' + ep + '|' + ch; if (sigCache.has(key)) return sigCache.get(key);
  if (sigCache.size > 600) sigCache.clear();
  const L = epochLayout(night, ep, f), r = rng(hash('S' + key)), x = new Float32Array(EPN), t = i => i / FS;
  const isEEG = /^PSG_[FCO][1-4]$/.test(ch), reg = isEEG ? REG[ch[4]] : null;
  const arch = L.art.chs.includes(ch) && L.art.kind !== 'none';
  if (isEEG) {
    const A = 14 + 50 * (f.rel_delta || 0);
    const bands = [['rel_delta', 0.5, 3.5, reg.d, 3], ['rel_theta', 4, 7.5, reg.t, 3], ['rel_alpha', 8, 12, reg.a, 3], ['rel_sigma', 12, 15, reg.s, 2], ['rel_beta', 16, 28, reg.b, 4]];
    for (const [nm, lo, hi, gn, nc] of bands) {
      const rms = A * Math.sqrt(Math.max(f[nm] || 0, 0)) * gn;
      for (let c = 0; c < nc; c++) {
        const amp = rms * Math.SQRT2 / Math.sqrt(nc), fr = lo + r() * (hi - lo), ph = r() * TAU, mf = 0.05 + r() * 0.25, mp = r() * TAU;
        for (let i = 0; i < EPN; i++) { const tt = t(i); x[i] += amp * (1 + 0.45 * Math.sin(TAU * mf * tt + mp)) * Math.sin(TAU * fr * tt + ph); }
      }
    }
    let prev = 0; for (let i = 0; i < EPN; i++) { prev = 0.7 * prev + gauss(r) * 3; x[i] += prev; }
    // slow waves
    const sw = L.sw; if (sw.dur > 0.5) for (let i = 0; i < EPN; i++) {
      const tt = t(i), u = tt - sw.start; if (u < 0 || u > sw.dur) continue; const env = Math.min(1, u / 1, (sw.dur - u) / 1);
      x[i] += 105 * reg.sw * env * Math.sin(TAU * u / sw.per) * (0.8 + 0.2 * Math.sin(u * 1.7));
    }
    for (const s of L.spindles) for (let i = 0; i < EPN; i++) { const tt = t(i); if (Math.abs(tt - s.c) > s.dur) continue; x[i] += 26 * reg.s * gb(tt, s.c, s.dur / 2.2) * Math.sin(TAU * s.hz * tt); }
    for (const c of L.kc) for (let i = 0; i < EPN; i++) { const tt = t(i); if (Math.abs(tt - c) > 1.5) continue; x[i] += reg.kc * (-130 * gb(tt, c, 0.13) + 80 * gb(tt, c + 0.5, 0.25)); }
    for (const c of L.vertex) for (let i = 0; i < EPN; i++) { const tt = t(i); if (Math.abs(tt - c) > 0.8) continue; x[i] += reg.v * (-80 * gb(tt, c, 0.07) + 35 * gb(tt, c + 0.15, 0.1)); }
    for (const s of L.saw) for (let i = 0; i < EPN; i++) { const tt = t(i), u = tt - s.c; if (u < 0 || u > s.dur) continue; const ph = (u * 2.5) % 1; x[i] += 45 * (ch[4] === 'C' ? 1 : ch[4] === 'F' ? 0.7 : 0.3) * Math.min(1, u, s.dur - u) * (ph * 2 - 1); }
  } else if (ch === 'PSG_EOG') {
    for (let c = 0; c < 4; c++) { const a = 14 * r(), fr = 0.3 + r() * 1.7, ph = r() * TAU; for (let i = 0; i < EPN; i++) x[i] += a * Math.sin(TAU * fr * t(i) + ph); }
    for (const c of L.blinks) for (let i = 0; i < EPN; i++) { const tt = t(i); if (Math.abs(tt - c) < 0.6) x[i] += 110 * gb(tt, c, 0.12); }
    for (const e of L.rem) for (let i = 0; i < EPN; i++) { const tt = t(i); if (Math.abs(tt - e.c) < 0.8) x[i] += e.s * (170 * gb(tt, e.c, 0.1) - 60 * gb(tt, e.c + 0.3, 0.2)); }
    if (f.sem) { const ph = r() * TAU; for (let i = 0; i < EPN; i++) x[i] += 75 * Math.sin(TAU * 0.28 * t(i) + ph); }
    let prev = 0; for (let i = 0; i < EPN; i++) { prev = 0.8 * prev + gauss(r) * 2; x[i] += prev; }
  } else if (ch === 'PSG_EMG') {
    const rms = f.emg_rms || 10;
    for (let i = 0; i < EPN; i++) { let m = 1; const tt = t(i); if (L.arO != null && tt >= L.arO && tt <= L.arO + L.arD) m *= 2.5; if (arch && L.art.kind === 'movement' && tt >= L.art.on && tt <= L.art.on + L.art.dur) m *= 4; x[i] = gauss(r) * rms * m; }
  } else { // respiratory
    const fr = 0.22 + r() * 0.06, ph = r() * TAU, a = ch === 'PSG_THER' ? 90 : ch === 'PSG_THOR' ? 70 : 60;
    for (let i = 0; i < EPN; i++) x[i] = a * Math.sin(TAU * fr * t(i) + ph) * (1 + 0.15 * Math.sin(t(i) * 0.4)) + gauss(r) * 4;
  }
  // arousal: abrupt alpha/beta burst
  if (isEEG && L.arO != null) for (let i = 0; i < EPN; i++) { const tt = t(i), u = tt - L.arO; if (u < 0 || u > L.arD) continue; const env = Math.min(1, u / 0.4, (L.arD - u) / 0.6); x[i] += env * (22 * Math.sin(TAU * 11 * tt) + 14 * Math.sin(TAU * 19 * tt + 1) + gauss(r) * 5); }
  // artifacts
  if (arch && !(ch === 'PSG_EMG' && L.art.kind === 'movement')) {
    const k = L.art.kind, on = L.art.on, du = L.art.dur, ra = rng(hash('A' + night + '|' + ep + '|' + ch));
    for (let i = 0; i < EPN; i++) {
      const tt = t(i);
      if (k === 'movement' && tt >= on && tt <= on + du) { const e = Math.min(1, (tt - on) / 0.2, (on + du - tt) / 0.3); x[i] += e * (320 * Math.sin(TAU * 1.7 * tt) + 180 * Math.sin(TAU * 4.1 * tt + 1) + gauss(ra) * 120); }
      else if (k === 'electrode_pop') { const u = tt - on; if (u >= 0) x[i] += 420 * Math.exp(-u / 0.6) * (u < 0.05 ? 1.6 : 1); }
      else if (k === 'sweat') x[i] += 160 * Math.sin(TAU * 0.15 * tt + 0.5) + 60 * Math.sin(TAU * 0.33 * tt);
      else if (k === 'ecg') { const ph = (tt * 1.1) % 1; x[i] += 55 * gb(ph, 0.3, 0.012) - 15 * gb(ph, 0.28, 0.01) + 12 * gb(ph, 0.55, 0.05); }
      else if (k === 'disconnect') x[i] = gauss(ra) * 0.8;
    }
  }
  sigCache.set(key, x); return x;
}

/* =========================================================
   Sidebar + routing
   ========================================================= */
const personaOpen = {};
function personaHTML(a) {
  if (!a) return '<span class="dim">no persona</span>';
  const rows = [['role', a.role], ['exp', a.years_exp + ' y'], ['L1', a.native_language], ['site', a.site], ['verbosity', a.verbosity], ['filler', a.filler_rate], ['s/epoch', (a.speed_s_per_epoch || []).join('–')], ['base acc', a.base_accuracy], ['YASA anchor', a.yasa_anchoring], ['tools', (a.favorite_tools || []).join(', ')], ['biases', JSON.stringify(a.biases || {})], ['notes', a.style_notes]];
  return '<table>' + rows.map(([k, v]) => `<tr><td class="dim">${k}</td><td>${esc(v)}</td></tr>`).join('') + '</table>';
}
let sideSort = 'pct';
function renderSide() {
  const side = $('#side'); const cur = location.hash.split('?')[0];
  let h = `<a class="side-item ${cur === '' || cur.startsWith('#/overview') ? 'active' : ''}" href="#/overview"><b>Overview</b><div class="dim" style="font-size:11px">nights ranked · annotator stats · agreement</div></a>
  <div class="side-sort">Nights <span class="spacer"></span><select id="sideSort"><option value="pct">most flagged first</option><option value="id">by id</option></select></div>`;
  const by = {}; D.index.forEach(j => (by[j.night] = by[j.night] || []).push(j));
  const ns = Object.keys(by).sort((a, b) => sideSort === 'pct' ? nightPct(b) - nightPct(a) : (+a.slice(4)) - (+b.slice(4)));
  const maxp = Math.max(...ns.map(nightPct), 0.01);
  for (const n of ns) {
    const m = D.nights[n] || {}, p = nightPct(n), nh = `#/night/${n}`;
    h += `<a class="night-h ${cur === nh ? 'active' : ''}" href="${nh}" title="${m.n_flagged ?? '?'} of ${m.n_epochs ?? '?'} epochs flagged by YASA">
      <span class="nm">${n}${m.role === 'shared' ? '<span class="badge">shared</span>' : ''}</span><span class="dim pc">${(100 * p).toFixed(0)}% flagged</span>
      <span class="ubar"><span style="width:${Math.round(100 * p / maxp)}%"></span></span></a>`;
    for (const j of by[n].sort((x, y) => x.annotator < y.annotator ? -1 : 1)) {
      const hash = `#/job/${j.annotator}/${j.night}`, pp = D.annotators[j.annotator];
      h += `<a class="side-item job ${cur === hash ? 'active' : ''}" href="${hash}" title="${esc(pp ? `${pp.role}, ${pp.years_exp}y, ${pp.native_language}` : '')}"><span>${j.annotator}</span><span class="dim">κ ${fmt(j.kappa_vs_consensus)} · ${mmss(j.duration_s)}</span></a>`;
    }
  }
  h += `<div class="side-sort" style="margin-top:10px">Annotator personas</div>`;
  for (const a of Object.keys(D.annotators).sort()) {
    const p = D.annotators[a];
    h += `<div class="ann-h" data-a="${a}">${a} <span class="dim" style="font-weight:400">${esc(p ? p.role : '')}</span></div>`;
    if (personaOpen[a]) h += `<div class="persona">${personaHTML(p)}</div>`;
  }
  side.innerHTML = h;
  $('#sideSort').value = sideSort; $('#sideSort').onchange = e => { sideSort = e.target.value; renderSide(); };
  side.querySelectorAll('.ann-h').forEach(e => e.onclick = () => { personaOpen[e.dataset.a] = !personaOpen[e.dataset.a]; renderSide(); });
}
function route() {
  stopPlay();
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?'), p = path.split('/');
  const ep = qs ? new URLSearchParams(qs).get('e') : null;
  renderSide(); NV = null; if (typeof rpStop === 'function') { rpStop(); RP = null; }
  if (p[0] === 'replay' && p[1] && p[2]) openReplay(p[1], p[2], new URLSearchParams(qs || '')); else if (p[0] === 'job' && p[1] && p[2]) openJob(p[1], p[2], ep); else if (p[0] === 'night' && p[1]) openNight(p[1]); else openOverview();
}
window.addEventListener('hashchange', route);
function redrawAll() { if (typeof RP !== 'undefined' && RP) { RP.sigKey = ''; rpRender(); } if (NV) drawNight(); if (J) { renderHyp(); renderTimeline(); renderSignal(true); } if (OV) OV.redraw && OV.redraw(); }

/* =========================================================
   Overview
   ========================================================= */
let OV = null;
function labChip(s) { return `<span class="lab" style="background:${COL[s] || '#888'}">${s ?? '–'}</span>`; }
async function openOverview() {
  J = null; const main = $('#main');
  main.innerHTML = '<div class="card">Computing statistics…</div>';
  const jobs = D.index, nights = [...new Set(jobs.map(j => j.night))];
  const N = {}; await Promise.all(nights.map(async n => N[n] = await loadNight(n)));
  const A = {}; await Promise.all(jobs.map(async j => A[j.annotator + '_' + j.night] = await loadAnn(j.annotator, j.night)));
  OV = {N, A, sel: 'all'};
  const anns = [...new Set(jobs.map(j => j.annotator))].sort();
  const rows = anns.map(a => {
    const js = jobs.filter(j => j.annotator === a), p = D.annotators[a] || {};
    let ky = [], kya = [], yc = [], over = 0, nonfl = 0, nh = 0;
    for (const j of js) {
      const an = A[a + '_' + j.night]; if (!an) continue; const n = N[j.night];
      ky.push(kappa(n.ystage, n.cons)); kya.push(kappa(n.ystage, an.fin));
      for (let e = 0; e < n.ne; e++) { if (an.src[e] === 'human') nh++; if (!an.flag[e]) { nonfl++; if (an.fin[e] !== n.ystage[e]) over++; } }
    }
    const kc = js.map(j => { const an = A[a + '_' + j.night]; return an ? kappa(an.fin, N[j.night].cons) : NaN; });
    return `<tr><td><b>${a}</b></td><td>${esc(p.role || '')}</td><td>${js.length}</td><td>${js.reduce((s, j) => s + (j.n_flagged || 0), 0)}</td><td>${js.reduce((s, j) => s + (j.n_labels || 0), 0)}</td><td>${mmss(js.reduce((s, j) => s + (j.duration_s || 0), 0))}</td>
      <td>${fmt(mean(js.map(j => j.kappa_vs_consensus)))}</td><td>${fmt(mean(kc))}</td><td>${fmt(mean(js.map(j => j.acc_flagged)))}</td><td>${fmt(mean(js.map(j => j.acc_all)))}</td><td>${fmt(mean(ky))}</td><td>${fmt(mean(kya))}</td><td>${nonfl ? fmt(100 * over / nonfl, 1) + '%' : '–'}</td></tr>`;
  }).join('');
  const shared = (D.assign && D.assign.shared_nights) || [...new Set(jobs.filter(j => j.role === 'shared').map(j => j.night))];
  main.innerHTML = nightsCardHTML() + `
  <div class="card"><h3>Per-annotator statistics</h3>
   <div style="overflow:auto"><table class="t"><thead><tr><th>annotator</th><th>role</th><th>jobs</th><th>flagged</th><th>labels</th><th>time</th><th>κ idx</th><th>κ final↔cons</th><th>acc flagged</th><th>acc all</th><th title="YASA vs consensus">κ YASA↔cons</th><th title="YASA vs annotator final (high = anchoring)">κ YASA↔ann</th><th title="unflagged epochs the annotator changed from YASA">override rate</th></tr></thead><tbody>${rows}</tbody></table></div>
   <div class="note">κ idx = mean of kappa_vs_consensus from index.json; κ final↔cons recomputed here from annotations/*.tsv vs events.tsv stage_hum. Override rate = share of non-flagged epochs where final ≠ YASA.</div></div>
  <div class="card"><h3>Confusion matrix (rows = consensus, cols = annotator final) <span class="spacer"></span><select id="cmSel"><option value="all">all annotators</option>${anns.map(a => `<option>${a}</option>`).join('')}</select>
   <label><input type="checkbox" id="cmYasa"> YASA instead of annotator</label></h3><div id="cm"></div></div>
  <div class="card"><h3>Shared nights — epoch-wise agreement across annotators</h3><div id="shared"></div></div>`;
  $('#cmSel').onchange = $('#cmYasa').onchange = drawCM; drawCM();
  OV.redraw = () => { drawSharedAll(); drawNightsList(); };
  $('#nsort').onchange = drawNightsList; drawNightsList();
  drawShared(shared);
}
function drawCM() {
  const sel = $('#cmSel').value, yasa = $('#cmYasa').checked, cats = ['W', 'N1', 'N2', 'N3', 'R'];
  const M = {}; cats.forEach(a => { M[a] = {}; cats.forEach(b => M[a][b] = 0); });
  for (const j of D.index) {
    if (sel !== 'all' && j.annotator !== sel) continue; const an = OV.A[j.annotator + '_' + j.night], n = OV.N[j.night]; if (!an) continue;
    const arr = yasa ? n.ystage : an.fin; for (let e = 0; e < n.ne; e++) { const a = n.cons[e], b = arr[e]; if (M[a] && b in M[a]) M[a][b]++; }
  }
  let tot = 0, ok = 0; cats.forEach(a => cats.forEach(b => { tot += M[a][b]; if (a === b) ok += M[a][b]; }));
  let h = `<table class="t cm"><thead><tr><th>cons \\ ${yasa ? 'YASA' : 'ann'}</th>${cats.map(c => `<th>${c}</th>`).join('')}<th>recall</th></tr></thead><tbody>`;
  for (const a of cats) {
    const rs = cats.reduce((s, b) => s + M[a][b], 0);
    h += `<tr><td>${labChip(a)} <span class="dim">n=${rs}</span></td>` + cats.map(b => { const p = rs ? M[a][b] / rs : 0; const bg = a === b ? `color-mix(in srgb, var(--c-N2) ${Math.round(p * 70)}%, transparent)` : `color-mix(in srgb, var(--bad) ${Math.min(90, Math.round(p * 400))}%, transparent)`; return `<td class="n" style="background:${bg}" title="${(100 * p).toFixed(1)}% of ${a}">${M[a][b]}</td>`; }).join('') + `<td class="n">${rs ? (100 * M[a][a] / rs).toFixed(1) + '%' : '–'}</td></tr>`;
  }
  $('#cm').innerHTML = h + `</tbody></table><div class="note">overall accuracy ${tot ? (100 * ok / tot).toFixed(1) : '–'}% over ${tot} epochs; red = off-diagonal share of row.</div>`;
}
function drawShared(shared) { OV.shared = shared; const el = $('#shared'); el.innerHTML = ''; for (const n of shared) { const d = document.createElement('div'); d.style.marginBottom = '10px'; d.innerHTML = `<div id="sh-${n}-t"></div><canvas></canvas>`; el.appendChild(d); d._n = n; } drawSharedAll(); }
function drawSharedAll() {
  if (!OV || !OV.shared) return;
  OV.shared.forEach((n, idx) => {
    const box = $('#shared').children[idx]; if (!box) return; const N = OV.N[n]; if (!N) return;
    const raters = D.index.filter(j => j.night === n).map(j => ({a: j.annotator, an: OV.A[j.annotator + '_' + n]})).filter(r => r.an).sort((x, y) => x.a < y.a ? -1 : 1);
    const fk = fleiss(raters.map(r => r.an.fin));
    const pw = []; raters.forEach((x, i) => raters.forEach((y, j) => { if (j > i) pw.push(kappa(x.an.fin, y.an.fin)); }));
    box.firstChild.innerHTML = `<b>${n}</b> · ${N.ne} epochs · ${raters.length} raters · <b>Fleiss κ = ${fmt(fk, 3)}</b> · mean pairwise Cohen κ ${fmt(mean(pw), 3)} · YASA↔cons κ ${fmt(kappa(N.ystage, N.cons), 3)}`;
    const rows = [{l: 'consensus', a: N.cons}, {l: 'YASA', a: N.ystage}, ...raters.map(r => ({l: r.a, a: r.an.fin}))];
    // agreement row: fraction of raters agreeing with the modal label
    const agr = new Array(N.ne).fill(0); for (let e = 0; e < N.ne; e++) { const c = {}; raters.forEach(r => { const v = r.an.fin[e]; c[v] = (c[v] || 0) + 1; }); agr[e] = raters.length ? Math.max(...Object.values(c)) / raters.length : 0; }
    const c = box.querySelector('canvas'), rh = 11, H = (rows.length + 2) * (rh + 2) + 22, {g, w} = fit(c, H), gx = 78, pw2 = w - gx - 6;
    g.font = '10px sans-serif'; g.textBaseline = 'middle';
    const rowsAll = [...rows]; let y = 2;
    rowsAll.forEach(r => {
      g.fillStyle = COL.dim; g.textAlign = 'right'; g.fillText(r.l, gx - 6, y + rh / 2);
      for (let e = 0; e < N.ne; e++) { const s = r.a[e]; if (!s) continue; g.fillStyle = COL[s] || '#888'; g.fillRect(gx + e / N.ne * pw2, y, Math.max(pw2 / N.ne, 1), rh); }
      y += rh + 2;
    });
    g.fillStyle = COL.dim; g.fillText('agreement', gx - 6, y + rh / 2);
    for (let e = 0; e < N.ne; e++) { const a = agr[e]; g.fillStyle = a >= 1 ? COL.panel2 : `rgba(209,56,74,${0.25 + 0.75 * (1 - a)})`; g.fillRect(gx + e / N.ne * pw2, y, Math.max(pw2 / N.ne, 1), rh); }
    y += rh + 2; g.fillStyle = COL.dim; g.fillText('≠ consensus', gx - 6, y + rh / 2);
    for (let e = 0; e < N.ne; e++) { let d = 0; raters.forEach(r => { if (r.an.fin[e] !== N.cons[e]) d++; }); if (!d) continue; g.fillStyle = `rgba(209,56,74,${d / Math.max(raters.length, 1)})`; g.fillRect(gx + e / N.ne * pw2, y, Math.max(pw2 / N.ne, 1), rh); }
    y += rh + 6; g.textAlign = 'center'; g.fillStyle = COL.dim;
    for (let hr = 0; hr * 120 < N.ne; hr++) g.fillText(hr + 'h', gx + hr * 120 / N.ne * pw2, y + 6);
    c.onmousemove = ev => { const b = c.getBoundingClientRect(), e = Math.floor((ev.clientX - b.left - gx) / pw2 * N.ne); if (e < 0 || e >= N.ne) return hideTip(); showTip(ev, `epoch ${e}  (${mmss(e * 30)})\n` + rows.map(r => r.l.padEnd(10) + r.a[e]).join('\n') + `\nmodal agreement ${(agr[e] * 100).toFixed(0)}%`); };
    c.onmouseleave = hideTip;
  });
}

/* =========================================================
   Job view
   ========================================================= */
let J = null, jobToken = 0, raf = null, lastTick = 0;
const FILTERS = {
  all: ['all epochs', () => true],
  dis: ['annotator ≠ consensus', (e, j) => j.final[e] != null && j.final[e] !== j.N.cons[e]],
  flag: ['flagged (YASA conf < 0.6)', (e, j) => !!j.N.yasa[e].flagged],
  flagdis: ['flagged & annotator ≠ consensus', (e, j) => j.N.yasa[e].flagged && j.final[e] != null && j.final[e] !== j.N.cons[e]],
  yasadis: ['YASA ≠ consensus', (e, j) => j.N.ystage[e] !== j.N.cons[e]],
  human: ['human-labelled', (e, j) => j.an && j.an.src[e] === 'human'],
  overrode: ['final ≠ YASA', (e, j) => j.final[e] != null && j.final[e] !== j.N.ystage[e]],
  unflagdis: ['NOT flagged but annotator ≠ consensus', (e, j) => !j.N.yasa[e].flagged && j.final[e] != null && j.final[e] !== j.N.cons[e]],
  artifact: ['artifact epochs', (e, j) => j.N.feat[e] && j.N.feat[e].artifact !== 'none'],
  arousal: ['arousal epochs', (e, j) => j.N.feat[e] && j.N.feat[e].arousal],
};

async function openJob(a, n, ep0) {
  const tok = ++jobToken, main = $('#main');
  main.innerHTML = '<div class="card">Loading night…</div>';
  const job = D.index.find(j => j.annotator === a && j.night === n) || {annotator: a, night: n, sessions: []};
  const [N, an] = await Promise.all([loadNight(n), loadAnn(a, n)]);
  if (tok !== jobToken) return;
  OV = null;
  J = {a, n, job, N, an, final: an ? an.fin : new Array(N.ne).fill(null), si: 0, S: null, t: 0, playing: false, speed: 10, manual: null, epoch: -1, filter: 'all', sel: [], chOverride: null, scale: null, marks: true, follow: true, v0: 0, v1: 1, sigKey: '', persona: D.annotators[a]};
  J.lights = (N.meta.lights_off || '00:00').split(':').map(Number);
  buildJobDOM();
  applyFilter();
  await setSession(0);
  if (tok !== jobToken) return;
  if (Q.has('epoch')) J.manual = +Q.get('epoch');
  renderHyp(); renderEpochList(); onTime();
  if (ep0 != null) selectEpoch(+ep0);
}
function clock(sec) { const L = J.lights, s = (L[0] * 3600 + L[1] * 60 + sec) % 86400, h = Math.floor(s / 3600); return String(h).padStart(2, '0') + ':' + String(Math.floor(s % 3600 / 60)).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0'); }

function buildJobDOM() {
  const {a, n, job, N, an} = J;
  $('#main').innerHTML = `
  <div class="grid"><div id="left">
   <div class="card"><h3><span><a href="#/night/${n}">${n}</a> › <b>${a}</b>${job.role === 'shared' ? '<span class="badge">shared</span>' : ''}</span>
     <span class="dim" style="font-weight:400;text-transform:none">${N.ne} epochs · ${N.meta.hours ?? ''} h · lights-off ${N.meta.lights_off ?? '?'} · ${N.meta.ahi_group ?? ''} · κ ${fmt(job.kappa_vs_consensus)} · acc<sub>flagged</sub> ${fmt(job.acc_flagged)} · acc<sub>all</sub> ${fmt(job.acc_all)} · YASA acc ${fmt(N.meta.yasa_acc)}</span>
     <a class="btnlink" href="#/replay/${a}/${n}?s=0">▶ Replay session</a><span class="spacer"></span>
     <label>filter <select id="filt">${Object.entries(FILTERS).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join('')}</select></label>
     <button id="fprev" title="previous matching epoch (k)">◀</button><span id="fcnt" class="dim"></span><button id="fnext" title="next matching epoch (j)">▶</button></h3>
     ${!an ? '<div class="warnbox">No annotation file for this job — annotator strip is empty.</div>' : ''}
     <canvas id="hyp"></canvas>
     <div class="note">Consensus stage_hum · YASA pre-score (red tick = ≠ consensus) · YASA confidence profile · annotator final (red tick = ≠ consensus). Marker rows: amber = flagged, red = annotator ≠ consensus, blue = current filter. Click an epoch to select it.</div></div>
   <div class="card"><h3><span>Session timeline</span><select id="sesSel"></select>
      <button id="play">▶ play</button><select id="speed"><option value="1">1×</option><option value="10" selected>10×</option><option value="60">60×</option></select>
      <span id="tnow" class="mono"></span><span class="spacer"></span><button id="tfit">fit</button><span class="dim" style="font-weight:400;text-transform:none">wheel = zoom · drag = scrub · space = play/pause</span></h3>
     <canvas id="tl"></canvas><input type="range" id="scrub" min="0" max="1000" value="0"><div id="tlLegend" class="note"></div></div>
   <div class="card"><h3><span>Signal</span><span id="mode"></span><button id="follow" hidden>follow playhead</button><span class="spacer"></span>
      <label><input type="checkbox" id="marks" checked> annotate synthesized events</label>
      <label>µV/half-lane <select id="scale"><option value="">viewport</option><option>25</option><option>50</option><option>75</option><option>100</option><option>150</option><option>250</option></select></label></h3>
     <div class="warnbox" style="margin-bottom:6px">Synthetic rendering from epoch_features — not real signal. Real data: BOAS EDF (OpenNeuro ds005555).</div>
     <div class="chips" id="chips"></div><canvas id="sig"></canvas><div id="info"></div></div>
  </div>
  <div id="right"><div class="card">
     <h3 class="tabs"><span><button id="tabT" class="on">Trajectory</button><button id="tabE">Epochs</button></span><span class="spacer"></span>
       <input type="search" id="q" placeholder="search transcript / tools…" style="width:150px"></h3>
     <div class="ctl" id="tctl" style="margin-top:0"><label><input type="checkbox" data-k="speech" checked> speech</label><label><input type="checkbox" data-k="tool" checked> tools</label>
       <label><input type="checkbox" data-k="ui"> UI</label><label><input type="checkbox" data-k="pause" checked> pauses</label>
       <label><input type="checkbox" id="rawall"> raw JSON</label><label><input type="checkbox" id="autoscroll" checked> follow</label><span id="qcnt" class="dim"></span></div>
     <div id="feed"></div><div id="eplist" hidden style="flex:1;overflow:auto;min-height:0;border-top:1px solid var(--line)"></div>
  </div></div></div>`;
  $('#filt').onchange = e => { J.filter = e.target.value; applyFilter(); renderHyp(); renderEpochList(); };
  $('#fprev').onclick = () => stepSel(-1); $('#fnext').onclick = () => stepSel(1);
  $('#play').onclick = () => J.playing ? stopPlay() : startPlay();
  $('#speed').onchange = e => J.speed = +e.target.value;
  $('#sesSel').onchange = e => setSession(+e.target.value);
  $('#scrub').oninput = e => seek(+e.target.value / 1000 * J.S.tmax);
  $('#tfit').onclick = () => { J.v0 = 0; J.v1 = J.S ? J.S.tmax : 1; renderTimeline(); };
  $('#marks').onchange = e => { J.marks = e.target.checked; renderSignal(true); };
  $('#scale').onchange = e => { J.scale = e.target.value ? +e.target.value : null; renderSignal(true); };
  $('#follow').onclick = () => { J.manual = null; onTime(); };
  $('#tabT').onclick = () => tab('T'); $('#tabE').onclick = () => tab('E');
  $('#q').oninput = filterFeed;
  $('#tctl').querySelectorAll('input[data-k]').forEach(c => c.onchange = filterFeed);
  $('#rawall').onchange = e => $('#feed').classList.toggle('rawall', e.target.checked);
  $('#sesSel').innerHTML = (job.sessions || []).map((p, i) => `<option value="${i}">session ${i + 1}</option>`).join('') || '<option>no sessions</option>';
  bindHyp(); bindTimeline();
}
function tab(t) { $('#tabT').classList.toggle('on', t === 'T'); $('#tabE').classList.toggle('on', t === 'E'); $('#feed').hidden = t !== 'T'; $('#tctl').hidden = t !== 'T'; $('#eplist').hidden = t !== 'E'; if (t === 'E') markEpochList(true); }

function applyFilter() {
  const f = FILTERS[J.filter][1]; J.sel = []; for (let e = 0; e < J.N.ne; e++) if (f(e, J)) J.sel.push(e);
  J.selSet = new Set(J.sel); $('#fcnt').textContent = `${J.sel.length}/${J.N.ne}`;
}
function stepSel(d) {
  const s = J.sel; if (!s.length) return; const cur = J.epoch; let t;
  if (d > 0) t = s.find(e => e > cur) ?? s[0]; else { t = null; for (const e of s) if (e < cur) t = e; if (t == null) t = s[s.length - 1]; }
  selectEpoch(t);
}
document.addEventListener('keydown', e => {
  if (!J || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && document.activeElement.type !== 'checkbox' && document.activeElement.type !== 'range') return;
  if (e.key === ' ') { e.preventDefault(); J.playing ? stopPlay() : startPlay(); }
  else if (e.key === 'j') stepSel(1); else if (e.key === 'k') stepSel(-1);
});

/* ---- session ---- */
const vpKey = vp => [vp.start_epoch, vp.window_s, (vp.channels || []).join(','), vp.scale_uv, vp.offset_s || 0].join('|');
async function setSession(i) {
  stopPlay(); J.si = i; J.t = 0; J.manual = null;
  const path = (J.job.sessions || [])[i]; const ev = path ? await loadSession(path) : [];
  J.S = buildSession(ev); J.v0 = 0; J.v1 = J.S.tmax || 1; J.sigKey = ''; J.epoch = -1;
  buildFeed(); onTime(); $('#sesSel').value = i;
}
function buildSession(ev) {
  const S = {ev, vps: [], items: [], speech: [], tools: [], ui: [], pauses: [], tmax: 0, first: new Map(), toolsSeen: new Set()};
  const res = {}; ev.forEach(e => { if (e.type === 'tool_result') res[e.call_id] = e; });
  let cur = {start_epoch: 0, offset_s: 0, window_s: 30, channels: DEFCH.slice(), scale_uv: 100};
  const push = t => S.vps.push({t, vp: {...cur, channels: cur.channels.slice()}});
  const nav = e => { const q = Object.assign({}, e); delete q.epoch; return q; };
  for (const e of ev) {
    let end = e.t; const calls = {};
    switch (e.type) {
      case 'session_start': if (e.viewport) cur = {...cur, ...e.viewport, channels: (e.viewport.channels || cur.channels).slice()}; push(e.t); S.items.push({t: e.t, k: 'sess', e}); break;
      case 'transcript': S.speech.push({a: e.t_start ?? e.t, b: e.t_end ?? e.t + 1, e}); end = e.t_end ?? e.t; S.items.push({t: e.t_start ?? e.t, k: 'speech', e}); break;
      case 'tool_call': {
        const r = res[e.call_id], a = e.args || {};
        switch (e.tool) {
          case 'goto_epoch': cur.start_epoch = a.epoch; cur.offset_s = 0; break;
          case 'pan': cur.start_epoch += (a.direction === 'left' ? -1 : 1) * (a.n_epochs || 1); break;
          case 'zoom': cur.window_s = a.window_s; break;
          case 'toggle_channel': { const s = new Set(cur.channels); a.visible ? s.add(a.channel) : s.delete(a.channel); cur.channels = ALLCH.filter(c => s.has(c)); break; }
          case 'set_scale': if (a.channel === 'all' || !a.channel) cur.scale_uv = (a.uv_per_div || 50) * 2; break;
        }
        push(e.t);
        if (r && r.result) {
          if (r.result.viewport) { const v = r.result.viewport; cur = {...cur, ...v, channels: (v.channels || cur.channels).slice()}; push(r.t); }
          else if (e.tool === 'next_flagged' && r.result.epoch != null) { cur.start_epoch = r.result.epoch; push(r.t); }
        }
        end = r ? r.t : e.t + 0.3; S.tools.push({a: e.t, b: Math.max(end, e.t + 0.3), tool: e.tool, e, r}); S.toolsSeen.add(e.tool);
        S.items.push({t: e.t, k: 'tool', e, r}); break;
      }
      case 'tool_result': if (!ev.some(x => x.type === 'tool_call' && x.call_id === e.call_id)) S.items.push({t: e.t, k: 'tool', e: null, r: e}); break;
      case 'ui': end = e.t + (e.duration_s || 0); S.ui.push({a: e.t, b: Math.max(end, e.t + 0.15), e}); S.items.push({t: e.t, k: 'ui', e}); break;
      case 'pause': end = e.t + (e.duration_s || 0); S.pauses.push({a: e.t, b: end, e}); S.items.push({t: e.t, k: 'pause', e}); break;
      case 'session_end': S.items.push({t: e.t, k: 'sess', e}); break;
    }
    S.tmax = Math.max(S.tmax, end, e.t);
  }
  S.tmax = Math.max(S.tmax, 1);
  // first time each epoch was on screen
  for (let i = 0; i < S.vps.length; i++) {
    const v = S.vps[i].vp, e0 = Math.floor(v.start_epoch), n = Math.min(20, Math.ceil(v.window_s / 30));
    for (let k = 0; k < n; k++) if (!S.first.has(e0 + k)) S.first.set(e0 + k, S.vps[i].t);
  }
  return S;
}
function vpAt(t) {
  const v = J.S.vps; if (!v.length) return {start_epoch: 0, offset_s: 0, window_s: 30, channels: DEFCH.slice(), scale_uv: 100};
  let lo = 0, hi = v.length - 1, r = 0; while (lo <= hi) { const m = (lo + hi) >> 1; if (v[m].t <= t) { r = m; lo = m + 1; } else hi = m - 1; } return v[r].vp;
}

/* ---- playback / time ---- */
function startPlay() { if (!J || !J.S) return; if (J.t >= J.S.tmax - 0.05) J.t = 0; J.manual = null; J.playing = true; lastTick = performance.now(); raf = requestAnimationFrame(tick); $('#play').textContent = '❚❚ pause'; $('#play').classList.add('on'); }
function stopPlay() { cancelAnimationFrame(raf); if (J) { J.playing = false; const b = $('#play'); if (b) { b.textContent = '▶ play'; b.classList.remove('on'); } } }
function tick(now) {
  if (!J || !J.playing) return; const dt = Math.min(0.1, (now - lastTick) / 1000); lastTick = now;
  J.t = Math.min(J.S.tmax, J.t + dt * J.speed);
  if (J.t < J.v0 || J.t > J.v1) { const w = J.v1 - J.v0; J.v0 = Math.max(0, J.t - 0.2 * w); J.v1 = J.v0 + w; }
  onTime(); if (J.t >= J.S.tmax) stopPlay(); else raf = requestAnimationFrame(tick);
}
function seek(t) { J.t = Math.max(0, Math.min(J.S.tmax, t)); J.manual = null; onTime(); }
function onTime() {
  if (!J || !J.S) return; const S = J.S, vp = vpAt(J.t); J.vp = vp;
  const e = J.manual != null ? J.manual : Math.max(0, Math.min(J.N.ne - 1, Math.floor(vp.start_epoch + 1e-9)));
  const key = e + '|' + (J.manual != null ? 'm|' + vp.window_s : vpKey(vp));
  if (key !== J.sigKey) { J.sigKey = key; const ch = e !== J.epoch; J.epoch = e; renderHyp(); renderSignal(); if (ch) { renderInfo(); markEpochList(); } }
  renderTimeline();
  $('#tnow').textContent = `${mmss(J.t)} / ${mmss(S.tmax)}`; $('#scrub').value = Math.round(J.t / S.tmax * 1000);
  const m = $('#mode'); m.innerHTML = J.manual != null ? '<span class="chip" style="background:var(--warn);color:#000">manual epoch (not in session viewport)</span>' : '<span class="dim" style="font-weight:400;text-transform:none">following session viewport</span>'; $('#follow').hidden = J.manual == null;
  feedHighlight();
}
function selectEpoch(e) {
  e = Math.max(0, Math.min(J.N.ne - 1, e)); const S = J.S;
  if (S && S.first.has(e)) { seekKeepPlay(S.first.get(e)); } else { J.manual = e; J.sigKey = ''; onTime(); }
  J.epoch = e; // ensure highlight even if unchanged
  renderHyp(); renderInfo(); markEpochList(true);
}
function seekKeepPlay(t) { J.t = t; J.manual = null; J.sigKey = ''; if (J.t < J.v0 || J.t > J.v1) { const w = J.v1 - J.v0; J.v0 = Math.max(0, t - 0.2 * w); J.v1 = J.v0 + w; } onTime(); }

/* ---- hypnogram ---- */
function bindHyp() {
  const c = $('#hyp'), ep = ev => { const b = c.getBoundingClientRect(), gx = 74, pw = b.width - gx - 8; return Math.floor((ev.clientX - b.left - gx) / pw * J.N.ne); };
  c.onclick = ev => { const e = ep(ev); if (e >= 0 && e < J.N.ne) selectEpoch(e); };
  c.onmousemove = ev => {
    const e = ep(ev); if (e < 0 || e >= J.N.ne) return hideTip(); const N = J.N, y = N.yasa[e], f = J.final[e];
    showTip(ev, `epoch ${e}  ${mmss(e * 30)} (${clock(e * 30)})\nconsensus  ${N.cons[e]}\nYASA       ${y.yasa_stage}  conf ${fmt(y.confidence)}${y.flagged ? '  FLAGGED' : ''}\nannotator  ${f ?? '–'}${J.an ? '  (' + J.an.src[e] + ')' : ''}${f != null && f !== N.cons[e] ? '  ≠ consensus' : ''}`);
  };
  c.onmouseleave = hideTip; c.style.cursor = 'pointer';
}
function renderHyp() {
  const c = $('#hyp'); if (!c || !J) return; const N = J.N, ne = N.ne;
  const stripH = 54, titleH = 12, blk = stripH + titleH + 3, marksH = 3 * 7 + 4, axisH = 14, H = 4 * blk + marksH + axisH + 4;
  const {g, w} = fit(c, H), gx = 74, pw = w - gx - 8, X = e => gx + e / ne * pw, ew = Math.max(pw / ne, 1);
  const strips = [['Consensus (stage_hum)', N.cons, 'c'], ['YASA pre-score', N.ystage, 'y'], ['YASA confidence  (dashed = flag threshold ' + THR().toFixed(2) + ', amber = flagged → annotator must score)', null, 'conf'], ['Annotator final (' + J.a + ')', J.final, 'a']];
  g.textBaseline = 'middle';
  strips.forEach(([name, arr, kind], i) => {
    const y0 = 2 + i * blk + titleH, lh = stripH / 6;
    g.fillStyle = COL.dim; g.font = 'bold 10px sans-serif'; g.textAlign = 'left'; g.fillText(name, gx, y0 - 6);
    if (kind === 'conf') { drawConf(g, N, gx, y0, pw, stripH); return; }
    g.fillStyle = COL.panel2; g.fillRect(gx, y0, pw, stripH);
    g.strokeStyle = COL.line; g.lineWidth = 0.5; g.beginPath(); for (let l = 1; l < 6; l++) { g.moveTo(gx, y0 + l * lh); g.lineTo(gx + pw, y0 + l * lh); } g.stroke();
    g.font = '8px sans-serif'; g.textAlign = 'right'; g.fillStyle = COL.dim;
    ['W', 'R', 'N1', 'N2', 'N3', 'DISC'].forEach((s, l) => g.fillText(s, gx - 4, y0 + (l + 0.5) * lh));
    for (let e = 0; e < ne; e++) { const s = arr[e]; if (!s) continue; g.fillStyle = COL[s] || '#888'; g.fillRect(X(e), y0 + LEVEL[s] * lh + 0.5, ew, lh - 1); }
    if (kind !== 'c') for (let e = 0; e < ne; e++) if (arr[e] != null && arr[e] !== N.cons[e]) { g.fillStyle = COL.bad; g.fillRect(X(e), kind === 'a' ? y0 + stripH - 3 : y0, Math.max(ew, 1.5), 3); }
  });
  let my = 2 + 4 * blk + 2;
  const rows = [[COL.warn, e => N.yasa[e].flagged, 'flagged'], [COL.bad, e => J.final[e] != null && J.final[e] !== N.cons[e], 'ann≠cons'], [COL.accent, e => J.filter !== 'all' && J.selSet.has(e), 'filter']];
  rows.forEach(([col, f, nm], i) => { g.fillStyle = COL.panel2; g.fillRect(gx, my, pw, 5); g.fillStyle = COL.dim; g.font = '8px sans-serif'; g.textAlign = 'right'; g.fillText(nm, gx - 4, my + 3); g.fillStyle = col; for (let e = 0; e < ne; e++) if (f(e)) g.fillRect(X(e), my, Math.max(ew, 1.5), 5); my += 7; });
  g.fillStyle = COL.dim; g.font = '9px sans-serif'; g.textAlign = 'center'; g.strokeStyle = COL.dim;
  timeAxis(g, ne, gx, my + 2, pw, N.meta.lights_off);
  // cursor: viewport window
  if (J.epoch >= 0) {
    const nw = Math.max(1, Math.ceil(((J.vp && J.vp.window_s) || 30) / 30)); const x0 = X(J.epoch); g.fillStyle = 'rgba(37,99,235,.18)'; g.fillRect(x0 - 1, 2, Math.max(nw * ew, 3) + 2, H - 20);
    g.strokeStyle = COL.accent; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x0, 2); g.lineTo(x0, H - 18); g.stroke();
  }
}

/* ---- timeline ---- */
const LANES = ['viewport', 'speech', 'tools', 'UI', 'pauses'], LANEH = 20, TLG = 70, RULER = 16;
function bindTimeline() {
  const c = $('#tl'); let down = false;
  const tAt = ev => { const b = c.getBoundingClientRect(), pw = b.width - TLG - 6; return J.v0 + (ev.clientX - b.left - TLG) / pw * (J.v1 - J.v0); };
  c.onmousedown = ev => { down = true; seek(tAt(ev)); }; window.addEventListener('mouseup', () => down = false);
  c.onmousemove = ev => {
    if (down) { seek(tAt(ev)); return; } const t = tAt(ev), b = c.getBoundingClientRect(), lane = Math.floor((ev.clientY - b.top - RULER) / LANEH); let txt = mmss(t) + ' (' + t.toFixed(1) + ' s)'; const S = J.S;
    const hit = arr => arr.find(x => t >= x.a - (J.v1 - J.v0) / 400 && t <= x.b + (J.v1 - J.v0) / 400);
    if (lane === 1) { const h = hit(S.speech); if (h) txt += '\n"' + h.e.text.slice(0, 120) + '"'; }
    if (lane === 2) { const h = hit(S.tools); if (h) txt += `\n${h.tool} ${JSON.stringify(h.e.args)}\n→ ${h.r ? JSON.stringify(h.r.result) : ''}`; }
    if (lane === 0) { const v = vpAt(t); txt += `\nepoch ${Math.floor(v.start_epoch)}  window ${v.window_s}s\n${(v.channels || []).map(x => x.replace('PSG_', '')).join(',')}`; }
    if (lane === 3) { const h = hit(S.ui); if (h) txt += `\nui ${h.e.kind} ${h.e.channel || ''} ${h.e.duration_s || ''}`; }
    if (lane === 4) { const h = hit(S.pauses); if (h) txt += `\npause ${h.e.reason} ${h.e.duration_s}s`; }
    showTip(ev, txt);
  };
  c.onmouseleave = hideTip;
  c.addEventListener('wheel', ev => {
    ev.preventDefault(); const t = tAt(ev), f = ev.deltaY > 0 ? 1.25 : 0.8, S = J.S; let w = (J.v1 - J.v0) * f; w = Math.max(5, Math.min(S.tmax, w));
    const fr = (t - J.v0) / (J.v1 - J.v0); J.v0 = Math.max(0, Math.min(S.tmax - w, t - fr * w)); J.v1 = J.v0 + w; renderTimeline();
  }, {passive: false});
}
function renderTimeline() {
  const c = $('#tl'); if (!c || !J || !J.S) return; const S = J.S, H = RULER + LANES.length * LANEH + 4, {g, w} = fit(c, H), pw = w - TLG - 6, v0 = J.v0, v1 = J.v1, X = t => TLG + (t - v0) / (v1 - v0) * pw;
  g.font = '10px sans-serif'; g.textBaseline = 'middle';
  // ruler
  const span = v1 - v0, steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600], st = steps.find(s => span / s < 12) || 3600;
  g.fillStyle = COL.dim; g.strokeStyle = COL.line; g.textAlign = 'center'; g.lineWidth = 0.5;
  for (let t = Math.ceil(v0 / st) * st; t <= v1; t += st) { const x = X(t); g.fillText(mmss(t), x, 7); g.beginPath(); g.moveTo(x, RULER - 2); g.lineTo(x, H); g.stroke(); }
  LANES.forEach((nm, i) => { const y = RULER + i * LANEH; g.fillStyle = i % 2 ? 'transparent' : COL.panel2; g.fillRect(TLG, y, pw, LANEH); g.fillStyle = COL.dim; g.textAlign = 'right'; g.fillText(nm, TLG - 6, y + LANEH / 2); });
  const lane = (i, arr, draw) => { const y = RULER + i * LANEH + 2, h = LANEH - 4; for (const o of arr) { if (o.b < v0 || o.a > v1) continue; const x0 = Math.max(TLG, X(o.a)), x1 = Math.min(TLG + pw, X(o.b)); draw(o, x0, Math.max(x1 - x0, 2), y, h); } };
  // viewport lane
  const vs = S.vps; for (let i = 0; i < vs.length; i++) {
    const a = vs[i].t, b = i + 1 < vs.length ? vs[i + 1].t : S.tmax; if (b < v0 || a > v1 || b - a <= 0) continue; const x0 = Math.max(TLG, X(a)), x1 = Math.min(TLG + pw, X(b)), e = Math.floor(vs[i].vp.start_epoch), s = J.N.cons[e] || 'DISC';
    g.fillStyle = COL[s]; g.globalAlpha = 0.85; g.fillRect(x0, RULER + 2, Math.max(x1 - x0, 1), LANEH - 4); g.globalAlpha = 1;
    if (x1 - x0 > 28) { g.fillStyle = s === 'W' || s === 'N1' ? '#000' : '#fff'; g.textAlign = 'left'; g.fillText((vs[i].vp.window_s !== 30 ? '[' + vs[i].vp.window_s + 's] ' : '') + 'e' + e, x0 + 2, RULER + LANEH / 2); }
  }
  lane(1, S.speech, (o, x, ww, y, h) => { const bad = o.e.no_speech_prob > 0.6 || o.e.avg_logprob < -1; g.fillStyle = bad ? COL.warn : COL.accent; g.globalAlpha = 0.75; g.fillRect(x, y, ww, h); g.globalAlpha = 1; });
  lane(2, S.tools, (o, x, ww, y, h) => { g.fillStyle = TOOLCOL[o.tool] || '#888'; g.fillRect(x, y, Math.max(ww, 3), h); });
  lane(3, S.ui, (o, x, ww, y, h) => { g.fillStyle = o.e.kind === 'dwell' ? '#59a14f' : o.e.kind === 'hover_channel' ? '#76b7b2' : '#bab0ac'; g.globalAlpha = 0.7; g.fillRect(x, y + (o.e.kind === 'dwell' ? 0 : 4), Math.max(ww, 1.5), o.e.kind === 'dwell' ? h : h - 8); g.globalAlpha = 1; });
  lane(4, S.pauses, (o, x, ww, y, h) => { g.fillStyle = o.e.reason === 'break' ? '#8a5cf6' : '#888'; g.fillRect(x, y, ww, h); });
  // playhead
  if (J.t >= v0 && J.t <= v1) { const x = X(J.t); g.strokeStyle = COL.bad; g.fillStyle = COL.bad; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); g.beginPath(); g.moveTo(x - 4, 0); g.lineTo(x + 4, 0); g.lineTo(x, 6); g.fill(); }
}

/* ---- signal panel ---- */
const SHORT = c => c.replace('PSG_', '');
function renderSignal(force) {
  const c = $('#sig'); if (!c || !J || !J.vp || J.epoch < 0) return; const N = J.N, vp = J.vp;
  const chans = (J.chOverride || vp.channels || DEFCH).filter(x => ALLCH.includes(x)), win = vp.window_s || 30;
  // chips
  $('#chips').innerHTML = '<span class="dim">channels: </span>' + ALLCH.map(ch => `<button data-c="${ch}" class="${chans.includes(ch) ? 'on' : ''}">${SHORT(ch)}</button>`).join('') + (J.chOverride ? ' <button id="chreset">reset to session</button>' : '') + `<span class="dim"> window ${win}s</span>`;
  $('#chips').querySelectorAll('button[data-c]').forEach(b => b.onclick = () => { const s = new Set(chans); s.has(b.dataset.c) ? s.delete(b.dataset.c) : s.add(b.dataset.c); J.chOverride = ALLCH.filter(x => s.has(x)); renderSignal(true); });
  const rb = $('#chreset'); if (rb) rb.onclick = () => { J.chOverride = null; renderSignal(true); };
  const abs0 = (J.manual != null ? J.manual : vp.start_epoch) * 30 + (J.manual != null ? 0 : (vp.offset_s || 0));
  const eS = Math.floor(abs0 / 30 + 1e-9), eE = Math.floor((abs0 + win - 1e-6) / 30), nE = eE - eS + 1;
  const topH = 18, laneH = chans.length > 7 ? 42 : chans.length > 4 ? 54 : 70, H = topH + chans.length * laneH + 18;
  const {g, w} = fit(c, H), gx = 62, pw = w - gx - 6, base = (eS * 30 - abs0), X = t => gx + (t - abs0) / win * pw;
  g.textBaseline = 'middle'; g.font = '10px sans-serif';
  // epoch strip
  for (let e = eS; e <= eE; e++) {
    const x0 = Math.max(gx, X(e * 30)), x1 = Math.min(gx + pw, X(e * 30 + 30)), s = N.cons[e]; if (!s) continue;
    g.fillStyle = COL[s]; g.globalAlpha = 0.9; g.fillRect(x0, 0, x1 - x0, topH - 3); g.globalAlpha = 1; g.fillStyle = (s === 'W' || s === 'N1') ? '#000' : '#fff'; g.textAlign = 'left';
    const f = J.final[e]; if (x1 - x0 > 60) g.fillText(`e${e} cons ${s} · ann ${f ?? '–'}${f && f !== s ? ' ≠' : ''}`, x0 + 3, (topH - 3) / 2); else if (x1 - x0 > 20) g.fillText('e' + e, x0 + 2, (topH - 3) / 2);
  }
  const half = J.scale || (vp.scale_uv ? vp.scale_uv * 2 : 100);
  // assemble samples
  const nS = Math.round(win * FS), s0 = Math.round((abs0 - eS * 30) * FS);
  chans.forEach((ch, ci) => {
    const y0 = topH + ci * laneH, mid = y0 + laneH / 2, sc = ch === 'PSG_EMG' ? half / 4 : half, ppu = (laneH / 2 - 2) / sc;
    g.fillStyle = ci % 2 ? 'transparent' : COL.panel2; g.fillRect(gx, y0, pw, laneH);
    g.fillStyle = COL.dim; g.textAlign = 'right'; g.font = 'bold 11px sans-serif'; g.fillText(SHORT(ch), gx - 6, mid - 5); g.font = '9px sans-serif'; g.fillText('±' + Math.round(sc) + (ch.match(/THER|THOR|ABD/) ? ' a.u.' : ' µV'), gx - 6, mid + 7);
    const buf = new Float32Array(nE * EPN); for (let e = eS; e <= eE; e++) { if (e < 0 || e >= N.ne) continue; buf.set(synthChannel(J.n, e, ch, N.feat[e]), (e - eS) * EPN); }
    g.save(); g.beginPath(); g.rect(gx, y0, pw, laneH); g.clip(); g.strokeStyle = COL.trace; g.lineWidth = 0.9; g.beginPath();
    for (let px = 0; px < pw; px++) {
      const i0 = s0 + Math.floor(px / pw * nS), i1 = Math.max(i0 + 1, s0 + Math.floor((px + 1) / pw * nS)); let mn = 1e9, mx = -1e9;
      for (let i = i0; i < i1 && i < buf.length; i++) { const v = buf[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      if (mn > mx) continue; const x = gx + px + 0.5; if (px === 0) g.moveTo(x, mid - mx * ppu); else g.lineTo(x, mid - mx * ppu); if (mn !== mx) g.lineTo(x, mid - mn * ppu);
    }
    g.stroke(); g.restore();
    // synthesized-event annotations
    if (J.marks) for (let e = eS; e <= eE; e++) {
      if (e < 0 || e >= N.ne) continue; const L = epochLayout(J.n, e, N.feat[e]), t0 = e * 30, isEEG = /^PSG_[FCO][1-4]$/.test(ch);
      g.font = '9px sans-serif'; g.textAlign = 'left';
      if (L.arO != null && ci === 0) { }
      if (L.arO != null) { const xa = X(t0 + L.arO), xb = X(t0 + L.arO + L.arD); g.fillStyle = 'rgba(217,142,4,.18)'; g.fillRect(xa, y0, xb - xa, laneH); g.fillStyle = COL.warn; g.fillRect(xa, y0, 1.5, laneH); if (ci === 0) g.fillText('arousal', xa + 3, y0 + 8); }
      if (L.art.kind !== 'none' && L.art.chs.includes(ch)) { const wide = L.art.kind === 'sweat' || L.art.kind === 'ecg' || L.art.kind === 'disconnect'; const xa = X(t0 + (wide ? 0 : L.art.on)), xb = X(t0 + (wide ? 30 : L.art.on + L.art.dur)); g.fillStyle = 'rgba(209,56,74,.13)'; g.fillRect(Math.max(gx, xa), y0, Math.min(gx + pw, xb) - Math.max(gx, xa), laneH); g.fillStyle = COL.bad; g.fillText('artifact: ' + L.art.kind, Math.max(gx, xa) + 3, y0 + laneH - 6); }
      if (isEEG && /[FC]/.test(ch[4])) { g.fillStyle = COL.accent; L.spindles.forEach(s => { g.fillRect(X(t0 + s.c - s.dur / 2), y0 + 1, Math.max(2, s.dur / win * pw), 2.5); }); if (ch[4] === 'F') L.kc.forEach(k => g.fillText('K', X(t0 + k) - 3, y0 + 9)); }
      if (isEEG && ch[4] === 'C') { L.kc.forEach(k => g.fillText('K', X(t0 + k) - 3, y0 + 9)); L.vertex.forEach(k => g.fillText('V', X(t0 + k) - 3, y0 + 9)); }
      if (ch === 'PSG_EOG') L.rem.forEach(r => { g.fillStyle = COL.R; g.fillText('R', X(t0 + r.c) - 3, y0 + 8); });
    }
  });
  // epoch gridlines + time axis
  g.strokeStyle = COL.dim; g.setLineDash([3, 3]); g.lineWidth = 0.8;
  for (let e = eS; e <= eE + 1; e++) { const x = X(e * 30); if (x < gx || x > gx + pw) continue; g.beginPath(); g.moveTo(x, topH - 3); g.lineTo(x, H - 14); g.stroke(); }
  g.setLineDash([]); g.fillStyle = COL.dim; g.textAlign = 'center'; g.font = '9px sans-serif';
  const tst = win <= 12 ? 1 : win <= 40 ? 5 : win <= 130 ? 10 : 30;
  for (let t = Math.ceil(abs0 / tst) * tst; t <= abs0 + win + 1e-6; t += tst) { const x = X(t); g.beginPath(); g.moveTo(x, H - 14); g.lineTo(x, H - 10); g.stroke(); g.fillText(win <= 40 ? (t % 30 === 0 ? mmss(t) : '+' + (t % 30).toFixed(0) + 's') : mmss(t), x, H - 4); }
}

/* ---- epoch info ---- */
function renderInfo() {
  const el = $('#info'); if (!el || !J || J.epoch < 0) return; const N = J.N, e = J.epoch, y = N.yasa[e], f = N.feat[e] || {}, fin = J.final[e], cons = N.cons[e];
  const probs = ['W', 'N1', 'N2', 'N3', 'R'].map(s => [s, y['p_' + s] || 0]);
  const keys = Object.keys(f).filter(k => !['epoch', 'onset_s', 'stage_true'].includes(k));
  el.innerHTML = `<div class="ctl"><b>Epoch ${e}</b><span class="dim">${mmss(e * 30)} into recording · ${clock(e * 30)}</span>
     <span>consensus ${labChip(cons)}</span><span>YASA ${labChip(y.yasa_stage)} <span class="mono">${fmt(y.confidence)}</span>${y.flagged ? ' <span class="chip" style="background:var(--warn);color:#000">flagged</span>' : ''}</span>
     <span>${J.a} ${fin ? `<span class="lab ${fin !== cons ? 'bad' : ''}" style="background:${COL[fin]}">${fin}</span>` : '–'} <span class="dim">${J.an ? J.an.src[e] + (J.an.chg[e] ? ', ' + J.an.chg[e] + ' change(s)' : '') : ''}</span></span>
     ${fin && fin !== cons ? '<span class="err">annotator ≠ consensus</span>' : ''}</div>
   <div class="probs" title="YASA probabilities">${probs.map(([s, p]) => `<span style="width:${p * 100}%;background:${COL[s]};${s === 'W' || s === 'N1' ? 'color:#000' : ''}">${p >= 0.08 ? s + ' ' + p.toFixed(2) : ''}</span>`).join('')}</div>
   <div class="kv">${keys.map(k => `<span class="k">${k}</span><span class="v">${esc(typeof f[k] === 'number' ? (Number.isInteger(f[k]) ? f[k] : +f[k].toFixed(3)) : f[k] === '' ? '–' : f[k])}</span>`).join('')}</div>`;
}

/* ---- epoch list ---- */
function renderEpochList() {
  const el = $('#eplist'); if (!el) return; const N = J.N, MAX = 3000, list = J.sel.slice(0, MAX);
  el.innerHTML = list.map(e => { const y = N.yasa[e], f = J.final[e]; return `<div class="it ep" data-e="${e}"><span class="ts">e${e}</span><span>${labChip(N.cons[e])} ${labChip(y.yasa_stage)}<span class="dim mono"> ${fmt(y.confidence)}</span> ${f ? `<span class="lab ${f !== N.cons[e] ? 'bad' : ''}" style="background:${COL[f]}">${f}</span>` : ''} <span class="dim">${y.flagged ? 'flagged ' : ''}${J.an ? J.an.src[e] : ''} ${mmss(e * 30)}</span></span></div>`; }).join('') + (J.sel.length > MAX ? `<div class="note">… ${J.sel.length - MAX} more (refine filter)</div>` : '');
  el.onclick = ev => { const r = ev.target.closest('.ep'); if (r) selectEpoch(+r.dataset.e); }; J.epRow = null;
}
function markEpochList(scroll) {
  const el = $('#eplist'); if (!el || !J) return; if (J.epRow) J.epRow.classList.remove('cur');
  const r = el.querySelector(`[data-e="${J.epoch}"]`); J.epRow = r; if (r) { r.classList.add('cur'); if (scroll && !el.hidden) el.scrollTop = r.offsetTop - el.clientHeight / 3; }
}

/* ---- transcript / trajectory feed ---- */
function wordsHTML(e) {
  const tokRe = /\[[A-Z_]+\]/;
  if (e.words && e.words.length) return e.words.map(w => { const t = String(w.w); const cls = tokRe.test(t) ? 'red' : (w.p != null && w.p < 0.6 ? 'lowp' : ''); return `<span class="${cls}" title="p=${w.p} ${fmt(w.s)}–${fmt(w.e)}s">${esc(t)}</span>`; }).join(' ');
  return esc(e.text || '').replace(/\[[A-Z_]+\]/g, m => `<span class="red">${m}</span>`);
}
function itemHTML(it, i) {
  const e = it.e, ts = `<span class="ts">${mmss(it.t)}</span>`; let body = '', raw = '';
  switch (it.k) {
    case 'sess': body = e.type === 'session_start' ? `session start · ${esc(e.annotator)} ${esc(e.night)} #${e.session} · ${esc(e.asr_model || '')} · ui ${esc(e.ui_version || '')}` : `session end · ${esc(e.reason)} · ${e.n_labels} labels`; raw = e; break;
    case 'speech': {
      const bad = e.no_speech_prob > 0.6 || e.avg_logprob < -1;
      body = `<div class="txt"><span class="tag" style="background:var(--accent)">speech</span>${wordsHTML(e)}${bad ? '<span class="halluc" title="low avg_logprob or high no_speech_prob — possible ASR hallucination">low-conf ASR</span>' : ''}</div><div class="meta">logprob ${fmt(e.avg_logprob)} · no_speech ${fmt(e.no_speech_prob, 3)} · ${fmt(e.t_start, 1)}–${fmt(e.t_end, 1)}s${e.redactions && e.redactions.length ? ' · redactions: ' + esc(e.redactions.map(r => r.kind).join(',')) : ''}</div>`; raw = e; break;
    }
    case 'tool': {
      const t = e ? e.tool : '(result)', r = it.r;
      body = `<div><span class="tag" style="background:${TOOLCOL[t] || '#888'}">tool</span><span class="tn">${esc(t)}</span> <span class="args">${esc(JSON.stringify(e ? e.args : {}))}</span></div>` + (r ? `<div class="res"><span class="${r.ok === false ? 'err' : 'ok'}">${r.ok === false ? '✗' : '→'}</span> ${esc(JSON.stringify(r.result))}</div>` : ''); raw = [e, r].filter(Boolean); break;
    }
    case 'ui': body = `<span class="dim">ui ${esc(e.kind)} ${esc(e.channel || '')} ${e.duration_s ? e.duration_s + 's' : ''}${e.x_range_s ? ' x=' + e.x_range_s.join('–') : ''}</span>`; raw = e; break;
    case 'pause': body = `pause (${esc(e.reason)}) ${e.duration_s}s`; raw = e; break;
  }
  return `<div class="it ${it.k}" data-i="${i}" data-t="${it.t}">${ts}<div><button class="jb" title="raw JSON">{ }</button>${body}<pre>${esc(JSON.stringify(raw, null, 1))}</pre></div></div>`;
}
function buildFeed() {
  const f = $('#feed'), S = J.S; f.innerHTML = S.items.map(itemHTML).join('') || '<div class="note" style="padding:8px">No session events for this job.</div>';
  J.els = Array.from(f.children).filter(x => x.dataset.i != null); J.cur = null;
  f.onclick = ev => { const b = ev.target.closest('.jb'); const row = ev.target.closest('.it'); if (!row || !row.dataset.i) return; if (b) { row.classList.toggle('raw'); return; } seek(+row.dataset.t); };
  const used = new Set(S.items.map(i => i.k)); $('#tctl').querySelectorAll('input[data-k]').forEach(c => { c.disabled = false; });
  $('#tlLegend').innerHTML = '<span class="swatch" style="background:var(--accent)"></span>speech (amber = low-conf ASR) &nbsp; <span class="swatch" style="background:#8a5cf6"></span>break &nbsp; <span class="swatch" style="background:#888"></span>idle &nbsp; <span class="swatch" style="background:#59a14f"></span>dwell &nbsp; tools: ' + [...S.toolsSeen].map(t => `<span class="swatch" style="background:${TOOLCOL[t] || '#888'}"></span>${t}`).join(' ');
  filterFeed();
}
function filterFeed() {
  if (!J || !J.els) return; const on = {}; $('#tctl').querySelectorAll('input[data-k]').forEach(c => on[c.dataset.k] = c.checked); const q = $('#q').value.trim().toLowerCase(); let n = 0;
  J.S.items.forEach((it, i) => {
    let ok = it.k === 'sess' ? true : on[it.k]; if (ok && q) { const e = it.e; const hay = (it.k === 'speech' ? e.text : it.k === 'tool' ? JSON.stringify(it.e ? [it.e.tool, it.e.args] : '') + JSON.stringify(it.r ? it.r.result : '') : JSON.stringify(e)).toLowerCase(); ok = hay.includes(q); if (it.k === 'sess') ok = false; }
    J.els[i].hidden = !ok; if (ok) n++;
  }); $('#qcnt').textContent = q ? n + ' hits' : '';
}
function feedHighlight() {
  const S = J.S, its = S.items; if (!its.length) return; let lo = 0, hi = its.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (its[m].t <= J.t) { r = m; lo = m + 1; } else hi = m - 1; }
  while (r > 0 && J.els[r].hidden) r--; if (r < 0) return; const el = J.els[r]; if (el === J.cur) return;
  if (J.cur) J.cur.classList.remove('cur'); J.cur = el; el.classList.add('cur');
  const f = $('#feed'); if ($('#autoscroll').checked && !el.hidden) f.scrollTop = el.offsetTop - f.offsetTop - f.clientHeight / 3;
}
window.addEventListener('resize', () => { if (typeof RP !== 'undefined' && RP) { RP.sigKey = ''; rpRender(); } if (NV) drawNight(); if (J) { renderHyp(); renderTimeline(); renderSignal(true); } if (OV) drawSharedAll(); });

/* =========================================================
   Init
   ========================================================= */

/* =========================================================
   YASA uncertainty drawing helpers (shared by night page, overview, job view)
   ========================================================= */
const THR = () => (D.assign && D.assign.flag_threshold) || 0.6;
const PORDER = [['p_W', 'W'], ['p_R', 'R'], ['p_N1', 'N1'], ['p_N2', 'N2'], ['p_N3', 'N3']];
function drawHypnodensity(g, N, x0, y0, pw, h) {
  const ew = pw / N.ne;
  for (let e = 0; e < N.ne; e++) { let y = y0; const r = N.yasa[e]; for (const [k, s] of PORDER) { const hh = (r[k] || 0) * h; g.fillStyle = COL[s]; g.fillRect(x0 + e * ew, y, Math.max(ew, 1) + 0.3, hh + 0.3); y += hh; } }
}
// confidence line with threshold; flagged epochs filled from line up to threshold
function drawConf(g, N, x0, y0, pw, h, opts = {}) {
  const thr = THR(), lo = 0.2, Y = c => y0 + h - (Math.max(lo, Math.min(1, c)) - lo) / (1 - lo) * h, ew = pw / N.ne;
  g.fillStyle = COL.panel2; g.fillRect(x0, y0, pw, h);
  for (let e = 0; e < N.ne; e++) { const r = N.yasa[e]; if (!r.flagged) continue; const y = Y(r.confidence); g.fillStyle = 'rgba(217,142,4,.55)'; g.fillRect(x0 + e * ew, Math.min(y, Y(thr)), Math.max(ew, 1.2), Math.abs(Y(thr) - y) || 2); }
  // smoothed confidence (5-epoch mean) + raw
  g.strokeStyle = COL.dim; g.globalAlpha = 0.35; g.lineWidth = 0.7; g.beginPath();
  for (let e = 0; e < N.ne; e++) { const x = x0 + (e + 0.5) * ew, y = Y(N.yasa[e].confidence); e ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke(); g.globalAlpha = 1;
  g.strokeStyle = COL.fg; g.lineWidth = 1.3; g.beginPath();
  for (let e = 0; e < N.ne; e++) { let s = 0, c = 0; for (let k = Math.max(0, e - 2); k <= Math.min(N.ne - 1, e + 2); k++) { s += N.yasa[k].confidence; c++; } const x = x0 + (e + 0.5) * ew, y = Y(s / c); e ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke();
  g.setLineDash([4, 3]); g.strokeStyle = COL.bad; g.lineWidth = 1; g.beginPath(); g.moveTo(x0, Y(thr)); g.lineTo(x0 + pw, Y(thr)); g.stroke(); g.setLineDash([]);
  if (!opts.noAxis) { g.font = '8px sans-serif'; g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillStyle = COL.dim; g.fillText('1.0', x0 - 4, Y(1) + 4); g.fillStyle = COL.bad; g.fillText(thr.toFixed(2), x0 - 4, Y(thr)); g.fillStyle = COL.dim; g.fillText(lo.toFixed(1), x0 - 4, Y(lo) - 3); }
}
// flagged-epoch density per bin (default 10 min = 20 epochs)
function flagBins(N, bin = 20) { const out = []; for (let b = 0; b * bin < N.ne; b++) { let f = 0, n = 0; for (let e = b * bin; e < Math.min(N.ne, (b + 1) * bin); e++) { n++; if (N.yasa[e].flagged) f++; } out.push(f / n); } return out; }
function drawFlagBars(g, N, x0, y0, pw, h, bin = 20) {
  const bins = flagBins(N, bin), bw = pw * bin / N.ne;
  g.fillStyle = COL.panel2; g.fillRect(x0, y0, pw, h);
  bins.forEach((v, i) => { g.fillStyle = `rgba(217,142,4,${0.35 + 0.65 * Math.min(1, v / 0.6)})`; const hh = Math.min(1, v / 0.6) * h; g.fillRect(x0 + i * bw + 0.5, y0 + h - hh, Math.max(bw - 1, 1), hh); });
  g.strokeStyle = COL.line; g.lineWidth = 0.5; g.beginPath(); g.moveTo(x0, y0 + h * (1 - 0.3 / 0.6)); g.lineTo(x0 + pw, y0 + h * (1 - 0.3 / 0.6)); g.stroke();
}
function drawStageStrip(g, arr, ne, x0, y0, pw, h, cons) {
  const ew = pw / ne; g.fillStyle = COL.panel2; g.fillRect(x0, y0, pw, h);
  for (let e = 0; e < ne; e++) { const s = arr[e]; if (!s) continue; g.fillStyle = COL[s] || '#888'; g.fillRect(x0 + e * ew, y0, Math.max(ew, 1) + 0.3, h); }
  if (cons) for (let e = 0; e < ne; e++) if (arr[e] != null && arr[e] !== cons[e]) { g.fillStyle = COL.bad; g.fillRect(x0 + e * ew, y0 + h, Math.max(ew, 1.5), 3); }
}
function drawStepHyp(g, arr, ne, x0, y0, pw, h) {
  const lh = h / 6, ew = pw / ne; g.fillStyle = COL.panel2; g.fillRect(x0, y0, pw, h);
  g.font = '8px sans-serif'; g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillStyle = COL.dim;
  ['W', 'R', 'N1', 'N2', 'N3', 'DISC'].forEach((s, l) => g.fillText(s, x0 - 4, y0 + (l + 0.5) * lh));
  for (let e = 0; e < ne; e++) { const s = arr[e]; if (!s) continue; g.fillStyle = COL[s] || '#888'; g.fillRect(x0 + e * ew, y0 + LEVEL[s] * lh + 0.5, Math.max(ew, 1), lh - 1); }
}
function timeAxis(g, ne, x0, y0, pw, lights) {
  g.fillStyle = COL.dim; g.font = '9px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  const L = (lights || '00:00').split(':').map(Number);
  for (let hr = 0; hr * 120 <= ne; hr++) { const s = (L[0] * 3600 + L[1] * 60 + hr * 3600) % 86400; g.fillText(String(Math.floor(s / 3600)).padStart(2, '0') + ':' + String(Math.floor(s % 3600 / 60)).padStart(2, '0'), Math.min(x0 + hr * 120 / ne * pw, x0 + pw - 12), y0 + 6); }
}
function nightStats(N) {
  const ne = N.ne, fl = []; let ycorr = 0, yn = 0, fcorr = 0, ucorr = 0, un = 0;
  for (let e = 0; e < ne; e++) { if (N.cons[e] === 'DISC') continue; yn++; const ok = N.ystage[e] === N.cons[e]; ycorr += ok; if (N.yasa[e].flagged) { fl.push(e); fcorr += ok; } else { un++; ucorr += ok; } }
  const cause = {transition: 0, artifact: 0, arousal: 0, 'N1 (no other cause)': 0, other: 0}, byStage = {};
  for (const s of ['W', 'N1', 'N2', 'N3', 'R']) byStage[s] = {n: 0, f: 0};
  for (let e = 0; e < ne; e++) { const s = N.cons[e]; if (byStage[s]) { byStage[s].n++; if (N.yasa[e].flagged) byStage[s].f++; } }
  for (const e of fl) {
    const f = N.feat[e] || {}, tr = (e > 0 && N.cons[e - 1] !== N.cons[e]) || (e < ne - 1 && N.cons[e + 1] !== N.cons[e]);
    if (f.artifact && f.artifact !== 'none') cause.artifact++; else if (tr) cause.transition++; else if (f.arousal) cause.arousal++; else if (N.cons[e] === 'N1') cause['N1 (no other cause)']++; else cause.other++;
  }
  return {nflag: fl.length, pct: fl.length / ne, yasaAcc: ycorr / yn, yasaAccFlag: fl.length ? fcorr / fl.length : NaN, yasaAccUnflag: un ? ucorr / un : NaN, meanConf: mean(N.yasa.map(r => r.confidence)), cause, byStage, kY: kappa(N.ystage, N.cons)};
}
function nightPct(n) { const m = D.nights[n]; return m && m.n_epochs ? m.n_flagged / m.n_epochs : 0; }

/* =========================================================
   Night page: YASA uncertainty profile + all annotators of that night
   ========================================================= */
let NV = null;
async function openNight(n) {
  J = null; OV = null; const tok = ++jobToken, main = $('#main');
  main.innerHTML = '<div class="card">Loading night…</div>';
  const N = await loadNight(n), jobs = D.index.filter(j => j.night === n).sort((x, y) => x.annotator < y.annotator ? -1 : 1);
  const A = {}; await Promise.all(jobs.map(async j => A[j.annotator] = await loadAnn(j.annotator, n)));
  if (tok !== jobToken) return;
  const st = nightStats(N), m = N.meta, raters = jobs.filter(j => A[j.annotator]);
  NV = {n, N, jobs, A, st};
  const fk = raters.length > 2 ? fleiss(raters.map(j => A[j.annotator].fin)) : NaN;
  const pct = x => isNaN(x) ? '–' : (100 * x).toFixed(1) + '%';
  const causeRows = Object.entries(st.cause).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td><td>${pct(v / Math.max(st.nflag, 1))}</td><td><span class="bar" style="width:${Math.round(120 * v / Math.max(st.nflag, 1))}px"></span></td></tr>`).join('');
  const stageRows = Object.entries(st.byStage).map(([s, o]) => `<tr><td>${labChip(s)}</td><td>${o.n}</td><td>${o.f}</td><td>${pct(o.f / Math.max(o.n, 1))}</td><td><span class="bar" style="width:${Math.round(120 * o.f / Math.max(o.n, 1))}px"></span></td></tr>`).join('');
  const annRows = jobs.map(j => { const p = D.annotators[j.annotator] || {}; return `<tr class="click" data-h="#/job/${j.annotator}/${n}"><td><b>${j.annotator}</b> <span class="dim">${esc(p.role || '')}</span></td><td>${fmt(j.kappa_vs_consensus)}</td><td>${fmt(j.acc_flagged)}</td><td>${fmt(j.acc_all)}</td><td>${j.n_labels ?? '–'}</td><td>${mmss(j.duration_s)}</td><td>${(j.sessions || []).length}</td><td><a href="#/replay/${j.annotator}/${n}">▶ replay</a> · <a href="#/job/${j.annotator}/${n}">trajectory →</a></td></tr>`; }).join('');
  main.innerHTML = `
  <div class="card"><h3><span><b>${n}</b>${m.role === 'shared' ? '<span class="badge">shared · all annotators</span>' : ''}</span>
   <span class="dim" style="font-weight:400;text-transform:none">${N.ne} epochs · ${m.hours ?? ''} h · lights-off ${m.lights_off ?? '?'} · ${m.ahi_group ?? ''}</span></h3>
   <div class="kpis">
    <div><div class="kv1">${st.nflag}</div><div class="dim">flagged epochs</div></div>
    <div><div class="kv1">${pct(st.pct)}</div><div class="dim">of the night flagged</div></div>
    <div><div class="kv1">${fmt(st.meanConf)}</div><div class="dim">mean YASA confidence</div></div>
    <div><div class="kv1">${pct(st.yasaAccFlag)}</div><div class="dim">YASA correct on flagged</div></div>
    <div><div class="kv1">${pct(st.yasaAccUnflag)}</div><div class="dim">YASA correct on unflagged</div></div>
    <div><div class="kv1">${fmt(st.kY)}</div><div class="dim">YASA κ vs consensus</div></div>
    ${raters.length > 2 ? `<div><div class="kv1">${fmt(fk)}</div><div class="dim">Fleiss κ (${raters.length} annotators)</div></div>` : ''}
   </div></div>
  <div class="card"><h3>YASA uncertainty profile</h3><canvas id="nprof"></canvas>
   <div class="note">From top: <b>consensus</b> hypnogram (BOAS stage_hum) · <b>YASA hypnodensity</b> (per-epoch stage probabilities, stacked W/R/N1/N2/N3) · <b>YASA confidence</b> (black = 5-epoch mean, grey = raw; dashed red = flag threshold ${THR().toFixed(2)}; amber fill = flagged epochs, which the annotators had to score) · <b>flagged share per 10 min</b> (scale 0–60%, grid line = 30%). Hover for details.</div></div>
  <div class="card"><h3>Annotators on this night <span class="dim" style="font-weight:400;text-transform:none">click a row or strip to open the trajectory</span></h3><canvas id="nann"></canvas>
   <div class="note">Each strip is the annotator's final labels; red ticks underneath = differs from consensus. Bottom row: share of annotators disagreeing with consensus.</div>
   <div style="overflow:auto;margin-top:6px"><table class="t"><thead><tr><th>annotator</th><th>κ vs cons</th><th>acc flagged</th><th>acc all</th><th>labels</th><th>time</th><th>sessions</th><th></th></tr></thead><tbody>${annRows}</tbody></table></div></div>
  <div class="grid2">
   <div class="card"><h3>Why epochs were flagged</h3><table class="t"><thead><tr><th>likely cause</th><th>n</th><th>share</th><th></th></tr></thead><tbody>${causeRows}</tbody></table>
    <div class="note">Assigned in order: artifact → stage transition (consensus changes at an adjacent epoch) → arousal → N1 → other.</div></div>
   <div class="card"><h3>Flag rate by consensus stage</h3><table class="t"><thead><tr><th>stage</th><th>epochs</th><th>flagged</th><th>rate</th><th></th></tr></thead><tbody>${stageRows}</tbody></table></div>
  </div>`;
  main.querySelectorAll('tr.click').forEach(r => r.onclick = ev => { if (ev.target.tagName !== 'A') location.hash = r.dataset.h; });
  NV.redraw = drawNight; drawNight();
}
function drawNight() {
  if (!NV) return; const {N, jobs, A, n} = NV, m = N.meta;
  // profile
  { const c = $('#nprof'); if (!c) return; const gx = 74, rows = [['consensus', 48], ['YASA hypnodensity', 40], ['YASA confidence', 64], ['flagged / 10 min', 30]];
    const H = rows.reduce((s, r) => s + r[1] + 16, 0) + 18, {g, w} = fit(c, H), pw = w - gx - 8; let y = 2;
    rows.forEach(([name, h], i) => {
      g.fillStyle = COL.dim; g.font = 'bold 10px sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(name, gx, y + 6); y += 13;
      if (i === 0) drawStepHyp(g, N.cons, N.ne, gx, y, pw, h); else if (i === 1) drawHypnodensity(g, N, gx, y, pw, h); else if (i === 2) drawConf(g, N, gx, y, pw, h); else { drawFlagBars(g, N, gx, y, pw, h); g.font = '8px sans-serif'; g.textAlign = 'right'; g.fillStyle = COL.dim; g.fillText('≥60%', gx - 4, y + 3); g.fillText('0', gx - 4, y + h - 3); }
      y += h + 3;
    });
    timeAxis(g, N.ne, gx, y, pw, m.lights_off);
    const bins = flagBins(N);
    c.onmousemove = ev => { const b = c.getBoundingClientRect(), e = Math.floor((ev.clientX - b.left - gx) / pw * N.ne); if (e < 0 || e >= N.ne) return hideTip(); const r = N.yasa[e], f = N.feat[e] || {};
      showTip(ev, `epoch ${e}  ${mmss(e * 30)}\nconsensus  ${N.cons[e]}\nYASA       ${r.yasa_stage}  conf ${fmt(r.confidence)}${r.flagged ? '  FLAGGED' : ''}\n` + PORDER.map(([k, s]) => `  p(${s}) ${fmt(r[k])}`).join('\n') + `\nartifact ${f.artifact || '–'}${f.arousal ? ' · arousal' : ''}\n10-min bin flagged: ${(100 * bins[Math.floor(e / 20)]).toFixed(0)}%`); };
    c.onmouseleave = hideTip;
  }
  // annotators
  { const c = $('#nann'); const gx = 74, sh = 16, gap = 9, rows = jobs.filter(j => A[j.annotator]);
    const H = (rows.length + 2) * (sh + gap) + 34, {g, w} = fit(c, H), pw = w - gx - 8; let y = 2;
    const strip = (label, arr, cons) => { g.fillStyle = COL.fg; g.font = '10px sans-serif'; g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText(label, gx - 6, y + sh / 2); drawStageStrip(g, arr, N.ne, gx, y, pw, sh, cons); y += sh + gap; };
    strip('consensus', N.cons); strip('YASA', N.ystage, N.cons);
    const y0 = y; rows.forEach(j => strip(j.annotator, A[j.annotator].fin, N.cons));
    g.fillStyle = COL.dim; g.textAlign = 'right'; g.fillText('≠ cons', gx - 6, y + 5);
    for (let e = 0; e < N.ne; e++) { let d = 0; rows.forEach(j => { if (A[j.annotator].fin[e] !== N.cons[e]) d++; }); if (d) { g.fillStyle = `rgba(209,56,74,${0.2 + 0.8 * d / rows.length})`; g.fillRect(gx + e * pw / N.ne, y, Math.max(pw / N.ne, 1.5), 10); } }
    timeAxis(g, N.ne, gx, y + 12, pw, m.lights_off);
    const at = ev => { const b = c.getBoundingClientRect(), e = Math.floor((ev.clientX - b.left - gx) / pw * N.ne), r = Math.floor((ev.clientY - b.top - y0) / (sh + gap)); return {e, j: rows[r]}; };
    c.onmousemove = ev => { const {e} = at(ev); if (e < 0 || e >= N.ne) return hideTip(); showTip(ev, `epoch ${e}  ${mmss(e * 30)}${N.yasa[e].flagged ? '  FLAGGED' : ''}\nconsensus  ${N.cons[e]}\nYASA       ${N.ystage[e]} (${fmt(N.yasa[e].confidence)})\n` + rows.map(j => j.annotator.padEnd(10) + A[j.annotator].fin[e] + (A[j.annotator].fin[e] !== N.cons[e] ? '  ✗' : '')).join('\n')); };
    c.onclick = ev => { const {e, j} = at(ev); if (j && e >= 0) location.hash = `#/job/${j.annotator}/${n}?e=${e}`; };
    c.onmouseleave = hideTip; c.style.cursor = 'pointer';
  }
}

/* ---- overview: nights ranked by YASA uncertainty ---- */
function nightsCardHTML() {
  return `<div class="card"><h3>Nights — how much did YASA leave to the annotators? <span class="spacer"></span><label>sort <select id="nsort"><option value="pct">most flagged first</option><option value="id">night id</option></select></label></h3>
   <div id="nlist"></div><div class="note">Bars: flagged share per 10-min bin across the night (full height = ≥60% of the bin flagged). Click a night to open its page.</div></div>`;
}
function drawNightsList() {
  const el = $('#nlist'); if (!el || !OV) return; const sort = ($('#nsort') || {}).value || 'pct';
  const ns = Object.keys(OV.N).sort((a, b) => sort === 'pct' ? nightPct(b) - nightPct(a) : (+a.slice(4)) - (+b.slice(4)));
  el.innerHTML = `<table class="t"><thead><tr><th>night</th><th>annotators</th><th>flagged</th><th>%</th><th>YASA κ</th><th>YASA acc on flagged</th><th>mean ann κ</th><th style="width:45%;text-align:left">flagged share across the night</th></tr></thead><tbody>${ns.map(n => {
    const N = OV.N[n], st = nightStats(N), js = D.index.filter(j => j.night === n);
    return `<tr class="click" data-n="${n}"><td><b>${n}</b>${N.meta.role === 'shared' ? '<span class="badge">shared</span>' : ''}</td><td>${js.map(j => j.annotator.replace('ann-', '')).join(', ')}</td><td>${st.nflag}</td><td>${(100 * st.pct).toFixed(1)}</td><td>${fmt(st.kY)}</td><td>${(100 * st.yasaAccFlag).toFixed(0)}%</td><td>${fmt(mean(js.map(j => j.kappa_vs_consensus)))}</td><td style="text-align:left"><canvas class="spark" data-n="${n}"></canvas></td></tr>`; }).join('')}</tbody></table>`;
  el.querySelectorAll('tr.click').forEach(r => r.onclick = () => location.hash = '#/night/' + r.dataset.n);
  el.querySelectorAll('canvas.spark').forEach(c => { const N = OV.N[c.dataset.n], {g, w, h} = fit(c, 18); drawFlagBars(g, N, 0, 0, w, h); });
}

async function init() {
  $('#stageLegend').innerHTML = STAGES.map(s => `<span class="chip" style="background:${COL[s]};${s === 'W' || s === 'N1' ? 'color:#000' : ''}">${s}</span>`).join('');
  $('#srcinfo').textContent = FIX ? '· source: viewer/fixture (?fixture=1)' : '· source: data/study';
  let idx = await fetchJSON(STUDY + 'index.json');
  if (idx && !Array.isArray(idx)) idx = idx.jobs || idx.index || Object.values(idx);
  if (!idx || !idx.length) {
    $('#main').innerHTML = `<div class="card"><b>No ${STUDY}index.json found.</b><p>The study outputs may not have been generated yet. Run <code>python3 scripts/gen_trajectories.py</code>, or load the hand-written fixture: <a href="?fixture=1">?fixture=1</a>.</p></div>`; return;
  }
  D.index = idx; const an = await fetchJSON(STUDY + 'annotators.json'); let ann = an;
  if (Array.isArray(an)) { ann = {}; an.forEach(a => ann[a.id] = a); } else if (an && an.annotators) { ann = Array.isArray(an.annotators) ? Object.fromEntries(an.annotators.map(a => [a.id, a])) : an.annotators; }
  D.annotators = ann || {}; D.assign = await fetchJSON('../data/study/assignment.json');
  const nj = await fetchJSON(DS + 'nights.json') || []; nj.forEach(n => D.nights[n.night] = n);
  route();
}
init();

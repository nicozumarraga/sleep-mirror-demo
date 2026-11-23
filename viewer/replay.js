/* Session replay: a simulated VACP annotation interface driven by one session's event log.
   Shares globals with app.js (loaded first). Route: #/replay/<ann>/<night>?s=<sessionIdx>&t=<sec> */
'use strict';
let RP = null;
const RP_SPEEDS = [1, 2, 5, 10, 30];
const ZOOMS = [10, 30, 120, 300];
const TOOL_LABEL = {goto_epoch: 'Go to epoch', next_flagged: 'Next flagged', pan: 'Pan', zoom: 'Zoom', toggle_channel: 'Channel', set_scale: 'Scale', apply_filter: 'Filter', measure: 'Measure', show_hypnogram: 'Hypnogram', show_spectrogram: 'Spectrogram', set_label: 'Label', mark_event: 'Mark event', add_comment: 'Comment', undo: 'Undo'};

function rpStop() { if (RP) { cancelAnimationFrame(RP.raf); RP.playing = false; } }

async function openReplay(a, n, qs) {
  J = null; OV = null; NV = null; rpStop();
  const tok = ++jobToken, main = $('#main');
  main.innerHTML = '<div class="card">Loading session…</div>';
  const job = D.index.find(j => j.annotator === a && j.night === n);
  if (!job || !(job.sessions || []).length) { main.innerHTML = `<div class="card">No sessions for ${a} / ${n}.</div>`; return; }
  const si = Math.min(+(qs.get('s') || 0), job.sessions.length - 1);
  const [N, ev] = await Promise.all([loadNight(n), loadSession(job.sessions[si])]);
  if (tok !== jobToken) return;
  // labels before this session: YASA + all set_labels of earlier sessions
  const base = N.ystage.slice();
  for (let k = 0; k < si; k++) applyLabels(base, await loadSession(job.sessions[k]), Infinity);
  if (tok !== jobToken) return;
  RP = {a, n, job, si, N, ev, base, t: +(qs.get('t') || 0), playing: false, speed: 5, compress: true, raf: 0, last: 0, sigKey: '', persona: D.annotators[a] || {}};
  rpPrepare();
  rpBuildDOM();
  rpSeek(RP.t);
}

/* ---------- preprocessing ---------- */
function applyLabels(arr, ev, tmax) {
  const calls = {}; ev.forEach(e => { if (e.type === 'tool_call') calls[e.call_id] = e; });
  const res = {}; ev.forEach(e => { if (e.type === 'tool_result') res[e.call_id] = e; });
  for (const e of ev) {
    if (e.t > tmax) break;
    if (e.type === 'tool_call' && e.tool === 'set_label') arr[e.args.epoch] = e.args.stage;
    if (e.type === 'tool_result' && e.result && e.result.undone_call_id) { const c = calls[e.result.undone_call_id], r = res[e.result.undone_call_id]; if (c && c.tool === 'set_label' && r && r.result) arr[c.args.epoch] = r.result.prev_stage; }
  }
}
function rpPrepare() {
  const R = RP, ev = R.ev, S = buildSession(ev); R.S = S; // reuse viewport timeline from app.js
  R.tmax = S.tmax;
  const res = {}; ev.forEach(e => { if (e.type === 'tool_result') res[e.call_id] = e; });
  R.res = res;
  R.calls = ev.filter(e => e.type === 'tool_call');
  R.speech = ev.filter(e => e.type === 'transcript').map(e => {
    const a = e.t_start ?? e.t, b = e.t_end ?? a + 2; let w = e.words || [];
    if (w.length && w[0].s < a - 1) w = w.map(x => ({...x, s: x.s + a, e: x.e + a}));
    return {a, b, e, w};
  });
  R.pauses = ev.filter(e => e.type === 'pause').map(e => ({a: e.t, b: e.t + (e.duration_s || 0), e}));
  R.labelEv = []; // timeline of label changes in this session
  const calls = {}; R.calls.forEach(c => calls[c.call_id] = c);
  for (const e of ev) {
    if (e.type === 'tool_call' && e.tool === 'set_label') R.labelEv.push({t: e.t, ep: e.args.epoch, st: e.args.stage});
    if (e.type === 'tool_result' && e.result && e.result.undone_call_id) { const c = calls[e.result.undone_call_id], r = res[e.result.undone_call_id]; if (c && c.tool === 'set_label' && r && r.result) R.labelEv.push({t: e.t, ep: c.args.epoch, st: r.result.prev_stage, undo: true}); }
  }
  R.flagged = R.N.yasa.map(y => !!y.flagged);
  // persistent overlays
  R.marks = R.calls.filter(c => c.tool === 'mark_event');
  R.filters = R.calls.filter(c => c.tool === 'apply_filter');
  R.spec = R.calls.filter(c => c.tool === 'show_spectrogram');
  // cursor keyframes
  const K = [];
  for (const e of ev) {
    if (e.type === 'tool_call') K.push({t: e.t, tgt: rpToolTarget(e), click: true});
    else if (e.type === 'ui' && e.kind === 'dwell') { const xr = e.x_range_s || [0, 30], d = e.duration_s || 1, r = rng(hash('d' + e.seq)); for (let k = 0; k < 3; k++) K.push({t: e.t + k * d / 3, tgt: {sig: true, xs: xr[0] + (0.2 + 0.6 * r()) * (xr[1] - xr[0]), ch: e.channel, dy: r() - 0.5}}); }
    else if (e.type === 'ui' && e.kind === 'mouse_path') (e.points || []).forEach(p => K.push({t: p[0], tgt: {sig: true, xs: p[1], lane: p[2], dy: 0}, fast: true}));
    else if (e.type === 'ui' && e.kind === 'scroll') K.push({t: e.t, tgt: {sig: true, xs: null, dy: 0}});
  }
  K.sort((x, y) => x.t - y.t); R.K = K;
  // density for scrubber
  R.dens = new Float32Array(400); for (const e of ev) if (e.type === 'tool_call' || e.type === 'transcript') R.dens[Math.min(399, Math.floor(e.t / R.tmax * 400))]++;
}
function rpToolTarget(e) {
  const a = e.args || {};
  switch (e.tool) {
    case 'zoom': return {id: 'rz-' + (ZOOMS.includes(a.window_s) ? a.window_s : 30)};
    case 'pan': return {id: 'rp-' + (a.direction === 'left' ? 'l' : 'r')};
    case 'toggle_channel': return {id: 'rc-' + a.channel};
    case 'set_label': return {id: 'rl-' + a.stage};
    case 'measure': return {sig: true, xs: ((a.t0_s || 0) + (a.t1_s || 0)) / 2, ch: a.channel, dy: 0};
    case 'mark_event': return {sig: true, xs: (a.onset_s || 0) + (a.duration_s || 0) / 2, ch: a.channel, dy: 0.3};
    default: return {id: 'rt-' + e.tool};
  }
}

/* ---------- DOM ---------- */
function rpBuildDOM() {
  const R = RP, p = R.persona, m = R.N.meta;
  const tbtn = (id, txt, title) => `<button class="rtb" id="${id}" title="${title || ''}">${txt}</button>`;
  $('#main').innerHTML = `
  <div class="rp-bar card">
    <a href="#/night/${R.n}">${R.n}</a> › <a href="#/job/${R.a}/${R.n}">${R.a}</a> › <b>session replay</b>
    <select id="rpSess">${R.job.sessions.map((s, i) => `<option value="${i}" ${i === R.si ? 'selected' : ''}>session ${i + 1}</option>`).join('')}</select>
    <button id="rpPlay">▶ play</button>
    <span class="dim">speed</span><select id="rpSpeed">${RP_SPEEDS.map(s => `<option value="${s}" ${s === R.speed ? 'selected' : ''}>${s}×</option>`).join('')}</select>
    <label title="fast-forward through silence and breaks"><input type="checkbox" id="rpCompress" checked> skip idle</label>
    <button id="rpPrevL" title="previous label decision">⏮ label</button><button id="rpNextL" title="next label decision">label ⏭</button>
    <span class="mono" id="rpClock"></span><span class="spacer"></span>
    <span class="dim">${esc(p.role || '')} · ${esc(p.native_language || '')} · ${p.years_exp ?? '?'} y</span>
  </div>
  <canvas id="rpScrub" class="rp-scrub"></canvas>
  <div class="rp-wrap">
   <div class="rp-app" id="rpApp">
    <div class="rp-title"><span class="dots"><i></i><i></i><i></i></span><b>VACP · Sleep Scorer</b><span class="dim">${R.n} · ${R.N.ne} epochs · ${m.ahi_group || ''}</span><span class="spacer"></span>
      <span class="dim" id="rpProg"></span><span class="rec" id="rpRec">● REC</span><span class="mono dim" id="rpWall"></span></div>
    <div class="rp-nav"><canvas id="rpNav"></canvas></div>
    <div class="rp-body">
     <div class="rp-tools">
      <div class="grp">Navigate</div>${tbtn('rt-goto_epoch', '⌖ Go to')}${tbtn('rt-next_flagged', '⚑ Next flagged')}<div class="row">${tbtn('rp-l', '◀')}${tbtn('rp-r', '▶')}</div>
      <div class="grp">Window</div><div class="row">${ZOOMS.map(z => tbtn('rz-' + z, z < 60 ? z + 's' : z / 60 + 'm')).join('')}</div>
      <div class="grp">Inspect</div>${tbtn('rt-measure', '📏 Measure')}${tbtn('rt-apply_filter', '∿ Filter')}${tbtn('rt-set_scale', '↕ Scale')}${tbtn('rt-show_spectrogram', '▦ Spectrogram')}${tbtn('rt-show_hypnogram', '▤ Hypnogram')}
      <div class="grp">Annotate</div>${tbtn('rt-mark_event', '✚ Mark event')}${tbtn('rt-add_comment', '💬 Comment')}${tbtn('rt-undo', '↶ Undo')}
      <div class="grp">Channels</div><div id="rpCh">${ALLCH.map(c => `<label class="rch" id="rc-${c}"><input type="checkbox" disabled> ${SHORT(c)}</label>`).join('')}</div>
     </div>
     <div class="rp-main">
      <div class="rp-sigwrap"><canvas id="rpSig"></canvas><canvas id="rpOver"></canvas><div class="rp-toast" id="rpToast"></div><div class="rp-sub" id="rpSub"></div><div class="rp-pause" id="rpPause" hidden></div></div>
      <div class="rp-spec" id="rpSpecWrap" hidden><canvas id="rpSpec"></canvas></div>
      <div class="rp-labels"><span class="dim" id="rpEp"></span>${['W', 'N1', 'N2', 'N3', 'R', 'DISC'].map(s => `<button class="rlb" id="rl-${s}" style="--c:var(--c-${s})">${s}</button>`).join('')}
        <span class="rp-probs" id="rpProbs"></span><div class="rp-comment" id="rpComment" hidden></div></div>
     </div>
    </div>
    <div class="cursor" id="rpCur"><svg width="18" height="22" viewBox="0 0 18 22"><path d="M1 1 L1 17 L5 13 L8 20 L11 19 L8 12 L14 12 Z" fill="#fff" stroke="#000" stroke-width="1.3"/></svg><span class="ripple" id="rpRip"></span></div>
   </div>
   <div class="rp-chat card"><h3>Think-aloud · Whisper transcript <span class="spacer"></span><label><input type="checkbox" id="rpShowTools" checked> actions</label></h3><div id="rpFeed"></div></div>
  </div>
  <div class="note">Simulated interface. The signal is synthesized from epoch_features (not real EEG). Cursor positions are reconstructed from logged dwell/mouse_path events and tool-call targets. Top strip: working hypnogram (YASA labels, replaced by the annotator's labels as they are set; ⚑ = flagged, ✓ = done).</div>`;
  $('#rpPlay').onclick = () => R.playing ? rpPause() : rpPlay();
  $('#rpSpeed').onchange = e => R.speed = +e.target.value;
  $('#rpCompress').onchange = e => R.compress = e.target.checked;
  $('#rpSess').onchange = e => { location.hash = `#/replay/${R.a}/${R.n}?s=${e.target.value}`; };
  $('#rpShowTools').onchange = () => { R.feedN = -1; rpFeed(true); };
  $('#rpPrevL').onclick = () => { const l = [...R.labelEv].reverse().find(x => x.t < R.t - 0.5); if (l) rpSeek(Math.max(0, l.t - 6)); };
  $('#rpNextL').onclick = () => { const l = R.labelEv.find(x => x.t > R.t + 6.5); if (l) rpSeek(Math.max(0, l.t - 6)); };
  const sc = $('#rpScrub'); let drag = false;
  const sk = ev => { const b = sc.getBoundingClientRect(); rpSeek(Math.max(0, Math.min(1, (ev.clientX - b.left) / b.width)) * R.tmax); };
  sc.onmousedown = ev => { drag = true; sk(ev); }; window.onmousemove = ev => { if (drag && RP) sk(ev); }; window.onmouseup = () => drag = false;
  $('#rpNav').onclick = ev => { const c = $('#rpNav'), b = c.getBoundingClientRect(), e = Math.floor((ev.clientX - b.left - 4) / (b.width - 8) * R.N.ne), S = R.S; if (S.first.has(e)) rpSeek(S.first.get(e)); };
  R.feedN = -1;
}

/* ---------- playback ---------- */
function rpPlay() { const R = RP; if (R.t >= R.tmax - 0.1) R.t = 0; R.playing = true; R.last = performance.now(); $('#rpPlay').textContent = '❚❚ pause'; $('#rpPlay').classList.add('on'); R.raf = requestAnimationFrame(rpTick); }
function rpPause() { const R = RP; R.playing = false; cancelAnimationFrame(R.raf); $('#rpPlay').textContent = '▶ play'; $('#rpPlay').classList.remove('on'); rpRender(); }
function rpIdle(t) { // true when nothing is happening around t
  const R = RP; if (R.speech.some(s => s.a - 0.3 <= t && t <= s.b + 0.3)) return false;
  return !R.ev.some(e => e.type !== 'ui' && e.type !== 'transcript' && Math.abs(e.t - t) < 1.2);
}
function rpTick(now) {
  const R = RP; if (!R || !R.playing) return;
  const dt = Math.min(0.1, (now - R.last) / 1000); R.last = now;
  let sp = R.speed; const inPause = R.pauses.find(p => p.a <= R.t && R.t < p.b);
  if (R.compress && inPause) sp = Math.max(sp, (inPause.b - inPause.a) / 2.5); // breaks collapse to ~2.5 s
  else if (R.compress && rpIdle(R.t)) sp *= 4;
  R.t += dt * sp;
  if (R.t >= R.tmax) { R.t = R.tmax; rpPause(); }
  rpRender(); if (R.playing) R.raf = requestAnimationFrame(rpTick);
}
function rpSeek(t) { RP.t = Math.max(0, Math.min(RP.tmax, t)); RP.feedN = -1; rpRender(); }

/* ---------- render ---------- */
function rpVp(t) { const v = RP.S.vps; if (!v.length) return {start_epoch: 0, window_s: 30, channels: DEFCH.slice(), scale_uv: 100}; let lo = 0, hi = v.length - 1, r = 0; while (lo <= hi) { const m = (lo + hi) >> 1; if (v[m].t <= t) { r = m; lo = m + 1; } else hi = m - 1; } return v[r].vp; }
function rpLabels(t) { const L = RP.base.slice(); for (const l of RP.labelEv) { if (l.t > t) break; L[l.ep] = l.st; } return L; }
function rpRender() {
  const R = RP; if (!R || !$('#rpApp')) return; const t = R.t, vp = rpVp(t);
  R.vp = vp; R.labels = rpLabels(t);
  const nd = R.labelEv.filter(l => l.t <= t).length;
  // header
  $('#rpClock').textContent = `${mmss(t)} / ${mmss(R.tmax)}`;
  const st = R.ev[0] && R.ev[0].wall ? new Date(Date.parse(R.ev[0].wall) + t * 1000) : null;
  $('#rpWall').textContent = st ? st.toISOString().slice(11, 19) + ' UTC' : '';
  const speaking = R.speech.find(s => s.a <= t && t <= s.b);
  $('#rpRec').classList.toggle('live', !!speaking);
  // pause overlay
  const ps = R.pauses.find(p => p.a <= t && t < p.b), po = $('#rpPause');
  po.hidden = !ps; if (ps) po.innerHTML = `<div>${ps.e.reason === 'break' ? '☕ Break' : '… idle'}</div><div class="dim">${mmss(t - ps.a)} / ${mmss(ps.b - ps.a)}</div>`;
  // tool highlight + toast
  document.querySelectorAll('#rpApp .hot').forEach(x => x.classList.remove('hot'));
  const recent = R.calls.filter(c => c.t <= t && t - c.t < 1.6);
  recent.forEach(c => { const tg = rpToolTarget(c); if (tg.id) { const el = document.getElementById(tg.id); if (el) el.classList.add('hot'); } });
  const lc = recent[recent.length - 1], toast = $('#rpToast');
  if (lc) { const r = R.res[lc.call_id]; toast.hidden = false; toast.innerHTML = `<b>${TOOL_LABEL[lc.tool] || lc.tool}</b> <span class="mono">${esc(JSON.stringify(lc.args || {}))}</span>${r && r.result && !r.result.viewport ? ` → <span class="mono">${esc(JSON.stringify(r.result))}</span>` : ''}`; } else toast.hidden = true;
  // channel checkboxes + zoom state
  ALLCH.forEach(c => { const el = document.getElementById('rc-' + c); el.classList.toggle('on', vp.channels.includes(c)); el.firstChild.checked = vp.channels.includes(c); });
  ZOOMS.forEach(z => document.getElementById('rz-' + z).classList.toggle('sel', vp.window_s === z));
  // spectrogram visibility
  const spOn = (() => { let on = false; for (const c of R.spec) { if (c.t > t) break; on = c.args.visible !== false; } return on; })();
  $('#rpSpecWrap').hidden = !spOn;
  // epoch + label bar
  const ep = Math.max(0, Math.min(R.N.ne - 1, Math.floor(vp.start_epoch + (vp.window_s > 30 ? 0 : 0))));
  const focus = vp.window_s > 30 ? Math.min(R.N.ne - 1, ep) : ep; R.focus = focus;
  const cur = R.labels[focus], human = cur !== R.N.ystage[focus] || R.labelEv.some(l => l.ep === focus && l.t <= t);
  $('#rpEp').innerHTML = `epoch <b>${focus}</b> ${R.flagged[focus] ? '<span class="flag">⚑ flagged</span>' : ''} · current <b>${cur}</b> <span class="dim">(${human ? 'annotator' : 'YASA'})</span>`;
  ['W', 'N1', 'N2', 'N3', 'R', 'DISC'].forEach(s => document.getElementById('rl-' + s).classList.toggle('cur', s === cur));
  const y = R.N.yasa[focus]; $('#rpProbs').innerHTML = 'YASA ' + PORDER.map(([k, s]) => `<span style="background:${COL[s]};width:${Math.round((y[k] || 0) * 120)}px" title="${s} ${fmt(y[k])}"></span>`).join('') + ` <span class="dim">${fmt(y.confidence)}</span>`;
  // comment popup
  const cm = R.calls.filter(c => c.tool === 'add_comment' && c.t <= t && t - c.t < 4).pop(), cel = $('#rpComment');
  cel.hidden = !cm; if (cm) cel.textContent = '💬 ' + (cm.args.text || '');
  $('#rpProg').textContent = `${nd} label actions`;
  // canvases
  rpNav(t); rpSig(); rpOver(t); if (spOn) rpSpec(); rpScrub(t); rpCursor(t); rpSubtitle(t, speaking); rpFeed(false);
}
function rpNav(t) {
  const R = RP, c = $('#rpNav'), {g, w, h} = fit(c, 46), N = R.N, x0 = 4, pw = w - 8, ew = pw / N.ne, L = R.labels;
  g.fillStyle = COL.panel2; g.fillRect(x0, 0, pw, 30);
  for (let e = 0; e < N.ne; e++) { const s = L[e]; g.fillStyle = COL[s] || '#888'; g.fillRect(x0 + e * ew, 2 + LEVEL[s] * 4.4, Math.max(ew, 1), 4); }
  const done = new Set(R.labelEv.filter(l => l.t <= t).map(l => l.ep));
  for (let e = 0; e < N.ne; e++) { if (!R.flagged[e]) continue; g.fillStyle = done.has(e) || R.base[e] !== N.ystage[e] ? COL.N2 : COL.warn; g.fillRect(x0 + e * ew, 33, Math.max(ew, 1.2), 5); }
  const vp = R.vp, vx = x0 + vp.start_epoch * ew, vw = Math.max(3, vp.window_s / 30 * ew);
  g.strokeStyle = COL.accent; g.lineWidth = 2; g.strokeRect(vx - 1, 0, vw + 2, 40);
  g.fillStyle = COL.dim; g.font = '9px sans-serif'; g.textAlign = 'left'; g.fillText('⚑ amber = flagged, to do · blue = flagged, scored', x0, 44);
}
function rpSig() {
  const R = RP, vp = R.vp, key = [vp.start_epoch, vp.window_s, vp.channels.join(','), vp.scale_uv, R.labels[vp.start_epoch]].join('|');
  const c = $('#rpSig'), H = Math.max(260, Math.min(520, 40 + vp.channels.length * 64));
  if (key === R.sigKey && c._h === H && c._w === Math.max(100, c.parentElement.clientWidth)) return; R.sigKey = key;
  const N = R.N, chans = vp.channels.filter(x => ALLCH.includes(x)), win = vp.window_s || 30, abs0 = vp.start_epoch * 30 + (vp.offset_s || 0);
  const eS = Math.floor(abs0 / 30), eE = Math.floor((abs0 + win - 1e-6) / 30), nE = eE - eS + 1;
  const topH = 18, laneH = (H - topH - 18) / Math.max(1, chans.length);
  const {g, w} = fit(c, H), gx = 56, pw = w - gx - 6, X = tt => gx + (tt - abs0) / win * pw;
  R.geo = {gx, pw, abs0, win, topH, laneH, chans, H};
  g.fillStyle = COL.panel; g.fillRect(0, 0, w, H); g.textBaseline = 'middle';
  for (let e = eS; e <= eE; e++) {
    if (e < 0 || e >= N.ne) continue; const x0 = Math.max(gx, X(e * 30)), x1 = Math.min(gx + pw, X(e * 30 + 30)), s = R.labels[e];
    g.fillStyle = COL[s]; g.fillRect(x0, 0, x1 - x0, topH - 3); g.fillStyle = (s === 'W' || s === 'N1') ? '#000' : '#fff'; g.font = '10px sans-serif'; g.textAlign = 'left';
    if (x1 - x0 > 50) g.fillText(`${e} · ${s}${R.flagged[e] ? ' ⚑' : ''}`, x0 + 3, (topH - 3) / 2);
  }
  const half = vp.scale_uv ? vp.scale_uv * 2 : 100, nS = Math.round(win * FS), s0 = Math.round((abs0 - eS * 30) * FS);
  chans.forEach((ch, ci) => {
    const y0 = topH + ci * laneH, mid = y0 + laneH / 2, sc = ch === 'PSG_EMG' ? half / 4 : half, ppu = (laneH / 2 - 2) / sc;
    if (ci % 2 === 0) { g.fillStyle = COL.panel2; g.fillRect(gx, y0, pw, laneH); }
    g.fillStyle = COL.dim; g.textAlign = 'right'; g.font = 'bold 11px sans-serif'; g.fillText(SHORT(ch), gx - 6, mid);
    const buf = new Float32Array(nE * EPN); for (let e = eS; e <= eE; e++) { if (e < 0 || e >= N.ne) continue; buf.set(synthChannel(R.n, e, ch, N.feat[e]), (e - eS) * EPN); }
    g.save(); g.beginPath(); g.rect(gx, y0, pw, laneH); g.clip(); g.strokeStyle = COL.trace; g.lineWidth = 0.9; g.beginPath();
    for (let px = 0; px < pw; px++) {
      const i0 = s0 + Math.floor(px / pw * nS), i1 = Math.max(i0 + 1, s0 + Math.floor((px + 1) / pw * nS)); let mn = 1e9, mx = -1e9;
      for (let i = i0; i < i1 && i < buf.length; i++) { const v = buf[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      if (mn > mx) continue; const x = gx + px + 0.5; if (px === 0) g.moveTo(x, mid - mx * ppu); else g.lineTo(x, mid - mx * ppu); if (mn !== mx) g.lineTo(x, mid - mn * ppu);
    }
    g.stroke(); g.restore();
  });
  g.strokeStyle = COL.dim; g.setLineDash([3, 3]); g.lineWidth = 0.8;
  for (let e = eS; e <= eE + 1; e++) { const x = X(e * 30); if (x < gx || x > gx + pw) continue; g.beginPath(); g.moveTo(x, topH - 3); g.lineTo(x, H - 14); g.stroke(); }
  g.setLineDash([]); g.fillStyle = COL.dim; g.textAlign = 'center'; g.font = '9px sans-serif';
  const tst = win <= 12 ? 1 : win <= 40 ? 5 : win <= 130 ? 10 : 30;
  for (let tt = Math.ceil(abs0 / tst) * tst; tt <= abs0 + win + 1e-6; tt += tst) g.fillText(mmss(tt), X(tt), H - 6);
}
function rpOver(t) {
  const R = RP, c = $('#rpOver'), sig = $('#rpSig'); if (!R.geo) return;
  const {gx, pw, abs0, win, topH, laneH, chans, H} = R.geo, {g} = fit(c, H), X = tt => gx + (tt - abs0) / win * pw;
  const laneOf = ch => chans.indexOf(ch);
  // dwell highlight
  const dw = R.ev.find(e => e.type === 'ui' && e.kind === 'dwell' && e.t <= t && t <= e.t + (e.duration_s || 0));
  if (dw) { const li = laneOf(dw.channel); if (li >= 0) { g.fillStyle = 'rgba(37,99,235,.10)'; g.fillRect(gx, topH + li * laneH, pw, laneH); g.strokeStyle = 'rgba(37,99,235,.5)'; g.strokeRect(gx + 0.5, topH + li * laneH + 0.5, pw - 1, laneH - 1); } }
  // mark_event regions (persist once made)
  for (const m of R.marks) { if (m.t > t) break; const a = m.args, xa = X(a.onset_s || 0), xb = X((a.onset_s || 0) + (a.duration_s || 3)); if (xb < gx || xa > gx + pw) continue; g.fillStyle = 'rgba(217,142,4,.22)'; g.fillRect(Math.max(gx, xa), topH, Math.min(gx + pw, xb) - Math.max(gx, xa), H - topH - 14); g.fillStyle = COL.warn; g.font = 'bold 10px sans-serif'; g.textAlign = 'left'; g.fillText(a.kind || 'event', Math.max(gx, xa) + 3, topH + 9); }
  // filters
  const fl = {}; for (const f of R.filters) { if (f.t > t) break; fl[f.args.channel] = `${f.args.kind} ${f.args.hz} Hz`; }
  for (const ch in fl) { const li = laneOf(ch); if (li < 0) continue; g.fillStyle = COL.accent; g.font = '9px sans-serif'; g.textAlign = 'right'; g.fillText('∿ ' + fl[ch], gx + pw - 4, topH + li * laneH + 8); }
  // measure bracket (visible 4 s)
  const ms = R.calls.filter(m => m.tool === 'measure' && m.t <= t && t - m.t < 4).pop();
  if (ms) { const a = ms.args, li = laneOf(a.channel), r = R.res[ms.call_id]; if (li >= 0) { const y = topH + li * laneH, xa = X(a.t0_s), xb = X(a.t1_s); g.strokeStyle = COL.bad; g.lineWidth = 1.5; g.strokeRect(xa, y + 3, Math.max(2, xb - xa), laneH - 6);
    if (r && r.result) { const s = `${fmt(r.result.peak_to_peak_uv, 1)} µV p-p · ${fmt(r.result.duration_s)} s · ${fmt(r.result.dominant_hz, 1)} Hz`; g.font = 'bold 11px sans-serif'; const tw = g.measureText(s).width; const bx = Math.min(xb + 6, gx + pw - tw - 10); g.fillStyle = COL.bad; g.fillRect(bx, y + 4, tw + 8, 16); g.fillStyle = '#fff'; g.textAlign = 'left'; g.fillText(s, bx + 4, y + 12); } } }
}
function rpSpec() {
  const R = RP, c = $('#rpSpec'), {g, w, h} = fit(c, 60), N = R.N, c0 = Math.max(0, R.vp.start_epoch - 20), c1 = Math.min(N.ne - 1, R.vp.start_epoch + 20), bw = w / (c1 - c0 + 1);
  const bands = ['rel_beta', 'rel_sigma', 'rel_alpha', 'rel_theta', 'rel_delta'];
  for (let e = c0; e <= c1; e++) { const f = N.feat[e] || {}; bands.forEach((b, i) => { const v = Math.min(1, (f[b] || 0) * 1.6); g.fillStyle = `hsl(${250 - 230 * v},80%,${15 + 45 * v}%)`; g.fillRect((e - c0) * bw, i * 10, bw + 0.5, 10); }); }
  g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.strokeRect((R.vp.start_epoch - c0) * bw, 0, Math.max(bw, R.vp.window_s / 30 * bw), 50);
  g.fillStyle = COL.dim; g.font = '9px sans-serif'; g.textAlign = 'left'; g.fillText('spectrogram (±20 epochs, δ bottom → β top)', 4, 57);
}
function rpScrub(t) {
  const R = RP, c = $('#rpScrub'), {g, w, h} = fit(c, 22), mx = Math.max(...R.dens) || 1;
  g.fillStyle = COL.panel2; g.fillRect(0, 0, w, h);
  for (const p of R.pauses) { g.fillStyle = 'rgba(139,92,246,.35)'; g.fillRect(p.a / R.tmax * w, 0, (p.b - p.a) / R.tmax * w, h); }
  for (let i = 0; i < 400; i++) { const v = R.dens[i] / mx; g.fillStyle = COL.dim; g.fillRect(i / 400 * w, h - v * h * 0.8, w / 400 + 0.5, v * h * 0.8); }
  for (const l of R.labelEv) { g.fillStyle = COL.bad; g.fillRect(l.t / R.tmax * w, 0, 1, 5); }
  g.fillStyle = COL.accent; g.fillRect(t / R.tmax * w - 1, 0, 2.5, h);
}
function rpTargetXY(tgt) {
  const app = $('#rpApp').getBoundingClientRect();
  if (tgt.id) { const el = document.getElementById(tgt.id); if (!el) return null; const b = el.getBoundingClientRect(); return [b.left - app.left + b.width * 0.55, b.top - app.top + b.height * 0.6]; }
  const R = RP, G = R.geo, sb = $('#rpSig').getBoundingClientRect(); if (!G) return null;
  let li = tgt.ch ? G.chans.indexOf(tgt.ch) : (tgt.lane != null ? Math.min(tgt.lane, G.chans.length - 1) : Math.floor(G.chans.length / 2)); if (li < 0) li = 0;
  const xs = tgt.xs == null ? G.abs0 + G.win / 2 : Math.max(G.abs0, Math.min(G.abs0 + G.win, tgt.xs));
  return [sb.left - app.left + G.gx + (xs - G.abs0) / G.win * G.pw, sb.top - app.top + G.topH + (li + 0.5 + 0.35 * (tgt.dy || 0)) * G.laneH];
}
function rpCursor(t) {
  const R = RP, K = R.K, cur = $('#rpCur'); if (!K.length) return;
  let lo = 0, hi = K.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (K[m].t <= t) { k = m; lo = m + 1; } else hi = m - 1; }
  const A = k >= 0 ? K[k] : K[0], B = K[k + 1];
  let p = rpTargetXY(A.tgt) || [300, 200];
  if (B) { const q = rpTargetXY(B.tgt); const travel = B.fast ? (B.t - A.t) : Math.min(0.7, B.t - A.t); const s = (t - (B.t - travel)) / Math.max(travel, 1e-3); if (q && s > 0) { const e = s < 0.5 ? 2 * s * s : 1 - (-2 * s + 2) ** 2 / 2; p = [p[0] + (q[0] - p[0]) * e, p[1] + (q[1] - p[1]) * e]; } }
  cur.style.transform = `translate(${p[0]}px,${p[1]}px)`;
  const clk = k >= 0 && A.click && t - A.t < 0.35; $('#rpRip').classList.toggle('on', clk);
}
function rpSubtitle(t, sp) {
  const el = $('#rpSub'); if (!sp) { el.hidden = true; return; } el.hidden = false;
  const w = sp.w.length ? sp.w : null;
  el.innerHTML = `<span class="who">${RP.a}</span> ` + (w ? w.map(x => `<span class="${x.s <= t ? (x.e >= t ? 'now' : 'said') : 'todo'}${x.p != null && x.p < 0.6 ? ' lowp' : ''}">${esc(x.w)}</span>`).join(' ') : esc(sp.e.text));
}
function rpFeed(force) {
  const R = RP, t = R.t, el = $('#rpFeed'); if (!el) return; const showT = $('#rpShowTools').checked;
  // items up to t
  const items = []; for (const e of R.ev) { if (e.t > t) break; if (e.type === 'transcript' || (showT && e.type === 'tool_call') || e.type === 'pause') items.push(e); }
  const n = items.length; if (!force && n === R.feedN) { const last = el.lastElementChild; if (last && last.classList.contains('bub')) rpKaraoke(last, t); return; }
  const start = Math.max(0, n - 60);
  el.innerHTML = items.slice(start).map(e => {
    if (e.type === 'transcript') return `<div class="bub" data-t="${e.t}"><div class="bt">${mmss(e.t)}${e.no_speech_prob > 0.5 || e.avg_logprob < -0.8 ? ' <span class="halluc">low-conf ASR</span>' : ''}</div><div class="bx">${esc(e.text).replace(/\[(NAME|INSTITUTION|CITY|SITE[^\]]*)\]/g, '<span class="red">[$1]</span>')}</div></div>`;
    if (e.type === 'pause') return `<div class="act dim" data-t="${e.t}">— ${e.reason === 'break' ? 'break' : 'idle'} ${mmss(e.duration_s || 0)} —</div>`;
    const r = R.res[e.call_id], a = e.args || {}, extra = e.tool === 'set_label' && r && r.result ? ` <span class="dim">(was ${r.result.prev_stage})</span>` : '';
    const lab = e.tool === 'set_label' ? `${labChip(a.stage)} epoch ${a.epoch}${extra}` : `${TOOL_LABEL[e.tool] || e.tool} <span class="mono dim">${esc(JSON.stringify(a)).slice(0, 70)}</span>`;
    return `<div class="act ${e.tool === 'set_label' ? 'lbl' : ''}" data-t="${e.t}"><span class="ts">${mmss(e.t)}</span> ${lab}</div>`;
  }).join('');
  R.feedN = n; el.scrollTop = el.scrollHeight;
  el.querySelectorAll('[data-t]').forEach(x => x.onclick = () => rpSeek(+x.dataset.t));
}
function rpKaraoke(node, t) { const s = RP.speech.find(x => x.a === +node.dataset.t); node.classList.toggle('speaking', !!s && t <= s.b); }

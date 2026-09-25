// Smoke Signal dashboard — vanilla JS, no build step. All temperatures arrive in °C and are
// converted with the hub's display unit. User-provided labels are inserted with textContent only.

const SVG_NS = 'http://www.w3.org/2000/svg';
const MIN = 60_000;
const state = {
  status: null,
  hist: null,
  events: [],
  range: localGet('range', '180'),
  table: false,
  hover: null, // index into hist.t
  setupKey: '',
};

function localGet(key, fallback) {
  try {
    return localStorage.getItem(`ss.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}
function localSet(key, value) {
  try {
    localStorage.setItem(`ss.${key}`, value);
  } catch {
    /* private mode */
  }
}

const $ = (sel) => document.querySelector(sel);
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.setAttribute('style', v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}
function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

// ---- units & formatting --------------------------------------------------------------

const unit = () => state.status?.unit ?? 'F';
const toU = (c) => (unit() === 'F' ? (c * 9) / 5 + 32 : c);
const fromU = (v) => (unit() === 'F' ? ((v - 32) * 5) / 9 : v);
const dToU = (dc) => (unit() === 'F' ? (dc * 9) / 5 : dc);
const fmtT = (c, digits = 0) => (c == null ? '—' : `${toU(c).toFixed(digits)}°${unit()}`);
const fmtRate = (r) => {
  if (r == null) return '—';
  const v = dToU(r);
  return `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(Math.abs(v) < 10 ? 1 : 0)}°/hr`;
};
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const dur = (ms) => {
  let m = Math.max(0, Math.round(ms / MIN));
  const h = Math.floor(m / 60);
  m -= h * 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
};

/** Colour follows the channel (sorted id order over every channel the cook has seen). */
function seriesVar(id) {
  const ids = Object.keys(state.status?.cook.channels ?? {}).sort();
  const i = Math.max(0, ids.indexOf(id));
  return `var(--series-${(i % 8) + 1})`;
}

// ---- data loading --------------------------------------------------------------------

async function getJson(url, init) {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function post(url, body) {
  return getJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

function rangeMinutes() {
  const s = state.status;
  if (state.range !== 'all' || !s) return Number(state.range);
  const start = s.cook.startedAt ?? s.cook.createdAt;
  return Math.max(30, Math.ceil((s.now - start) / MIN) + 5);
}

async function refreshStatus() {
  state.status = await getJson('/api/status');
  renderHeader();
  renderAlerts();
  renderTiles();
  renderDevices();
  renderSetup();
}

async function refreshHistory() {
  if (!state.status) await refreshStatus();
  const minutes = rangeMinutes();
  const bucket = Math.max(5, Math.round((minutes * 60) / 480 / 5) * 5);
  const since = state.status.now - minutes * MIN;
  const [hist, events] = await Promise.all([
    getJson(`/api/history?minutes=${minutes}&bucketSeconds=${bucket}`),
    getJson(`/api/events?since=${since}`),
  ]);
  state.hist = hist;
  state.events = events;
  renderChart();
  renderTable();
  renderEvents();
}

function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  return () => {
    const wait = last + ms - Date.now();
    if (wait <= 0) {
      last = Date.now();
      fn();
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn();
      }, wait);
    }
  };
}

const safe = (fn) => () => fn().catch((err) => console.warn(err));
const statusSoon = throttle(safe(refreshStatus), 2000);
const historySoon = throttle(safe(refreshHistory), 5000);

function connectStream() {
  const es = new EventSource('/api/stream');
  es.addEventListener('sample', () => {
    statusSoon();
    historySoon();
  });
  for (const ev of ['event', 'alarm', 'cook', 'device']) {
    es.addEventListener(ev, () => {
      statusSoon();
      historySoon();
    });
  }
  es.onerror = () => {
    $('#cook-line').textContent = 'Lost connection to the hub — retrying…';
  };
}

// ---- header, alerts, tiles -------------------------------------------------------------

function renderHeader() {
  const s = state.status;
  const c = s.cook;
  const bits = [];
  if (c.startedAt) bits.push(`${c.name} · ${dur((c.endedAt ?? s.now) - c.startedAt)}${c.endedAt ? ' · finished' : ''}`);
  else bits.push('No cook started — set one up below or ask Claude');
  if (c.meat) bits.push(c.meat);
  if (c.serveAt) bits.push(`serve ${clock(c.serveAt)}`);
  $('#cook-line').textContent = bits.join(' · ');
  const mode = $('#mode-chip');
  mode.hidden = s.mode !== 'sim';
  mode.textContent = `Simulator${s.speed !== 1 ? ` ×${s.speed}` : ''}`;
  const chip = $('#claude-chip');
  chip.replaceChildren();
  const ago = s.claudeLastCheckAt ? s.now - s.claudeLastCheckAt : null;
  const color = ago == null ? 'var(--muted)' : ago < 15 * MIN * s.speed ? 'var(--good)' : 'var(--warning)';
  chip.append(el('span', { class: 'dot', style: `background:${color}` }), ago == null ? 'Claude: not checking in yet' : `Claude checked in ${dur(ago)} ago`);
  for (const b of document.querySelectorAll('[data-unit]')) b.classList.toggle('on', b.dataset.unit === s.unit);
}

function renderAlerts() {
  const box = $('#alerts');
  box.replaceChildren(
    ...state.status.activeAlarms.map((a) =>
      el(
        'div',
        { class: `alert ${a.severity}`, role: 'status' },
        el('span', { class: 'icon', 'aria-hidden': 'true' }, a.severity === 'critical' ? '▲' : '!'),
        el('div', {}, el('strong', {}, `${a.severity === 'critical' ? 'Critical: ' : 'Warning: '}${a.title}`), el('span', {}, a.message || '')),
      ),
    ),
  );
}

function badge(kind, text) {
  return el('span', { class: `badge ${kind}` }, text);
}

function renderTiles() {
  const s = state.status;
  const list = [...s.analyses].sort((a, b) => (a.role === b.role ? a.id.localeCompare(b.id) : a.role === 'pit' ? -1 : 1));
  const tiles = list.map((a) => {
    const badges = [];
    const subs = [];
    if (a.current == null) badges.push(badge(a.sensorStatus === 'docked' ? '' : 'serious', a.sensorStatus === 'docked' ? 'In dock' : a.lastAt ? `No signal ${dur(s.now - a.lastAt)}` : 'No data yet'));
    if (a.role === 'pit') {
      if (a.lowC != null || a.highC != null) subs.push(`Range ${fmtT(a.lowC)}–${fmtT(a.highC)}`);
      else subs.push('No range set');
      if (a.rangeStatus === 'ok') badges.push(badge('good', 'In range'));
      if (a.rangeStatus === 'low') badges.push(badge('critical', `Low for ${dur((a.outOfRangeMin ?? 0) * MIN)}`));
      if (a.rangeStatus === 'high') badges.push(badge('critical', `High for ${dur((a.outOfRangeMin ?? 0) * MIN)}`));
      if (a.stats10) subs.push(`10-min avg ${fmtT(a.stats10.mean)} · ${fmtRate(a.rate30)} over 30 min`);
    } else {
      if (a.targetC != null) {
        const left = a.current != null ? a.targetC - a.current : null;
        subs.push(`Target ${fmtT(a.targetC)}${left != null && left > 0 ? ` · ${Math.round(dToU(left))}° to go` : ''}`);
        if (left != null && left <= 0) badges.push(badge('good', 'Target reached'));
      } else subs.push('No target set');
      subs.push(`${fmtRate(a.rate30)} over 30 min`);
      const eta = a.eta60Min ?? a.eta30Min;
      if (a.stall) badges.push(badge('warning', `Stall ${dur(a.stall.minutes * MIN)}`));
      else if (eta != null && a.targetC != null && a.current < a.targetC) subs.push(`ETA ~${clock(s.now + eta * MIN)} (straight-line)`);
    }
    return el(
      'article',
      { class: 'tile' },
      el('div', { class: 'tile-head' }, el('span', { class: 'key', style: `background:${seriesVar(a.id)}` }), `${a.label}`, el('span', { style: 'color:var(--muted)' }, a.id)),
      el('div', { class: 'value' }, a.current == null ? '—' : `${Math.round(toU(a.current))}°`, el('small', {}, unit())),
      ...subs.map((t) => el('div', { class: 'sub' }, t)),
      badges.length ? el('div', { class: 'badges' }, badges) : null,
    );
  });
  if (!tiles.length) tiles.push(el('article', { class: 'tile' }, el('div', { class: 'sub' }, 'Waiting for thermometer data… check the hub terminal.')));
  $('#tiles').replaceChildren(...tiles);
}

function renderDevices() {
  const s = state.status;
  const items = s.devices.map((d) =>
    el(
      'li',
      {},
      el('div', {}, el('span', { class: 'badge ' + (d.connected ? 'good' : 'critical') }, d.connected ? 'Connected' : 'Disconnected'), ' ', `${d.alias} · ${d.model}`),
      el(
        'div',
        { class: 'meta' },
        [
          d.state,
          d.rssi != null ? `signal ${d.rssi} dBm` : null,
          d.batteries ? Object.entries(d.batteries).map(([k, v]) => `${k} ${v}%`).join(', ') : d.batteryPct != null ? `battery ${d.batteryPct}%` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      ),
    ),
  );
  $('#devices').replaceChildren(...(items.length ? items : [el('li', { class: 'meta' }, 'No thermometer found yet. Close the INKBIRD phone app and wake the base (take out a probe).')]));
}

// ---- chart ---------------------------------------------------------------------------

function niceStep(span, target, steps) {
  const raw = span / target;
  return steps.find((s) => s >= raw) ?? steps.at(-1);
}

function renderChart() {
  const box = $('#chart');
  const h = state.hist;
  const s = state.status;
  box.querySelector('svg')?.remove();
  const legend = $('#legend');
  const ids = h ? Object.keys(h.series) : [];
  legend.replaceChildren(
    ...ids.map((id) => el('li', {}, el('span', { class: 'key', style: `background:${seriesVar(id)}` }), `${h.labels[id] ?? id} (${id})`)),
  );
  if (!h || !h.t.length) {
    box.querySelector('.empty')?.remove();
    box.append(el('p', { class: 'hint empty' }, 'No readings in this time range yet.'));
    return;
  }
  box.querySelector('.empty')?.remove();

  const W = Math.max(320, box.clientWidth);
  const H = W < 600 ? 300 : 380;
  const m = { l: 44, r: 58, t: 14, b: 26 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const x0 = h.t[0];
  const x1 = Math.max(h.now, h.t.at(-1));
  const X = (t) => m.l + ((t - x0) / Math.max(1, x1 - x0)) * pw;

  // y domain from data + targets/ranges (display units)
  let lo = Infinity;
  let hi = -Infinity;
  for (const id of ids) for (const v of h.series[id]) if (v != null) (lo = Math.min(lo, toU(v))), (hi = Math.max(hi, toU(v)));
  for (const a of s.analyses) {
    for (const v of [a.targetC, a.lowC, a.highC]) if (v != null && ids.includes(a.id)) (lo = Math.min(lo, toU(v))), (hi = Math.max(hi, toU(v)));
  }
  if (!Number.isFinite(lo)) (lo = 0), (hi = 100);
  const yStep = niceStep(hi - lo || 10, 6, [1, 2, 5, 10, 20, 25, 50, 100]);
  lo = Math.floor((lo - yStep * 0.25) / yStep) * yStep;
  hi = Math.ceil((hi + yStep * 0.25) / yStep) * yStep;
  const Y = (v) => m.t + ph - ((v - lo) / (hi - lo)) * ph;

  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': 'Temperature over time' });

  // stall bands (behind everything)
  for (const a of s.analyses) {
    if (!a.stall || !ids.includes(a.id)) continue;
    const xa = Math.max(m.l, X(a.stall.since));
    root.append(svg('rect', { x: xa, y: m.t, width: Math.max(0, m.l + pw - xa), height: ph, fill: 'var(--stall)' }));
    root.append(svg('text', { x: xa + 4, y: m.t + 12, class: 'stall-label' }, `${a.label} stall`));
  }

  // grid + y ticks
  for (let v = lo; v <= hi + 1e-9; v += yStep) {
    const y = Y(v);
    root.append(svg('line', { x1: m.l, x2: m.l + pw, y1: y, y2: y, stroke: 'var(--grid)', 'stroke-width': 1 }));
    root.append(svg('text', { x: m.l - 6, y: y + 4, 'text-anchor': 'end' }, `${Math.round(v)}°`));
  }
  root.append(svg('line', { x1: m.l, x2: m.l + pw, y1: m.t + ph, y2: m.t + ph, stroke: 'var(--axis)', 'stroke-width': 1 }));

  // x ticks
  const spanMin = (x1 - x0) / MIN;
  const xStep = niceStep(spanMin, W < 600 ? 4 : 7, [5, 10, 15, 30, 60, 120, 180, 240, 360, 720]) * MIN;
  const tzOffset = new Date(x0).getTimezoneOffset() * MIN;
  for (let t = Math.ceil((x0 - tzOffset) / xStep) * xStep + tzOffset; t <= x1; t += xStep) {
    const x = X(t);
    root.append(svg('line', { x1: x, x2: x, y1: m.t + ph, y2: m.t + ph + 4, stroke: 'var(--axis)' }));
    root.append(svg('text', { x, y: H - 6, 'text-anchor': 'middle' }, clock(t)));
  }

  // pit range bands; meat targets grouped so probes sharing a target get one line + label
  const targets = new Map();
  for (const a of s.analyses) {
    if (!ids.includes(a.id)) continue;
    if (a.role === 'pit' && a.lowC != null && a.highC != null) {
      root.append(svg('rect', { x: m.l, y: Y(toU(a.highC)), width: pw, height: Math.max(0, Y(toU(a.lowC)) - Y(toU(a.highC))), fill: seriesVar(a.id), 'fill-opacity': 0.08 }));
    }
    if (a.role === 'meat' && a.targetC != null) {
      const k = Math.round(toU(a.targetC));
      if (!targets.has(k)) targets.set(k, []);
      targets.get(k).push(a);
    }
  }
  for (const [v, list] of targets) {
    const y = Y(v);
    const stroke = list.length === 1 ? seriesVar(list[0].id) : 'var(--ink-2)';
    root.append(svg('line', { x1: m.l, x2: m.l + pw, y1: y, y2: y, stroke, 'stroke-opacity': 0.55, 'stroke-width': 1 }));
    root.append(svg('text', { x: m.l + 4, y: y - 4, class: 'ref' }, `Target ${v}° · ${list.map((a) => a.label).join(', ')}`));
  }

  // event markers
  const evs = state.events.filter((e) => e.at >= x0 && e.at <= x1 && (e.type !== 'system' || e.code));
  for (const e of evs) {
    const x = X(e.at);
    const col = e.type === 'alarm' ? (e.severity === 'critical' ? 'var(--critical)' : 'var(--warning)') : e.type === 'claude' ? 'var(--ink)' : 'var(--muted)';
    root.append(svg('line', { x1: x, x2: x, y1: m.t, y2: m.t + ph, stroke: col, 'stroke-opacity': 0.35, 'stroke-width': 1 }));
    const dot = svg('circle', { cx: x, cy: m.t + 2, r: 4, fill: col, stroke: 'var(--surface)', 'stroke-width': 2 });
    dot.append(svg('title', {}, `${clock(e.at)} ${e.title}`));
    root.append(dot);
  }

  // lines
  const ends = [];
  for (const id of ids) {
    const vals = h.series[id];
    let d = '';
    let pen = false;
    vals.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${X(h.t[i]).toFixed(1)},${Y(toU(v)).toFixed(1)}`;
      pen = true;
    });
    root.append(svg('path', { d, fill: 'none', stroke: seriesVar(id), 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    for (let i = vals.length - 1; i >= 0; i--) {
      if (vals[i] != null) {
        ends.push({ id, x: X(h.t[i]), y: Y(toU(vals[i])), v: toU(vals[i]) });
        break;
      }
    }
  }
  // end markers + direct labels (dropped where they would collide; the legend still identifies)
  ends.sort((a, b) => a.y - b.y);
  ends.forEach((e, i) => {
    root.append(svg('circle', { cx: e.x, cy: e.y, r: 4, fill: seriesVar(e.id), stroke: 'var(--surface)', 'stroke-width': 2 }));
    const clash = (ends[i - 1] && e.y - ends[i - 1].y < 14) || (ends[i + 1] && ends[i + 1].y - e.y < 14);
    if (!clash) root.append(svg('text', { x: e.x + 8, y: e.y + 4, class: 'end' }, `${Math.round(e.v)}°`));
  });

  // crosshair + hit area
  const cross = svg('line', { y1: m.t, y2: m.t + ph, stroke: 'var(--ink-2)', 'stroke-width': 1, visibility: 'hidden' });
  root.append(cross);
  const hit = svg('rect', { x: m.l, y: 0, width: pw, height: H, fill: 'transparent' });
  root.append(hit);
  box.prepend(root);

  const showAt = (i, clientX) => {
    if (i == null) {
      cross.setAttribute('visibility', 'hidden');
      $('#tooltip').hidden = true;
      return;
    }
    state.hover = i;
    const x = X(h.t[i]);
    cross.setAttribute('x1', x);
    cross.setAttribute('x2', x);
    cross.setAttribute('visibility', 'visible');
    const tip = $('#tooltip');
    const rows = ids.map((id) =>
      el(
        'div',
        { class: 'row' },
        el('span', { class: 'key', style: `background:${seriesVar(id)}` }),
        el('b', {}, h.series[id][i] == null ? '—' : `${toU(h.series[id][i]).toFixed(0)}°${unit()}`),
        el('span', {}, h.labels[id] ?? id),
      ),
    );
    const half = Math.max(h.bucketMs, (x1 - x0) / 120);
    const near = state.events.filter((e) => Math.abs(e.at - h.t[i]) <= half);
    tip.replaceChildren(el('div', { class: 'when' }, clock(h.t[i])), ...rows, ...near.map((e) => el('div', { class: 'ev' }, `${clock(e.at)} · ${e.title}`)));
    tip.hidden = false;
    const bw = box.clientWidth;
    const left = x + 14 + tip.offsetWidth > bw ? x - 14 - tip.offsetWidth : x + 14;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${m.t + 8}px`;
    void clientX;
  };
  const indexAt = (px) => {
    const t = x0 + ((px - m.l) / pw) * (x1 - x0);
    let lo2 = 0;
    let hi2 = h.t.length - 1;
    while (lo2 < hi2) {
      const mid = (lo2 + hi2) >> 1;
      if (h.t[mid] < t) lo2 = mid + 1;
      else hi2 = mid;
    }
    if (lo2 > 0 && Math.abs(h.t[lo2 - 1] - t) < Math.abs(h.t[lo2] - t)) lo2--;
    return lo2;
  };
  hit.addEventListener('pointermove', (ev) => {
    const r = root.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    showAt(indexAt(px), ev.clientX);
  });
  hit.addEventListener('pointerleave', () => showAt(null));
  box.onkeydown = (ev) => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    ev.preventDefault();
    const cur = state.hover ?? h.t.length - 1;
    showAt(Math.max(0, Math.min(h.t.length - 1, cur + (ev.key === 'ArrowLeft' ? -1 : 1))));
  };
  box.onblur = () => showAt(null);
}

function renderTable() {
  const wrap = $('#table-wrap');
  wrap.hidden = !state.table;
  if (!state.table || !state.hist) return;
  const h = state.hist;
  const ids = Object.keys(h.series);
  const every = Math.max(1, Math.ceil(h.t.length / 80));
  const rows = [];
  for (let i = h.t.length - 1; i >= 0; i -= every) {
    rows.push(el('tr', {}, el('td', {}, clock(h.t[i])), ...ids.map((id) => el('td', {}, h.series[id][i] == null ? '—' : `${toU(h.series[id][i]).toFixed(1)}°`))));
  }
  wrap.replaceChildren(
    el(
      'table',
      {},
      el('caption', {}, `Temperatures in °${unit()}, newest first`),
      el('thead', {}, el('tr', {}, el('th', {}, 'Time'), ...ids.map((id) => el('th', {}, `${h.labels[id] ?? id} (${id})`)))),
      el('tbody', {}, rows),
    ),
  );
}

// ---- cook log --------------------------------------------------------------------------

function renderEvents() {
  const list = [...state.events].reverse().slice(0, 150);
  const kind = (e) => (e.type === 'claude' ? 'Claude' : e.type === 'alarm' ? e.severity : e.type === 'alarm-cleared' ? 'cleared' : e.type === 'note' ? 'note' : 'hub');
  $('#events').replaceChildren(
    ...list.map((e) =>
      el(
        'li',
        {},
        el('time', { datetime: new Date(e.at).toISOString() }, clock(e.at)),
        el('div', {}, el('div', { class: 'title' }, el('span', { class: 'kind' }, kind(e)), e.title), e.message && e.type !== 'alarm-cleared' ? el('div', { class: 'msg' }, e.message) : null),
      ),
    ),
  );
  if (!list.length) $('#events').append(el('li', { class: 'msg' }, el('span', {}), 'Nothing logged in this time range.'));
}

$('#note-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const input = $('#note-text');
  const text = input.value.trim();
  if (!text) return;
  try {
    await post('/api/notes', { text });
    input.value = '';
    historySoon();
  } catch (err) {
    alert(`Couldn't add note: ${err.message}`);
  }
});

// ---- cook setup --------------------------------------------------------------------------

function renderSetup() {
  const s = state.status;
  const channelIds = Object.keys(s.cook.channels).sort();
  const key = `${s.cook.id}|${s.unit}|${channelIds.join(',')}|${s.cook.startedAt}|${s.cook.endedAt}`;
  const form = $('#setup-form');
  if (key === state.setupKey || form.contains(document.activeElement)) return;
  state.setupKey = key;
  const c = s.cook;
  const u = s.unit;
  const num = (v) => (v == null ? '' : String(Math.round(toU(v))));
  const weight = c.weightKg == null ? '' : u === 'F' ? (c.weightKg / 0.45359237).toFixed(1) : c.weightKg.toFixed(2);
  const serve = c.serveAt ? new Date(c.serveAt - new Date(c.serveAt).getTimezoneOffset() * MIN).toISOString().slice(0, 16) : '';
  const byId = Object.fromEntries(s.analyses.map((a) => [a.id, a]));
  const fields = channelIds.map((id) => {
    const info = c.channels[id];
    const st = c.settings[id] ?? {};
    const role = st.role ?? (info.kind === 'ambient' ? 'pit' : 'meat');
    const a = byId[id];
    return el(
      'fieldset',
      { 'data-channel': id },
      el('legend', {}, el('span', { class: 'key', style: `background:${seriesVar(id)}` }), `${id} · ${info.name ?? info.kind}`),
      el('label', {}, 'Label', el('input', { name: 'label', value: st.label ?? a?.label ?? '', placeholder: 'e.g. Brisket flat' })),
      el(
        'label',
        {},
        'Role',
        el('select', { name: 'role' }, ...['meat', 'pit', 'off'].map((r) => el('option', { value: r, selected: r === role }, r))),
      ),
      role === 'pit'
        ? [el('label', {}, `Low °${u}`, el('input', { name: 'low', inputmode: 'numeric', value: num(st.lowC) })), el('label', {}, `High °${u}`, el('input', { name: 'high', inputmode: 'numeric', value: num(st.highC) }))]
        : [el('label', {}, `Target °${u}`, el('input', { name: 'target', inputmode: 'numeric', value: num(st.targetC) })), el('span')],
    );
  });
  form.replaceChildren(
    el('div', { class: 'row2' }, el('label', {}, 'Cook name', el('input', { name: 'name', value: c.name === 'Untitled cook' ? '' : c.name, placeholder: 'Saturday brisket' })), el('label', {}, 'Meat', el('input', { name: 'meat', value: c.meat ?? '', placeholder: 'Packer brisket' }))),
    el('div', { class: 'row2' }, el('label', {}, `Weight (${u === 'F' ? 'lb' : 'kg'})`, el('input', { name: 'weight', inputmode: 'decimal', value: weight })), el('label', {}, 'Serve at', el('input', { name: 'serveAt', type: 'datetime-local', value: serve }))),
    ...fields,
    el(
      'div',
      { class: 'actions' },
      el('button', { type: 'submit', value: 'save' }, 'Save'),
      !c.startedAt || c.endedAt ? el('button', { type: 'submit', value: c.endedAt ? 'new' : 'start' }, c.endedAt ? 'Start a new cook' : 'Start cook') : el('button', { type: 'submit', value: 'end' }, 'End cook'),
    ),
  );
  $('#setup-hint').textContent = channelIds.length ? '' : 'Probes appear here once the thermometer is connected.';
}

$('#setup-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = ev.currentTarget;
  const action = ev.submitter?.value ?? 'save';
  const fd = new FormData(form);
  const body = { unit: unit(), channels: {} };
  const name = String(fd.get('name') || '').trim();
  if (name) body.name = name;
  body.meat = String(fd.get('meat') || '');
  const w = String(fd.get('weight') || '').trim();
  if (w) (body.weight = Number(w)), (body.weightUnit = unit() === 'F' ? 'lb' : 'kg');
  const serve = String(fd.get('serveAt') || '');
  body.serveAt = serve ? new Date(serve).getTime() : null;
  for (const fs of form.querySelectorAll('fieldset[data-channel]')) {
    const get = (n) => fs.querySelector(`[name=${n}]`)?.value.trim();
    const numOrNull = (v) => (v === undefined ? undefined : v === '' ? null : Number(v));
    body.channels[fs.dataset.channel] = { label: get('label') || null, role: get('role'), target: numOrNull(get('target')), low: numOrNull(get('low')), high: numOrNull(get('high')) };
  }
  try {
    if (action === 'end') {
      if (!confirm('End this cook? Alarms for it will stop.')) return;
      await post('/api/cook/end', {});
    } else if (action === 'start' || action === 'new') {
      await post('/api/cook/start', { ...body, name: body.name || 'Cook', newSession: action === 'new' });
    } else {
      await post('/api/cook', body);
    }
    state.setupKey = '';
    await refreshStatus();
    historySoon();
    $('#setup-hint').textContent = 'Saved.';
  } catch (err) {
    $('#setup-hint').textContent = `Couldn't save: ${err.message}`;
  }
});

// ---- controls ---------------------------------------------------------------------------

for (const b of document.querySelectorAll('[data-range]')) {
  b.classList.toggle('on', b.dataset.range === state.range);
  b.addEventListener('click', () => {
    state.range = b.dataset.range;
    localSet('range', state.range);
    for (const o of document.querySelectorAll('[data-range]')) o.classList.toggle('on', o === b);
    safe(refreshHistory)();
  });
}

$('#table-toggle').addEventListener('click', (ev) => {
  state.table = !state.table;
  ev.currentTarget.setAttribute('aria-pressed', String(state.table));
  renderTable();
});

for (const b of document.querySelectorAll('[data-unit]')) {
  b.addEventListener('click', async () => {
    try {
      await post('/api/unit', { unit: b.dataset.unit });
      state.setupKey = '';
      await refreshStatus();
      await refreshHistory();
    } catch (err) {
      alert(`Couldn't change unit: ${err.message}`);
    }
  });
}

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderChart, 150);
});

(async function init() {
  try {
    await refreshStatus();
    await refreshHistory();
  } catch (err) {
    $('#cook-line').textContent = `Can't reach the hub: ${err.message}`;
  }
  connectStream();
  setInterval(safe(refreshHistory), 30_000);
})();

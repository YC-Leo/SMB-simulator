/* SMB Simulator Suite — front end (vanilla JS, no external libraries). */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clone = o => JSON.parse(JSON.stringify(o));
const ZONES = ["I", "II", "III", "IV", "V", "VI"];
const ROLE_LABEL = { extract: "Extract", raffinate: "Raffinate", desorbent: "Desorbent" };
const KIND_LABEL = { desorbent: "Desorbent in", feed: "Feed in", extract: "Extract out", raffinate: "Raffinate out" };
const INLETS = ["desorbent", "feed"];

const S = {
  defaults: null, cfg: null, isotherms: {}, schemes: {}, presets: {}, maxColumns: 16, maxZones: 6,
  derived: null, runs: [], selected: null, view: null,
  job: null, queue: [], r0: null,
  frame: 0, switchNo: 0, playing: null, speed: 75,
  hidden: {}, profMode: "liquid", frameMode: "ports", profTab: "axial", colPick: 0,
  unitMode: "process", motion: "valves", fill: "solutes", prodTab: "outlets", outletIdx: 0, convTab: "perf",
  validateTimer: null, errors: [], anim: null,
};

/* ------------------------------------------------------------------ utils */
function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function palette() { return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(i => css(`--c${i}`)); }
function compColor(i) { const p = palette(); return p[i % p.length]; }
function fmt(v, d) {
  if (v === null || v === undefined || Number.isNaN(v)) return "–";
  if (d !== undefined) return Number(v).toFixed(d);
  const a = Math.abs(v);
  if (a === 0) return "0";
  if (a >= 1000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(1);
  if (a >= 0.01) return v.toPrecision(3);
  return v.toExponential(2);
}
function pct(v) { return v === null || v === undefined || Number.isNaN(v) ? "–" : v.toFixed(2); }
function fmtTime(s) { return s < 60 ? `${s.toFixed(0)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`; }
async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, data };
}
function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function roleIndex(cfg, role) { return cfg.components.findIndex(c => c.role === role); }
function namesWithRole(cfg, role) { return cfg.components.filter(c => c.role === role).map(c => c.name).join(", ") || "–"; }
function hexToRgb(h) {
  h = h.trim();
  if (h.startsWith("rgb")) { const m = h.match(/[\d.]+/g).map(Number); return m.slice(0, 3); }
  if (h.length === 4) h = "#" + [...h.slice(1)].map(c => c + c).join("");
  const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/* Layout of a configuration: zone starts, ports with junction index and label (mirrors smbsim.config). */
function layoutOf(cfg) {
  const n = cfg.zones.reduce((a, b) => a + b, 0), nz = cfg.zones.length;
  const start = z => cfg.zones.slice(0, z).reduce((a, b) => a + b, 0) % Math.max(1, n);
  const letter = { desorbent: "D", feed: "F", extract: "E", raffinate: "R" };
  const count = {}; cfg.ports.forEach(p => count[p.kind] = (count[p.kind] || 0) + 1);
  const seen = {};
  const ports = cfg.ports.map(p => {
    seen[p.kind] = (seen[p.kind] || 0) + 1;
    return { kind: p.kind, zone: p.zone, junction: start(p.zone), flow: p.flow, balance: !!p.balance && !INLETS.includes(p.kind),
      label: letter[p.kind] + (count[p.kind] > 1 ? seen[p.kind] : "") };
  });
  return { n, nz, starts: Array.from({ length: nz }, (_, z) => start(z)), ports, pitch: cfg.length + cfg.dead_length };
}
function portColor(cfg, kind) {
  if (kind === "feed") return css("--ink-2");
  const role = kind === "desorbent" ? "desorbent" : kind;
  const i = roleIndex(cfg, role);
  return i >= 0 ? compColor(i) : css("--ink-2");
}
function zoneOfColumn(v, k) {           // port-frame column -> zone index
  let z = 0;
  for (let i = 0; i < v.starts.length; i++) if (k >= v.starts[i]) z = i;
  return z;
}

/* ------------------------------------------------------------- tooltip */
const tip = {
  el: null,
  show(html, x, y) {
    const t = this.el; t.innerHTML = html; t.hidden = false;
    const w = t.offsetWidth, h = t.offsetHeight;
    let left = x + 14, top = y + 14;
    if (left + w > innerWidth - 8) left = x - w - 14;
    if (top + h > innerHeight - 8) top = y - h - 14;
    t.style.left = left + "px"; t.style.top = top + "px";
  },
  hide() { this.el.hidden = true; },
};

/* ----------------------------------------------------------- SVG charts */
function niceTicks(min, max, count = 5) {
  if (!(max > min)) { max = min + 1; }
  const span = max - min, step0 = span / count, mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const err = step0 / mag, step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
  const out = [];
  for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + step * 1e-9; v += step) out.push(+v.toPrecision(12));
  return out;
}
function bsearch(xs, x) {
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] < x) lo = m; else hi = m; }
  return Math.abs(xs[lo] - x) <= Math.abs(xs[hi] - x) ? lo : hi;
}

function legend(el, series, key, onChange) {
  if (!el) return;
  const hid = S.hidden[key] || (S.hidden[key] = new Set());
  el.innerHTML = "";
  for (const s of series) {
    const b = document.createElement("button");
    b.className = hid.has(s.name) ? "off" : "";
    b.innerHTML = `<i class="${s.dash ? "dash" : ""}" style="background:${s.color};color:${s.color}"></i><span>${esc(s.name)}</span>`;
    b.title = "Show / hide";
    b.onclick = () => { hid.has(s.name) ? hid.delete(s.name) : hid.add(s.name); onChange(); };
    el.appendChild(b);
  }
}

function lineChart(el, o) {
  const W = el.clientWidth || 600, H = el.clientHeight || 240;
  const m = { l: 58, r: 14, t: o.top || 12, b: 36 };
  const iw = Math.max(10, W - m.l - m.r), ih = Math.max(10, H - m.t - m.b);
  const hid = S.hidden[o.key] || new Set();
  const vis = o.series.filter(s => !hid.has(s.name) && s.x.length);
  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  if (!vis.length) {
    el.innerHTML = svg + `<text class="empty-msg" x="${W / 2}" y="${H / 2}" text-anchor="middle">${esc(o.empty || "No data yet")}</text></svg>`;
    el.onmousemove = el.onmouseleave = null; return;
  }
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const s of vis) for (let i = 0; i < s.x.length; i++) {
    const x = s.x[i], y = s.y[i];
    if (y === null || !isFinite(y) || (o.ylog && y <= 0)) continue;
    if (x < xmin) xmin = x; if (x > xmax) xmax = x;
    if (y < ymin) ymin = y; if (y > ymax) ymax = y;
  }
  for (const h of o.hlines || []) { ymin = Math.min(ymin, h.y); ymax = Math.max(ymax, h.y); }
  if (o.xDomain) [xmin, xmax] = o.xDomain;
  if (xmax <= xmin) xmax = xmin + 1;
  let yT, sy;
  if (o.ylog) {
    let a = Math.floor(Math.log10(ymin)), b = Math.ceil(Math.log10(ymax));
    if (b <= a) b = a + 1;
    yT = []; const stepE = Math.max(1, Math.ceil((b - a) / 6));
    for (let e = a; e <= b; e += stepE) yT.push(Math.pow(10, e));
    sy = y => m.t + ih - (Math.log10(Math.max(y, 1e-300)) - a) / (b - a) * ih;
  } else {
    if (o.yDomain) [ymin, ymax] = o.yDomain;
    else { if (o.yZero !== false) ymin = Math.min(0, ymin); ymax = ymax + (ymax - ymin) * 0.06; }
    if (ymax <= ymin) ymax = ymin + 1;
    yT = niceTicks(ymin, ymax, Math.max(3, Math.round(ih / 50)));
    ymin = Math.min(ymin, yT[0]); ymax = Math.max(ymax, yT[yT.length - 1]);
    sy = y => m.t + ih - (y - ymin) / (ymax - ymin) * ih;
  }
  const sx = x => m.l + (x - xmin) / (xmax - xmin) * iw;
  const xT = o.xTicks || niceTicks(xmin, xmax, Math.max(3, Math.round(iw / 90)));

  // bands
  for (const [i, b] of (o.bands || []).entries()) {
    const x0 = sx(Math.max(b.x0, xmin)), x1 = sx(Math.min(b.x1, xmax));
    svg += `<rect x="${x0}" y="${m.t}" width="${Math.max(0, x1 - x0)}" height="${ih}" fill="${b.fill || (i % 2 ? "var(--zone-b)" : "var(--zone-a)")}"/>`;
    if (b.label) svg += `<text class="zone-label" x="${(x0 + x1) / 2}" y="${m.t - 6}" text-anchor="middle">${esc(b.label)}</text>`;
  }
  // grid + axes
  svg += `<g class="grid">`;
  for (const t of yT) svg += `<line x1="${m.l}" x2="${m.l + iw}" y1="${sy(t)}" y2="${sy(t)}"/>`;
  for (const g of o.colLines || []) if (g > xmin && g < xmax) svg += `<line x1="${sx(g)}" x2="${sx(g)}" y1="${m.t}" y2="${m.t + ih}" stroke-dasharray="2 3"/>`;
  svg += `</g><g class="axis">`;
  for (const t of yT) svg += `<text x="${m.l - 8}" y="${sy(t) + 4}" text-anchor="end">${o.ylog ? "1e" + Math.round(Math.log10(t)) : (o.fmtY || fmt)(t)}</text>`;
  for (const t of xT) if (t >= xmin - 1e-9 && t <= xmax + 1e-9) svg += `<text x="${sx(t)}" y="${m.t + ih + 16}" text-anchor="middle">${(o.fmtX || fmt)(t)}</text>`;
  svg += `<line x1="${m.l}" x2="${m.l + iw}" y1="${m.t + ih}" y2="${m.t + ih}"/></g>`;
  if (o.xTitle) svg += `<text class="axis-title" x="${m.l + iw / 2}" y="${H - 3}" text-anchor="middle">${esc(o.xTitle)}</text>`;
  if (o.yTitle) svg += `<text class="axis-title" transform="translate(12 ${m.t + ih / 2}) rotate(-90)" text-anchor="middle">${esc(o.yTitle)}</text>`;
  for (const h of o.hlines || []) svg += `<line x1="${m.l}" x2="${m.l + iw}" y1="${sy(h.y)}" y2="${sy(h.y)}" stroke="var(--ink-3)" stroke-dasharray="5 4"/><text class="axis-title" x="${m.l + 6}" y="${sy(h.y) - 5}" text-anchor="start">${esc(h.label)}</text>`;
  // series
  svg += `<g clip-path="none">`;
  for (const s of vis) {
    let d = "", pen = false;
    for (let i = 0; i < s.x.length; i++) {
      const y = s.y[i];
      if (y === null || !isFinite(y) || (o.ylog && y <= 0)) { pen = false; continue; }
      d += (pen ? "L" : "M") + sx(s.x[i]).toFixed(1) + " " + sy(y).toFixed(1); pen = true;
    }
    svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width || 2}" stroke-linejoin="round" stroke-linecap="round" ${s.dash ? `stroke-dasharray="${s.dash}"` : ""}/>`;
    if (s.dots) for (let i = 0; i < s.x.length; i++) if (s.y[i] !== null && isFinite(s.y[i])) svg += `<circle cx="${sx(s.x[i])}" cy="${sy(s.y[i])}" r="2.5" fill="${s.color}"/>`;
  }
  svg += `</g>`;
  // vertical markers
  for (const v of o.vlines || []) {
    if (v.x < xmin - 1e-9 || v.x > xmax + 1e-9) continue;
    const X = sx(v.x);
    svg += `<line x1="${X}" x2="${X}" y1="${m.t}" y2="${m.t + ih}" stroke="${v.color || "var(--ink-2)"}" stroke-width="${v.width || 1.2}" ${v.dash ? `stroke-dasharray="${v.dash}"` : ""}/>`;
    if (v.label) svg += `<g><rect x="${X - 9}" y="${m.t + 3}" width="18" height="16" rx="4" fill="${v.badge || "var(--ink-2)"}"/><text x="${X}" y="${m.t + 15}" text-anchor="middle" fill="#fff" font-size="10.5" font-weight="700">${esc(v.label)}</text></g>`;
  }
  svg += `<line class="crosshair" id="ch" x1="0" x2="0" y1="${m.t}" y2="${m.t + ih}" visibility="hidden"/>`;
  el.innerHTML = svg + "</svg>";
  const ch = el.querySelector("#ch");
  el.onmousemove = ev => {
    const r = el.getBoundingClientRect(), px = (ev.clientX - r.left) * (W / r.width);
    if (px < m.l || px > m.l + iw) { ch.setAttribute("visibility", "hidden"); tip.hide(); return; }
    const xv = xmin + (px - m.l) / iw * (xmax - xmin);
    const ref = vis[0], j = bsearch(ref.x, xv), xs = ref.x[j];
    ch.setAttribute("x1", sx(xs)); ch.setAttribute("x2", sx(xs)); ch.setAttribute("visibility", "visible");
    let html = `<div class="tt-head">${esc(o.tipX ? o.tipX(xs) : fmt(xs))}</div>`;
    for (const s of vis) {
      const k = bsearch(s.x, xs);
      html += `<div class="tt-row"><span><i style="background:${s.color}"></i>${esc(s.name)}</span><b>${(o.tipY || fmt)(s.y[k])}</b></div>`;
    }
    tip.show(html, ev.clientX, ev.clientY);
  };
  el.onmouseleave = () => { ch.setAttribute("visibility", "hidden"); tip.hide(); };
}

/* ============================================================ SETUP PANEL */
function setSeg(seg, v) { $$("button", seg).forEach(b => { const on = b.dataset.v === v; b.classList.toggle("on", on); b.setAttribute("aria-checked", on); }); }

const KIND_PATTERN = { 2: ["desorbent", "feed"], 3: ["desorbent", "extract", "feed"], 4: ["desorbent", "extract", "feed", "raffinate"],
  5: ["desorbent", "extract", "extract", "feed", "raffinate"], 6: ["desorbent", "extract", "extract", "feed", "raffinate", "raffinate"] };

function typicalFlow(kind) {
  const p = (S.cfg.ports || []).find(q => q.kind === kind && !q.balance);
  return p ? p.flow : { desorbent: 2, feed: 0.5, extract: 1, raffinate: 1 }[kind];
}
/* Keep the port list consistent with the zones: one port at the start of every zone, plus the
   end-of-train outlet in an open loop; exactly one balance outlet. */
function normalizePorts(cfg) {
  const nz = cfg.zones.length;
  const endOld = cfg.ports.find(p => cfg.open_loop && p.balance && p.zone === 0 && !INLETS.includes(p.kind) && p._end);
  const zonePorts = [];
  for (let z = 0; z < nz; z++) {
    let p = cfg.ports.find(q => q.zone === z && !q._end);
    if (!p) { const kind = (KIND_PATTERN[nz] || KIND_PATTERN[4])[z] || "extract"; p = { kind, zone: z, flow: typicalFlow(kind), balance: false }; }
    zonePorts.push(Object.assign({}, p, { zone: z }));
  }
  let ports = zonePorts;
  if (cfg.open_loop) {
    ports.forEach(p => p.balance = false);
    const end = endOld ? Object.assign({}, endOld) : { kind: "raffinate", zone: 0, flow: 0, balance: true };
    end._end = true; end.balance = true; end.zone = 0;
    ports = ports.concat([end]);
  } else {
    const outs = ports.filter(p => !INLETS.includes(p.kind));
    ports.forEach(p => { if (INLETS.includes(p.kind)) p.balance = false; });
    const nb = outs.filter(p => p.balance).length;
    if (outs.length && nb !== 1) { outs.forEach(p => p.balance = false); outs[outs.length - 1].balance = true; }
  }
  cfg.ports = ports;
}
function stripEnd(cfg) {        // the _end marker is UI-only
  const c = clone(cfg); c.ports.forEach(p => delete p._end); return c;
}
function markEnd(cfg) {          // restore the _end marker after loading a config
  if (cfg.open_loop) {
    const e = cfg.ports.find(p => p.balance && p.zone === 0 && !INLETS.includes(p.kind));
    if (e) e._end = true;
  }
  return cfg;
}
function splitColumns(n, weights) {
  const tot = weights.reduce((a, b) => a + b, 0);
  const out = weights.map(w => Math.max(1, Math.round(n * w / tot)));
  let diff = n - out.reduce((a, b) => a + b, 0), i = 0;
  while (diff !== 0 && i < 100) { const k = i % out.length; if (diff > 0) { out[k]++; diff--; } else if (out[k] > 1) { out[k]--; diff++; } i++; }
  return out;
}
function applyLayout(kind) {
  const c = S.cfg, n = Math.min(S.maxColumns, c.zones.reduce((a, b) => a + b, 0));
  const f = k => typicalFlow(k);
  if (kind === "classic") {
    c.open_loop = false; c.zones = splitColumns(n, [5, 4, 4, 3]);
    c.ports = [{ kind: "desorbent", zone: 0, flow: f("desorbent") }, { kind: "extract", zone: 1, flow: f("extract") },
      { kind: "feed", zone: 2, flow: f("feed") }, { kind: "raffinate", zone: 3, flow: 0, balance: true }];
  } else if (kind === "open3") {
    // keep the current zone I and II flows: in an open loop the desorbent alone supplies zone I
    const zf = S.derived && S.derived.zone_flows ? S.derived.zone_flows : null;
    const qD = zf ? zf[0] : f("desorbent"), qE = zf && zf.length > 1 ? Math.max(0.01, zf[0] - zf[1]) : f("extract");
    c.open_loop = true; c.zones = splitColumns(n, [4, 4, 4]);
    c.ports = [{ kind: "desorbent", zone: 0, flow: +qD.toPrecision(4) }, { kind: "extract", zone: 1, flow: +qE.toPrecision(4) },
      { kind: "feed", zone: 2, flow: f("feed") }, { kind: "raffinate", zone: 0, flow: 0, balance: true, _end: true }];
  } else if (kind === "five") {
    c.open_loop = false; c.zones = splitColumns(n, [4, 2, 3, 4, 3]);
    const fe = f("extract");
    c.ports = [{ kind: "desorbent", zone: 0, flow: f("desorbent") }, { kind: "extract", zone: 1, flow: fe * 0.6 },
      { kind: "extract", zone: 2, flow: fe * 0.4 }, { kind: "feed", zone: 3, flow: f("feed") }, { kind: "raffinate", zone: 4, flow: 0, balance: true }];
  }
  normalizePorts(c); renderSetup(); onCfgChange();
}

function renderSetup() {
  const c = S.cfg;
  setSeg($("#schemeSeg"), c.scheme); setSeg($("#flowSeg"), c.flow_model);
  setSeg($("#poroSeg"), c.porosity_spec); setSeg($("#dispSeg"), c.dispersion_spec);
  $("#schemeHint").textContent = (S.schemes[c.scheme] || {}).summary || "";
  $("#flowHint").textContent = c.flow_model === "constant"
    ? "Liquid flow is uniform inside each zone."
    : "Liquid flow varies along each column as components of different density adsorb and desorb; total liquid volume is conserved.";
  const iso = $("#isotherm");
  iso.innerHTML = Object.entries(S.isotherms).map(([k, v]) => `<option value="${esc(k)}">${esc(v.label)}</option>`).join("");
  iso.value = c.isotherm;
  $("#isoEq").textContent = (S.isotherms[c.isotherm] || {}).equation || "";
  $("#poroTotal").hidden = c.porosity_spec !== "total"; $("#poroSplit").hidden = c.porosity_spec !== "split";
  $("#dispPe").hidden = c.dispersion_spec !== "peclet"; $("#dispDp").hidden = c.dispersion_spec !== "particle";
  $$("[data-k]").forEach(inp => {
    const v = c[inp.dataset.k];
    if (inp.type === "checkbox") inp.checked = !!v;
    else if (document.activeElement !== inp) inp.value = typeof v === "number" ? +v.toPrecision(8) : v;
  });
  $("#loopSel").value = c.open_loop ? "open" : "closed";
  $("#nzSel").innerHTML = Array.from({ length: S.maxZones - 1 }, (_, i) => i + 2).map(k => `<option value="${k}">${k} zones</option>`).join("");
  $("#nzSel").value = c.zones.length;
  $("#q1Field").hidden = !!c.open_loop;
  renderComponents(); renderZoneTable(); renderDerived(); updatePill();
}

function renderComponents() {
  const c = S.cfg, list = $("#compList");
  list.innerHTML = c.components.map((p, i) => `
    <div class="comp" data-i="${i}">
      <div class="comp-top">
        <span class="swatch" style="background:${compColor(i)}"></span>
        <input type="text" data-f="name" value="${esc(p.name)}" aria-label="Component name">
        <select data-f="role" aria-label="Target outlet">
          ${["extract", "raffinate", "desorbent"].map(r => `<option value="${r}" ${p.role === r ? "selected" : ""}>${r === "desorbent" ? "Desorbent" : "→ " + ROLE_LABEL[r]}</option>`).join("")}
        </select>
        <button class="x" data-del="${i}" title="Remove component" ${c.components.length <= 2 ? "disabled" : ""}>×</button>
      </div>
      <div class="comp-grid">
        ${cf("qsat", "Q<sub>sat</sub> g/mL", p)}${cf("keq", "K mL/g", p)}${cf("kap", "k<sub>LDF</sub> 1/min", p)}
        ${cf("rho", "ρ g/mL", p)}${cf("feed_frac", "Feed vol. frac.", p)}${cf("des_frac", "Desorbent vol. frac.", p)}
      </div>
    </div>`).join("");
  renderSums();
  $("#addComp").disabled = c.components.length >= 10;
}
const cf = (f, label, p) => `<label class="field"><span>${label}</span><input type="number" step="any" data-f="${f}" value="${p[f]}"></label>`;
function renderSums() {
  const c = S.cfg, ok = v => Math.abs(v - 1) <= 1e-3;
  const fs = c.components.reduce((a, p) => a + (+p.feed_frac || 0), 0), ds = c.components.reduce((a, p) => a + (+p.des_frac || 0), 0);
  $("#fracSums").innerHTML = `<span>Feed Σ <b class="${ok(fs) ? "ok" : "no"}">${fs.toFixed(3)}</b></span><span>Desorbent Σ <b class="${ok(ds) ? "ok" : "no"}">${ds.toFixed(3)}</b></span>`;
}

function renderZoneTable() {
  const c = S.cfg, nz = c.zones.length, n = c.zones.reduce((a, b) => a + b, 0);
  const lay = layoutOf(c), d = S.derived;
  const pf = d && d.port_flows ? d.port_flows : null;
  let h = `<thead><tr><th>Zone</th><th>Columns</th><th>Port at zone start</th><th>Flow, mL/min</th>${c.open_loop ? "" : `<th class="bal" title="Outlet whose flow is computed from the liquid balance">Bal.</th>`}</tr></thead><tbody>`;
  c.ports.forEach((p, i) => {
    if (p._end) return;
    const z = p.zone, isOut = !INLETS.includes(p.kind);
    h += `<tr><td class="zname">${ZONES[z]}</td>
      <td><input class="ncol" type="number" min="1" step="1" data-zone="${z}" value="${c.zones[z]}" aria-label="Columns in zone ${ZONES[z]}"></td>
      <td><select data-pk="${i}" aria-label="Port at the start of zone ${ZONES[z]}">${Object.entries(KIND_LABEL).map(([k, l]) => `<option value="${k}" ${p.kind === k ? "selected" : ""}>${lay.ports[i].label} · ${l}</option>`).join("")}</select></td>
      <td>${p.balance ? `<span class="computed" data-ci="${i}">${pf ? fmt(pf[i]) : "–"} (balance)</span>` : `<input class="flow" type="number" step="any" min="0" data-pf="${i}" value="${p.flow}">`}</td>
      ${c.open_loop ? "" : `<td class="bal">${isOut ? `<input type="radio" name="balport" data-pb="${i}" ${p.balance ? "checked" : ""} aria-label="Balance outlet">` : ""}</td>`}</tr>`;
  });
  if (c.open_loop) {
    const ie = c.ports.findIndex(p => p._end), e = c.ports[ie];
    if (e) h += `<tr class="endrow"><td class="zname">end</td><td></td>
      <td><select data-pk="${ie}" aria-label="Outlet at the end of the last zone">${["raffinate", "extract"].map(k => `<option value="${k}" ${e.kind === k ? "selected" : ""}>${lay.ports[ie].label} · ${KIND_LABEL[k]}</option>`).join("")}</select></td>
      <td><span class="computed" data-ci="${ie}" data-suffix="all remaining">${pf ? fmt(pf[ie]) : "–"} (all remaining)</span></td></tr>`;
  }
  $("#zoneTable").innerHTML = h + "</tbody>";
  $("#colCount").innerHTML = `${n} of at most ${S.maxColumns} columns. Ports act at the start of each zone, in the direction of flow.` +
    (c.open_loop ? " Open loop: nothing is recycled; the zone I flow equals the inlet flow at its start." : "");
  // layout strip
  let st = "";
  c.ports.forEach((p, i) => {
    if (p._end) return;
    st += `<span class="ls-port" style="background:${portColor(c, p.kind)}">${lay.ports[i].label}</span><span class="ls-arrow">›</span><span class="ls-zone">${ZONES[p.zone]} · ${c.zones[p.zone]}</span><span class="ls-arrow">›</span>`;
  });
  if (c.open_loop) { const ie = c.ports.findIndex(p => p._end); if (ie >= 0) st += `<span class="ls-port" style="background:${portColor(c, c.ports[ie].kind)}">${lay.ports[ie].label}</span><span class="ls-arrow">out</span>`; }
  else st += `<span class="ls-arrow" title="recycle to zone I">↺</span>`;
  $("#layoutStrip").innerHTML = st;
}

function renderDerived() {
  const c = S.cfg, d = S.derived;
  updateChips();
  if (!d) { $("#derived").innerHTML = ""; return; }
  const nz = c.zones.length;
  const row = (lab, arr, dig = 3) => `<tr><td>${lab}</td>${arr.map(v => `<td>${v === null || !isFinite(v) ? "–" : (+v).toFixed(dig)}</td>`).join("")}</tr>`;
  $("#derived").innerHTML = `
    <table><thead><tr><th></th>${c.zones.map((_, i) => `<th>${ZONES[i]}</th>`).join("")}</tr></thead><tbody>
      ${row("Columns", c.zones, 0)}
      ${row("Flow, mL/min", d.zone_flows, 2)}
      ${row("m-value", d.m_values)}
      ${c.dead_length > 0 ? row("m incl. dead vol.", d.m_values_dead) : ""}
      ${row("u, cm/min", d.velocity, 1)}
      ${row("D<sub>ax</sub>, cm²/min", d.dispersion, 3)}
    </tbody></table>
    <div class="kv"><span>Balance outlet flow</span><b>${fmt(d.balance_flow)} mL/min</b></div>
    <div class="kv"><span>Desorbent / feed</span><b>${fmt(d.desorbent_to_feed)}</b></div>
    <div class="kv"><span>Bed volume</span><b>${fmt(d.bed_volume)} mL</b></div>
    <div class="kv"><span>Full cycle</span><b>${d.n_columns} switches · ${fmt(d.cycle_time)} min</b></div>`;
  $("#dvSize").innerHTML = `<span>Area <b>${fmt(d.area)} cm²</b></span><span>Column volume <b>${fmt(d.column_volume)} mL</b></span><span>Pore volume <b>${fmt(d.pore_volume)} mL</b></span>`;
  $("#dvPoro").innerHTML = c.porosity_spec === "split"
    ? `<span>ε<sub>t</sub> = ε<sub>b</sub> + (1 − ε<sub>b</sub>)·ε<sub>p</sub> = <b>${fmt(d.porosity, 4)}</b></span>`
    : `<span>Liquid holds <b>${fmt(100 * d.porosity, 1)}%</b> of the column volume</span>`;
  $("#dvDisp").innerHTML = (c.dispersion_spec === "particle" ? `<span>Pe = Pe<sub>p</sub>·L/d<sub>p</sub> = <b>${fmt(d.peclet)}</b></span>` : "") +
    `<span>D<sub>ax</sub> = u·L/Pe, zone I: <b>${fmt(d.dispersion[0])} cm²/min</b></span><span title="u uses the total porosity">u (zone I) <b>${fmt(d.velocity[0])} cm/min</b></span>`;
  $("#dvDead").innerHTML = c.dead_length > 0
    ? `<span>Dead volume <b>${fmt(d.dead_volume)} mL</b> per column = <b>${fmt(100 * d.dead_volume / d.pore_volume, 0)}%</b> of its pore volume</span>`
    : `<span>No extra-column volume.</span>`;
  $$("#zoneTable .computed").forEach(sp => { const i = +sp.dataset.ci; sp.textContent = `${fmt(d.port_flows[i])} (${sp.dataset.suffix || "balance"})`; });
}
function updateChips() {
  const c = S.cfg, d = S.derived, ps = $("#presetSel");
  $("#chipCase").textContent = ps && ps.value ? (S.presets[ps.value] || {}).label || "" : "custom";
  $("#chipModel").textContent = `${(S.schemes[c.scheme] || {}).label || c.scheme} · ${c.flow_model === "constant" ? "constant flow" : "volume change"}`;
  $("#chipComp").textContent = `${c.components.length} components`;
  $("#chipCol").textContent = d ? `r ${fmt(c.radius)} × ${fmt(c.length)} cm · ε ${fmt(d.porosity, 3)} · Pe ${fmt(d.peclet)}` : "";
  $("#chipLayout").textContent = `${c.zones.reduce((a, b) => a + b, 0)} col · ${c.zones.join("-")} · ${c.open_loop ? "open" : "closed"}`;
  $("#chipNum").textContent = `${c.nodes} nodes · tol ${c.css_tol}`;
}
function updatePill() {
  const c = S.cfg;
  $("#modePill").textContent = `${(S.schemes[c.scheme] || {}).label || c.scheme} · ${c.flow_model === "constant" ? "Constant flow" : "Volume change"}`;
}
function onCfgChange() {
  updatePill(); updateChips();
  clearTimeout(S.validateTimer);
  S.validateTimer = setTimeout(validate, 220);
  if (!S.view || S.view.empty) { S.view = null; renderUnit(true); }
}
async function validate() {
  const { data } = await api("/api/validate", stripEnd(S.cfg));
  S.errors = data.errors || [];
  S.derived = data.derived || null;
  const box = $("#errors");
  box.hidden = !S.errors.length;
  box.innerHTML = S.errors.length ? `<ul>${S.errors.map(e => `<li>${esc(e)}</li>`).join("")}</ul>` : "";
  $("#runBtn").disabled = $("#runBothBtn").disabled = !!S.errors.length || !!S.job;
  renderDerived();
  // refresh computed balance flows in the table without rebuilding inputs being edited
  const act = document.activeElement;
  if (!act || !$("#zoneTable").contains(act)) renderZoneTable();
}

function bindSetup() {
  const segBind = (sel, key, after) => $(sel).onclick = e => { const v = e.target.closest("button")?.dataset.v; if (v) { S.cfg[key] = v; renderSetup(); onCfgChange(); after && after(); } };
  segBind("#schemeSeg", "scheme"); segBind("#flowSeg", "flow_model");
  segBind("#poroSeg", "porosity_spec"); segBind("#dispSeg", "dispersion_spec");
  $("#isotherm").onchange = e => { S.cfg.isotherm = e.target.value; renderSetup(); onCfgChange(); };
  $("#loopSel").onchange = e => { S.cfg.open_loop = e.target.value === "open"; normalizePorts(S.cfg); renderSetup(); onCfgChange(); };
  $("#nzSel").onchange = e => {
    const nz = +e.target.value, c = S.cfg, n = c.zones.reduce((a, b) => a + b, 0);
    const w = { 2: [1, 1], 3: [1, 1, 1], 4: [5, 4, 4, 3], 5: [4, 2, 3, 4, 3], 6: [3, 2, 3, 3, 3, 2] }[nz];
    c.zones = splitColumns(Math.max(n, nz), w);
    c.ports = c.ports.filter(p => p._end || p.zone < nz);
    const pat = KIND_PATTERN[nz];
    for (let z = 0; z < nz; z++) {          // re-pattern the port kinds for a fresh layout
      const p = c.ports.find(q => q.zone === z && !q._end);
      if (p) p.kind = pat[z]; else c.ports.push({ kind: pat[z], zone: z, flow: typicalFlow(pat[z]) });
    }
    c.ports.sort((a, b) => (a._end ? 99 : a.zone) - (b._end ? 99 : b.zone));
    c.ports.forEach(p => { if (!p._end) p.balance = false; });
    normalizePorts(c); renderSetup(); onCfgChange();
  };
  $$("[data-layout]").forEach(b => b.onclick = () => applyLayout(b.dataset.layout));
  $("#setup").addEventListener("input", e => {
    const t = e.target, c = S.cfg;
    if (t.dataset.k) {
      const k = t.dataset.k;
      c[k] = t.type === "checkbox" ? t.checked : (t.step === "1" ? parseInt(t.value, 10) : parseFloat(t.value));
      t.classList.toggle("invalid", t.type === "number" && !isFinite(c[k]));
    } else if (t.dataset.zone !== undefined) {
      c.zones[+t.dataset.zone] = parseInt(t.value, 10) || 0;
    } else if (t.dataset.pf !== undefined) {
      c.ports[+t.dataset.pf].flow = parseFloat(t.value);
    } else if (t.dataset.f) {
      const i = +t.closest(".comp").dataset.i, f = t.dataset.f, p = c.components[i];
      p[f] = (f === "name" || f === "role") ? t.value : parseFloat(t.value);
      if (f !== "name" && f !== "role") renderSums();
    } else return;
    markCustom(); onCfgChange();
  });
  $("#setup").addEventListener("change", e => {
    const t = e.target, c = S.cfg;
    if (t.dataset.f === "role") renderComponents();
    if (t.dataset.pk !== undefined) {
      const p = c.ports[+t.dataset.pk]; p.kind = t.value;
      if (INLETS.includes(p.kind) && p.balance && !p._end) p.balance = false;
      normalizePorts(c); renderZoneTable(); markCustom(); onCfgChange();
    }
    if (t.dataset.pb !== undefined) {
      c.ports.forEach((p, i) => p.balance = i === +t.dataset.pb);
      renderZoneTable(); markCustom(); onCfgChange();
    }
    if (t.dataset.zone !== undefined) { renderZoneTable(); }
  });
  $("#compList").onclick = e => {
    const d = e.target.closest("[data-del]");
    if (d) { S.cfg.components.splice(+d.dataset.del, 1); renderComponents(); markCustom(); onCfgChange(); }
  };
  $("#addComp").onclick = () => {
    const n = S.cfg.components.length + 1;
    S.cfg.components.push({ name: `Component ${n}`, role: "raffinate", qsat: 0.4, keq: 10, kap: 1, rho: 0.85, feed_frac: 0, des_frac: 0 });
    renderComponents(); markCustom(); onCfgChange();
  };
  $("#resetBtn").onclick = () => { S.cfg = markEnd(clone(S.defaults)); renderSetup(); onCfgChange(); };
  $("#exportBtn").onclick = () => download("smb_setup.json", JSON.stringify(stripEnd(S.cfg), null, 2), "application/json");
  $("#importFile").onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      const { ok, data } = await api("/api/normalize", d.config || d);
      S.cfg = markEnd(ok ? data.config : Object.assign(clone(S.defaults), d.config || d));
      normalizePorts(S.cfg); markCustom(); renderSetup(); onCfgChange();
    } catch (err) { alertStatus(`Could not read ${f.name}: ${err.message}`); }
    e.target.value = "";
  };
  $("#runBtn").onclick = () => startRuns([stripEnd(S.cfg)]);
  $("#runBothBtn").onclick = () => {
    const a = stripEnd(S.cfg), b = stripEnd(S.cfg);
    a.scheme = "original"; b.scheme = "conservative";
    startRuns([a, b]);
  };
  $("#cancelBtn").onclick = async () => { S.queue = []; if (S.job) await api(`/api/job/${S.job.id}/cancel`, {}); };
}
function markCustom() { const ps = $("#presetSel"); if (ps.value) { ps.value = ""; $("#presetHint").textContent = "Edited from a test case."; } }
function alertStatus(msg) { $("#statusText").innerHTML = esc(msg); }

/* ================================================================== RUNS */
function modeLabel(cfg) { return `${(S.schemes[cfg.scheme] || {}).label || cfg.scheme} mode · ${cfg.flow_model === "constant" ? "constant flow" : "volume change"}`; }
async function startRuns(cfgs) { if (S.job) return; S.queue = cfgs.slice(); nextRun(); }
async function nextRun() {
  const cfg = S.queue.shift();
  if (!cfg) return;
  const { ok, data } = await api("/api/run", cfg);
  if (!ok) { alertStatus((data.errors || ["Could not start the run."]).join(" ")); return; }
  S.job = { id: data.id, cfg };
  S.r0 = null; stopPlay();
  $("#cancelBtn").hidden = false;
  $("#runBtn").disabled = $("#runBothBtn").disabled = true;
  $("#progressFill").classList.remove("done"); $("#progressFill").style.width = "2%";
  $("#statusText").innerHTML = `Running <b>${esc(modeLabel(cfg))}</b>… starting`;
  poll();
}
async function poll() {
  if (!S.job) return;
  const { data } = await api(`/api/job/${S.job.id}`);
  const cfg = S.job.cfg;
  if (data.status === "running") {
    const p = data.progress;
    if (p) {
      if (S.r0 === null) S.r0 = p.residual;
      const frac = S.r0 > cfg.css_tol ? Math.log(S.r0 / Math.max(p.residual, cfg.css_tol)) / Math.log(S.r0 / cfg.css_tol) : 0;
      $("#progressFill").style.width = `${Math.max(3, Math.min(97, 100 * frac))}%`;
      const last = p.history[p.history.length - 1] || {};
      $("#statusText").innerHTML = `Running <b>${esc(modeLabel(cfg))}</b> · cycle ${p.cycle.toFixed(0)} · residual ${p.residual.toExponential(1)} (target ${cfg.css_tol.toExponential(0)}) · extract purity ${pct(last.extract_purity)}% · ${fmtTime(p.elapsed)}`;
      showLive(cfg, p);
    }
    setTimeout(poll, 500);
    return;
  }
  S.job = null; $("#cancelBtn").hidden = true;
  if (data.status === "done") {
    const r = data.result, run = { id: data.id, cfg, result: r };
    S.runs.push(run);
    $("#progressFill").style.width = "100%"; $("#progressFill").classList.add("done");
    $("#statusText").innerHTML = `<b>${esc(modeLabel(cfg))}</b> ${r.converged ? "reached cyclic steady state" : "stopped at the cycle limit"} after ${r.cycles.toFixed(1)} cycles in ${fmtTime(r.elapsed)}.`;
    select(run);
  } else if (data.status === "cancelled") {
    $("#progressFill").style.width = "0"; alertStatus("Run cancelled."); if (S.selected) select(S.selected);
  } else {
    $("#progressFill").style.width = "0"; alertStatus(`The run failed: ${data.error}`);
  }
  validate();
  if (S.queue.length) nextRun();
}

/* ================================================================= VIEWS */
function makeView(cfg, x, frames, extra = {}) {
  const lay = layoutOf(cfg), N = x.length;
  return Object.assign({ cfg, x, frames, n: lay.n, m: N / lay.n, pitch: lay.pitch, ports: lay.ports, starts: lay.starts,
    nz: lay.nz, nc: cfg.components.length }, extra);
}
function emptyView() {
  const cfg = stripEnd(S.cfg), lay = layoutOf(cfg), m = 6;
  const x = []; for (let k = 0; k < lay.n; k++) for (let j = 0; j < m; j++) x.push(k * lay.pitch + (j + 0.5) / m * lay.pitch);
  return makeView(cfg, x, [{ t: 0, C: cfg.components.map(() => new Array(x.length).fill(0)) }], { empty: true });
}
function showLive(cfg, p) {
  S.view = makeView(cfg, p.profile.x, [{ t: cfg.step_time, C: p.profile.C }], { live: true, history: p.history });
  S.frame = 0; S.switchNo = 0;
  renderAll();
}
function select(run) {
  S.selected = run;
  const r = run.result;
  S.view = makeView(run.cfg, r.x, r.frames, { result: r, history: r.history, m: r.cells_per_column, pitch: r.column_pitch, ports: r.ports });
  S.frame = 0; S.switchNo = 0; S.anim = null;
  $("#scrub").max = r.frames.length - 1; $("#scrub").value = S.frame;
  $("#csvBtn").disabled = false;
  S.outletIdx = Math.min(S.outletIdx, (r.outlet_labels || []).length - 1);
  renderAll();
  startPlay();
}
function renderAll() {
  renderKPIs(); renderUnit(true); renderProfiles(); renderProducts(); renderConvergence(); renderRuns(); renderSwitchHint();
}

/* ------------------------------------------------- switching helpers
   The simulation is stored in the port frame: index 0 is the first column of zone I.
   In the plant the columns stay put and every switch moves all ports one column downstream.
   After s switches, physical column p therefore sits at port-frame position (p - s) mod n. */
function shift(v) { return v && !v.live && !v.empty ? ((S.switchNo % v.n) + v.n) % v.n : 0; }
function portCol(v, p) { return ((p - shift(v)) % v.n + v.n) % v.n; }
function toLab(v, arr) {
  const m = Math.round(v.m), out = new Array(arr.length);
  for (let p = 0; p < v.n; p++) { const k = portCol(v, p); for (let j = 0; j < m; j++) out[p * m + j] = arr[k * m + j]; }
  return out;
}
function curFrame(v) { return v.frames[Math.min(S.frame, v.frames.length - 1)]; }
function animProgress() {
  if (!S.anim) return 1;
  const a = (performance.now() - S.anim.t0) / S.anim.dur;
  if (a >= 1) { S.anim = null; return 1; }
  return 1 - Math.pow(1 - a, 3);            // ease-out
}

/* ================================================================= KPIs */
function renderKPIs() {
  const v = S.view, el = $("#kpis");
  const r = v && v.result, mt = r && r.metrics;
  const cfg = v ? v.cfg : S.cfg;
  const prev = r ? S.runs[S.runs.indexOf(S.selected) - 1] : null;
  const pm = prev && prev.result.metrics;
  const live = v && v.live ? v.history[v.history.length - 1] : null;
  const val = k => mt ? mt[k] : live ? live[k] : null;
  const delta = k => {
    if (!mt || !pm || pm[k] === null || mt[k] === null) return "";
    const d = mt[k] - pm[k];
    if (Math.abs(d) < 0.005) return "";
    return `<span class="delta ${d > 0 ? "up" : "down"}" title="Change from the previous run">${d > 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(2)}</span>`;
  };
  const tile = (label, value, unit, sub, barPct, key) =>
    `<div class="kpi ${value === null ? "placeholder" : ""}"><div class="k-label">${label}</div>
      <div class="k-value">${value === null || value === undefined ? "–" : value}${value !== null && unit ? `<small>${unit}</small>` : ""}${key ? delta(key) : ""}</div>
      <div class="k-sub">${sub}</div>${barPct !== undefined && barPct !== null ? `<div class="k-bar" style="width:${Math.max(0, Math.min(100, barPct))}%"></div>` : ""}</div>`;
  const P = k => { const x = val(k); return x === null || x === undefined ? null : pct(x); };
  const E = esc(namesWithRole(cfg, "extract")), R = esc(namesWithRole(cfg, "raffinate"));
  const dF = mt ? mt.desorbent_to_feed : (S.derived ? S.derived.desorbent_to_feed : null);
  el.innerHTML =
    tile("Extract purity", P("extract_purity"), "%", `${E} in extract`, val("extract_purity"), "extract_purity") +
    tile("Extract recovery", P("extract_recovery"), "%", `of ${E} fed`, val("extract_recovery"), "extract_recovery") +
    tile("Raffinate purity", P("raffinate_purity"), "%", `${R} in raffinate`, val("raffinate_purity"), "raffinate_purity") +
    tile("Raffinate recovery", P("raffinate_recovery"), "%", `of ${R} fed`, val("raffinate_recovery"), "raffinate_recovery") +
    tile("Productivity", mt ? fmt(mt.productivity) : null, "", "mL feed / mL bed / h") +
    tile("Desorbent / feed", dF === null ? null : fmt(dF), "", "volume ratio") +
    tile("Cycles to steady state", r ? r.cycles.toFixed(1) : live ? live.cycle.toFixed(0) : null, "",
      r ? `${r.converged ? "converged" : "not converged"} · ${fmtTime(r.elapsed)}` : live ? "running…" : "–") +
    tile("Mass balance closure", mt ? fmt(mt.mass_closure_max_dev, 2) : null, "%", "largest deviation, any component");
}

/* ======================================================== PROCESS VIEW */
function renderUnit(rebuild) {
  setSeg($("#unitSeg"), S.unitMode); setSeg($("#motionSeg"), S.motion);
  $("#processWrap").hidden = S.unitMode !== "process"; $("#ringWrap").hidden = S.unitMode !== "ring";
  $("#motionSeg").hidden = $("#fillSeg").hidden = S.unitMode !== "process";
  const v = S.view || emptyView();
  if (S.unitMode === "process") drawProcess(); else renderRing(rebuild);
  renderProcessLegend(v);
  const sub = v.empty ? "Run the simulation to see the columns fill and separate"
    : v.live ? "Live: end of the latest switch while the run converges"
    : S.motion === "valves" ? "As in the plant: columns stay put, the four ports step downstream every switch"
    : "Equivalent moving bed: ports stay put, the columns step upstream every switch";
  $("#unitSub").textContent = sub;
  updateScrubLabel();
}
function renderProcessLegend(v) {
  const cfg = v.cfg;
  $("#processLegend").innerHTML = cfg.components.map((c, i) => `<span><i style="background:${compColor(i)};opacity:${c.role === "desorbent" ? 0.3 : 1}"></i>${esc(c.name)}</span>`).join("") +
    (S.fill === "solutes"
      ? `<span class="muted">· column fill = composition of the dissolved solutes; stronger colour = more concentrated · pipe width = flow</span>`
      : `<span class="muted">· column fill = full liquid composition (pale = desorbent) · pipe width = flow</span>`);
}

let drawPending = false;
function requestDraw() { if (!drawPending) { drawPending = true; requestAnimationFrame(() => { drawPending = false; drawProcess(); }); } }

function drawProcess() {
  if (S.unitMode !== "process") return;
  const cv = $("#process"), v = S.view || emptyView();
  const W = cv.clientWidth || 900, H = cv.clientHeight || 330, dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const cfg = v.cfg, n = v.n, m = Math.round(v.m), f = curFrame(v);
  const ink = css("--ink"), ink2 = css("--ink-2"), ink3 = css("--ink-3"), line = css("--line"), surf = css("--surface"), zoneA = css("--zone-a");
  const Lm = 30, Rm = 30, slot = (W - Lm - Rm) / n, tw = Math.max(8, Math.min(34, slot * 0.46));
  const y0 = 92, th = Math.max(80, H - 92 - 92), topP = y0 - 12, botP = y0 + th + 12, recY = H - 12;
  const sh = shift(v), a = animProgress(), lab = S.motion === "valves" && !v.live && !v.empty;
  const gx = fpos => Lm + fpos * slot;                  // x of a junction position (0..n)
  const cxs = slotPos => Lm + (slotPos + 0.5) * slot;    // x of a tube centre
  // flows (inlet flow of each port-frame column)
  const Fin = f.Fin || null;
  const zf = (v.result && v.result.zone_flows) || (S.derived && S.derived.zone_flows) || [];
  const fmax = Math.max(1e-9, ...(Fin || zf));
  const flowAt = k => Fin ? Fin[k] : zf[zoneOfColumn(v, k)] || 0;
  const pw = q => 1.2 + 3.8 * Math.max(0, q) / fmax;

  // ---- zone bands (positions in junction units)
  const offs = lab ? sh - (S.anim ? 1 - a : 0) : 0;
  const bounds = v.starts.concat([n]);
  g.font = "600 11px " + css("--sans");
  for (let z = 0; z < v.nz; z++) {
    let s0 = bounds[z] + offs, s1 = bounds[z + 1] + offs;
    const pieces = [];
    const norm = x => ((x % n) + n) % n;
    let A0 = norm(s0), len = s1 - s0;
    if (A0 + len <= n + 1e-9) pieces.push([A0, A0 + len]); else { pieces.push([A0, n]); pieces.push([0, A0 + len - n]); }
    pieces.forEach(([p0, p1], pi) => {
      g.fillStyle = z % 2 ? "rgba(127,127,127,0.0)" : zoneA;
      g.fillRect(gx(p0), 36, gx(p1) - gx(p0), botP + 14 - 36);
      g.strokeStyle = line; g.lineWidth = 1;
      g.beginPath(); g.moveTo(gx(p0) + 2, 40); g.lineTo(gx(p1) - 2, 40); g.stroke();
      const big = (p1 - p0) >= len / 2;
      if (big && gx(p1) - gx(p0) > 40) {
        g.fillStyle = ink3; g.textAlign = "center";
        const q = zf[z];
        const txt = `Zone ${ZONES[z]}` + (q !== undefined && gx(p1) - gx(p0) > 110 ? ` · ${fmt(q)} mL/min` : "");
        g.fillText(txt, (gx(p0) + gx(p1)) / 2, 32);
      }
    });
  }

  // ---- pipes between columns (fixed to the physical slots)
  const pipe = (j, q, broken) => {          // connection entering slot j (from slot j-1, or recycle for j = 0)
    g.lineWidth = pw(q); g.strokeStyle = broken ? line : ink3; g.globalAlpha = broken ? 1 : 0.55; g.setLineDash(broken ? [3, 4] : []);
    const xIn = cxs(j), x = gx(j);
    g.beginPath();
    if (j === 0) {
      const xl = cxs(n - 1);
      g.moveTo(xl, y0 + th); g.lineTo(xl, botP); g.lineTo(gx(n), botP); g.lineTo(gx(n), recY); g.lineTo(gx(0) - 8, recY);
      g.lineTo(gx(0) - 8, topP); g.lineTo(xIn, topP); g.lineTo(xIn, y0);
    } else {
      const xp = cxs(j - 1);
      g.moveTo(xp, y0 + th); g.lineTo(xp, botP); g.lineTo(x, botP); g.lineTo(x, topP); g.lineTo(xIn, topP); g.lineTo(xIn, y0);
    }
    g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
  };
  for (let slotJ = 0; slotJ < n; slotJ++) {
    const kJ = lab ? portCol(v, slotJ) : slotJ;               // port-frame column entering at this slot
    const broken = cfg.open_loop && kJ === 0;                  // open loop: no recycle into zone I
    pipe(slotJ, flowAt(kJ), broken);
  }

  // ---- tubes
  const compRGB = cfg.components.map((_, i) => hexToRgb(compColor(i)));
  const isDes = cfg.components.map(c => c.role === "desorbent");
  const order = cfg.components.map((_, i) => i).sort((p, q) => (isDes[p] - isDes[q]) || p - q);
  const fr = [];   // cell boundaries along a column (fractions), from grid positions
  for (let j = 0; j <= m; j++) fr.push(j / m);
  if (v.x && v.x.length === n * m) {
    const xs = []; for (let j = 0; j < m; j++) xs.push((v.x[j] - 0) / v.pitch);
    for (let j = 1; j < m; j++) fr[j] = (xs[j - 1] + xs[j]) / 2;
  }
  const solutesOnly = S.fill === "solutes";
  if (solutesOnly && v.soluteMax === undefined) {
    let mx = 1e-12;
    v.frames.forEach(fr2 => { for (let q = 0; q < v.x.length; q++) { let s2 = 0; cfg.components.forEach((c, i) => { if (!isDes[i]) s2 += fr2.C[i][q]; }); if (s2 > mx) mx = s2; } });
    v.soluteMax = mx;
  }
  const desRGB = compRGB[isDes.indexOf(true)] || [200, 200, 200];
  const drawTube = (xc, k, alpha, label) => {
    const x = xc - tw / 2;
    g.globalAlpha = alpha;
    g.fillStyle = surf; g.fillRect(x, y0, tw, th);
    if (solutesOnly) { g.fillStyle = `rgba(${desRGB[0]},${desRGB[1]},${desRGB[2]},0.13)`; g.fillRect(x, y0, tw, th); }
    for (let j = 0; j < m; j++) {
      const yA = y0 + fr[j] * th, yB = y0 + fr[j + 1] * th;
      let tot = 0; const cs = order.map(i => { const c = (solutesOnly && isDes[i]) ? 0 : Math.max(0, f.C[i][k * m + j] || 0); tot += c; return c; });
      if (tot <= 0) continue;
      const strength = solutesOnly ? Math.min(1, 0.12 + 0.88 * Math.sqrt(tot / v.soluteMax)) : 1;
      let xx = x;
      order.forEach((i, oi) => {
        const w = tw * cs[oi] / tot; if (w <= 0.05) return;
        const [rr, gg, bb] = compRGB[i];
        g.fillStyle = `rgba(${rr},${gg},${bb},${isDes[i] ? 0.22 : 0.95 * strength})`;
        g.fillRect(xx, yA, w + 0.3, yB - yA + 0.4); xx += w;
      });
    }
    g.strokeStyle = ink2; g.lineWidth = 1.2; g.strokeRect(x, y0, tw, th);
    g.fillStyle = ink3; g.font = "10px " + css("--sans"); g.textAlign = "center";
    g.fillText(label, xc, botP + 15);
    g.globalAlpha = 1;
  };
  g.save(); g.beginPath(); g.rect(Lm - 4, 0, n * slot + 8, H); g.clip();
  if (lab || v.live || v.empty) {
    for (let p = 0; p < n; p++) drawTube(cxs(p), lab ? portCol(v, p) : p, 1, String(p + 1));
  } else {   // bed moves: tube k drawn at slot k, sliding in from k+1 during the switch animation
    const o = S.anim ? 1 - a : 0;
    for (let k = 0; k < n; k++) drawTube(cxs(k + o), k, 1, String(((k + sh) % n) + 1));
    if (S.anim) drawTube(cxs(-1 + o), n - 1, Math.max(0, o), String(((n - 1 + sh) % n) + 1));
  }
  g.restore();

  // ---- ports
  v.ports.forEach(pt => {
    let pos = pt.junction + (lab ? offs : 0);
    pos = ((pos % n) + n) % n;
    let x = gx(pos);
    if (pos < 0.02 && !(lab && S.anim)) x = gx(0) - 8;
    const inlet = INLETS.includes(pt.kind), col = portColor(cfg, pt.kind);
    const q = pt.flow;
    g.strokeStyle = col; g.fillStyle = col; g.lineWidth = pw(q);
    if (inlet) {
      g.beginPath(); g.moveTo(x, 62); g.lineTo(x, topP - 4); g.stroke();
      g.beginPath(); g.moveTo(x, topP - 1); g.lineTo(x - 5, topP - 9); g.lineTo(x + 5, topP - 9); g.closePath(); g.fill();
      badge(g, x, 52, pt.label, col);
      g.fillStyle = ink2; g.font = "10.5px " + css("--sans"); g.textAlign = "left";
      if (q !== undefined && q !== null) g.fillText(fmt(q), x + 13, 56);
    } else {
      const yb = recY - 22;
      g.beginPath(); g.moveTo(x, botP + 2); g.lineTo(x, yb - 12); g.stroke();
      g.beginPath(); g.moveTo(x, yb - 6); g.lineTo(x - 5, yb - 14); g.lineTo(x + 5, yb - 14); g.closePath(); g.fill();
      badge(g, x, yb, pt.label, col);
      g.fillStyle = ink2; g.font = "10.5px " + css("--sans"); g.textAlign = "left";
      if (q !== undefined && q !== null && isFinite(q)) g.fillText(fmt(q) + (pt.balance ? "*" : ""), x + 13, yb + 4);
    }
  });
  // time label
  g.fillStyle = ink2; g.font = "600 11px " + css("--sans"); g.textAlign = "left";
  if (!v.empty) g.fillText(v.live ? "live" : `switch ${sh + 1}/${n} · t = ${f.t.toFixed(2)} min`, Lm, 14);
  g.textAlign = "right"; g.fillStyle = ink3; g.font = "10.5px " + css("--sans");
  g.fillText(cfg.open_loop ? "open loop: no recycle" : "recycle ↺ (closed loop)", W - Rm, 14);
  if (S.anim) requestDraw();
  cv._geom = { Lm, slot, n, y0, th, lab, v };
}
function badge(g, x, y, text, col) {
  g.fillStyle = col; g.beginPath(); g.arc(x, y, 10, 0, 2 * Math.PI); g.fill();
  g.strokeStyle = css("--surface"); g.lineWidth = 2; g.stroke();
  g.fillStyle = "#fff"; g.font = "700 10.5px " + css("--sans"); g.textAlign = "center"; g.fillText(text, x, y + 3.8);
}
function bindProcessHover() {
  const cv = $("#process");
  cv.onmousemove = ev => {
    const G = cv._geom; if (!G || G.v.empty) return;
    const r = cv.getBoundingClientRect(), x = ev.clientX - r.left;
    const p = Math.floor((x - G.Lm) / G.slot); if (p < 0 || p >= G.n) { tip.hide(); return; }
    const v = G.v, k = G.lab ? portCol(v, p) : p, f = curFrame(v), m = Math.round(v.m), cfg = v.cfg;
    const phys = G.lab ? p + 1 : ((k + shift(v)) % v.n) + 1;
    const z = zoneOfColumn(v, k);
    const avg = cfg.components.map((c, i) => { let s = 0; for (let j = 0; j < m; j++) s += f.C[i][k * m + j]; return { c, i, a: s / m }; });
    const q = f.Fin ? f.Fin[k] : ((v.result && v.result.zone_flows) || [])[z];
    let h = `<div class="tt-head">Column ${phys} · zone ${ZONES[z]} · inlet flow ${fmt(q)} mL/min</div>`;
    avg.sort((a1, b1) => b1.a - a1.a).forEach(o => h += `<div class="tt-row"><span><i style="background:${compColor(o.i)}"></i>${esc(o.c.name)}</span><b>${fmt(o.a)} g/mL</b></div>`);
    tip.show(h, ev.clientX, ev.clientY);
  };
  cv.onmouseleave = () => tip.hide();
}

/* ============================================================== RING VIEW */
function arcPath(cx, cy, r0, r1, a0, a1) {
  const p = (r, a) => `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${p(r1, a0)}A${r1} ${r1} 0 ${large} 1 ${p(r1, a1)}L${p(r0, a1)}A${r0} ${r0} 0 ${large} 0 ${p(r0, a0)}Z`;
}
function bandComps(cfg) {
  const out = [];
  const e = roleIndex(cfg, "extract"), r = roleIndex(cfg, "raffinate");
  if (e >= 0) out.push(e);
  if (r >= 0) out.push(r);
  cfg.components.forEach((c, i) => { if (out.length < 2 && c.role !== "desorbent" && !out.includes(i)) out.push(i); });
  return out;
}
function renderRing(rebuild) {
  const el = $("#ring"), v = S.view || emptyView();
  if (rebuild || el._built !== v) buildRing(el, v);
  updateRing(el, v);
}
function buildRing(el, v) {
  const cx = 200, cy = 200, n = v.n, a = 2 * Math.PI / n, gap = Math.min(0.05, a * 0.14);
  const bands = bandComps(v.cfg), radii = [[120, 142], [96, 117]];
  const ang = f => -Math.PI / 2 + f * a;
  const m = Math.round(v.m);
  let s = `<svg viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="SMB unit schematic">`;
  for (let k = 0; k < n; k++) {
    const t = ang(k + 0.5), r = 186;
    s += `<text class="col-num" x="${cx + r * Math.cos(t)}" y="${cy + r * Math.sin(t) + 3}" text-anchor="middle">${k + 1}</text>`;
  }
  const cells = [];
  bands.forEach((ci, bi) => {
    const [r0, r1] = radii[bi];
    for (let k = 0; k < n; k++) {
      const a0 = ang(k) + gap / 2, a1 = ang(k + 1) - gap / 2, span = a1 - a0;
      for (let j = 0; j < m; j++) {
        const idx = cells.length;
        cells.push({ ci, col: k, j });
        s += `<path data-c="${idx}" d="${arcPath(cx, cy, r0, r1, a0 + j / m * span - 0.002, a0 + (j + 1) / m * span + 0.002)}" fill="${compColor(ci)}" fill-opacity="0.06"/>`;
      }
      s += `<path class="col-outline" d="${arcPath(cx, cy, r0, r1, a0, a1)}"/>`;
    }
  });
  s += `<g class="ports" id="portsG">`;
  const zb = v.starts.concat([n]);
  for (let z = 0; z < v.nz; z++) {
    const a0 = ang(zb[z]) + gap, a1 = ang(zb[z + 1]) - gap, rz = 84;
    if (a1 <= a0) continue;
    s += `<path class="zone-arc" stroke="var(--ink-3)" stroke-opacity=".45" d="M${cx + rz * Math.cos(a0)} ${cy + rz * Math.sin(a0)}A${rz} ${rz} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${cx + rz * Math.cos(a1)} ${cy + rz * Math.sin(a1)}"/>`;
  }
  v.ports.forEach((p, i) => {
    const inlet = INLETS.includes(p.kind), col = portColor(v.cfg, p.kind);
    const t = ang(p.junction) + (v.ports.filter(q => q.junction === p.junction).indexOf(p)) * 0.09, c = Math.cos(t), sn = Math.sin(t);
    const r1 = 146, r2 = 160, rb = 170;
    const tipR = inlet ? r1 : r2, tailR = inlet ? r2 : r1;
    const tx = cx + tipR * c, ty = cy + tipR * sn;
    const hx = (inlet ? 1 : -1) * c, hy = (inlet ? 1 : -1) * sn, px = -sn, py = c;
    s += `<line x1="${cx + tailR * c}" y1="${cy + tailR * sn}" x2="${tx}" y2="${ty}" stroke="${col}" stroke-width="2"/>`;
    s += `<path d="M${tx} ${ty}L${tx + hx * 6 + px * 3.5} ${ty + hy * 6 + py * 3.5}L${tx + hx * 6 - px * 3.5} ${ty + hy * 6 - py * 3.5}Z" fill="${col}"/>`;
    s += `<g class="port-badge"><circle cx="${cx + rb * c}" cy="${cy + rb * sn}" r="10" fill="${col}"/><text x="${cx + rb * c}" y="${cy + rb * sn + 4}" text-anchor="middle">${esc(p.label)}</text></g>`;
  });
  s += `</g>`;
  for (let z = 0; z < v.nz; z++) s += `<text class="zone-label" data-zone="${z}" text-anchor="middle">${ZONES[z]}</text>`;
  s += `<text class="flash" id="ringFlash" x="200" y="181" text-anchor="middle">switch: ports +1 column</text>`;
  s += `<path class="flow-arrow" d="M${cx + 46 * Math.cos(-2.3)} ${cy + 46 * Math.sin(-2.3)}A46 46 0 0 1 ${cx + 46 * Math.cos(-0.85)} ${cy + 46 * Math.sin(-0.85)}" marker-end="url(#ah)"/>`;
  s += `<defs><marker id="ah" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--ink-3)"/></marker></defs>`;
  s += `<text class="center-big" id="ringT" x="200" y="207" text-anchor="middle">–</text>`;
  s += `<text class="center-small" id="ringS" x="200" y="224" text-anchor="middle"></text>`;
  s += `<text class="center-small" x="200" y="240" text-anchor="middle">liquid flows clockwise</text>`;
  el.innerHTML = s + "</svg>";
  el._zmid = Array.from({ length: v.nz }, (_, z) => (zb[z] + zb[z + 1]) / 2);
  el._built = v; el._cells = cells; el._paths = $$("path[data-c]", el); el._m = m; el._lastSwitch = null;
  el._cmax = v.cfg.components.map((_, ci) => Math.max(1e-12, ...v.frames.map(f => Math.max(...f.C[ci]))));
  $("#ringLegend").innerHTML = bands.map((ci, bi) => `<span><i style="background:linear-gradient(90deg, color-mix(in srgb, ${compColor(ci)} 8%, transparent), ${compColor(ci)})"></i>${esc(v.cfg.components[ci].name)} (${bi ? "inner" : "outer"} ring)</span>`).join("") +
    v.ports.map(p => `<span><i style="background:${portColor(v.cfg, p.kind)};width:12px;height:12px;border-radius:50%"></i>${esc(p.label)} · ${KIND_LABEL[p.kind]}</span>`).join("");
}
function updateRing(el, v) {
  const f = curFrame(v);
  const cells = el._cells, paths = el._paths, cmax = el._cmax, m = el._m, sh = shift(v);
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i], k = portCol(v, c.col), val = f.C[c.ci][k * m + c.j] / cmax[c.ci];
    paths[i].setAttribute("fill-opacity", (0.06 + 0.94 * Math.max(0, Math.min(1, val))).toFixed(3));
  }
  $("#portsG", el).style.transform = `rotate(${S.switchNo * 360 / v.n}deg)`;
  if (el._lastSwitch !== null && el._lastSwitch !== S.switchNo) {
    const fl = $("#ringFlash", el); fl.classList.add("on");
    clearTimeout(el._flashT); el._flashT = setTimeout(() => fl.classList.remove("on"), 900);
  }
  el._lastSwitch = S.switchNo;
  $$("text[data-zone]", el).forEach(t => {
    const a = -Math.PI / 2 + (el._zmid[+t.dataset.zone] + sh) * 2 * Math.PI / v.n;
    t.setAttribute("x", 200 + 70 * Math.cos(a)); t.setAttribute("y", 204 + 70 * Math.sin(a));
  });
  $("#ringT", el).textContent = v.empty ? "–" : `${f.t.toFixed(2)} min`;
  $("#ringS", el).textContent = v.empty ? "" : v.live ? "live, end of switch" : `switch ${sh + 1} of ${v.n} · cycle ${Math.floor(S.switchNo / v.n) + 1}`;
}

/* ============================================================== PROFILES */
function zoneBands(v, sh = 0) {
  const n = v.n, p = v.pitch, zb = v.starts.concat([n]);
  const bands = [];
  for (let i = 0; i < v.nz; i++) {
    const fill = i % 2 ? "var(--zone-b)" : "var(--zone-a)";
    let a = zb[i] + sh, b = zb[i + 1] + sh;
    if (a >= n) { a -= n; b -= n; }
    const lbl = `Zone ${ZONES[i]}`;
    if (b <= n) bands.push({ x0: a * p, x1: b * p, label: lbl, fill });
    else {
      const big = (n - a) >= (b - n);
      bands.push({ x0: a * p, x1: n * p, label: big ? lbl : "", fill });
      bands.push({ x0: 0, x1: (b - n) * p, label: big ? "" : lbl, fill });
    }
  }
  return bands;
}
function portLines(v, sh = 0) {
  return v.ports.map(pt => ({ x: ((pt.junction + sh) % v.n) * v.pitch, label: pt.label, badge: portColor(v.cfg, pt.kind), color: "var(--ink-3)" }));
}
function renderProfiles() {
  setSeg($("#profTabs"), S.profTab);
  $$("#profTabs button").forEach(b => b.classList.toggle("on", b.dataset.v === S.profTab));
  const axial = S.profTab === "axial";
  $("#frameSeg").hidden = !axial; $("#profSeg").hidden = !axial; $("#colPickWrap").hidden = axial;
  if (axial) renderProfile(); else renderColumnCycle();
}
function renderProfile() {
  const v = S.view, el = $("#profile");
  setSeg($("#profSeg"), S.profMode); setSeg($("#frameSeg"), S.frameMode);
  if (!v || v.empty) {
    legend($("#profLegend"), [], "prof", renderProfile);
    lineChart(el, { series: [], empty: "Run the simulation to see the axial profile", key: "prof" });
    $("#profFoot").textContent = ""; return;
  }
  const f = curFrame(v), cfg = v.cfg;
  const lab = S.frameMode === "lab" && !v.live, sh = lab ? shift(v) : 0;
  const Y = arr => lab ? toLab(v, arr) : arr;
  let series, yTitle;
  if (S.profMode === "volume") {
    const sum = v.x.map((_, j) => cfg.components.reduce((a, c, i) => a + f.C[i][j] / c.rho, 0));
    series = [{ name: "Σ Cᵢ/ρᵢ (liquid volume fraction)", color: "var(--ink)", x: v.x, y: Y(sum) }];
    yTitle = "Σ C/ρ  (–)";
  } else {
    const src = S.profMode === "solid" ? f.Q : f.C;
    series = src ? cfg.components.map((c, i) => ({ name: c.name, color: compColor(i), x: v.x, y: Y(src[i]) })) : [];
    yTitle = S.profMode === "solid" ? "q  (g/mL solid)" : "C  (g/mL)";
  }
  legend($("#profLegend"), series, "prof" + S.profMode, renderProfile);
  lineChart(el, {
    series, key: "prof" + S.profMode, bands: zoneBands(v, sh), vlines: portLines(v, sh), top: 22,
    colLines: Array.from({ length: v.n - 1 }, (_, k) => (k + 1) * v.pitch),
    xDomain: [0, v.n * v.pitch], yTitle,
    xTitle: lab ? "Position in the unit, from the inlet of column 1 (cm)" : "Position along the unit from the start of zone I (cm)",
    yDomain: S.profMode === "volume" ? [0.98, 1.02] : undefined,
    empty: S.profMode === "solid" ? "Adsorbed phase is shown once the run completes" : "All series hidden",
    tipX: x => `x = ${x.toFixed(1)} cm · column ${Math.min(v.n, Math.floor(x / v.pitch) + 1)}`, tipY: y => fmt(y),
  });
  $("#profFoot").textContent = lab
    ? "Columns fixed: what you would sample along the plant. The ports and zones jump one column at every switch."
    : "Ports fixed: the profile seen from the ports. At cyclic steady state it repeats identically in every switch.";
}
function renderColumnCycle() {
  const v = S.view, r = v && v.result, el = $("#profile"), lg = $("#profLegend"), pick = $("#colPick");
  const n = v ? v.n : layoutOf(S.cfg).n;
  if (pick.options.length !== n) pick.innerHTML = Array.from({ length: n }, (_, i) => `<option value="${i}">${i + 1}</option>`).join("");
  S.colPick = Math.min(S.colPick, n - 1); pick.value = S.colPick;
  if (!r) { lineChart(el, { series: [], empty: v && v.live ? "Available when the run completes" : "No data yet", key: "col_none" }); lg.innerHTML = ""; $("#profFoot").textContent = ""; return; }
  const cfg = v.cfg, T = cfg.step_time, fr = v.frames, m = Math.round(v.m), p = S.colPick;
  const t = [], ys = cfg.components.map(() => []);
  for (let s = 0; s < n; s++) {
    const k = ((p - s) % n + n) % n;
    fr.forEach((f, q) => {
      if (q === fr.length - 1 && s < n - 1) return;
      t.push(s * T + f.t);
      cfg.components.forEach((_, i) => ys[i].push(f.C[i][k * m + m - 1]));
    });
  }
  const bands = [];
  const seq = [];
  for (let s = 0; s < n; s++) {
    const z = zoneOfColumn(v, ((p - s) % n + n) % n), last = bands[bands.length - 1];
    if (last && last.z === z) last.x1 = (s + 1) * T;
    else { bands.push({ z, x0: s * T, x1: (s + 1) * T, label: `Zone ${ZONES[z]}`, fill: z % 2 ? "var(--zone-b)" : "var(--zone-a)" }); seq.push(ZONES[z]); }
  }
  const series = cfg.components.map((c, i) => ({ name: c.name, color: compColor(i), x: t, y: ys[i] }));
  const draw = () => {
    legend(lg, series, "colcyc", draw);
    lineChart(el, {
      series, key: "colcyc", bands, top: 22, xDomain: [0, n * T],
      colLines: Array.from({ length: n - 1 }, (_, s) => (s + 1) * T),
      vlines: [{ x: shift(v) * T + curFrame(v).t, color: "var(--accent)", dash: "4 3" }],
      xTitle: `Time over one full cycle (${n} switches × ${fmt(T)} min)`, yTitle: "C at column outlet (g/mL)",
      tipX: x => `t = ${x.toFixed(2)} min · switch ${Math.min(n, Math.floor(x / T) + 1)}`,
    });
  };
  draw();
  $("#profFoot").textContent = `Outlet of column ${p + 1} as the ports move past it. Relative to the ports the column travels against the flow, through zones ${seq.join(" → ")}.`;
}

/* ============================================================== PRODUCTS */
function renderProducts() {
  $$("#prodTabs button").forEach(b => b.classList.toggle("on", b.dataset.v === S.prodTab));
  $("#prodOutlets").hidden = S.prodTab !== "outlets"; $("#prodSplit").hidden = S.prodTab !== "split"; $("#prodTable").hidden = S.prodTab !== "table";
  const v = S.view, r = v && v.result;
  const labels = r ? r.outlet_labels : [];
  $("#outletSeg").hidden = S.prodTab !== "outlets" || !labels.length;
  $("#outletSeg").innerHTML = labels.map((l, i) => `<button data-v="${i}" class="${i === S.outletIdx ? "on" : ""}">${esc(l)} · ${esc(KIND_LABEL[r.outlet_kinds[i]].replace(" out", ""))}</button>`).join("");
  if (S.prodTab === "outlets") renderOutlets();
  else if (S.prodTab === "split") renderSplit();
  else renderPerfTable();
}
function renderOutlets() {
  const v = S.view, r = v && v.result, el = $("#outChart"), lg = $("#outLegend");
  if (!r) { lineChart(el, { series: [], empty: v && v.live ? "Available when the run completes" : "No data yet", key: "out_none" }); lg.innerHTML = ""; return; }
  const cfg = v.cfg, t = r.outlets.map(o => o.t), oi = Math.max(0, Math.min(S.outletIdx, r.outlet_labels.length - 1));
  const key = "out";
  if (!S.hidden[key]) S.hidden[key] = new Set(cfg.components.filter(c => c.role === "desorbent").map(c => c.name));
  const series = cfg.components.map((c, i) => ({ name: c.name, color: compColor(i), x: t, y: r.outlets.map(o => o.C[oi][i]) }));
  const draw = () => {
    legend(lg, series, key, draw);
    lineChart(el, { series, key, xTitle: `Time since last switch (min) · outlet ${r.outlet_labels[oi]}`, yTitle: "C (g/mL)", xDomain: [0, cfg.step_time],
      vlines: [{ x: curFrame(v).t, color: "var(--accent)", dash: "4 3" }], tipX: x => `t = ${x.toFixed(2)} min` });
  };
  draw();
}
function renderSplit() {
  const v = S.view, r = v && v.result, el = $("#split"), el2 = $("#composition");
  if (!r) { el.innerHTML = `<div class="muted">${v && v.live ? "Available when the run completes." : "No data yet."}</div>`; el2.innerHTML = ""; return; }
  const cfg = v.cfg, comps = r.metrics.components;
  el.innerHTML = comps.map((c, i) => {
    if (c.to_extract === null) return "";
    const e = Math.max(0, c.to_extract), f = Math.max(0, c.to_raffinate), col = compColor(i);
    return `<div class="split-row"><div class="split-label"><b>${esc(c.name)}</b><span>target: ${ROLE_LABEL[c.role].toLowerCase()} · closure ${fmt(c.closure, 1)}%</span></div>
      <div class="bar"><div style="width:${e}%;background:${col}" title="To extract ${pct(e)}%">${e > 12 ? "E " + e.toFixed(1) + "%" : ""}</div>
      <div style="width:${f}%;background:color-mix(in srgb, ${col} 38%, var(--surface))" title="To raffinate ${pct(f)}%"><span style="color:var(--ink)">${f > 12 ? "R " + f.toFixed(1) + "%" : ""}</span></div></div></div>`;
  }).join("") + `<div class="split-keys"><span><i style="background:var(--ink-2)"></i>leaves in extract</span><span><i style="background:color-mix(in srgb, var(--ink-2) 38%, var(--surface))"></i>leaves in raffinate</span></div>`;
  el2.innerHTML = r.metrics.streams.map(st => {
    const parts = st.composition.map((v2, i) => ({ i, v: v2 })).filter(p => p.v !== null && p.v > 0);
    return `<div class="split-row"><div class="split-label"><b>${esc(st.label)} · ${esc(KIND_LABEL[st.kind])} product</b><span>${fmt(st.flow)} mL/min · ${pct(st.product_fraction)}% is product</span></div>
      <div class="bar">${parts.map(p => `<div style="width:${p.v}%;background:${compColor(p.i)}" title="${esc(cfg.components[p.i].name)} ${pct(p.v)}%">${p.v > 14 ? esc(cfg.components[p.i].name) + " " + p.v.toFixed(1) + "%" : ""}</div>`).join("")}</div></div>`;
  }).join("") + `<div class="split-keys">compositions in mass %, desorbent excluded</div>`;
}
function renderPerfTable() {
  const v = S.view, r = v && v.result, el = $("#prodTable");
  if (!r) { el.innerHTML = `<div class="muted">${v && v.live ? "Available when the run completes." : "No data yet."}</div>`; return; }
  const comps = r.metrics.components, cfg = v.cfg;
  let h = `<table class="perf"><caption>By component (purities on a desorbent-free basis)</caption><thead><tr><th>Component</th><th>Target</th><th>Extract recovery</th><th>Extract purity</th><th>Raffinate recovery</th><th>Raffinate purity</th><th>Closure</th></tr></thead><tbody>`;
  comps.forEach((c, i) => {
    h += `<tr class="${c.role === "desorbent" ? "sub" : ""}"><td><span class="sw" style="background:${compColor(i)}"></span>${esc(c.name)}</td><td>${ROLE_LABEL[c.role]}</td>
      <td>${pct(c.to_extract)}</td><td>${pct(c.extract_purity)}</td><td>${pct(c.to_raffinate)}</td><td>${pct(c.raffinate_purity)}</td><td>${pct(c.closure)}</td></tr>`;
  });
  h += `</tbody></table><table class="perf"><caption>By outlet stream</caption><thead><tr><th>Outlet</th><th>Flow, mL/min</th><th>Product in stream</th>${cfg.components.filter(c => c.role !== "desorbent").map(c => `<th>${esc(c.name)} %</th>`).join("")}</tr></thead><tbody>`;
  r.metrics.streams.forEach(st => {
    h += `<tr><td>${esc(st.label)} · ${esc(KIND_LABEL[st.kind])}${st.balance ? " (balance)" : ""}</td><td>${fmt(st.flow)}</td><td>${pct(st.product_fraction)}%</td>
      ${cfg.components.map((c, i) => c.role === "desorbent" ? "" : `<td>${pct(st.composition[i])}</td>`).join("")}</tr>`;
  });
  el.innerHTML = h + "</tbody></table>";
}

/* =========================================================== CONVERGENCE */
function renderConvergence() {
  $$("#convTabs button").forEach(b => b.classList.toggle("on", b.dataset.v === S.convTab));
  $("#convPerf").hidden = S.convTab !== "perf"; $("#convRes").hidden = S.convTab !== "res";
  const v = S.view, h = v ? v.history || [] : [];
  const cfg = v ? v.cfg : S.cfg;
  const ec = roleIndex(cfg, "extract") >= 0 ? compColor(roleIndex(cfg, "extract")) : compColor(0);
  const rc = roleIndex(cfg, "raffinate") >= 0 ? compColor(roleIndex(cfg, "raffinate")) : compColor(1);
  const x = h.map(p => p.cycle);
  if (S.convTab === "perf") {
    const series = [
      { name: "Extract purity", color: ec, x, y: h.map(p => p.extract_purity), dots: h.length < 40 },
      { name: "Extract recovery", color: ec, x, y: h.map(p => p.extract_recovery), dash: "5 4" },
      { name: "Raffinate purity", color: rc, x, y: h.map(p => p.raffinate_purity), dots: h.length < 40 },
      { name: "Raffinate recovery", color: rc, x, y: h.map(p => p.raffinate_recovery), dash: "5 4" },
    ];
    const draw = () => {
      legend($("#convLegend"), series, "conv", draw);
      lineChart($("#convChart"), { series, key: "conv", xTitle: "Cycle", yTitle: "%", yDomain: [0, 105], tipX: c => `cycle ${c.toFixed(1)}`, tipY: y => pct(y) + " %", empty: "Convergence appears as the run progresses" });
    };
    draw();
  } else {
    lineChart($("#resChart"), {
      series: [{ name: "Residual", color: "var(--accent)", x, y: h.map(p => p.residual), dots: h.length < 40 }],
      key: "res", ylog: true, xTitle: "Cycle", yTitle: "max |Δ| per switch", hlines: h.length ? [{ y: cfg.css_tol, label: "tolerance" }] : [],
      tipX: c => `cycle ${c.toFixed(1)}`, tipY: y => y.toExponential(2), empty: "Convergence appears as the run progresses",
    });
  }
}

/* ============================================================ RUN HISTORY */
function renderRuns() {
  const tb = $("#runs tbody");
  if (!S.runs.length) { tb.innerHTML = `<tr class="empty"><td colspan="10">No runs yet.</td></tr>`; return; }
  tb.innerHTML = S.runs.map((run, i) => {
    const r = run.result, m = r.metrics, c = run.cfg;
    return `<tr data-i="${i}" class="${run === S.selected ? "sel" : ""}">
      <td><span class="dot ${r.converged ? "" : "warn"}" title="${r.converged ? "Converged" : "Not converged"}"></span> ${i + 1}</td>
      <td><span class="tag ${esc(c.scheme)}">${esc((S.schemes[c.scheme] || {}).label || c.scheme)}</span></td>
      <td>${c.zones.join("-")}${c.open_loop ? " open" : ""}</td>
      <td>${c.flow_model === "constant" ? "Constant" : "Volume change"}</td>
      <td>${pct(m.extract_purity)} %</td><td>${pct(m.extract_recovery)} %</td>
      <td>${pct(m.raffinate_purity)} %</td><td>${pct(m.raffinate_recovery)} %</td>
      <td>${r.cycles.toFixed(1)}</td><td>${fmtTime(r.elapsed)}</td></tr>`;
  }).join("");
}

/* =============================================================== PLAYBACK */
function startPlay() {
  stopPlay();
  const v = S.view; if (!v || v.live || v.frames.length < 2) return;
  S.playing = setInterval(() => {
    S.frame++;
    if (S.frame >= v.frames.length) { S.frame = 0; S.switchNo++; S.anim = { t0: performance.now(), dur: 520 }; }
    tick();
  }, S.speed);
  setPlayIcon(true);
}
function stopPlay() { clearInterval(S.playing); S.playing = null; setPlayIcon(false); }
function setPlayIcon(on) { $("#playIcon").innerHTML = on ? `<path fill="currentColor" d="M6 4h4v16H6zM14 4h4v16h-4z"/>` : `<path fill="currentColor" d="M7 4v16l13-8z"/>`; }
function tick() {
  $("#scrub").value = S.frame;
  if (S.unitMode === "process") requestDraw(); else renderRing(false);
  updateScrubLabel();
  const v = S.view;
  if (S.profTab === "axial") renderProfile(); else if (v && v.result) renderColumnCycle();
  if (v && v.result && S.prodTab === "outlets") renderOutlets();
}
function updateScrubLabel() {
  const v = S.view;
  $("#scrubLabel").textContent = !v || v.empty ? "t = –" : v.live ? "live · end of switch"
    : `switch ${shift(v) + 1}/${v.n} · t = ${curFrame(v).t.toFixed(2)} of ${v.cfg.step_time.toFixed(2)} min`;
}
function nextSwitch() {
  const v = S.view; if (!v || v.live || v.empty) return;
  S.frame = 0; S.switchNo++; S.anim = { t0: performance.now(), dur: 520 }; tick();
}
function renderSwitchHint() {
  const v = S.view, cfg = v ? v.cfg : S.cfg, n = layoutOf(cfg).n;
  $("#switchHint").innerHTML = `Every <b>${fmt(cfg.step_time)} min</b> all ports step one column downstream, in the direction of the liquid. ` +
    `The columns and the liquid and adsorbent inside them stay where they are; only the inlet and outlet valves change. ` +
    `Relative to the ports, the packing therefore moves one column upstream per switch, which is how SMB mimics a counter-current moving bed. ` +
    `<b>Valves move</b> shows the plant; <b>Bed moves</b> shows the equivalent moving bed. After ${n} switches (one cycle, ${fmt(n * cfg.step_time)} min) every port is back where it started. ` +
    `In the simulation, the end-of-switch state of each column becomes the start state of the column one position upstream (C_end[j] = C_0[j−1]).`;
}

/* ==================================================================== CSV */
function exportCSV() {
  const run = S.selected; if (!run) return;
  const r = run.result, cfg = run.cfg, names = cfg.components.map(c => c.name);
  const last = r.frames[r.frames.length - 1];
  let out = `# SMB Simulator Suite results\n# mode,${cfg.scheme},flow model,${cfg.flow_model},zones,${cfg.zones.join("-")},open loop,${cfg.open_loop}\n`;
  out += `# extract purity %,${r.metrics.extract_purity},extract recovery %,${r.metrics.extract_recovery},raffinate purity %,${r.metrics.raffinate_purity},raffinate recovery %,${r.metrics.raffinate_recovery}\n\n`;
  out += `Axial profile at end of switch (port frame)\nx_cm,${names.map(n => "C_" + n).join(",")},${names.map(n => "q_" + n).join(",")}\n`;
  r.x.forEach((x, j) => { out += `${x},${last.C.map(c => c[j]).join(",")},${last.Q.map(c => c[j]).join(",")}\n`; });
  out += `\nOutlet concentrations over one switch\nt_min,${r.outlet_labels.map(l => names.map(n => l + "_" + n).join(",")).join(",")}\n`;
  r.outlets.forEach(o => { out += `${o.t},${o.C.map(row => row.join(",")).join(",")}\n`; });
  out += `\nComponent performance\ncomponent,extract_recovery,extract_purity,raffinate_recovery,raffinate_purity,closure\n`;
  r.metrics.components.forEach(c => { out += `${c.name},${c.to_extract},${c.extract_purity},${c.to_raffinate},${c.raffinate_purity},${c.closure}\n`; });
  out += `\nConvergence history\ncycle,residual,extract_purity,extract_recovery,raffinate_purity,raffinate_recovery\n`;
  r.history.forEach(h => { out += `${h.cycle},${h.residual},${h.extract_purity},${h.extract_recovery},${h.raffinate_purity},${h.raffinate_recovery}\n`; });
  download(`smb_results_${cfg.scheme}_${cfg.flow_model}.csv`, out, "text/csv");
}

/* ================================================================== THEME */
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem("smb-theme"); } catch (e) { /* storage unavailable */ }
  if (saved) document.documentElement.dataset.theme = saved;
  $("#themeBtn").onclick = () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("smb-theme", next); } catch (e) { /* ignore */ }
    renderComponents(); renderZoneTable(); renderAll();
  };
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => { renderComponents(); renderAll(); });
}

/* =================================================================== INIT */
async function init() {
  tip.el = $("#tooltip");
  initTheme();
  const { data } = await api("/api/defaults");
  S.isotherms = data.isotherms; S.schemes = data.schemes; S.presets = data.presets || {};
  S.maxColumns = data.max_columns || 16; S.maxZones = data.max_zones || 6;
  S.defaults = data.config; S.cfg = markEnd(clone(data.config));
  const ps = $("#presetSel");
  ps.innerHTML = Object.entries(S.presets).map(([k, p]) => `<option value="${esc(k)}">${esc(p.label)}</option>`).join("") + `<option value="" hidden>Custom setup</option>`;
  const showPresetHint = () => { const p = S.presets[ps.value]; $("#presetHint").textContent = p ? p.summary : "Edited from a test case."; };
  ps.onchange = () => { const k = ps.value, p = S.presets[k]; if (!p) return; S.cfg = markEnd(clone(p.config)); S.defaults = clone(p.config); renderSetup(); onCfgChange(); ps.value = k; showPresetHint(); updateChips(); };
  showPresetHint();
  bindSetup(); renderSetup(); validate();
  $("#unitSeg").onclick = e => { const b = e.target.closest("button"); if (b) { S.unitMode = b.dataset.v; renderUnit(true); } };
  $("#fillSeg").onclick = e => { const b = e.target.closest("button"); if (b) { S.fill = b.dataset.v; setSeg($("#fillSeg"), S.fill); renderUnit(false); } };
  $("#motionSeg").onclick = e => { const b = e.target.closest("button"); if (b) { S.motion = b.dataset.v; S.anim = null; renderUnit(false); } };
  $("#profTabs").onclick = e => { const b = e.target.closest("button"); if (b) { S.profTab = b.dataset.v; renderProfiles(); } };
  $("#profSeg").onclick = e => { const b = e.target.closest("button"); if (b) { S.profMode = b.dataset.v; renderProfile(); } };
  $("#frameSeg").onclick = e => { const b = e.target.closest("button"); if (b) { S.frameMode = b.dataset.v; renderProfile(); } };
  $("#colPick").onchange = e => { S.colPick = +e.target.value; renderColumnCycle(); };
  $("#prodTabs").onclick = e => { const b = e.target.closest("button"); if (b) { S.prodTab = b.dataset.v; renderProducts(); } };
  $("#outletSeg").onclick = e => { const b = e.target.closest("button"); if (b) { S.outletIdx = +b.dataset.v; renderProducts(); } };
  $("#convTabs").onclick = e => { const b = e.target.closest("button"); if (b) { S.convTab = b.dataset.v; renderConvergence(); } };
  $("#scrub").oninput = e => { stopPlay(); S.frame = +e.target.value; tick(); };
  $("#playBtn").onclick = () => S.playing ? stopPlay() : startPlay();
  $("#nextSwitchBtn").onclick = nextSwitch;
  $("#speedSel").onchange = e => { S.speed = +e.target.value; if (S.playing) startPlay(); };
  $("#runs").onclick = e => { const tr = e.target.closest("tr[data-i]"); if (tr) select(S.runs[+tr.dataset.i]); };
  $("#csvBtn").onclick = exportCSV;
  bindProcessHover();
  renderAll();
  let rt; new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(renderAll, 120); }).observe($(".results"));
}
init();

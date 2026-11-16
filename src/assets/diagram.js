// Wiring diagrams: a few lines of text become an SVG of Grasshopper-style component boxes.
//
// Used by the build (Node) to draw every diagram into the page, and by the browser
// (assets/live.js) to make sliders draggable. No DOM access in this file.
//
// ---------------------------------------------------------------- syntax
//
//   # a comment
//   nv  = GetCameraFromNamedviews          component, by class id or name ("Get Camera From Named Views")
//   key = AnimateKeyframes [used]          only draw the ports that have a wire
//   vcd = ViewCaptureDriver [path, fps]    only draw these ports (plus wired ones)
//   ev  = EventTimeline events="0-0.5, 0.4-1" ease=inout
//   t   = slider 0.25 min=0 max=1 live     Number Slider; "live" makes it draggable on the page
//   p   = panel "D:\frames"                Panel
//   on  = toggle true                      Boolean Toggle
//   b   = button                           Button
//   g   = param Geometry "Building"        a parameter container (Geometry, Curve, Text ...)
//
//   nv.camera -> key.cameras               a wire, from an output to an input
//   t ~> key.t                             "~>" draws the wire in the accent colour (the time signal t)
//
// Port names are matched without case or spaces, so "masterTime" finds "master Time".
// Any node can take col=N to force its column; otherwise columns follow the wires.

const ROW = 20;          // height of one port row
const HEAD = 30;         // component header (icon + name)
const PAD_X = 10;
const BTN_H = 20;
const COL_GAP = 60;
const NODE_GAP = 22;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// Rough text width for a 12px system sans-serif, good enough to size boxes.
export function textWidth(s, size = 12, bold = false) {
  let w = 0;
  for (const ch of String(s)) {
    if ('ijlI.,:;|!\'`'.includes(ch)) w += 0.28;
    else if ('ft()[]{} r"-'.includes(ch)) w += 0.36;
    else if ('mwMW'.includes(ch)) w += 0.86;
    else if (ch >= 'A' && ch <= 'Z') w += 0.66;
    else if (ch >= '0' && ch <= '9') w += 0.56;
    else w += 0.54;
  }
  return w * size * (bold ? 1.06 : 1);
}

// ---------------------------------------------------------------- parse

function tokenizeLine(line) {
  const out = [];
  const re = /\s*(\w+="(?:[^"\\]|\\.)*"|"(?:[^"\\]|\\.)*"|\[[^\]]*\]|[^\s]+)/g;
  let m;
  while ((m = re.exec(line))) if (m[1]) out.push(m[1]);
  return out;
}
const unquote = (s) => s.startsWith('"') ? s.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\') : s;

export function parseDiagram(text) {
  const nodes = [];
  const wires = [];
  const errors = [];
  const lines = text.split('\n');
  lines.forEach((raw, li) => {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) return;
    const wm = /^([\w]+)(?:\.([\w ]+?))?\s*(->|~>)\s*([\w]+)(?:\.([\w ]+?))?$/.exec(line);
    if (wm) {
      wires.push({ from: { node: wm[1], port: wm[2] || null }, to: { node: wm[4], port: wm[5] || null }, hot: wm[3] === '~>', line: li + 1 });
      return;
    }
    const nm = /^([\w]+)\s*=\s*(.+)$/.exec(line);
    if (!nm) { errors.push(`line ${li + 1}: cannot read "${line}"`); return; }
    const toks = tokenizeLine(nm[2]);
    const node = { key: nm[1], ref: toks[0], args: [], opts: {}, ports: null, line: li + 1 };
    // a component name may be written with spaces: "Animate Keyframes"
    let k = 1;
    while (k < toks.length && /^[A-Z][\w]*$/.test(toks[k]) && /^[A-Z]/.test(node.ref) && !['slider', 'panel', 'toggle', 'button', 'param'].includes(node.ref)) {
      node.ref += ' ' + toks[k]; k++;
    }
    for (; k < toks.length; k++) {
      const t = toks[k];
      if (t.startsWith('[')) node.ports = t.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
      else if (/^\w+=/.test(t)) { const i = t.indexOf('='); node.opts[t.slice(0, i)] = unquote(t.slice(i + 1)); }
      else if (/^\w+=$/.test(t)) node.opts[t.slice(0, -1)] = '';
      else node.args.push(unquote(t));
    }
    // flags written bare, like "live"
    node.args = node.args.filter(a => { if (a === 'live') { node.opts.live = true; return false; } return true; });
    nodes.push(node);
  });
  return { nodes, wires, errors };
}

// ---------------------------------------------------------------- catalog

export function makeCatalog(data) {
  const byKey = new Map();
  for (const c of data.components) {
    for (const k of [c.id, c.slug, c.name, c.nickname]) if (k && !byKey.has(norm(k))) byKey.set(norm(k), c);
  }
  return { data, find: (ref) => byKey.get(norm(ref)) || null };
}

// ---------------------------------------------------------------- build node shapes

function eventsOf(node) {
  const src = node.opts.events || '0-0.333, 0.333-0.667, 0.667-1';
  return src.split(',').map(s => s.trim()).filter(Boolean).map((s, i) => {
    const m = /^(?:"?([^:"]+)"?:)?\s*([\d.]+)\s*-\s*([\d.]+)$/.exec(s);
    return m ? { label: m[1] ? m[1].trim() : null, a: +m[2], b: +m[3] } : { label: null, a: 0, b: 1 };
  });
}

function shapeFor(node, catalog, errors) {
  const kind = ['slider', 'panel', 'toggle', 'button', 'param'].includes(node.ref) ? node.ref : 'component';
  const s = { key: node.key, kind, node, inputs: [], outputs: [], buttons: [], extraH: 0 };

  if (kind === 'slider') {
    const min = +(node.opts.min ?? 0), max = +(node.opts.max ?? 1);
    const value = node.args.length ? +node.args[0] : min;
    s.slider = { min, max, value, digits: node.opts.digits != null ? +node.opts.digits : (String(node.args[0] || '').split('.')[1] || '000').length, live: !!node.opts.live };
    s.label = node.opts.label ?? node.key;
    s.outputs = [{ name: '', key: '', type: 'Number', access: 'item' }];
    s.w = Math.max(180, textWidth(s.label) + 120);
    s.h = 26;
    return s;
  }
  if (kind === 'toggle') {
    s.value = /^(true|1|on)$/i.test(node.args[0] || 'false');
    s.label = node.opts.label ?? node.key;
    s.outputs = [{ name: '', key: '', type: 'Boolean', access: 'item' }];
    s.w = Math.max(96, textWidth(s.label) + 64); s.h = 26;
    return s;
  }
  if (kind === 'button') {
    s.label = node.opts.label ?? 'Button';
    s.outputs = [{ name: '', key: '', type: 'Boolean', access: 'item' }];
    s.w = Math.max(80, textWidth(s.label) + 36); s.h = 26;
    return s;
  }
  if (kind === 'panel') {
    s.text = node.args.length ? node.args.join(' ') : '';
    s.lines = s.text.split('\n');
    s.inputs = [{ name: '', key: '', type: 'Generic', access: 'item' }];
    s.outputs = [{ name: '', key: '', type: 'Text', access: 'item' }];
    s.w = Math.max(110, ...s.lines.map(l => textWidth(l, 11.5) + 22));
    s.h = Math.max(30, s.lines.length * 15 + 14);
    return s;
  }
  if (kind === 'param') {
    s.label = node.args[1] ?? node.args[0] ?? 'Param';
    s.typeName = node.args[0] || 'Generic';
    s.inputs = [{ name: '', key: '', type: s.typeName, access: 'item' }];
    s.outputs = [{ name: '', key: '', type: s.typeName, access: node.opts.access || 'item' }];
    s.w = Math.max(84, textWidth(s.label, 12, true) + 30); s.h = 26;
    return s;
  }

  // a SnowyPlover component
  const c = catalog.find(node.ref);
  if (!c) {
    errors.push(`line ${node.line}: unknown component "${node.ref}"`);
    s.comp = { name: node.ref, nickname: '', inputs: [], outputs: [], buttons: [], icon: null, slug: '' };
  } else s.comp = c;
  const comp = s.comp;
  s.label = node.opts.label || comp.name;
  s.inputs = comp.inputs.map(p => ({ ...p, key: norm(p.name) }));
  s.outputs = comp.outputs.map(p => ({ ...p, key: norm(p.name) }));
  if (comp.id === 'EventTimeline') {
    s.events = eventsOf(node);
    s.ease = node.opts.ease || 'linear';
    s.events.forEach((e, i) => s.outputs.push({
      name: e.label ? `event ${i + 1} · ${e.label}` : `event ${i + 1}`, nickname: `E${i + 1}`, key: norm(`event ${i + 1}`),
      type: 'Number', access: 'item', description: `t of event ${i + 1} [0..1]`,
    }));
    s.extraH = s.events.length * 12 + 20;
  }
  s.buttons = node.opts.buttons != null ? node.opts.buttons.split('|').filter(Boolean) : (comp.buttons || []);
  return s;
}

function measure(s) {
  if (s.kind !== 'component') return;
  const inW = Math.max(0, ...s.shownIn.map(p => textWidth(p.name)));
  const outW = Math.max(0, ...s.shownOut.map(p => textWidth(p.name)));
  const headW = textWidth(s.label, 12.5, true) + 16 + 8 + PAD_X * 2;
  const btnW = Math.max(0, ...s.buttons.map(b => textWidth(b) + 28));
  s.w = Math.ceil(Math.max(132, headW, inW + outW + PAD_X * 2 + 28, btnW + 16, s.events ? 190 : 0));
  const rows = Math.max(s.shownIn.length, s.shownOut.length, 1);
  s.rowsTop = HEAD;
  s.h = HEAD + rows * ROW + 6 + s.extraH + s.buttons.length * (BTN_H + 4) + (s.buttons.length ? 4 : 0);
}

// ---------------------------------------------------------------- render

export function renderDiagram(text, catalog, { id = 'd' } = {}) {
  const { nodes, wires, errors } = parseDiagram(text);
  const shapes = new Map();
  for (const n of nodes) {
    if (shapes.has(n.key)) errors.push(`line ${n.line}: "${n.key}" is defined twice`);
    shapes.set(n.key, shapeFor(n, catalog, errors));
  }

  // resolve wire ends to port indices
  const resolved = [];
  for (const w of wires) {
    const a = shapes.get(w.from.node), b = shapes.get(w.to.node);
    if (!a) { errors.push(`line ${w.line}: no node "${w.from.node}"`); continue; }
    if (!b) { errors.push(`line ${w.line}: no node "${w.to.node}"`); continue; }
    const pick = (list, port, side, s) => {
      if (port == null) {
        if (list.length === 1 || s.kind !== 'component') return 0;
        errors.push(`line ${w.line}: say which ${side} of "${s.key}" (${list.map(p => p.name).join(', ')})`);
        return -1;
      }
      let i = list.findIndex(p => p.key === norm(port));
      if (i < 0) i = list.findIndex(p => p.nickname && p.nickname === port);
      if (i < 0) errors.push(`line ${w.line}: "${s.label}" has no ${side} "${port}" (it has: ${list.map(p => p.name).join(', ') || 'none'})`);
      return i;
    };
    const fi = pick(a.outputs, w.from.port, 'output', a);
    const ti = pick(b.inputs, w.to.port, 'input', b);
    if (fi < 0 || ti < 0) continue;
    resolved.push({ ...w, a, b, fi, ti });
  }

  // which ports to draw
  for (const s of shapes.values()) {
    if (s.kind !== 'component') continue;
    const usedIn = new Set(resolved.filter(r => r.b === s).map(r => r.ti));
    const usedOut = new Set(resolved.filter(r => r.a === s).map(r => r.fi));
    const filter = s.node.ports;
    const keep = (list, used) => {
      if (!filter) return list.map((p, i) => i);
      const names = filter.filter(f => f !== 'used').map(norm);
      return list.map((p, i) => i).filter(i => used.has(i) || names.includes(list[i].key) || (filter.includes('used') && false));
    };
    s.inIdx = keep(s.inputs, usedIn);
    s.outIdx = keep(s.outputs, usedOut);
    if (s.events) { // event outputs are the point of the component: always draw them
      s.inputs.forEach(() => {});
      for (let i = 2; i < s.outputs.length; i++) if (!s.outIdx.includes(i)) s.outIdx.push(i);
      s.outIdx.sort((x, y) => x - y);
    }
    s.shownIn = s.inIdx.map(i => s.inputs[i]);
    s.shownOut = s.outIdx.map(i => s.outputs[i]);
    s.moreIn = s.inputs.length - s.shownIn.length;
    s.moreOut = s.outputs.length - s.shownOut.length;
    measure(s);
  }
  for (const s of shapes.values()) if (s.kind !== 'component') { s.inIdx = s.inputs.map((p, i) => i); s.outIdx = s.outputs.map((p, i) => i); }

  // port positions relative to the node
  const portY = (s, side, idx) => {
    if (s.kind !== 'component') return s.h / 2;
    const list = side === 'in' ? s.inIdx : s.outIdx;
    const row = list.indexOf(idx);
    return s.rowsTop + row * ROW + ROW / 2 + 3;
  };

  // columns: longest path from the sources, unless col= is given
  const col = new Map();
  for (const s of shapes.values()) col.set(s, s.node.opts.col != null ? +s.node.opts.col : 0);
  for (let pass = 0; pass < shapes.size + 1; pass++) {
    let changed = false;
    for (const r of resolved) {
      if (r.b.node.opts.col != null) continue;
      if (col.get(r.b) < col.get(r.a) + 1) { col.set(r.b, col.get(r.a) + 1); changed = true; }
    }
    if (!changed) break;
  }
  // pull pure sources (sliders, panels...) right next to what they feed
  for (const s of shapes.values()) {
    if (s.node.opts.col != null || resolved.some(r => r.b === s)) continue;
    const targets = resolved.filter(r => r.a === s).map(r => col.get(r.b));
    if (targets.length) col.set(s, Math.min(...targets) - 1);
  }
  const minCol = Math.min(0, ...col.values());
  for (const [s, c] of col) col.set(s, c - minCol);
  const ncol = Math.max(0, ...col.values()) + 1;
  const columns = Array.from({ length: ncol }, () => []);
  for (const s of shapes.values()) columns[col.get(s)].push(s);

  let x = 0;
  const colX = [];
  for (let c = 0; c < ncol; c++) {
    colX[c] = x;
    const w = Math.max(0, ...columns[c].map(s => s.w));
    x += w + COL_GAP;
  }
  // right-align sources in their column so short wires stay short
  for (let c = 0; c < ncol; c++) {
    const w = Math.max(0, ...columns[c].map(s => s.w));
    for (const s of columns[c]) s.x = colX[c] + (s.kind !== 'component' ? w - s.w : (w - s.w) / 2);
  }

  // vertical placement: start stacked in declaration order, then let every node drift toward the
  // ports it is wired to (both sides), re-sorting each column, a few sweeps left-to-right and back.
  for (const list of columns) {
    let y = 0;
    for (const s of list) { s.y = y; y += s.h + NODE_GAP; }
  }
  const wantY = (s) => {
    const w = [];
    for (const r of resolved) {
      if (r.b === s) w.push(r.a.y + portY(r.a, 'out', r.fi) - portY(s, 'in', r.ti));
      if (r.a === s) w.push(r.b.y + portY(r.b, 'in', r.ti) - portY(s, 'out', r.fi));
    }
    return w.length ? w.reduce((p, q) => p + q, 0) / w.length : s.y;
  };
  const place = (list) => {
    for (const s of list) s.want = wantY(s);
    list.sort((p, q) => p.want - q.want);
    // pack without overlaps, as close to the wanted spots as possible (push down, then pull up)
    let floor = -Infinity;
    for (const s of list) { s.y = Math.max(floor, s.want); floor = s.y + s.h + NODE_GAP; }
    let ceil = Infinity;
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      if (s.y + s.h > ceil) s.y = ceil - s.h;
      ceil = s.y - NODE_GAP;
    }
    floor = -Infinity;
    for (const s of list) { s.y = Math.max(floor, s.y); floor = s.y + s.h + NODE_GAP; }
  };
  for (let sweep = 0; sweep < 6; sweep++) {
    if (sweep % 2 === 0) for (let c = 0; c < ncol; c++) place(columns[c]);
    else for (let c = ncol - 1; c >= 0; c--) place(columns[c]);
  }
  const minY = Math.min(...[...shapes.values()].map(s => s.y));
  for (const s of shapes.values()) s.y -= minY;

  const W = Math.ceil(Math.max(...[...shapes.values()].map(s => s.x + s.w))) + 8;
  const H = Math.ceil(Math.max(...[...shapes.values()].map(s => s.y + s.h))) + 8;

  // ---------------- draw
  const out = [];
  const pad = 8;
  out.push(`<svg class="gh" id="${esc(id)}" viewBox="${-pad} ${-pad} ${W + pad} ${H + pad}" width="${W + pad}" height="${H + pad}" style="min-width:${Math.min(W + pad, 560)}px" role="img" aria-label="Wiring diagram" data-model="${esc(JSON.stringify(model()))}">`);

  // wires underneath
  out.push('<g class="wires">');
  resolved.forEach((r, i) => {
    const x1 = r.a.x + r.a.w, y1 = r.a.y + portY(r.a, 'out', r.fi);
    const x2 = r.b.x, y2 = r.b.y + portY(r.b, 'in', r.ti);
    const dx = Math.max(36, Math.abs(x2 - x1) * 0.5);
    const d = `M${x1.toFixed(1)},${y1.toFixed(1)} C${(x1 + dx).toFixed(1)},${y1.toFixed(1)} ${(x2 - dx).toFixed(1)},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
    const p = r.a.outputs[r.fi];
    const acc = p.access === 'list' ? ' list' : p.access === 'tree' ? ' tree' : '';
    out.push(`<path class="w${r.hot ? ' hot' : ''}${acc}" d="${d}" data-w="${i}"/>`);
    if (acc === ' list') out.push(`<path class="w-in" d="${d}"/>`);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    out.push(`<g class="wv" data-w="${i}" transform="translate(${mx.toFixed(1)},${my.toFixed(1)})"><rect x="-17" y="-9" width="34" height="18" rx="9"/><text y="4"></text></g>`);
  });
  out.push('</g>');

  for (const s of shapes.values()) out.push(drawNode(s, catalog));
  out.push('</svg>');

  function model() {
    return {
      nodes: [...shapes.values()].map(s => ({
        key: s.key, kind: s.kind, comp: s.comp ? s.comp.id : null,
        slider: s.slider || null, events: s.events || null, ease: s.ease || null,
        outputs: s.outputs.map(p => p.key),
      })),
      wires: resolved.map(r => ({ a: r.a.key, fi: r.fi, b: r.b.key, ti: r.ti, hot: r.hot })),
    };
  }

  return { svg: out.join(''), errors, width: W + pad * 2, height: H + pad * 2 };

  // ---------------- nodes
  function portTitle(p, side) {
    const bits = [p.name];
    if (p.nickname && p.nickname !== p.name) bits[0] += ` (${p.nickname})`;
    bits.push(`${p.type} · ${p.access}`);
    if (side === 'in' && p.default !== undefined && p.default !== '') bits.push(`default ${p.default}`);
    else if (side === 'in' && p.optional) bits.push('optional');
    if (p.description) bits.push(p.description);
    return esc(bits.join('\n'));
  }

  function drawNode(s) {
    const g = [];
    const t = `translate(${s.x.toFixed(1)},${s.y.toFixed(1)})`;
    const dot = (cx, cy, cls = '') => `<circle class="port${cls}" cx="${cx}" cy="${cy}" r="3.5"/>`;

    if (s.kind === 'slider') {
      const sl = s.slider;
      const labelW = textWidth(s.label) + 18;
      const x0 = labelW + 8, x1 = s.w - 54;
      const f = (sl.value - sl.min) / ((sl.max - sl.min) || 1);
      const kx = x0 + f * (x1 - x0);
      g.push(`<g class="n slider${sl.live ? ' live' : ''}" transform="${t}" data-node="${esc(s.key)}" data-min="${sl.min}" data-max="${sl.max}" data-value="${sl.value}" data-digits="${sl.digits}" data-x0="${x0}" data-x1="${x1}">`);
      g.push(`<rect class="box" width="${s.w}" height="${s.h}" rx="4"/>`);
      g.push(`<text class="lbl" x="10" y="17">${esc(s.label)}</text>`);
      g.push(`<line class="track" x1="${x0}" y1="13" x2="${x1}" y2="13"/>`);
      g.push(`<rect class="knob" x="${(kx - 4).toFixed(1)}" y="6" width="8" height="14" rx="2"/>`);
      g.push(`<text class="val" x="${s.w - 12}" y="17" text-anchor="end">${sl.value.toFixed(sl.digits)}</text>`);
      if (sl.live) g.push(`<rect class="hit" x="${x0 - 8}" y="0" width="${x1 - x0 + 16}" height="${s.h}"/>`);
      g.push(dot(s.w, s.h / 2, ' out'));
      g.push('</g>');
      return g.join('');
    }
    if (s.kind === 'toggle' || s.kind === 'button') {
      g.push(`<g class="n ${s.kind}" transform="${t}" data-node="${esc(s.key)}">`);
      g.push(`<rect class="box" width="${s.w}" height="${s.h}" rx="4"/>`);
      if (s.kind === 'toggle') {
        g.push(`<text class="lbl" x="10" y="17">${esc(s.label)}</text>`);
        g.push(`<rect class="pill${s.value ? ' on' : ''}" x="${s.w - 50}" y="5" width="40" height="16" rx="8"/>`);
        g.push(`<text class="pilltext${s.value ? ' on' : ''}" x="${s.w - 30}" y="17" text-anchor="middle">${s.value ? 'True' : 'False'}</text>`);
      } else {
        g.push(`<rect class="pill" x="6" y="5" width="${s.w - 16}" height="16" rx="8"/>`);
        g.push(`<text class="pilltext" x="${(s.w - 4) / 2}" y="17" text-anchor="middle">${esc(s.label)}</text>`);
      }
      g.push(dot(s.w, s.h / 2, ' out'));
      g.push('</g>');
      return g.join('');
    }
    if (s.kind === 'panel') {
      g.push(`<g class="n panel" transform="${t}" data-node="${esc(s.key)}">`);
      g.push(`<rect class="box" width="${s.w}" height="${s.h}" rx="3"/>`);
      s.lines.forEach((l, i) => g.push(`<text class="ptext" x="10" y="${19 + i * 15}">${esc(l)}</text>`));
      g.push(dot(0, s.h / 2, ' in'));
      g.push(dot(s.w, s.h / 2, ' out'));
      g.push('</g>');
      return g.join('');
    }
    if (s.kind === 'param') {
      g.push(`<g class="n param" transform="${t}" data-node="${esc(s.key)}">`);
      g.push(`<title>${esc(s.typeName)} parameter</title>`);
      g.push(`<rect class="box" width="${s.w}" height="${s.h}" rx="4"/>`);
      g.push(`<text class="name" x="${s.w / 2}" y="17" text-anchor="middle">${esc(s.label)}</text>`);
      g.push(dot(0, s.h / 2, ' in'));
      g.push(dot(s.w, s.h / 2, ' out'));
      g.push('</g>');
      return g.join('');
    }

    // component
    const c = s.comp;
    const href = c.slug ? `{{root}}reference/${c.slug}.html` : null;
    g.push(`<g class="n comp" transform="${t}" data-node="${esc(s.key)}">`);
    g.push(`<rect class="box" width="${s.w}" height="${s.h}" rx="6"/>`);
    g.push(`<line class="sep" x1="0" y1="${HEAD - 4}" x2="${s.w}" y2="${HEAD - 4}"/>`);
    const head = [];
    if (c.icon) head.push(`<image href="{{root}}assets/icons/${esc(c.icon)}" x="${PAD_X}" y="5" width="16" height="16"/>`);
    head.push(`<text class="name" x="${PAD_X + (c.icon ? 22 : 0)}" y="17.5">${esc(s.label)}</text>`);
    if (href) g.push(`<a href="${href}"><title>${esc(c.name)}: ${esc(c.description || '')}</title>${head.join('')}</a>`);
    else g.push(head.join(''));

    s.inIdx.forEach((pi, row) => {
      const p = s.inputs[pi];
      const y = s.rowsTop + row * ROW + ROW / 2 + 3;
      const cls = p.optional ? 'pl opt' : 'pl';
      g.push(`<g class="pin"><title>${portTitle(p, 'in')}</title><rect class="phit" x="0" y="${y - 10}" width="${s.w / 2}" height="${ROW}"/><text class="${cls}" x="${PAD_X}" y="${y + 4}">${esc(p.name)}</text>${dot(0, y, ' in')}</g>`);
    });
    s.outIdx.forEach((pi, row) => {
      const p = s.outputs[pi];
      const y = s.rowsTop + row * ROW + ROW / 2 + 3;
      g.push(`<g class="pout"><title>${portTitle(p, 'out')}</title><rect class="phit" x="${s.w / 2}" y="${y - 10}" width="${s.w / 2}" height="${ROW}"/><text class="pl" x="${s.w - PAD_X}" y="${y + 4}" text-anchor="end">${esc(p.name)}</text>${dot(s.w, y, ' out')}</g>`);
    });
    const rows = Math.max(s.inIdx.length, s.outIdx.length, 1);
    let yy = s.rowsTop + rows * ROW;
    yy += 6;
    if (s.events) {
      const x0 = PAD_X, x1 = s.w - PAD_X, top = yy + 4;
      g.push(`<g class="evt" data-x0="${x0}" data-x1="${x1}">`);
      g.push(`<rect class="evbg" x="${x0 - 4}" y="${top - 6}" width="${x1 - x0 + 8}" height="${s.events.length * 12 + 12}" rx="3"/>`);
      s.events.forEach((e, i) => {
        const ex = x0 + e.a * (x1 - x0), ew = Math.max(2, (e.b - e.a) * (x1 - x0));
        g.push(`<rect class="evbar" x="${ex.toFixed(1)}" y="${top + i * 12}" width="${ew.toFixed(1)}" height="8" rx="2"/>`);
      });
      g.push(`<line class="playhead" x1="${x0}" y1="${top - 4}" x2="${x0}" y2="${top + s.events.length * 12 + 2}" style="display:none"/>`);
      g.push('</g>');
      yy += s.extraH;
    }
    s.buttons.forEach((b, i) => {
      const by = yy + i * (BTN_H + 4);
      g.push(`<rect class="btn" x="8" y="${by}" width="${s.w - 16}" height="${BTN_H}" rx="4"/><text class="btntext" x="${s.w / 2}" y="${by + 14}" text-anchor="middle">${esc(b)}</text>`);
    });
    g.push('</g>');
    return g.join('');
  }
}

// ---------------------------------------------------------------- evaluation (for live sliders)

export function ease(x, mode) {
  switch (mode) {
    case 'in': return x * x * x;
    case 'out': { const u = 1 - x; return 1 - u * u * u; }
    case 'inout': if (x < 0.5) return 4 * x * x * x; { const u = -2 * x + 2; return 1 - u * u * u / 2; }
    default: return x;
  }
}

// Returns Map("node:outputIndex" -> number) for everything we know how to compute.
export function evaluate(model, sliderValues) {
  const values = new Map();
  const byKey = new Map(model.nodes.map(n => [n.key, n]));
  const inputOf = (key, ti) => {
    const w = model.wires.find(w => w.b === key && w.ti === ti);
    return w ? values.get(`${w.a}:${w.fi}`) : undefined;
  };
  // simple fixed-point: a handful of passes is plenty for small diagrams
  for (let pass = 0; pass < 6; pass++) {
    for (const n of model.nodes) {
      if (n.kind === 'slider') values.set(`${n.key}:0`, sliderValues[n.key] ?? n.slider.value);
      else if (n.kind === 'panel') { const v = inputOf(n.key, 0); if (v !== undefined) values.set(`${n.key}:0`, v); }
      else if (n.kind === 'param') { const v = inputOf(n.key, 0); if (v !== undefined) values.set(`${n.key}:0`, v); }
      else if (n.comp === 'EventTimeline') {
        const t = inputOf(n.key, 0);
        if (t === undefined) continue;
        n.events.forEach((e, i) => {
          let v;
          if (t < e.a) v = 0; else if (t > e.b) v = 1;
          else v = ease(Math.min(1, Math.max(0, (e.b - e.a) > 1e-12 ? (t - e.a) / (e.b - e.a) : 1)), n.ease);
          values.set(`${n.key}:${2 + i}`, v);
        });
      } else if (n.comp === 'DurationCounter' || n.comp === 'ViewCaptureDriver') {
        // these produce t themselves; a live slider wired into nothing stands in for them in demos
      }
    }
  }
  void byKey;
  return values;
}

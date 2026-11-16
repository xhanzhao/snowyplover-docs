// Menu, theme switch, search, and live sliders in diagrams.
// The build bundles this file with evaluate() from diagram.js into assets/site.bundle.js, a plain
// script, so the site also works when opened straight from disk (file://) without a server.
const root = new URL('.', document.currentScript.src).href.replace(/assets\/$/, '');

// ---------------------------------------------------------------- menu + theme

const menu = document.querySelector('.menu');
menu?.addEventListener('click', () => {
  const open = document.body.classList.toggle('nav-open');
  menu.setAttribute('aria-expanded', String(open));
});
document.querySelector('.side')?.addEventListener('click', (e) => {
  if (e.target.closest('a')) document.body.classList.remove('nav-open');
});

document.querySelector('.theme')?.addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('sp-theme', next); } catch { /* private mode */ }
});

// keep the current page visible in a long sidebar
document.querySelector('.side a[aria-current="page"]')?.scrollIntoView({ block: 'center' });

// ---------------------------------------------------------------- search

const box = document.querySelector('.search input');
const list = document.querySelector('.search .results');
let index = null;
let active = -1;

async function loadIndex() {
  if (index) return index;
  // a script tag instead of fetch(), because fetch() is blocked on file://
  if (!window.SP_SEARCH) {
    await new Promise((done) => {
      const el = document.createElement('script');
      el.src = root + 'assets/search.js';
      el.onload = el.onerror = done;
      document.head.appendChild(el);
    });
  }
  index = window.SP_SEARCH || [];
  return index;
}

function score(item, q) {
  const t = item.title.toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  let s = 0;
  for (const w of words) {
    if (t === w) s += 100;
    else if (t.startsWith(w)) s += 40;
    else if (t.split(/\s+/).some(x => x.startsWith(w))) s += 25;
    else if (t.includes(w)) s += 15;
    else if (item.text.toLowerCase().includes(w)) s += 4;
    else return 0;
  }
  return s + (item.kind === 'component' ? 1 : 0);
}

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

async function search() {
  const q = box.value.trim().toLowerCase();
  if (!q) { list.hidden = true; return; }
  const items = (await loadIndex()).map(i => [i, score(i, q)]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 10);
  active = items.length ? 0 : -1;
  list.innerHTML = items.length ? items.map(([i], k) =>
    `<li><a href="${root + i.url}"${k === 0 ? ' class="on"' : ''}>${i.icon ? `<img src="${root}assets/icons/${i.icon}" alt="">` : '<span class="dot">·</span>'}${esc(i.title)}<small>${i.kind === 'component' ? 'Component' : 'Page'}</small></a></li>`).join('')
    : '<li class="none">Nothing found</li>';
  list.hidden = false;
}

if (box) {
  box.addEventListener('input', search);
  box.addEventListener('focus', () => { loadIndex(); if (box.value) search(); });
  box.addEventListener('keydown', (e) => {
    const links = [...list.querySelectorAll('a')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!links.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length;
      links.forEach((a, i) => a.classList.toggle('on', i === active));
    } else if (e.key === 'Enter' && links[active]) {
      location.href = links[active].href;
    } else if (e.key === 'Escape') {
      box.value = ''; list.hidden = true; box.blur();
    }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) list.hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== box && !/input|textarea/i.test(document.activeElement.tagName)) {
      e.preventDefault(); box.focus();
    }
  });
}

// ---------------------------------------------------------------- live diagrams

for (const svg of document.querySelectorAll('svg.gh')) {
  const sliders = [...svg.querySelectorAll('.slider.live')];
  if (!sliders.length) continue;
  const model = JSON.parse(svg.dataset.model);
  const values = {};

  const update = () => {
    const v = evaluate(model, values);
    model.wires.forEach((w, i) => {
      const tag = svg.querySelector(`.wv[data-w="${i}"]`);
      const val = v.get(`${w.a}:${w.fi}`);
      if (!tag) return;
      if (val === undefined || !w.hot) { tag.classList.remove('on'); return; }
      tag.classList.add('on');
      tag.querySelector('text').textContent = val.toFixed(2);
    });
    // Event Timeline: playhead and the bars that are running
    for (const n of model.nodes) {
      if (n.comp !== 'EventTimeline') continue;
      const g = svg.querySelector(`.n[data-node="${CSS.escape(n.key)}"] .evt`);
      const w = model.wires.find(x => x.b === n.key && x.ti === 0);
      const t = w ? v.get(`${w.a}:${w.fi}`) : undefined;
      if (!g || t === undefined) continue;
      const x0 = +g.dataset.x0, x1 = +g.dataset.x1;
      const head = g.querySelector('.playhead');
      const x = x0 + Math.min(1, Math.max(0, t)) * (x1 - x0);
      head.setAttribute('x1', x); head.setAttribute('x2', x); head.style.display = '';
      g.querySelectorAll('.evbar').forEach((bar, i) => {
        const e = n.events[i];
        bar.classList.toggle('active', t >= e.a && t <= e.b);
      });
    }
  };

  for (const g of sliders) {
    const key = g.dataset.node;
    const min = +g.dataset.min, max = +g.dataset.max, digits = +g.dataset.digits;
    const x0 = +g.dataset.x0, x1 = +g.dataset.x1;
    const knob = g.querySelector('.knob');
    const label = g.querySelector('.val');
    const hit = g.querySelector('.hit');
    values[key] = +g.dataset.value;

    const set = (clientX) => {
      const pt = svg.createSVGPoint();
      pt.x = clientX; pt.y = 0;
      const local = pt.matrixTransform(g.getScreenCTM().inverse());
      const f = Math.min(1, Math.max(0, (local.x - x0) / (x1 - x0)));
      const value = min + f * (max - min);
      values[key] = +value.toFixed(digits);
      knob.setAttribute('x', (x0 + f * (x1 - x0) - 4).toFixed(1));
      label.textContent = values[key].toFixed(digits);
      update();
    };
    hit.addEventListener('pointerdown', (e) => {
      hit.setPointerCapture(e.pointerId);
      set(e.clientX);
      const move = (ev) => set(ev.clientX);
      const up = () => { hit.removeEventListener('pointermove', move); hit.removeEventListener('pointerup', up); };
      hit.addEventListener('pointermove', move);
      hit.addEventListener('pointerup', up);
    });
    // keyboard: focus the slider and use the arrow keys
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'slider');
    g.setAttribute('aria-valuemin', min); g.setAttribute('aria-valuemax', max);
    g.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const step = (max - min) / 50 * (e.key === 'ArrowRight' ? 1 : -1);
      const value = Math.min(max, Math.max(min, values[key] + step));
      values[key] = +value.toFixed(digits);
      const f = (value - min) / (max - min);
      knob.setAttribute('x', (x0 + f * (x1 - x0) - 4).toFixed(1));
      label.textContent = values[key].toFixed(digits);
      g.setAttribute('aria-valuenow', values[key]);
      update();
    });
  }
  update();
}

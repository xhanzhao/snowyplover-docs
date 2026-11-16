// Builds the static site into dist/.
//
//   node tools/build.mjs          build once
//   node tools/build.mjs --check  build and fail on any diagram error (used in CI)
//
// Pages live in src/pages as HTML fragments with a small header comment. Reference pages are
// generated from data/components.json, plus optional hand-written notes in src/notes/<slug>.html.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDiagram, makeCatalog } from '../src/assets/diagram.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'components.json'), 'utf8'));
const catalog = makeCatalog(data);
const components = data.components.filter(c => c.kind === 'component');
const SITE = 'SnowyPlover';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const problems = [];

// ---------------------------------------------------------------- pages

function readPage(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const m = /^<!--([\s\S]*?)-->\s*/.exec(raw);
  const meta = {};
  if (m) for (const line of m[1].split('\n')) {
    const kv = /^\s*(\w+)\s*:\s*(.*?)\s*$/.exec(line);
    if (kv) meta[kv[1]] = kv[2];
  }
  return { meta, body: m ? raw.slice(m[0].length) : raw };
}

const pageFiles = [];
(function walk(dir, rel = '') {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) walk(path.join(dir, e.name), rel + e.name + '/');
    else if (e.name.endsWith('.html')) pageFiles.push({ file: path.join(dir, e.name), url: rel + e.name });
  }
})(path.join(SRC, 'pages'));

const pages = pageFiles.map(p => ({ ...p, ...readPage(p.file) }));
const GROUPS = ['Getting started', 'Tutorials', 'Help'];
pages.sort((a, b) => GROUPS.indexOf(a.meta.group) - GROUPS.indexOf(b.meta.group) || (+a.meta.order || 0) - (+b.meta.order || 0));

// ---------------------------------------------------------------- shared bits

function nav(current, root) {
  const out = ['<nav class="side" aria-label="Site">'];
  for (const g of GROUPS) {
    const list = pages.filter(p => p.meta.group === g);
    if (!list.length) continue;
    out.push(`<div class="nav-group"><div class="nav-title">${esc(g)}</div><ul>`);
    for (const p of list) {
      const href = root + p.url;
      out.push(`<li><a href="${href}"${p.url === current ? ' aria-current="page"' : ''}>${esc(p.meta.nav || p.meta.title)}</a></li>`);
    }
    out.push('</ul></div>');
  }
  out.push('<div class="nav-group"><div class="nav-title">Reference</div><ul>');
  out.push(`<li><a href="${root}reference/index.html"${current === 'reference/index.html' ? ' aria-current="page"' : ''}>All components</a></li>`);
  for (const s of data.sections) {
    if (s.id.startsWith('00')) continue;
    const list = components.filter(c => c.section === s.id);
    const open = list.some(c => current === `reference/${c.slug}.html`);
    out.push(`<li><details${open ? ' open' : ''}><summary>${esc(s.title)}</summary><ul>`);
    for (const c of list) {
      out.push(`<li><a href="${root}reference/${c.slug}.html"${current === `reference/${c.slug}.html` ? ' aria-current="page"' : ''}>${esc(c.name)}</a></li>`);
    }
    out.push('</ul></details></li>');
  }
  out.push('</ul></div></nav>');
  return out.join('');
}

function layout({ title, body, url, description }) {
  const depth = url.split('/').length - 1;
  const root = depth ? '../'.repeat(depth) : './';
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title === SITE ? `${SITE}: animation tools for Grasshopper` : `${title} · ${SITE}`)}</title>
<meta name="description" content="${esc(description || 'SnowyPlover is a Grasshopper plugin for architectural animation: cameras, timelines, effects and frame export.')}">
<link rel="icon" href="${root}assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${root}assets/style.css">
<script>try{const t=localStorage.getItem('sp-theme');if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
</head>
<body>
<header class="top">
  <button class="menu" aria-label="Menu" aria-expanded="false"><svg width="18" height="18" viewBox="0 0 18 18"><path d="M2 4h14M2 9h14M2 14h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
  <a class="brand" href="${root}index.html"><img src="${root}assets/favicon.svg" alt="" width="20" height="20">SnowyPlover</a>
  <div class="search">
    <input type="search" placeholder="Search" aria-label="Search" autocomplete="off" spellcheck="false">
    <kbd>/</kbd>
    <ul class="results" hidden></ul>
  </div>
  <button class="theme" aria-label="Switch light or dark"><svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="currentColor"/></svg></button>
</header>
<div class="wrap">
${nav(url, root)}
<main>
${body}
<footer class="foot">Component data from SnowyPlover source <code>${esc(data.sourceCommit || '')}</code>, ${esc(data.generated)}.</footer>
</main>
</div>
<script type="module" src="${root}assets/site.js"></script>
</body>
</html>
`;
  return html.replace(/\{\{root\}\}/g, root);
}

// [[Animate Keyframes]] -> link with icon. [[Animate Keyframes|text]] for custom text.
function linkComponents(html, where) {
  return html.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (all, ref, text) => {
    const c = catalog.find(ref.trim());
    if (!c) { problems.push(`${where}: unknown component link [[${ref}]]`); return esc(text || ref); }
    const icon = c.icon ? `<img src="{{root}}assets/icons/${c.icon}" alt="" width="16" height="16">` : '';
    if (c.kind === 'param') return `<span class="cref">${icon}${esc(text || c.name)}</span>`;
    return `<a class="cref" href="{{root}}reference/${c.slug}.html">${icon}${esc(text || c.name)}</a>`;
  });
}

let diagramCount = 0;
function diagrams(html, where) {
  return html.replace(/<pre class="diagram"([^>]*)>([\s\S]*?)<\/pre>/g, (all, attrs, src) => {
    const caption = /data-caption="([^"]*)"/.exec(attrs);
    const text = src.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
    const { svg, errors } = renderDiagram(text, catalog, { id: `d${++diagramCount}` });
    for (const e of errors) problems.push(`${where}: diagram ${diagramCount}: ${e}`);
    return `<figure class="diagram"><div class="canvas">${svg}</div>${caption ? `<figcaption>${caption[1]}</figcaption>` : ''}</figure>`;
  });
}

const transform = (html, where) => diagrams(linkComponents(html, where), where);

// ---------------------------------------------------------------- reference pages

function portTable(list, side) {
  if (!list.length) return `<p class="muted">No ${side === 'in' ? 'inputs' : 'outputs'}.</p>`;
  const rows = list.map(p => {
    const def = p.default !== undefined && p.default !== '' ? `<code>${esc(p.default)}</code>` : (side === 'in' && p.optional ? '<span class="muted">optional</span>' : '');
    const values = p.values ? `<div class="values">${p.values.map(v => `<span><code>${esc(v.value)}</code> ${esc(v.label)}</span>`).join('')}</div>` : '';
    return `<tr><td><span class="pname">${esc(p.name)}</span>${p.nickname && p.nickname !== p.name ? ` <span class="nick">${esc(p.nickname)}</span>` : ''}</td>` +
      `<td><span class="type">${esc(p.type)}</span>${p.access !== 'item' ? ` <span class="access">${esc(p.access)}</span>` : ''}</td>` +
      (side === 'in' ? `<td>${def}</td>` : '') +
      `<td>${esc(p.description)}${values}</td></tr>`;
  }).join('');
  return `<div class="table"><table><thead><tr><th>Name</th><th>Type</th>${side === 'in' ? '<th>Default</th>' : ''}<th>Description</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function referencePage(c) {
  const url = `reference/${c.slug}.html`;
  const notesFile = path.join(SRC, 'notes', `${c.slug}.html`);
  const notes = fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8') : '';
  const section = data.sections.find(s => s.id === c.section);
  const siblings = components.filter(x => x.section === c.section);
  const i = siblings.indexOf(c);
  const prev = siblings[i - 1], next = siblings[i + 1];
  let glance = `c = ${c.id}`;
  if (c.id === 'EventTimeline') glance += ' events="0-0.4, 0.3-0.7, 0.6-1"';
  const body = `
<p class="crumb"><a href="{{root}}reference/index.html">Reference</a> / ${esc(section.title)}</p>
<h1 class="cname">${c.icon ? `<img src="{{root}}assets/icons/${c.icon}" alt="" width="24" height="24">` : ''}${esc(c.name)}</h1>
<p class="meta"><span>Nickname <code>${esc(c.nickname)}</code></span><span>Tab <code>${esc(c.category)} › ${esc(c.section)}</code></span>${c.buttons.length ? `<span>Button <code>${c.buttons.map(esc).join('</code> <code>')}</code></span>` : ''}</p>
<p class="lead">${esc(c.description).replace(/\n/g, '<br>')}</p>
<pre class="diagram">${esc(glance)}</pre>
${notes}
<h2 id="inputs">Inputs</h2>
${portTable(c.inputs, 'in')}
<h2 id="outputs">Outputs</h2>
${portTable(c.outputs, 'out')}
${c.variableParams ? '<p class="muted">Outputs <code>event 1 … event N</code> are added and removed as you edit the events on the component.</p>' : ''}
<nav class="pager">${prev ? `<a href="{{root}}reference/${prev.slug}.html"><span>Previous</span>${esc(prev.name)}</a>` : '<span></span>'}${next ? `<a class="next" href="{{root}}reference/${next.slug}.html"><span>Next</span>${esc(next.name)}</a>` : ''}</nav>
`;
  return { url, title: c.name, description: c.description, body: transform(body, url) };
}

function referenceIndex() {
  const parts = ['<h1>Components</h1>', `<p class="lead">All ${components.length} components, by the section they sit in on the SnowyPlover tab. Hover a port in any diagram to see its type and description.</p>`];
  for (const s of data.sections) {
    if (s.id.startsWith('00')) continue;
    parts.push(`<h2 id="${esc(s.title.toLowerCase())}">${esc(s.title)}</h2><ul class="cards">`);
    for (const c of components.filter(x => x.section === s.id)) {
      const first = (c.description || '').split(/(?<=\.)\s|\n/)[0];
      parts.push(`<li><a href="{{root}}reference/${c.slug}.html">${c.icon ? `<img src="{{root}}assets/icons/${c.icon}" alt="" width="24" height="24">` : ''}<span><b>${esc(c.name)}</b><small>${esc(first)}</small></span></a></li>`);
    }
    parts.push('</ul>');
  }
  return { url: 'reference/index.html', title: 'Components', body: parts.join('') };
}

// ---------------------------------------------------------------- write

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, 'reference'), { recursive: true });
fs.cpSync(path.join(SRC, 'assets'), path.join(DIST, 'assets'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'data', 'components.json'), path.join(DIST, 'assets', 'components.json'));

const out = [];
for (const p of pages) out.push({ url: p.url, title: p.meta.title, description: p.meta.description, body: transform(p.body, p.url) });
out.push(referenceIndex());
for (const c of components) out.push(referencePage(c));

const search = [];
for (const o of out) {
  fs.mkdirSync(path.dirname(path.join(DIST, o.url)), { recursive: true });
  fs.writeFileSync(path.join(DIST, o.url), layout(o));
  const comp = components.find(c => `reference/${c.slug}.html` === o.url);
  search.push({
    url: o.url, title: o.title, kind: comp ? 'component' : 'page',
    icon: comp ? comp.icon : null,
    text: comp ? [comp.nickname, comp.description, ...comp.inputs.map(p => p.name), ...comp.outputs.map(p => p.name)].join(' ')
      : o.body.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 2000),
  });
}
fs.writeFileSync(path.join(DIST, 'assets', 'search.json'), JSON.stringify(search));
fs.writeFileSync(path.join(DIST, '.nojekyll'), '');
fs.writeFileSync(path.join(DIST, '404.html'), layout({ url: '404.html', title: 'Not found', body: '<h1>Page not found</h1><p>Try the search above, or go back to the <a href="{{root}}index.html">start page</a>.</p>' }).replace(/href="\.\//g, 'href="/snowyplover-docs/').replace(/src="\.\//g, 'src="/snowyplover-docs/'));

console.log(`${out.length} pages, ${diagramCount} diagrams → dist/`);
if (problems.length) {
  console.error(problems.map(p => '  ' + p).join('\n'));
  if (process.argv.includes('--check')) process.exit(1);
}

// Reads the SnowyPlover C# source and writes data/components.json plus the component icons.
//
//   node tools/sync.mjs <path to the SnowyPlover source folder>
//
// The source repository stays private: only names, descriptions, ports and icons end up here.
// Anything the parser cannot read from the source (button labels, dynamic outputs, better
// descriptions) goes in data/overrides.json, which is merged in last.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(process.argv[2] || process.env.SNOWYPLOVER_SRC || '../snowyplover');
if (!fs.existsSync(path.join(SRC, 'SnowyPlover.csproj'))) {
  console.error(`SnowyPlover.csproj not found in ${SRC}\nUsage: node tools/sync.mjs <source folder>`);
  process.exit(1);
}

// ---------------------------------------------------------------- tokenizer

function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); i = i < 0 ? n : i + 2; continue; }
    // strings: "..", @"..", $"..", $@"..", @$".."
    const m = /^(\$@|@\$|@|\$)?"/.exec(src.slice(i, i + 3));
    if (m) {
      const verbatim = m[1] && m[1].includes('@');
      const interp = m[1] && m[1].includes('$');
      let j = i + m[0].length, s = '';
      while (j < n) {
        const d = src[j];
        if (verbatim) {
          if (d === '"' && src[j + 1] === '"') { s += '"'; j += 2; continue; }
          if (d === '"') break;
          s += d; j++;
        } else {
          if (d === '\\') {
            const e = src[j + 1];
            s += e === 'n' ? '\n' : e === 't' ? '\t' : e === '\\' ? '\\' : e === '"' ? '"' : e === '0' ? '' : e;
            j += 2; continue;
          }
          if (d === '"') break;
          s += d; j++;
        }
      }
      toks.push({ t: 'str', v: s, interp });
      i = j + 1; continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== "'") j += src[j] === '\\' ? 2 : 1;
      toks.push({ t: 'chr', v: src.slice(i + 1, j) });
      i = j + 1; continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1]))) {
      const mm = /^[0-9_]*\.?[0-9_]*(?:[eE][+-]?[0-9]+)?[fFdDmMlLuU]*/.exec(src.slice(i));
      toks.push({ t: 'num', v: mm[0] });
      i += mm[0].length; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const mm = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      toks.push({ t: 'id', v: mm[0] });
      i += mm[0].length; continue;
    }
    const two = src.slice(i, i + 2);
    if (['=>', '==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '??', '::'].includes(two)) {
      toks.push({ t: 'p', v: two }); i += 2; continue;
    }
    toks.push({ t: 'p', v: c }); i++;
  }
  return toks;
}

const isP = (tok, v) => tok && tok.t === 'p' && tok.v === v;
const isId = (tok, v) => tok && tok.t === 'id' && (v === undefined || tok.v === v);

function matchClose(toks, i) {
  // toks[i] is an opening bracket; returns index of the matching close
  const open = toks[i].v, close = { '(': ')', '{': '}', '[': ']' }[open];
  let depth = 0;
  for (let j = i; j < toks.length; j++) {
    if (isP(toks[j], open)) depth++;
    else if (isP(toks[j], close)) { depth--; if (depth === 0) return j; }
  }
  return toks.length - 1;
}

// Split the tokens between ( and ) into top-level arguments.
function splitArgs(toks, open) {
  const close = matchClose(toks, open);
  const args = [];
  let cur = [], depth = 0;
  for (let j = open + 1; j < close; j++) {
    const tk = toks[j];
    if (tk.t === 'p' && '([{'.includes(tk.v)) depth++;
    if (tk.t === 'p' && ')]}'.includes(tk.v)) depth--;
    // generic angle brackets inside "new List<double>()" have no commas we care about
    if (depth === 0 && isP(tk, ',')) { args.push(cur); cur = []; continue; }
    cur.push(tk);
  }
  if (cur.length) args.push(cur);
  return { args, close };
}

const exprText = (ts) => ts.map(t => (t.t === 'str' ? JSON.stringify(t.v) : t.v)).join(' ')
  .replace(/ ?([.,()\[\]<>]) ?/g, '$1').replace(/,/g, ', ');

// Evaluate a string expression: literals joined with +, identifiers from the symbol table.
function evalStr(ts, sym) {
  let out = '';
  let ok = false;
  for (const tk of ts) {
    if (tk.t === 'str') { out += tk.v; ok = true; }
    else if (isP(tk, '+') || isP(tk, '(') || isP(tk, ')')) continue;
    else if (tk.t === 'id' && sym.has(tk.v)) { out += sym.get(tk.v); ok = true; }
    else if (isId(tk, 'Environment') || isP(tk, '.') || isId(tk, 'NewLine')) { if (isId(tk, 'NewLine')) out += '\n'; }
    else return ok ? out : null;
  }
  return ok ? out : null;
}

// Collect simple constants: const X = ...; X => "..."; static readonly X = ...;
function collectSymbols(toks, sym) {
  for (let i = 0; i < toks.length - 2; i++) {
    const a = toks[i], b = toks[i + 1];
    if (a.t !== 'id') continue;
    let start = -1;
    if (isP(b, '=>')) start = i + 2;
    else if (isP(b, '=') && i > 0 && toks[i - 1].t === 'id' &&
      ['string', 'int', 'double'].includes(toks[i - 1].v) &&
      toks.slice(Math.max(0, i - 4), i).some(t => isId(t, 'const') || isId(t, 'readonly'))) start = i + 2;
    if (start < 0) continue;
    let end = start;
    while (end < toks.length && !isP(toks[end], ';')) end++;
    const ex = toks.slice(start, end);
    const s = evalStr(ex, sym);
    if (s !== null) { if (!sym.has(a.v)) sym.set(a.v, s); }
    else if (ex.length === 1 && ex[0].t === 'num' && !sym.has(a.v)) sym.set(a.v, ex[0].v);
    else if (ex.length === 2 && isP(ex[0], '-') && ex[1].t === 'num' && !sym.has(a.v)) sym.set(a.v, '-' + ex[1].v);
  }
}

// ---------------------------------------------------------------- params

const TYPE_FROM_METHOD = {
  AddBooleanParameter: 'Boolean', AddBoxParameter: 'Box', AddColourParameter: 'Colour',
  AddCurveParameter: 'Curve', AddGenericParameter: 'Generic', AddGeometryParameter: 'Geometry',
  AddIntegerParameter: 'Integer', AddIntervalParameter: 'Domain', AddLineParameter: 'Line',
  AddMeshParameter: 'Mesh', AddNumberParameter: 'Number', AddPlaneParameter: 'Plane',
  AddPointParameter: 'Point', AddSurfaceParameter: 'Surface', AddTextParameter: 'Text',
  AddTransformParameter: 'Transform', AddVectorParameter: 'Vector', AddBrepParameter: 'Brep',
  AddColorParameter: 'Colour',
};
const TYPE_FROM_CLASS = {
  Param_Camera: 'Camera', Param_Integer: 'Integer', Param_Number: 'Number', Param_Boolean: 'Boolean',
  Param_String: 'Text', Param_Geometry: 'Geometry', Param_Curve: 'Curve', Param_GenericObject: 'Generic',
  Param_TransitionToggle: 'Integer',
};

function paramTypeFromClass(name, classes) {
  if (TYPE_FROM_CLASS[name]) return TYPE_FROM_CLASS[name];
  const c = classes.get(name);
  if (c && c.base) return paramTypeFromClass(c.base, classes);
  return name.replace(/^Param_/, '');
}

function defaultValue(ts, sym) {
  if (!ts || !ts.length) return undefined;
  const s = evalStr(ts, sym);
  if (s !== null) return s;
  if (ts.length === 1 && ts[0].t === 'num') return ts[0].v.replace(/[fFdDmM]$/, '');
  if (ts.length === 2 && isP(ts[0], '-') && ts[1].t === 'num') return '-' + ts[1].v.replace(/[fFdDmM]$/, '');
  if (ts.length === 1 && ts[0].t === 'id') {
    if (['true', 'false'].includes(ts[0].v)) return ts[0].v;
    if (sym.has(ts[0].v)) return sym.get(ts[0].v);
  }
  if (ts.length >= 1 && isId(ts[0], 'new')) {
    const txt = exprText(ts);
    if (/^new\s*List<\w+>\(\)$/.test(txt)) return undefined; // empty list = no default
    const col = /^new\s*Color\s*\(\s*([^)]*)\)/.exec(txt) || /Color\.FromArgb\(([^)]*)\)/.exec(txt);
    if (col) return `rgb(${col[1]})`;
    const iv = /^new\s*Interval\((.*), (.*)\)$/.exec(txt);
    if (iv) return `${iv[1]} to ${iv[2]}`;
    const vec = /^new\s*(?:Vector3d|Point3d)\((.*)\)$/.exec(txt);
    if (vec) return `{${vec[1]}}`;
    return txt.replace(/^new\s*/, '');
  }
  const txt = exprText(ts);
  const named = /^(?:System\.Drawing\.)?Color\.(\w+)$/.exec(txt);
  if (named) return named[1];
  const fromArgb = /^Color\.FromArgb\((.*)\)$/.exec(txt);
  if (fromArgb) return `rgb(${fromArgb[1]})`;
  if (/^string\.Empty$|^String\.Empty$/.test(txt)) return '';
  if (/^Plane\.World(XY|YZ|ZX)$/.test(txt)) return txt.replace('Plane.', '');
  if (/^Vector3d\.\w+$|^Point3d\.\w+$/.test(txt)) return txt.replace(/^\w+\./, '');
  const iv = /^new Interval\((.*), (.*)\)$/.exec(txt) || /^Interval\((.*), (.*)\)$/.exec(txt);
  if (iv) return `${iv[1]} to ${iv[2]}`;
  return txt;
}

function accessOf(ts) {
  const t = exprText(ts || []);
  if (/list/.test(t)) return 'list';
  if (/tree/.test(t)) return 'tree';
  return 'item';
}

// Parse a Register*Params body into a list of params.
function parseRegister(toks, bodyStart, bodyEnd, sym, classes) {
  const params = [];
  const varIndex = new Map();   // local int var -> param index ("int format = pManager.Add...")
  const varParam = new Map();   // local var -> param object from "var p = new Param_X { ... }"
  const pending = new Map();    // var name -> param object not yet added

  for (let i = bodyStart; i < bodyEnd; i++) {
    const tk = toks[i];

    // var p = new Param_X { Name = .., NickName = .., Description = .., Access = .., Optional = .. };
    if ((isId(tk, 'var') || (tk.t === 'id' && /^Param_/.test(tk.v))) && isId(toks[i + 1]) && isP(toks[i + 2], '=') && isId(toks[i + 3], 'new')) {
      let j = i + 4;
      while (isP(toks[j + 1], '.') && isId(toks[j + 2])) j += 2;
      const cls = toks[j].v;
      j++;
      while (j < bodyEnd && !isP(toks[j], '{') && !isP(toks[j], ';')) j++;
      const p = { name: '', nickname: '', description: '', type: paramTypeFromClass(cls, classes), access: 'item', optional: false };
      if (isP(toks[j], '{')) {
        const close = matchClose(toks, j);
        // property = expr, ...
        let k = j + 1;
        while (k < close) {
          if (isId(toks[k]) && isP(toks[k + 1], '=')) {
            const key = toks[k].v;
            let e = k + 2, depth = 0;
            const ex = [];
            while (e < close) {
              if (toks[e].t === 'p' && '([{'.includes(toks[e].v)) depth++;
              if (toks[e].t === 'p' && ')]}'.includes(toks[e].v)) depth--;
              if (depth === 0 && isP(toks[e], ',')) break;
              ex.push(toks[e]); e++;
            }
            if (key === 'Name') p.name = evalStr(ex, sym) ?? '';
            if (key === 'NickName') p.nickname = evalStr(ex, sym) ?? '';
            if (key === 'Description') p.description = evalStr(ex, sym) ?? '';
            if (key === 'Access') p.access = accessOf(ex);
            if (key === 'Optional') p.optional = exprText(ex) === 'true';
            k = e + 1;
          } else k++;
        }
      }
      pending.set(toks[i + 1].v, p);
      continue;
    }

    // pManager.AddXParameter( ... )
    if (isId(tk, 'pManager') && isP(toks[i + 1], '.') && isId(toks[i + 2]) && /^Add\w*Parameter$/.test(toks[i + 2].v) && isP(toks[i + 3], '(')) {
      const method = toks[i + 2].v;
      const { args, close } = splitArgs(toks, i + 3);
      let p;
      if (method === 'AddParameter') {
        if (args.length === 1 && args[0].length === 1 && args[0][0].t === 'id' && pending.has(args[0][0].v)) {
          p = pending.get(args[0][0].v);
          varParam.set(args[0][0].v, p);
        } else {
          const first = args[0] || [];
          let type;
          if (first.length === 1 && first[0].t === 'id' && pending.has(first[0].v)) type = pending.get(first[0].v).type;
          else if (isId(first[0], 'new')) {
            let k = 1;
            while (isP(first[k + 1], '.') && isId(first[k + 2])) k += 2;
            type = paramTypeFromClass(first[k].v, classes);
          } else type = 'Generic';
          p = {
            name: evalStr(args[1] || [], sym) ?? '',
            nickname: evalStr(args[2] || [], sym) ?? '',
            description: evalStr(args[3] || [], sym) ?? '',
            type,
            access: accessOf(args[4]),
            optional: false,
          };
        }
      } else {
        p = {
          name: evalStr(args[0] || [], sym) ?? exprText(args[0] || []),
          nickname: evalStr(args[1] || [], sym) ?? exprText(args[1] || []),
          description: evalStr(args[2] || [], sym) ?? '',
          type: TYPE_FROM_METHOD[method] || method.replace(/^Add|Parameter$/g, ''),
          access: accessOf(args[3]),
          optional: false,
        };
        const def = defaultValue(args[4], sym);
        if (def !== undefined) { p.default = def; p.optional = true; }
      }
      const index = params.length;
      params.push(p);
      // "int format = pManager.Add..."
      if (i >= 3 && isP(toks[i - 1], '=') && isId(toks[i - 2])) varIndex.set(toks[i - 2].v, index);
      i = close;
      continue;
    }

    // pManager[N].Optional = true;   pManager[var].Optional = true;
    if (isId(tk, 'pManager') && isP(toks[i + 1], '[')) {
      const close = matchClose(toks, i + 1);
      const inner = toks.slice(i + 2, close);
      let idx = -1;
      if (inner.length === 1 && inner[0].t === 'num') idx = parseInt(inner[0].v, 10);
      else if (inner.length === 1 && varIndex.has(inner[0].v)) idx = varIndex.get(inner[0].v);
      if (idx >= 0 && params[idx] && isP(toks[close + 1], '.') && isId(toks[close + 2], 'Optional') && isP(toks[close + 3], '=')) {
        params[idx].optional = isId(toks[close + 4], 'true');
      }
      // var x = (Param_Integer)pManager[format];
      if (idx >= 0 && params[idx] && i >= 6 && isP(toks[i - 1], ')')) {
        let k = i - 1;
        while (k > bodyStart && !isP(toks[k], '=')) k--;
        if (isId(toks[k - 1])) varParam.set(toks[k - 1].v, params[idx]);
      }
      i = close;
      continue;
    }

    // x.AddNamedValue("label", value);
    if (isId(tk) && isP(toks[i + 1], '.') && isId(toks[i + 2], 'AddNamedValue') && isP(toks[i + 3], '(')) {
      const p = varParam.get(tk.v) || pending.get(tk.v);
      const { args, close } = splitArgs(toks, i + 3);
      if (p) {
        (p.values ||= []).push({ value: defaultValue(args[1], sym), label: evalStr(args[0], sym) ?? exprText(args[0]) });
      }
      i = close;
    }
  }
  return params;
}

// ---------------------------------------------------------------- classes

function findMethodBody(toks, from, to, name) {
  for (let i = from; i < to; i++) {
    if (isId(toks[i], name) && isP(toks[i + 1], '(')) {
      const pc = matchClose(toks, i + 1);
      if (isP(toks[pc + 1], '{')) return [pc + 1, matchClose(toks, pc + 1)];
    }
  }
  return null;
}

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || ['bin', 'obj', 'Properties'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.cs')) files.push(p);
  }
})(SRC);

const classes = new Map();
const globalSym = new Map();
for (const f of files) {
  const toks = tokenize(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
  for (let i = 0; i < toks.length; i++) {
    if (isId(toks[i], 'class') && isId(toks[i + 1])) {
      const name = toks[i + 1].v;
      let j = i + 2, base = null;
      if (isP(toks[j], ':')) {
        let k = j + 1;
        base = toks[k].v;
        while (isP(toks[k + 1], '.') && isId(toks[k + 2])) { k += 2; base = toks[k].v; }
      }
      while (j < toks.length && !isP(toks[j], '{')) j++;
      const end = matchClose(toks, j);
      const sym = new Map();
      collectSymbols(toks.slice(j, end), sym);
      classes.set(name, { name, base, file: f, toks, start: j, end, sym });
      i = j; // nested classes are found on the next pass of the loop
    }
  }
  collectSymbols(toks, globalSym);
}

// Resolve symbols along the inheritance chain (derived first).
function symbolsFor(cls) {
  const s = new Map();
  for (let c = cls; c; c = classes.get(c.base)) for (const [k, v] of c.sym) if (!s.has(k)) s.set(k, v);
  for (const [k, v] of globalSym) if (!s.has(k)) s.set(k, v);
  return s;
}

function registerFor(cls, method, sym) {
  for (let c = cls; c; c = classes.get(c.base)) {
    const body = findMethodBody(c.toks, c.start, c.end, method);
    if (body) return parseRegister(c.toks, body[0], body[1], sym, classes);
  }
  return [];
}

function constructorInfo(cls, sym) {
  const { toks, start, end } = cls;
  for (let i = start; i < end; i++) {
    if (isId(toks[i], cls.name) && isP(toks[i + 1], '(')) {
      const pc = matchClose(toks, i + 1);
      if (isP(toks[pc + 1], ':') && isId(toks[pc + 2], 'base') && isP(toks[pc + 3], '(')) {
        const { args } = splitArgs(toks, pc + 3);
        if (args.length >= 5) {
          const vals = args.map(a => evalStr(a, sym));
          if (vals[3] && /^snowyplover$/i.test(vals[3])) {
            return { name: vals[0].trim(), nickname: vals[1], description: vals[2], category: vals[3], section: vals[4] };
          }
        }
      }
    }
  }
  return null;
}

function grab(cls, re) {
  for (let c = cls; c; c = classes.get(c.base)) {
    const src = c.toks.slice(c.start, c.end).map(t => t.t === 'str' ? JSON.stringify(t.v) : t.v).join(' ');
    const m = re.exec(src);
    if (m) return m;
  }
  return null;
}

function guidOf(cls) {
  const m = grab(cls, /ComponentGuid\s*=>\s*new Guid\s*\(\s*"([0-9a-fA-F-]+)"/);
  return m ? m[1].toLowerCase() : null;
}

// Button labels as shown when the component is first placed (the "else" side of a ternary).
function buttonsOf(cls, sym) {
  for (let c = cls; c; c = classes.get(c.base)) {
    const { toks, start, end } = c;
    for (let i = start; i < end; i++) {
      if (isId(toks[i], 'new') && isId(toks[i + 1], 'ComponentButtonAttributes') && isP(toks[i + 2], '(')) {
        const close = matchClose(toks, i + 2);
        const labels = [];
        // each label lambda is "() => <expr>," where expr is a literal, ident, or cond ? a : b
        for (let k = i + 3; k < close; k++) {
          if (isP(toks[k], '(') && isP(toks[k + 1], ')') && isP(toks[k + 2], '=>') && !isP(toks[k + 3], '{')) {
            let e = k + 3;
            const ex = [];
            let depth = 0;
            while (e < close) {
              if (toks[e].t === 'p' && '([{'.includes(toks[e].v)) depth++;
              if (toks[e].t === 'p' && ')]}'.includes(toks[e].v)) { if (depth === 0) break; depth--; }
              if (depth === 0 && isP(toks[e], ',')) break;
              ex.push(toks[e]); e++;
            }
            const colon = ex.findIndex(t => isP(t, ':'));
            const part = colon >= 0 ? ex.slice(colon + 1) : ex;
            const val = evalStr(part, sym);
            if (val !== null) labels.push(val);
            k = e;
          }
        }
        return labels;
      }
    }
  }
  return [];
}

const components = [];
for (const cls of classes.values()) {
  const sym = symbolsFor(cls);
  const info = constructorInfo(cls, sym);
  if (!info) continue;
  const icon = grab(cls, /Icon\s*=>\s*Properties\s*\.\s*Resources\s*\.\s*(\w+)/) ||
    grab(cls, /Icon\s*\{\s*get\s*\{[^}]*?Properties\s*\.\s*Resources\s*\.\s*(\w+)/);
  const exposure = grab(cls, /Exposure\s*=>\s*GH_Exposure\s*\.\s*(\w+)/);
  const isParam = /GH_PersistentParam|GH_Param\b/.test(cls.base || '');
  components.push({
    id: cls.name,
    kind: isParam ? 'param' : 'component',
    ...info,
    guid: guidOf(cls),
    exposure: exposure ? exposure[1] : 'primary',
    icon: icon ? icon[1] : null,
    buttons: isParam ? [] : buttonsOf(cls, sym),
    variableParams: /IGH_VariableParameterComponent/.test(fs.readFileSync(cls.file, 'utf8')),
    inputs: isParam ? [] : registerFor(cls, 'RegisterInputParams', sym),
    outputs: isParam ? [] : registerFor(cls, 'RegisterOutputParams', sym),
    file: path.relative(SRC, cls.file).replace(/\\/g, '/'),
  });
}

// Param_Camera registers through GH_InstanceDescription instead of base(name, ...).
for (const cls of classes.values()) {
  if (components.some(c => c.id === cls.name)) continue;
  const m = grab(cls, /new GH_InstanceDescription\s*\(\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"/);
  if (!m || classes.get(cls.name).file.includes('Attributes')) continue;
  if (!/^snowyplover$/i.test(m[4])) continue;
  const icon = grab(cls, /Icon\s*=>\s*Properties\s*\.\s*Resources\s*\.\s*(\w+)/);
  components.push({
    id: cls.name, kind: 'param', name: m[1], nickname: m[2], description: m[3], category: m[4], section: m[5],
    guid: guidOf(cls), exposure: 'primary', icon: icon ? icon[1] : null, buttons: [], variableParams: false,
    inputs: [], outputs: [], file: path.relative(SRC, cls.file).replace(/\\/g, '/'),
  });
}

// ---------------------------------------------------------------- overrides, slugs, icons

const overridesPath = path.join(ROOT, 'data', 'overrides.json');
const overrides = fs.existsSync(overridesPath) ? JSON.parse(fs.readFileSync(overridesPath, 'utf8')) : {};

const slug = (s) => s.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const EXPOSURE_ORDER = ['primary', 'secondary', 'tertiary', 'quarternary', 'quinary', 'senary', 'septenary', 'octonary', 'hidden'];

for (const c of components) {
  const o = overrides[c.id] || {};
  for (const [k, v] of Object.entries(o)) {
    if (k === 'inputs' || k === 'outputs') {
      for (const [pname, po] of Object.entries(v)) {
        const p = c[k].find(x => x.name === pname);
        if (p) Object.assign(p, po);
        else console.warn(`override: ${c.id}.${k}.${pname} not found`);
      }
    } else c[k] = v;
  }
  c.slug = slug(c.name);
  if (/^description$/i.test((c.description || '').trim()) || (c.description || '').trim() === c.name) c.descriptionMissing = true;
}

components.sort((a, b) =>
  a.section.localeCompare(b.section) ||
  EXPOSURE_ORDER.indexOf(a.exposure) - EXPOSURE_ORDER.indexOf(b.exposure) ||
  a.name.localeCompare(b.name));

const iconDir = path.join(ROOT, 'src', 'assets', 'icons');
fs.mkdirSync(iconDir, { recursive: true });
for (const f of fs.readdirSync(iconDir)) fs.unlinkSync(path.join(iconDir, f));
for (const c of components) {
  if (!c.icon) continue;
  const from = path.join(SRC, 'Resources', c.icon + '.png');
  if (fs.existsSync(from)) {
    fs.copyFileSync(from, path.join(iconDir, c.slug + '.png'));
    c.icon = c.slug + '.png';
  } else { console.warn(`icon missing: ${from}`); c.icon = null; }
}

let commit = null;
try { commit = execSync('git rev-parse --short HEAD', { cwd: SRC }).toString().trim(); } catch { /* not a git checkout */ }

const sections = [...new Set(components.map(c => c.section))].sort().map(id => ({
  id, title: id.replace(/^\d+\s*/, ''),
}));

const out = { generated: new Date().toISOString().slice(0, 10), sourceCommit: commit, sections, components };
for (const c of components) delete c.file;
fs.writeFileSync(path.join(ROOT, 'data', 'components.json'), JSON.stringify(out, null, 2) + '\n');

console.log(`${components.length} components from ${commit || SRC}`);
for (const c of components) {
  const flag = c.descriptionMissing ? '  (no description)' : '';
  console.log(`  ${c.section.padEnd(12)} ${c.name.padEnd(34)} in ${String(c.inputs.length).padStart(2)}  out ${String(c.outputs.length).padStart(2)}  ${c.buttons.join('/')}${flag}`);
}

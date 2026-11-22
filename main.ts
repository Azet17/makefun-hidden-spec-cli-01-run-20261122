// mend: one patch tool for every AI edit format.
//
// Applies unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edits
// to a tree of text files, following the SPEC.md contract (version 1):
// three-tier line matching, atomic all-or-nothing writes, exact stdout and
// exit codes. Node 22+ standard library only; run as `node main.ts`.
//
// The trial hand-over at the bottom is the kit's runner protocol: when
// MAKEFUN_ENV_URL is set, this file hands the run to runner.ts.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A patch-level failure: exit 2 with this one line on stdout. */
class ParseErr {
  line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit's failure: exit 1, reported as `error: <code> <path>`. */
class Fail {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` removed each, and the
 *  empty piece after a final `\n` dropped. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

/** The leading spaces and tabs of a line. */
function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** One file's lines plus its line break and whether it ends with one. */
interface FileState {
  br: string;
  lines: string[];
  finalBreak: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { br, lines: parts, finalBreak };
}

function joinFile(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.finalBreak ? st.br : '');
}

/** The tree as the edits leave it: paths changed in `now` (null: deleted),
 *  everything else read from disk on demand and cached in `orig`. */
class Tree {
  orig = new Map<string, string | null>();
  now = new Map<string, string | null>();
  moves: { old: string; new: string }[] = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p) as string | null;
  }

  get(p: string): string | null {
    return this.now.has(p) ? (this.now.get(p) as string | null) : this.original(p);
  }
}

type EditFn = (tree: Tree) => void;

/** One line of an old/new pair: a context line (in both), an old-only line,
 *  or a new-only line. `noEol` is set when a `\` line follows it. */
interface Item {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  noEol: boolean;
}

/** Split a hunk/chunk body into the old lines O and the new lines N.
 *  A context line of N remembers which line of O it is. */
function buildItems(items: Item[]): {
  oTexts: string[];
  nItems: { text: string; oIndex: number | null }[];
} {
  const oTexts: string[] = [];
  const nItems: { text: string; oIndex: number | null }[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      oTexts.push(it.text);
      nItems.push({ text: it.text, oIndex: oTexts.length - 1 });
    } else if (it.kind === 'old') {
      oTexts.push(it.text);
    } else {
      nItems.push({ text: it.text, oIndex: null });
    }
  }
  return { oTexts, nItems };
}

/** A line compared at one matching tier. */
function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** The first tier at which `oldLines` occurs in `lines` at or after `from`,
 *  with every occurrence position there; null when it occurs at no tier. */
function findOccurrences(
  lines: string[],
  oldLines: string[],
  strict: boolean,
  from: number,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const keys = oldLines.map((l) => tierKey(l, t));
    const pos: number[] = [];
    for (let i = from; i + oldLines.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < oldLines.length; j++) {
        if (tierKey(lines[i + j], t) !== keys[j]) {
          ok = false;
          break;
        }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** Re-indent one new line at tier 2: a non-blank line starting with the old
 *  block's leading whitespace P gets P replaced by the file's F. */
function reindentLine(text: string, tier: number, pLead: string, fLead: string): string {
  if (tier !== 2) return text;
  if (text === '' || /^[ \t]+$/.test(text)) return text;
  if (!text.startsWith(pLead)) return text;
  return fLead + text.slice(pLead.length);
}

/** Render N at a matched position: context lines come from the file itself,
 *  other lines are re-indented at tier 2. */
function renderN(
  nItems: { text: string; oIndex: number | null }[],
  fileLines: string[],
  pos: number,
  tier: number,
  pLead: string,
  fLead: string,
): string[] {
  return nItems.map((it) =>
    it.oIndex !== null ? fileLines[pos + it.oIndex] : reindentLine(it.text, tier, pLead, fLead),
  );
}

/* ------------------------------------------------------------------ */
/* JSON edits (section 9)                                              */
/* ------------------------------------------------------------------ */

/** One JSON edit object, or null when the value is not one. */
function jsonEditObject(v: unknown): EditFn | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }

  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const st = splitFile(before);
      if (line < 0 || line > st.lines.length) throw new Fail('no-match', p);
      const outLines = [...st.lines.slice(0, line), ...add, ...st.lines.slice(line)];
      tree.now.set(p, joinFile({ br: st.br, lines: outLines, finalBreak: st.finalBreak }));
    };
  }

  return null;
}

function jsonEdits(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new ParseErr('error: parse 1');
  const edits: EditFn[] = [];
  if (lines[first].trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseErr(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new ParseErr(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEditObject(x);
      if (e === null) throw new ParseErr(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: EditFn | null = null;
    try {
      e = jsonEditObject(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseErr(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (section 7)                                   */
/* ------------------------------------------------------------------ */

function srEdits(lines: string[], strict: boolean): EditFn[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') continue;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j].trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new ParseErr(`error: parse ${i + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new ParseErr(`error: parse ${i + 1}`);
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const l = lines[j];
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseErr(`error: parse ${i + 1}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep;
  }
  return blocks.map((b) => {
    return (tree: Tree) => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      if (b.oldLines.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(b.path);
      if (cur === null) throw new Fail('missing', b.path);
      const st = splitFile(cur);
      const found = findOccurrences(st.lines, b.oldLines, strict, 0);
      if (found === null) throw new Fail('no-match', b.path);
      if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
      const pos = found.positions[0];
      const pLead = leadWs(b.oldLines[0]);
      const fLead = leadWs(st.lines[pos]);
      const rendered = b.newLines.map((t) => reindentLine(t, found.tier, pLead, fLead));
      const out = [
        ...st.lines.slice(0, pos),
        ...rendered,
        ...st.lines.slice(pos + b.oldLines.length),
      ];
      tree.now.set(b.path, joinFile({ br: st.br, lines: out, finalBreak: st.finalBreak }));
    };
  });
}

/* ------------------------------------------------------------------ */
/* V4A patches (section 8)                                             */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: Item[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  addLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

function v4aEdits(lines: string[], strict: boolean): EditFn[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new ParseErr('error: parse 1');
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseErr(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i])) {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new ParseErr(`error: parse ${lines.length + 1}`);

  const secStart = (line: string): { kind: 'add' | 'delete' | 'update'; path: string } | null => {
    if (line.startsWith('*** Add File:')) return { kind: 'add', path: line.slice(13).trim() };
    if (line.startsWith('*** Delete File:')) return { kind: 'delete', path: line.slice(16).trim() };
    if (line.startsWith('*** Update File:')) return { kind: 'update', path: line.slice(16).trim() };
    return null;
  };

  interface RawSec {
    kind: 'add' | 'delete' | 'update';
    path: string;
    headerLine: number;
    start: number;
    end: number;
  }
  const rawSecs: RawSec[] = [];
  let cur: RawSec | null = null;
  for (let i = first + 1; i < last; i++) {
    const l = lines[i];
    const s = secStart(l);
    if (s !== null) {
      if (cur !== null) cur.end = i;
      cur = { kind: s.kind, path: s.path, headerLine: i + 1, start: i + 1, end: last };
      rawSecs.push(cur);
      continue;
    }
    if (blank(l)) continue;
    if (cur === null) throw new ParseErr(`error: parse ${i + 1}`);
  }
  if (cur !== null) cur.end = last;

  const sections: VSection[] = rawSecs.map((sec) => {
    const body: { text: string; num: number }[] = [];
    for (let j = sec.start; j < sec.end; j++) body.push({ text: lines[j], num: j + 1 });
    while (body.length > 0 && blank(body[body.length - 1].text)) body.pop();

    if (sec.kind === 'add') {
      const addLines: string[] = [];
      for (const bl of body) {
        if (bl.text.startsWith('+')) addLines.push(bl.text.slice(1));
        else if (bl.text === '') addLines.push('');
        else throw new ParseErr(`error: parse ${bl.num}`);
      }
      return { kind: 'add', path: sec.path, addLines, moveTo: null, chunks: [] };
    }
    if (sec.kind === 'delete') {
      if (body.length > 0) throw new ParseErr(`error: parse ${body[0].num}`);
      return { kind: 'delete', path: sec.path, addLines: [], moveTo: null, chunks: [] };
    }

    let idx = 0;
    let moveTo: string | null = null;
    if (body.length > 0 && body[0].text.startsWith('*** Move to:')) {
      moveTo = body[0].text.slice(12).trim();
      idx = 1;
    }
    const chunks: VChunk[] = [];
    while (idx < body.length) {
      let anchor: string | null = null;
      if (body[idx].text.startsWith('@@')) {
        anchor = body[idx].text.slice(2).trim();
        idx++;
      }
      let eof = false;
      const items: Item[] = [];
      while (idx < body.length) {
        const bl = body[idx];
        if (bl.text.startsWith('@@')) break;
        if (bl.text.trimEnd() === '*** End of File') {
          eof = true;
          idx++;
          break;
        }
        if (bl.text === '') {
          items.push({ kind: 'ctx', text: '', noEol: false });
          idx++;
          continue;
        }
        const c = bl.text[0];
        if (c === ' ') {
          items.push({ kind: 'ctx', text: bl.text.slice(1), noEol: false });
          idx++;
          continue;
        }
        if (c === '-') {
          items.push({ kind: 'old', text: bl.text.slice(1), noEol: false });
          idx++;
          continue;
        }
        if (c === '+') {
          items.push({ kind: 'new', text: bl.text.slice(1), noEol: false });
          idx++;
          continue;
        }
        throw new ParseErr(`error: parse ${bl.num}`);
      }
      chunks.push({ anchor, eof, items });
    }
    if (chunks.length === 0 && moveTo === null) throw new ParseErr(`error: parse ${sec.headerLine}`);
    return { kind: 'update', path: sec.path, addLines: [], moveTo, chunks };
  });

  return sections.map((sec) => {
    return (tree: Tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
      if (sec.kind === 'add') {
        if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
        tree.now.set(
          sec.path,
          sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n',
        );
        return;
      }
      if (sec.kind === 'delete') {
        if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
        tree.now.set(sec.path, null);
        return;
      }
      const cur = tree.get(sec.path);
      if (cur === null) throw new Fail('missing', sec.path);
      if (sec.moveTo !== null && tree.get(sec.moveTo) !== null)
        throw new Fail('exists', sec.moveTo);
      let st = splitFile(cur);
      let cursor = 0;
      for (const chunk of sec.chunks) {
        const r = applyV4AChunk(st, chunk, cursor, strict, sec.path);
        st = r.state;
        cursor = r.cursor;
      }
      const text = joinFile(st);
      if (sec.moveTo !== null) {
        tree.now.set(sec.path, null);
        tree.now.set(sec.moveTo, text);
        tree.moves.push({ old: sec.path, new: sec.moveTo });
      } else {
        tree.now.set(sec.path, text);
      }
    };
  });
}

/** Apply one V4A chunk to a file state, threading the cursor through. */
function applyV4AChunk(
  st: FileState,
  chunk: VChunk,
  cursor: number,
  strict: boolean,
  path: string,
): { state: FileState; cursor: number } {
  let cur = cursor;
  if (chunk.anchor !== null && chunk.anchor !== '') {
    const found = findOccurrences(st.lines, [chunk.anchor], strict, cur);
    if (found === null) throw new Fail('no-match', path);
    cur = found.positions[0] + 1;
  }
  const { oTexts, nItems } = buildItems(chunk.items);
  if (oTexts.length === 0) {
    const ins = chunk.eof ? st.lines.length : cur;
    const newLines = [...st.lines.slice(0, ins), ...nItems.map((it) => it.text), ...st.lines.slice(ins)];
    return {
      state: { br: st.br, lines: newLines, finalBreak: st.finalBreak },
      cursor: ins + nItems.length,
    };
  }
  const found = findOccurrences(st.lines, oTexts, strict, cur);
  if (found === null) throw new Fail('no-match', path);
  // An end-of-file chunk takes only an occurrence ending at the file's last
  // line, so the tier is the first one with such an occurrence: search each
  // tier for EOF-ending occurrences rather than filtering afterwards.
  let pos: number | null = null;
  let tier = found.tier;
  if (chunk.eof) {
    pos = null;
    const tiers = strict ? [0] : [0, 1, 2];
    for (const t of tiers) {
      const keys = oTexts.map((l) => tierKey(l, t));
      for (let i = cur; i + oTexts.length <= st.lines.length; i++) {
        if (i + oTexts.length !== st.lines.length) continue;
        let ok = true;
        for (let j = 0; j < oTexts.length; j++) {
          if (tierKey(st.lines[i + j], t) !== keys[j]) {
            ok = false;
            break;
          }
        }
        if (ok) {
          pos = i;
          tier = t;
          break;
        }
      }
      if (pos !== null) break;
    }
    if (pos === null) throw new Fail('no-match', path);
  } else {
    pos = found.positions[0];
  }
  const pLead = leadWs(oTexts[0]);
  const fLead = leadWs(st.lines[pos]);
  const rendered = renderN(nItems, st.lines, pos, tier, pLead, fLead);
  const newLines = [
    ...st.lines.slice(0, pos),
    ...rendered,
    ...st.lines.slice(pos + oTexts.length),
  ];
  return {
    state: { br: st.br, lines: newLines, finalBreak: st.finalBreak },
    cursor: pos + nItems.length,
  };
}

/* ------------------------------------------------------------------ */
/* Unified diffs (section 6)                                           */
/* ------------------------------------------------------------------ */

interface UHunk {
  a: number;
  items: Item[];
  noEol: boolean;
}

interface USection {
  oldP: string | null | undefined;
  newP: string | null | undefined;
  hasPair: boolean;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  isNew: boolean;
  isDeleted: boolean;
  inHeader: boolean;
  hunks: UHunk[];
}

/** A `---`/`+++` path: up to the first tab, surrounding spaces removed,
 *  `/dev/null` meaning no file, one leading `a/` or `b/` removed. */
function headerPath(raw: string): string | null {
  let p = raw;
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** A hunk's body lines, from `start` until the first line that is not one.
 *  Trailing empty lines are not part of the body. */
function parseHunkBody(
  lines: string[],
  start: number,
): { items: Item[]; noEol: boolean; next: number } {
  const raw: string[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j];
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (
      l === '' ||
      l.startsWith(' ') ||
      l.startsWith('-') ||
      l.startsWith('+') ||
      l.startsWith('\\')
    ) {
      raw.push(l);
      j++;
      continue;
    }
    break;
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const items: Item[] = [];
  for (const l of raw) {
    if (l.startsWith('\\')) {
      if (items.length > 0) items[items.length - 1].noEol = true;
      continue;
    }
    if (l === '') items.push({ kind: 'ctx', text: '', noEol: false });
    else if (l[0] === ' ') items.push({ kind: 'ctx', text: l.slice(1), noEol: false });
    else if (l[0] === '-') items.push({ kind: 'old', text: l.slice(1), noEol: false });
    else items.push({ kind: 'new', text: l.slice(1), noEol: false });
  }
  let noEol = false;
  for (let k = items.length - 1; k >= 0; k--) {
    if (items[k].kind === 'ctx' || items[k].kind === 'new') {
      noEol = items[k].noEol;
      break;
    }
  }
  return { items, noEol, next: j };
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const fresh = (diffOld?: string, diffNew?: string): USection => ({
    oldP: undefined,
    newP: undefined,
    hasPair: false,
    renameFrom: undefined,
    renameTo: undefined,
    diffOld,
    diffNew,
    isNew: false,
    isDeleted: false,
    inHeader: true,
    hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new ParseErr(`error: parse ${i + 1}`);
      cur = fresh(m[1], m[2]);
      sections.push(cur);
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      const nxt = lines[i + 1];
      if (nxt !== undefined && nxt.startsWith('+++ ')) {
        if (cur === null || !cur.inHeader || cur.hasPair) {
          cur = fresh();
          sections.push(cur);
        }
        cur.oldP = headerPath(line.slice(4));
        cur.newP = headerPath(nxt.slice(4));
        cur.hasPair = true;
        i += 2;
        continue;
      }
      if (cur !== null && cur.inHeader) throw new ParseErr(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new ParseErr(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new ParseErr(`error: parse ${i + 1}`);
      const parsed = parseHunkBody(lines, i + 1);
      cur.hunks.push({ a: Number(m[1]), items: parsed.items, noEol: parsed.noEol });
      cur.inHeader = false;
      i = parsed.next;
      continue;
    }
    if (cur !== null && cur.inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.isNew = true;
      else if (line.startsWith('deleted file mode')) cur.isDeleted = true;
      i++;
      continue;
    }
    i++;
  }
  return sections;
}

/** Apply one section's hunks in order to a file state. */
function applyHunks(
  state: FileState,
  hunks: UHunk[],
  strict: boolean,
  path: string,
): FileState {
  let cur = state;
  let d = 0;
  for (const h of hunks) {
    const { oTexts, nItems } = buildItems(h.items);
    if (oTexts.length === 0) {
      const pos = Math.max(0, Math.min(h.a + d, cur.lines.length));
      const newLines = [
        ...cur.lines.slice(0, pos),
        ...nItems.map((it) => it.text),
        ...cur.lines.slice(pos),
      ];
      let finalBreak = cur.finalBreak;
      if (pos === cur.lines.length) finalBreak = !h.noEol;
      cur = { br: cur.br, lines: newLines, finalBreak };
    } else {
      const found = findOccurrences(cur.lines, oTexts, strict, 0);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.positions[0];
      let bestDist = Math.abs(best - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const pLead = leadWs(oTexts[0]);
      const fLead = leadWs(cur.lines[best]);
      const rendered = renderN(nItems, cur.lines, best, found.tier, pLead, fLead);
      const newLines = [
        ...cur.lines.slice(0, best),
        ...rendered,
        ...cur.lines.slice(best + oTexts.length),
      ];
      let finalBreak = cur.finalBreak;
      if (best + oTexts.length === cur.lines.length) finalBreak = !h.noEol;
      cur = { br: cur.br, lines: newLines, finalBreak };
    }
    d += nItems.length - oTexts.length;
  }
  return cur;
}

function unifiedEdits(lines: string[], strict: boolean): EditFn[] {
  const sections = parseUnified(lines);
  return sections.map((sec) => {
    const oldP = sec.hasPair ? sec.oldP : (sec.renameFrom ?? sec.diffOld);
    const newP = sec.hasPair ? sec.newP : (sec.renameTo ?? sec.diffNew);
    return (tree: Tree) => {
      if (oldP !== undefined && oldP !== null && !safe(oldP))
        throw new Fail('unsafe', oldP);
      if (newP !== undefined && newP !== null && !safe(newP))
        throw new Fail('unsafe', newP);
      const isCreate = oldP === null || sec.isNew;
      const isDelete = !isCreate && (newP === null || sec.isDeleted);
      if (isCreate) {
        const np = newP as string;
        if (np === null || np === undefined) return;
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const plus: string[] = [];
        for (const h of sec.hunks) {
          for (const it of h.items) if (it.kind === 'new') plus.push(it.text);
        }
        let noEol = false;
        outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
          const items = sec.hunks[hi].items;
          for (let k = items.length - 1; k >= 0; k--) {
            if (items[k].kind === 'new') {
              noEol = items[k].noEol;
              break outer;
            }
          }
        }
        tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
        return;
      }
      if (isDelete) {
        const op = oldP as string;
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
        return;
      }
      const op = oldP as string;
      const np = newP as string;
      const isMove = op !== np;
      if (tree.get(op) === null) throw new Fail('missing', op);
      if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
      const before = tree.get(op) as string;
      const after = applyHunks(splitFile(before), sec.hunks, strict, op);
      const text = joinFile(after);
      if (isMove) {
        tree.now.set(op, null);
        tree.now.set(np, text);
        tree.moves.push({ old: op, new: np });
      } else {
        tree.now.set(op, text);
      }
    };
  });
}

/* ------------------------------------------------------------------ */
/* Format detection (section 4), the run, and the output (section 2)   */
/* ------------------------------------------------------------------ */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first].trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  )
    return 'unified';
  return null;
}

const byteOrder = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** The change rows for exit 0, in byte order of the paths (a move sorts by
 *  its new path and replaces that pair's D and A lines). */
function computeRows(tree: Tree): string[] {
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  const used = new Set<string>();
  for (const mv of tree.moves) {
    const wasOld = tree.original(mv.old);
    const nowOld = tree.now.has(mv.old) ? (tree.now.get(mv.old) as string | null) : wasOld;
    const wasNew = tree.original(mv.new);
    const nowNew = tree.now.has(mv.new) ? (tree.now.get(mv.new) as string | null) : wasNew;
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: mv.new, text: `R ${mv.old} -> ${mv.new}` });
      used.add(mv.old);
      used.add(mv.new);
    }
  }
  for (const p of tree.now.keys()) {
    if (used.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p) as string | null;
    if (was === now) continue;
    const kind = was === null ? 'A' : now === null ? 'D' : 'M';
    rows.push({ key: p, text: `${kind} ${p}` });
  }
  rows.sort((x, y) => byteOrder(x.key, y.key));
  return rows.map((r) => r.text);
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) return { code: 2, out: ['error: usage'] };
        const v = a.slice(9);
        if (!FORMATS.includes(v)) return { code: 2, out: ['error: usage'] };
        format = v;
      } else if (a === '--check') {
        if (check) return { code: 2, out: ['error: usage'] };
        check = true;
      } else if (a === '--strict') {
        if (strict) return { code: 2, out: ['error: usage'] };
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0];
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: EditFn[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new ParseErr('error: parse 1');
  } catch (e) {
    if (e instanceof ParseErr) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now = beforeNow;
      tree.moves = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [
        ...fails.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${fails.length} of ${edits.length} edits`,
      ],
    };
  }
  const rows = computeRows(tree);
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteOrder)) {
      const was = tree.original(p);
      const now = tree.now.get(p) as string | null;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

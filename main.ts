// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
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
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}

const leadingWS = (s: string): string => /^[ \t]*/.exec(s)![0];
const trimSpaces = (s: string): string => s.replace(/^ +| +$/g, '');

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+|[ \t]+$/g, '');
}

/** Find all occurrences of `target` in `fileLines` at the first matching tier (SPEC section 5). */
function findOccurrences(
  fileLines: string[],
  target: string[],
  strict: boolean,
  startIdx = 0,
  endOnly = false,
): { tier: number; positions: number[] } | null {
  const k = target.length;
  if (k === 0 || k > fileLines.length) return null;
  const minPos = endOnly ? fileLines.length - k : startIdx;
  const maxPos = fileLines.length - k;
  if (minPos < startIdx || minPos > maxPos) return null;
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier += 1) {
    const normTarget = target.map((l) => normLine(l, tier));
    const positions: number[] = [];
    for (let i = minPos; i <= maxPos; i += 1) {
      let ok = true;
      for (let j = 0; j < k; j += 1) {
        if (normLine(fileLines[i + j]!, tier) !== normTarget[j]) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

interface NewLineSpec {
  text: string;
  contextOldIdx: number | null;
}

function buildReplacement(
  fileLines: string[],
  pos: number,
  oldLines: string[],
  newSpec: NewLineSpec[],
  tier: number,
): string[] {
  const F = tier === 2 ? leadingWS(fileLines[pos]!) : '';
  const P = tier === 2 ? leadingWS(oldLines[0]!) : '';
  return newSpec.map((item) => {
    if (item.contextOldIdx !== null) return fileLines[pos + item.contextOldIdx]!;
    if (tier === 2 && !blank(item.text) && item.text.startsWith(P)) {
      return F + item.text.slice(P.length);
    }
    return item.text;
  });
}

interface UnifiedHunk {
  oldStart: number;
  oldLines: string[];
  newSpec: NewLineSpec[];
  plusLines: string[];
  noNewlineAfterLastN: boolean;
  noNewlineAfterLastPlus: boolean;
}

interface UnifiedSection {
  diffOld: string | null;
  diffNew: string | null;
  headerOld: string | null;
  headerNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  isNew: boolean;
  isDeleted: boolean;
  hasMinusPlus: boolean;
  hunks: UnifiedHunk[];
}

function parseUnifiedHeaderPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  const raw = trimSpaces(tab >= 0 ? rest.slice(0, tab) : rest);
  if (raw === '/dev/null') return '/dev/null';
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const DIFF_GIT_RE = /^diff --git a\/(.+) b\/(.+)$/;

/** Parse unified diffs (SPEC.md section 6). */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let inHeader = false;
  let i = 0;

  const startSection = (diffOld: string | null, diffNew: string | null): UnifiedSection => {
    const s: UnifiedSection = {
      diffOld,
      diffNew,
      headerOld: null,
      headerNew: null,
      renameFrom: null,
      renameTo: null,
      isNew: false,
      isDeleted: false,
      hasMinusPlus: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };

  while (i < lines.length) {
    const line = lines[i]!;
    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      const followedByPlus = next !== undefined && next.startsWith('+++ ');
      if (inHeader && cur !== null) {
        if (!followedByPlus) throw new Exit2(`error: parse ${i + 2}`);
        if (cur.hasMinusPlus) {
          startSection(null, null);
        }
        cur.headerOld = parseUnifiedHeaderPath(line);
        cur.headerNew = parseUnifiedHeaderPath(next!);
        cur.hasMinusPlus = true;
        i += 2;
        continue;
      }
      if (followedByPlus) {
        startSection(null, null);
        cur!.headerOld = parseUnifiedHeaderPath(line);
        cur!.headerNew = parseUnifiedHeaderPath(next!);
        cur!.hasMinusPlus = true;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const oldStart = Number(m[1]!);
      i += 1;
      const rawBody: string[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          rawBody.push(bl);
          i += 1;
        } else {
          break;
        }
      }
      while (rawBody.length > 0 && rawBody[rawBody.length - 1] === '') rawBody.pop();

      const oldLines: string[] = [];
      const newSpec: NewLineSpec[] = [];
      const plusLines: string[] = [];
      let lastNIdx = -1;
      let lastPlusIdx = -1;
      for (let b = 0; b < rawBody.length; b += 1) {
        const bl = rawBody[b]!;
        if (bl === '') {
          const oldIdx = oldLines.length;
          oldLines.push('');
          newSpec.push({ text: '', contextOldIdx: oldIdx });
          lastNIdx = b;
        } else if (bl[0] === ' ') {
          const oldIdx = oldLines.length;
          const text = bl.slice(1);
          oldLines.push(text);
          newSpec.push({ text, contextOldIdx: oldIdx });
          lastNIdx = b;
        } else if (bl[0] === '-') {
          oldLines.push(bl.slice(1));
        } else if (bl[0] === '+') {
          const text = bl.slice(1);
          newSpec.push({ text, contextOldIdx: null });
          plusLines.push(text);
          lastNIdx = b;
          lastPlusIdx = b;
        }
      }
      const noNewlineAfterLastN = lastNIdx >= 0 && rawBody[lastNIdx + 1]?.[0] === '\\';
      const noNewlineAfterLastPlus = lastPlusIdx >= 0 && rawBody[lastPlusIdx + 1]?.[0] === '\\';
      cur.hunks.push({ oldStart, oldLines, newSpec, plusLines, noNewlineAfterLastN, noNewlineAfterLastPlus });
      continue;
    }
    if (inHeader && cur !== null) {
      if (line.startsWith('rename from ')) cur.renameFrom = trimSpaces(line.slice(12));
      else if (line.startsWith('rename to ')) cur.renameTo = trimSpaces(line.slice(10));
      else if (line === 'new file mode' || line.startsWith('new file mode ')) cur.isNew = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) cur.isDeleted = true;
    }
    i += 1;
  }

  return sections.map((sec): Edit => {
    const oldPath = sec.headerOld ?? sec.renameFrom ?? sec.diffOld ?? '';
    const newPath = sec.headerNew ?? sec.renameTo ?? sec.diffNew ?? '';
    const isCreate = oldPath === '/dev/null' || sec.isNew;
    const isDelete = !isCreate && (newPath === '/dev/null' || sec.isDeleted);
    const isMove = !isCreate && !isDelete && oldPath !== newPath;

    if (isCreate) {
      return (tree) => {
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const outLines: string[] = [];
        let noNewline = false;
        for (const h of sec.hunks) {
          if (h.plusLines.length > 0) {
            outLines.push(...h.plusLines);
            noNewline = h.noNewlineAfterLastPlus;
          }
        }
        tree.now.set(newPath, joinFile(outLines, '\n', !noNewline));
      };
    }
    if (isDelete) {
      return (tree) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
      };
    }
    return (tree) => {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (isMove && !safe(newPath)) throw new Fail('unsafe', newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (isMove && tree.get(newPath) !== null) throw new Fail('exists', newPath);

      const file = splitFile(before);
      let d = 0;
      for (const h of sec.hunks) {
        if (h.oldLines.length === 0) {
          const insertPos = Math.max(0, Math.min(file.lines.length, h.oldStart + d));
          const atEnd = insertPos === file.lines.length;
          const add = h.newSpec.map((x) => x.text);
          file.lines.splice(insertPos, 0, ...add);
          if (atEnd) file.final = !h.noNewlineAfterLastN;
          d += add.length;
        } else {
          const found = findOccurrences(file.lines, h.oldLines, strict);
          if (found === null) throw new Fail('no-match', oldPath);
          const target = h.oldStart - 1 + d;
          let bestPos = found.positions[0]!;
          let bestDist = Math.abs(bestPos - target);
          for (let k = 1; k < found.positions.length; k += 1) {
            const p = found.positions[k]!;
            const dist = Math.abs(p - target);
            if (dist < bestDist) {
              bestDist = dist;
              bestPos = p;
            }
          }
          const runsToEnd = bestPos + h.oldLines.length === file.lines.length;
          const rep = buildReplacement(file.lines, bestPos, h.oldLines, h.newSpec, found.tier);
          file.lines.splice(bestPos, h.oldLines.length, ...rep);
          if (runsToEnd) file.final = !h.noNewlineAfterLastN;
          d += rep.length - h.oldLines.length;
        }
      }
      const out = joinFile(file.lines, file.br, file.final);
      if (isMove) {
        tree.now.set(oldPath, null);
        tree.now.set(newPath, out);
        tree.moves.push([oldPath, newPath]);
      } else {
        tree.now.set(oldPath, out);
      }
    };
  });
}

/** Parse SEARCH/REPLACE blocks (SPEC.md section 7). */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let afterPrev = 0;
  let i = 0;

  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let foundPath: string | null = null;
    for (let k = searchIdx - 1; k >= afterPrev; k -= 1) {
      const l = lines[k]!;
      if (!blank(l) && !l.trim().startsWith('```')) {
        foundPath = l.trim();
        break;
      }
    }
    const path = foundPath ?? prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);

    let sepIdx = -1;
    for (let k = searchIdx + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        sepIdx = k;
        break;
      }
    }
    if (sepIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);

    let endIdx = -1;
    for (let k = sepIdx + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        endIdx = k;
        break;
      }
    }
    if (endIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);

    const oldLines = lines.slice(searchIdx + 1, sepIdx);
    const newLines = lines.slice(sepIdx + 1, endIdx);
    prevPath = path;
    afterPrev = endIdx + 1;
    i = endIdx + 1;

    edits.push((tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (oldLines.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, joinFile(newLines, '\n', true));
        return;
      }
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      const file = splitFile(before);
      const found = findOccurrences(file.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', path);
      if (found.positions.length > 1) throw new Fail('ambiguous', path);
      const pos = found.positions[0]!;
      const newSpec: NewLineSpec[] = newLines.map((text) => ({ text, contextOldIdx: null }));
      const rep = buildReplacement(file.lines, pos, oldLines, newSpec, found.tier);
      file.lines.splice(pos, oldLines.length, ...rep);
      tree.now.set(path, joinFile(file.lines, file.br, file.final));
    });
  }

  return edits;
}

interface V4AChunk {
  anchor: string | null;
  oldLines: string[];
  newSpec: NewLineSpec[];
  eof: boolean;
}

/** Parse V4A patches (SPEC.md section 8). */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last <= first || lines[last]!.trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${lines.length + 1}`);
  }

  const isSectionHeader = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const header = lines[i]!;
    if (!isSectionHeader(header)) throw new Exit2(`error: parse ${i + 1}`);
    const secStart = i;
    let secEnd = i + 1;
    while (secEnd < last && !isSectionHeader(lines[secEnd]!)) secEnd += 1;
    let bodyEnd = secEnd;
    while (bodyEnd > secStart + 1 && blank(lines[bodyEnd - 1]!)) bodyEnd -= 1;

    if (header.startsWith('*** Add File: ')) {
      const path = trimSpaces(header.slice('*** Add File: '.length));
      const addLines: string[] = [];
      for (let k = secStart + 1; k < bodyEnd; k += 1) {
        const bl = lines[k]!;
        if (bl.startsWith('+')) addLines.push(bl.slice(1));
        else if (bl === '') addLines.push('');
        else throw new Exit2(`error: parse ${k + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, joinFile(addLines, '\n', true));
      });
    } else if (header.startsWith('*** Delete File: ')) {
      const path = trimSpaces(header.slice('*** Delete File: '.length));
      if (bodyEnd > secStart + 1) throw new Exit2(`error: parse ${secStart + 2}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      const path = trimSpaces(header.slice('*** Update File: '.length));
      let k = secStart + 1;
      let moveTo: string | null = null;
      if (k < bodyEnd && lines[k]!.startsWith('*** Move to: ')) {
        moveTo = trimSpaces(lines[k]!.slice('*** Move to: '.length));
        k += 1;
      }
      const chunks: V4AChunk[] = [];
      let curChunk: V4AChunk | null = null;
      while (k < bodyEnd) {
        const bl = lines[k]!;
        if (bl.startsWith('@@')) {
          if (curChunk !== null) chunks.push(curChunk);
          const anchorText = trimSpaces(bl.slice(2));
          curChunk = { anchor: anchorText === '' ? null : anchorText, oldLines: [], newSpec: [], eof: false };
          k += 1;
        } else if (bl.trimEnd() === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${k + 1}`);
          curChunk.eof = true;
          chunks.push(curChunk);
          curChunk = null;
          k += 1;
        } else if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+') {
          if (curChunk === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${k + 1}`);
            curChunk = { anchor: null, oldLines: [], newSpec: [], eof: false };
          }
          if (bl === '') {
            const oldIdx = curChunk.oldLines.length;
            curChunk.oldLines.push('');
            curChunk.newSpec.push({ text: '', contextOldIdx: oldIdx });
          } else if (bl[0] === ' ') {
            const oldIdx = curChunk.oldLines.length;
            const text = bl.slice(1);
            curChunk.oldLines.push(text);
            curChunk.newSpec.push({ text, contextOldIdx: oldIdx });
          } else if (bl[0] === '-') {
            curChunk.oldLines.push(bl.slice(1));
          } else {
            curChunk.newSpec.push({ text: bl.slice(1), contextOldIdx: null });
          }
          k += 1;
        } else {
          throw new Exit2(`error: parse ${k + 1}`);
        }
      }
      if (curChunk !== null) chunks.push(curChunk);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secStart + 1}`);

      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);

        const file = splitFile(before);
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            const foundAnchor = findOccurrences(file.lines, [ch.anchor], strict, cursor, false);
            if (foundAnchor === null) throw new Fail('no-match', path);
            cursor = foundAnchor.positions[0]! + 1;
          }
          if (ch.oldLines.length === 0) {
            const insertAt = ch.eof ? file.lines.length : cursor;
            const add = ch.newSpec.map((x) => x.text);
            file.lines.splice(insertAt, 0, ...add);
            cursor = insertAt + add.length;
          } else {
            const found = findOccurrences(file.lines, ch.oldLines, strict, cursor, ch.eof);
            if (found === null) throw new Fail('no-match', path);
            const pos = found.positions[0]!;
            const rep = buildReplacement(file.lines, pos, ch.oldLines, ch.newSpec, found.tier);
            file.lines.splice(pos, ch.oldLines.length, ...rep);
            cursor = pos + rep.length;
          }
        }
        const out = joinFile(file.lines, file.br, file.final);
        if (moveTo !== null) {
          tree.now.set(path, null);
          tree.now.set(moveTo, out);
          tree.moves.push([path, moveTo]);
        } else {
          tree.now.set(path, out);
        }
      });
    }
    i = secEnd;
  }

  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const movedFrom = new Map<string, string>();
  const movedAway = new Set<string>();
  for (const [oldPath, newPath] of tree.moves) {
    if (
      !movedAway.has(oldPath) &&
      !movedFrom.has(newPath) &&
      tree.original(oldPath) !== null &&
      tree.now.get(oldPath) === null &&
      tree.original(newPath) === null &&
      tree.now.get(newPath) !== null
    ) {
      movedAway.add(oldPath);
      movedFrom.set(newPath, oldPath);
    }
  }
  const sorted = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const rows: string[] = [];
  for (const p of sorted) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (movedAway.has(p)) continue;
    const oldP = movedFrom.get(p);
    rows.push(oldP !== undefined ? `R ${oldP} -> ${p}` : `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  if (!check) {
    for (const p of sorted) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now || now !== null) continue;
      rmSync(p, { force: true });
    }
    for (const p of sorted) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now || now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
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

/**
 * The extraction engine: parse a file with its tree-sitter grammar, run the language's queries, and
 * interpret the matches into boundaries. No network, no model, no clock: the same file text always
 * gives the same boundaries, in the same order.
 */
import { Language, type Node, Parser, Query } from "web-tree-sitter";
import coreWasm from "web-tree-sitter/tree-sitter.wasm" with { type: "file" };
import { type Boundary, KINDS, type Kind, type LanguageSpec, type Match } from "./languages.ts";

interface Loaded {
  spec: LanguageSpec;
  language: Language;
  query: Query;
}

const loaded = new Map<string, Promise<Loaded>>();
// One init for the process. Concurrent extractions used to each run Parser.init, and a second init
// replaced the wasm module under grammars the first had loaded ("Incompatible language version 0").
let parserReady: Promise<Parser> | undefined;

function getParser(): Promise<Parser> {
  parserReady ??= Parser.init({ locateFile: () => coreWasm }).then(() => new Parser());
  return parserReady;
}

function load(spec: LanguageSpec): Promise<Loaded> {
  let p = loaded.get(spec.id);
  if (!p) {
    p = (async () => {
      await getParser();
      const language = await Language.load(spec.grammar);
      return { spec, language, query: new Query(language, spec.queries) };
    })();
    loaded.set(spec.id, p);
  }
  return p;
}

export interface FileResult {
  boundaries: Boundary[];
  /** The grammar reported a syntax error somewhere in the file. */
  hasError: boolean;
}

/** Extract every boundary from one file's text. `path` is recorded as given. */
export async function extractFile(spec: LanguageSpec, path: string, text: string): Promise<FileResult> {
  const { language, query } = await load(spec);
  const p = await getParser();
  p.setLanguage(language);
  const tree = p.parse(text);
  if (!tree) return { boundaries: [], hasError: true };
  try {
    const found: { b: Boundary; anchorId: number; weak: boolean }[] = [];
    const claimed = new Set<number>();
    const exports: { b: Boundary; anchorId: number; weak: boolean; of: number | undefined }[] = [];
    for (const m of query.matches(tree.rootNode)) {
      const caps = new Map<string, Node>();
      for (const c of m.captures) if (!caps.has(c.name)) caps.set(c.name, c.node);
      const kind = KINDS.find((k) => caps.has(k));
      if (!kind) continue;
      const match: Match = { anchor: caps.get(kind)!, caps };
      for (const f of spec.interpreter[kind](match)) {
        if (f.claim) claimed.add(f.claim.id);
        const b: Boundary = {
          kind,
          name: f.name,
          file: path,
          line: f.at.startPosition.row + 1,
          language: spec.id,
          ...(f.detail !== undefined ? { detail: f.detail } : {}),
        };
        const entry = { b, anchorId: match.anchor.id, weak: f.weak === true };
        if (kind === "export") exports.push({ ...entry, of: f.of?.id });
        else found.push(entry);
      }
    }
    // A default export is dropped when the same statement also exported a named declaration.
    const named = new Set(exports.filter((e) => !e.weak).map((e) => e.anchorId));
    for (const e of exports) {
      if (e.weak && named.has(e.anchorId)) continue;
      if (e.of !== undefined && claimed.has(e.of)) continue;
      found.push(e);
    }
    return { boundaries: found.map((f) => f.b), hasError: tree.rootNode.hasError };
  } finally {
    tree.delete();
  }
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const KIND_ORDER: Record<Kind, number> = { route: 0, cli: 1, ui: 2, export: 3 };

/** Stable total order: file, line, kind, name. Plain code-unit comparison, so no locale can change it. */
export function sortBoundaries(list: Boundary[]): Boundary[] {
  return list.sort(
    (a, b) =>
      compare(a.file, b.file) || a.line - b.line || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || compare(a.name, b.name),
  );
}

/** Collapse duplicates: one export per file, name and detail (overloads); one other boundary per file, line and name. */
export function dedupe(list: Boundary[]): Boundary[] {
  const seen = new Set<string>();
  const out: Boundary[] = [];
  for (const b of sortBoundaries([...list])) {
    const key = b.kind === "export" ? `${b.kind}\0${b.file}\0${b.name}\0${b.detail}` : `${b.kind}\0${b.file}\0${b.line}\0${b.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(b);
  }
  return out;
}

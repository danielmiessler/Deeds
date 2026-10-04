/** Boundary extraction over a whole repo: the library behind `deeds extract`. */
import { dedupe, extractFile } from "./engine.ts";
import { type Boundary, languageOf } from "./languages.ts";
import { openSource } from "./source.ts";

export type { Boundary, Kind } from "./languages.ts";

export interface Extraction {
  /** The commit read, or null for a working tree or plain folder. */
  rev: string | null;
  /** Source files parsed. */
  files: number;
  /** Files parsed per language id, keys sorted. */
  languages: Record<string, number>;
  /** Boundaries per kind, in a fixed key order. */
  counts: Record<"route" | "cli" | "ui" | "export", number>;
  /** Paths whose syntax tree contained errors; their readable boundaries are still reported. */
  parseErrors: string[];
  boundaries: Boundary[];
}

export async function extractRepo(root: string, rev?: string): Promise<Extraction> {
  const source = await openSource(root, rev);
  const all: Boundary[] = [];
  const languages = new Map<string, number>();
  const parseErrors: string[] = [];
  for (const file of source.files) {
    const spec = languageOf(file.path);
    if (!spec) continue;
    const r = await extractFile(spec, file.path, file.text);
    languages.set(spec.id, (languages.get(spec.id) ?? 0) + 1);
    if (r.hasError) parseErrors.push(file.path);
    all.push(...r.boundaries);
  }
  const boundaries = dedupe(all);
  const counts = { route: 0, cli: 0, ui: 0, export: 0 };
  for (const b of boundaries) counts[b.kind]++;  return {
    rev: source.rev,
    files: source.files.length,
    languages: Object.fromEntries([...languages].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    counts,
    parseErrors: parseErrors.sort(),
    boundaries,
  };
}

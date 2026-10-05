/**
 * Cap names, made by code and never by a model: this file imports nothing that can reach the network.
 *
 * A cap is named for the boundary its commit changed, read from the boundary delta deeds already extracts
 * (routes, CLI commands, UI handlers, public exports added or removed): "GET /invoices", "analyze-many command",
 * "export parseConfig". A commit that changed no boundary is named in plain words from its most-changed product
 * path ("invoice export"). The result is never empty.
 */
import type { CapChange } from "../schema.ts";

export interface NameInput {
  change: CapChange;
  /** The commit's files with line counts, as the raw record carries them. */
  files: readonly { path: string; added: number; removed: number }[];
  /** The facts' boundary_delta text: one "added|removed <kind> <name> in <file>" line per entry. */
  boundaryDelta?: string | undefined;
  /** The facts' files text: one "<status> <path> [<class>]" line per file; the class says which are product files. */
  filesText?: string | undefined;
}

type Kind = "route" | "command" | "ui handler" | "export";
interface Entry {
  dir: "added" | "removed";
  kind: Kind;
  name: string;
  file: string;
  publicEntry: boolean;
}

const ENTRY = /^(added|removed) (route|command|ui handler|export) (.+) in (.+?)(?:, ([^,]+), (public entry point|module export))?$/;
const KIND_ORDER: readonly Kind[] = ["route", "command", "ui handler", "export"];
const PRODUCT_CLASS = /\[(source|app_config|content|asset)\]$/;
/** File stems that say nothing on their own; the folder names the thing instead. */
const GENERIC_STEMS = new Set(["index", "main", "mod", "lib", "app", "readme", "skill", "__init__", "__main__", "init", "default", "config", "types", "utils", "util", "helpers"]);

/** The boundary entries in a boundary_delta text. Lines that are not entries (the "not extracted" note, "none") are skipped. */
export function parseBoundaryDelta(text: string | undefined): Entry[] {
  const out: Entry[] = [];
  for (const line of (text ?? "").split("\n")) {
    const m = ENTRY.exec(line.trim());
    if (!m) continue;
    out.push({ dir: m[1] as Entry["dir"], kind: m[2] as Kind, name: m[3]!.trim(), file: m[4]!, publicEntry: m[6] === "public entry point" });
  }
  return out;
}

const boundaryName = (e: Entry): string => {
  switch (e.kind) {
    case "route": return e.name;
    case "command": return `${e.name.replace(/^bin /, "")} command`;
    case "ui handler": return `${e.name.replace(/:/g, " ")} handler`;
    case "export": return `export ${e.name}`;
  }
};

/** Words from a file or folder name: splits on separators and camel case, lower-cased. */
function words(stem: string): string {
  return stem
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[-_.\s]+/g, " ")
    .trim()
    .toLowerCase();
}

/** A path in plain words: its file name, or its folder's name when the file name is generic. */
export function pathWords(path: string): string {
  const parts = path.split("/").filter(Boolean);
  const file = parts.at(-1) ?? "";
  const stem = file.replace(/\.[A-Za-z0-9]+$/, "") || file;
  let w = words(stem);
  if (GENERIC_STEMS.has(stem.toLowerCase()) || w === "") {
    for (let i = parts.length - 2; i >= 0; i--) {
      const dir = words(parts[i]!);
      if (dir && !/^(src|lib|app|packages?|skills?|workflows?|tools?|source)$/.test(dir)) { w = dir; break; }
    }
  }
  return w || words(file) || "capability";
}

/** Product paths named by the facts' files text; every path when the text is absent or names none. */
function productPaths(files: NameInput["files"], filesText: string | undefined): NameInput["files"] {
  if (!filesText) return files;
  const lines = filesText.split("\n").filter((l) => PRODUCT_CLASS.test(l));
  const hit = files.filter((f) => lines.some((l) => l.includes(` ${f.path} [`) || l.includes(` ${f.path} (`)));
  return hit.length ? hit : files;
}

/** The name of a cap, from code alone. Always non-empty. */
export function nameCap(input: NameInput): string {
  const entries = parseBoundaryDelta(input.boundaryDelta).filter((e) => e.kind !== "export" || e.publicEntry);
  // A cap that adds or deepens is named for what was added; one that removes or regresses, for what went.
  const want: Entry["dir"] = input.change === "new" || input.change === "deepened" ? "added" : "removed";
  const pool = entries.some((e) => e.dir === want) ? entries.filter((e) => e.dir === want) : entries;
  const ranked = [...pool].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  const top = ranked[0];
  if (top) {
    const more = ranked.length - 1;
    return more > 0 ? `${boundaryName(top)} and ${more} more` : boundaryName(top);
  }
  const candidates = productPaths(input.files, input.filesText);
  const best = [...candidates].sort((a, b) => b.added + b.removed - (a.added + a.removed) || (a.path < b.path ? -1 : 1))[0];
  return best ? pathWords(best.path) : "capability";
}

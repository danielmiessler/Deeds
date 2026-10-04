/**
 * The deed canon: `canon/deeds.md`, the worked examples that pin what each deed kind means.
 * `parseCanon` is pure; `loadCanon` reads the one file.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CAP_CHANGES, DEED_KINDS, type CapChange, type DeedKind } from "./schema.ts";

export const CANON_PATH = join(import.meta.dir, "..", "canon", "deeds.md");

export interface CanonExample {
  kind: DeedKind;
  /** Present on a cap example only. */
  change?: CapChange;
  text: string;
  /** 1-based line in the canon file. */
  line: number;
}

export interface CanonProblem {
  line: number;
  message: string;
}

export interface ParsedCanon {
  examples: CanonExample[];
  problems: CanonProblem[];
}

// `- [kind] text` or `- [cap:change] text`. Anything that opens a bracket in that position must parse cleanly.
const EXAMPLE_RE = /^- \[([^\]]*)\] (.+)$/;

/** Read the labelled examples out of canon text. A malformed or mislabelled example is reported, never counted. */
export function parseCanon(text: string): ParsedCanon {
  const examples: CanonExample[] = [];
  const problems: CanonProblem[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = i + 1;
    const m = EXAMPLE_RE.exec(raw);
    if (!m) return;
    const [kindRaw = "", change] = (m[1] as string).split(":") as [string, string | undefined];
    if (!(DEED_KINDS as readonly string[]).includes(kindRaw)) {
      problems.push({ line, message: `unknown kind "${kindRaw}"` });
      return;
    }
    const kind = kindRaw as DeedKind;
    if (kind === "cap") {
      if (!(CAP_CHANGES as readonly string[]).includes(change ?? "")) {
        problems.push({ line, message: `a cap example needs a change from ${CAP_CHANGES.join(", ")}` });
        return;
      }
      examples.push({ kind, change: change as CapChange, text: m[2] as string, line });
      return;
    }
    if (change !== undefined) {
      problems.push({ line, message: `a ${kind} example carries no change` });
      return;
    }
    examples.push({ kind, text: m[2] as string, line });
  });
  return { examples, problems };
}

/** The canon text, or null when the file is missing (the load-bearing check removes it). */
export function loadCanon(path: string = CANON_PATH): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/**
 * The commit-judgment question system Deeds asks the judgment API, shipped as `system.json` beside this file.
 * `systemHash` names the system by what it asks and how it decides, so a cached judgment is bound to it
 * and prose-only edits (rationale, provenance, descriptions) never invalidate the cache.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Hash of round r3, the design deeds 0.2 to 0.3 shipped; a judgment cached under it is never served to a later system. */
export const R3_SYSTEM_HASH = "bb19377ee723f10ff90a4e5acedcf5eb36648a1d9815f4f68874feb13def8a7d";
/** Hash of v4b, the design the workshop selected on 2026-10-08 and deeds 0.4.0 ships; parity tests compare against it. */
export const V4B_SYSTEM_HASH = "8f517fd16caad50d04b8e2c6fd8538c9a6efa0dd1e7b6265b1c61ed694d28540";

export interface Question {
  id: string;
  kind: "noul" | "score" | "choice";
  instructions: unknown;
  criteria?: unknown;
  options?: unknown;
  reads?: unknown;
  applies_when?: unknown;
  threshold?: unknown;
  [k: string]: unknown;
}

export interface PolicyRule {
  id: string;
  if?: unknown;
  then: string;
  why?: string;
  [k: string]: unknown;
}

export interface QuestionSystem {
  id: string;
  decisions: unknown;
  stages: { id: string; questions: Question[]; [k: string]: unknown }[];
  policy: Record<string, PolicyRule[]>;
  [k: string]: unknown;
}

/** Keys that carry explanation only; they never change a question sent or an outcome decided. */
const PROSE_KEYS = new Set(["schema", "why", "reason", "purpose", "computed_by", "provenance", "fit", "problem", "calibration", "budget", "description", "notes"]);

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => !PROSE_KEYS.has(k)).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** sha256 of the system's behaviour-bearing fields in canonical key order. */
export function systemHash(system: QuestionSystem): string {
  return createHash("sha256").update(canonical(system)).digest("hex");
}

/** The shipped question system; throws if the file is missing or not a question system. */
export function loadSystem(): QuestionSystem {
  const parsed: unknown = JSON.parse(readFileSync(join(import.meta.dir, "system.json"), "utf8"));
  const s = parsed as Partial<QuestionSystem>;
  if (typeof s?.id !== "string" || !Array.isArray(s.stages) || s.policy === null || typeof s.policy !== "object") {
    throw new Error("src/jev/system.json is not a question system (needs id, stages, policy)");
  }
  return s as QuestionSystem;
}

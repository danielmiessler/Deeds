/**
 * The fast classifier. One commit costs:
 *   - zero model calls when every hunk is on the noise list;
 *   - one call for the typed questions, in one strict json_schema request;
 *   - one more call, only when the policy counts caps, that names each cap;
 *   - a full-model read instead, when any typed answer is `unsure`.
 * A request is built from the commit's files and diff only, so the commit message cannot reach it
 *, and every request is held under MAX_REQUEST_BYTES.
 */
import { parseCanon } from "../canon.ts";
import { ClassifyError, classifyCommit, replyText, type CommitDiff, type ModelFn, type ModelRequest } from "../classify.ts";
import type { CapChange, Deed } from "../schema.ts";
import { stripNoise } from "./noise.ts";
import { applyPolicy } from "./policy.ts";
import { namingSchema, parseAnswers, QUESTION_INSTRUCTIONS, QUESTION_SCHEMA } from "./questions.ts";

/**
 * A request's system text, user text and schema together stay under this many UTF-8 bytes. Every token
 * of a byte-level BPE tokenizer covers at least one byte, so the input is at most this many tokens plus
 * the chat template's few per message, well inside the per-request size cap set by MAX_REQUEST_BYTES.
 */
export const MAX_REQUEST_BYTES = 11_000;

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** Total UTF-8 bytes a request sends: system, user, and the response schema. */
export function requestBytes(req: ModelRequest): number {
  return bytes(req.system) + bytes(req.user) + (req.responseSchema ? bytes(JSON.stringify(req.responseSchema)) : 0);
}

/** Cut `text` to at most `max` UTF-8 bytes on a character boundary, saying so in the text. */
function cutTo(text: string, max: number): string {
  if (bytes(text) <= max) return text;
  const note = "\n... diff cut to fit the request budget\n";
  const room = Math.max(0, max - bytes(note));
  let out = Buffer.from(text, "utf8").subarray(0, room).toString("utf8");
  // A cut inside a multi-byte character decodes to U+FFFD; drop it so the byte count holds.
  while (bytes(out) > room) out = out.slice(0, -1);
  return out + note;
}

/** The canon's worked examples, one per line: the precedent the fast questions judge by. */
function canonDigest(canon: string): string {
  return parseCanon(canon).examples.map((e) => `- [${e.kind}${e.change ? `:${e.change}` : ""}] ${e.text}`).join("\n");
}

/** Fit a request with the diff filling whatever the budget leaves. */
function fitRequest(system: string, head: string, diff: string, responseSchema: ModelRequest["responseSchema"]): ModelRequest {
  const fixed: ModelRequest = { system, user: `${head}\n\nDiff:\n`, ...(responseSchema ? { responseSchema } : {}) };
  const room = MAX_REQUEST_BYTES - requestBytes(fixed);
  if (room < 200) throw new ClassifyError("the fast request has no room left for the diff; the canon or question set is too large");
  return { system, user: fixed.user + cutTo(diff, room), ...(responseSchema ? { responseSchema } : {}) };
}

const filesHead = (files: string[]) => {
  const list = files.slice(0, 40).map((f) => `- ${f}`);
  if (files.length > 40) list.push(`- ... ${files.length - 40} more`);
  return `Files changed:\n${list.join("\n")}`;
};

/** The typed-question request for one commit. Pure. */
export function buildQuestionRequest(commit: CommitDiff, canon: string): ModelRequest {
  const system = `${QUESTION_INSTRUCTIONS}\n\n## Worked examples\n\n${canonDigest(canon)}`;
  return fitRequest(system, filesHead(commit.files), commit.diff, { name: "deed_questions", schema: QUESTION_SCHEMA });
}

/** The naming request: one short name per counted cap. Pure. */
export function buildNamingRequest(commit: CommitDiff, count: number, change: CapChange): ModelRequest {
  const system = `Name the capabilities a code change ${change === "new" ? "adds" : change === "deepened" ? "extends" : change === "regressed" ? "degrades" : "removes"}, judged from its diff alone.
Give exactly ${count} name${count === 1 ? "" : "s"}, one per distinct capability, each a short phrase naming what a user can do (for example "export orders as CSV").`;
  return fitRequest(system, filesHead(commit.files), commit.diff, { name: "cap_names", schema: namingSchema(count) });
}

function parseNames(text: string, count: number): string[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new ClassifyError("cap names reply is not JSON");
  }
  const names = (doc as { names?: unknown } | null)?.names;
  if (!Array.isArray(names) || names.length !== count || !names.every((n) => typeof n === "string" && n.trim() !== "")) {
    throw new ClassifyError(`cap names reply must hold exactly ${count} non-empty names`);
  }
  return names.map((n: string) => n.trim());
}

export interface FastResult {
  deeds: Deed[];
  /** True when an `unsure` answer sent the commit to the full-model classifier. */
  escalated: boolean;
}

/** Classify one commit on the fast path. Refuses without the canon, exactly as the full path does. */
export async function classifyFast(commit: CommitDiff, opts: { canon: string | null; model: ModelFn }): Promise<FastResult> {
  if (opts.canon === null || parseCanon(opts.canon).examples.length === 0) {
    throw new ClassifyError("the deed canon is missing or holds no labelled examples; refusing to classify without precedent", "canon_missing");
  }
  const clean = stripNoise(commit);
  if (clean.diff.trim() === "") return { deeds: [], escalated: false };
  const signal = { files: clean.files, diff: clean.diff };

  const answers = parseAnswers(replyText(await opts.model(buildQuestionRequest(signal, opts.canon))));
  const outcome = applyPolicy(answers);
  if (outcome.escalate) return { deeds: await classifyCommit(signal, { canon: opts.canon, model: opts.model }), escalated: true };

  const deeds: Deed[] = [];
  if (outcome.caps > 0 && outcome.change) {
    const names = parseNames(replyText(await opts.model(buildNamingRequest(signal, outcome.caps, outcome.change))), outcome.caps);
    for (const name of names) deeds.push({ kind: "cap", change: outcome.change, name, summary: name });
  }
  if (outcome.fix) deeds.push({ kind: "fix", summary: "fixes a defect" });
  if (outcome.tend) deeds.push({ kind: "tend", summary: "upkeep" });
  return { deeds, escalated: false };
}

/**
 * Commit classification: one commit's diff in, zero or more deeds out.
 *
 * The model sees the diff and the canon, nothing else. There is no message field on `CommitDiff`, so a
 * commit message cannot reach the model. The kinds are defined by the canon's worked examples,
 * not by prose rules, so removing the canon changes the answer.
 */
import { parseCanon } from "./canon.ts";
import { DEED_KINDS, CAP_CHANGES, parseDeed, type Deed } from "./schema.ts";

/** What the classifier is given about a commit. No message, no author, no date: the diff is ground truth. */
export interface CommitDiff {
  /** Paths changed, as named by the diff. */
  files: string[];
  /** The unified diff. */
  diff: string;
}

export interface ModelRequest {
  system: string;
  user: string;
  /** When set, the reply must match this JSON schema exactly (OpenAI strict json_schema). */
  responseSchema?: { name: string; schema: { [key: string]: unknown } };
}

/** Tokens one model call used, as the vendor reported them. */
export interface ModelUsage {
  input: number;
  output: number;
}

/** A model reply with its token usage. A bare string is a reply whose usage is unknown (replays, stubs). */
export interface ModelReply {
  text: string;
  usage: ModelUsage;
}

/** A model call: request in, the model's text (and usage when known) out. Tests inject a replay; live runs inject a vendor client. */
export type ModelFn = (req: ModelRequest) => Promise<string | ModelReply>;

export function replyText(r: string | ModelReply): string {
  return typeof r === "string" ? r : r.text;
}

export function replyUsage(r: string | ModelReply): ModelUsage {
  return typeof r === "string" ? { input: 0, output: 0 } : r.usage;
}

export class ClassifyError extends Error {
  constructor(
    message: string,
    readonly code: "classify_failed" | "canon_missing" = "classify_failed",
  ) {
    super(message);
    this.name = "ClassifyError";
  }
}

const INSTRUCTIONS = `You classify one code change into deeds. A deed is one unit of work that changed the product.
Kinds: ${DEED_KINDS.join(", ")}. A cap also has a change: ${CAP_CHANGES.join(", ")}.
What each kind means is defined only by the worked examples below. Judge the diff by the nearest example.
Judge only from the diff you are given. Count what the product can now do or no longer does, never the amount of code.
A change may yield zero, one or several deeds. Reply with JSON only, in this shape:
{"deeds":[{"kind":"cap","change":"new|deepened|regressed|removed","name":"<what the product can do>","summary":"<one sentence>"},{"kind":"fix","summary":"<one sentence>"},{"kind":"tend","summary":"<one sentence>"}]}
Reply {"deeds":[]} when the diff is not a deed.`;

/** Build the model request. Pure. */
export function buildClassifyRequest(commit: CommitDiff, canon: string): ModelRequest {
  return {
    system: `${INSTRUCTIONS}\n\n## Worked examples\n\n${canon}`,
    user: `Files changed:\n${commit.files.map((f) => `- ${f}`).join("\n")}\n\nDiff:\n${commit.diff}`,
  };
}

/** Read the model's reply into validated deeds. Tolerates a fenced block; rejects anything outside the schema. */
export function parseClassification(text: string): Deed[] {
  const body = text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "").trim();
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    throw new ClassifyError("model reply is not JSON");
  }
  const list = (doc as { deeds?: unknown } | null)?.deeds;
  if (!Array.isArray(list)) throw new ClassifyError('model reply has no "deeds" array');
  return list.map((d) => parseDeed(d));
}

/**
 * Classify one commit. Fails closed without the canon: a model judging by its own private idea of a
 * cap, fix or tend would drift silently from run to run, so no canon (missing file, or a file with no
 * labelled examples) means no classification, never a guess.
 */
export async function classifyCommit(
  commit: CommitDiff,
  opts: { canon: string | null; model: ModelFn },
): Promise<Deed[]> {
  if (opts.canon === null || parseCanon(opts.canon).examples.length === 0) {
    throw new ClassifyError("the deed canon is missing or holds no labelled examples; refusing to classify without precedent", "canon_missing");
  }
  return parseClassification(replyText(await opts.model(buildClassifyRequest(commit, opts.canon))));
}

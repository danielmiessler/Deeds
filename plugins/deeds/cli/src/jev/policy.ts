/**
 * The policy evaluator: turns a commit's code-computed facts and the judgment API's answers into one outcome per
 * decision (cap, fix, tend) by walking each decision's ordered rule list in `system.json`. Pure: no I/O, no clock.
 * Ported unchanged in behaviour from the question-system workshop's evaluator; the parity test holds it to that.
 */

import { createHash } from "node:crypto";

export type Scalar = string | number | boolean;
export type Facts = Record<string, Scalar | null>;

export type NoulAnswer = { type: "noul"; noul: number };
export type ChoiceAnswer = { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };
export type ScoreAnswer = { type: "score"; score: number; confidence: number; probabilities: Record<string, number>; legend?: Record<string, string> };
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
/** Answers by question id; a missing id (or `undefined`) means the question was not asked. */
export type Answers = Record<string, Answer | undefined>;

export type Condition =
  | { fact: string; eq?: Scalar; in?: Scalar[]; gte?: number; lte?: number; present?: boolean }
  | { q: string; is: "yes" | "no" | "uncertain" | "unasked" }
  | { q: string; choice: string | string[] }
  | { q: string; option: string; p_gte: number }
  | { q: string; score_gte?: number; score_lte?: number }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

export type WeightedTerm = { q: string; weight: number; option?: string };
export type Rule =
  | { id: string; if: Condition; then: string; why?: string }
  | { id: string; weighted: { terms: WeightedTerm[]; gte: number }; if?: Condition; then: string; why?: string };

type QuestionBase = { id: string; instructions: unknown; reads: string[]; applies_when?: Condition; threshold: { value: number; favor?: string } };
export type PolicyQuestion =
  | (QuestionBase & { kind: "noul"; criteria?: { true?: unknown; false?: unknown } })
  | (QuestionBase & { kind: "score"; criteria: unknown[] })
  | (QuestionBase & { kind: "choice"; options: Record<string, unknown>; no_match: string });

export type PolicySystem = {
  decisions: { id: string; outcomes: string[]; default: string }[];
  stages: { id: string; when?: Condition; questions: PolicyQuestion[] }[];
  policy: Record<string, Rule[]>;
};

export type EvalTrace = { decision: string; outcome: string; rule: string | null; by: "deterministic" | "judgment" | "escalation" | "default" };
/** Question id → threshold value, overriding each question's own `threshold.value`. */
export type Thresholds = Record<string, number>;
export type EvaluateOptions = { unasked?: Iterable<string>; thresholds?: Thresholds };

export const ESCALATE = "escalate";
const EPS = 1e-9;
const TRUNCATION_JOINER = " … ";

type State5 = "yes" | "no" | "uncertain" | "unasked" | "answered";
type Env = { facts: Facts; question: (id: string) => PolicyQuestion | undefined; answer: (id: string) => Answer | undefined; thresholds: Thresholds | undefined };

/** A noul probability as a verdict and its confidence; throws on a value that is not a probability. */
export function noulValue(p: number): { verdict: "yes" | "no"; confidence: number } {
  if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error("invalid noul probability");
  return { verdict: p >= 1 - p ? "yes" : "no", confidence: Math.max(p, 1 - p) };
}

/** Cut a state field to `max` characters the way the request builder sends it: the head, or two thirds head and one third tail. */
export function truncateText(v: string, max: number, mode: "head" | "head_tail" = "head"): string {
  if (v.length <= max) return v;
  if (mode === "head") return v.slice(0, max);
  const room = Math.max(0, max - TRUNCATION_JOINER.length);
  const head = Math.floor((room * 2) / 3);
  const tail = room - head;
  const joined = v.slice(0, head) + TRUNCATION_JOINER + v.slice(v.length - tail);
  return joined.length < v.length ? joined : v.slice(0, max);
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** sha256 of the question's canonical JSON: kind, instructions, and criteria or options. */
export function questionHash(q: PolicyQuestion): string {
  const body = q.kind === "choice"
    ? { kind: q.kind, instructions: q.instructions, options: q.options }
    : { kind: q.kind, instructions: q.instructions, criteria: q.criteria ?? null };
  return createHash("sha256").update(canonical(body)).digest("hex");
}

const allQuestions = (system: PolicySystem): PolicyQuestion[] => system.stages.flatMap((s) => s.questions);

function makeEnv(system: PolicySystem, facts: Facts, answers: Answers, forced?: ReadonlySet<string>, thresholds?: Thresholds): Env {
  const byId = new Map(allQuestions(system).map((q) => [q.id, q]));
  return { facts, question: (id) => byId.get(id), answer: (id) => (forced?.has(id) ? undefined : answers[id]), thresholds };
}

function checkThresholds(thresholds: Thresholds | undefined): void {
  for (const [id, v] of Object.entries(thresholds ?? {})) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) throw new Error(`threshold override for "${id}" must be a number in [0, 1], got ${String(v)}`);
  }
}

const thresholdOf = (q: PolicyQuestion, thresholds?: Thresholds): number => (thresholds && Object.hasOwn(thresholds, q.id) ? thresholds[q.id]! : q.threshold.value);
const choiceStrength = (a: ChoiceAnswer): number => a.probabilities?.[a.choice] ?? a.confidence ?? 0;

function isUncertain(q: PolicyQuestion, a: Answer, thresholds?: Thresholds): boolean {
  const t = thresholdOf(q, thresholds);
  if (q.kind === "noul" && a.type === "noul") return noulValue(a.noul).confidence + 1e-12 < t;
  if (a.type === "choice") return choiceStrength(a) + 1e-12 < t;
  if (a.type === "score") return (a.confidence ?? 0) + 1e-12 < t;
  return true;
}

/** A noul is yes/no/uncertain at the question's threshold; a choice or score is "answered" or uncertain. */
export function stateOf(q: PolicyQuestion | undefined, a: Answer | undefined, thresholds?: Thresholds): State5 {
  if (!q || !a) return "unasked";
  try {
    if (q.kind === "noul") {
      if (a.type !== "noul") return "unasked";
      return isUncertain(q, a, thresholds) ? "uncertain" : noulValue(a.noul).verdict;
    }
    if (q.kind === "choice" && a.type !== "choice") return "unasked";
    if (q.kind === "score" && a.type !== "score") return "unasked";
    return isUncertain(q, a, thresholds) ? "uncertain" : "answered";
  } catch {
    return "unasked"; // a probability outside [0, 1] is no answer at all
  }
}

function optionShare(a: ChoiceAnswer, option: string): number {
  const p = a.probabilities?.[option];
  return typeof p === "number" ? p : a.choice === option ? a.confidence ?? 0 : 0;
}

function condHolds(c: Condition, env: Env): boolean {
  if ("all" in c) return c.all.every((x) => condHolds(x, env));
  if ("any" in c) return c.any.some((x) => condHolds(x, env));
  if ("not" in c) return !condHolds(c.not, env);
  if ("fact" in c) {
    const v = env.facts[c.fact];
    const has = v !== null && v !== undefined;
    if (c.present !== undefined && c.present !== has) return false;
    if (c.eq !== undefined && v !== c.eq) return false;
    if (c.in !== undefined && !(has && c.in.includes(v as Scalar))) return false;
    if (c.gte !== undefined && !(typeof v === "number" && v >= c.gte - EPS)) return false;
    if (c.lte !== undefined && !(typeof v === "number" && v <= c.lte + EPS)) return false;
    return true;
  }
  const q = env.question(c.q);
  const a = env.answer(c.q);
  if ("is" in c) return stateOf(q, a, env.thresholds) === c.is;
  if ("option" in c) return !!q && q.kind === "choice" && !!a && a.type === "choice" && optionShare(a, c.option) >= c.p_gte - EPS;
  const st = q && a ? stateOf(q, a, env.thresholds) : "unasked";
  if (!q || !a || st === "unasked" || st === "uncertain") return false;
  if ("choice" in c) return q.kind === "choice" && a.type === "choice" && (Array.isArray(c.choice) ? c.choice : [c.choice]).includes(a.choice);
  if (q.kind !== "score" || a.type !== "score") return false;
  if (c.score_gte !== undefined && !(a.score >= c.score_gte - EPS)) return false;
  if (c.score_lte !== undefined && !(a.score <= c.score_lte + EPS)) return false;
  return c.score_gte !== undefined || c.score_lte !== undefined;
}

function termValue(t: WeightedTerm, env: Env): number {
  const q = env.question(t.q);
  const a = env.answer(t.q);
  if (!q || !a) return 0;
  if (q.kind === "noul" && a.type === "noul") return a.noul;
  if (q.kind === "score" && a.type === "score") return Math.min(1, Math.max(0, a.score / (q.criteria.length - 1)));
  if (q.kind === "choice" && a.type === "choice" && t.option !== undefined) return optionShare(a, t.option);
  return 0;
}

function ruleFires(rule: Rule, env: Env): boolean {
  if ("weighted" in rule) {
    if (rule.if && !condHolds(rule.if, env)) return false;
    const sum = rule.weighted.terms.reduce((acc, t) => acc + t.weight * termValue(t, env), 0);
    return sum >= rule.weighted.gte - EPS;
  }
  return condHolds(rule.if, env);
}

function conditionQuestions(c: Condition, into: Set<string>): Set<string> {
  if ("all" in c) c.all.forEach((x) => conditionQuestions(x, into));
  else if ("any" in c) c.any.forEach((x) => conditionQuestions(x, into));
  else if ("not" in c) conditionQuestions(c.not, into);
  else if ("q" in c) into.add(c.q);
  return into;
}

function ruleQuestions(rule: Rule): Set<string> {
  const into = new Set<string>();
  if (rule.if) conditionQuestions(rule.if, into);
  if ("weighted" in rule) rule.weighted.terms.forEach((t) => into.add(t.q));
  return into;
}

/** True when a stage should be asked for this commit, given its facts and the answers earlier stages returned. */
export function stageRuns(system: PolicySystem, stageId: string, facts: Facts, answers: Answers, thresholds?: Thresholds): boolean {
  const stage = system.stages.find((s) => s.id === stageId);
  if (!stage) throw new Error(`unknown stage "${stageId}"`);
  return !stage.when || condHolds(stage.when, makeEnv(system, facts, answers, undefined, thresholds));
}

/** Evaluate one decision: the first rule that fires decides; with none, the decision's default stands. */
export function evaluateDecision(system: PolicySystem, decisionId: string, facts: Facts, answers: Answers, opts: EvaluateOptions = {}): EvalTrace {
  const decision = system.decisions.find((d) => d.id === decisionId);
  if (!decision) throw new Error(`unknown decision "${decisionId}"`);
  checkThresholds(opts.thresholds);
  const env = makeEnv(system, facts, answers, opts.unasked ? new Set(opts.unasked) : undefined, opts.thresholds);
  for (const rule of system.policy[decisionId] ?? []) {
    if (!ruleFires(rule, env)) continue;
    const by: EvalTrace["by"] = ruleQuestions(rule).size === 0 ? "deterministic" : rule.then === ESCALATE ? "escalation" : "judgment";
    return { decision: decisionId, outcome: rule.then, rule: rule.id, by };
  }
  return { decision: decisionId, outcome: decision.default, rule: null, by: "default" };
}

/** One trace per decision, in declaration order. */
export function evaluate(system: PolicySystem, facts: Facts, answers: Answers, opts: EvaluateOptions = {}): EvalTrace[] {
  return system.decisions.map((d) => evaluateDecision(system, d.id, facts, answers, opts));
}

/**
 * The fast question set: many small typed questions asked of one diff in one
 * request, answered into a strict JSON schema whose every property is a boolean, an enum or a bounded
 * integer. A fixed policy (policy.ts) turns the answers into deeds; the model never writes a
 * deed itself on this path.
 */

/** Bump on any change to the questions, the schema or the policy: it is part of the cache key. */
export const QUESTION_SET_VERSION = "fast-q1";

export const CAPABILITY_ANSWERS = ["added", "extended", "degraded", "removed", "none", "unsure"] as const;
export const YES_NO_UNSURE = ["yes", "no", "unsure"] as const;
export type CapabilityAnswer = (typeof CAPABILITY_ANSWERS)[number];
export type YesNoUnsure = (typeof YES_NO_UNSURE)[number];

/** The most capabilities one commit may be credited with on the fast path. */
export const MAX_CAPS_PER_COMMIT = 5;

export interface FastAnswers {
  capability: CapabilityAnswer;
  capability_count: number;
  fixes_defect: YesNoUnsure;
  upkeep: YesNoUnsure;
  behaviour_preserving: boolean;
  is_revert: boolean;
}

type JsonSchema = { [key: string]: unknown };

export const QUESTION_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["capability", "capability_count", "fixes_defect", "upkeep", "behaviour_preserving", "is_revert"],
  properties: {
    capability: {
      type: "string",
      enum: [...CAPABILITY_ANSWERS],
      description: "What this diff does to what a user of the product can do: added a new capability, extended an existing one, degraded one, removed one, none, or unsure.",
    },
    capability_count: {
      type: "integer",
      minimum: 0,
      maximum: MAX_CAPS_PER_COMMIT,
      description: "How many distinct capabilities the diff adds, extends, degrades or removes. 0 when capability is none.",
    },
    fixes_defect: { type: "string", enum: [...YES_NO_UNSURE], description: "Does the diff make something that was broken sound (a bug or a security hole)?" },
    upkeep: { type: "string", enum: [...YES_NO_UNSURE], description: "Does the diff hold invisible upkeep: refactor, dependencies, performance, tests, docs, tooling?" },
    behaviour_preserving: { type: "boolean", description: "True when the product does exactly what it did before: a refactor, a rename, a move, formatting." },
    is_revert: { type: "boolean", description: "True when the diff undoes an earlier change." },
  },
};

export const QUESTION_INSTRUCTIONS = `You answer typed questions about one code change, judged from its diff alone.
A capability is something a user of the product can do. Judge by the nearest worked example below.
Count what the product can now do or no longer does, never the amount of code. Answer "unsure" rather than guess.`;

/** The naming call's schema: exactly `count` capability names, one per counted cap. */
export function namingSchema(count: number): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["names"],
    properties: {
      names: { type: "array", minItems: count, maxItems: count, items: { type: "string" } },
    },
  };
}

export function parseAnswers(text: string): FastAnswers {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error("fast answers are not JSON");
  }
  const d = doc as Record<string, unknown>;
  const inList = <T extends readonly string[]>(list: T, v: unknown): v is T[number] => typeof v === "string" && (list as readonly string[]).includes(v);
  if (!inList(CAPABILITY_ANSWERS, d.capability)) throw new Error("fast answer capability out of range");
  if (!Number.isInteger(d.capability_count) || (d.capability_count as number) < 0 || (d.capability_count as number) > MAX_CAPS_PER_COMMIT) {
    throw new Error("fast answer capability_count out of range");
  }
  if (!inList(YES_NO_UNSURE, d.fixes_defect)) throw new Error("fast answer fixes_defect out of range");
  if (!inList(YES_NO_UNSURE, d.upkeep)) throw new Error("fast answer upkeep out of range");
  if (typeof d.behaviour_preserving !== "boolean" || typeof d.is_revert !== "boolean") throw new Error("fast answer booleans missing");
  return {
    capability: d.capability,
    capability_count: d.capability_count as number,
    fixes_defect: d.fixes_defect,
    upkeep: d.upkeep,
    behaviour_preserving: d.behaviour_preserving,
    is_revert: d.is_revert,
  };
}

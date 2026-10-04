/**
 * The answers-to-deeds policy: a pure function from typed answers to deed counts. Any
 * `unsure` escalates the commit to the full-model classifier instead of guessing.
 */
import type { CapChange } from "../schema.ts";
import type { CapabilityAnswer, FastAnswers } from "./questions.ts";

export type PolicyOutcome =
  | { escalate: true }
  | { escalate: false; caps: number; change: CapChange | null; fix: boolean; tend: boolean };

const CHANGE_OF: Partial<Record<CapabilityAnswer, CapChange>> = {
  added: "new",
  extended: "deepened",
  degraded: "regressed",
  removed: "removed",
};

export function applyPolicy(a: FastAnswers): PolicyOutcome {
  if (a.capability === "unsure" || a.fixes_defect === "unsure" || a.upkeep === "unsure") return { escalate: true };
  const change = CHANGE_OF[a.capability] ?? null;
  // A behaviour-preserving change or a revert never earns a cap: it changes no capability on net.
  const capsAllowed = change !== null && !a.behaviour_preserving && !a.is_revert;
  const caps = capsAllowed ? Math.max(1, a.capability_count) : 0;
  const fix = a.fixes_defect === "yes" && !a.behaviour_preserving;
  // Upkeep is credited when asked for, and for a behaviour-preserving change or revert that earned nothing else.
  const tend = a.upkeep === "yes" || (caps === 0 && !fix && (a.behaviour_preserving || a.is_revert));
  return { escalate: false, caps, change: caps > 0 ? change : null, fix, tend };
}

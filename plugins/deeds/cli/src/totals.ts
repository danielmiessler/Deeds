/** Deed totals for a window. Pure. A negative cap change takes one off the cap total. */
import { CAP_CHANGES, type CapChange, type Deed } from "./schema.ts";

export interface Tally {
  /** Net caps: new and deepened count +1 each, regressed and removed count -1 each. */
  cap: number;
  fix: number;
  tend: number;
  /** The four cap changes, counted apart, so a negative never hides inside the net. */
  capChanges: Record<CapChange, number>;
}

export function capDelta(change: CapChange): 1 | -1 {
  return change === "regressed" || change === "removed" ? -1 : 1;
}

export function tallyDeeds(deeds: readonly Deed[]): Tally {
  const capChanges = Object.fromEntries(CAP_CHANGES.map((c) => [c, 0])) as Record<CapChange, number>;
  const t: Tally = { cap: 0, fix: 0, tend: 0, capChanges };
  for (const d of deeds) {
    if (d.kind === "cap") {
      t.cap += capDelta(d.change);
      capChanges[d.change]++;
    } else t[d.kind]++;
  }
  return t;
}

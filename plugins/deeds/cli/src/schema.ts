/**
 * The deed schema. A deed is one unit of work that changed the product, of exactly one of
 * three kinds. A cap also says how the capability changed. No I/O, so any module may import it.
 */

export const DEED_KINDS = ["cap", "fix", "tend"] as const;
export type DeedKind = (typeof DEED_KINDS)[number];

/** How a cap changed. `regressed` and `removed` are negative deeds. */
export const CAP_CHANGES = ["new", "deepened", "regressed", "removed"] as const;
export type CapChange = (typeof CAP_CHANGES)[number];

export type CapDeed = { kind: "cap"; change: CapChange; name: string; summary: string };
export type FixDeed = { kind: "fix"; summary: string };
export type TendDeed = { kind: "tend"; summary: string };
export type Deed = CapDeed | FixDeed | TendDeed;

export class DeedSchemaError extends Error {
  readonly code = "deed_schema";
  constructor(message: string) {
    super(message);
    this.name = "DeedSchemaError";
  }
}

export type ParseResult = { ok: true; deed: Deed } | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const has = <T extends readonly string[]>(list: T, v: unknown): v is T[number] =>
  typeof v === "string" && (list as readonly string[]).includes(v);

/** Validate one deed. Rejects any kind outside cap, fix and tend, any cap change outside the four, and unknown fields. */
export function safeParseDeed(input: unknown): ParseResult {
  if (!isRecord(input)) return { ok: false, error: "a deed must be an object" };
  const { kind } = input;
  if (!has(DEED_KINDS, kind)) {
    return { ok: false, error: `kind must be one of ${DEED_KINDS.join(", ")}; got ${JSON.stringify(kind)}` };
  }
  if (!isText(input.summary)) return { ok: false, error: "summary must be a non-empty string" };
  const allowed = kind === "cap" ? ["kind", "change", "name", "summary"] : ["kind", "summary"];
  const extra = Object.keys(input).filter((k) => !allowed.includes(k));
  if (extra.length > 0) return { ok: false, error: `a ${kind} deed has no field ${extra.map((k) => `"${k}"`).join(", ")}` };
  if (kind !== "cap") return { ok: true, deed: { kind, summary: input.summary } };
  if (!has(CAP_CHANGES, input.change)) {
    return { ok: false, error: `a cap's change must be one of ${CAP_CHANGES.join(", ")}; got ${JSON.stringify(input.change)}` };
  }
  if (!isText(input.name)) return { ok: false, error: "a cap needs a non-empty name" };
  return { ok: true, deed: { kind, change: input.change, name: input.name, summary: input.summary } };
}

export function parseDeed(input: unknown): Deed {
  const r = safeParseDeed(input);
  if (!r.ok) throw new DeedSchemaError(r.error);
  return r.deed;
}

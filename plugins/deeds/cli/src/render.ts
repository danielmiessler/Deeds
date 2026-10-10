/**
 * One layout for the analyze report, drawn four ways: plain text, ANSI colour for a terminal,
 * HTML spans for the site, and an SVG terminal for the README. Every output reads the same
 * lines, so a change to the layout shows up everywhere at once.
 */
import type { Report } from "./analyze.ts";
import { escapeControls } from "./terminal.ts";

export type Style = "plain" | "dim" | "bold" | "head" | "cap" | "fix" | "tend" | "capBold" | "fixBold" | "tendBold" | "warn";
export interface Seg { t: string; s?: Style }
export type Line = Seg[];

/** The brand palette, shared by the terminal, the HTML report and the SVG. */
export const PALETTE = {
  ground: "#0F2C2E",
  ground0: "#0A2022",
  paper: "#EEE7D7",
  dim: "#93A8A4",
  cap: "#F2A93B",
  fix: "#E8654E",
  tend: "#97C09F",
} as const;

const KIND = [["cap", "caps"], ["fix", "fixes"], ["tend", "tends"]] as const;
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/** A bar of `width` cells for `n` against `max`, at one-eighth cell precision; any nonzero n shows. */
export function bar(n: number, max: number, width: number): string {
  if (n <= 0 || max <= 0) return "";
  const eighths = Math.max(1, Math.round((Math.min(n, max) / max) * width * 8));
  return "█".repeat(Math.floor(eighths / 8)) + EIGHTHS[eighths % 8];
}

/** Emoji have no fixed width in a terminal, so names drop them before they are lined up. */
const display = (s: string) => s.normalize("NFC").replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "").trim() || s;

/** Weekly rows summed into calendar months, labelled YYYY-MM. */
function months(weeks: Report["weeks"]): { label: string; cap: number; fix: number; tend: number }[] {
  const m = new Map<string, { label: string; cap: number; fix: number; tend: number }>();
  for (const w of weeks) {
    const k = w.week.slice(0, 7);
    const row = m.get(k) ?? { label: k, cap: 0, fix: 0, tend: 0 };
    row.cap += w.cap; row.fix += w.fix; row.tend += w.tend;
    m.set(k, row);
  }
  return [...m.values()];
}

const padEnd = (s: string, n: number) => s + " ".repeat(Math.max(0, n - [...s].length));
const padStart = (s: string, n: number) => " ".repeat(Math.max(0, n - [...s].length)) + s;
const clip = (s: string, n: number) => ([...s].length > n ? [...s].slice(0, n - 1).join("") + "…" : s);

/** Share `cells` between the nonzero kinds by largest remainder; every nonzero kind gets at least one cell. */
export function split(a: { cap: number; fix: number; tend: number }, cells: number): ["cap" | "fix" | "tend", number][] {
  const kinds = KIND.map(([k]) => k).filter((k) => a[k] > 0);
  const total = kinds.reduce((n, k) => n + a[k], 0);
  if (!total) return [];
  const n = Math.max(cells, kinds.length);
  const exact = kinds.map((k) => (a[k] / total) * n);
  const out = exact.map((x) => Math.max(1, Math.floor(x)));
  let left = n - out.reduce((x, y) => x + y, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((p, q) => q[0] - p[0]);
  for (let j = 0; left > 0; j = (j + 1) % order.length, left--) out[order[j]![1]]!++;
  while (left < 0) { const i = out.indexOf(Math.max(...out)); out[i]!--; left++; }
  return kinds.map((k, i) => [k, out[i]!]);
}

/** The change glyph and colour of a cap. */
export function capMark(change: string): { glyph: string; s: Style } {
  if (change === "new") return { glyph: "+", s: "capBold" };
  if (change === "deepened") return { glyph: "↑", s: "capBold" };
  if (change === "regressed") return { glyph: "↓", s: "fixBold" };
  return { glyph: "−", s: "fixBold" };
}

/** The report as styled lines. `maxCaps` bounds the caps list; the rest is counted, never dropped silently. */
export function reportLines(r: Report, opts: { maxCaps?: number; maxAuthors?: number; maxWeeks?: number } = {}): Line[] {
  const maxWeeks = opts.maxWeeks ?? 16;
  const maxCaps = opts.maxCaps ?? 15;
  const maxAuthors = opts.maxAuthors ?? 10;
  const L: Line[] = [];
  const blank = () => L.push([]);
  const day = (iso: string | null) => iso?.slice(0, 10) ?? "-";

  L.push([{ t: "deeds", s: "capBold" }, { t: "  " }, { t: r.repo, s: "head" }]);
  const cache = r.cached ? ` (${r.cached} cached)` : "";
  L.push([{ t: `${day(r.window.first)} → ${day(r.window.last)}  ·  ${r.commits} commits${cache}  ·  judged by ${r.mode} (${r.model.replace(/^typesafe:/, "")})`, s: "dim" }]);
  blank();

  const totals: Line = [{ t: "  " }];
  KIND.forEach(([k, word], i) => {
    if (i) totals.push({ t: "     " });
    totals.push({ t: String(r.totals[k]), s: `${k}Bold` as Style }, { t: ` ${word}`, s: k });
  });
  L.push(totals);
  blank();

  if (r.weeks.length) {
    const W = 12;
    // A long window reads better by month than as a column of quiet weeks.
    const byMonth = r.weeks.length > maxWeeks;
    const rows = byMonth ? months(r.weeks) : r.weeks.map((w) => ({ ...w, label: w.week.slice(5) }));
    // Each kind on its own scale, so a quiet column still shows its shape next to a busy one.
    const max = { cap: Math.max(1, ...rows.map((w) => w.cap)), fix: Math.max(1, ...rows.map((w) => w.fix)), tend: Math.max(1, ...rows.map((w) => w.tend)) };
    const head: Line = [{ t: padEnd(byMonth ? "month" : "week of", 11), s: "dim" }];
    for (const [k, word] of KIND) head.push({ t: padEnd(word, W + 5), s: k });
    L.push(head);
    for (const w of rows.slice(-maxWeeks)) {
      const row: Line = [{ t: padEnd(w.label, 11), s: "dim" }];
      for (const [k] of KIND) {
        const n = w[k];
        const b = n > 0 ? bar(n, max[k], W) : n < 0 ? "◂" : "·";
        row.push({ t: b, s: n > 0 ? k : n < 0 ? "fix" : "dim" }, { t: " " + padEnd(n < 0 ? `−${-n}` : String(n), W + 4 - [...b].length), s: n > 0 ? "plain" : n < 0 ? "fix" : "dim" });
      }
      L.push(row);
    }
    blank();
  }

  if (r.authors.length) {
    const shown = r.authors.slice(0, maxAuthors);
    const nameW = Math.min(24, Math.max(10, ...shown.map((a) => [...display(a.author)].length)) + 2);
    L.push([{ t: padEnd("by author", nameW), s: "dim" }, { t: padStart("caps", 6), s: "cap" }, { t: padStart("fixes", 7), s: "fix" }, { t: padStart("tends", 7), s: "tend" }]);
    const top = Math.max(1, ...shown.map((a) => a.cap + a.fix + a.tend));
    for (const a of shown) {
      const row: Line = [{ t: padEnd(clip(display(a.author), nameW - 2), nameW) }];
      for (const [k, , w] of [["cap", "caps", 6], ["fix", "fixes", 7], ["tend", "tends", 7]] as const) row.push({ t: padStart(String(a[k]), w), s: a[k] ? `${k}Bold` as Style : "dim" });
      row.push({ t: "   " });
      // One stacked bar per author, 16 cells at full share, coloured by kind.
      const total = a.cap + a.fix + a.tend;
      for (const [k, cells] of split(a, Math.round((total / top) * 16))) row.push({ t: "█".repeat(cells), s: k });
      L.push(row);
    }
    if (r.authors.length > shown.length) L.push([{ t: `+ ${r.authors.length - shown.length} more authors`, s: "dim" }]);
    blank();
  }

  if (r.caps.length) {
    const shown = r.caps.slice(-maxCaps).reverse();
    L.push([{ t: "caps", s: "cap" }, { t: `  newest first${r.caps.length > shown.length ? `, ${shown.length} of ${r.caps.length}` : ""}`, s: "dim" }]);
    const nameW = Math.min(44, Math.max(...shown.map((c) => [...c.name].length)) + 2);
    for (const c of shown) {
      const m = capMark(c.change);
      L.push([{ t: "  " }, { t: m.glyph, s: m.s }, { t: " " }, { t: padEnd(clip(c.name, nameW - 2), nameW) }, { t: `${c.sha}  ${c.author}`, s: "dim" }]);
    }
    blank();
  }

  if (r.failed.length) {
    L.push([{ t: `incomplete: ${r.failed.length} commits could not be judged, so these totals are a lower bound (first: ${r.failed[0]!.sha} ${r.failed[0]!.error})`, s: "warn" }]);
  }
  if (r.redactions) L.push([{ t: `${r.redactions} secret-shaped strings were redacted before leaving this machine`, s: "dim" }]);
  while (L.length && L.at(-1)!.length === 0) L.pop();
  return L;
}

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(";");
const ANSI: Record<Style, string> = {
  plain: "",
  dim: `\x1b[38;2;${hex(PALETTE.dim)}m`,
  bold: "\x1b[1m",
  head: "\x1b[1m",
  cap: `\x1b[38;2;${hex(PALETTE.cap)}m`,
  fix: `\x1b[38;2;${hex(PALETTE.fix)}m`,
  tend: `\x1b[38;2;${hex(PALETTE.tend)}m`,
  capBold: `\x1b[1;38;2;${hex(PALETTE.cap)}m`,
  fixBold: `\x1b[1;38;2;${hex(PALETTE.fix)}m`,
  tendBold: `\x1b[1;38;2;${hex(PALETTE.tend)}m`,
  warn: `\x1b[1;38;2;${hex(PALETTE.fix)}m`,
};

const ANSI_RESET = "\x1b[0m";

/** The only escape sequences the text renderer writes; terminal output lets these through and escapes the rest. */
export const ANSI_SEQUENCES: ReadonlySet<string> = new Set([...Object.values(ANSI).filter(Boolean), ANSI_RESET]);

/**
 * Plain text, or ANSI colour when `color` is set. Segment text comes from the repository (author names, cap
 * names), so its control characters are escaped before the renderer adds its own colour codes.
 */
export function toText(lines: Line[], color: boolean): string {
  return lines
    .map((l) => l.map((g) => (color && g.s && ANSI[g.s] ? `${ANSI[g.s]}${escapeControls(g.t)}${ANSI_RESET}` : escapeControls(g.t))).join("").trimEnd())
    .join("\n");
}

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** HTML spans, one element per line, classed `s-<style>`. */
export function toHtmlLines(lines: Line[], lineClass = "ln"): string {
  return lines
    .map((l) => `<div class="${lineClass}">${l.map((g) => (g.s && g.s !== "plain" ? `<span class="s-${g.s}">${escapeHtml(g.t)}</span>` : escapeHtml(g.t))).join("") || "&#8203;"}</div>`)
    .join("\n");
}

/** A terminal window as a standalone SVG, for places that cannot show colour any other way (a README). */
export function toSvg(lines: Line[], title: string): string {
  const fs = 14, lh = 21, cw = 8.43, padX = 22, top = 52;
  const cols = Math.max(title.length + 10, ...lines.map((l) => l.reduce((n, g) => n + [...g.t].length, 0)));
  const w = Math.ceil(cols * cw + padX * 2), h = top + lines.length * lh + 18;
  const fill: Record<Style, string> = {
    plain: PALETTE.paper, dim: PALETTE.dim, bold: PALETTE.paper, head: PALETTE.paper,
    cap: PALETTE.cap, fix: PALETTE.fix, tend: PALETTE.tend, capBold: PALETTE.cap, fixBold: PALETTE.fix, tendBold: PALETTE.tend, warn: PALETTE.fix,
  };
  const bold = new Set<Style>(["bold", "head", "capBold", "fixBold", "tendBold", "warn"]);
  const body = lines.map((l, i) => {
    let x = 0;
    const spans = l.map((g) => {
      const s = g.s ?? "plain";
      const out = `<tspan x="${(padX + x * cw).toFixed(1)}" fill="${fill[s]}"${bold.has(s) ? ' font-weight="700"' : ""}>${escapeHtml(g.t)}</tspan>`;
      x += [...g.t].length;
      return out;
    }).join("");
    return `<text y="${top + i * lh}" xml:space="preserve">${spans}</text>`;
  }).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${escapeHtml(title)}">
<rect width="${w}" height="${h}" rx="12" fill="${PALETTE.ground0}"/>
<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="12" fill="none" stroke="#EEE7D7" stroke-opacity="0.14"/>
<circle cx="22" cy="20" r="5" fill="#EEE7D7" fill-opacity="0.18"/><circle cx="38" cy="20" r="5" fill="#EEE7D7" fill-opacity="0.18"/><circle cx="54" cy="20" r="5" fill="#EEE7D7" fill-opacity="0.18"/>
<text x="72" y="25" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="13" fill="${PALETTE.dim}">${escapeHtml(title)}</text>
<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="${fs}">
${body}
</g>
</svg>
`;
}

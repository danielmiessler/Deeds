/**
 * The analyze report as one self-contained HTML page: no scripts, no fonts or images fetched,
 * so it opens offline and can be mailed or attached as is.
 */
import type { Report } from "./analyze.ts";
import { escapeHtml as e, PALETTE } from "./render.ts";

const KINDS = [["cap", "caps", "Capabilities gained or deepened"], ["fix", "fixes", "Broken things made sound"], ["tend", "tends", "Upkeep users never see"]] as const;
const CHANGE: Record<string, { label: string; kind: "cap" | "fix" }> = {
  new: { label: "New", kind: "cap" },
  deepened: { label: "Deepened", kind: "cap" },
  regressed: { label: "Regressed", kind: "fix" },
  removed: { label: "Removed", kind: "fix" },
};

/** A small line of weekly values for a stat card. */
function spark(values: number[], color: string): string {
  if (values.length < 2) return "";
  const w = 160, h = 36, max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 3 - (v / max) * (h - 6)).toFixed(1)}`);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;
}

/** Weekly columns as three strips, one per kind, each on its own scale over a shared week axis. */
function weekChart(r: Report): string {
  if (!r.weeks.length) return "";
  const n = r.weeks.length, step = 10, colW = 7, w = n * step, h = 56;
  const strips = KINDS.map(([k, word]) => {
    const max = Math.max(1, ...r.weeks.map((x) => Math.abs(x[k])));
    const total = r.weeks.reduce((t, x) => t + x[k], 0);
    const cols = r.weeks.map((wk, i) => {
      const v = wk[k];
      if (!v) return "";
      const bh = Math.max(2, (Math.abs(v) / max) * (h - 2));
      return `<rect x="${i * step + (step - colW) / 2}" y="${(h - bh).toFixed(1)}" width="${colW}" height="${bh.toFixed(1)}" rx="1" class="${v < 0 ? "b-neg" : `b-${k}`}"><title>${e(wk.week)}: ${v} ${word}</title></rect>`;
    }).join("");
    return `<div class="strip"><div class="strip-label t-${k}"><b>${total}</b> ${word}<span>peak ${max}</span></div><svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${word} per week"><line x1="0" x2="${w}" y1="${h - 0.5}" y2="${h - 0.5}" class="axis"/>${cols}</svg></div>`;
  }).join("");
  const every = Math.max(1, Math.ceil(n / 8));
  const labels = r.weeks.map((wk, i) => (i % every === 0 ? `<span style="left:${(((i + 0.5) / n) * 100).toFixed(2)}%">${e(wk.week.slice(2))}</span>` : "")).join("");
  return `<section class="panel">
  <div class="panel-head"><h2>Week by week</h2><span class="count">${n} weeks, each kind on its own scale</span></div>
  ${strips}
  <div class="strip"><div></div><div class="xlabels">${labels}</div></div>
</section>`;
}

function authorsTable(r: Report): string {
  if (!r.authors.length) return "";
  const top = Math.max(1, ...r.authors.map((a) => a.cap + a.fix + a.tend));
  const row = (a: Report["authors"][number]) => {
    const total = a.cap + a.fix + a.tend;
    const seg = KINDS.map(([k]) => (a[k] ? `<i class="b-${k}" style="width:${((a[k] / top) * 100).toFixed(2)}%"></i>` : "")).join("");
    return `<tr><td class="who">${e(a.author)}</td>${KINDS.map(([k]) => `<td class="num ${a[k] ? `t-${k}` : "zero"}">${a[k]}</td>`).join("")}<td class="stack"><div>${seg}</div><span>${total}</span></td></tr>`;
  };
  const rows = r.authors.slice(0, 10).map(row).join("\n");
  const more = r.authors.slice(10);
  const rest = more.length ? `\n<details><summary>Show ${more.length} more authors</summary><table class="authors"><tbody>${more.map(row).join("")}</tbody></table></details>` : "";
  return `<section class="panel">
  <div class="panel-head"><h2>By author</h2><span class="count">${r.authors.length}</span></div>
  <table class="authors"><thead><tr><th>Author</th><th class="num t-cap">Caps</th><th class="num t-fix">Fixes</th><th class="num t-tend">Tends</th><th>Share of the work</th></tr></thead><tbody>
${rows}
  </tbody></table>${rest}
</section>`;
}

function capsList(r: Report): string {
  if (!r.caps.length) return "";
  const li = (c: Report["caps"][number]) => {
    const ch = CHANGE[c.change] ?? CHANGE.removed!;
    return `<li><span class="badge k-${ch.kind}">${ch.label}</span><span class="name">${e(c.name)}</span><span class="meta"><code>${e(c.sha)}</code> ${e(c.author)} · ${e(c.date.slice(0, 10))}</span></li>`;
  };
  const all = [...r.caps].reverse();
  const items = all.slice(0, 24).map(li).join("\n");
  const restCaps = all.length > 24 ? `\n  <details><summary>Show all ${all.length} caps</summary><ul class="caps">${all.slice(24).map(li).join("")}</ul></details>` : "";
  const counts = Object.entries(CHANGE).map(([k, v]) => [v.label, r.caps.filter((c) => c.change === k).length] as const).filter(([, n]) => n);
  return `<section class="panel">
  <div class="panel-head"><h2>Caps by name</h2><span class="count">${counts.map(([l, n]) => `${n} ${l.toLowerCase()}`).join(" · ")}</span></div>
  <ul class="caps">
${items}
  </ul>${restCaps}
  <p class="note">Newest first. Names come from the code: the route, command, UI handler or export a commit added, or else the part of the product it changed most. Regressed and removed caps count −1.</p>
</section>`;
}

/** The whole page. `version` is the deeds version that made it; `generated` an ISO timestamp. */
export function renderHtml(r: Report, opts: { version: string; generated: string }): string {
  const day = (iso: string | null) => iso?.slice(0, 10) ?? "–";
  const cut = r.repo.replace(/\/+$/, "").lastIndexOf("/");
  const name = cut >= 0 ? r.repo.slice(cut + 1) : r.repo, where = cut >= 0 ? r.repo.slice(0, cut) : "";
  const series = (k: "cap" | "fix" | "tend") => r.weeks.map((w) => w[k]);
  const cards = KINDS.map(([k, word, what]) => `<div class="card k-${k}"><div class="big">${r.totals[k]}</div><div class="label">${word}</div><div class="what">${what}</div>${spark(series(k), PALETTE[k])}</div>`).join("");
  const warn = r.failed.length
    ? `<div class="warn">${r.failed.length} of ${r.commits} commits could not be judged, so these totals are a lower bound. Rerun to retry only those commits.</div>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Deeds: ${e(r.repo)}</title>
<style>
:root {
  --ground: ${PALETTE.ground}; --ground-0: ${PALETTE.ground0}; --panel: #133638; --line: rgba(238,231,215,0.12);
  --paper: ${PALETTE.paper}; --dim: ${PALETTE.dim}; --cap: ${PALETTE.cap}; --fix: ${PALETTE.fix}; --tend: ${PALETTE.tend};
  --sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color-scheme: dark;
}
@media (prefers-color-scheme: light) {
  :root { --ground: #F4EFE3; --ground-0: #EAE3D2; --panel: #FBF8F1; --line: rgba(23,42,43,0.12); --paper: #172A2B; --dim: #5A6C6A; --cap: #B8740F; --fix: #C2432C; --tend: #4E8A5C; color-scheme: light; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--ground); color: var(--paper); font: 15px/1.55 var(--sans); -webkit-font-smoothing: antialiased; }
main { max-width: 1040px; margin: 0 auto; padding: 40px 20px 64px; }
header { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 12px 24px; margin-bottom: 28px; }
.brand { font: 700 12px/1.4 var(--mono); letter-spacing: 0.14em; text-transform: uppercase; color: var(--cap); margin-bottom: 8px; }
.brand span { color: var(--dim); text-transform: none; letter-spacing: 0; font-weight: 400; margin-left: 12px; overflow-wrap: anywhere; }
h1 { margin: 0; font-size: clamp(24px, 4.2vw, 36px); line-height: 1.15; letter-spacing: -0.01em; word-break: break-word; }
.meta-line { color: var(--dim); font-size: 14px; text-align: right; }
.meta-line b { color: var(--paper); font-weight: 600; }
.cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-bottom: 14px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 20px 20px 14px; position: relative; overflow: hidden; }
.card::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 4px; }
.card.k-cap::before { background: var(--cap); } .card.k-fix::before { background: var(--fix); } .card.k-tend::before { background: var(--tend); }
.big { font: 700 clamp(34px, 6vw, 52px)/1 var(--sans); font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
.k-cap .big, .k-cap .label { color: var(--cap); } .k-fix .big, .k-fix .label { color: var(--fix); } .k-tend .big, .k-tend .label { color: var(--tend); }
.label { font-weight: 600; margin-top: 6px; } .what { color: var(--dim); font-size: 13px; }
.spark { display: block; width: 100%; height: 36px; margin-top: 10px; opacity: 0.9; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 20px 22px; margin-top: 14px; }
.panel-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px 16px; margin-bottom: 14px; }
h2 { margin: 0; font-size: 17px; } .count { color: var(--dim); font-size: 13px; }
.legend { display: flex; gap: 16px; font-size: 13px; color: var(--dim); } .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
.sw-cap, .b-cap { background: var(--cap); fill: var(--cap); } .sw-fix, .b-fix { background: var(--fix); fill: var(--fix); } .sw-tend, .b-tend { background: var(--tend); fill: var(--tend); }
.strip { display: grid; grid-template-columns: 130px 1fr; gap: 16px; align-items: end; }
.strip + .strip { margin-top: 10px; }
.strip svg { display: block; width: 100%; height: 56px; } .axis { stroke: var(--line); stroke-width: 1; vector-effect: non-scaling-stroke; }
.strip-label { font-size: 14px; padding-bottom: 2px; } .strip-label b { font-size: 20px; font-variant-numeric: tabular-nums; } .strip-label span { display: block; color: var(--dim); font-size: 12px; }
.b-neg { fill: var(--fix); opacity: 0.45; }
.xlabels { position: relative; height: 18px; font: 12px var(--mono); color: var(--dim); }
.xlabels span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
.note { color: var(--dim); font-size: 13px; margin: 12px 0 0; }
table.authors { width: 100%; border-collapse: collapse; font-size: 14px; }
.authors th { text-align: left; font-weight: 500; color: var(--dim); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; padding: 0 10px 8px 0; border-bottom: 1px solid var(--line); }
.authors td { padding: 8px 10px 8px 0; border-bottom: 1px solid var(--line); }
.authors tr:last-child td { border-bottom: 0; }
.who { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.num { text-align: right; font-variant-numeric: tabular-nums; width: 64px; font-weight: 600; }
.t-cap { color: var(--cap); } .t-fix { color: var(--fix); } .t-tend { color: var(--tend); } .zero { color: var(--dim); font-weight: 400; opacity: 0.6; }
.stack { width: 38%; } .stack div { display: inline-flex; width: calc(100% - 44px); height: 10px; vertical-align: middle; gap: 2px; }
.stack i { display: block; height: 100%; border-radius: 2px; min-width: 2px; } .stack span { display: inline-block; width: 40px; text-align: right; color: var(--dim); font-variant-numeric: tabular-nums; font-size: 13px; }
ul.caps { list-style: none; margin: 0; padding: 0; columns: 2 380px; column-gap: 28px; }
.caps li { break-inside: avoid; display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; padding: 9px 0; border-bottom: 1px solid var(--line); }
.badge { grid-row: span 2; align-self: start; font: 600 11px/1 var(--sans); text-transform: uppercase; letter-spacing: 0.05em; padding: 5px 7px; border-radius: 6px; min-width: 76px; text-align: center; }
.badge.k-cap { color: var(--cap); background: color-mix(in srgb, var(--cap) 16%, transparent); }
.badge.k-fix { color: var(--fix); background: color-mix(in srgb, var(--fix) 16%, transparent); }
.name { font-weight: 600; word-break: break-word; } .caps .meta { color: var(--dim); font-size: 12.5px; }
code { font-family: var(--mono); font-size: 12px; }
.warn { margin: 0 0 14px; padding: 12px 16px; border-radius: 10px; border: 1px solid var(--fix); color: var(--fix); background: color-mix(in srgb, var(--fix) 10%, transparent); }
details { margin-top: 12px; } summary { cursor: pointer; color: var(--dim); font-size: 13px; padding: 6px 0; } summary:hover { color: var(--paper); }
footer { margin-top: 28px; color: var(--dim); font-size: 13px; display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px 20px; }
footer a { color: var(--dim); }
@media (max-width: 720px) {
  .cards { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; } .card { padding: 14px 12px 10px; } .what, .spark { display: none; }
  .big { font-size: 30px; } .meta-line { text-align: left; } .brand span { display: block; margin: 4px 0 0; }
  .strip { grid-template-columns: 1fr; gap: 4px; } .strip-label span { display: inline; margin-left: 8px; } .panel { padding: 16px; }
  .stack { display: none; } .authors th:last-child { display: none; }
}
@media print { body { background: #fff; } .panel, .card { break-inside: avoid; } }
</style>
</head>
<body>
<main>
<header>
  <div><div class="brand">Deeds report<span>${e(where)}</span></div><h1>${e(name)}</h1></div>
  <div class="meta-line"><b>${day(r.window.first)} → ${day(r.window.last)}</b><br>${r.commits} commits read · judged by ${e(r.mode)} (${e(r.model.replace(/^typesafe:/, ""))})</div>
</header>
${warn}
<div class="cards">${cards}</div>
${weekChart(r)}
${authorsTable(r)}
${capsList(r)}
<footer>
  <span>Made by deeds ${e(opts.version)} on ${e(opts.generated.slice(0, 10))}. The three counts are kept separate on purpose.${r.redactions ? ` ${r.redactions} secret-shaped strings were redacted before judging.` : ""}</span>
  <a href="https://workdeeds.ai">workdeeds.ai</a>
</footer>
</main>
</body>
</html>
`;
}

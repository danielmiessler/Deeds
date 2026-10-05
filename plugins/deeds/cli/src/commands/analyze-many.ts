import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import type { Report } from "../analyze.ts";
import { type Command, type CommandContext, type CommandResult, DeedsError, EXIT, type JsonValue } from "../contract.ts";
import { checkOutputPath } from "../outpath.ts";
import { parseAnalyzeArgs, resolveJudge } from "../resolve.ts";
import { analyzeTarget, liveDeps, type AnalyzeDeps } from "./analyze.ts";

export interface ManyRepo {
  repo: string;
  status: "ok" | "failed";
  mode: Report["mode"] | null;
  report: Report | null;
  error: string | null;
}

/** The repos a list file names: one local path or github.com URL per line; blank lines and `#` lines are skipped. */
export function readList(path: string): string[] {
  if (!existsSync(path)) throw new DeedsError("not_found", `no such list file: ${path}`, EXIT.error);
  return readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
}

/** analyze-many: every listed repo through the same judge analyze resolves, one report each, totals summed. */
export async function runAnalyzeMany(ctx: Pick<CommandContext, "args" | "json" | "cwd">, deps: AnalyzeDeps = liveDeps): Promise<CommandResult> {
  const rest: string[] = [];
  let out: string | undefined;
  for (let i = 0; i < ctx.args.length; i++) {
    if (ctx.args[i] === "--out") {
      out = ctx.args[++i];
      if (!out) throw new DeedsError("usage", "--out needs a folder", EXIT.usage);
    } else rest.push(ctx.args[i]!);
  }
  const flags = parseAnalyzeArgs(rest);
  if (flags.target === ".") throw new DeedsError("usage", "analyze-many needs a list file: one path or github.com URL per line", EXIT.usage);
  // Checked before any work, so a refused folder costs nothing.
  const outDir = out ? checkOutputPath(ctx.cwd, out, "dir", flags.allowAnyOutput === true) : undefined;
  const judge = resolveJudge(flags, deps.env);
  const listed = readList(resolvePath(ctx.cwd, flags.target));
  const window = { since: flags.since, ...(flags.until ? { until: flags.until } : {}) };

  const repos: ManyRepo[] = [];
  for (const entry of listed) {
    try {
      const report = await analyzeTarget(entry, window, judge, deps, ctx.cwd);
      if (!report.complete) {
        repos.push({ repo: entry, status: "failed", mode: report.mode, report, error: `${report.failed.length} of ${report.commits} commits could not be judged` });
      } else repos.push({ repo: entry, status: "ok", mode: report.mode, report, error: null });
    } catch (err) {
      repos.push({ repo: entry, status: "failed", mode: null, report: null, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (outDir) {
    const dir = outDir;
    mkdirSync(dir, { recursive: true });
    repos.forEach((r, i) => {
      if (r.report) writeFileSync(join(dir, `${String(i + 1).padStart(3, "0")}-${r.repo.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80)}.json`), JSON.stringify(r.report, null, 2));
    });
  }
  const totals = { cap: 0, fix: 0, tend: 0 };
  for (const r of repos) {
    if (!r.report) continue;
    totals.cap += r.report.totals.cap;
    totals.fix += r.report.totals.fix;
    totals.tend += r.report.totals.tend;
  }
  const data = { mode: judge.mode, complete: repos.every((r) => r.status === "ok"), totals, repos };
  const text = [
    ...repos.map((r) => `${r.status === "ok" ? "ok    " : "FAILED"} ${r.repo}${r.report ? `   ${r.report.totals.cap} caps ${r.report.totals.fix} fixes ${r.report.totals.tend} tends` : ""}${r.error ? `   ${r.error}` : ""}`),
    "",
    `all   ${totals.cap} caps      ${totals.fix} fixes      ${totals.tend} tends   (${judge.mode})`,
  ].join("\n");
  return { data: data as unknown as JsonValue, text };
}

const analyzeMany: Command = {
  name: "analyze-many",
  summary: "Analyze every repo a list file names and sum their caps, fixes and tends.",
  usage: "deeds analyze-many <list-file> [--since 90d] [--until <date>] [--mode jev|full] [--out <dir>] [--allow-any-output] [--json]",
  network: "model+clone",
  run: (ctx) => runAnalyzeMany(ctx),
};

export default analyzeMany;

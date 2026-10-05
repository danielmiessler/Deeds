import { writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { analyzeRepo, renderReport, type Report } from "../analyze.ts";
import { renderHtml } from "../html.ts";
import { loadCanon } from "../canon.ts";
import type { ModelFn } from "../classify.ts";
import { type Command, type CommandContext, type CommandResult, DeedsError, EXIT, type JsonValue } from "../contract.ts";
import { cloneOrFetch, isRepo } from "../git.ts";
import { judgeRepo, liveTransport, recordedTransport, repoNameOf, type JevTransport } from "../jev/judge.ts";
import { vendorModel } from "../model.ts";
import { parseAnalyzeArgs, repoSettings, resolveJudge, resolveTarget, toSince, type ResolvedJudge, type ResolvedModel } from "../resolve.ts";

export { toSince };

/** What the command reaches outside itself for; tests replace the transports and the environment. */
export interface AnalyzeDeps {
  env: Record<string, string | undefined>;
  makeModel: (r: ResolvedModel) => ModelFn;
  makeJev: (apiKey: string, env: Record<string, string | undefined>) => JevTransport;
}

/** The live Jev transport, or the recorded one when the DEEDS_JEV_RECORDING test seam names a file. */
export function defaultJev(apiKey: string, env: Record<string, string | undefined>): JevTransport {
  const recording = env.DEEDS_JEV_RECORDING;
  return recording ? recordedTransport(recording, env.DEEDS_JEV_CAPTURE || undefined) : liveTransport(apiKey);
}

export const liveDeps: AnalyzeDeps = {
  env: process.env,
  makeModel: (r) => vendorModel({ vendor: r.vendor, apiKey: r.apiKey, model: r.model }),
  makeJev: defaultJev,
};

/** analyze, with every input resolved through resolve.ts. */
export async function runAnalyze(ctx: Pick<CommandContext, "args" | "json" | "cwd">, deps: AnalyzeDeps = liveDeps): Promise<CommandResult> {
  const flags = parseAnalyzeArgs(ctx.args);
  const judge = resolveJudge(flags, deps.env);
  const onProgress = ctx.json ? undefined : (done: number, total: number) => {
    if (process.stderr.isTTY) process.stderr.write(`\rjudging commits ${done}/${total}${done === total ? "\n" : ""}`);
  };
  const report = await analyzeTarget(flags.target, { since: flags.since, ...(flags.until ? { until: flags.until } : {}) }, judge, deps, ctx.cwd, onProgress);
  // Under --json a caller reads the exit code, so a partial count must not look like a whole one.
  // The judged commits are cached, so a rerun pays only for the ones that failed.
  if (ctx.json && !report.complete) {
    throw new DeedsError(
      "incomplete",
      `${report.failed.length} of ${report.commits} commits could not be judged (first: ${report.failed[0]!.sha} ${report.failed[0]!.error}); totals so far ${report.totals.cap} caps, ${report.totals.fix} fixes, ${report.totals.tend} tends. Rerun to retry only the failed commits.`,
      EXIT.error,
    );
  }
  let text = renderReport(report, wantColor(flags.color, deps.env));
  if (flags.html) {
    const out = resolvePath(ctx.cwd, flags.html);
    try {
      writeFileSync(out, renderHtml(report, { version: pkg.version, generated: new Date().toISOString() }));
    } catch (err) {
      throw new DeedsError("write_failed", `could not write the HTML report to ${out}: ${err instanceof Error ? err.message : String(err)}`, EXIT.error);
    }
    text += `\n\nHTML report: ${out}`;
  }
  return { data: report as unknown as JsonValue, text };
}

/** Colour on a terminal, never when piped, NO_COLOR set or TERM=dumb; --color and --no-color win. */
export function wantColor(flag: boolean | undefined, env: Record<string, string | undefined>, isTTY = Boolean(process.stdout.isTTY)): boolean {
  if (flag !== undefined) return flag;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.TERM === "dumb") return false;
  return isTTY;
}

/** Judge one target (a folder or a GitHub URL) over a window with an already resolved judge. Shared by analyze and analyze-many. */
export async function analyzeTarget(
  targetArg: string,
  win: { since: string; until?: string },
  judge: ResolvedJudge,
  deps: AnalyzeDeps,
  cwd: string,
  onProgress?: (done: number, total: number) => void,
): Promise<Report> {
  const target = resolveTarget(targetArg, cwd, isRepo);
  const repo = target.kind === "github" ? cloneOrFetch(target) : target.path;
  const canon = loadCanon();
  if (!canon) throw new DeedsError("canon_missing", "the deed canon is missing from this install", EXIT.error);
  const window = { since: toSince(win.since), ...(win.until ? { until: win.until } : {}) };
  return judge.mode === "jev"
    ? await judgeRepo({
      repo,
      repoName: repoNameOf(target),
      label: target.label,
      ...window,
      canon,
      transport: deps.makeJev(judge.apiKey, deps.env),
      settings: repoSettings(deps.env),
      onProgress,
    })
    : await analyzeRepo({ repo, label: target.label, ...window, canon, model: deps.makeModel(judge), modelId: judge.modelId, onProgress });
}

const analyze: Command = {
  name: "analyze",
  summary: "Read a repo's commit history over a window and report its caps, fixes and tends.",
  usage: "deeds analyze [path | github.com/owner/repo] [--since 90d] [--until <date>] [--mode jev|full] [--vendor anthropic|openai] [--model <id>] [--html <file>] [--color|--no-color] [--json]",
  network: "model+clone",
  run: (ctx) => runAnalyze(ctx),
};

export default analyze;

import { analyzeRepo, renderReport, type Report } from "../analyze.ts";
import { loadCanon } from "../canon.ts";
import type { ModelFn } from "../classify.ts";
import { type Command, type CommandContext, type CommandResult, DeedsError, EXIT, type JsonValue } from "../contract.ts";
import { cloneOrFetch, isRepo } from "../git.ts";
import { vendorModel } from "../model.ts";
import { parseAnalyzeArgs, resolveModel, resolveTarget, toSince, type ResolvedModel } from "../resolve.ts";

export { toSince };

/** What the command reaches outside itself for; tests replace the model and the environment. */
export interface AnalyzeDeps {
  env: Record<string, string | undefined>;
  makeModel: (r: ResolvedModel) => ModelFn;
}

const liveDeps: AnalyzeDeps = {
  env: process.env,
  makeModel: (r) => vendorModel({ vendor: r.vendor, apiKey: r.apiKey, model: r.model }),
};

/** analyze, with every input resolved through resolve.ts. */
export async function runAnalyze(ctx: Pick<CommandContext, "args" | "json" | "cwd">, deps: AnalyzeDeps = liveDeps): Promise<CommandResult> {
  const flags = parseAnalyzeArgs(ctx.args);
  const resolved = resolveModel(flags, deps.env);
  const target = resolveTarget(flags.target, ctx.cwd, isRepo);
  const repo = target.kind === "github" ? cloneOrFetch(target) : target.path;

  const canon = loadCanon();
  if (!canon) throw new DeedsError("canon_missing", "the deed canon is missing from this install", EXIT.error);

  const report: Report = await analyzeRepo({
    repo,
    label: target.label,
    since: toSince(flags.since),
    ...(flags.until ? { until: flags.until } : {}),
    canon,
    mode: resolved.mode,
    model: deps.makeModel(resolved),
    modelId: resolved.modelId,
    onProgress: ctx.json ? undefined : (done, total) => {
      if (process.stderr.isTTY) process.stderr.write(`\rjudging commits ${done}/${total}${done === total ? "\n" : ""}`);
    },
  });
  // Under --json a caller reads the exit code, so a partial count must not look like a whole one.
  // The judged commits are cached, so a rerun pays only for the ones that failed.
  if (ctx.json && !report.complete) {
    throw new DeedsError(
      "incomplete",
      `${report.failed.length} of ${report.commits} commits could not be judged (first: ${report.failed[0]!.sha} ${report.failed[0]!.error}); totals so far ${report.totals.cap} caps, ${report.totals.fix} fixes, ${report.totals.tend} tends. Rerun to retry only the failed commits.`,
      EXIT.error,
    );
  }
  return { data: report as unknown as JsonValue, text: renderReport(report) };
}

const analyze: Command = {
  name: "analyze",
  summary: "Read a repo's commit history over a window and report its caps, fixes and tends.",
  usage: "deeds analyze [path | github.com/owner/repo] [--since 90d] [--until <date>] [--mode fast|full] [--vendor anthropic|openai] [--model <id>] [--json]",
  network: "model+clone",
  run: (ctx) => runAnalyze(ctx),
};

export default analyze;

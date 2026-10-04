import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { type Command, DeedsError, EXIT, type JsonValue } from "../contract.ts";
import { extractRepo } from "../extract/index.ts";

const URL_LIKE = /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i;

const extract: Command = {
  name: "extract",
  summary: "List every boundary (routes, CLI commands, UI handlers, exports) of a repo, deterministically.",
  usage: "deeds extract [path] [--rev <commit>] [--json]",
  run(ctx) {
    let target = ".";
    let rev: string | undefined;
    let sawPath = false;
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i]!;
      if (a === "--rev") {
        rev = ctx.args[++i];
        if (!rev) throw new DeedsError("usage", "--rev needs a commit", EXIT.usage);
      } else if (a.startsWith("--rev=")) {
        rev = a.slice("--rev=".length);
      } else if (a.startsWith("-")) {
        throw new DeedsError("usage", `unknown option ${a}; usage: deeds extract [path] [--rev <commit>]`, EXIT.usage);
      } else if (sawPath) {
        throw new DeedsError("usage", "only one path is accepted", EXIT.usage);
      } else {
        target = a;
        sawPath = true;
      }
    }
    if (URL_LIKE.test(target)) {
      throw new DeedsError("usage", "extract reads a local folder; clone the repository first", EXIT.usage);
    }
    const root = resolve(ctx.cwd, target);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new DeedsError("not_found", `no such folder: ${target}`, EXIT.error);
    }
    return extractRepo(root, rev).then((data) => ({
      data: data as unknown as JsonValue,
      text: [
        `${data.files} files parsed (${Object.entries(data.languages).map(([k, v]) => `${k} ${v}`).join(", ") || "none"})`,
        `routes ${data.counts.route}, cli ${data.counts.cli}, ui ${data.counts.ui}, exports ${data.counts.export}`,
        ...(data.parseErrors.length ? [`parse errors: ${data.parseErrors.join(", ")}`] : []),
        "",
        ...data.boundaries.map((b) => `${b.kind.padEnd(6)} ${b.name}  ${b.file}:${b.line}`),
      ].join("\n"),
    }));
  },
};

export default extract;

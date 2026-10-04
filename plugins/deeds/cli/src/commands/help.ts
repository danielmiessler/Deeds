import { buildCatalog } from "../catalog.ts";
import type { Command } from "../contract.ts";

const help: Command = {
  name: "help",
  pure: true,
  summary: "List every deeds subcommand; --json prints the machine-readable catalog.",
  run(ctx) {
    const catalog = buildCatalog(ctx.commands, ctx.offlineEnforcement);
    const width = Math.max(...catalog.commands.map((c) => c.name.length));
    const text = [
      "deeds: count caps, fixes and tends.",
      "",
      ...catalog.commands.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
      "",
      "Add --json to any command for machine-readable output.",
    ].join("\n");
    return { data: catalog, text };
  },
};

export default help;

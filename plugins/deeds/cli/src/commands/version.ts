import type { Command } from "../contract.ts";
import pkg from "../../package.json" with { type: "json" };

const version: Command = {
  name: "version",
  pure: true,
  summary: "Print the deeds version.",
  run() {
    return { data: { version: pkg.version }, text: pkg.version };
  },
};

export default version;

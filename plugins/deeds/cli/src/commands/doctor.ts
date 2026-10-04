import { existsSync } from "node:fs";
import type { Command } from "../contract.ts";

/**
 * Not pure: it looks at the filesystem. It therefore runs under the OS network denial like every other
 * command, and on a host with no usable sandbox it refuses unless `--allow-unsandboxed` is passed.
 */
const doctor: Command = {
  name: "doctor",
  summary: "Report how the no-network guarantee is enforced on this host.",
  run(ctx) {
    const sandboxExec = existsSync("/usr/bin/sandbox-exec");
    const data = {
      platform: process.platform,
      sandboxExecPresent: sandboxExec,
      offlineEnforcement: ctx.offlineEnforcement,
      // Every non-pure network-none command needs the OS sandbox or the explicit override.
      sandboxRequired: true,
    };
    return {
      data,
      text: [
        `platform:            ${data.platform}`,
        `sandbox-exec:        ${sandboxExec ? "present" : "absent"}`,
        `offline enforcement: ${data.offlineEnforcement}`,
      ].join("\n"),
    };
  },
};

export default doctor;

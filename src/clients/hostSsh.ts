import { execFile } from "node:child_process";
import type { HostSshConfig } from "../config.js";
import { ToolError } from "../errors.js";
import { COMMAND_NAME_RE } from "../hostCommands.js";

const MAX_BUFFER = 1 << 20;

export interface HostRunResult {
  exitCode: number;
  output: string;
}

/**
 * D7: runs a named command on the Proxmox host over SSH. The remote command is only the name; the
 * host's forced command (host/mcp-diag.sh) maps it to a fixed command line. ssh is spawned with an
 * argument array (no shell), ignores the user's ssh config, and never accepts an unknown host key.
 */
export class HostSsh {
  constructor(private readonly cfg: HostSshConfig) {}

  get node(): string {
    return this.cfg.node;
  }

  async run(name: string, timeoutMs: number): Promise<HostRunResult> {
    if (!COMMAND_NAME_RE.test(name)) throw new ToolError(`invalid host command name '${name}'`);
    const c = this.cfg;
    const args = [
      "-F", "/dev/null",
      "-T",
      "-i", c.keyFile,
      "-p", String(c.port),
      "-o", "BatchMode=yes",
      "-o", "IdentitiesOnly=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${c.knownHostsFile}`,
      "-o", "GlobalKnownHostsFile=/dev/null",
      "-o", "ConnectTimeout=10",
      "-o", "ClearAllForwardings=yes",
      "-o", "ControlPath=none",
      `${c.user}@${c.host}`,
      "--",
      name,
    ];
    return new Promise((resolve, reject) => {
      execFile("ssh", args, { timeout: timeoutMs, maxBuffer: MAX_BUFFER, killSignal: "SIGKILL" }, (err, stdout, stderr) => {
        const output = `${stdout}${stderr ? (stdout ? "\n" : "") + stderr : ""}`;
        if (!err) return resolve({ exitCode: 0, output });
        const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
        if (e.killed) return reject(new ToolError(`host command ${name} timed out after ${Math.round(timeoutMs / 1000)}s`));
        if (e.code === "ENOENT") return reject(new ToolError("the ssh client is not installed on the machine running the MCP"));
        if (typeof e.code === "number") return resolve({ exitCode: e.code, output });
        reject(new ToolError(`could not run ssh: ${e.message}`));
      });
    });
  }
}

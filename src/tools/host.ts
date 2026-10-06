import { z } from "zod";
import type { HostSsh } from "../clients/hostSsh.js";
import { ToolError, RefusedError } from "../errors.js";
import type { HostCommands } from "../hostCommands.js";
import { Allowlist } from "../security/allowlist.js";
import { defineTool, type ToolDef } from "./define.js";

const MAX_OUTPUT = 20_000;

const commandSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/)
  .describe("Command name from host_commands_list");

/** Host diagnostics over SSH (D7, R10). Registered only when SSH is configured. */
export function hostTools(ssh: HostSsh, commands: HostCommands, allowedNodes: readonly string[]): ToolDef[] {
  const nodes = new Allowlist("Proxmox node", allowedNodes);

  async function exec(name: string, level: "operate" | "admin"): Promise<string> {
    nodes.assert(ssh.node); // R5
    const spec = await commands.get(name);
    if (spec.level !== level) {
      throw new RefusedError(
        `host command '${name}' is ${spec.level}-level; use ${spec.level === "admin" ? "host_command_admin" : "host_command"}`,
      );
    }
    const { exitCode, output } = await ssh.run(name, spec.timeoutSeconds * 1000);
    const tail = output.length > MAX_OUTPUT ? `…(truncated)…\n${output.slice(-MAX_OUTPUT)}` : output;
    if (exitCode !== 0) throw new ToolError(`host/${name} failed (exit ${exitCode}):\n${tail.trim()}`);
    return `host/${name} (exit 0):\n${tail.trim() || "(no output)"}`;
  }

  return [
    defineTool({
      name: "host_commands_list",
      title: "List host commands",
      description:
        "List the allowlisted diagnostic commands for the Proxmox host (host/commands.yaml, committed version), with the access level each needs. Read-only: nothing is executed.",
      level: "read",
      input: {},
      handler: async () => {
        const file = await commands.load();
        return {
          node: ssh.node,
          note: file.uncommittedChanges ? "commands.yaml has uncommitted changes; only the committed version runs" : undefined,
          commands: Object.entries(file.commands).map(([name, c]) => ({
            name,
            level: c.level,
            description: c.description,
            timeoutSeconds: c.timeoutSeconds,
          })),
        };
      },
    }),
    defineTool({
      name: "host_command",
      title: "Run host diagnostic",
      description:
        "Run one operate-level diagnostic command on the Proxmox host (disks, mounts, network link). See host_commands_list. Nothing from the client is interpolated: the host maps the name to a fixed command.",
      level: "operate",
      input: { command: commandSchema },
      handler: async ({ command }) => exec(command, "operate"),
    }),
    defineTool({
      name: "host_command_admin",
      title: "Run host benchmark",
      description:
        "Run one admin-level command on the Proxmox host that writes to disk, such as disk_speed_test (see host_commands_list). Nothing from the client is interpolated.",
      level: "admin",
      input: { command: commandSchema },
      confirm: { describe: "the command name", expected: ({ command }) => command },
      handler: async ({ command }) => exec(command, "admin"),
    }),
  ];
}

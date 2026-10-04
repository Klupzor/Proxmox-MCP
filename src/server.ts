import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PortainerClient } from "./clients/portainer.js";
import { ProxmoxClient } from "./clients/proxmox.js";
import type { Config } from "./config.js";
import { AuditLog } from "./security/auditLog.js";
import { AppCommands } from "./appCommands.js";
import { StacksRepo } from "./stacks.js";
import { auditTools } from "./tools/audit.js";
import { appCommandTools } from "./tools/appCommands.js";
import { registerTools } from "./tools/define.js";
import { portainerTools } from "./tools/portainer.js";
import { proxmoxTools } from "./tools/proxmox.js";

export interface ServerDeps {
  pve?: ProxmoxClient;
  ptr?: PortainerClient;
}

export function createServer(config: Config, deps: ServerDeps = {}) {
  const pve = deps.pve ?? (config.proxmox ? new ProxmoxClient(config.proxmox, config.timeoutMs) : undefined);
  const ptr = deps.ptr ?? (config.portainer ? new PortainerClient(config.portainer, config.timeoutMs) : undefined);
  const stacks = new StacksRepo(config.stacksDir);

  const server = new McpServer(
    { name: "proxmox-mcp", version: "0.1.0" },
    {
      instructions: [
        `Access level: ${config.accessLevel}.`,
        "Manages a Proxmox VE homelab and its Portainer-managed Docker node (an LXC on Proxmox).",
        "Before any change, take a snapshot of the Docker LXC with pve_snapshot_create when available.",
        "Never pass `confirm` to a destructive tool unless the user explicitly approved that exact action in this conversation.",
      ].join(" "),
    },
  );

  const defs = [
    ...(pve ? proxmoxTools(pve) : []),
    ...(ptr ? portainerTools(ptr, stacks) : []),
    ...(ptr ? appCommandTools(ptr, new AppCommands(config.stacksDir)) : []),
    ...auditTools({ pve, ptr, stacks }),
  ];
  const tools = registerTools(server, defs, config.accessLevel, new AuditLog(config.auditLogPath));
  return { server, tools };
}

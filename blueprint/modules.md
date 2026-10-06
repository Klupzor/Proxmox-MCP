# Modules

Ownership map of `src/`. See [architecture.md](architecture.md) for how the layers relate.

| Module | Owns |
|---|---|
| `index.ts` | Process entry: load config, start the stdio transport. Diagnostics go to stderr only. |
| `server.ts` | Builds the MCP server: constructs clients and assembles the tool set for the configured access level. |
| `config.ts` | Loading and validating `.env`; the file-permission check (D3); https-only URLs (R4). |
| `http.ts` | The only place HTTP happens: TLS verification and custom CA (R4), timeouts, redacted upstream errors. |
| `errors.ts` | Error types. `ToolError` messages are safe to show the client; `RefusedError` marks security refusals. |
| `clients/proxmox.ts` | Proxmox VE API calls and the node/VMID allowlists (R5). Guests are resolved by VMID alone. |
| `clients/portainer.ts` | Portainer API and the Docker API via Portainer's endpoint proxy; the endpoint allowlist (R5). |
| `security/access.ts` | Access-tier ordering (R1) and the exact-confirm check (R2). |
| `security/allowlist.ts` | Generic allowlist used by both clients (R5). |
| `security/redact.ts` | All secret redaction (R3): keys, values, `{name,value}` pairs, compose text. |
| `security/auditLog.ts` | Append-only JSONL audit log (R6). |
| `tools/define.ts` | Tool definition and registration. This is where R1, R2, R3 and R6 are applied uniformly to every tool. Shared input schemas live here too. |
| `appCommands.ts` | Loads and validates `stacks/<stack>/commands.yaml` from the committed git version only (D6, R9). |
| `tools/appCommands.ts` | `app_commands_list` (read) and `app_command` (admin). This is the only caller of `PortainerClient.execInContainer`. |
| `hostCommands.ts` | Loads and validates `host/commands.yaml` from the committed git version only (D7, R9, R10). |
| `clients/hostSsh.ts` | The only place SSH happens: spawns `ssh` without a shell, with a pinned host key, and sends only a command name. |
| `tools/host.ts` | `host_commands_list` (read), `host_command` (operate), `host_command_admin` (admin). Registered only when SSH is configured. |
| `tools/proxmox.ts`, `tools/portainer.ts`, `tools/audit.ts` | Tool definitions per area. Handlers only call clients and audit rules. |
| `audit/serviceRules.ts` | Security rules for one Docker service, normalized from compose or from a running container. |
| `audit/composeRules.ts`, `audit/containerRules.ts` | Normalize compose YAML or `docker inspect` output into service specs. |
| `audit/lxcRules.ts` | Security rules for the Docker-hosting LXC. |
| `stacks.ts` | Read access to `stacks/<app>` (D5), plus detection of the variables a compose file requires. |

Outside `src/`: `host/mcp-diag.sh` is the forced-command wrapper installed on the Proxmox host, and `host/commands.yaml` defines the command names. Their names must match; a test checks it.

New tools are added with `defineTool` in the matching `tools/*.ts` file. Never register directly with the MCP server, because that would bypass the security layer.

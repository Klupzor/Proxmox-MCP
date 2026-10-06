# Architecture

A single Node.js process speaking MCP over **stdio**. It is launched by the MCP client (Claude Code / Claude Desktop) on the operator's machine and makes outbound HTTPS calls to the homelab, plus, only when configured, outbound SSH to the Proxmox host for fixed diagnostics ([D7](decisions.md#d7-host-diagnostics-over-ssh-with-a-forced-command)). It opens no listening sockets (see [decisions D2](decisions.md#d2-local-stdio-transport)).

```text
MCP client (Claude)
   │ stdio (JSON-RPC)
   ▼
Tool layer ── registers only the tools the configured access level allows
   │
   ▼
Security layer
   ├─ access tiers + confirmation   (rules R1, R2)
   ├─ allowlists                    (R5)
   ├─ secret redaction of outputs   (R3)
   └─ append-only audit log         (R6)
   │
   ▼
API clients ── shared HTTPS wrapper: TLS always verified, optional custom CA (R4), timeouts
   ├─ Proxmox VE API   https://<pve>:8006/api2/json   (API token auth)
   ├─ Portainer API    https://<portainer>:9443/api   (access token auth; Docker API via endpoint proxy)
   └─ Proxmox host SSH (optional)  named commands only; key bound to host/mcp-diag.sh   (D7, R10)
```

Audit tools are pure functions over data fetched by the clients (or read from `stacks/` in this repo); they never mutate anything.

Configuration (endpoints, tokens, access level, allowlists, CA path) is loaded once at startup from a local, gitignored `.env` file and validated; the server refuses to start on invalid or unsafe configuration.

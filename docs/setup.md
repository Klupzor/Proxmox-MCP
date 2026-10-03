# Setup

Operator runbook: create least-privilege credentials, configure the server, connect it to Claude, and harden the Docker LXC. The security rules referenced here are in [`blueprint/rules.md`](../blueprint/rules.md).

## 1. Build

```bash
npm install
npm run build
npm test
```

## 2. Proxmox API token (R8)

Create a dedicated user and a privilege-separated token. With `--privsep 1` the token's effective rights are the **intersection** of the user's and the token's ACLs, so grant both.

On a Proxmox node shell:

```bash
pveum user add mcp@pve --comment "Proxmox MCP"
pveum user token add mcp@pve mcp --privsep 1      # copy the secret shown once
```

**`read` level** — the built-in `PVEAuditor` role on `/`:

```bash
pveum acl modify / --users mcp@pve --roles PVEAuditor
pveum acl modify / --tokens 'mcp@pve!mcp' --roles PVEAuditor
```

**`operate` level** — add power and snapshot rights, scoped to the guests the MCP may touch (here the Docker LXC, VMID 105):

```bash
pveum role add MCPOperator --privs "VM.Audit,VM.PowerMgmt,VM.Snapshot"
pveum acl modify /vms/105 --users mcp@pve --roles MCPOperator
pveum acl modify /vms/105 --tokens 'mcp@pve!mcp' --roles MCPOperator
```

**`admin` level** — additionally allow snapshot rollback/delete:

```bash
pveum role add MCPAdmin --privs "VM.Audit,VM.PowerMgmt,VM.Snapshot,VM.Snapshot.Rollback"
pveum acl modify /vms/105 --users mcp@pve --roles MCPAdmin
pveum acl modify /vms/105 --tokens 'mcp@pve!mcp' --roles MCPAdmin
```

Also set `PROXMOX_ALLOWED_VMIDS=105` (R5), so a token mistake still can't reach other guests.

**TLS (R4):** copy `/etc/pve/pve-root-ca.pem` from the node to `certs/pve-root-ca.pem` in this repo (gitignored) and set `PROXMOX_CA_FILE`. The URL host must match the node certificate's name (e.g. `pve.lan`).

## 3. Portainer access token (R8)

1. In Portainer, create a dedicated user `mcp` (not an administrator).
2. Under *Environments → \<your Docker LXC\> → Manage access*, give it access to that environment only. On Business Edition, use the **Read-only user** role for `read` and **Operator** for `operate`. On Community Edition there are no granular roles, so the MCP's access level and `PORTAINER_ALLOWED_ENDPOINTS` are what limit it.
3. Make sure your existing stacks are visible to that user: give the stack's access control to the user or its team, or make it public.
4. Log in as `mcp`, go to *My account → Access tokens → Add access token*, and copy the `ptr_…` token.

**TLS (R4):** if Portainer uses its self-signed certificate, save it as a trusted cert and set `PORTAINER_CA_FILE`:

```bash
openssl s_client -connect portainer.lan:9443 -servername portainer.lan </dev/null 2>/dev/null | openssl x509 > certs/portainer.pem
```

Verify the fingerprint against Portainer's own UI before trusting it. A certificate from your internal CA or reverse proxy is better still.

## 4. Configure

```bash
cp .env.example .env
chmod 600 .env
```

Fill in `.env`. Start at `MCP_ACCESS_LEVEL=read`, and raise it only for a session that needs it. Every `operate`/`admin` call is appended to `~/.local/state/proxmox-mcp/audit.jsonl` (R6).

## 5. Connect to Claude

- **Claude Code:** the repo's `.mcp.json` registers `proxmox-homelab`. Open Claude Code in this directory and approve the server when prompted.
- **Claude Desktop:** add to `claude_desktop_config.json`:

  ```json
  { "mcpServers": { "proxmox-homelab": { "command": "node", "args": ["/absolute/path/to/Proxmox-MCP/dist/index.js"] } } }
  ```

  Don't put tokens in the client config; the server reads `.env` itself (D3).

To debug, run `npx @modelcontextprotocol/inspector node dist/index.js`.

## 6. Docker LXC hardening checklist

`audit_docker_lxc` checks most of these automatically:

- **Unprivileged** container (`unprivileged: 1`) with `features: nesting=1,keyctl=1`. A privileged Docker LXC means a container escape gives root on the Proxmox host.
- No raw `lxc.*` overrides that loosen confinement (`apparmor.profile: unconfined`, `cgroup2.devices.allow: a`, `cap.drop:` empty).
- `firewall=1` on the LXC's NICs, and the guest firewall enabled. Allow only the app ports, the Portainer port (9443 or the agent's 9001) from your admin network, and SSH from your admin network. Docker rewrites iptables inside the LXC, so `ufw` in the LXC does **not** protect published ports. The Proxmox firewall on the host does.
- Don't expose Portainer or the Proxmox UI to the internet. Reach them over a VPN (WireGuard or Tailscale).
- `onboot: 1`, `protection: 1`, and a scheduled vzdump/PBS backup job for the LXC.
- Bind-mount only dedicated data directories, never `/etc/pve`, `/root`, or `/`.

## 7. Bringing your apps into `stacks/`

For each Portainer stack:

1. `ptr_get_stack_file` → save as `stacks/<stack-name>/compose.yaml`. Inline secrets come back redacted, so replace each one with a `${VAR}` reference.
2. Put the real values in `stacks/<app>/.env` (`chmod 600`, gitignored), and placeholders in `stacks/<app>/.env.example`.
3. Run `audit_compose app=<app>` and fix the findings. Then `stack_drift app=<app>` shows what will change.
4. Snapshot the Docker LXC (`pve_snapshot_create`), then deploy with `ptr_stack_deploy_from_repo` (admin level).

# Setup

Operator runbook: create least-privilege credentials, configure the server, connect it to Claude, and harden the Docker LXC. The security rules referenced here are in [`blueprint/rules.md`](../blueprint/rules.md).

## 1. Build

```bash
npm install
npm run build
npm test
```

## 2. Proxmox API token (R8)

All commands in this section run in the **Proxmox shell** (web UI → click your node → **Shell**), not on your Mac. Run them one line at a time.

### 2.1 Find the VMID of your Docker LXC

```
pct list
```

Note the number in the `VMID` column for the container that runs Docker/Portainer. Below it is written as `<VMID>`. Replace it with your number, e.g. `100`.

### 2.2 Create the user and token (do this now)

```
pveum user add mcp@pve --comment "Proxmox MCP"
```
```
pveum user token add mcp@pve mcp --privsep 1
```

The second command prints a table. Copy its `value` field: that is `PROXMOX_TOKEN_SECRET`, and it is shown only once. The token ID is `mcp@pve!mcp`.

### 2.3 Grant read-only rights (do this now)

With `--privsep 1`, the token only gets rights that **both** the user and the token have, so every grant is given twice:

```
pveum acl modify / --users mcp@pve --roles PVEAuditor
```
```
pveum acl modify / --tokens 'mcp@pve!mcp' --roles PVEAuditor
```

### 2.4 Verify

```
pveum acl list
```

You should see exactly two `mcp@pve` lines, both `/` with role `PVEAuditor`. That is everything needed for `MCP_ACCESS_LEVEL=read`. Set `PROXMOX_ALLOWED_VMIDS=<VMID>` in `.env` (R5).

### 2.5 Later only: extra rights for `operate` / `admin`

> **Skip this section during initial setup.** Only run it when you deliberately raise `MCP_ACCESS_LEVEL`. These rights are scoped to `/vms/<VMID>`, so double-check the number first.

For `operate` (start/stop/reboot, create snapshots):

```
pveum role add MCPOperator --privs "VM.Audit,VM.PowerMgmt,VM.Snapshot"
```
```
pveum acl modify /vms/<VMID> --users mcp@pve --roles MCPOperator
```
```
pveum acl modify /vms/<VMID> --tokens 'mcp@pve!mcp' --roles MCPOperator
```

For `admin` (also snapshot rollback/delete), use this role instead of `MCPOperator`:

```
pveum role add MCPAdmin --privs "VM.Audit,VM.PowerMgmt,VM.Snapshot,VM.Snapshot.Rollback"
```
```
pveum acl modify /vms/<VMID> --users mcp@pve --roles MCPAdmin
```
```
pveum acl modify /vms/<VMID> --tokens 'mcp@pve!mcp' --roles MCPAdmin
```

### 2.6 Undo a grant

If a grant went to the wrong path or role, delete it with the same arguments, using `delete` instead of `modify`. Then re-check with `pveum acl list`:

```
pveum acl delete /vms/<VMID> --users mcp@pve --roles MCPAdmin
```
```
pveum acl delete /vms/<VMID> --tokens 'mcp@pve!mcp' --roles MCPAdmin
```

### 2.7 TLS certificate (R4)

Copy the Proxmox CA into `certs/` (gitignored) in this repo. SSH to Proxmox is often blocked, so the simplest way is copy and paste:

1. In the **Proxmox shell**, run `cat /etc/pve/pve-root-ca.pem` and select everything from `-----BEGIN CERTIFICATE-----` to `-----END CERTIFICATE-----`.
2. On your Mac, in this repo:

   ```bash
   mkdir -p certs && pbpaste > certs/pve-root-ca.pem
   ```

3. Verify. You should get a `401` (not logged in), not a certificate error:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' --cacert certs/pve-root-ca.pem https://<proxmox-ip>:8006/api2/json/version
   ```

Set `PROXMOX_CA_FILE=certs/pve-root-ca.pem`. Use the same address in `PROXMOX_URL` that you use in the browser for the Proxmox UI.

## 3. Portainer access token (R8)

1. In Portainer, create a dedicated user `mcp` (not an administrator).
2. Under *Environments → \<your Docker LXC\> → Manage access*, give it access to that environment only. On Business Edition, use the **Read-only user** role for `read` and **Operator** for `operate`. On Community Edition there are no granular roles, so the MCP's access level and `PORTAINER_ALLOWED_ENDPOINTS` are what limit it.
3. Make sure your existing stacks are visible to that user: give the stack's access control to the user or its team, or make it public.
4. Log in as `mcp`, go to *My account → Access tokens → Add access token*, and copy the `ptr_…` token.

**TLS (R4):** Portainer's built-in self-signed certificate is issued only for `localhost`. Hostname verification against its IP therefore fails, even if you trust that certificate. Instead, give Portainer a certificate for its real address, signed by a private CA that lives only on your Mac.

1. Create the CA and the Portainer certificate in `certs/` (gitignored). Replace `192.168.1.27` with Portainer's address. Use the CA config below for `ca.cnf`, and the server config for `srv.cnf`:

   ```ini
   # ca.cnf
   [req]
   distinguished_name = dn
   prompt = no
   x509_extensions = v3_ca
   [dn]
   CN = Homelab Private CA
   [v3_ca]
   basicConstraints = critical, CA:TRUE, pathlen:0
   keyUsage = critical, keyCertSign, cRLSign
   subjectKeyIdentifier = hash
   ```

   ```ini
   # srv.cnf
   [req]
   distinguished_name = dn
   prompt = no
   [dn]
   CN = 192.168.1.27
   [v3_srv]
   basicConstraints = critical, CA:FALSE
   keyUsage = critical, digitalSignature, keyEncipherment
   extendedKeyUsage = serverAuth
   subjectAltName = IP:192.168.1.27, DNS:localhost
   ```

   ```bash
   cd certs && umask 077
   openssl genrsa -out homelab-ca.key 4096
   openssl req -x509 -new -key homelab-ca.key -sha256 -days 3650 -config ca.cnf -out homelab-ca.pem
   openssl genrsa -out portainer-server.key 2048
   openssl req -new -key portainer-server.key -config srv.cnf -out portainer.csr
   openssl x509 -req -in portainer.csr -CA homelab-ca.pem -CAkey homelab-ca.key -CAcreateserial -days 825 -sha256 -extfile srv.cnf -extensions v3_srv -out portainer-server.crt
   ```

2. In Portainer, go to *Administration → Settings → SSL certificate*. Upload `portainer-server.crt` and `portainer-server.key`, apply, then **restart the Portainer container** so it serves the new certificate.
3. Set `PORTAINER_CA_FILE=certs/homelab-ca.pem`, then verify (it should print `200`):

   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' --cacert certs/homelab-ca.pem https://192.168.1.27:9443/api/status
   ```

The certificate is valid for 825 days. Re-issue it with the last `openssl x509` command before it expires. Keep `homelab-ca.key` private: anything it signs is trusted by the MCP.

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

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `No route to host` / `Couldn't connect` from the terminal, although Safari reaches the host | macOS Local Network privacy. Enable the app (Claude, iTerm, VS Code, …) in *System Settings → Privacy & Security → Local Network*, then fully quit and reopen it. |
| `SSL certificate problem: unable to get local issuer certificate` | The server isn't presenting a certificate signed by the configured CA. For Portainer: upload the certificate and restart the container (section 3). |
| Hostname or altname mismatch | The certificate doesn't list the address in the URL. Re-issue it with the right `subjectAltName`. |
| `HTTP 401/403` from the MCP | Wrong token, or a missing ACL. Check with `pveum acl list` (Proxmox), or the user's environment and stack access (Portainer). |
| New MCP code isn't picked up | Type `/mcp` in the Claude Code session and click **Reconnect** next to `proxmox-homelab`. No need to quit Claude. Changes to a stack's `commands.yaml` need no reload at all, only a commit (R9). |
| MCP shows "Connection closed" at startup | The server exited: `.env` is missing, has invalid values, or is not `chmod 600`. Run `node dist/index.js` to see the error. |

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

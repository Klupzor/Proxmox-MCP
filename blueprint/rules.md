# Rules

Security rules this project must uphold. Violating any of these is a bug even if the code "works".

## R1: Read-only by default

The access level defaults to `read`. Tools that change infrastructure are not registered at all — not merely refused — unless the configured access level is `operate` (lifecycle actions) or `admin` (destructive actions).

## R2: Destructive actions require exact confirmation

Every `admin`-level tool requires a `confirm` argument whose value exactly equals the identifier of the target (VMID, snapshot name, stack name, etc., as specified by the tool). A mismatch is refused before any API call is made.

## R3: No secrets in tool output

Tool output never contains secret values. Environment variables, stack env, and configuration fields whose key looks secret (password, token, secret, key, credential, …) or whose value looks like a credential are replaced with a redaction marker. API tokens used by the server itself never appear in output, errors, or logs.

## R4: TLS is always verified

Certificate verification is never disabled. Self-signed homelab certificates are supported only by configuring a trusted CA certificate file.

## R5: Allowlists bound the blast radius

When allowlists are configured (Proxmox nodes, Proxmox VMIDs, Portainer endpoint IDs), every tool call that targets a resource outside them is refused. Listing tools filter their output to allowlisted resources.

## R6: Mutations are audit-logged

Every call to an `operate` or `admin` tool — successful, failed, or refused — is appended to a local JSONL audit log with timestamp, tool, target, and outcome. Arguments are redacted per R3 before logging.

## R7: Secrets are never committed

`.env` and `stacks/*/.env` are gitignored. Each such file has a committed `.env.example` with placeholder values only.

## R8: Least-privilege credentials

API tokens are scoped to the minimum the configured access level needs. The recommended Proxmox roles and Portainer permissions per level are in [`docs/setup.md`](../docs/setup.md).

## R9: Only committed command definitions run

In-container commands (D6) execute only as defined in the version of `stacks/<stack>/commands.yaml` committed to git. Uncommitted edits are ignored. Adding or changing a command therefore requires a reviewed commit, which takes the place of a server restart as the human checkpoint.

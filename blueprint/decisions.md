# Decisions

## D1: TypeScript on Node with the official MCP SDK

The server is written in TypeScript using `@modelcontextprotocol/sdk`, with `zod` for input validation. Chosen for SDK maturity and strong typing of tool schemas.

## D2: Local stdio transport

The server runs on the operator's machine, launched by the MCP client over stdio, and reaches the homelab over LAN/VPN. No HTTP listener is exposed, which removes an entire class of remote-access risk. Revisit only if the server must run inside the homelab.

## D3: Credentials from a gitignored `.env` file

Tokens and endpoints are read from a local `.env` file (mode `600`), not from the MCP client config. The server refuses to start if the file is readable by group or others.

## D4: Tiered access levels

Three levels — `read` (default), `operate` (start/stop/restart/redeploy/snapshot), `admin` (hard stop, rollback, delete, deploy, prune). Tools above the configured level are not registered. See [R1](rules.md#r1-read-only-by-default) and [R2](rules.md#r2-destructive-actions-require-exact-confirmation).

## D5: App stacks are versioned in this repo

Each Docker app's compose definition lives in `stacks/<app>/compose.yaml`, with secrets in a gitignored `stacks/<app>/.env`. The repo is the intended source of truth; Portainer's deployed state is compared against it (drift detection) and updated from it.

## D6: No generic container exec — only allowlisted app commands

The MCP never exposes arbitrary `docker exec`, because it is root-equivalent on the Docker host. When an app needs in-container maintenance, the `admin` tool `app_command` runs a fixed allowlist of commands defined per stack in `stacks/<stack>/commands.yaml`. Client input selects a command by name; it is never interpolated into one. Credentials such commands need come from the container's own environment. The definitions live in data, not code, so new commands need a commit ([R9](rules.md#r9-only-committed-command-definitions-run)) rather than a server restart.

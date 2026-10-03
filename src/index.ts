#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./config.js";
import { createServer } from "./server.js";

// stdout carries the MCP protocol; all diagnostics go to stderr.
async function main() {
  const config = loadConfig();
  const { server, tools } = createServer(config);
  await server.connect(new StdioServerTransport());
  console.error(
    `proxmox-mcp ready: access=${config.accessLevel}, proxmox=${config.proxmox ? "on" : "off"}, portainer=${config.portainer ? "on" : "off"}, tools=${tools.length}`,
  );
}

main().catch((err) => {
  console.error(err instanceof ConfigError ? `proxmox-mcp: ${err.message}` : `proxmox-mcp: fatal: ${(err as Error).message}`);
  process.exit(1);
});

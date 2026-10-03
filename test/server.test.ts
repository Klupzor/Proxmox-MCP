import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import type { PortainerClient } from "../src/clients/portainer.js";
import type { ProxmoxClient } from "../src/clients/proxmox.js";
import type { AccessLevel, Config } from "../src/config.js";
import { createServer } from "../src/server.js";

function setup(level: AccessLevel) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmcp-"));
  const config: Config = {
    accessLevel: level,
    proxmox: { url: "https://pve.test:8006", tokenId: "a@pve!b", tokenSecret: "x", allowedNodes: [], allowedVmids: [] },
    portainer: { url: "https://ptr.test:9443", apiKey: "k", allowedEndpoints: [] },
    timeoutMs: 1000,
    auditLogPath: path.join(dir, "audit.jsonl"),
    stacksDir: path.join(__dirname, "fixtures/stacks"),
  };
  const pve = {
    guestAction: vi.fn(async () => ({ node: "pve", upid: "UPID:pve:1" })),
    listGuests: vi.fn(async () => []),
  } as unknown as ProxmoxClient;
  const ptr = {
    getStack: vi.fn(async () => ({ Id: 7, Name: "webapp", EndpointId: 2, Type: 2, Status: 1, Env: [{ name: "DB_PASSWORD", value: "hunter2" }] })),
    listStacks: vi.fn(async () => [{ Id: 7, Name: "webapp", EndpointId: 2, Type: 2, Status: 1, Env: [{ name: "DB_PASSWORD", value: "hunter2" }] }]),
    findStackByName: vi.fn(async () => ({ Id: 7, Name: "webapp", EndpointId: 2, Type: 2, Status: 1, Env: [] })),
    getStackFile: vi.fn(async () => "services:\n  app:\n    environment:\n      DB_PASSWORD: hunter2\n"),
  } as unknown as PortainerClient;
  const { server } = createServer(config, { pve, ptr });
  return { server, pve, ptr, auditLogPath: config.auditLogPath };
}

async function connect(level: AccessLevel) {
  const ctx = setup(level);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([ctx.server.connect(serverT), client.connect(clientT)]);
  return { ...ctx, client };
}

const text = (r: any) => r.content[0].text as string;

describe("access tiers (R1)", () => {
  it("exposes only read tools at read level", async () => {
    const { client } = await connect("read");
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain("pve_list_guests");
    expect(names).toContain("audit_compose");
    expect(names).not.toContain("pve_guest_start");
    expect(names).not.toContain("ptr_stack_delete");
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("adds lifecycle tools at operate and destructive tools only at admin", async () => {
    const operate = (await (await connect("operate")).client.listTools()).tools.map((t) => t.name);
    expect(operate).toContain("pve_guest_start");
    expect(operate).toContain("ptr_stack_redeploy");
    expect(operate).not.toContain("pve_guest_stop");

    const admin = (await (await connect("admin")).client.listTools()).tools;
    const stop = admin.find((t) => t.name === "pve_guest_stop");
    expect(stop?.annotations?.destructiveHint).toBe(true);
    expect(stop?.inputSchema.required).toContain("confirm");
  });
});

describe("confirmation (R2) and audit log (R6)", () => {
  it("refuses a mismatched confirm without calling the API", async () => {
    const { client, pve, auditLogPath } = await connect("admin");
    const res = await client.callTool({ name: "pve_guest_stop", arguments: { vmid: 105, confirm: "106" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/confirmation mismatch/);
    expect(pve.guestAction).not.toHaveBeenCalled();
    const entries = fs.readFileSync(auditLogPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(entries).toEqual([expect.objectContaining({ tool: "pve_guest_stop", outcome: "refused" })]);
  });

  it("runs and logs a confirmed destructive call", async () => {
    const { client, pve, auditLogPath } = await connect("admin");
    const res = await client.callTool({ name: "pve_guest_stop", arguments: { vmid: 105, confirm: "105" } });
    expect(res.isError).toBeFalsy();
    expect(pve.guestAction).toHaveBeenCalledWith(105, "stop");
    const outcomes = fs.readFileSync(auditLogPath, "utf8").trim().split("\n").map((l) => JSON.parse(l).outcome);
    expect(outcomes).toEqual(["started", "ok"]);
    expect(fs.statSync(auditLogPath).mode & 0o777).toBe(0o600);
  });

  it("does not write the audit log for read tools", async () => {
    const { client, auditLogPath } = await connect("read");
    await client.callTool({ name: "pve_list_guests", arguments: {} });
    expect(fs.existsSync(auditLogPath)).toBe(false);
  });
});

describe("secret redaction (R3)", () => {
  it("never returns stack env values or inline compose secrets", async () => {
    const { client } = await connect("read");
    const list = text(await client.callTool({ name: "ptr_list_stacks", arguments: {} }));
    const file = text(await client.callTool({ name: "ptr_get_stack_file", arguments: { stack: "webapp" } }));
    expect(list).toContain("DB_PASSWORD");
    expect(list + file).not.toContain("hunter2");
  });

  it("audits a repo stack via the tool", async () => {
    const { client } = await connect("read");
    const res = JSON.parse(text(await client.callTool({ name: "audit_compose", arguments: { app: "webapp" } })));
    expect(res.summary.high).toBeGreaterThan(0);
    expect(JSON.stringify(res)).not.toContain("hunter2-plaintext");
  });
});

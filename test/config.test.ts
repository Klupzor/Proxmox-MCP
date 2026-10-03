import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertPrivateFile, ConfigError, parseConfig } from "../src/config.js";

const portainer = { PORTAINER_URL: "https://portainer.lan:9443/", PORTAINER_API_KEY: "ptr_x" };
const proxmox = {
  PROXMOX_URL: "https://pve.lan:8006",
  PROXMOX_TOKEN_ID: "mcp@pve!readonly",
  PROXMOX_TOKEN_SECRET: "uuid",
};

describe("parseConfig", () => {
  it("defaults to read access", () => {
    const cfg = parseConfig({ ...portainer });
    expect(cfg.accessLevel).toBe("read");
    expect(cfg.portainer?.url).toBe("https://portainer.lan:9443");
    expect(cfg.proxmox).toBeUndefined();
  });

  it("rejects plain http (R4)", () => {
    expect(() => parseConfig({ ...portainer, PORTAINER_URL: "http://portainer.lan:9000" })).toThrow(/https/);
  });

  it("rejects partial service config", () => {
    expect(() => parseConfig({ ...portainer, PROXMOX_URL: proxmox.PROXMOX_URL })).toThrow(/partially configured/);
  });

  it("requires at least one service", () => {
    expect(() => parseConfig({})).toThrow(ConfigError);
  });

  it("validates token id and allowlists", () => {
    expect(() => parseConfig({ ...proxmox, PROXMOX_TOKEN_ID: "root" })).toThrow(/user@realm!tokenname/);
    expect(() => parseConfig({ ...proxmox, PROXMOX_ALLOWED_VMIDS: "105,abc" })).toThrow(/not a VMID/);
    const cfg = parseConfig({ ...proxmox, PROXMOX_ALLOWED_VMIDS: "105, 106", MCP_ACCESS_LEVEL: "operate" });
    expect(cfg.proxmox?.allowedVmids).toEqual([105, 106]);
    expect(cfg.accessLevel).toBe("operate");
  });

  it("rejects unknown access levels", () => {
    expect(() => parseConfig({ ...portainer, MCP_ACCESS_LEVEL: "root" })).toThrow(ConfigError);
  });
});

describe("assertPrivateFile (D3)", () => {
  it("refuses group/world-readable files", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pmcp-")), ".env");
    fs.writeFileSync(file, "X=1");
    fs.chmodSync(file, 0o644);
    expect(() => assertPrivateFile(file)).toThrow(/chmod 600/);
    fs.chmodSync(file, 0o600);
    expect(() => assertPrivateFile(file)).not.toThrow();
  });
});

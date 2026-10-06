import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { HostSsh } from "../src/clients/hostSsh.js";
import { parseConfig, type AccessLevel, type Config } from "../src/config.js";
import { HostCommands } from "../src/hostCommands.js";
import { createServer } from "../src/server.js";

const REPO = path.join(__dirname, "..");
const text = (r: any) => r.content[0].text as string;

const DEMO = `commands:
  lsblk:
    description: Block devices.
    level: operate
  disk_speed_test:
    description: Writes a temp file.
    level: admin
    timeoutSeconds: 300
`;

function gitHostDir(yaml: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pmcp-host-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  fs.writeFileSync(path.join(root, "commands.yaml"), yaml);
  git("add", ".");
  git("commit", "-q", "-m", "host commands");
  return root;
}

describe("HostCommands (R9)", () => {
  it("loads the committed commands.yaml with levels and default timeouts", async () => {
    const file = await new HostCommands(gitHostDir(DEMO)).load();
    expect(Object.keys(file.commands)).toEqual(["lsblk", "disk_speed_test"]);
    expect(file.commands.lsblk!.timeoutSeconds).toBe(60);
    expect(file.commands.disk_speed_test!.level).toBe("admin");
    expect(file.uncommittedChanges).toBe(false);
  });

  it("ignores uncommitted edits", async () => {
    const dir = gitHostDir(DEMO);
    fs.appendFileSync(path.join(dir, "commands.yaml"), "  evil:\n    description: x\n    level: operate\n");
    const cmds = new HostCommands(dir);
    expect((await cmds.load()).uncommittedChanges).toBe(true);
    await expect(cmds.get("evil")).rejects.toThrow(/unknown host command 'evil'/);
    await expect(cmds.get("constructor")).rejects.toThrow(/unknown host command/);
  });

  it("refuses an uncommitted file and an invalid one", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "pmcp-host-"));
    execFileSync("git", ["-C", empty, "init", "-q"]);
    fs.writeFileSync(path.join(empty, "commands.yaml"), DEMO);
    await expect(new HostCommands(empty).load()).rejects.toThrow(/committed to git/);
    await expect(new HostCommands(gitHostDir("commands:\n  x:\n    description: d\n    level: root\n")).load()).rejects.toThrow(/invalid/);
  });
});

describe("repo host definitions", () => {
  const defined = Object.keys(parse(fs.readFileSync(path.join(REPO, "host", "commands.yaml"), "utf8")).commands).sort();

  it("host/commands.yaml names equal the wrapper's case names", () => {
    const wrapper = fs.readFileSync(path.join(REPO, "host", "mcp-diag.sh"), "utf8");
    const caseBody = wrapper.slice(wrapper.indexOf('case "${SSH_ORIGINAL_COMMAND'));
    const names = [...caseBody.matchAll(/^\s{2}([a-z][a-z0-9_]*)\)/gm)].map((m) => m[1]!).sort();
    expect(names).toEqual(defined);
  });

  it("the wrapper refuses unknown names, injections, empty input and arguments", () => {
    const wrapper = path.join(REPO, "host", "mcp-diag.sh");
    for (const cmd of ["rm -rf /", "lsblk; id", "lsblk && id", "$(id)", "bogus", "LSBLK", "", "lsblk "]) {
      const r = spawnSync("sh", [wrapper], { env: { SSH_ORIGINAL_COMMAND: cmd, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
      expect(r.status, `command '${cmd}'`).toBe(2);
      expect(r.stderr).toMatch(/not allowed/);
      expect(r.stdout).toBe("");
    }
    const withArgs = spawnSync("sh", [wrapper, "x"], { env: { SSH_ORIGINAL_COMMAND: "lsblk", PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    expect(withArgs.status).toBe(2);
    expect(withArgs.stderr).toMatch(/arguments are not accepted/);
  });
});

describe("SSH config (D3, D7)", () => {
  function files(mode: number) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmcp-ssh-"));
    fs.writeFileSync(path.join(dir, "key"), "KEY");
    fs.chmodSync(path.join(dir, "key"), mode);
    fs.writeFileSync(path.join(dir, "known_hosts"), "");
    return dir;
  }
  const base = { PORTAINER_URL: "https://ptr.test:9443", PORTAINER_API_KEY: "k" };
  const ssh = { PROXMOX_SSH_HOST: "192.168.1.28", PROXMOX_SSH_NODE: "proxmox", PROXMOX_SSH_KEY_FILE: "key", PROXMOX_SSH_KNOWN_HOSTS_FILE: "known_hosts" };

  it("is off unless configured", () => {
    expect(parseConfig(base).ssh).toBeUndefined();
  });

  it("parses a full configuration with defaults", () => {
    const dir = files(0o600);
    const cfg = parseConfig({ ...base, ...ssh }, dir).ssh!;
    expect(cfg).toMatchObject({ host: "192.168.1.28", port: 22, user: "root", node: "proxmox" });
    expect(cfg.keyFile).toBe(path.join(dir, "key"));
    expect(cfg.hostDir).toBe(path.join(dir, "host"));
  });

  it("rejects partial config, a key readable by others, and option-like hosts", () => {
    const dir = files(0o600);
    expect(() => parseConfig({ ...base, PROXMOX_SSH_HOST: "192.168.1.28" }, dir)).toThrow(/partially configured/);
    expect(() => parseConfig({ ...base, ...ssh }, files(0o644))).toThrow(/accessible by group\/others/);
    expect(() => parseConfig({ ...base, ...ssh, PROXMOX_SSH_HOST: "-oProxyCommand=id" }, dir)).toThrow(/hostname/);
    expect(() => parseConfig({ ...base, ...ssh, PROXMOX_SSH_KEY_FILE: "missing" }, dir)).toThrow(/cannot read SSH key/);
  });
});

describe("HostSsh", () => {
  function fakeSsh(script: string): string {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "pmcp-bin-"));
    fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return bin;
  }
  const cfg = { host: "192.168.1.28", port: 22, user: "root", node: "proxmox", keyFile: "/k/key", knownHostsFile: "/k/kh", hostDir: "/h" };

  it("spawns ssh with strict options, ignoring user config, and sends only the name", async () => {
    const bin = fakeSsh('printf "%s\\n" "$@"');
    const prev = process.env.PATH;
    process.env.PATH = `${bin}:${prev}`;
    try {
      const { exitCode, output } = await new HostSsh(cfg).run("lsblk", 5000);
      const args = output.trim().split("\n");
      expect(exitCode).toBe(0);
      expect(args.slice(0, 2)).toEqual(["-F", "/dev/null"]);
      expect(args).toContain("StrictHostKeyChecking=yes");
      expect(args).toContain("BatchMode=yes");
      expect(args).toContain("UserKnownHostsFile=/k/kh");
      expect(args.slice(-3)).toEqual(["root@192.168.1.28", "--", "lsblk"]);
    } finally {
      process.env.PATH = prev;
    }
  });

  it("returns the remote exit code and rejects invalid names before spawning", async () => {
    const bin = fakeSsh('echo "denied" >&2; exit 2');
    const prev = process.env.PATH;
    process.env.PATH = `${bin}:${prev}`;
    try {
      const host = new HostSsh(cfg);
      expect(await host.run("lsblk", 5000)).toEqual({ exitCode: 2, output: "denied\n" });
      await expect(host.run("lsblk; id", 5000)).rejects.toThrow(/invalid host command name/);
    } finally {
      process.env.PATH = prev;
    }
  });
});

describe("host tools through the server (R1, R2, R5, R6)", () => {
  async function connect(level: AccessLevel, opts: { ssh?: boolean; allowedNodes?: string[] } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmcp-"));
    const hostDir = gitHostDir(DEMO);
    const config: Config = {
      accessLevel: level,
      proxmox: { url: "https://pve.test:8006", tokenId: "a@pve!b", tokenSecret: "x", allowedNodes: opts.allowedNodes ?? [], allowedVmids: [] },
      ssh: opts.ssh === false ? undefined : { host: "h", port: 22, user: "root", node: "proxmox", keyFile: "k", knownHostsFile: "kh", hostDir },
      timeoutMs: 1000,
      auditLogPath: path.join(dir, "audit.jsonl"),
      stacksDir: path.join(__dirname, "fixtures/stacks"),
    };
    const hostSsh = { node: "proxmox", run: vi.fn(async () => ({ exitCode: 0, output: "NAME ROTA TRAN\nsdb 1 usb\n" })) } as unknown as HostSsh;
    const { server } = createServer(config, { pve: {} as never, hostSsh });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    const names = async () => (await client.listTools()).tools.map((t) => t.name);
    return { client, hostSsh, names, auditLogPath: config.auditLogPath };
  }

  it("registers no host tool when SSH is not configured", async () => {
    const { names } = await connect("admin", { ssh: false });
    expect((await names()).filter((n) => n.startsWith("host_"))).toEqual([]);
  });

  it("exposes tools by tier: list at read, command at operate, admin command only at admin", async () => {
    expect((await (await connect("read")).names()).filter((n) => n.startsWith("host_"))).toEqual(["host_commands_list"]);
    expect((await (await connect("operate")).names()).filter((n) => n.startsWith("host_"))).toEqual(["host_commands_list", "host_command"]);
    const admin = await connect("admin");
    expect((await admin.names()).filter((n) => n.startsWith("host_"))).toEqual(["host_commands_list", "host_command", "host_command_admin"]);
    const tool = (await admin.client.listTools()).tools.find((t) => t.name === "host_command_admin");
    expect(tool?.annotations?.destructiveHint).toBe(true);
    expect(tool?.inputSchema.required).toContain("confirm");
  });

  it("lists the committed commands with their levels", async () => {
    const { client } = await connect("read");
    const res = JSON.parse(text(await client.callTool({ name: "host_commands_list", arguments: {} })));
    expect(res.commands.map((c: any) => [c.name, c.level])).toEqual([["lsblk", "operate"], ["disk_speed_test", "admin"]]);
  });

  it("runs an operate command by name with the committed timeout, and logs it", async () => {
    const { client, hostSsh, auditLogPath } = await connect("operate");
    const res = await client.callTool({ name: "host_command", arguments: { command: "lsblk" } });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain("sdb 1 usb");
    expect(hostSsh.run).toHaveBeenCalledWith("lsblk", 60000);
    const outcomes = fs.readFileSync(auditLogPath, "utf8").trim().split("\n").map((l) => JSON.parse(l).outcome);
    expect(outcomes).toEqual(["started", "ok"]);
  });

  it("refuses unknown names, and a command used through the wrong tier, before any SSH call", async () => {
    const { client, hostSsh, auditLogPath } = await connect("admin");
    const unknown = await client.callTool({ name: "host_command", arguments: { command: "rm_rf" } });
    expect(text(unknown)).toMatch(/unknown host command/);
    const wrongTier = await client.callTool({ name: "host_command", arguments: { command: "disk_speed_test" } });
    expect(text(wrongTier)).toMatch(/admin-level; use host_command_admin/);
    const wrongTier2 = await client.callTool({ name: "host_command_admin", arguments: { command: "lsblk", confirm: "lsblk" } });
    expect(text(wrongTier2)).toMatch(/operate-level; use host_command/);
    const injected = await client.callTool({ name: "host_command", arguments: { command: "lsblk; id" } });
    expect(injected.isError).toBe(true);
    expect(hostSsh.run).not.toHaveBeenCalled();
    expect(fs.readFileSync(auditLogPath, "utf8")).toMatch(/"outcome":"refused"/);
  });

  it("requires confirm to equal the command name for the admin tool", async () => {
    const { client, hostSsh } = await connect("admin");
    const refused = await client.callTool({ name: "host_command_admin", arguments: { command: "disk_speed_test", confirm: "lsblk" } });
    expect(text(refused)).toMatch(/confirmation mismatch/);
    expect(hostSsh.run).not.toHaveBeenCalled();
    const ok = await client.callTool({ name: "host_command_admin", arguments: { command: "disk_speed_test", confirm: "disk_speed_test" } });
    expect(ok.isError).toBeFalsy();
    expect(hostSsh.run).toHaveBeenCalledWith("disk_speed_test", 300000);
  });

  it("refuses when the host node is outside the node allowlist (R5)", async () => {
    const { client, hostSsh } = await connect("operate", { allowedNodes: ["other"] });
    const res = await client.callTool({ name: "host_command", arguments: { command: "lsblk" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/not in the configured allowlist/);
    expect(hostSsh.run).not.toHaveBeenCalled();
  });

  it("reports a failing host command with its output", async () => {
    const { client, hostSsh } = await connect("operate");
    (hostSsh.run as any).mockResolvedValueOnce({ exitCode: 1, output: "boom\n" });
    const res = await client.callTool({ name: "host_command", arguments: { command: "lsblk" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/failed \(exit 1\):\nboom/);
  });
});

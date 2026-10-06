import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

export const ACCESS_LEVELS = ["read", "operate", "admin"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export class ConfigError extends Error {}

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

// R4: plain http is rejected outright.
const httpsUrl = z
  .url()
  .refine((u) => u.startsWith("https://"), "must use https://")
  .transform((u) => u.replace(/\/+$/, ""));

const envSchema = z
  .object({
    MCP_ACCESS_LEVEL: z.enum(ACCESS_LEVELS).default("read"),

    PROXMOX_URL: httpsUrl.optional(),
    PROXMOX_TOKEN_ID: z
      .string()
      .regex(/^[^@\s]+@[^!\s]+![A-Za-z0-9_-]+$/, "expected user@realm!tokenname")
      .optional(),
    PROXMOX_TOKEN_SECRET: z.string().min(1).optional(),
    PROXMOX_CA_FILE: z.string().optional(),
    PROXMOX_ALLOWED_NODES: csv,
    PROXMOX_ALLOWED_VMIDS: csv,

    PROXMOX_SSH_HOST: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/, "expected a hostname or IPv4 address").optional(),
    PROXMOX_SSH_NODE: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/, "expected the Proxmox node name").optional(),
    PROXMOX_SSH_KEY_FILE: z.string().min(1).optional(),
    PROXMOX_SSH_KNOWN_HOSTS_FILE: z.string().min(1).optional(),
    PROXMOX_SSH_USER: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/).default("root"),
    PROXMOX_SSH_PORT: z.coerce.number().int().min(1).max(65535).default(22),
    HOST_DIR: z.string().optional(),

    PORTAINER_URL: httpsUrl.optional(),
    PORTAINER_API_KEY: z.string().min(1).optional(),
    PORTAINER_CA_FILE: z.string().optional(),
    PORTAINER_ALLOWED_ENDPOINTS: csv,

    HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
    AUDIT_LOG_PATH: z.string().optional(),
    STACKS_DIR: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    const groups: Array<[string, string[]]> = [
      ["Proxmox", ["PROXMOX_URL", "PROXMOX_TOKEN_ID", "PROXMOX_TOKEN_SECRET"]],
      ["Portainer", ["PORTAINER_URL", "PORTAINER_API_KEY"]],
    ];
    const ssh = ["PROXMOX_SSH_HOST", "PROXMOX_SSH_NODE", "PROXMOX_SSH_KEY_FILE", "PROXMOX_SSH_KNOWN_HOSTS_FILE"] as const;
    const sshSet = ssh.filter((k) => env[k] !== undefined);
    if (sshSet.length > 0 && sshSet.length < ssh.length) {
      ctx.addIssue({ code: "custom", message: `Proxmox SSH is partially configured; set all of ${ssh.join(", ")}` });
    }
    let configured = 0;
    for (const [name, keys] of groups) {
      const set = keys.filter((k) => env[k as keyof typeof env] !== undefined);
      if (set.length > 0 && set.length < keys.length) {
        ctx.addIssue({
          code: "custom",
          message: `${name} is partially configured; set all of ${keys.join(", ")}`,
        });
      }
      if (set.length === keys.length) configured++;
    }
    if (configured === 0) {
      ctx.addIssue({ code: "custom", message: "configure Proxmox and/or Portainer" });
    }
    for (const id of env.PROXMOX_ALLOWED_VMIDS) {
      if (!/^\d+$/.test(id)) ctx.addIssue({ code: "custom", message: `PROXMOX_ALLOWED_VMIDS: '${id}' is not a VMID` });
    }
    for (const id of env.PORTAINER_ALLOWED_ENDPOINTS) {
      if (!/^\d+$/.test(id)) {
        ctx.addIssue({ code: "custom", message: `PORTAINER_ALLOWED_ENDPOINTS: '${id}' is not an endpoint ID` });
      }
    }
  });

export interface ProxmoxConfig {
  url: string;
  tokenId: string;
  tokenSecret: string;
  ca?: string;
  allowedNodes: string[];
  allowedVmids: number[];
}

export interface PortainerConfig {
  url: string;
  apiKey: string;
  ca?: string;
  allowedEndpoints: number[];
}

/** D7: SSH to the Proxmox host. The key is bound to a forced command there (host/mcp-diag.sh). */
export interface HostSshConfig {
  host: string;
  port: number;
  user: string;
  /** Proxmox node this host is. Checked against PROXMOX_ALLOWED_NODES (R5). */
  node: string;
  keyFile: string;
  knownHostsFile: string;
  /** Directory holding the committed commands.yaml (R9). */
  hostDir: string;
}

export interface Config {
  accessLevel: AccessLevel;
  proxmox?: ProxmoxConfig;
  ssh?: HostSshConfig;
  portainer?: PortainerConfig;
  timeoutMs: number;
  auditLogPath: string;
  stacksDir: string;
}

function readCa(file: string | undefined, baseDir: string): string | undefined {
  if (!file) return undefined;
  const resolved = path.resolve(baseDir, file);
  try {
    return fs.readFileSync(resolved, "utf8");
  } catch {
    throw new ConfigError(`cannot read CA file ${resolved}`);
  }
}

function checkReadable(file: string, what: string): void {
  try {
    fs.accessSync(file, fs.constants.R_OK);
  } catch {
    throw new ConfigError(`cannot read ${what} ${file}`);
  }
}

/** Build a Config from a flat env map. Pure apart from reading CA files. */
export function parseConfig(raw: Record<string, string | undefined>, baseDir = PROJECT_ROOT): Config {
  const cleaned = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined && v !== ""));
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".") || "config"}: ${i.message}`);
    throw new ConfigError(`invalid configuration:\n${issues.join("\n")}`);
  }
  const env = result.data;

  return {
    accessLevel: env.MCP_ACCESS_LEVEL,
    proxmox:
      env.PROXMOX_URL && env.PROXMOX_TOKEN_ID && env.PROXMOX_TOKEN_SECRET
        ? {
            url: env.PROXMOX_URL,
            tokenId: env.PROXMOX_TOKEN_ID,
            tokenSecret: env.PROXMOX_TOKEN_SECRET,
            ca: readCa(env.PROXMOX_CA_FILE, baseDir),
            allowedNodes: env.PROXMOX_ALLOWED_NODES,
            allowedVmids: env.PROXMOX_ALLOWED_VMIDS.map(Number),
          }
        : undefined,
    portainer:
      env.PORTAINER_URL && env.PORTAINER_API_KEY
        ? {
            url: env.PORTAINER_URL,
            apiKey: env.PORTAINER_API_KEY,
            ca: readCa(env.PORTAINER_CA_FILE, baseDir),
            allowedEndpoints: env.PORTAINER_ALLOWED_ENDPOINTS.map(Number),
          }
        : undefined,
    ssh: sshConfig(env, baseDir),
    timeoutMs: env.HTTP_TIMEOUT_MS,
    auditLogPath: path.resolve(
      baseDir,
      env.AUDIT_LOG_PATH ?? path.join(os.homedir(), ".local", "state", "proxmox-mcp", "audit.jsonl"),
    ),
    stacksDir: path.resolve(baseDir, env.STACKS_DIR ?? "stacks"),
  };
}

function sshConfig(env: z.infer<typeof envSchema>, baseDir: string): HostSshConfig | undefined {
  if (!env.PROXMOX_SSH_HOST || !env.PROXMOX_SSH_NODE || !env.PROXMOX_SSH_KEY_FILE || !env.PROXMOX_SSH_KNOWN_HOSTS_FILE) {
    return undefined;
  }
  const keyFile = path.resolve(baseDir, env.PROXMOX_SSH_KEY_FILE);
  const knownHostsFile = path.resolve(baseDir, env.PROXMOX_SSH_KNOWN_HOSTS_FILE);
  checkReadable(keyFile, "SSH key file");
  checkReadable(knownHostsFile, "SSH known_hosts file");
  assertPrivateFile(keyFile); // D3: a private key readable by others is refused
  return {
    host: env.PROXMOX_SSH_HOST,
    port: env.PROXMOX_SSH_PORT,
    user: env.PROXMOX_SSH_USER,
    node: env.PROXMOX_SSH_NODE,
    keyFile,
    knownHostsFile,
    hostDir: path.resolve(baseDir, env.HOST_DIR ?? "host"),
  };
}

/** D3: refuse secrets files that group/others can read. */
export function assertPrivateFile(file: string): void {
  const mode = fs.statSync(file).mode;
  if (mode & 0o077) {
    throw new ConfigError(
      `${file} is accessible by group/others (mode ${(mode & 0o777).toString(8)}); run: chmod 600 ${file}`,
    );
  }
}

/**
 * Load config from the .env file (PROXMOX_MCP_ENV_FILE or <project>/.env).
 * Values in the file win over the process environment.
 */
export function loadConfig(): Config {
  const envFile = path.resolve(process.env.PROXMOX_MCP_ENV_FILE ?? path.join(PROJECT_ROOT, ".env"));
  let fileVars: Record<string, string> = {};
  if (fs.existsSync(envFile)) {
    assertPrivateFile(envFile);
    fileVars = dotenv.parse(fs.readFileSync(envFile));
  }
  return parseConfig({ ...process.env, ...fileVars }, path.dirname(envFile));
}

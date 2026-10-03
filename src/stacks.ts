import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { assertPrivateFile } from "./config.js";
import { ToolError } from "./errors.js";

// Access to the versioned app definitions under stacks/ (decision D5).

const APP_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const COMPOSE_NAMES = ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"];

export class StacksRepo {
  constructor(readonly dir: string) {}

  private appDir(app: string): string {
    if (!APP_RE.test(app)) throw new ToolError(`invalid app name '${app}'`);
    const dir = path.join(this.dir, app);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new ToolError(`no app '${app}' in ${this.dir}; available: ${this.listApps().join(", ") || "none"}`);
    }
    return dir;
  }

  listApps(): string[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && APP_RE.test(d.name))
      .map((d) => d.name)
      .sort();
  }

  readCompose(app: string): string {
    const dir = this.appDir(app);
    for (const name of COMPOSE_NAMES) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
    }
    throw new ToolError(`stacks/${app} has no compose.yaml`);
  }

  /** Real secret values; never returned to the client. */
  readEnv(app: string): Record<string, string> {
    const file = path.join(this.appDir(app), ".env");
    if (!fs.existsSync(file)) return {};
    try {
      assertPrivateFile(file);
    } catch (err) {
      throw new ToolError((err as Error).message);
    }
    return dotenv.parse(fs.readFileSync(file));
  }

  /** Variable names declared in .env.example and .env. */
  envNames(app: string): string[] {
    const dir = this.appDir(app);
    const names = new Set<string>();
    for (const f of [".env.example", ".env"]) {
      const file = path.join(dir, f);
      if (fs.existsSync(file)) for (const k of Object.keys(dotenv.parse(fs.readFileSync(file)))) names.add(k);
    }
    return [...names].sort();
  }
}

/** Variables a compose file needs: `${VAR}`, `${VAR:?err}`, `$VAR` — but not `${VAR:-default}`. */
export function requiredComposeVars(text: string): string[] {
  const required = new Set<string>();
  const withoutEscapes = text.replace(/\$\$/g, "");
  for (const m of withoutEscapes.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[-?+])?[^}]*\}/g)) {
    const op = m[2];
    if (!op || op.endsWith("?")) required.add(m[1]!);
  }
  for (const m of withoutEscapes.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) required.add(m[1]!);
  return [...required].sort();
}

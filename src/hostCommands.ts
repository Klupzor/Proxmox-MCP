import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse } from "yaml";
import { z } from "zod";
import { ToolError } from "./errors.js";

// D7/R10/R9: host diagnostics are named commands defined in host/commands.yaml. Only the version
// committed to git is used, and it is re-read on every call. The host wrapper (host/mcp-diag.sh)
// holds the real command lines and refuses any name it does not know.

const run = promisify(execFile);

export const COMMAND_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

const commandSchema = z.strictObject({
  description: z.string().min(1).max(500),
  level: z.enum(["operate", "admin"]),
  timeoutSeconds: z.number().int().min(1).max(3600).default(60),
});

const fileSchema = z.strictObject({
  commands: z
    .record(z.string().regex(COMMAND_NAME_RE), commandSchema)
    .refine((c) => Object.keys(c).length > 0, "at least one command is required"),
});

export type HostCommand = z.infer<typeof commandSchema>;
export type HostCommandFile = z.infer<typeof fileSchema> & { uncommittedChanges: boolean };

export class HostCommands {
  constructor(private readonly hostDir: string) {}

  async load(): Promise<HostCommandFile> {
    let text: string;
    try {
      ({ stdout: text } = await run("git", ["-C", this.hostDir, "show", "HEAD:./commands.yaml"], { maxBuffer: 1 << 20 }));
    } catch {
      throw new ToolError("no committed host/commands.yaml: host commands only run from definitions committed to git (R9)");
    }
    let parsed: z.infer<typeof fileSchema>;
    try {
      parsed = fileSchema.parse(parse(text));
    } catch (err) {
      const detail = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : String(err);
      throw new ToolError(`host/commands.yaml is invalid: ${detail}`);
    }
    const status = await run("git", ["-C", this.hostDir, "status", "--porcelain", "--", "commands.yaml"]).catch(() => ({ stdout: "" }));
    return { ...parsed, uncommittedChanges: status.stdout.trim() !== "" };
  }

  async get(name: string): Promise<HostCommand> {
    const file = await this.load();
    if (!Object.hasOwn(file.commands, name)) {
      throw new ToolError(`unknown host command '${name}'; available: ${Object.keys(file.commands).join(", ")}`);
    }
    return file.commands[name]!;
  }
}

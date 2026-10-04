import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
import { z } from "zod";
import { ToolError } from "./errors.js";

// D6/R9: in-container commands are fixed argv lists defined per stack in
// stacks/<stack>/commands.yaml, and only the version committed to git is ever executed.
// Re-read on every call, so new commands need a commit — not a server restart.

const run = promisify(execFile);
const STACK_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const commandSchema = z.strictObject({
  description: z.string().min(1).max(500),
  argv: z.array(z.string()).min(1).max(64),
  timeoutSeconds: z.number().int().min(1).max(7200).default(60),
});

const fileSchema = z.strictObject({
  service: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
  user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/),
  commands: z
    .record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), commandSchema)
    .refine((c) => Object.keys(c).length > 0, "at least one command is required"),
});

export type AppCommand = z.infer<typeof commandSchema>;
export type AppCommandFile = z.infer<typeof fileSchema> & { uncommittedChanges: boolean };

export class AppCommands {
  constructor(private readonly stacksDir: string) {}

  async load(stack: string): Promise<AppCommandFile> {
    if (!STACK_RE.test(stack)) throw new ToolError(`invalid stack name '${stack}'`);
    const dir = path.join(this.stacksDir, stack);
    let text: string;
    try {
      ({ stdout: text } = await run("git", ["-C", dir, "show", "HEAD:./commands.yaml"], { maxBuffer: 1 << 20 }));
    } catch {
      throw new ToolError(
        `no committed stacks/${stack}/commands.yaml: commands only run from definitions committed to git (R9)`,
      );
    }
    let parsed: z.infer<typeof fileSchema>;
    try {
      parsed = fileSchema.parse(parse(text));
    } catch (err) {
      const detail = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : String(err);
      throw new ToolError(`stacks/${stack}/commands.yaml is invalid: ${detail}`);
    }
    const status = await run("git", ["-C", dir, "status", "--porcelain", "--", "commands.yaml"]).catch(() => ({ stdout: "" }));
    return { ...parsed, uncommittedChanges: status.stdout.trim() !== "" };
  }

  async get(stack: string, name: string): Promise<{ file: AppCommandFile; command: AppCommand }> {
    const file = await this.load(stack);
    if (!Object.hasOwn(file.commands, name)) {
      throw new ToolError(`unknown command '${name}' for stack '${stack}'; available: ${Object.keys(file.commands).join(", ")}`);
    }
    return { file, command: file.commands[name]! };
  }
}

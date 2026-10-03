import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AccessLevel } from "../config.js";
import { RefusedError, ToolError } from "../errors.js";
import { checkConfirm, levelAllows } from "../security/access.js";
import type { AuditLog, Outcome } from "../security/auditLog.js";
import { redactDeep, redactString } from "../security/redact.js";

type Args<S extends z.ZodRawShape> = z.infer<z.ZodObject<S>>;

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  level: AccessLevel;
  input: S;
  /** Admin tools: the exact value `confirm` must equal (R2), and how to describe it. */
  confirm?: { describe: string; expected: (args: Args<S>) => string };
  handler: (args: Args<S>) => Promise<unknown>;
}

export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef {
  if (def.level === "admin" && !def.confirm) throw new Error(`admin tool ${def.name} must define confirm`);
  return def as unknown as ToolDef;
}

const ANNOTATIONS: Record<AccessLevel, ToolAnnotations> = {
  read: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  operate: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  admin: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
};

/** Register every tool the access level allows; higher-tier tools are never exposed (R1). */
export function registerTools(server: McpServer, defs: ToolDef[], level: AccessLevel, auditLog: AuditLog): string[] {
  const registered: string[] = [];
  for (const def of defs) {
    if (!levelAllows(level, def.level)) continue;
    const shape: z.ZodRawShape = def.confirm
      ? {
          ...def.input,
          confirm: z
            .string()
            .describe(`Destructive action. Must exactly equal ${def.confirm.describe}. Only set this after the operator explicitly approved this exact action.`),
        }
      : def.input;
    const description = def.confirm ? `${def.description} [DESTRUCTIVE: requires confirm = ${def.confirm.describe}]` : def.description;
    server.registerTool(
      def.name,
      { title: def.title, description, inputSchema: shape, annotations: { title: def.title, ...ANNOTATIONS[def.level] } },
      (async (args: Record<string, unknown>) => runTool(def, args, auditLog)) as never,
    );
    registered.push(def.name);
  }
  return registered;
}

export async function runTool(def: ToolDef, args: Record<string, unknown>, auditLog: AuditLog): Promise<CallToolResult> {
  const mutating = def.level !== "read";
  const log = (outcome: Outcome, detail?: string) =>
    auditLog.write({ tool: def.name, level: def.level, args, outcome, detail });

  try {
    if (def.confirm) checkConfirm(def.confirm.expected(args as never), args.confirm);
    // R6: if the audit log cannot be written, the mutation does not happen.
    if (mutating) log("started");
    const result = await def.handler(args as never);
    if (mutating) log("ok");
    const text = typeof result === "string" ? redactString(result) : JSON.stringify(redactDeep(result), null, 2);
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const message =
      err instanceof ToolError ? err.message : `internal error: ${redactString(String((err as Error)?.message ?? err))}`;
    if (mutating) {
      try {
        log(err instanceof RefusedError ? "refused" : "error", message);
      } catch {
        // Audit log unavailable; the error below still reaches the client.
      }
    }
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}

// Shared input schemas.
export const vmidSchema = z.number().int().min(100).max(999_999_999).describe("Proxmox guest VMID");
export const snapnameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{1,39}$/, "letters, digits, _ or -, starting with a letter")
  .describe("Snapshot name");
export const endpointIdSchema = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Portainer endpoint (environment) ID; may be omitted when only one endpoint is visible");
export const containerSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/, "container ID or name")
  .describe("Container ID (full or short) or name");
export const stackRefSchema = z
  .union([z.number().int().positive(), z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/)])
  .describe("Portainer stack ID (number) or stack name (string)");
export const appSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "lowercase app directory name under stacks/")
  .describe("App directory name under stacks/ (must equal the Portainer stack name)");

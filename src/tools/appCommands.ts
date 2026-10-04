import { z } from "zod";
import type { AppCommands } from "../appCommands.js";
import type { PortainerClient } from "../clients/portainer.js";
import { ToolError } from "../errors.js";
import { defineTool, endpointIdSchema, type ToolDef } from "./define.js";

const MAX_OUTPUT = 20_000;

const stackSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
  .describe("Stack name: stacks/<stack>/commands.yaml defines its commands");
const commandSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/)
  .describe("Command name from app_commands_list");

export function appCommandTools(ptr: PortainerClient, commands: AppCommands): ToolDef[] {
  return [
    defineTool({
      name: "app_commands_list",
      title: "List app commands",
      description:
        "List the allowlisted in-container commands a stack defines (stacks/<stack>/commands.yaml, committed version). Read-only: nothing is executed.",
      level: "read",
      input: { stack: stackSchema },
      handler: async ({ stack }) => {
        const file = await commands.load(stack);
        return {
          stack,
          service: file.service,
          user: file.user,
          note: file.uncommittedChanges ? "commands.yaml has uncommitted changes; only the committed version runs" : undefined,
          commands: Object.entries(file.commands).map(([name, c]) => ({
            name,
            description: c.description,
            timeoutSeconds: c.timeoutSeconds,
          })),
        };
      },
    }),
    defineTool({
      name: "app_command",
      title: "Run app command",
      description:
        "Run one allowlisted command (see app_commands_list) inside a stack's service container. Only fixed commands committed in stacks/<stack>/commands.yaml can run; nothing from the client is interpolated.",
      level: "admin",
      input: { stack: stackSchema, command: commandSchema, endpointId: endpointIdSchema },
      confirm: { describe: "the command name", expected: ({ command }) => command },
      handler: async ({ stack, command, endpointId }) => {
        const { file, command: spec } = await commands.get(stack, command);
        const id = await ptr.resolveEndpoint(endpointId);
        const container = await ptr.findServiceContainer(id, stack, file.service);
        const { exitCode, output } = await ptr.execInContainer(id, container, [...spec.argv], file.user, spec.timeoutSeconds * 1000);
        const tail = output.length > MAX_OUTPUT ? `…(truncated)…\n${output.slice(-MAX_OUTPUT)}` : output;
        if (exitCode !== 0) throw new ToolError(`${stack}/${command} failed (exit ${exitCode}):\n${tail.trim()}`);
        return `${stack}/${command} (exit 0):\n${tail.trim() || "(no output)"}`;
      },
    }),
  ];
}

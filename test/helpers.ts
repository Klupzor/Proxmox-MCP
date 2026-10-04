import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A throwaway git repo acting as a stacks dir, with stacks/<stack>/commands.yaml committed. */
export function gitStacksDir(stack: string, commandsYaml: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pmcp-stacks-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  fs.mkdirSync(path.join(root, stack));
  fs.writeFileSync(path.join(root, stack, "commands.yaml"), commandsYaml);
  git("add", ".");
  git("commit", "-q", "-m", "commands");
  return root;
}

export const DEMO_COMMANDS = `service: app
user: www-data
commands:
  status:
    description: Show status.
    argv: [php, occ, status]
  maintenance_on:
    description: Enable maintenance mode.
    argv: [php, occ, maintenance:mode, --on]
`;

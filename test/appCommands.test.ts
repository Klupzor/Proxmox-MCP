import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { AppCommands } from "../src/appCommands.js";
import { DEMO_COMMANDS, gitStacksDir } from "./helpers.js";

describe("AppCommands (R9)", () => {
  it("loads the committed commands.yaml", async () => {
    const dir = gitStacksDir("demo", DEMO_COMMANDS);
    const file = await new AppCommands(dir).load("demo");
    expect(file.service).toBe("app");
    expect(Object.keys(file.commands)).toEqual(["status", "maintenance_on"]);
    expect(file.commands.status!.timeoutSeconds).toBe(60);
    expect(file.uncommittedChanges).toBe(false);
  });

  it("ignores uncommitted edits: only the committed version runs", async () => {
    const dir = gitStacksDir("demo", DEMO_COMMANDS);
    fs.appendFileSync(path.join(dir, "demo", "commands.yaml"), "  evil:\n    description: x\n    argv: [rm, -rf, /]\n");
    const cmds = new AppCommands(dir);
    const file = await cmds.load("demo");
    expect(file.uncommittedChanges).toBe(true);
    await expect(cmds.get("demo", "evil")).rejects.toThrow(/unknown command 'evil'/);
  });

  it("refuses uncommitted files, invalid stacks, bad schemas and prototype keys", async () => {
    const dir = gitStacksDir("demo", DEMO_COMMANDS);
    fs.mkdirSync(path.join(dir, "fresh"));
    fs.writeFileSync(path.join(dir, "fresh", "commands.yaml"), DEMO_COMMANDS);
    const cmds = new AppCommands(dir);
    await expect(cmds.load("fresh")).rejects.toThrow(/committed to git/);
    await expect(cmds.load("../etc")).rejects.toThrow(/invalid stack/);
    await expect(cmds.get("demo", "constructor")).rejects.toThrow(/unknown command/);

    const bad = gitStacksDir("demo", "service: app\nuser: www-data\ncommands:\n  x:\n    description: d\n    argv: [1, 2]\n");
    await expect(new AppCommands(bad).load("demo")).rejects.toThrow(/invalid/);
  });

  it("the repo's Nextcloud commands.yaml is valid and uses only fixed strings", () => {
    const doc = parse(fs.readFileSync(path.join(__dirname, "..", "stacks", "nextcloud", "commands.yaml"), "utf8"));
    expect(doc.service).toBe("app");
    for (const c of Object.values<any>(doc.commands)) {
      expect(c.argv.every((a: unknown) => typeof a === "string")).toBe(true);
    }
  });
});

import fs from "node:fs";
import path from "node:path";
import { redactDeep } from "./redact.js";

// R6: append-only JSONL record of every mutating call.

export type Outcome = "started" | "ok" | "error" | "refused";

export interface AuditEntry {
  tool: string;
  level: string;
  args: Record<string, unknown>;
  outcome: Outcome;
  detail?: string;
}

export class AuditLog {
  constructor(private readonly file: string) {}

  write(entry: AuditEntry): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...(redactDeep(entry) as AuditEntry) });
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.file, `${line}\n`, { mode: 0o600 });
  }
}

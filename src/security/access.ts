import type { AccessLevel } from "../config.js";
import { RefusedError } from "../errors.js";

const RANK: Record<AccessLevel, number> = { read: 0, operate: 1, admin: 2 };

/** R1: whether a tool requiring `required` is available at `configured`. */
export function levelAllows(configured: AccessLevel, required: AccessLevel): boolean {
  return RANK[configured] >= RANK[required];
}

/** R2: the confirm argument must exactly equal the target identifier. */
export function checkConfirm(expected: string, given: unknown): void {
  if (typeof given !== "string" || given !== expected) {
    throw new RefusedError(
      `confirmation mismatch: this is a destructive action; re-run with confirm="${expected}" only if the operator approved it`,
    );
  }
}

// R3: keep secret values out of tool output and logs.

export const REDACTED = "[REDACTED]";

// Matched anywhere in a key name.
const STRONG_KEY = /(password|passwd|secret|token|credential|api_?key|private_?key|access_?key|client_?secret)/i;
// Matched only as a whole segment of a key name (FOO_KEY, dbPass, X-Auth).
const WEAK_SEGMENTS = new Set(["key", "pass", "pwd", "auth", "salt", "dsn", "jwt", "otp", "pin", "license"]);

function keySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isSecretKey(key: string): boolean {
  if (STRONG_KEY.test(key)) return true;
  return keySegments(key).some((s) => WEAK_SEGMENTS.has(s));
}

/** A value made only of ${VAR} interpolations carries no secret itself. */
export function isInterpolation(value: string): boolean {
  return /^\s*(\$\{[^}]+\}\s*)+$/.test(value) || /^\s*\$[A-Za-z_][A-Za-z0-9_]*\s*$/.test(value);
}

const VALUE_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
  /\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bptr_[A-Za-z0-9+/=]{20,}\b/g, // Portainer access token
  /PVEAPIToken=[^\s"']+/g,
];

/** Redact credential-looking substrings and KEY=VALUE pairs with secret keys. */
export function redactString(value: string): string {
  const kv = value.includes("\n") ? null : /^([A-Za-z_][A-Za-z0-9_.-]*)=(.*)$/.exec(value);
  if (kv &&isSecretKey(kv[1]!) && kv[2] !== "" && !isInterpolation(kv[2]!)) {
    return `${kv[1]}=${REDACTED}`;
  }
  let out = value.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi, `$1${REDACTED}$3`);
  for (const re of VALUE_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

/** Deep-redact any JSON-like value. */
export function redactDeep(value: unknown, parentKey?: string): unknown {
  if (typeof value === "string") {
    if (parentKey && isSecretKey(parentKey) && value !== "" && !isInterpolation(value)) return REDACTED;
    return redactString(value);
  }
  if (Array.isArray(value)) return value.map((v) => redactDeep(v));
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // {name, value} pairs, e.g. Portainer stack Env.
    const pairKey = typeof obj.name === "string" ? obj.name : typeof obj.Name === "string" ? obj.Name : undefined;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (pairKey && (k === "value" || k === "Value") && typeof v === "string" && isSecretKey(pairKey) && v !== "") {
        out[k] = REDACTED;
      } else if (v !== null && typeof v !== "object" && typeof v !== "string" && isSecretKey(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = redactDeep(v, k);
      }
    }
    return out;
  }
  return value;
}

/**
 * Redact secrets in compose YAML text while preserving its formatting.
 * Handles `KEY: value`, `KEY=value` and `- KEY=value` lines.
 */
export function redactComposeText(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const m =
        /^(\s*-?\s*["']?)([A-Za-z_][A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)(["']?)(.*?)(["']?)(\s*(#.*)?)$/.exec(line);
      if (m) {
        const [, pre, key, sep, q1, val, q2, tail] = m;
        if (isSecretKey(key!) && val && !isInterpolation(val) && !/^[|>]/.test(val)) {
          return `${pre}${key}${sep}${q1}${REDACTED}${q2}${tail ?? ""}`;
        }
      }
      return redactString(line);
    })
    .join("\n");
}

import { Agent, type Dispatcher, fetch } from "undici";
import { HttpError, ToolError } from "./errors.js";
import { redactString } from "./security/redact.js";

export interface HttpClientOptions {
  baseUrl: string;
  headers: Record<string, string>;
  /** PEM CA bundle for self-signed homelab certs (R4). */
  ca?: string;
  timeoutMs: number;
  /** Test hook (undici MockAgent). */
  dispatcher?: Dispatcher;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  form?: Record<string, string | number | boolean | undefined>;
}

export class HttpClient {
  private readonly dispatcher: Dispatcher;

  constructor(private readonly opts: HttpClientOptions) {
    // R4: rejectUnauthorized is never turned off; a CA is the only escape hatch.
    this.dispatcher =
      opts.dispatcher ??
      new Agent({
        connect: { rejectUnauthorized: true, ...(opts.ca ? { ca: opts.ca } : {}) },
        headersTimeout: opts.timeoutMs,
        bodyTimeout: opts.timeoutMs,
      });
  }

  async json<T>(method: string, path: string, req: RequestOptions = {}): Promise<T> {
    const res = await this.send(method, path, req);
    const text = Buffer.from(res).toString("utf8");
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ToolError(`${method} ${path}: upstream returned non-JSON response`);
    }
  }

  async raw(method: string, path: string, req: RequestOptions = {}): Promise<Uint8Array> {
    return this.send(method, path, req);
  }

  private async send(method: string, path: string, req: RequestOptions): Promise<Uint8Array> {
    const url = new URL(this.opts.baseUrl + path);
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { Accept: "application/json", ...this.opts.headers };
    let body: string | undefined;
    if (req.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(req.json);
    } else if (req.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(req.form)) if (v !== undefined) form.set(k, String(v));
      body = form.toString();
    }

    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(url, {
        method,
        headers,
        body,
        dispatcher: this.dispatcher,
        signal: AbortSignal.timeout(this.opts.timeoutMs),
        redirect: "error",
      });
    } catch (err) {
      throw new ToolError(`${method} ${url.pathname}: connection failed (${describeNetworkError(err)})`);
    }

    const buf = new Uint8Array(await res.arrayBuffer());
    if (!res.ok) {
      throw new HttpError(res.status, `${method} ${url.pathname}: HTTP ${res.status}${upstreamMessage(buf, res.status)}`);
    }
    return buf;
  }
}

function describeNetworkError(err: unknown): string {
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code ?? (err as { name?: string })?.name ?? "unknown error";
  if (typeof code === "string" && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) {
    return `${code}: TLS certificate not trusted; set the *_CA_FILE option (see docs/setup.md)`;
  }
  return String(code);
}

/** A short, redacted message extracted from an upstream error body — never the raw body. */
function upstreamMessage(buf: Uint8Array, status: number): string {
  let msg = "";
  try {
    const parsed = JSON.parse(Buffer.from(buf).toString("utf8")) as Record<string, unknown>;
    const candidate = parsed.message ?? parsed.details ?? parsed.errors;
    msg = typeof candidate === "string" ? candidate : candidate ? JSON.stringify(candidate) : "";
  } catch {
    // Non-JSON error bodies (HTML pages etc.) are dropped.
  }
  msg = redactString(msg).slice(0, 300).trim();
  const hint = status === 401 || status === 403 ? " (check the API token and its permissions, see docs/setup.md)" : "";
  return (msg ? `: ${msg}` : "") + hint;
}

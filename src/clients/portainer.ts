import type { Dispatcher } from "undici";
import type { PortainerConfig } from "../config.js";
import { ToolError } from "../errors.js";
import { HttpClient } from "../http.js";
import { Allowlist } from "../security/allowlist.js";

export interface Endpoint {
  Id: number;
  Name: string;
  Type: number;
  URL?: string;
  Status: number;
}

export interface StackEnv {
  name: string;
  value: string;
}

export interface Stack {
  Id: number;
  Name: string;
  EndpointId: number;
  Type: number;
  Status: number;
  Env?: StackEnv[];
  CreationDate?: number;
  UpdateDate?: number;
}

export type ContainerAction = "start" | "stop" | "restart";

/** Stack deploys pull images and recreate containers; they routinely exceed the default timeout. */
const DEPLOY_TIMEOUT_MS = 15 * 60_000;

export class PortainerClient {
  private readonly http: HttpClient;
  readonly endpoints: Allowlist<number>;

  constructor(cfg: PortainerConfig, timeoutMs: number, dispatcher?: Dispatcher) {
    this.http = new HttpClient({
      baseUrl: `${cfg.url}/api`,
      headers: { "X-API-Key": cfg.apiKey },
      ca: cfg.ca,
      timeoutMs,
      dispatcher,
    });
    this.endpoints = new Allowlist("Portainer endpoint", cfg.allowedEndpoints);
  }

  async listEndpoints(): Promise<Endpoint[]> {
    const all = await this.http.json<Endpoint[]>("GET", "/endpoints");
    return this.endpoints.filter(all, (e) => e.Id);
  }

  /** Use the given endpoint, or the only visible one when omitted. */
  async resolveEndpoint(endpointId?: number): Promise<number> {
    if (endpointId !== undefined) {
      this.endpoints.assert(endpointId);
      return endpointId;
    }
    const list = await this.listEndpoints();
    if (list.length === 1) return list[0]!.Id;
    throw new ToolError(
      `endpointId is required; available: ${list.map((e) => `${e.Id} (${e.Name})`).join(", ") || "none"}`,
    );
  }

  async listStacks(): Promise<Stack[]> {
    const all = await this.http.json<Stack[]>("GET", "/stacks");
    return this.endpoints.filter(all, (s) => s.EndpointId);
  }

  async getStack(stackId: number): Promise<Stack> {
    const stack = await this.http.json<Stack>("GET", `/stacks/${stackId}`);
    this.endpoints.assert(stack.EndpointId);
    return stack;
  }

  async findStackByName(name: string): Promise<Stack | undefined> {
    const matches = (await this.listStacks()).filter((s) => s.Name === name);
    if (matches.length > 1) {
      throw new ToolError(`multiple stacks named '${name}' (ids ${matches.map((s) => s.Id).join(", ")})`);
    }
    return matches[0];
  }

  async getStackFile(stackId: number): Promise<string> {
    await this.getStack(stackId);
    const res = await this.http.json<{ StackFileContent: string }>("GET", `/stacks/${stackId}/file`);
    return res.StackFileContent;
  }

  async stackAction(stackId: number, action: "start" | "stop"): Promise<Stack> {
    const stack = await this.getStack(stackId);
    await this.http.json("POST", `/stacks/${stackId}/${action}`, {
      query: { endpointId: stack.EndpointId },
      timeoutMs: DEPLOY_TIMEOUT_MS,
    });
    return stack;
  }

  async updateStack(
    stack: Stack,
    content: string,
    env: StackEnv[],
    opts: { pullImage: boolean; prune: boolean },
  ): Promise<void> {
    this.endpoints.assert(stack.EndpointId);
    await this.http.json("PUT", `/stacks/${stack.Id}`, {
      query: { endpointId: stack.EndpointId },
      json: { stackFileContent: content, env, prune: opts.prune, pullImage: opts.pullImage },
      timeoutMs: DEPLOY_TIMEOUT_MS,
    });
  }

  /** Pull images and redeploy the stack's current definition. */
  async redeployStack(stackId: number): Promise<Stack> {
    const stack = await this.getStack(stackId);
    const content = await this.getStackFile(stackId);
    await this.updateStack(stack, content, stack.Env ?? [], { pullImage: true, prune: false });
    return stack;
  }

  async createStack(endpointId: number, name: string, content: string, env: StackEnv[]): Promise<Stack> {
    this.endpoints.assert(endpointId);
    return this.http.json<Stack>("POST", "/stacks/create/standalone/string", {
      query: { endpointId },
      json: { name, stackFileContent: content, env },
      timeoutMs: DEPLOY_TIMEOUT_MS,
    });
  }

  async deleteStack(stackId: number): Promise<Stack> {
    const stack = await this.getStack(stackId);
    await this.http.json("DELETE", `/stacks/${stackId}`, { query: { endpointId: stack.EndpointId } });
    return stack;
  }

  // --- Docker API through Portainer's endpoint proxy ---

  private docker(endpointId: number, path: string): string {
    this.endpoints.assert(endpointId);
    return `/endpoints/${endpointId}/docker${path}`;
  }

  listContainers(endpointId: number, all: boolean): Promise<Array<Record<string, unknown>>> {
    return this.http.json("GET", this.docker(endpointId, "/containers/json"), { query: { all } });
  }

  inspectContainer(endpointId: number, id: string): Promise<Record<string, any>> {
    return this.http.json("GET", this.docker(endpointId, `/containers/${encodeURIComponent(id)}/json`));
  }

  async containerLogs(endpointId: number, id: string, tail: number, since?: number): Promise<string> {
    const buf = await this.http.raw("GET", this.docker(endpointId, `/containers/${encodeURIComponent(id)}/logs`), {
      query: { stdout: true, stderr: true, timestamps: true, tail, since },
    });
    return demuxDockerStream(buf);
  }

  async containerAction(endpointId: number, id: string, action: ContainerAction): Promise<void> {
    await this.http.json("POST", this.docker(endpointId, `/containers/${encodeURIComponent(id)}/${action}`));
  }

  /** Process list of a container (Docker `top`, runs `ps aux` on the Docker host). */
  containerTop(endpointId: number, id: string): Promise<{ Titles: string[]; Processes: string[][] }> {
    return this.http.json("GET", this.docker(endpointId, `/containers/${encodeURIComponent(id)}/top`), {
      query: { ps_args: "aux" },
    });
  }

  /** Find the container of a compose stack's service via Compose labels. */
  async findServiceContainer(endpointId: number, project: string, service: string): Promise<string> {
    const filters = JSON.stringify({
      label: [`com.docker.compose.project=${project}`, `com.docker.compose.service=${service}`],
      status: ["running"],
    });
    const list = await this.http.json<Array<{ Id: string }>>("GET", this.docker(endpointId, "/containers/json"), {
      query: { filters },
    });
    if (list.length !== 1) {
      throw new ToolError(`expected one running '${service}' container in stack '${project}', found ${list.length}`);
    }
    return list[0]!.Id;
  }

  /**
   * Run a fixed argv in a container and wait for it. Internal only: callers must pass a
   * hard-coded command, never user input (see tools/nextcloud.ts).
   */
  async execInContainer(
    endpointId: number,
    containerId: string,
    cmd: string[],
    user: string,
    timeoutMs: number,
  ): Promise<{ exitCode: number; output: string }> {
    const created = await this.http.json<{ Id: string }>(
      "POST",
      this.docker(endpointId, `/containers/${encodeURIComponent(containerId)}/exec`),
      { json: { AttachStdout: true, AttachStderr: true, Tty: false, User: user, Cmd: cmd } },
    );
    const raw = await this.http.raw("POST", this.docker(endpointId, `/exec/${encodeURIComponent(created.Id)}/start`), {
      json: { Detach: false, Tty: false },
      timeoutMs,
    });
    const info = await this.http.json<{ ExitCode: number | null; Running: boolean }>(
      "GET",
      this.docker(endpointId, `/exec/${encodeURIComponent(created.Id)}/json`),
    );
    return { exitCode: info.ExitCode ?? -1, output: demuxDockerStream(raw) };
  }

  listImages(endpointId: number): Promise<Array<Record<string, unknown>>> {
    return this.http.json("GET", this.docker(endpointId, "/images/json"));
  }

  listVolumes(endpointId: number): Promise<{ Volumes: Array<Record<string, unknown>> | null }> {
    return this.http.json("GET", this.docker(endpointId, "/volumes"));
  }

  listNetworks(endpointId: number): Promise<Array<Record<string, unknown>>> {
    return this.http.json("GET", this.docker(endpointId, "/networks"));
  }

  pruneImages(endpointId: number, allUnused: boolean): Promise<Record<string, unknown>> {
    return this.http.json("POST", this.docker(endpointId, "/images/prune"), {
      query: { filters: JSON.stringify({ dangling: [allUnused ? "false" : "true"] }) },
    });
  }
}

/** Docker multiplexes stdout/stderr with 8-byte frame headers unless the container has a TTY. */
export function demuxDockerStream(buf: Uint8Array): string {
  const isFramed = buf.length >= 8 && buf[0]! <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
  if (!isFramed) return Buffer.from(buf).toString("utf8");
  const view = Buffer.from(buf);
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= view.length) {
    const size = view.readUInt32BE(offset + 4);
    chunks.push(view.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  return Buffer.concat(chunks).toString("utf8");
}

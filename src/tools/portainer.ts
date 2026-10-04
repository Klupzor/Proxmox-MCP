import { z } from "zod";
import type { PortainerClient, Stack } from "../clients/portainer.js";
import { ToolError } from "../errors.js";
import { redactComposeText } from "../security/redact.js";
import { requiredComposeVars, type StacksRepo } from "../stacks.js";
import {
  appSchema,
  containerSchema,
  defineTool,
  endpointIdSchema,
  stackRefSchema,
  type ToolDef,
} from "./define.js";

const MB = 1024 ** 2;

export async function resolveStack(ptr: PortainerClient, ref: number | string): Promise<Stack> {
  if (typeof ref === "number") return ptr.getStack(ref);
  const stack = await ptr.findStackByName(ref);
  if (!stack) throw new ToolError(`no stack named '${ref}'`);
  return stack;
}

function stackSummary(s: Stack) {
  return {
    id: s.Id,
    name: s.Name,
    endpointId: s.EndpointId,
    status: s.Status === 1 ? "active" : s.Status === 2 ? "inactive" : s.Status,
    type: s.Type === 2 ? "compose" : s.Type === 1 ? "swarm" : s.Type,
    // R3: names only; values never leave the server.
    envVars: (s.Env ?? []).map((e) => e.name),
    updated: s.UpdateDate ? new Date(s.UpdateDate * 1000).toISOString() : undefined,
  };
}

/** A curated, security-relevant view of `docker inspect`. */
function inspectView(c: Record<string, any>) {
  const hc = c.HostConfig ?? {};
  return {
    id: String(c.Id ?? "").slice(0, 12),
    name: String(c.Name ?? "").replace(/^\//, ""),
    image: c.Config?.Image,
    created: c.Created,
    state: { status: c.State?.Status, health: c.State?.Health?.Status, startedAt: c.State?.StartedAt, restartCount: c.RestartCount },
    config: {
      user: c.Config?.User || "(image default)",
      env: c.Config?.Env,
      cmd: c.Config?.Cmd,
      entrypoint: c.Config?.Entrypoint,
      healthcheck: c.Config?.Healthcheck,
      labels: c.Config?.Labels,
    },
    hostConfig: {
      privileged: hc.Privileged,
      networkMode: hc.NetworkMode,
      pidMode: hc.PidMode,
      capAdd: hc.CapAdd,
      capDrop: hc.CapDrop,
      securityOpt: hc.SecurityOpt,
      readonlyRootfs: hc.ReadonlyRootfs,
      restartPolicy: hc.RestartPolicy?.Name,
      memoryMB: hc.Memory ? Math.round(hc.Memory / MB) : 0,
      nanoCpus: hc.NanoCpus,
      portBindings: hc.PortBindings,
      devices: hc.Devices,
    },
    mounts: (c.Mounts ?? []).map((m: any) => ({ type: m.Type, source: m.Source, destination: m.Destination, rw: m.RW })),
    networks: Object.fromEntries(
      Object.entries((c.NetworkSettings?.Networks ?? {}) as Record<string, any>).map(([k, v]) => [k, v.IPAddress]),
    ),
  };
}

export function portainerTools(ptr: PortainerClient, stacks: StacksRepo): ToolDef[] {
  return [
    // --- read ---
    defineTool({
      name: "ptr_list_endpoints",
      title: "List Portainer endpoints",
      description: "List Portainer environments (Docker endpoints).",
      level: "read",
      input: {},
      handler: async () =>
        (await ptr.listEndpoints()).map((e) => ({
          id: e.Id,
          name: e.Name,
          type: e.Type,
          url: e.URL,
          status: e.Status === 1 ? "up" : "down",
        })),
    }),
    defineTool({
      name: "ptr_list_stacks",
      title: "List stacks",
      description: "List Portainer stacks (apps) with status and env variable names (values are never shown).",
      level: "read",
      input: {},
      handler: async () => (await ptr.listStacks()).map(stackSummary),
    }),
    defineTool({
      name: "ptr_get_stack_file",
      title: "Get stack compose file",
      description: "The compose file of a deployed stack, with inline secret values redacted.",
      level: "read",
      input: { stack: stackRefSchema },
      handler: async ({ stack }) => {
        const s = await resolveStack(ptr, stack);
        const content = await ptr.getStackFile(s.Id);
        return { ...stackSummary(s), compose: redactComposeText(content) };
      },
    }),
    defineTool({
      name: "ptr_list_containers",
      title: "List containers",
      description: "List containers on an endpoint.",
      level: "read",
      input: {
        endpointId: endpointIdSchema,
        all: z.boolean().default(true).describe("Include stopped containers"),
      },
      handler: async ({ endpointId, all }) => {
        const id = await ptr.resolveEndpoint(endpointId);
        return (await ptr.listContainers(id, all)).map((c: Record<string, any>) => ({
          id: String(c.Id).slice(0, 12),
          name: (c.Names?.[0] ?? "").replace(/^\//, ""),
          image: c.Image,
          state: c.State,
          status: c.Status,
          stack: c.Labels?.["com.docker.compose.project"],
          ports: (c.Ports ?? []).map((p: any) =>
            p.PublicPort ? `${p.IP ?? ""}:${p.PublicPort}->${p.PrivatePort}/${p.Type}` : `${p.PrivatePort}/${p.Type}`,
          ),
        }));
      },
    }),
    defineTool({
      name: "ptr_inspect_container",
      title: "Inspect container",
      description: "Security-relevant runtime configuration of a container (env secrets redacted).",
      level: "read",
      input: { endpointId: endpointIdSchema, container: containerSchema },
      handler: async ({ endpointId, container }) => {
        const id = await ptr.resolveEndpoint(endpointId);
        return inspectView(await ptr.inspectContainer(id, container));
      },
    }),
    defineTool({
      name: "ptr_container_logs",
      title: "Container logs",
      description: "Recent stdout/stderr of a container (credential-looking values redacted).",
      level: "read",
      input: {
        endpointId: endpointIdSchema,
        container: containerSchema,
        tail: z.number().int().min(1).max(500).default(100).describe("Number of lines (max 500)"),
        sinceMinutes: z.number().int().min(1).max(10080).optional().describe("Only logs from the last N minutes"),
      },
      handler: async ({ endpointId, container, tail, sinceMinutes }) => {
        const id = await ptr.resolveEndpoint(endpointId);
        const since = sinceMinutes ? Math.floor(Date.now() / 1000) - sinceMinutes * 60 : undefined;
        const text = await ptr.containerLogs(id, container, tail, since);
        return text.split("\n").map(redactComposeText).join("\n") || "(no log output)";
      },
    }),
    defineTool({
      name: "ptr_container_top",
      title: "Container processes",
      description: "Process list of a container (ps aux): what is running, CPU/memory, and state (e.g. D = waiting on disk).",
      level: "read",
      input: { endpointId: endpointIdSchema, container: containerSchema },
      handler: async ({ endpointId, container }) => {
        const id = await ptr.resolveEndpoint(endpointId);
        const top = await ptr.containerTop(id, container);
        return [top.Titles.join("  "), ...top.Processes.map((p) => p.join("  "))].join("\n");
      },
    }),
    defineTool({
      name: "ptr_list_images",
      title: "List images",
      description: "List images on an endpoint.",
      level: "read",
      input: { endpointId: endpointIdSchema },
      handler: async ({ endpointId }) => {
        const id = await ptr.resolveEndpoint(endpointId);
        return (await ptr.listImages(id)).map((i: Record<string, any>) => ({
          id: String(i.Id).replace(/^sha256:/, "").slice(0, 12),
          tags: i.RepoTags,
          sizeMB: Math.round((i.Size ?? 0) / MB),
          created: i.Created ? new Date(i.Created * 1000).toISOString() : undefined,
          inUseBy: i.Containers >= 0 ? i.Containers : undefined,
        }));
      },
    }),
    defineTool({
      name: "ptr_list_volumes",
      title: "List volumes",
      description: "List Docker volumes on an endpoint.",
      level: "read",
      input: { endpointId: endpointIdSchema },
      handler: async ({ endpointId }) => {
        const id = await ptr.resolveEndpoint(endpointId);
        return ((await ptr.listVolumes(id)).Volumes ?? []).map((v: Record<string, any>) => ({
          name: v.Name,
          driver: v.Driver,
          mountpoint: v.Mountpoint,
          stack: v.Labels?.["com.docker.compose.project"],
        }));
      },
    }),
    defineTool({
      name: "ptr_list_networks",
      title: "List networks",
      description: "List Docker networks on an endpoint.",
      level: "read",
      input: { endpointId: endpointIdSchema },
      handler: async ({ endpointId }) => {
        const id = await ptr.resolveEndpoint(endpointId);
        return (await ptr.listNetworks(id)).map((n: Record<string, any>) => ({
          name: n.Name,
          driver: n.Driver,
          scope: n.Scope,
          internal: n.Internal,
          subnets: (n.IPAM?.Config ?? []).map((c: any) => c.Subnet),
          stack: n.Labels?.["com.docker.compose.project"],
        }));
      },
    }),

    // --- operate ---
    ...(["start", "stop", "restart"] as const).map((action) =>
      defineTool({
        name: `ptr_container_${action}`,
        title: `${action[0]!.toUpperCase()}${action.slice(1)} container`,
        description: `${action[0]!.toUpperCase()}${action.slice(1)} a container.`,
        level: "operate",
        input: { endpointId: endpointIdSchema, container: containerSchema },
        handler: async ({ endpointId, container }) => {
          const id = await ptr.resolveEndpoint(endpointId);
          await ptr.containerAction(id, container, action);
          return { container, action, endpointId: id, result: "ok" };
        },
      }),
    ),
    ...(["start", "stop"] as const).map((action) =>
      defineTool({
        name: `ptr_stack_${action}`,
        title: `${action === "start" ? "Start" : "Stop"} stack`,
        description: `${action === "start" ? "Start" : "Stop"} all services of a Portainer stack.`,
        level: "operate",
        input: { stack: stackRefSchema },
        handler: async ({ stack }) => {
          const s = await resolveStack(ptr, stack);
          await ptr.stackAction(s.Id, action);
          return { stack: s.Name, action, result: "ok" };
        },
      }),
    ),
    defineTool({
      name: "ptr_stack_redeploy",
      title: "Redeploy stack",
      description: "Pull images and redeploy a stack with its current compose file and env (no definition changes).",
      level: "operate",
      input: { stack: stackRefSchema },
      handler: async ({ stack }) => {
        const s = await resolveStack(ptr, stack);
        await ptr.redeployStack(s.Id);
        return { stack: s.Name, action: "redeploy", pulledImages: true, result: "ok" };
      },
    }),

    // --- admin ---
    defineTool({
      name: "ptr_stack_deploy_from_repo",
      title: "Deploy stack from repo",
      description:
        "Deploy stacks/<app>/compose.yaml with env from stacks/<app>/.env to Portainer: updates the stack with the same name, or creates it on endpointId.",
      level: "admin",
      input: {
        app: appSchema,
        endpointId: endpointIdSchema.describe("Required only when the stack does not exist yet"),
        pullImage: z.boolean().default(true),
        prune: z.boolean().default(false).describe("Remove services no longer in the compose file"),
      },
      confirm: { describe: "the app name", expected: ({ app }) => app },
      handler: async ({ app, endpointId, pullImage, prune }) => {
        const content = stacks.readCompose(app);
        const envMap = stacks.readEnv(app);
        const missing = requiredComposeVars(content).filter((v) => !(v in envMap));
        if (missing.length > 0) {
          throw new ToolError(`stacks/${app}/.env is missing required variables: ${missing.join(", ")}`);
        }
        const env = Object.entries(envMap).map(([name, value]) => ({ name, value }));
        const existing = await ptr.findStackByName(app);
        if (existing) {
          if (endpointId !== undefined && endpointId !== existing.EndpointId) {
            throw new ToolError(`stack '${app}' exists on endpoint ${existing.EndpointId}, not ${endpointId}`);
          }
          await ptr.updateStack(existing, content, env, { pullImage, prune });
          return { app, action: "updated", stackId: existing.Id, endpointId: existing.EndpointId, envVars: Object.keys(envMap) };
        }
        if (endpointId === undefined) throw new ToolError(`stack '${app}' does not exist yet; endpointId is required to create it`);
        const created = await ptr.createStack(endpointId, app, content, env);
        return { app, action: "created", stackId: created.Id, endpointId, envVars: Object.keys(envMap) };
      },
    }),
    defineTool({
      name: "ptr_stack_delete",
      title: "Delete stack",
      description: "Delete a Portainer stack and remove its containers.",
      level: "admin",
      input: { stack: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/).describe("Portainer stack name") },
      confirm: { describe: "the stack name", expected: ({ stack }) => stack },
      handler: async ({ stack }) => {
        const s = await resolveStack(ptr, stack);
        await ptr.deleteStack(s.Id);
        return { stack: s.Name, action: "deleted" };
      },
    }),
    defineTool({
      name: "ptr_image_prune",
      title: "Prune images",
      description: "Remove dangling images, or all images not used by any container.",
      level: "admin",
      input: {
        endpointId: z.number().int().positive().describe("Portainer endpoint ID"),
        allUnused: z.boolean().default(false).describe("Also remove tagged images not used by any container"),
      },
      confirm: { describe: "the endpoint ID as a string", expected: ({ endpointId }) => String(endpointId) },
      handler: async ({ endpointId, allUnused }) => {
        const res = await ptr.pruneImages(endpointId, allUnused);
        return {
          deleted: ((res.ImagesDeleted as unknown[]) ?? []).length,
          reclaimedMB: Math.round(Number(res.SpaceReclaimed ?? 0) / MB),
        };
      },
    }),
  ];
}

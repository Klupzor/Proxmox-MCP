import { parse } from "yaml";
import { z } from "zod";
import { auditCompose } from "../audit/composeRules.js";
import { auditContainer } from "../audit/containerRules.js";
import { type Finding, summarize } from "../audit/findings.js";
import { auditLxc } from "../audit/lxcRules.js";
import type { PortainerClient } from "../clients/portainer.js";
import type { ProxmoxClient } from "../clients/proxmox.js";
import { ToolError } from "../errors.js";
import type { StacksRepo } from "../stacks.js";
import { appSchema, containerSchema, defineTool, endpointIdSchema, stackRefSchema, type ToolDef, vmidSchema } from "./define.js";
import { resolveStack } from "./portainer.js";

const MAX_CONTAINERS = 50;

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

function services(text: string): Record<string, Record<string, unknown>> {
  return ((parse(text) as Record<string, any>)?.services ?? {}) as Record<string, Record<string, unknown>>;
}

/** Structural diff of two compose files; reports keys only, never values (R3). */
export function composeDrift(repoText: string, deployedText: string) {
  const repo = services(repoText);
  const deployed = services(deployedText);
  const changed: Array<{ service: string; keys: string[] }> = [];
  for (const name of Object.keys(repo)) {
    if (!(name in deployed)) continue;
    const a = repo[name] ?? {};
    const b = deployed[name] ?? {};
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
      (k) => stableStringify(a[k]) !== stableStringify(b[k]),
    );
    if (keys.length) changed.push({ service: name, keys: keys.sort() });
  }
  return {
    onlyInRepo: Object.keys(repo).filter((s) => !(s in deployed)),
    onlyDeployed: Object.keys(deployed).filter((s) => !(s in repo)),
    changed,
  };
}

export function auditTools(deps: { pve?: ProxmoxClient; ptr?: PortainerClient; stacks: StacksRepo }): ToolDef[] {
  const { pve, ptr, stacks } = deps;
  const tools: ToolDef[] = [
    defineTool({
      name: "audit_compose",
      title: "Audit compose file",
      description:
        "Security audit of a compose definition: either stacks/<app> in this repo (app) or a stack deployed in Portainer (stack). Returns findings with severity and fix.",
      level: "read",
      input: { app: appSchema.optional(), stack: stackRefSchema.optional() },
      handler: async ({ app, stack }) => {
        if ((app === undefined) === (stack === undefined)) throw new ToolError("pass exactly one of app or stack");
        if (app !== undefined) return { source: `stacks/${app}`, ...summarize(auditCompose(stacks.readCompose(app), app)) };
        if (!ptr) throw new ToolError("Portainer is not configured");
        const s = await resolveStack(ptr, stack!);
        return { source: `portainer stack ${s.Name}`, ...summarize(auditCompose(await ptr.getStackFile(s.Id), s.Name)) };
      },
    }),
  ];

  if (ptr) {
    tools.push(
      defineTool({
        name: "audit_containers",
        title: "Audit running containers",
        description: `Security audit of containers as actually running (runtime config can differ from compose). Optionally limit to one stack or container; at most ${MAX_CONTAINERS} containers.`,
        level: "read",
        input: {
          endpointId: endpointIdSchema,
          stack: z.string().optional().describe("Only containers of this compose project / stack name"),
          container: containerSchema.optional(),
        },
        handler: async ({ endpointId, stack, container }) => {
          const id = await ptr.resolveEndpoint(endpointId);
          let ids: string[];
          if (container) {
            ids = [container];
          } else {
            const list = await ptr.listContainers(id, false);
            ids = list
              .filter((c: Record<string, any>) => !stack || c.Labels?.["com.docker.compose.project"] === stack)
              .map((c) => String(c.Id));
          }
          const truncated = ids.length > MAX_CONTAINERS;
          const findings: Finding[] = [];
          for (const cid of ids.slice(0, MAX_CONTAINERS)) findings.push(...auditContainer(await ptr.inspectContainer(id, cid)));
          return { endpointId: id, containers: Math.min(ids.length, MAX_CONTAINERS), truncated, ...summarize(findings) };
        },
      }),
      defineTool({
        name: "stack_drift",
        title: "Stack drift",
        description:
          "Compare stacks/<app> in this repo with the Portainer stack of the same name: services added/removed, which service keys differ, and env variable names on each side (no values).",
        level: "read",
        input: { app: appSchema },
        handler: async ({ app }) => {
          const repoText = stacks.readCompose(app);
          const s = await ptr.findStackByName(app);
          if (!s) return { app, deployed: false, note: `no Portainer stack named '${app}'` };
          const drift = composeDrift(repoText, await ptr.getStackFile(s.Id));
          const repoEnv = stacks.envNames(app);
          const deployedEnv = (s.Env ?? []).map((e) => e.name).sort();
          const inSync =
            !drift.onlyInRepo.length && !drift.onlyDeployed.length && !drift.changed.length && stableStringify(repoEnv) === stableStringify(deployedEnv);
          return {
            app,
            stackId: s.Id,
            inSync,
            ...drift,
            env: {
              onlyInRepo: repoEnv.filter((n) => !deployedEnv.includes(n)),
              onlyDeployed: deployedEnv.filter((n) => !repoEnv.includes(n)),
            },
          };
        },
      }),
    );
  }

  if (pve) {
    tools.push(
      defineTool({
        name: "audit_docker_lxc",
        title: "Audit Docker LXC",
        description:
          "Security audit of the Proxmox LXC that hosts Docker: privilege mode, features, raw lxc overrides, host mounts, firewall, boot/protection flags, and backups.",
        level: "read",
        input: { vmid: vmidSchema },
        handler: async ({ vmid }) => {
          const { guest, config } = await pve.guestConfig(vmid);
          if (guest.type !== "lxc") throw new ToolError(`guest ${vmid} is a ${guest.type}, not an LXC`);
          const notes: string[] = [];
          const firewallOptions = await pve
            .guestFirewall(vmid)
            .then((r) => r.options)
            .catch((e: Error) => {
              notes.push(`firewall options unavailable: ${e.message}`);
              return undefined;
            });
          const backups = await pve.listBackups(vmid).catch((e: Error) => {
            notes.push(`backups unavailable (backup findings skipped): ${e.message}`);
            return undefined;
          });
          const findings = auditLxc({ vmid, config, firewallOptions, backups: backups ?? [] }).filter(
            (f) => backups !== undefined || !["no-backups", "stale-backup"].includes(f.rule),
          );
          return { vmid, node: guest.node, name: guest.name, ...summarize(findings), notes: notes.length ? notes : undefined };
        },
      }),
    );
  }
  return tools;
}

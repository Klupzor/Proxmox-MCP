import { parse } from "yaml";
import { ToolError } from "../errors.js";
import type { Finding } from "./findings.js";
import { checkService, type ServiceSpec } from "./serviceRules.js";

type Dict = Record<string, any>;

const isDefined = <T>(v: T | undefined): v is T => v !== undefined;

function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") return [v];
  return [];
}

function parseEnv(env: unknown): Array<{ key: string; value: string }> {
  if (Array.isArray(env)) {
    return env.map(String).map((e) => {
      const i = e.indexOf("=");
      return i === -1 ? { key: e, value: "" } : { key: e.slice(0, i), value: e.slice(i + 1) };
    });
  }
  if (env && typeof env === "object") {
    return Object.entries(env as Dict).map(([key, value]) => ({ key, value: value == null ? "" : String(value) }));
  }
  return [];
}

function parsePort(p: unknown): ServiceSpec["ports"][number] | undefined {
  if (p && typeof p === "object") {
    const o = p as Dict;
    if (o.target === undefined) return undefined;
    return { hostIp: o.host_ip, published: o.published?.toString(), target: String(o.target) };
  }
  const str = String(p).replace(/\/(tcp|udp|sctp)$/, "");
  // [ip:]published:target | target ; ip may be [ipv6]
  const m = /^(?:(\[[^\]]+\]|[^:]+):)?(?:([^:]*):)?([^:]+)$/.exec(str);
  if (!m) return undefined;
  const [, a, b, target] = m;
  if (b !== undefined) return { hostIp: a?.replace(/^\[|\]$/g, ""), published: b, target: target! };
  if (a !== undefined) return { published: a, target: target! };
  return { target: target! };
}

function parseVolume(v: unknown): ServiceSpec["mounts"][number] | undefined {
  if (v && typeof v === "object") {
    const o = v as Dict;
    return { source: String(o.source ?? ""), target: String(o.target ?? ""), readOnly: Boolean(o.read_only), type: String(o.type ?? "volume") };
  }
  const parts = String(v).split(":");
  if (parts.length === 1) return { source: "", target: parts[0]!, readOnly: false, type: "volume" };
  const [source, target, mode = ""] = parts as [string, string, string?];
  const isBind = /^(\/|\.|~|\$)/.test(source);
  return { source, target, readOnly: mode.split(",").includes("ro"), type: isBind ? "bind" : "volume" };
}

export function composeToSpecs(text: string): ServiceSpec[] {
  let doc: Dict;
  try {
    doc = parse(text) as Dict;
  } catch (err) {
    throw new ToolError(`compose file is not valid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  const services = doc?.services;
  if (!services || typeof services !== "object") throw new ToolError("compose file has no `services` section");

  return Object.entries(services as Dict).map(([name, svc]: [string, Dict]) => {
    svc ??= {};
    const limits = svc.deploy?.resources?.limits ?? {};
    return {
      name,
      source: "compose",
      image: svc.image,
      privileged: svc.privileged === true,
      networkMode: svc.network_mode,
      pidMode: svc.pid,
      ipcMode: svc.ipc,
      capAdd: asList(svc.cap_add),
      securityOpt: asList(svc.security_opt),
      user: svc.user === undefined ? undefined : String(svc.user),
      ports: (Array.isArray(svc.ports) ? svc.ports : []).map(parsePort).filter(isDefined),
      mounts: (Array.isArray(svc.volumes) ? svc.volumes : []).map(parseVolume).filter(isDefined),
      restart: svc.restart ?? svc.deploy?.restart_policy?.condition,
      hasHealthcheck: svc.healthcheck !== undefined && svc.healthcheck?.disable !== true,
      hasMemoryLimit: svc.mem_limit !== undefined || limits.memory !== undefined,
      hasCpuLimit: svc.cpus !== undefined || limits.cpus !== undefined,
      readOnlyRootfs: svc.read_only === true,
      devices: asList(svc.devices).map((d) => (typeof d === "string" ? d : JSON.stringify(d))),
      env: parseEnv(svc.environment),
    } satisfies ServiceSpec;
  });
}

export function auditCompose(text: string, stackName: string): Finding[] {
  return composeToSpecs(text).flatMap((s) =>
    checkService(s).map((f) => ({ ...f, target: `${stackName}/${f.target}` })),
  );
}

import type { Finding } from "./findings.js";
import { checkService, type ServiceSpec } from "./serviceRules.js";

/** Normalize a Docker `containers/{id}/json` inspect result. */
export function containerToSpec(c: Record<string, any>): ServiceSpec {
  const hc = c.HostConfig ?? {};
  const cfg = c.Config ?? {};
  const ports: ServiceSpec["ports"] = [];
  for (const [target, bindings] of Object.entries((hc.PortBindings ?? {}) as Record<string, any[] | null>)) {
    for (const b of bindings ?? []) ports.push({ hostIp: b.HostIp ?? "", published: b.HostPort, target });
  }
  return {
    name: String(c.Name ?? c.Id ?? "container").replace(/^\//, ""),
    source: "container",
    image: cfg.Image,
    privileged: hc.Privileged === true,
    networkMode: hc.NetworkMode,
    pidMode: hc.PidMode || undefined,
    ipcMode: hc.IpcMode,
    capAdd: hc.CapAdd ?? [],
    securityOpt: hc.SecurityOpt ?? [],
    user: cfg.User || undefined,
    ports,
    mounts: ((c.Mounts ?? []) as any[]).map((m) => ({
      source: String(m.Source ?? ""),
      target: String(m.Destination ?? ""),
      readOnly: m.RW === false,
      type: String(m.Type ?? "volume"),
    })),
    restart: hc.RestartPolicy?.Name || undefined,
    hasHealthcheck: Boolean(cfg.Healthcheck?.Test?.length) && cfg.Healthcheck.Test[0] !== "NONE",
    hasMemoryLimit: (hc.Memory ?? 0) > 0,
    hasCpuLimit: (hc.NanoCpus ?? 0) > 0 || (hc.CpuQuota ?? 0) > 0,
    readOnlyRootfs: hc.ReadonlyRootfs === true,
    devices: ((hc.Devices ?? []) as any[]).map((d) => d.PathOnHost),
  };
}

export function auditContainer(inspect: Record<string, any>): Finding[] {
  return checkService(containerToSpec(inspect));
}

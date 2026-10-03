import type { Backup } from "../clients/proxmox.js";
import type { Finding } from "./findings.js";

export interface LxcAuditInput {
  vmid: number;
  config: Record<string, any>;
  firewallOptions?: Record<string, any>;
  backups: Backup[];
  nowSeconds?: number;
}

const SENSITIVE_HOST_PREFIXES = ["/", "/etc", "/root", "/var/lib/vz", "/etc/pve", "/dev", "/proc", "/sys", "/boot", "/var/run", "/run"];

function parseProps(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of value.split(",")) {
    const i = part.indexOf("=");
    if (i === -1) out[""] = part;
    else out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

/** Raw `lxc.*` keys come back from the API as [key, value] pairs. */
function rawLxc(config: Record<string, any>): Array<[string, string]> {
  return Array.isArray(config.lxc) ? (config.lxc as Array<[string, string]>) : [];
}

export function auditLxc(input: LxcAuditInput): Finding[] {
  const { vmid, config } = input;
  const target = `lxc/${vmid}${config.hostname ? ` (${config.hostname})` : ""}`;
  const f: Finding[] = [];
  const add = (severity: Finding["severity"], rule: string, issue: string, fix: string) =>
    f.push({ severity, target, rule, issue, fix });

  if (Number(config.unprivileged) !== 1) {
    add("high", "privileged-lxc", "Container is privileged: root inside the LXC (and any Docker container escape) is root on the Proxmox host.", "Migrate Docker to an unprivileged LXC (backup, restore with --unprivileged 1, fix bind-mount ownership), or move it to a VM.");
  }

  const features = parseProps(String(config.features ?? ""));
  if (features.nesting !== "1") {
    add("low", "nesting-disabled", "`nesting` feature is off; Docker in LXC usually needs it.", "Enable `features: nesting=1` (safe on unprivileged containers).");
  }
  if (Number(config.unprivileged) === 1 && features.keyctl !== "1") {
    add("low", "keyctl-disabled", "`keyctl` is off on an unprivileged LXC; some Docker images fail without it.", "Enable `features: keyctl=1` if containers fail with keyring errors.");
  }
  if (features.mknod === "1") {
    add("medium", "mknod-enabled", "`mknod` feature lets the container create device nodes.", "Disable `mknod` unless a workload strictly requires it.");
  }

  for (const [key, value] of rawLxc(config)) {
    const v = String(value);
    if (key === "lxc.apparmor.profile" && v === "unconfined") {
      add("high", "apparmor-unconfined", "AppArmor is disabled for the container (lxc.apparmor.profile: unconfined).", "Remove the raw `lxc.apparmor.profile` override.");
    } else if (key === "lxc.cap.drop" && v.trim() === "") {
      add("high", "no-cap-drop", "All default capability drops are cleared (lxc.cap.drop empty).", "Remove the empty `lxc.cap.drop` override.");
    } else if (/^lxc\.cgroup2?\.devices\.allow$/.test(key) && /^a\b/.test(v.trim())) {
      add("high", "all-devices", "Container is allowed access to all host devices.", "Allow only specific device majors/minors (e.g. `c 226:* rwm` for /dev/dri).");
    } else if (key === "lxc.mount.auto" && /(proc|sys):rw/.test(v)) {
      add("high", "rw-proc-sys", `Host /proc or /sys mounted read-write (${v}).`, "Remove the `lxc.mount.auto` override.");
    } else if (key === "lxc.mount.entry") {
      add("medium", "raw-mount-entry", `Raw mount entry: ${v}.`, "Prefer `mpX` mount points so Proxmox manages them; confirm the host path is not sensitive.");
    }
  }

  for (const [key, value] of Object.entries(config)) {
    if (!/^mp\d+$/.test(key)) continue;
    const props = parseProps(String(value));
    const source = props[""] ?? "";
    if (!source.startsWith("/")) continue;
    const ro = props.ro === "1";
    const sensitive = SENSITIVE_HOST_PREFIXES.some((p) => source === p || (p !== "/" && source.startsWith(`${p}/`)));
    if (sensitive) {
      add(ro ? "medium" : "high", "sensitive-host-mount", `${key} bind-mounts host path ${source} -> ${props.mp}${ro ? " (ro)" : " (rw)"}.`, "Bind-mount a dedicated data directory instead.");
    }
  }

  const nets = Object.entries(config).filter(([k]) => /^net\d+$/.test(k));
  const unfirewalled = nets.filter(([, v]) => parseProps(String(v)).firewall !== "1").map(([k]) => k);
  if (unfirewalled.length > 0) {
    add("medium", "nic-firewall-off", `Proxmox firewall is not enabled on ${unfirewalled.join(", ")}.`, "Set `firewall=1` on the interface(s) so guest firewall rules apply.");
  }
  if (input.firewallOptions && Number(input.firewallOptions.enable) !== 1) {
    add("medium", "guest-firewall-off", "Guest-level firewall is disabled.", "Enable the guest firewall and add rules allowing only the published app ports (and Portainer agent/API).");
  }

  if (Number(config.onboot) !== 1) {
    add("low", "no-onboot", "Container does not start on boot; apps stay down after a host reboot.", "Set `onboot: 1`.");
  }
  if (Number(config.protection) !== 1) {
    add("low", "no-protection", "Protection flag is off; the container can be removed accidentally.", "Set `protection: 1`.");
  }

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const mine = input.backups.filter((b) => Number(b.vmid) === vmid);
  if (mine.length === 0) {
    add("medium", "no-backups", "No vzdump backups found for this container on any backup storage.", "Create a scheduled backup job (Datacenter -> Backup) for this LXC.");
  } else {
    const newest = Math.max(...mine.map((b) => b.ctime ?? 0));
    const ageDays = Math.floor((now - newest) / 86400);
    if (ageDays > 7) add("low", "stale-backup", `Newest backup is ${ageDays} days old.`, "Check that the scheduled backup job is running.");
  }
  return f;
}

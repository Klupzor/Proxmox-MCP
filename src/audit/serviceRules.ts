import { isInterpolation, isSecretKey } from "../security/redact.js";
import type { Finding } from "./findings.js";

/** A service definition normalized from either a compose file or a running container. */
export interface ServiceSpec {
  name: string;
  source: "compose" | "container";
  image?: string;
  privileged: boolean;
  networkMode?: string;
  pidMode?: string;
  ipcMode?: string;
  capAdd: string[];
  securityOpt: string[];
  user?: string;
  ports: Array<{ hostIp?: string; published?: string; target: string }>;
  mounts: Array<{ source: string; target: string; readOnly: boolean; type: string }>;
  restart?: string;
  hasHealthcheck?: boolean;
  hasMemoryLimit: boolean;
  hasCpuLimit: boolean;
  readOnlyRootfs: boolean;
  devices: string[];
  /** Only for compose: plaintext env values are a finding; resolved runtime env is not. */
  env?: Array<{ key: string; value: string }>;
}

const HIGH_CAPS = new Set(["ALL", "SYS_ADMIN", "SYS_MODULE", "SYS_PTRACE", "SYS_RAWIO", "DAC_READ_SEARCH", "SYS_BOOT"]);
const MEDIUM_CAPS = new Set(["NET_ADMIN", "NET_RAW", "SYS_TIME", "MKNOD", "SETFCAP"]);
const SENSITIVE_HOST_PATHS = [
  "/",
  "/etc",
  "/root",
  "/home",
  "/boot",
  "/proc",
  "/sys",
  "/dev",
  "/var/lib/docker",
  "/var/run",
  "/run",
  "/usr",
  "/lib",
];

function isSensitiveHostPath(p: string): boolean {
  const norm = p.replace(/\/+$/, "") || "/";
  return SENSITIVE_HOST_PATHS.some((s) => norm === s || (s !== "/" && norm.startsWith(`${s}/`)));
}

function isDockerSocket(p: string): boolean {
  return /(^|\/)docker\.sock$/.test(p);
}

export function checkService(s: ServiceSpec): Finding[] {
  const f: Finding[] = [];
  const add = (severity: Finding["severity"], rule: string, issue: string, fix: string) =>
    f.push({ severity, target: s.name, rule, issue, fix });

  if (s.privileged) {
    add("high", "privileged", "Runs privileged: full access to host devices and kernel capabilities.", "Remove `privileged: true`; grant only the specific capabilities/devices needed.");
  }
  if (s.networkMode === "host") {
    add("high", "host-network", "Uses the host network namespace; every listening port is exposed on the host.", "Use a bridge/user-defined network and publish only required ports.");
  }
  if (s.pidMode === "host") {
    add("high", "host-pid", "Shares the host PID namespace; can see and signal host processes.", "Remove `pid: host`.");
  }
  if (s.ipcMode === "host") {
    add("medium", "host-ipc", "Shares the host IPC namespace.", "Remove `ipc: host`.");
  }
  for (const cap of s.capAdd.map((c) => c.toUpperCase().replace(/^CAP_/, ""))) {
    if (HIGH_CAPS.has(cap)) add("high", "dangerous-capability", `Adds capability ${cap}, which allows container escape or host tampering.`, `Drop ${cap} from cap_add; find a narrower capability if possible.`);
    else if (MEDIUM_CAPS.has(cap)) add("medium", "elevated-capability", `Adds capability ${cap}.`, `Keep ${cap} only if strictly required (e.g. VPN/network tools).`);
  }
  const secOpts = s.securityOpt.map((o) => o.toLowerCase().replace("=", ":"));
  if (secOpts.some((o) => /^(seccomp|apparmor):unconfined$/.test(o))) {
    add("high", "unconfined-profile", "Disables seccomp or AppArmor confinement.", "Remove the `*:unconfined` security_opt.");
  }
  if (!secOpts.some((o) => /^no-new-privileges(:true)?$/.test(o))) {
    add("low", "no-new-privileges", "`no-new-privileges` is not set; setuid binaries can escalate privileges.", "Add `security_opt: [\"no-new-privileges:true\"]`.");
  }

  const user = s.user?.trim();
  if (!user) {
    add("medium", "runs-as-root", "No user set; runs as the image default user, which is usually root.", "Set `user: \"<uid>:<gid>\"` (non-root) if the image supports it, or use the image's PUID/PGID options.");
  } else if (/^(root|0)(:|$)/.test(user)) {
    add("medium", "runs-as-root", `Explicitly runs as root (${user}).`, "Run as a non-root UID/GID.");
  }

  if (s.image) {
    const ref = s.image.split("@")[0]!;
    const lastSegment = ref.split("/").pop() ?? ref;
    const hasDigest = s.image.includes("@sha256:");
    if (!hasDigest && (!lastSegment.includes(":") || lastSegment.endsWith(":latest"))) {
      add("medium", "unpinned-image", `Image '${s.image}' uses an implicit or :latest tag; updates are unreviewed and not reproducible.`, "Pin a specific version tag (or a digest) and bump it deliberately.");
    }
  }

  for (const e of s.env ?? []) {
    if (isSecretKey(e.key) && e.value !== "" && !isInterpolation(e.value)) {
      add("high", "plaintext-secret", `Environment variable ${e.key} holds a plaintext secret in the compose file.`, `Reference it as \`${e.key}: \${${e.key}}\` and put the value in the stack's gitignored .env.`);
    }
  }

  for (const p of s.ports) {
    const ip = p.hostIp ?? "";
    if (ip === "" || ip === "0.0.0.0" || ip === "::") {
      add("medium", "port-all-interfaces", `Port ${p.published ? `${p.published}->` : ""}${p.target} is published on all host interfaces.`, `Bind to a specific interface (e.g. \`127.0.0.1:${p.published ?? p.target}:${p.target}\`) or expose it only through a reverse proxy network.`);
    }
  }

  for (const m of s.mounts) {
    if (m.type !== "bind") continue;
    if (isDockerSocket(m.source)) {
      add("high", "docker-socket", `Mounts the Docker socket (${m.source}); this is root-equivalent on the Docker host${m.readOnly ? " even when read-only" : ""}.`, "Remove the mount, or put a filtering socket proxy (e.g. tecnativa/docker-socket-proxy) in front of it.");
    } else if (isSensitiveHostPath(m.source)) {
      add(m.readOnly ? "medium" : "high", "sensitive-bind-mount", `Bind-mounts sensitive host path ${m.source} -> ${m.target}${m.readOnly ? " (read-only)" : " read-write"}.`, "Mount only the specific subdirectory needed, read-only where possible.");
    }
  }

  if (s.devices.length > 0) {
    add("medium", "host-devices", `Maps host devices: ${s.devices.join(", ")}.`, "Keep only devices the app needs (e.g. a specific /dev/dri render node).");
  }
  if (!s.restart || s.restart === "no") {
    add("low", "no-restart-policy", "No restart policy; the app stays down after a crash or host reboot.", "Set `restart: unless-stopped`.");
  }
  if (s.hasHealthcheck === false) {
    add("low", "no-healthcheck", s.source === "compose" ? "No healthcheck defined in compose (the image may define one)." : "No healthcheck configured.", "Add a `healthcheck:` so failures are detected and dependents can wait on it.");
  }
  if (!s.hasMemoryLimit || !s.hasCpuLimit) {
    const missing = [!s.hasMemoryLimit && "memory", !s.hasCpuLimit && "CPU"].filter(Boolean).join(" and ");
    add("low", "no-resource-limits", `No ${missing} limit; a runaway container can starve the whole Docker LXC.`, "Set `mem_limit`/`cpus` (or `deploy.resources.limits`).");
  }
  if (!s.readOnlyRootfs) {
    add("low", "writable-rootfs", "Root filesystem is writable.", "Consider `read_only: true` with `tmpfs` for scratch paths, if the app tolerates it.");
  }
  return f;
}

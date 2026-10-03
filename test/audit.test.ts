import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { auditCompose, composeToSpecs } from "../src/audit/composeRules.js";
import { auditContainer } from "../src/audit/containerRules.js";
import { auditLxc } from "../src/audit/lxcRules.js";
import { requiredComposeVars } from "../src/stacks.js";
import { composeDrift } from "../src/tools/audit.js";

const fixture = (app: string) => fs.readFileSync(path.join(__dirname, "fixtures/stacks", app, "compose.yaml"), "utf8");
const rules = (findings: Array<{ rule: string; target: string }>, target?: string) =>
  findings.filter((f) => !target || f.target.endsWith(target)).map((f) => f.rule);

describe("compose audit", () => {
  const findings = auditCompose(fixture("webapp"), "webapp");

  it("flags the dangerous settings", () => {
    const app = rules(findings, "/app");
    expect(app).toEqual(
      expect.arrayContaining([
        "privileged",
        "host-network",
        "docker-socket",
        "sensitive-bind-mount",
        "dangerous-capability",
        "unpinned-image",
        "plaintext-secret",
        "runs-as-root",
      ]),
    );
    // ${API_TOKEN} is interpolated, so only DB_PASSWORD is a plaintext secret on app.
    expect(findings.filter((f) => f.target === "webapp/app" && f.rule === "plaintext-secret")).toHaveLength(1);
    expect(rules(findings, "/db")).toEqual(expect.arrayContaining(["unpinned-image", "port-all-interfaces", "plaintext-secret"]));
  });

  it("finds nothing serious in a hardened stack", () => {
    const hardened = auditCompose(fixture("hardened"), "hardened");
    expect(hardened.filter((f) => f.severity !== "low")).toEqual([]);
    expect(hardened.map((f) => f.rule)).toEqual([]);
  });

  it("parses port syntaxes", () => {
    const [svc] = composeToSpecs(
      "services:\n  a:\n    ports:\n      - '127.0.0.1:80:8080'\n      - '443:8443/tcp'\n      - '9000'\n      - target: 53\n        published: 53\n        host_ip: 10.0.0.2\n",
    );
    expect(svc!.ports).toEqual([
      { hostIp: "127.0.0.1", published: "80", target: "8080" },
      { published: "443", target: "8443" },
      { target: "9000" },
      { hostIp: "10.0.0.2", published: "53", target: "53" },
    ]);
  });
});

describe("container audit", () => {
  it("audits runtime inspect data", () => {
    const findings = auditContainer({
      Name: "/plex",
      Config: { Image: "plexinc/pms-docker", User: "", Env: ["PLEX_CLAIM=claim-x"] },
      HostConfig: {
        Privileged: false,
        NetworkMode: "host",
        CapAdd: ["NET_ADMIN"],
        PortBindings: { "32400/tcp": [{ HostIp: "", HostPort: "32400" }] },
        RestartPolicy: { Name: "unless-stopped" },
        Memory: 0,
      },
      Mounts: [{ Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock", RW: false }],
    });
    expect(rules(findings)).toEqual(
      expect.arrayContaining(["host-network", "elevated-capability", "port-all-interfaces", "docker-socket", "unpinned-image", "runs-as-root"]),
    );
    expect(rules(findings)).not.toContain("plaintext-secret");
  });
});

describe("LXC audit", () => {
  const now = 1_800_000_000;
  it("flags a privileged, unfirewalled, unbacked-up Docker LXC", () => {
    const findings = auditLxc({
      vmid: 105,
      config: {
        hostname: "docker",
        features: "nesting=1",
        net0: "name=eth0,bridge=vmbr0,ip=dhcp",
        mp0: "/etc/pve,mp=/mnt/pve",
        lxc: [["lxc.apparmor.profile", "unconfined"], ["lxc.cgroup2.devices.allow", "a"]],
      },
      firewallOptions: { enable: 0 },
      backups: [],
      nowSeconds: now,
    });
    expect(rules(findings)).toEqual(
      expect.arrayContaining([
        "privileged-lxc",
        "apparmor-unconfined",
        "all-devices",
        "sensitive-host-mount",
        "nic-firewall-off",
        "guest-firewall-off",
        "no-backups",
        "no-onboot",
      ]),
    );
  });

  it("accepts a well-configured unprivileged LXC", () => {
    const findings = auditLxc({
      vmid: 105,
      config: {
        unprivileged: 1,
        features: "keyctl=1,nesting=1",
        net0: "name=eth0,bridge=vmbr0,firewall=1,ip=dhcp",
        mp0: "/tank/appdata,mp=/srv/appdata",
        onboot: 1,
        protection: 1,
      },
      firewallOptions: { enable: 1 },
      backups: [{ node: "pve", storage: "pbs", volid: "pbs:backup/ct/105", vmid: 105, ctime: now - 3600 }],
      nowSeconds: now,
    });
    expect(findings).toEqual([]);
  });
});

describe("stack helpers", () => {
  it("finds required compose variables", () => {
    expect(requiredComposeVars(fixture("hardened"))).toEqual(["ADMIN_PASSWORD"]);
    expect(requiredComposeVars("a: ${A}\nb: $B\nc: ${C:-x}\nd: $$NOT\ne: ${E?err}")).toEqual(["A", "B", "E"]);
  });

  it("reports structural drift by key only", () => {
    const drift = composeDrift(
      "services:\n  web:\n    image: nginx:1.27\n    environment:\n      PASSWORD: a\n  worker:\n    image: w:1\n",
      "services:\n  web:\n    image: nginx:1.26\n    environment:\n      PASSWORD: b\n  cron:\n    image: c:1\n",
    );
    expect(drift).toEqual({
      onlyInRepo: ["worker"],
      onlyDeployed: ["cron"],
      changed: [{ service: "web", keys: ["environment", "image"] }],
    });
    expect(JSON.stringify(drift)).not.toMatch(/PASSWORD|nginx/);
  });
});

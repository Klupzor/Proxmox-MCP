import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { demuxDockerStream, PortainerClient } from "../src/clients/portainer.js";
import { ProxmoxClient } from "../src/clients/proxmox.js";

let agent: MockAgent;
beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
});
afterEach(() => agent.close());

const pveCfg = {
  url: "https://pve.test:8006",
  tokenId: "mcp@pve!ro",
  tokenSecret: "s3cret-uuid",
  allowedNodes: [] as string[],
  allowedVmids: [105],
};

describe("ProxmoxClient", () => {
  it("authenticates with an API token and filters by allowlist", async () => {
    agent
      .get("https://pve.test:8006")
      .intercept({
        path: "/api2/json/cluster/resources?type=vm",
        method: "GET",
        headers: { authorization: "PVEAPIToken=mcp@pve!ro=s3cret-uuid" },
      })
      .reply(200, {
        data: [
          { vmid: 105, node: "pve", type: "lxc", status: "running", name: "docker" },
          { vmid: 200, node: "pve", type: "qemu", status: "running", name: "other" },
        ],
      });
    const pve = new ProxmoxClient(pveCfg, 5000, agent);
    expect((await pve.listGuests()).map((g) => g.vmid)).toEqual([105]);
  });

  it("refuses non-allowlisted VMIDs before calling the API", async () => {
    const pve = new ProxmoxClient(pveCfg, 5000, agent);
    await expect(pve.guestAction(200, "stop")).rejects.toThrow(/not in the configured allowlist/);
  });

  it("returns short, redacted errors without the raw body", async () => {
    agent
      .get("https://pve.test:8006")
      .intercept({ path: "/api2/json/nodes", method: "GET" })
      .reply(401, "<html>secret page PVEAPIToken=leak</html>");
    const pve = new ProxmoxClient({ ...pveCfg, allowedVmids: [] }, 5000, agent);
    const err = await pve.listNodes().catch((e: Error) => e);
    expect((err as Error).message).toMatch(/HTTP 401/);
    expect((err as Error).message).toMatch(/docs\/setup\.md/);
    expect((err as Error).message).not.toMatch(/leak|html/);
  });
});

describe("PortainerClient", () => {
  it("sends the API key and resolves the only endpoint", async () => {
    agent
      .get("https://ptr.test:9443")
      .intercept({ path: "/api/endpoints", method: "GET", headers: { "x-api-key": "ptr_key" } })
      .reply(200, [{ Id: 2, Name: "docker-lxc", Type: 1, Status: 1 }]);
    const ptr = new PortainerClient({ url: "https://ptr.test:9443", apiKey: "ptr_key", allowedEndpoints: [] }, 5000, agent);
    expect(await ptr.resolveEndpoint()).toBe(2);
  });

  it("runs an exec and returns demuxed output with the exit code", async () => {
    const pool = agent.get("https://ptr.test:9443");
    const frame = Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 0, 0, 3]), Buffer.from("ok\n")]);
    pool
      .intercept({
        path: "/api/endpoints/3/docker/containers/abc/exec",
        method: "POST",
        body: (b) => JSON.parse(b).User === "www-data" && JSON.parse(b).Cmd[0] === "php",
      })
      .reply(201, { Id: "ex1" });
    pool.intercept({ path: "/api/endpoints/3/docker/exec/ex1/start", method: "POST" }).reply(200, frame);
    pool.intercept({ path: "/api/endpoints/3/docker/exec/ex1/json", method: "GET" }).reply(200, { ExitCode: 0, Running: false });
    const ptr = new PortainerClient({ url: "https://ptr.test:9443", apiKey: "k", allowedEndpoints: [3] }, 5000, agent);
    expect(await ptr.execInContainer(3, "abc", ["php", "occ", "status"], "www-data", 60000)).toEqual({ exitCode: 0, output: "ok\n" });
  });

  it("refuses endpoints outside the allowlist", async () => {
    const ptr = new PortainerClient({ url: "https://ptr.test:9443", apiKey: "k", allowedEndpoints: [2] }, 5000, agent);
    expect(() => ptr.listImages(3)).toThrow(/not in the configured allowlist/);
  });
});

describe("demuxDockerStream", () => {
  it("strips multiplexed frame headers", () => {
    const frame = (stream: number, text: string) => {
      const body = Buffer.from(text);
      const head = Buffer.alloc(8);
      head[0] = stream;
      head.writeUInt32BE(body.length, 4);
      return Buffer.concat([head, body]);
    };
    expect(demuxDockerStream(Buffer.concat([frame(1, "out\n"), frame(2, "err\n")]))).toBe("out\nerr\n");
    expect(demuxDockerStream(Buffer.from("plain tty output"))).toBe("plain tty output");
  });
});

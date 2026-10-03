import type { Dispatcher } from "undici";
import type { ProxmoxConfig } from "../config.js";
import { ToolError } from "../errors.js";
import { HttpClient, type RequestOptions } from "../http.js";
import { Allowlist } from "../security/allowlist.js";

export type GuestType = "qemu" | "lxc";

export interface Guest {
  vmid: number;
  node: string;
  type: GuestType;
  name?: string;
  status: string;
  template?: number;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
  tags?: string;
}

export interface Backup {
  node: string;
  storage: string;
  volid: string;
  vmid?: number;
  ctime?: number;
  size?: number;
  notes?: string;
  protected?: number;
}

export type GuestAction = "start" | "shutdown" | "reboot" | "stop";

export class ProxmoxClient {
  private readonly http: HttpClient;
  readonly nodes: Allowlist<string>;
  readonly vmids: Allowlist<number>;

  constructor(cfg: ProxmoxConfig, timeoutMs: number, dispatcher?: Dispatcher) {
    this.http = new HttpClient({
      baseUrl: `${cfg.url}/api2/json`,
      headers: { Authorization: `PVEAPIToken=${cfg.tokenId}=${cfg.tokenSecret}` },
      ca: cfg.ca,
      timeoutMs,
      dispatcher,
    });
    this.nodes = new Allowlist("Proxmox node", cfg.allowedNodes);
    this.vmids = new Allowlist("VMID", cfg.allowedVmids);
  }

  private async call<T>(method: string, path: string, req?: RequestOptions): Promise<T> {
    const res = await this.http.json<{ data: T }>(method, path, req);
    return res?.data;
  }

  async listNodes(): Promise<Array<Record<string, unknown> & { node: string }>> {
    const nodes = await this.call<Array<Record<string, unknown> & { node: string }>>("GET", "/nodes");
    return this.nodes.filter(nodes, (n) => n.node);
  }

  async listGuests(): Promise<Guest[]> {
    const all = await this.call<Guest[]>("GET", "/cluster/resources", { query: { type: "vm" } });
    return all.filter((g) => this.nodes.allows(g.node) && this.vmids.allows(g.vmid));
  }

  /** Locate a guest by VMID and enforce both allowlists. */
  async resolveGuest(vmid: number): Promise<Guest> {
    this.vmids.assert(vmid);
    const all = await this.call<Guest[]>("GET", "/cluster/resources", { query: { type: "vm" } });
    const guest = all.find((g) => g.vmid === vmid);
    if (!guest) throw new ToolError(`guest ${vmid} not found`);
    this.nodes.assert(guest.node);
    return guest;
  }

  private guestPath(g: Guest): string {
    return `/nodes/${encodeURIComponent(g.node)}/${g.type}/${g.vmid}`;
  }

  async guestStatus(vmid: number): Promise<Record<string, unknown>> {
    const g = await this.resolveGuest(vmid);
    const status = await this.call<Record<string, unknown>>("GET", `${this.guestPath(g)}/status/current`);
    return { node: g.node, type: g.type, ...status };
  }

  async guestConfig(vmid: number): Promise<{ guest: Guest; config: Record<string, unknown> }> {
    const g = await this.resolveGuest(vmid);
    const config = await this.call<Record<string, unknown>>("GET", `${this.guestPath(g)}/config`);
    return { guest: g, config };
  }

  async listSnapshots(vmid: number): Promise<Array<Record<string, unknown>>> {
    const g = await this.resolveGuest(vmid);
    return this.call("GET", `${this.guestPath(g)}/snapshot`);
  }

  async guestFirewall(vmid: number): Promise<{ options: Record<string, unknown>; rules: unknown[] }> {
    const g = await this.resolveGuest(vmid);
    const [options, rules] = await Promise.all([
      this.call<Record<string, unknown>>("GET", `${this.guestPath(g)}/firewall/options`),
      this.call<unknown[]>("GET", `${this.guestPath(g)}/firewall/rules`),
    ]);
    return { options, rules };
  }

  async clusterFirewallOptions(): Promise<Record<string, unknown>> {
    return this.call("GET", "/cluster/firewall/options");
  }

  async nodeFirewallOptions(node: string): Promise<Record<string, unknown>> {
    this.nodes.assert(node);
    return this.call("GET", `/nodes/${encodeURIComponent(node)}/firewall/options`);
  }

  async listBackups(vmid?: number): Promise<Backup[]> {
    if (vmid !== undefined) this.vmids.assert(vmid);
    const out: Backup[] = [];
    for (const { node } of await this.listNodes()) {
      const storages = await this.call<Array<{ storage: string; content?: string; active?: number; enabled?: number }>>(
        "GET",
        `/nodes/${encodeURIComponent(node)}/storage`,
        { query: { content: "backup" } },
      );
      for (const s of storages) {
        if (s.active === 0 || s.enabled === 0) continue;
        const items = await this.call<Backup[]>(
          "GET",
          `/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(s.storage)}/content`,
          { query: { content: "backup", vmid } },
        );
        for (const b of items) {
          if (b.vmid !== undefined && !this.vmids.allows(Number(b.vmid))) continue;
          out.push({ ...b, node, storage: s.storage });
        }
      }
    }
    // Shared storages appear under every node; keep one entry per volume.
    const seen = new Set<string>();
    return out.filter((b) => !seen.has(b.volid) && seen.add(b.volid));
  }

  async taskStatus(node: string, upid: string): Promise<Record<string, unknown>> {
    this.nodes.assert(node);
    return this.call("GET", `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`);
  }

  async guestAction(vmid: number, action: GuestAction): Promise<{ node: string; upid: string }> {
    const g = await this.resolveGuest(vmid);
    const upid = await this.call<string>("POST", `${this.guestPath(g)}/status/${action}`);
    return { node: g.node, upid };
  }

  async createSnapshot(vmid: number, snapname: string, description?: string): Promise<{ node: string; upid: string }> {
    const g = await this.resolveGuest(vmid);
    const upid = await this.call<string>("POST", `${this.guestPath(g)}/snapshot`, {
      form: { snapname, description },
    });
    return { node: g.node, upid };
  }

  async rollbackSnapshot(vmid: number, snapname: string): Promise<{ node: string; upid: string }> {
    const g = await this.resolveGuest(vmid);
    const upid = await this.call<string>(
      "POST",
      `${this.guestPath(g)}/snapshot/${encodeURIComponent(snapname)}/rollback`,
    );
    return { node: g.node, upid };
  }

  async deleteSnapshot(vmid: number, snapname: string): Promise<{ node: string; upid: string }> {
    const g = await this.resolveGuest(vmid);
    const upid = await this.call<string>("DELETE", `${this.guestPath(g)}/snapshot/${encodeURIComponent(snapname)}`);
    return { node: g.node, upid };
  }
}

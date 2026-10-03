import { z } from "zod";
import type { ProxmoxClient } from "../clients/proxmox.js";
import { defineTool, snapnameSchema, type ToolDef, vmidSchema } from "./define.js";

const GB = 1024 ** 3;
const gb = (n?: number) => (n === undefined ? undefined : Math.round((n / GB) * 10) / 10);

export function proxmoxTools(pve: ProxmoxClient): ToolDef[] {
  return [
    // --- read ---
    defineTool({
      name: "pve_list_nodes",
      title: "List Proxmox nodes",
      description: "List Proxmox nodes with status, CPU, memory, and uptime.",
      level: "read",
      input: {},
      handler: async () =>
        (await pve.listNodes()).map((n: Record<string, any>) => ({
          node: n.node,
          status: n.status,
          cpu: n.cpu,
          maxcpu: n.maxcpu,
          memGB: gb(n.mem),
          maxmemGB: gb(n.maxmem),
          uptime: n.uptime,
        })),
    }),
    defineTool({
      name: "pve_list_guests",
      title: "List VMs and LXCs",
      description: "List QEMU VMs and LXC containers across allowed nodes, with status and resource usage.",
      level: "read",
      input: {
        type: z.enum(["qemu", "lxc"]).optional().describe("Only this guest type"),
        status: z.enum(["running", "stopped"]).optional(),
      },
      handler: async ({ type, status }) =>
        (await pve.listGuests())
          .filter((g) => (!type || g.type === type) && (!status || g.status === status))
          .map((g) => ({
            vmid: g.vmid,
            name: g.name,
            type: g.type,
            node: g.node,
            status: g.status,
            template: g.template === 1 || undefined,
            cpu: g.cpu,
            maxcpu: g.maxcpu,
            memGB: gb(g.mem),
            maxmemGB: gb(g.maxmem),
            maxdiskGB: gb(g.maxdisk),
            uptime: g.uptime,
            tags: g.tags,
          }))
          .sort((a, b) => a.vmid - b.vmid),
    }),
    defineTool({
      name: "pve_guest_status",
      title: "Guest status",
      description: "Current runtime status of a VM or LXC.",
      level: "read",
      input: { vmid: vmidSchema },
      handler: ({ vmid }) => pve.guestStatus(vmid),
    }),
    defineTool({
      name: "pve_guest_config",
      title: "Guest configuration",
      description: "Configuration of a VM or LXC (secrets redacted).",
      level: "read",
      input: { vmid: vmidSchema },
      handler: async ({ vmid }) => {
        const { guest, config } = await pve.guestConfig(vmid);
        return { vmid, node: guest.node, type: guest.type, config };
      },
    }),
    defineTool({
      name: "pve_list_snapshots",
      title: "List snapshots",
      description: "Snapshots of a VM or LXC.",
      level: "read",
      input: { vmid: vmidSchema },
      handler: ({ vmid }) => pve.listSnapshots(vmid),
    }),
    defineTool({
      name: "pve_list_backups",
      title: "List backups",
      description: "vzdump backups on backup-capable storages, optionally for one guest, newest first.",
      level: "read",
      input: { vmid: vmidSchema.optional() },
      handler: async ({ vmid }) =>
        (await pve.listBackups(vmid))
          .sort((a, b) => (b.ctime ?? 0) - (a.ctime ?? 0))
          .map((b) => ({
            vmid: b.vmid,
            storage: b.storage,
            volid: b.volid,
            created: b.ctime ? new Date(b.ctime * 1000).toISOString() : undefined,
            sizeGB: gb(b.size),
            protected: b.protected === 1 || undefined,
            notes: b.notes,
          })),
    }),
    defineTool({
      name: "pve_firewall_status",
      title: "Firewall status",
      description: "Proxmox firewall options at datacenter and node level, plus guest options and rules when vmid is given.",
      level: "read",
      input: { vmid: vmidSchema.optional() },
      handler: async ({ vmid }) => {
        const settle = async <T>(p: Promise<T>) => p.catch((e: Error) => ({ error: e.message }));
        const nodes = await pve.listNodes();
        return {
          datacenter: await settle(pve.clusterFirewallOptions()),
          nodes: Object.fromEntries(
            await Promise.all(nodes.map(async (n) => [n.node, await settle(pve.nodeFirewallOptions(n.node))])),
          ),
          guest: vmid === undefined ? undefined : await settle(pve.guestFirewall(vmid)),
        };
      },
    }),
    defineTool({
      name: "pve_task_status",
      title: "Task status",
      description: "Status of an asynchronous Proxmox task (UPID returned by start/stop/snapshot tools).",
      level: "read",
      input: {
        node: z.string().regex(/^[A-Za-z0-9.-]+$/).describe("Node the task runs on"),
        upid: z.string().regex(/^UPID:[A-Za-z0-9:._@!-]+$/).describe("Task UPID"),
      },
      handler: ({ node, upid }) => pve.taskStatus(node, upid),
    }),

    // --- operate ---
    defineTool({
      name: "pve_guest_start",
      title: "Start guest",
      description: "Start a VM or LXC. Returns a task UPID.",
      level: "operate",
      input: { vmid: vmidSchema },
      handler: ({ vmid }) => pve.guestAction(vmid, "start"),
    }),
    defineTool({
      name: "pve_guest_shutdown",
      title: "Shut down guest",
      description: "Gracefully shut down a VM or LXC. Returns a task UPID.",
      level: "operate",
      input: { vmid: vmidSchema },
      handler: ({ vmid }) => pve.guestAction(vmid, "shutdown"),
    }),
    defineTool({
      name: "pve_guest_reboot",
      title: "Reboot guest",
      description: "Gracefully reboot a VM or LXC. Returns a task UPID.",
      level: "operate",
      input: { vmid: vmidSchema },
      handler: ({ vmid }) => pve.guestAction(vmid, "reboot"),
    }),
    defineTool({
      name: "pve_snapshot_create",
      title: "Create snapshot",
      description: "Take a snapshot of a VM or LXC (e.g. before changing an app). Returns a task UPID.",
      level: "operate",
      input: {
        vmid: vmidSchema,
        snapname: snapnameSchema,
        description: z.string().max(200).optional(),
      },
      handler: ({ vmid, snapname, description }) => pve.createSnapshot(vmid, snapname, description),
    }),

    // --- admin ---
    defineTool({
      name: "pve_guest_stop",
      title: "Force-stop guest",
      description: "Immediately stop a VM or LXC (like pulling the power). Prefer pve_guest_shutdown.",
      level: "admin",
      input: { vmid: vmidSchema },
      confirm: { describe: "the VMID as a string, e.g. \"105\"", expected: ({ vmid }) => String(vmid) },
      handler: ({ vmid }) => pve.guestAction(vmid, "stop"),
    }),
    defineTool({
      name: "pve_snapshot_rollback",
      title: "Roll back snapshot",
      description: "Roll a VM or LXC back to a snapshot. All changes since the snapshot are lost.",
      level: "admin",
      input: { vmid: vmidSchema, snapname: snapnameSchema },
      confirm: { describe: "\"<vmid>/<snapname>\"", expected: ({ vmid, snapname }) => `${vmid}/${snapname}` },
      handler: ({ vmid, snapname }) => pve.rollbackSnapshot(vmid, snapname),
    }),
    defineTool({
      name: "pve_snapshot_delete",
      title: "Delete snapshot",
      description: "Delete a snapshot of a VM or LXC.",
      level: "admin",
      input: { vmid: vmidSchema, snapname: snapnameSchema },
      confirm: { describe: "\"<vmid>/<snapname>\"", expected: ({ vmid, snapname }) => `${vmid}/${snapname}` },
      handler: ({ vmid, snapname }) => pve.deleteSnapshot(vmid, snapname),
    }),
  ];
}

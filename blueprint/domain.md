# Domain

## Proxmox VE

- **Node** — a physical Proxmox host in the cluster (or the single host).
- **Guest** — a workload on a node, identified by a numeric **VMID**. Two kinds:
  - **QEMU VM** (`qemu`)
  - **LXC container** (`lxc`) — may be *privileged* or *unprivileged*; may enable *features* such as `nesting` and `keyctl`, which Docker inside LXC requires.
- **Snapshot** — a named point-in-time state of a guest that can be rolled back to.
- **Backup** — a vzdump archive of a guest stored on a backup-capable storage.
- **Firewall** — datacenter, node, and per-guest firewall configuration.

## Portainer / Docker

- **Endpoint** (a.k.a. environment) — a Docker engine Portainer manages, identified by a numeric ID.
- **Stack** — a Docker Compose project deployed through Portainer on an endpoint; has a compose file and environment variables.
- **Container**, **Image**, **Volume**, **Network** — standard Docker objects on an endpoint.

## How they relate in this homelab

The Docker host is an **LXC guest on Proxmox**. Portainer manages the Docker engine inside that LXC as an endpoint, and the operator's apps run there as stacks. Securing an app therefore spans three layers: the compose definition, the running container, and the LXC that hosts Docker.

The canonical, versioned definition of each app lives in [`stacks/`](../stacks/); what is deployed in Portainer may drift from it.

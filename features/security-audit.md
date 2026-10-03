# Security audit

An agent can review the security posture of the operator's Docker apps across all three layers they depend on:

- **Compose definitions** — whether in this repo or deployed in Portainer — for risky settings such as privileged mode, host networking, Docker socket mounts, dangerous capabilities, running as root, unpinned images, plaintext secrets, ports exposed on all interfaces, and missing resource limits, health checks, or restart policies.
- **Running containers** — the same risks as actually applied at runtime, which can differ from the definition.
- **The Docker LXC on Proxmox** — whether it is unprivileged, which features it enables, whether its firewall is on, and what host paths it mounts.

Each finding has a severity and a concrete recommended fix, so the operator and agent can harden one app at a time. Auditing never changes anything.

# Proxmox management

An agent can see the state of the Proxmox homelab: which nodes exist, which VMs and LXC containers run on them, their resource usage, configuration, snapshots, backups, and firewall state. This is how the agent locates the LXC that hosts Docker and understands what it is running on.

When the operator opts in to a higher access level, the agent can also start, shut down, and reboot guests and take snapshots (for example, a safety snapshot before changing an app). At the highest level it can hard-stop a guest, roll back to a snapshot, or delete one — each only after the operator confirms the exact target (see [R1](../blueprint/rules.md#r1-read-only-by-default), [R2](../blueprint/rules.md#r2-destructive-actions-require-exact-confirmation)).

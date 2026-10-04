# Portainer management

An agent can see everything Portainer manages on the Docker node: environments, stacks and their compose definitions, containers, images, volumes, and networks, plus recent container logs. Secret values never appear in what it sees ([R3](../blueprint/rules.md#r3-no-secrets-in-tool-output)).

With lifecycle access, the agent can start, stop, and restart containers and stacks, and redeploy a stack so it pulls fresh images. With admin access, it can deploy an app from its versioned definition in [`stacks/`](../stacks/), delete a stack, or prune unused images — always after exact confirmation.

The agent can also compare an app's versioned definition in this repo against what Portainer actually has deployed, so drift is visible before it causes surprises.

For apps that need in-container maintenance, each stack can define a small, fixed set of commands that the agent can list at any level and run at admin level. For example, for Nextcloud: maintenance mode, file re-indexing, and switching background jobs to cron. It can never run arbitrary commands inside a container ([D6](../blueprint/decisions.md#d6-no-generic-container-exec--only-allowlisted-app-commands)). A new command becomes available as soon as its definition is committed, without restarting anything ([R9](../blueprint/rules.md#r9-only-committed-command-definitions-run)).

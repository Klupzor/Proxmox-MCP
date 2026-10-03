# Stacks

One directory per Docker app deployed through Portainer — the versioned source of truth for that app ([decision D5](../blueprint/decisions.md#d5-app-stacks-are-versioned-in-this-repo)).

```text
stacks/<app>/
  compose.yaml   # committed; references secrets as ${VAR}, never inline
  .env.example   # committed; placeholder values only
  .env           # gitignored; real values (chmod 600)
```

The directory name must equal the Portainer stack name — drift detection and deploy-from-repo match on it.

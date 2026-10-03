# Features

`features/` describes what the product does — meaningful, user-recognizable capabilities and behavior. Each file describes one capability, in prose, from the outside.

## What belongs here

Behavioral, product-level statements:

> Users can filter tasks by status.

## What does not belong here

Implementation or API detail:

> The service now accepts an optional `status` parameter.

...unless that detail is itself durable knowledge someone would need later (rare — most implementation parameters are plumbing, not product capability). A small implementation change is generally **not** sufficient reason to touch a feature document. This is not a minor style preference: it comes from repeatedly observing agents edit a feature doc for a small optional filter parameter that didn't change what the product actually does. See `references/context-impact.md` for the fuller reasoning behind this boundary.

Concretely, avoid letting a feature document become:

- **An API reference.** If it reads like function signatures or endpoint documentation, it's describing implementation, not capability.
- **An implementation diary.** If it's a log of what changed and when, that's what git history and commit messages are for.
- **A changelog.** "Added X, then changed X to do Y" belongs in commits, not here — a feature doc should describe current behavior, not its history.

## Referencing rules

If a capability's behavior is governed by a rule in `blueprint/rules.md`, reference the rule rather than restating its wording:

> New tasks default to status `todo` (see `blueprint/rules.md#r1`).

## No mandated per-feature template

There is intentionally no fixed template for an individual feature file. Feature documents are freeform prose — write what a person would need to understand the capability, at whatever length that takes. Don't "fix" this by adding a rigid schema later; keeping this format-free is deliberate, in line with AIR staying lightweight.

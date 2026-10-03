# Agent Instructions

This project uses [AIR](https://github.com/Klupzor/Air) (AI-Readable). If the AIR Skill is available to you, load it and follow it — it explains the full workflow. The rules below are the essentials that hold even if the Skill isn't available.

- Start at [`PROJECT.md`](PROJECT.md). Use progressive context: read only what the current task requires.
- For anything beyond a trivial, unambiguous change, resolve material ambiguity in conversation (Discovery) before writing or acting on an implementation contract.
- `current-task.md`, if present, is the single active implementation contract. It is created only once Discovery has converged, and it is deleted once its work is committed.
- `blueprint/` holds durable project knowledge (architecture, domain, modules, rules, decisions). `features/` describes product capabilities. Don't duplicate canonical knowledge across documents — including into any tool-specific integration file (a Skill config or another tool's instruction file) — reference it instead.
- Never invent a decision that materially affects product, domain, architecture, scope, or behavior. Ask a human.
- If documentation and code disagree, surface the conflict and ask — never silently pick a side.
- After a meaningful implementation change, run a Context Impact Check: decide whether any canonical document is now stale, and update it if so.

This file is intentionally short and self-contained on purpose: it must hold even if the AIR Skill and the AIR repository itself are both unavailable. See the AIR specification for the reasoning behind these rules, if you have access to it.

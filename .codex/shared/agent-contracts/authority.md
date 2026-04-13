.codex is the authoritative workflow surface for Mulder in Codex.

Use these contracts and the local `.codex/skills/**/references/*.md` files as the active execution source of truth.

Do not depend on legacy Claude command files for required behavior. Historical workflow assets may remain in the repository for comparison or compatibility with other tools, but Codex execution should be fully reconstructable from `.codex` alone.

`agents/openai.yaml` is UI metadata for skill discovery and invocation chips. Keep behavior in `SKILL.md` plus `references/`, not in YAML.

When a workflow uses fresh workers, the worker must rebuild domain context from repository files and structured handoff fields rather than from parent-thread memory.

# CLI Command Tree Audit

Date: 2026-04-14

Scope:
- Spec reviewed: `docs/functional-spec.md` section `1. CLI Command Tree`
- Implementation reviewed: `apps/cli/src/index.ts` and `apps/cli/src/commands/*.ts`
- Verification method: source inspection plus built CLI help from `pnpm --filter @mulder/cli exec node dist/index.js --help`

## Summary

Most of the command tree from the functional spec is present in the CLI, but the following spec items are not fully implemented:

1. `mulder config init` is missing.
2. `mulder db reset --confirm` is missing.
3. `mulder ingest --watch` is missing.
4. `mulder ingest --cost-estimate` is registered, but it is explicitly stubbed and does not perform a cost estimate.
5. `mulder pipeline run --cost-estimate` is missing.
6. Top-level `mulder eval` is missing.
7. Top-level `mulder retry` is missing.
8. Top-level `mulder reprocess` is missing.

Everything else listed in the section appears to be implemented, and several extra commands/flags exist beyond the spec, such as `mulder show`, `mulder cache stats`, `mulder config schema`, and `mulder fixtures status`.

## Disposition

This audit reflects a **current-state visibility problem**, not a blanket requirement to pull M8 work forward before the next roadmap step.

Implement now:
- Clarify the live `mulder ingest --cost-estimate` help text so the flag no longer reads like a fully implemented capability.
- Record the gap assessment in review/audit docs so contributors can distinguish the current CLI from the end-state functional spec.

Defer to the existing roadmap:
- `mulder eval` → M8-I1
- `mulder ingest/pipeline run/reprocess --cost-estimate` → M8-I2
- `mulder reprocess` → M8-I4
- top-level `mulder retry` → M8-I5

Defer as backlog / unassigned:
- `mulder config init`
- `mulder db reset --confirm`
- `mulder ingest --watch`

Recommendation:
- Do not block the next M7 step on implementing the missing commands above.
- Do not rewrite the functional spec just to encode milestone status. It is serving as the end-state product/design contract; `docs/roadmap.md` and audit/review docs should carry "what ships today" status.
- Only change the functional spec if we decide the intended end-state command surface itself is wrong.

## Detailed Gaps

### 1. `config init` missing

Spec:
- `docs/functional-spec.md` §1 defines `mulder config init`

Implementation evidence:
- `apps/cli/src/commands/config.ts:26-76` only registers `validate`, `show`, and `schema`
- `apps/cli/src/index.ts:41` registers `registerConfigCommands(program)`, but there is no separate config-init registration anywhere

Impact:
- The CLI does not provide the interactive config bootstrap flow described by the spec.

### 2. `db reset --confirm` missing

Spec:
- `docs/functional-spec.md` §1 defines `mulder db reset` and says it requires `--confirm`

Implementation evidence:
- `apps/cli/src/commands/db.ts:42-153` only registers `migrate`, `status`, and `gc`
- There is no `reset` subcommand and no `--confirm` flag under `db`

Impact:
- The destructive database reset path described in the spec is unavailable.

### 3. `ingest --watch` missing

Spec:
- `docs/functional-spec.md` §1 defines `mulder ingest <path>` with `--watch`

Implementation evidence:
- `apps/cli/src/commands/ingest.ts:37-42` registers `--dry-run`, `--tag`, and `--cost-estimate`
- No `--watch` option is present

Impact:
- The CLI cannot watch a directory for new PDFs as described in the spec.

### 4. `ingest --cost-estimate` is stubbed, not implemented

Spec:
- `docs/functional-spec.md` §1 defines `--cost-estimate` as an actual estimate-before-ingest feature

Implementation evidence:
- `apps/cli/src/commands/ingest.ts:42` registers `--cost-estimate`
- `apps/cli/src/commands/ingest.ts:53-55` exits early with a placeholder message referencing `M8-I2`

Impact:
- The flag exists in help output, but the functionality required by the spec is not implemented.

### 5. `pipeline run --cost-estimate` missing

Spec:
- `docs/functional-spec.md` §1 defines `mulder pipeline run <path>` with `--cost-estimate`

Implementation evidence:
- `apps/cli/src/commands/pipeline.ts:71-77` registers `--up-to`, `--from`, `--dry-run`, and `--tag`
- No `--cost-estimate` option is present for `pipeline run`

Impact:
- There is no preflight cost-estimation mode for full pipeline runs.

### 6. Top-level `eval` command missing

Spec:
- `docs/functional-spec.md` §1 defines top-level `mulder eval`

Implementation evidence:
- `apps/cli/src/index.ts:39-58` registers all top-level command groups, and there is no `registerEval...` import or call
- `apps/cli/src/commands/` contains no `eval.ts`

Impact:
- The quality-evaluation CLI described in the spec is not exposed.

### 7. Top-level `retry` command missing

Spec:
- `docs/functional-spec.md` §1 defines top-level `mulder retry`

Implementation evidence:
- `apps/cli/src/index.ts:39-58` has no top-level retry registration
- `apps/cli/src/commands/` contains no `retry.ts`
- Only `mulder pipeline retry` exists in `apps/cli/src/commands/pipeline.ts:384-507`

Impact:
- The spec’s standalone retry entrypoint is missing; only the nested pipeline retry flow exists.

### 8. Top-level `reprocess` command missing

Spec:
- `docs/functional-spec.md` §1 defines top-level `mulder reprocess`

Implementation evidence:
- `apps/cli/src/index.ts:39-58` has no reprocess registration
- `apps/cli/src/commands/` contains no `reprocess.ts`

Impact:
- The selective reprocessing workflow described in the spec is not exposed in the CLI.

## Notes

- `mulder pipeline status` includes an extra `--run <id>` flag not mentioned in the command tree.
- `mulder status` includes an extra `--json` flag not mentioned in the command tree.
- `mulder query`, `ground`, `entity`, `export`, `taxonomy`, `worker`, `extract`, `segment`, `enrich`, `embed`, `graph`, `cache clear`, `fixtures generate`, and `pipeline retry/status` otherwise match the command-tree surface area from the spec closely enough for this audit.

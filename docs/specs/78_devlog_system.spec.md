---
spec: "78"
title: "Devlog System"
roadmap_step: M8-I6
functional_spec: ["§17"]
scope: single
issue: "https://github.com/mulkatz/mulder/issues/202"
created: 2026-04-15
---

# Spec 78: Devlog System

## 1. Objective

Complete roadmap step `M8-I6` by turning Mulder's already-started `devlog/` practice into an explicit, contributor-facing, and verifiable repository contract. Per `§17`, the repository must expose a `devlog/` directory whose entries follow a fixed filename pattern, frontmatter shape, type vocabulary, and short technical writing style suitable for a public build log.

This step is intentionally documentation- and verification-focused. It does not add publishing automation or a new CLI surface. The goal is to make the conventions easy for contributors to discover and hard for the repo to drift away from silently.

## 2. Boundaries

- **Roadmap Step:** `M8-I6` — Devlog system
- **Target:** `devlog/README.md`, `CLAUDE.md`, `tests/specs/78_devlog_system.test.ts`
- **In scope:** adding a contributor-facing conventions document inside `devlog/`; aligning the existing `CLAUDE.md` devlog rules with the exact `§17` contract where they currently leave room for ambiguity; and adding black-box verification that the directory exists, the conventions document captures the required rules, and checked-in devlog entries conform to the documented filename/frontmatter/body expectations
- **Out of scope:** website deployment, RSS feeds, changelog generation, automatic devlog entry creation, CI workflows beyond the shipped Vitest coverage, or rewriting historical entries for editorial reasons unless a test reveals a concrete contract violation
- **Constraints:** preserve the current lightweight workflow; do not introduce a CLI command for devlog work; keep the source of truth repository-local and human-readable; and keep verification at the filesystem/content-contract level rather than relying on implementation internals

## 3. Dependencies

- **Requires:** None
- **Blocks:** no immediate downstream roadmap step directly, but this step formalizes the documentation discipline that later operational and milestone work can rely on when recording notable delivery progress

## 4. Blueprint

### 4.1 Files

1. **`devlog/README.md`** — defines the public build-log purpose, filename convention, required frontmatter keys, allowed `type` values, when to write an entry, when to skip one, and the short technical style expected by `§17`
2. **`CLAUDE.md`** — tightens the existing devlog section so the contributor guidance matches the formal `§17` contract and the new `devlog/README.md`
3. **`tests/specs/78_devlog_system.test.ts`** — black-box verification for directory/document presence and conformance of checked-in devlog entries

### 4.2 Repository Contract

The delivered repository contract must make these requirements observable without opening the functional spec:

- the repository root contains `devlog/`
- `devlog/README.md` explains that `devlog/` is the public build log
- filenames follow `YYYY-MM-DD-slug.md`
- every entry contains frontmatter keys `date`, `type`, `title`, and `tags`
- `type` values are restricted to the `§17` vocabulary
- entry body text remains short, direct, technical, and bounded to the documented sentence limit

### 4.3 Verification Strategy

The test suite should validate the contract through the public filesystem surface only:

- inspect checked-in files under `devlog/`
- parse frontmatter from each Markdown entry
- assert required keys, allowed type values, and filename/date consistency
- ensure the body is present and remains within the documented sentence cap

The verification must not depend on application runtime packages or internal implementation modules, because `M8-I6` is a repository convention, not a runtime subsystem.

## 5. QA Contract

1. **QA-01: the repository exposes contributor-facing devlog conventions**
   - Given: a fresh checkout of the repository
   - When: the `devlog/` directory is inspected
   - Then: the directory exists and contains a conventions document that describes the build-log purpose, filename pattern, required frontmatter, type vocabulary, and logging/skip rules

2. **QA-02: `CLAUDE.md` matches the devlog contract**
   - Given: the checked-in contributor guide
   - When: the devlog section in `CLAUDE.md` is inspected
   - Then: it documents the same directory, frontmatter keys, allowed type values, and short technical style defined by `§17`

3. **QA-03: checked-in devlog entries follow the repository contract**
   - Given: all Markdown entries directly under `devlog/`
   - When: their filenames, frontmatter, and body text are validated
   - Then: each file uses `YYYY-MM-DD-slug.md`, includes `date`, `type`, `title`, and `tags`, uses an allowed `type` value, and contains a non-empty body within the documented sentence cap

4. **QA-04: the step stays documentation-only**
   - Given: the files changed for this step
   - When: they are reviewed at the repository boundary
   - Then: no new CLI commands, runtime packages, or deployment automation surfaces are introduced

## 5b. CLI Test Matrix

N/A — no CLI commands in this step.

## 6. Cost Considerations

- **Services called:** none
- **Operational impact:** none at runtime; this step only establishes and validates repository conventions
- **Safety requirement:** keep the work local and deterministic so contributors can verify the contract without credentials, cloud access, or side effects

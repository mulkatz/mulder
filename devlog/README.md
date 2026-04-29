# Devlog

`devlog/` is Mulder's public build log. It records significant project progress in short, technical entries that are easy to skim and easy to audit.

## File Naming

- Use `YYYY-MM-DD-slug.md`
- Keep the slug lowercase, kebab-case, and specific to the change
- If multiple entries land on the same day, use different slugs for each file

## Frontmatter

Every entry must start with:

```yaml
---
date: 2026-03-28
type: architecture
title: "Short, concrete title"
tags: [relevant, technical, tags]
---
```

Required keys:

- `date`
- `type`
- `title`
- `tags`

Allowed `type` values:

- `architecture`
- `implementation`
- `breakthrough`
- `decision`
- `refactor`
- `integration`
- `milestone`

## When To Write

Write a devlog entry when:

- a new capability works
- an architecture decision is made or revised
- a non-obvious technical problem is solved
- a GCP service is integrated for the first time
- a significant refactor changes the structure
- a milestone is reached

Skip a devlog entry when:

- the change is routine refactoring
- the change is a bug fix
- the change is a dependency update
- the change is formatting or typo cleanup
- the change is a repeated iteration on the same feature

## Style

- Write in English
- Keep the body direct, technical, and filler-free
- Use 2-15 sentences
- Do not use "today I", "in this entry", or similar intro phrasing
- Make the result or decision explicit

---
phase: 4
title: "Post-MVP GCP Smoketest — Public Summary"
scope: End-to-end real-GCP pipeline run in a private operator environment
date: 2026-04-08
tester: private operator environment
project: private
cost_cap_eur: 3
estimated_cost_eur: 0.10
verdict: PASS_WITH_FINDINGS
---

# Post-MVP QA Gate — Phase 4: GCP Smoketest

## Public Summary

A private operator environment ran the full document-intelligence pipeline
(ingest -> extract -> segment -> enrich -> embed -> graph -> query) against real
GCP services with a 16-page PDF fixture and a small hybrid-retrieval query set.

The MVP pipeline completed end to end on real cloud services. The run produced
segmented stories, extracted entities, relationship edges, taxonomy entries, and
embedded chunks, then returned high-quality hybrid retrieval matches for queries
whose content existed in the test corpus.

The detailed environment values, cloud project, account, bucket, processor,
object paths, source IDs, and cleanup commands are intentionally omitted from the
public repository. Keep live smoke details in a private ops repository.

## Findings

The run surfaced several follow-up findings:

- Document extraction configuration must support a Document AI multi-region that
  can differ from the primary runtime region.
- PDF page-image rendering must be robust when optional native image-rendering
  modules are unavailable.
- Segmentation should report when page images were unavailable so operators can
  distinguish text-only success from multimodal success.
- Storage path IDs and database source IDs should be easy to correlate in
  operator tooling.

## Public Pass Criteria

- Real cloud service calls completed without using test doubles.
- The pipeline advanced through all major processing phases.
- Structured output was persisted and queryable.
- Hybrid retrieval returned relevant matches for known-answer queries.
- Findings were captured for follow-up triage.

## Private Artifacts

The private ops repository should retain the full smoke transcript, concrete
GCP values, object paths, cost notes, cleanup commands, and live environment
metadata. Do not copy those values back into tracked public files.

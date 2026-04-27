# Mulder — Functional Specification Addendum

This document extends the [Functional Specification](./functional-spec.md) with 21 additional features (F-01 through F-21), an architecture principle, and a comprehensive ingest provenance model. It introduces five new milestones (M10–M14) that integrate with the existing M1–M9 roadmap.

## Reading Instructions

1. **Read the functional spec first** — this addendum assumes familiarity with §1–§18 of `functional-spec.md`.
2. **Read only referenced sections** — each §A section lists which functional spec sections it extends. Read those first.
3. **Cross-reference conventions:**
   - `§1`–`§18` = Functional Specification (`functional-spec.md`)
   - `§A1`–`§A17` = This addendum
   - `§D1`–`§D5` = Architecture Principles (`architecture-core-vs-domain.md`)
4. **Relationship to functional spec:** This addendum **extends, never contradicts** the functional spec. Where a concept is replaced (e.g., §A8 replaces single-float reliability scoring from §2.8), this is explicitly noted.
5. **Feature numbering:** F-01 through F-21. F-14 (Knowledge Graph Explorer) and F-15 (Watchlist & Research Alerts) are reserved but not yet specified.
6. **Domain-agnostic:** This addendum is fully domain-agnostic. All data models, interfaces, and examples use generic terms. Domain-specific examples (e.g., concrete taxonomies, entity types, external data sources for a particular domain) live exclusively in the architecture principle document (`architecture-core-vs-domain.md`, §D4).

## Feature Overview

| Feature | Title | Addendum Section | Tier |
|---------|-------|-----------------|------|
| — | Core vs. Domain Architecture | §A1 | Principle |
| — | Ingest Data Model & Document Provenance | §A2 | Foundation |
| F-04 | Assertion Classification (Observation/Interpretation) | §A3 | Foundation |
| F-19 | Document Quality Pipeline | §A4 | Foundation |
| F-20 | Access Control & Sensitivity Levels | §A5 | Foundation |
| F-10 | Source Provenance Tracking & Rollback | §A6 | Foundation |
| F-08 | Document Translation Service | §A7 | Enhancement |
| F-09 | Multi-Dimensional Source Credibility Profiles | §A8 | Enhancement |
| F-17 | Contradiction Management | §A9 | Enhancement |
| F-11 | Similar Case Discovery | §A10 | Enhancement |
| F-12 | Classification System Harmonization | §A11 | Enhancement |
| F-13 | Temporal Pattern Detection & Flap Analysis | §A12 | Enhancement |
| F-16 | Collaborative Review Workflow | §A13 | Enhancement |
| F-18 | Knowledge Graph Versioning | §A14 | Enhancement |
| F-21 | Export & Interoperability | §A15 | Enhancement |
| F-01 | Agentic Research Loop | §A16 | Agent |
| F-02 | Exploration Scheduler | §A16 | Agent |
| F-03 | Research Journal | §A16 | Agent |
| F-05 | Source Integration | §A16 | Agent |
| F-06 | External Web Research | §A16 | Agent |
| F-07 | Report Generator | §A16 | Agent |

**Tiers:**
- **Foundation** — Must be implemented before first real archive ingest. Modifies or extends existing pipeline steps.
- **Enhancement** — New capabilities built on top of the core pipeline. New milestones after M5/M6.
- **Agent** — Entirely new system layer. Phase 2+, after core pipeline is complete.

---

## §A1 — Architecture Principle: Core vs. Domain Separation

> **Reference:** [`architecture-core-vs-domain.md`](./architecture-core-vs-domain.md)

The full architecture principle document lives in a separate file. This section summarizes the key constraints.

### Guiding Principle

> The core models generic concepts. Domain configuration gives them names, semantics, and constraints.

Mulder is a Document Intelligence Platform, not a tool for any specific domain. Every data structure, pipeline step, and feature must work in any domain by swapping configuration — no code changes. Investigative journalism, medical case studies, historical archive research, or legal discovery are all valid instances.

### Six Rules

1. **No domain terms in code.** No data type, function, or field name in core code may contain a domain-specific term. Domain terms exist only in config files, ontology definitions, and UI labels. **Test:** A developer unfamiliar with the configured domain should not be able to tell from the code what the system is used for.
2. **Domain semantics live in the ontology config.** The config-driven ontology is the single place where domain-specific concepts are defined: entity types, relation types, taxonomies, analysis attributes, display labels.
3. **Features are generic, examples are domain-specific.** Feature specs define generic mechanisms. Domain-specific examples are illustrations, not part of the feature design. The architecture principle document (§D3, §D4) contains concrete domain configuration examples.
4. **External data sources are plugins.** External time series (geomagnetic indices, media coverage, parliamentary sessions) are not hard-coded. Every external source is a configurable plugin with a standardized interface.
5. **Credibility dimensions are configurable.** The dimensions of source credibility profiles (§A8) are a sensible default but not hard-coded. The ontology config defines which dimensions exist, how they are named, and what they mean.
6. **Similarity dimensions are configurable.** The dimensions of similar case discovery (§A10) are not fixed. The core provides four built-in dimensions (`semantic`, `structural`, `geospatial`, `temporal`) and an extensible `domain_attributes` array for domain-specific comparison axes.

### New Feature Checklist

Before implementing any feature from this addendum:

1. Does the data model contain domain-specific field names? → Generalize, move domain labels to config.
2. Does the code reference concrete taxonomies or entity types? → Replace with config references.
3. Are external data sources hard-coded? → Model as plugin with standardized interface.
4. Are analysis dimensions or metrics fixed? → Separate core dimensions from domain dimensions.
5. Does the feature work with a completely different `domain.yaml`? → If not, refactor.
6. Are domain-specific examples clearly separated from core design? → Domain illustrations belong in the architecture principle document (§D4), not in core feature specs.

---

## §A2 — Ingest Data Model & Document Provenance

> **Extends:** §2.1 (Ingest), §4.3 (Core Schema), §4.4 (Storage Architecture)
>
> **What exists:** Ingest stores PDFs in `gs://mulder-{project}/raw/` keyed by source UUID. Sources tracked in `sources` table with `file_hash` for uniqueness. No provenance chain, no archive metadata, no custody tracking.
>
> **What this adds:** Content-addressed storage, full document provenance (acquisition context, custody chain, archive locations), collection management, blob versioning, and virtual archive view.

### 2.1 Design Principles

1. **Mulder is the canonical copy after ingest.** The raw document (blob) is stored immutably and can always be re-verified and re-processed.
2. **Archive paths are metadata, not storage paths.** The folder structure of the original archive describes how the archivist organized their material — that is information, not a storage location.
3. **Storage is content-addressed.** A document is stored under its content hash, not its name or path. Same PDF = same hash = one blob, regardless of how many paths it entered the system through.
4. **A document can have multiple origins.** Mulder's data model represents an n:m relationship between blobs and archive locations.

### 2.2 Ingest Flow

```
┌─────────────────────────────────────────────────────────────┐
│                     INGEST REQUEST                          │
│  (File + Metadata: channel, collection, path, submitter)   │
└─────────────────────┬───────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────────────┐
│              CONTENT-HASH COMPUTATION (SHA-256)             │
└─────────���───────────┬───────────────────────────────────────┘
                      ↓
              ┌───────┴────────┐
              │  Hash known?   │
              └───┬────────┬───┘
                  │ Yes    │ No
                  ↓        ↓
┌─────────────────────┐  ┌────────────────────────────────────┐
│ DEDUPLICATION       │  │ BLOB STORAGE                       │
│ Append new          │  │ Store blob in GCS under hash       │
│ AcquisitionContext   │  │ Create DocumentBlob record         │
│ to existing blob    │  │ Create AcquisitionContext           │
└─────────┬───────���───┘  └─────────────────┬──────────────────┘
          │                                │
          └──────────┬─────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────────────┐
│           QUALITY ASSESSMENT (→ §A4)                        │
└─────────────────────┬───────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────────────┐
│           EXTRACT → ENRICH → ... (Pipeline)                 │
└─────────────────────────────────────────────────────────────┘
```

### 2.3 Data Model

#### DocumentBlob — Immutable Raw Storage

```typescript
interface DocumentBlob {
  // Identification
  content_hash: string;               // SHA-256 of original file bytes — primary identifier
  mulder_blob_id: string;             // UUID for internal referencing

  // Storage
  storage_uri: string;                // GCS path derived from hash
                                      // e.g., "gs://mulder-blobs/sha256/a1/b2/a1b2c3d4e5f6..."
  storage_class: "standard" | "nearline" | "coldline" | "archive";
  storage_status: "active" | "cold_storage" | "pending_deletion" | "deleted";

  // File properties
  mime_type: string;                  // e.g., "application/pdf", "image/jpeg"
  file_size_bytes: number;
  page_count: number | null;          // For PDFs, TIFFs
  original_filenames: string[];       // All filenames this document was ever submitted under

  // Timestamps
  first_ingested_at: string;          // ISO8601 — when was this blob first seen?
  last_accessed_at: string;           // For storage tiering and retention decisions

  // Integrity
  integrity_verified_at: string | null;
  integrity_status: "verified" | "unverified" | "corrupted";

  // Versions
  version_links: BlobVersionLink[];   // References to older/newer versions of same document

  // Provenance — all paths through which this document entered the system
  acquisition_contexts: AcquisitionContext[];

  // Archive locations — all places this document has been stored
  archive_locations: ArchiveLocation[];
}
```

#### AcquisitionContext — How a Document Entered the System

One blob can have multiple AcquisitionContexts (e.g., first via archive import, then again via email from another member).

```typescript
interface AcquisitionContext {
  context_id: string;                 // UUID
  blob_id: string;                    // Reference to DocumentBlob

  // Channel: How did the document enter the system?
  channel: AcquisitionChannel;

  // Submitter: Who brought it in?
  submitted_by: {
    user_id: string;                  // User ID (or system ID for automated imports)
    type: "human" | "system";
    role: string | null;              // Role of submitter at time of submission
  };
  submitted_at: string;              // ISO8601

  // Collection: Which collection does this ingest belong to?
  collection_id: string | null;      // → Collection

  // Submission context
  submission_notes: string | null;   // Free text from submitter
  submission_metadata: Record<string, string>;  // Flexible key-value pairs

  // Original source: Where did the submitter get the document?
  original_source: OriginalSource | null;

  // Custody chain: What path did the document take?
  custody_chain: CustodyStep[];

  // Verification
  authenticity_status: "unverified" | "verified" | "disputed";
  authenticity_notes: string | null;
}

type AcquisitionChannel =
  | "archive_import"           // Batch import from an archive
  | "manual_upload"            // Single upload via UI
  | "email_submission"         // Submitted via email
  | "web_research"             // Downloaded by agent (F-06)
  | "api_import"               // Ingested via API (e.g., external database adapter, F-21)
  | "bulk_import"              // Mass import (e.g., entire archive)
  | "re_scan"                  // Re-scan of an already known document
  | "partner_exchange";        // Received from partner organization
```

#### OriginalSource & CustodyChain — The Provenance Chain

```typescript
interface OriginalSource {
  source_type: "witness_report" | "government_document" | "academic_paper" |
               "news_article" | "correspondence" | "field_notes" |
               "measurement_data" | "photograph" | "audio_recording" |
               "video_recording" | "other";
  source_description: string;
  source_date: string | null;        // ISO8601 — when was the original created?
  source_author: string | null;      // Original author (if known, subject to §A5 sensitivity)
  source_language: string;           // ISO 639-1
  source_institution: string | null;
  foia_reference: string | null;     // FOIA request reference number, if applicable
}

interface CustodyStep {
  step_order: number;                // Sequence (1, 2, 3, ...)
  holder: string;                    // Who held the document?
  holder_type: "person" | "institution" | "archive" | "unknown";
  received_from: string | null;
  held_from: string | null;          // ISO8601
  held_until: string | null;         // ISO8601 (null = currently held)
  actions: CustodyAction[];
  location: string | null;
  notes: string | null;
}

type CustodyAction =
  | "received" | "copied" | "digitized" | "annotated"
  | "translated" | "redacted" | "restored" | "transferred" | "archived";
```

#### ArchiveLocation — Where in the Original Archive

Describes one location of a document in an external archive. A blob can appear in multiple archives.

```typescript
interface ArchiveLocation {
  location_id: string;               // UUID
  blob_id: string;                   // Reference to DocumentBlob

  archive_id: string;                // Reference to Archive
  original_path: string;             // Full path in source archive
  original_filename: string;

  // Structured path segments (hierarchically resolved)
  path_segments: PathSegment[];

  // Physical location (if applicable)
  physical_location: PhysicalLocation | null;

  // Source status
  source_status: "current" | "moved" | "deleted_from_source" |
                 "archive_destroyed" | "digitized_only" | "unknown";
  source_status_updated_at: string;

  recorded_at: string;               // When was this location recorded?
  valid_from: string | null;
  valid_until: string | null;        // null = presumably still there
}

interface PathSegment {
  depth: number;                     // 0 = root level
  name: string;                      // Folder name
  segment_type: "collection" | "topic" | "region" | "time_period" |
                "person" | "case" | "administrative" | "unknown";
}

interface PhysicalLocation {
  building: string | null;
  room: string | null;
  shelf: string | null;
  container: string | null;          // e.g., "Folder 12", "Archive Box 7"
  position: string | null;           // e.g., "Pages 45-52"
  notes: string | null;
}
```

#### Archive — Registry of Known Archives

```typescript
interface Archive {
  archive_id: string;
  name: string;
  description: string;
  type: "personal" | "institutional" | "digital" | "governmental" | "partner" | "other";
  institution: string | null;
  custodian: string | null;
  physical_address: string | null;
  status: "active" | "closed" | "destroyed" | "transferred" | "unknown";

  // Structure metadata
  structure_description: string | null;
  estimated_document_count: number | null;
  languages: string[];
  date_range: { earliest: string | null; latest: string | null };

  // Ingest status
  ingest_status: {
    total_documents_known: number | null;
    total_documents_ingested: number;
    last_ingest_date: string | null;
    completeness: "unknown" | "partial" | "complete";
    notes: string | null;
  };

  access_restrictions: string | null;
  registered_at: string;
  last_verified_at: string | null;
}
```

#### Collection — Logical Document Groupings

A Collection is a logical grouping of documents in Mulder — independent of the source archive. Collections can be archive-based ("Everything from archive X") or thematic ("All documents related to topic Y, regardless of archive").

```typescript
interface Collection {
  collection_id: string;
  name: string;
  description: string;
  type: "archive_mirror" | "thematic" | "import_batch" | "curated" | "other";
  archive_id: string | null;         // For archive_mirror: which archive?
  created_by: string;
  created_at: string;
  visibility: "private" | "team" | "public";  // → §A5 Access Control

  document_count: number;
  total_size_bytes: number;
  languages: string[];
  date_range: { earliest: string | null; latest: string | null };
  tags: string[];

  defaults: {
    sensitivity_level: string;       // → §A5
    default_language: string;
    credibility_profile_id: string | null;  // → §A8
  };
}
```

#### BlobVersionLink — Document Versions

When a better scan, an OCR-corrected version, or an annotated edition of the same document is uploaded, it creates a new blob with a different hash. The link between versions is explicitly modeled.

```typescript
interface BlobVersionLink {
  link_id: string;
  previous_blob_hash: string;
  current_blob_hash: string;
  reason: "better_scan" | "ocr_corrected" | "annotated" | "redacted" |
          "restored" | "format_converted" | "merged" | "split" | "other";
  description: string | null;
  linked_by: string;
  linked_at: string;
  pipeline_action: "reprocess" | "supplement" | "archive_only";
}
```

**Reprocessing logic for new versions:** When `pipeline_action: "reprocess"`, the new version runs through the full pipeline. Old results are marked `superseded_by: current_blob_hash`. New results replace old. The old blob is preserved (Principle 1). Change events are logged (§A14). Affected review artifacts (§A13) are reset to `pending`.

### 2.4 Content-Addressed Storage

**Hash computation:** SHA-256 over exact byte content of the original file. Not over extracted text, not over metadata.

**GCS layout:**

```
gs://mulder-blobs/
  └── sha256/
      ├── a1/
      │   ├── b2/
      │   │   ├── a1b2c3d4e5f6...    ← Blob (original file)
      │   │   └── a1b2d7e8f9a0...
      │   └── c3/
      │       └── ...

gs://mulder-cold/                     ← Cold storage for purged sources (→ §A6)
  └── sha256/
      └── ...                         ← Same structure
```

Prefix partitioning (first 2 + next 2 characters of hash as directories) prevents GCS performance issues at scale (>100,000 blobs).

**Deduplication at ingest:**

1. Receive file
2. Compute SHA-256
3. Check: Does `gs://mulder-blobs/sha256/{prefix}/{hash}` exist?
   - **No** → Store blob, create DocumentBlob record
   - **Yes** → No new blob, but: append new AcquisitionContext, append ArchiveLocation (if different), add to `original_filenames`, notify submitter: "Document already in system. Your provenance information has been added."

No information is discarded during deduplication. The new submission path, archive location, and all metadata are stored — only the blob is not duplicated.

**Integrity verification:** Weekly Cloud Run job recomputes SHA-256 for stored blobs, compares against database record. Mismatches (bit rot, storage errors) trigger alert and quarantine.

### 2.5 Blob Lifecycle

Resolves the tension between F-10 ("no data residue when removing a source") and the archive principle ("never delete an original").

```
ACTIVE              → Blob is in the system, fully referenced and accessible
  │
  │ F-10 Soft-Delete
  ↓
COLD_STORAGE        → Blob moved from active bucket to cold storage bucket
  │                   All derived artifacts deleted (→ §A6 Cascading Purge)
  │                   Blob itself preserved for audit and undo
  │
  │ Undo window expired + retention period expired
  ↓
DELETED             → Blob permanently deleted
                      Only audit log entry remains
```

**Multi-source scenario:** If a blob was submitted via two different paths (e.g., archive import AND partner exchange), and source A is removed via F-10: only AcquisitionContext A is marked deleted. The blob stays `active` because AcquisitionContext B is still active. Pipeline results derived exclusively from source A are purged; results with multiple source references have the source A reference removed.

### 2.6 Virtual Archive View

From ArchiveLocation metadata, the system can reconstruct the original folder structure of any source archive as a navigable tree. Researchers can browse the archive "as if" they were at the physical collection — but with search, filtering, and knowledge graph links.

**Path segments as clustering signal:** Structured PathSegments are a free metadata signal. Documents under `Archive/Case Files/Region-A/1989-1990/` automatically receive tags `region:region-a` and `time_period:1989-1990` without LLM analysis. Folders can be automatically proposed as Collections. Folder structure represents the archivist's interpretation (→ §A3) — a taxonomy suggestion, not ground truth.

### 2.7 Configuration

```yaml
ingest_provenance:
  storage:
    primary_bucket: "gs://mulder-blobs/"
    cold_bucket: "gs://mulder-cold/"
    hash_algorithm: "sha256"
    prefix_depth: 2                    # 2 levels of prefix partitioning
    deduplication: true

  lifecycle:
    on_source_purge: "cold_storage"    # "delete" | "cold_storage" | "keep"
    cold_retention_days: 730           # 2 years in cold storage
    auto_delete_after_retention: true
    multi_source_handling: "keep_if_any_active"

  integrity:
    enabled: true
    schedule: "weekly"
    alert_on_mismatch: true

  required_metadata:
    channel: true                      # How did the document enter?
    submitted_by: true                 # Who submitted it?
    collection_id: false               # Optional but recommended
    original_source: false             # Optional but recommended for archive material
    custody_chain: false               # Optional, rarely fully available

  archives:
    auto_register: true                # Auto-create archive when unknown archive_id referenced
    completeness_check:
      enabled: true
      schedule: "monthly"

  collections:
    auto_create_from_archive: true     # Auto-create archive_mirror collection per archive
    auto_tag_from_path_segments: true  # Propose path segments as collection tags

  archive_view:
    enabled: true
    max_depth: 10
    segment_type_detection: "llm_auto"
    segment_type_review: true          # Auto-detection is reviewable (→ §A13)
```

### 2.8 Open Questions

- **Storage costs:** How large will the blob store realistically get? 10,000 PDFs at 5MB = 50GB (trivial). But scans, photos, audio, and video could reach terabytes. Is a storage tiering strategy needed beyond a certain volume?
- **Backup:** How should the blob store be backed up? GCS versioning? Cross-region replication?
- **Encryption at rest:** Should blobs be encrypted with Customer-Managed Encryption Keys (CMEK)? Especially relevant with §A5 sensitivity levels.
- **Custody chain completeness:** Often not fully reconstructible for historical material. How does the system handle gaps? (`holder: "unknown"` as placeholder?)
- **Automatic version detection:** Can Mulder automatically detect that a newly uploaded document is a better version of an existing one? (Perceptual hashing on scans?) Or must this always be linked manually?

---

## §A3 — Assertion Classification (F-04)

> **Extends:** §2.4 (Enrich)
>
> **What exists:** The Enrich step extracts entities, relationships, and performs taxonomy normalization. Extracted facts are stored as entity attributes and edges without epistemological classification.
>
> **What this adds:** Every extracted assertion is classified as `observation`, `interpretation`, or `hypothesis`. This classification is the epistemological foundation for the research agent (§A16) and prevents systemic confirmation bias.

### 3.1 Problem

Source documents — including well-regarded academic works — contain a mixture of empirical observations and speculative interpretations. If both flow undifferentiated into the Knowledge Graph, the system creates confirmation bias: the agent finds "evidence" for theories that are actually just opinions from other authors.

### 3.2 Data Model

```typescript
interface KnowledgeAssertion {
  id: string;                         // UUID
  source_id: string;                  // Source document reference
  story_id: string;                   // Story reference
  assertion_type: "observation" | "interpretation" | "hypothesis";
  content: string;
  extracted_entities: string[];       // Entity IDs
  confidence_metadata: ConfidenceMetadata;
  classification_provenance: "llm_auto" | "human_reviewed" | "author_explicit";
}

interface ConfidenceMetadata {
  witness_count: number | null;       // Number of independent witnesses
  measurement_based: boolean;         // Instrumental measurement available?
  contemporaneous: boolean;           // Documented close to event time?
  corroborated: boolean;              // Independently confirmed?
  peer_reviewed: boolean;             // Published in peer-reviewed venue?
  author_is_interpreter: boolean;     // Author interpreting own data?
}
```

**`observation`** — Empirical data points. No causal explanation, no interpretation. *Example: "On March 12, 1978 at 22:15, three witnesses observed an anomalous event at location X. Instrument Y confirmed readings at Z altitude."*

**`interpretation`** — Author's reading of existing observations. Builds on data but goes beyond it. *Example: "The clustering of events correlates with environmental factor X, suggesting mechanism Y as the origin."*

**`hypothesis`** — Formalized, testable thesis. Explicitly marked as verifiable. *Example: "If hypothesis Y holds, events in regions with high factor X should be significantly more frequent."*

### 3.3 Classification in the Pipeline

Classification occurs in the **Enrich step** (§2.4) via LLM. Prompt engineering with clear definitions and few-shot examples. For borderline cases, the more conservative label is chosen (`interpretation` rather than `observation`).

Each assertion also receives a **provenance tag** recording how the classification was determined:
- `llm_auto` — Classified automatically by LLM
- `human_reviewed` — Reviewed and confirmed/corrected by a human (→ §A13)
- `author_explicit` — The author themselves distinguished observation from interpretation

### 3.4 Impact on Knowledge Graph

- `observation` nodes and `interpretation` nodes are **structurally separate entity types** in the graph
- Relations between them are explicitly typed: `supports`, `contradicts`, `derived_from`, `speculates_about`
- The research agent (§A16) can query only observations, only interpretations, or both — always aware of the difference
- Credibility scoring operates separately: observations are assessed by data quality (witness count, measurements, recency); interpretations by argumentative coherence and evidence base

### 3.5 Configuration

```yaml
enrichment:
  assertion_classification:
    enabled: true
    conservative_labeling: true        # Borderline → more conservative label
    require_confidence_metadata: true
    default_provenance: "llm_auto"
    reviewable: true                   # Classifications are reviewable (→ §A13)
    review_depth: "spot_check"         # "spot_check" | "single_review" | "double_review"
    spot_check_percentage: 20
```

### 3.6 Open Questions

- **Classification accuracy:** How reliably can an LLM draw the line between observation and interpretation, especially in sources that mix both in a single sentence? Benchmarking against manually classified samples required.
- **Retroactive classification:** When assertion classification is enabled after documents have already been enriched, do all existing entities need re-classification?
- **Ontology evolution:** How does the system handle it when the agent discovers categories that don't exist in any established classification system?

---

## §A4 — Document Quality Pipeline (F-19)

> **Extends:** §2.1 (Ingest), §2.2 (Extract)
>
> **What exists:** All documents go through the same extraction path. OCR confidence is tracked but doesn't influence routing.
>
> **What this adds:** A Quality Assessment step between Ingest and Extract that evaluates document processability and routes to the optimal extraction path.

### 4.1 Problem

Historical archives contain material that the standard pipeline can't handle well: poorly scanned documents, handwritten notes, multi-generation photocopies, newspaper clippings, fax artifacts, photos of documents. Without quality assessment, roughly 30-50% of these documents produce unusable extraction results that contaminate embeddings, the graph, and the agent.

### 4.2 Pipeline Position

```
ingest → [quality assessment] → extract → segment → enrich → ...
```

Quality Assessment is a new step between ingest and extract.

### 4.3 Data Model

```typescript
interface DocumentQualityAssessment {
  document_id: string;
  assessed_at: string;
  assessment_method: "automated" | "human";

  overall_quality: "high" | "medium" | "low" | "unusable";
  processable: boolean;
  recommended_path: ExtractionPath;

  dimensions: {
    text_readability: {
      score: number;                  // 0.0–1.0
      method: "ocr_confidence" | "llm_visual" | "n/a";
      details: string;
    };
    image_quality: {
      score: number;
      issues: string[];               // e.g., ["blurry", "skewed", "low_contrast"]
    };
    language_detection: {
      primary_language: string;
      confidence: number;
      mixed_languages: boolean;
    };
    document_structure: {
      type: "printed_text" | "handwritten" | "mixed" | "table" | "form" |
            "newspaper_clipping" | "photo_of_document" | "diagram";
      has_annotations: boolean;
      has_marginalia: boolean;
      multi_column: boolean;
    };
    content_completeness: {
      pages_total: number;
      pages_readable: number;
      missing_pages_suspected: boolean;
      truncated: boolean;
    };
  };
}

type ExtractionPath =
  | "standard"                        // Good quality, normal pipeline
  | "enhanced_ocr"                    // Poor scan, OCR preprocessing needed
  | "visual_extraction"               // Gemini Vision extraction instead of OCR
  | "handwriting_recognition"         // Handwriting special path
  | "manual_transcription_required"   // Automatic processing not viable
  | "skip";                           // Unusable, don't process
```

### 4.4 Assessment Method

**Primary: Gemini Vision Assessment.** Document sent as image to Gemini with prompt asking to evaluate text readability, image quality, document structure, language, and completeness. Gemini can visually assess what no OCR confidence score captures: Is this a photo of a handwritten letter? Is the copy so degraded that only a human can decipher it?

**Secondary: OCR Confidence Analysis.** For documents that go through OCR: aggregated character-level confidence. If average falls below threshold (default: 0.7), the document is rated `low` quality.

### 4.5 Routing Logic

```
Document
  ↓
Quality Assessment
  ↓
┌──────────────┬──────────────────┬────────────────────┬──────────────────────────┐
│ high quality │ medium quality   │ low quality        │ unusable                 │
│ → standard   │ → enhanced_ocr   │ �� visual_extract.  │ → manual queue           │
│   pipeline   │   or visual      │   or manual        │   (don't process)        │
│              │   extraction     │   transcription    │                          │
└──────────────┴──────────────────┴────────────────────┴──────────────────────────┘
```

### 4.6 Quality Propagation

Quality assessment propagates downstream. Everything extracted from a `low`-quality document inherits a quality marker:

```typescript
interface QualityPropagation {
  source_document_quality: "high" | "medium" | "low";
  extraction_path: ExtractionPath;
  extraction_confidence: number;
}
```

This marker affects:
- **Embeddings:** Low extraction confidence → lower weight in similarity search
- **Assertions:** Assertions from low-quality documents get lower confidence in §A3
- **Agent:** Agent sees extraction quality and can factor it into assertion evaluation
- **Reports:** Reports flag information from low-quality extractions

### 4.7 Batch Assessment

For initial ingest of a large archive: batch mode that assesses all documents first and produces a quality report before the pipeline starts.

```typescript
interface BatchQualityReport {
  total_documents: number;
  quality_distribution: { high: number; medium: number; low: number; unusable: number };
  estimated_manual_effort_hours: number;
  recommended_action: string;
  documents_by_issue: {
    handwritten: number;
    blurry_scan: number;
    multi_generation_copy: number;
    newspaper_clipping: number;
    mixed_content: number;
    other: number;
  };
}
```

### 4.8 Configuration

```yaml
document_quality:
  enabled: true
  assessment:
    method: "gemini_vision"            # "gemini_vision" | "ocr_confidence" | "both"
    engine: "gemini-2.5-pro"
    ocr_confidence_threshold: 0.7
  routing:
    high: { path: "standard" }
    medium: { path: "enhanced_ocr", fallback: "visual_extraction" }
    low: { path: "visual_extraction", fallback: "manual_transcription_required" }
    unusable: { path: "skip", create_manual_task: true }
  quality_propagation:
    enabled: true
    low_quality_embedding_weight: 0.5
    low_quality_assertion_penalty: 0.3
  manual_queue:
    enabled: true
    notify_reviewers: true
    priority: "normal"
```

### 4.9 Open Questions

- Should Mulder actively improve damaged documents (image enhancement) or only assess and route?
- How are audio/video sources handled? (Transcription is a separate problem, not covered by OCR pipeline.)
- Should there be re-assessment when Gemini models improve? (Documents that are `unusable` today might be processable in a year.)
- Cost estimate: Gemini Vision assessment for 2,000 documents — what does the batch cost?

---

## §A5 — Access Control & Sensitivity Levels (F-20)

> **Extends:** §4.3 (Core Schema — adds fields to all tables)
>
> **What exists:** No access control. All data visible to all users. Single-user CLI operation assumed.
>
> **What this adds:** Sensitivity tagging on every artifact from first ingest, automatic PII detection, role-based access control, and an external query gate that prevents sensitive data from leaking into web research queries.

### 5.1 Two-Layer Model

**Layer 1: Sensitivity Levels (data layer)** — which data is how sensitive.
**Layer 2: Role-Based Access Control (user layer)** — who can see what.

### 5.2 Sensitivity Levels

Every artifact in the system (document, entity, assertion, embedding, graph edge) receives a sensitivity level:

```typescript
type SensitivityLevel = "public" | "internal" | "restricted" | "confidential";

interface SensitivityMetadata {
  level: SensitivityLevel;
  reason: string;                     // e.g., "contains_witness_identity"
  assigned_by: "llm_auto" | "human" | "policy_rule";
  assigned_at: string;
  pii_types: PIIType[];
  declassify_date: string | null;     // Optional: date when level can be lowered
}

type PIIType =
  | "person_name" | "contact_info" | "medical_data"
  | "location_private" | "location_sighting"
  | "financial" | "unpublished_research" | "legal";
```

**Automatic detection** in the Enrich step: LLM scans extracted content for PII and sensitive information based on configurable rules.

**Granularity:** Sensitivity is assigned at the finest level and propagates upward. A document can be `internal`, but individual entities within it can be `restricted` (e.g., a witness name in an otherwise public report).

### 5.3 Role-Based Access Control

```typescript
interface Role {
  id: string;
  name: string;
  max_sensitivity_level: SensitivityLevel;
  permissions: Permission[];
}

type Permission =
  | "read" | "write" | "review" | "classify"
  | "delete" | "admin" | "export" | "agent_config";
```

### 5.4 External Query Gate

**Critical for §A16 (Agent) + F-06 (Web Research).** When the agent performs web research, internal data must never appear in search queries.

```typescript
interface ExternalQueryGate {
  sanitize(query: string, context: QueryContext): SanitizedQuery;
}

interface SanitizedQuery {
  query: string;                      // Sanitized query
  removed_terms: string[];            // What was removed?
  sensitivity_violations: string[];   // What sensitive data almost leaked?
  approved: boolean;                  // May the query go out?
}
```

Rules: No person names (except public figures), no contact information, no medical details, no unpublished research. When in doubt: block the query and log it.

### 5.5 Configuration

```yaml
access_control:
  enabled: true
  sensitivity:
    levels: ["public", "internal", "restricted", "confidential"]
    default_level: "internal"
    auto_detection: true
    propagation: "upward"             # Most restrictive level wins
  rbac:
    roles_source: "config/roles.yaml"
    default_role: "analyst"
  external_query_gate:
    enabled: true
    llm_check: true
    pattern_blocklist: true
    block_on_uncertainty: true
    log_all_queries: true
  audit:
    log_access: true
    log_sensitivity_changes: true
    retention_days: 730               # 2 years
```

### 5.6 Open Questions

- GDPR compliance: Does Mulder need a deletion concept for personal data independent of §A6?
- Pseudonymization: Should witness names be system-wide pseudonymized (Witness A, Witness B) with resolution only for `restricted` roles?
- Encryption at rest: Should `confidential` artifacts be additionally encrypted?
- Audit log access: Who can see who accessed what when?

---

## §A6 — Source Provenance Tracking & Rollback (F-10)

> **Extends:** §2.1 (Ingest), §3.4 (Cascading Reset), §4.3 (Core Schema)
>
> **What exists:** §3.4 defines cascading reset for `--force` re-runs — delete downstream data then rewrite. Sources can be removed manually from the database, but there's no structured rollback mechanism.
>
> **What this adds:** Provenance tracking on every artifact, two-phase source rollback (soft-delete + cascading purge), undo window, and audit log. Different concern from `--force`: force = "redo this step", rollback = "remove this source entirely."

### 6.1 Provenance Tracking

Every artifact in the system must know its origin:

```typescript
interface ArtifactProvenance {
  source_document_ids: string[];      // Which documents contributed to this artifact?
  extraction_pipeline_run: string;    // Which pipeline run created this?
  created_at: string;                 // ISO8601
}
```

This tracking must be present on: entities, entity_aliases, entity_edges, story_entities, chunks, assertions (§A3), credibility profiles (§A8), conflict nodes (§A9), similarity links (§A10).

### 6.2 Two-Phase Rollback

**Phase 1: Soft-Delete (synchronous, immediate)**

```typescript
interface SourceDeletion {
  source_document_id: string;
  deleted_by: string;                 // User ID
  deleted_at: string;                 // ISO8601
  reason: string;                     // Required
  status: "soft_deleted" | "purging" | "purged" | "restored";
  undo_deadline: string;              // Default: 72h after deleted_at
}
```

Effect: All queries, agent access, and reports immediately ignore `soft_deleted` documents. No latency, no purge job needed.

**Phase 2: Cascading Purge (asynchronous, Cloud Run Job)**

Runs after the undo window expires. Cascade in defined order:

| Step | Subsystem | Action |
|------|-----------|--------|
| 1 | Document Store | Delete original document + all translations (§A7) |
| 2 | Segment Store | Delete all extracted segments |
| 3 | Assertion Store | Assertions with *only* this source as provenance → delete |
| 4 | Assertion Store | Assertions with *multiple* sources → remove source_ref, keep assertion |
| 5 | Embedding Store | Delete all vectors referencing deleted documents or segments |
| 6 | Knowledge Graph | Nodes sourced exclusively from this source → delete. Edges with reference → remove. Orphaned nodes → mark as `orphaned` |
| 7 | Credibility Profiles (§A8) | Profile persists (source-independent) but `usage_count` is decremented |
| 8 | Research Journal (§A16) | Journal entries referencing this source → annotate with `[SOURCE REMOVED: {reason}]`, not delete |
| 9 | Reports (§A16) | Generated reports → mark as `stale`, not delete |
| 10 | Audit Log | Write purge protocol: what was deleted, what was annotated, timestamps |

**Undo:** Within the undo window (configurable, default 72h), a soft-delete can be reversed. Status changes to `restored`, all artifacts become visible again. After the window expires or manual confirmation, the purge job runs automatically.

### 6.3 Configuration

```yaml
source_rollback:
  undo_window_hours: 72
  auto_purge_after_undo_window: true
  require_reason: true
  require_confirmation: true          # Second confirmation before purge
  orphan_handling: "mark"             # "mark" | "delete" — orphaned graph nodes
  journal_annotation: true            # Annotate journal entries rather than delete
  notify_on_purge: true               # Notify admins
```

### 6.4 Safety Measures

1. **Mandatory reason.** No delete without `reason`.
2. **Undo window.** Protection against accidental deletion.
3. **Confirmation step.** Second confirmation before final purge.
4. **Audit log.** Complete protocol of who deleted what, when, and why.
5. **Journal preservation.** Agent findings are annotated, not deleted. The agent should know a source was removed — that itself is relevant information.
6. **No silent cascade.** The purge job explicitly reports which dependent artifacts are affected before deleting.

### 6.5 Open Questions

- Should there be a "dry run" mode that shows what *would* be deleted without actually doing it?
- How are sources treated that are referenced in active agent sessions? Wait until session ends, or soft-delete immediately?
- Should there be a bulk operation (e.g., "remove all sources from author X")?
- Archival as alternative to deletion? (Document removed from active analysis but preserved in cold storage for audit purposes.)

---

## §A7 — Document Translation Service (F-08)

> **Extends:** §2.1 (Ingest)
>
> **What exists:** No translation capability. Documents are processed in their original language.
>
> **What this adds:** Translation as an ingest-layer capability with two paths (full pipeline, translation-only), persistent caching, and configurable target languages.

### 7.1 Problem

Research teams may include members who don't read all relevant languages. Relevant literature, government documents, and research papers may exist in languages inaccessible to parts of the team. Without translation, these sources remain partially or fully unusable for some researchers. Additionally, translations should be persistently stored to avoid redundant costs and latency.

### 7.2 Two Paths

- **Full Pipeline:** Document is ingested, translated, and runs through the full 8-step cycle (Extract → … → Analyze). Translation is a byproduct.
- **Translation-Only:** Simplified path for pure reading access. Ingest → Translate → Output. No enrichment, no graph, no embedding. Fast and cheap.

### 7.3 Data Model

```typescript
interface TranslatedDocument {
  id: string;
  source_document_id: string;         // Reference to original
  source_language: string;            // ISO 639-1 (auto-detected)
  target_language: string;            // ISO 639-1
  translation_engine: string;         // e.g., "gemini-2.5-flash"
  translation_date: string;           // ISO8601
  content: string;                    // Markdown/HTML, no PDF layout rebuild
  content_hash: string;               // For cache invalidation on original change
  status: "current" | "stale";        // "stale" if original was updated
  pipeline_path: "full" | "translation_only";
}
```

**Cache logic:** Before every translation, check if a current translation exists for the pair `(source_document_id, target_language)`. Cache hit → serve directly, no LLM call. Cache invalidation: when the original document is updated, all associated translations are set to `status: "stale"`. Re-translation happens on demand, not automatically.

**Output format:** Markdown as default (structured, searchable, lightweight). HTML as option for complex layouts. No PDF layout rebuild — too error-prone and expensive.

### 7.4 Configuration

```yaml
translation:
  enabled: true
  default_target_language: "en"
  supported_languages: ["de", "en", "fr", "es", "pt", "ru", "zh", "ja", "pl", "cs"]
  engine: "gemini-2.5-flash"
  output_format: "markdown"           # "markdown" | "html"
  cache_enabled: true
  max_document_length_tokens: 500000  # Longer documents are chunked
```

### 7.5 Open Questions

- Should the translation-only path also be accessible via UI as an explicit action, or only via API/config?
- Quality control: Should a second LLM pass verify translation consistency (expensive but valuable for technical texts)?
- Terminology glossary: Should domain-specific terms be maintained in a glossary fed to the translation engine?

---

## §A8 — Multi-Dimensional Source Credibility Profiles (F-09)

> **Replaces:** §2.8 source reliability scoring (PageRank → single float)
>
> **What exists:** §2.8 defines source reliability scoring via weighted PageRank on a source graph built from cross-source entity co-occurrence, producing a single `sources.reliability_score` float (0–1).
>
> **What this replaces with:** Multi-dimensional credibility profiles with N configurable dimensions. No aggregate score. PageRank becomes one possible input signal, not the sole score. The `sources.reliability_score` column is superseded by the credibility profile table.

### 8.1 Problem

A one-dimensional credibility score is insufficient and potentially dangerous. A government institution may have high institutional authority but documented unreliability in a specific domain, with known motives for disinformation. A naive score ("government = credible") would systematically overweight such statements — the exact opposite of the §A3 design philosophy.

### 8.2 Data Model

```typescript
interface SourceCredibilityProfile {
  source_id: string;
  source_name: string;
  source_type: "government" | "academic" | "journalist" | "witness" |
               "organization" | "anonymous" | "other";

  // Dimensions (configurable via ontology config — see §D5)
  dimensions: CredibilityDimension[];

  // Meta
  profile_author: "llm_auto" | "human" | "hybrid";
  last_reviewed: string;              // ISO8601
  review_status: "draft" | "reviewed" | "contested";  // → §A13
}

interface CredibilityDimension {
  id: string;                         // From config, e.g., "institutional_authority"
  label: string;                      // Display label from config
  score: number;                      // 0.0–1.0
  rationale: string;                  // Required justification
  evidence_refs: string[];            // Supporting evidence references
  known_factors: string[];            // e.g., known motives or biases
}
```

**Default dimensions** (configurable, not hard-coded):

| Dimension | Description |
|-----------|-------------|
| `institutional_authority` | Formal recognition, legal binding |
| `domain_track_record` | Historical reliability in the specific domain |
| `conflict_of_interest` | 0.0 = no conflict, 1.0 = severe conflict |
| `transparency` | Verifiability of claims |
| `consistency` | Internal consistency over time |

### 8.3 Design Principles

1. **No aggregate score.** Never combine dimensions into a single float. This hides nuance and invites misuse.
2. **No exclusion.** The credibility profile contextualizes, it does not censor. A source with a poor profile is included but flagged.
3. **Human-in-the-loop.** LLM-generated profiles are always drafts. Humans have the final word (→ §A13).
4. **Symmetry.** Dimensions apply equally to all sources — including internal documents and well-known authorities. Consistent with §A3.

### 8.4 Pipeline Integration

- **Enrich step:** On ingest of a new source, check for existing credibility profile. If none → LLM proposes a draft profile (`profile_author: "llm_auto"`, `review_status: "draft"`). Team is notified that review is needed.
- **Agent (§A16):** Agent sees all dimensions, not an aggregated score. Reasoning instruction: "Consider credibility dimensions but never fully ignore a source. A source with low track record can still contain correct observations."
- **Reports (§A16):** Reports include a compact display of relevant credibility dimensions per source reference (not all dimensions, only contextually relevant ones).

### 8.5 Configuration

```yaml
credibility:
  enabled: true
  dimensions:
    - id: "institutional_authority"
      label: "Institutional authority"
    - id: "domain_track_record"
      label: "Domain track record"
    - id: "conflict_of_interest"
      label: "Conflict of interest"
    - id: "transparency"
      label: "Transparency / verifiability"
    - id: "consistency"
      label: "Internal consistency over time"
  auto_profile_on_ingest: true
  require_human_review: true
  display_in_reports: true
  agent_instruction: "weight_but_never_exclude"
```

### 8.6 Open Questions

- Should credibility profiles be versioned (e.g., when an institution improves its transparency)?
- How granular? One profile per institution, or per sub-unit?
- Should the agent document its own assessment of source reliability in findings, even when it diverges from the manual profile?
- Interaction with web research (§A16/F-06): How are web sources evaluated that can't be matched to a predefined profile?

---

## §A9 — Contradiction Management (F-17)

> **Extends:** §2.7 (Graph — contradiction flagging), §2.8 (Analyze — contradiction resolution)
>
> **What exists:** Two-phase contradiction handling — fast attribute-diff flagging creates `POTENTIAL_CONTRADICTION` edges (§2.7), LLM resolves to `CONFIRMED` or `DISMISSED` with explanation (§2.8).
>
> **What this adds:** Promotes contradictions to first-class graph entities with typed conflict categories, severity levels, typed resolution reasons, and review workflow integration. The existing two-phase approach becomes the detection mechanism feeding into a richer model.

### 9.1 Problem

Contradictions are not errors — they are research subjects. When one witness reports "silent" and another reports "deep humming" about the same event, that's not a database problem but information that needs explanation. Possible explanations range from different observation positions to different time points to perception differences to unreliability of a source.

The functional spec mentions "Contradiction Detection" as a capability, but there's no spec for how contradictions are modeled, managed, and utilized beyond CONFIRMED/DISMISSED.

### 9.2 Data Model

```typescript
interface ConflictNode {
  id: string;
  conflict_type: ConflictType;
  assertions: ConflictAssertion[];    // At least 2
  detection_method: "llm_auto" | "statistical" | "human_reported";
  detected_at: string;
  detected_by: string;                // Pipeline run ID, agent session ID, or user ID

  resolution_status: "open" | "explained" | "confirmed_contradictory" | "false_positive";
  resolution: ConflictResolution | null;

  severity: "minor" | "significant" | "fundamental";
  severity_rationale: string;

  review_status: string;              // → §A13
}

type ConflictType =
  | "factual"                         // Contradictory empirical claims
  | "interpretive"                    // Contradictory interpretations of same facts
  | "taxonomic"                       // Contradictory classifications
  | "temporal"                        // Contradictory time data
  | "spatial"                         // Contradictory location data
  | "attributive";                    // Contradictory attribute assignments

interface ConflictAssertion {
  assertion_id: string;
  source_document_id: string;
  assertion_type: string;             // "observation" | "interpretation" | "hypothesis" (→ §A3)
  claim: string;                      // Natural language summary
  credibility_profile_id: string | null;  // → §A8
}

interface ConflictResolution {
  resolution_type: ResolutionType;
  explanation: string;
  resolved_by: string;
  resolved_at: string;
  evidence_refs: string[];
  review_status: string;              // Resolution itself is reviewable (→ §A13)
}

type ResolutionType =
  | "different_vantage_point"         // Different observation perspectives
  | "different_time"                  // Different points in time of same event
  | "measurement_error"               // Measurement error in one or both sources
  | "source_unreliable"               // One source unreliable (cross-ref §A8)
  | "scope_difference"                // Claims refer to different aspects
  | "genuinely_contradictory"         // Real, unresolvable contradiction
  | "duplicate_misidentification"     // Falsely identified as contradiction
  | "other";
```

### 9.3 Severity Classification

| Severity | Criteria | Example |
|----------|----------|---------|
| **minor** | Contradiction concerns peripheral details, not core claims | Time discrepancy of 30 minutes |
| **significant** | Contradiction concerns an essential property of the documented event | "Silent" vs. "Deep humming" |
| **fundamental** | Contradiction concerns the existence or nature of the event itself | "Event confirmed" vs. "Event was misidentification" |

Severity is initially assessed by LLM, but is reviewable (→ §A13).

### 9.4 Detection: Three Paths

1. **Pipeline detection (automatic, Enrich step):** On ingest of new documents, LLM compares extracted assertions against existing assertions. Semantically similar but contradictory → create ConflictNode. Uses embedding similarity band (too close = duplicate, too far = unrelated), shared entity requirement, and LLM confirmation.
2. **Agent detection (research loop, §A16):** The agent actively searches for contradictions as part of its research. Contradiction density is a signal for the exploration scheduler.
3. **Human-reported (manual):** Team members can manually report contradictions the system didn't catch.

### 9.5 Graph Modeling

ConflictNode is a node in the Knowledge Graph with edges to participating assertions:

```
[Assertion A] --CONTRADICTS--> [ConflictNode] <--CONTRADICTS-- [Assertion B]
                                     |
                                     +-- conflict_type: "factual"
                                     +-- severity: "significant"
                                     +-- resolution_status: "open"
```

### 9.6 Integration

- **§A3 (Assertions):** A contradiction between two observations is more relevant than one between two interpretations. `assertion_type` informs severity assessment.
- **§A8 (Credibility):** Sources disproportionately involved in contradictions → signal for credibility profile (`consistency` dimension).
- **§A10 (Similar Cases):** Cases with similar contradiction patterns may be related.
- **§A12 (Temporal):** Time periods with elevated contradiction density may indicate contaminated source material or disinformation campaigns.
- **§A13 (Review):** ConflictNodes and resolutions are reviewable artifacts.

### 9.7 Configuration

```yaml
contradiction_management:
  enabled: true
  conflict_types: ["factual", "interpretive", "taxonomic", "temporal", "spatial", "attributive"]
  severity_levels: ["minor", "significant", "fundamental"]
  detection:
    pipeline: true
    agent: true
    human_reported: true
    embedding_similarity_band: [0.3, 0.8]
    require_shared_entity: true
    llm_confirmation: true
    llm_engine: "gemini-2.5-pro"
    min_confidence: 0.7
  auto_severity_assessment: true
  review:
    conflict_detection: "single_review"
    resolution: "single_review"
  metrics:
    track_contradiction_density: true
    track_resolution_rate: true
    feed_credibility_profiles: true    # → §A8
```

### 9.8 Open Questions

- How are transitive contradictions handled? (A contradicts B, B contradicts C, but A and C are consistent.)
- Should the system detect contradictions between agent hypotheses (§A16) and new observations?
- How to prevent a flood of false-positive contradictions during mass ingest?
- Should resolved contradictions remain in the graph or be archived?

---

## §A10 — Similar Case Discovery (F-11)

> **Extends:** §5 (Retrieval System)
>
> **What exists:** §5 defines hybrid retrieval (vector + BM25 + graph traversal) with RRF fusion for search. §2.7 has MinHash deduplication for near-duplicates.
>
> **What this adds:** Dedicated multi-dimensional similarity analysis with configurable dimensions, on-demand and automatic modes, explanation generation, and automatic SIMILAR_TO edge creation in the graph.

### 10.1 Problem

Researchers have been working with document collections for decades. The central question for every case is: are there similar cases, and what do the similarities reveal? Today this relies on individual experience and memory — a method that doesn't scale, isn't reproducible, and systematically misses cases documented in other languages, classification systems, or archives.

Mulder has all building blocks for multimodal similarity search: embeddings (semantic), knowledge graph (structural), PostGIS (geospatial), timestamps (temporal). What's missing is a dedicated feature that combines these dimensions and makes results explainable.

### 10.2 Similarity Dimensions

```typescript
// Core: Always available (built-in)
interface CoreSimilarityDimensions {
  semantic: number;                   // Vector cosine similarity of entity embeddings
  structural: number;                 // Graph distance (shared entities, edge overlap)
  geospatial: number;                // Geographic proximity (PostGIS ST_Distance)
  temporal: number;                   // Temporal proximity (days/months/years)
}

// Domain: From ontology config (see §D1 Rule 6)
interface DomainSimilarityDimension {
  id: string;                         // e.g., "classification_similarity"
  label: string;                      // Display label from config
  score: number;
  source: "taxonomy_mapping" | "attribute_comparison" | "custom_scorer";
  config_ref: string;                 // Reference to ontology definition
}

interface SimilarityResult {
  entity_id: string;
  entity_title: string;
  overall_rank: number;               // Sorted by weighted combination
  core: CoreSimilarityDimensions;
  domain: DomainSimilarityDimension[];
  explanation: string;                // Natural language, 2-3 sentences
  shared_entities: string[];
  key_differences: string[];
}
```

Each dimension produces a 0.0–1.0 score. Dimensions are **not** combined into an aggregate score (consistent with §A8). Users and the agent see individual values plus a natural language explanation.

### 10.3 Two Modes

**Query mode (on demand):** User selects an entity and asks "show me similar entities." Configurable: minimum similarity per dimension, max results, dimension weights for sorting.

**Auto mode (on ingest):** Every newly ingested entity is automatically compared against the existing corpus. If similarities exceed configurable thresholds, a `SIMILAR_TO` edge is created in the graph and optionally an alert is triggered.

### 10.4 Technical Implementation

1. **Candidate retrieval (fast, broad):** pgvector top-100 semantically similar entities (ANN search, milliseconds). PostGIS geographic radius. Temporal window. Union of candidate sets → typically 50-300 candidates.
2. **Multi-dimensional scoring (precise):** For each candidate pair, compute all dimensions. Structural via graph query (shared entities, path length). Domain dimensions via taxonomy mappings (§A11) and attribute comparison.
3. **Explanation generation:** LLM call (Gemini Flash) per top-N result: natural language explanation of similarity + differences. Short, 2-3 sentences.

### 10.5 Configuration

```yaml
similar_case_discovery:
  enabled: true
  candidate_retrieval:
    vector_top_k: 100
    geo_radius_km: null               # null = no geo filter at retrieval
    temporal_window_years: null        # null = no time filter at retrieval
  scoring:
    core_dimensions: ["semantic", "structural", "geospatial", "temporal"]
    weights:
      semantic: 0.25
      structural: 0.2
      geospatial: 0.15
      temporal: 0.1
    # Domain dimensions configured in ontology (see §D4)
  explanation:
    enabled: true
    engine: "gemini-2.5-flash"
    max_tokens: 200
  auto_discovery:
    enabled: true
    trigger: "on_ingest"
    threshold: 0.6
    create_graph_edge: true
    edge_type: "SIMILAR_TO"
    max_auto_links: 10
```

### 10.6 Open Questions

- Should similarity search also work on sub-aspects of an entity (e.g., "find entities with similar descriptions" without geospatial proximity)?
- How are entities described in multiple documents handled (deduplication vs. merging)?
- Performance: At 100,000+ entities — is ANN search sufficient for candidate retrieval, or is a precomputed similarity index needed?
- Should users interactively adjust dimension weights (slider UI)?

---

## §A11 — Classification System Harmonization (F-12)

> **Extends:** §6 (Taxonomy System)
>
> **What exists:** §6 defines a single taxonomy system with bootstrap (§6.1), normalization during enrich (§6.2), and human-in-the-loop curation (§6.3). Taxonomies are flat: one canonical ID with language variants.
>
> **What this adds:** Multiple parallel classification taxonomies with weighted, directed cross-taxonomy mappings. Enables entities classified in different systems to be compared and correlated.

### 11.1 Problem

Research domains often use multiple parallel classification systems that have evolved historically, are partially incompatible, and vary in granularity. Without harmonization, the similar case discovery (§A10) can't find cross-system patterns, and the agent (§A16) treats different labels for the same concept as separate concepts.

### 11.2 Data Model

```typescript
interface ClassificationTaxonomy {
  id: string;                         // e.g., "taxonomy_a", "taxonomy_b"
  name: string;
  version: string;                    // Taxonomies evolve
  language: string;                   // Original language
  description: string;
  categories: ClassificationCategory[];
}

interface ClassificationCategory {
  id: string;                         // e.g., "taxonomy_a:category_3"
  taxonomy_id: string;
  code: string;
  label: string;
  label_translations: Record<string, string>;
  definition: string;                 // Official definition
  parent_id: string | null;           // For hierarchical taxonomies
  attributes: string[];               // Defining attributes
}

interface TaxonomyMapping {
  id: string;
  source: { taxonomy_id: string; category_id: string };
  target: { taxonomy_id: string; category_id: string };
  mapping_type: "equivalent" | "broader" | "narrower" | "overlapping" | "related";
  confidence: number;                 // 0.0–1.0
  conditions: string | null;          // When does this mapping apply?
  rationale: string;
  mapping_author: "llm_auto" | "human" | "hybrid";
  review_status: "draft" | "reviewed" | "contested";  // → §A13
}
```

**Mapping types:**

| Type | Meaning |
|------|---------|
| `equivalent` | Semantically identical |
| `broader` | Source is more general than target |
| `narrower` | Source is more specific than target |
| `overlapping` | Partial overlap, not congruent |
| `related` | Thematically related but structurally different |

### 11.3 Pipeline Integration

In the **Enrich step** (§2.4):
1. LLM extracts classification references from the document.
2. Match against known taxonomies: Is this a reference to a known taxonomy? Or does the author use a custom definition?
3. If mapping exists → classification annotated in all mapped taxonomies (with confidence).
4. If no mapping exists → new category inserted as `draft`, LLM proposes mappings, team reviews (→ §A13).

**Similar Case Discovery (§A10):** Domain similarity dimensions use taxonomy mappings. Two entities classified in different systems get a high similarity score if an `equivalent` or `overlapping` mapping exists. Mapping confidence feeds into the score.

### 11.4 Configuration

```yaml
taxonomy:
  harmonization:
    enabled: true
    taxonomies:
      - id: "taxonomy_a"
        source: "config/taxonomies/taxonomy_a.yaml"
        status: "active"
      - id: "taxonomy_b"
        source: "config/taxonomies/taxonomy_b.yaml"
        status: "active"
    auto_mapping:
      enabled: true
      engine: "gemini-2.5-pro"        # Pro, not Flash — mapping requires reasoning
      require_human_review: true
      min_confidence_for_auto_link: 0.7
    extraction:
      detect_classification_refs: true
      detect_implicit_classifications: true
```

### 11.5 Open Questions

- How to handle authors who misapply classification systems?
- Should Mulder have a "canonical" internal taxonomy (superset of all external ones), or work only with mappings between external systems?
- Versioning: Should Mulder support different versions of the same taxonomy?
- Visualization: How does the Knowledge Graph Explorer display taxonomy mappings?

---

## §A12 — Temporal Pattern Detection & Flap Analysis (F-13)

> **Extends:** §2.8 (Analyze — spatio-temporal clustering)
>
> **What exists:** §2.8 defines basic spatio-temporal clustering using PostGIS `ST_DWithin` and temporal windowing. Results stored as `spatio_temporal_clusters`.
>
> **What this adds:** Three-level statistical analysis (anomaly detection, hotspot clustering, external correlation), configurable external data source plugins, and bias controls. Significantly more rigorous than the basic clustering in §2.8.

### 12.1 Three Analysis Levels

#### Level 1: Temporal Anomaly Detection

Automatic detection of time periods with statistically significant elevated event frequency.

```typescript
interface TemporalAnomalyCluster {
  id: string;
  region: GeoJSON;
  time_start: string;                 // ISO8601
  time_end: string;
  entity_count: number;
  baseline_rate: number;              // Expected rate (events/month) based on historical average
  observed_rate: number;
  significance: number;               // p-value or z-score
  peak_date: string;
  dominant_category: string | null;   // Most common classification (via §A11)
  contributing_entity_ids: string[];
  known_pattern_match: string | null; // Reference to configured known pattern
}
```

**Method:** Time series of event frequency per region (configurable granularity: day/week/month). Sliding-window anomaly detection against historical baseline. Poisson-based anomaly detection (events as rare occurrences), CUSUM for changepoint detection. Minimum significance configurable (default: p < 0.05 after Bonferroni correction for multiple regions).

#### Level 2: Spatiotemporal Clustering

Geographic hotspot identification and evolution over time.

```typescript
interface SpatiotemporalCluster {
  id: string;
  centroid: { lat: number; lng: number };
  radius_km: number;
  time_window: { start: string; end: string };
  entity_count: number;
  density: number;                    // Entities per km² per month
  persistence: "transient" | "recurring" | "permanent";
  recurrence_pattern: string | null;
  related_cluster_ids: string[];
}
```

**Method:** DBSCAN or HDBSCAN on (lat, lng, time) tuples (PostGIS + application code). Separate analysis per time window → hotspot evolution over time. Persistence classification: transient (one occurrence), recurring (periodic), permanent (ongoing).

#### Level 3: External Correlation Analysis

Correlation of internal time series with external data sources.

```typescript
interface CorrelationResult {
  id: string;
  internal_series: string;
  external_series: string;
  method: "pearson" | "spearman" | "granger_causality" | "cross_correlation";
  correlation_coefficient: number;
  p_value: number;
  lag_days: number;                   // Time offset with strongest signal
  time_window: { start: string; end: string };
  interpretation_caveat: string;      // Always: "Correlation ≠ Causation"
}
```

**External data source plugin interface** (see §D1 Rule 4):

```typescript
interface ExternalDataSource {
  id: string;
  name: string;
  description: string;
  type: "time_series" | "event_list" | "static_dataset";
  update_frequency: "realtime" | "daily" | "weekly" | "monthly" | "yearly" | "manual";
  fetch(): Promise<DataPoint[]>;
}
```

### 12.2 Bias Controls

1. **Bonferroni correction** for anomaly detection across multiple regions (prevents false positives from multiple testing).
2. **Reporting bias warning:** Elevated event frequency following major media coverage is automatically flagged as potentially report-induced (not phenomenon-induced).
3. **Confirmation bias protection:** The agent may use detected anomalies and correlations as hypothesis starting points, but they count as `weak signal` (§A16), not `moderate evidence` — unless supported by independent observations.
4. **Mandatory caveat:** Every external correlation is annotated with "Correlation ≠ Causation" — in reports and in the journal.

### 12.3 Configuration

```yaml
temporal_pattern_detection:
  enabled: true
  schedule: "weekly"
  anomaly_detection:
    enabled: true
    min_entities: 5
    significance_threshold: 0.05
    baseline_window_years: 10
    granularity: "month"
    region_grid: "country"            # "country" | "admin1" | "hex_grid_100km"
  hotspot_clustering:
    enabled: true
    algorithm: "hdbscan"
    min_cluster_size: 3
    temporal_granularity: "year"
    persistence_threshold_years: 5
  external_correlation:
    enabled: true
    series: []                        # Configure via external data source plugins
    methods: ["spearman", "cross_correlation"]
    min_data_points: 30
    max_lag_days: 90
    always_include_caveat: true
  reporting_bias:
    correction_enabled: true
    correction_field: null             # Configure in ontology (see §D4)
```

### 12.4 Open Questions

- How to handle reporting bias? Regions with active research groups have more documented events — that's an observation effect, not a phenomenon. Should Mulder apply a "researcher density" correction?
- Should Mulder also detect *absences*? ("Between 1995 and 2005, region X had unusually *few* events — why?")
- Region granularity: Fixed grid, administrative boundaries, or dynamic regions based on event density?
- Integration with external database projects: Should their time series be available as input for pattern detection even if individual entries aren't ingested?

---

## §A13 — Collaborative Review Workflow (F-16)

> **Extends:** All features producing LLM-generated artifacts
>
> **What exists:** No review system. LLM-generated artifacts (entity extraction, taxonomy normalization) are accepted as-is.
>
> **What this adds:** A domain-agnostic annotation and review layer applicable to any reviewable artifact in the system. Not a separate UI silo but a cross-cutting system integrated into all features.

### 13.1 Problem

Mulder produces LLM-generated artifacts at multiple points that require human review before they can be trusted:
- §A3: Observation/interpretation/hypothesis classification
- §A8: Credibility profile drafts
- §A11: Taxonomy mapping suggestions
- §A10: Similar case links (auto-discovery)
- §A16: Agent findings and journal entries

Without structured review, these artifacts remain permanently in draft status — or worse, are treated as facts without review.

### 13.2 Core Concepts

#### Reviewable Artifact

Every artifact requiring review implements a common interface:

```typescript
interface ReviewableArtifact {
  artifact_id: string;
  artifact_type: string;              // e.g., "assertion_classification", "credibility_profile"
  created_by: "llm_auto" | "human" | "agent";
  created_at: string;
  review_status: ReviewStatus;
  review_history: ReviewEvent[];
  current_value: unknown;             // The artifact being reviewed
  context: ReviewContext;             // Enough context to evaluate the artifact
}

type ReviewStatus =
  | "pending"                         // Not yet reviewed
  | "approved"                        // Manually approved by reviewer
  | "auto_approved"                   // Wait time expired, never reviewed
  | "corrected"                       // Reviewer entered corrected value
  | "contested"                       // Reviewers disagree
  | "rejected";                       // Artifact rejected as incorrect
```

#### Review Event

Every review action is stored as an immutable event:

```typescript
interface ReviewEvent {
  event_id: string;
  artifact_id: string;
  reviewer_id: string;
  timestamp: string;
  action: "approve" | "correct" | "reject" | "comment" | "escalate";
  previous_value: unknown | null;     // For "correct": what was there before?
  new_value: unknown | null;          // For "correct": what is the new value?
  confidence: "certain" | "likely" | "uncertain";
  rationale: string;                  // Required for "correct", "reject", "escalate"
  tags: string[];                     // e.g., ["needs_discussion", "domain_expert_required"]
}
```

#### Review Queue

Artifacts are sorted into thematic queues. Each team member sees queues matching their expertise:

```typescript
interface ReviewQueue {
  queue_id: string;
  name: string;
  artifact_types: string[];
  assignees: string[];
  priority_rules: PriorityRule[];
  pending_count: number;
  oldest_pending: string;
}
```

### 13.3 Disagreement Handling

When reviewers contradict each other — reviewer A approves, reviewer B rejects — the status changes to `contested`. The system does not resolve this automatically.

1. Both positions are documented with rationale in the artifact.
2. The artifact moves to a `contested` queue.
3. Configurable: either a designated reviewer is notified as tiebreaker (`escalation_reviewer`), or the artifact stays contested until consensus.
4. In the Knowledge Graph, a `contested` artifact receives a visual marker — visible but flagged as disputed.

**No majority vote.** In a small research team, two against one is not a quality signal. The disagreement itself is valuable research data.

### 13.4 Review Depth

Not every artifact needs the same review level. Configurable per `artifact_type`:

| Depth | Description | Use Case |
|-------|-------------|----------|
| **Spot-check** | System selects random N% for review. Rest auto-approved after wait time. | Assertion classification at high LLM confidence (>0.9) |
| **Single review** | One reviewer. Approve/correct/reject. | Taxonomy mappings, similar case links |
| **Double review** | Two independent reviewers. Agreement → approved. Disagreement → contested. | Credibility profiles, high-impact agent findings |

### 13.5 Auto-Approve Mechanism

For artifacts with spot-check review or configured wait time: if no review occurs before deadline, status changes to `auto_approved`. This status is distinguishable from `approved` — in the graph, reports, and for the agent, an `auto_approved` artifact is less trustworthy than a manually reviewed one.

### 13.6 Review Metrics & Feedback Loop

The review system collects data on LLM classification accuracy:

```typescript
interface ReviewMetrics {
  artifact_type: string;
  period: { start: string; end: string };
  total_reviewed: number;
  approved_unchanged: number;         // LLM was correct
  corrected: number;                  // LLM was wrong
  rejected: number;                   // LLM produced nonsense
  accuracy_rate: number;              // approved / (approved + corrected + rejected)
  common_corrections: { pattern: string; count: number }[];
}
```

These metrics feed back into the pipeline: if accuracy rate drops below threshold for an artifact type, review depth is automatically upgraded (e.g., spot-check → single review). If consistently high, it can be downgraded.

### 13.7 Configuration

```yaml
review_workflow:
  enabled: true
  artifact_types:
    assertion_classification:
      review_depth: "spot_check"
      spot_check_percentage: 20
      auto_approve_after_hours: 168   # 7 days
      auto_approve_min_confidence: 0.9
    credibility_profile:
      review_depth: "double_review"
      auto_approve_after_hours: null   # Never auto-approve
      escalation_reviewer: null
    taxonomy_mapping:
      review_depth: "single_review"
      auto_approve_after_hours: 336   # 14 days
    similar_case_link:
      review_depth: "single_review"
      auto_approve_after_hours: 168
    agent_finding:
      review_depth: "single_review"
      auto_approve_after_hours: null   # Never auto-approve
  metrics:
    track_accuracy: true
    auto_adjust_depth: true
    accuracy_threshold_for_upgrade: 0.7
    accuracy_threshold_for_downgrade: 0.95
```

### 13.8 Open Questions

- Should the system support "expertise weighting" (e.g., a specialist has more weight on specific source types)?
- How are reviews manageable at high volume? (10,000 assertions during mass ingest → review queue explodes)
- Should there be a gamification element (review progress visible) to encourage participation?
- Offline review: Can artifacts be exported as a batch and reviewed offline?

---

## §A14 — Knowledge Graph Versioning (F-18)

> **Extends:** §4.3 (Core Schema)
>
> **What exists:** No graph versioning. No way to understand how the knowledge graph evolved over time.
>
> **What this adds:** Event-based change log with periodic snapshots. Not a full graph versioning system (too expensive), but a pragmatic audit trail with diff capability.

### 14.1 Change Event Log

Every structural change to the Knowledge Graph is logged as an event:

```typescript
interface GraphChangeEvent {
  event_id: string;
  timestamp: string;
  change_type: "node_created" | "node_updated" | "node_deleted" | "node_merged" |
               "edge_created" | "edge_updated" | "edge_deleted" | "attribute_changed";
  entity_id: string | null;
  edge_id: string | null;
  before: unknown | null;             // State before (null for CREATE)
  after: unknown | null;              // State after (null for DELETE)
  caused_by: {
    type: "ingest" | "purge" | "review" | "agent" | "manual";
    reference_id: string;
  };
  source_document_ids: string[];
}
```

### 14.2 Snapshots

Periodic snapshots capture the graph's overall state as a statistical fingerprint — not a full copy, but structural metadata:

```typescript
interface GraphSnapshot {
  snapshot_id: string;
  timestamp: string;
  node_count: number;
  edge_count: number;
  node_counts_by_type: Record<string, number>;
  edge_counts_by_type: Record<string, number>;
  cluster_count: number;
  largest_cluster_size: number;
  orphan_count: number;
  avg_degree: number;
  top_entities: { entity_id: string; degree: number }[];
  assertion_counts: {
    total: number;
    by_status: Record<string, number>;
    by_type: Record<string, number>;
  };
  conflict_counts: { total: number; open: number; resolved: number };
}
```

### 14.3 Diff Queries

From the change event log and snapshots, diff queries can be answered:

```typescript
interface GraphDiff {
  from: string;                       // ISO8601 or snapshot_id
  to: string;
  nodes_added: number;
  nodes_removed: number;
  nodes_modified: number;
  edges_added: number;
  edges_removed: number;
  edges_modified: number;
  significant_changes: GraphChangeEvent[];
  new_connections: {                  // New edges between previously unconnected clusters
    edge_id: string;
    from_entity: string;
    to_entity: string;
    edge_type: string;
    caused_by: string;
  }[];
}
```

### 14.4 Retention Strategy

Change events generate high volume. Retention must be configurable:

```yaml
graph_versioning:
  change_log:
    enabled: true
    retention_days: 365
    retention_keep_significant: true
    significance_threshold: "node_created|node_deleted|node_merged|edge_between_clusters"
  snapshots:
    enabled: true
    frequency: "weekly"
    retention: "indefinite"
  diff:
    max_range_days: 180
    include_events: true
    max_events_in_diff: 500
```

### 14.5 Open Questions

- Should it be possible to reset the graph to a prior state (graph rollback)? Or is read-only time travel sufficient?
- How are change events manageable during mass ingest? (1,000 documents → potentially 50,000 events)
- Should snapshots serialize the full graph (expensive, exact time travel) or only the statistical fingerprint (cheap, no exact reconstruction)?

---

## §A15 — Export & Interoperability (F-21)

> **Extends:** §1 (CLI — export commands)
>
> **What exists:** §1 mentions `mulder export` commands briefly. No specified data model for export/import.
>
> **What this adds:** Bidirectional data exchange via standardized export formats and configurable import adapters. Export respects sensitivity levels (§A5). Import runs through the full pipeline.

### 15.1 Export

#### Export Scopes

```typescript
interface ExportRequest {
  id: string;
  requested_by: string;
  requested_at: string;
  scope: ExportScope;
  format: ExportFormat;
  sensitivity_max: SensitivityLevel;  // Highest level that may be exported
  include_metadata: boolean;
  include_provenance: boolean;
  include_credibility_profiles: boolean;
  include_review_status: boolean;
  language: string;                   // Export language (translation via §A7)
}

type ExportScope =
  | { type: "entity"; entity_ids: string[] }
  | { type: "subgraph"; root_entity_id: string; depth: number }
  | { type: "query"; query: GraphQuery }
  | { type: "collection"; collection_id: string }
  | { type: "report"; report_id: string }
  | { type: "temporal"; time_range: TimeRange; region?: GeoJSON }
  | { type: "full" };                // Full dataset (admin only)

type ExportFormat =
  | "mulder_native"                   // Mulder internal JSON (lossless)
  | "json_ld"                         // JSON-LD with Schema.org mapping
  | "csv_bundle"                      // CSV files for entities, relations, assertions
  | "rdf_turtle"                      // RDF/Turtle for Semantic Web interop
  | "geojson"                         // GeoJSON for geospatial data
  | "markdown_report"                 // Human-readable (via §A16/F-07)
  | "pdf_report";                     // PDF report (via §A16/F-07)
```

#### Sensitivity Filtering

```typescript
interface ExportFilter {
  max_level: SensitivityLevel;
  pii_handling: "exclude" | "pseudonymize" | "redact";
}
```

Every export is logged for audit (who exported what, when, in what format, how many entities filtered).

### 15.2 Import

#### Import Adapters

```typescript
interface ImportAdapter {
  id: string;
  name: string;
  source_format: string;              // e.g., "external_csv", "partner_api"
  mapping: FieldMapping[];
  taxonomy_mapping_ref: string | null; // Reference to §A11 taxonomy mapping
  default_sensitivity: SensitivityLevel;
  default_credibility_profile: string | null;
  deduplication: boolean;
}

interface FieldMapping {
  source_field: string;
  target_field: string;
  transformation: string | null;      // e.g., "date_parse('MM/DD/YYYY')", "geocode"
}
```

#### Import Workflow

1. **Select adapter** (or configure a new one)
2. **Dry run:** Adapter processes data, shows preview: "500 records found, 23 duplicates, 12 without coordinates."
3. **Review & confirm:** User confirms import.
4. **Pipeline run:** Imported documents run through the full pipeline (Quality Assessment → Extract → Enrich → Graph).
5. **Post-import report:** "500 records imported, 47 new entities, 12 new contradictions, 3 new temporal clusters."

### 15.3 Stable IDs

Architecture prerequisite: All IDs must be stable and referenceable. No auto-increment IDs, no session-dependent IDs.

```typescript
interface EntityIdentifiers {
  mulder_id: string;                  // Internal UUID — stable, never reused
  external_ids: {
    system: string;                   // e.g., external database name
    id: string;                       // ID in external system
  }[];
}
```

### 15.4 Configuration

```yaml
export:
  enabled: true
  formats: ["mulder_native", "json_ld", "csv_bundle", "geojson", "markdown_report", "pdf_report"]
  default_sensitivity_max: "internal"
  default_pii_handling: "pseudonymize"
  require_audit: true
  max_export_entities: 50000

import:
  enabled: true
  adapters: []                        # Configure per instance
  require_dry_run: true
  deduplication: true
  auto_quality_assessment: true       # → §A4
```

### 15.5 Open Questions

- Should Mulder propose a standard interchange format for its domain? (No established standard may exist — Mulder could set a de-facto standard.)
- Bidirectional synchronization with external databases? Or import-only?
- How are conflicts handled on re-import? (Source updated externally but also internally.)
- Licensing: Under what license are exported data shared? Does the export define a data license?

---

## §A16 — Autonomous Research Agent (F-01, F-02, F-03, F-05, F-06, F-07)

> **Entirely new system layer.** No functional spec section extended. This is Phase 2+ functionality that operates on top of the complete core pipeline.

### 16.1 Overview

An LLM-powered agent that iteratively explores the Mulder Knowledge Graph and retrieval layers, autonomously formulates hypotheses, and systematically validates them against internal and external evidence. The agent works autonomously — without human questions as triggers.

```
┌─────────────────────────────────────────────────────┐
│                   System Prompt                      │
│          (Research mandate + constraints)             │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│              Exploration Scheduler (F-02)             │
│         Selects next exploration target               │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│            Agentic Research Loop (F-01)               │
│                                                     │
│  ┌─────────┐  ┌──────────┐  ┌────────┐  ┌───────┐ │
│  │Classic  │  │ Graph    │  │Vector- │  │ Web   │ │
│  │RAG      │  │ RAG      │  │less RAG│  │Search │ │
│  └─────────┘  └──────────┘  └────────┘  └───────┘ │
│                  Tool Interface                      │
└──────────────────────┬──────────────────────────────┘
                       │
          ┌────────────┴────────────┐
          ▼                         ▼
┌──────────────────┐  ┌──────────────────────────────┐
│ Research Journal  │  │ Report Generator (F-07)      │
│ (F-03)           │  │ Daily / Theme / Theory /     │
│                  │  │ Contradiction reports         │
│ Findings         │  └──────────────────────────────┘
│ Hypotheses       │
│ Open Questions   │
└──────────────────┘
```

### 16.2 Agentic Research Loop (F-01)

1. **Exploration:** Agent identifies underexplored areas in the Knowledge Graph (sparsely connected clusters, high contradiction density, unexplained spatiotemporal patterns)
2. **Hypothesis generation:** Formulate a testable hypothesis based on identified patterns
3. **Internal validation:** Systematic querying against all retrieval layers (vector, full-text, graph)
4. **External validation:** Web research for independent confirmation or refutation (→ F-06)
5. **Assessment:** Credibility scoring of hypothesis based on collected evidence
6. **Documentation:** Persist finding in Research Journal (→ F-03)
7. **Iteration:** Select next exploration target based on results so far

**Technical implementation:** Orchestrated as Cloud Run Job chain (not a single endless call). Gemini via Vertex AI as reasoning engine. System prompt defines research mandate, methodological constraints, and ontology. Cost cap and iteration limit per session configurable.

### 16.3 Exploration Scheduler (F-02)

Decides which area of the data space to investigate next. Prevents the agent from going in circles or pursuing irrelevant paths.

**Heuristic strategy:** Prioritization by structural signals in the Knowledge Graph:
- Entities with few connections despite high mention frequency
- Clusters with high internal contradiction density
- Temporal or spatial concentrations without explanatory connections
- Areas where established theories haven't been tested against newer data

**Stochastic strategy:** Weighted random selection with "curiosity" factor — enables serendipity discoveries beyond obvious patterns.

**Mixed (recommended):** 70% heuristic, 30% stochastic. Configurable.

### 16.4 Research Journal (F-03)

Structured database serving as the agent's long-term memory. Stores all findings, rejected hypotheses, open questions, and exploration history. Enables continuity across arbitrarily many agent sessions.

```typescript
interface JournalEntry {
  id: string;
  timestamp: string;
  type: "finding" | "rejected_hypothesis" | "open_question" | "observation";
  hypothesis: string;
  evidence: Evidence[];
  confidence: number;                 // 0.0–1.0
  confidence_label: "speculative" | "weak_signal" | "moderate_evidence" | "strong_evidence";
  related_entities: string[];
  related_entries: string[];          // Links to prior findings
  sources_internal: string[];         // Tier 1 + Tier 2
  sources_external: string[];         // Tier 2 + Tier 3
  exploration_path: string;           // How the agent got here
  status: "active" | "superseded" | "refuted";
}
```

**Session briefing:** At the start of a new session, the agent receives a compressed summary of all relevant prior findings (LLM-generated context window management).

**Contradiction tracking:** Automatic marking when new findings contradict earlier ones.

### 16.5 Source Integration Strategy (F-05)

All sources are treated equally and pass through the assertion classification (§A3). No source receives inherently elevated authority.

**Hypotheses from any source** are valuable starting points for the exploration loop, but the agent treats them methodically neutral: it searches equally for confirming and refuting evidence. The system explicitly logs when a hypothesis is refuted — that is an equally valuable result as confirmation.

**Agent benchmark:** Known, well-established connections from the corpus can serve as validation tests: does the agent independently rediscover these patterns when given only raw data? This tests the retrieval capability, not the truth of the connections.

### 16.6 External Web Research (F-06)

Enables the agent to conduct independent internet research to externally validate, expand, or refute internally generated hypotheses.

**Research workflow:**
1. Agent formulates hypothesis from internal evidence
2. Agent generates targeted search queries — multilingual
3. Execution via Gemini Grounding with Google Search (Vertex AI, native)
4. Result evaluation: relevance, source quality, alignment with hypothesis
5. Integration into finding with explicit tier labeling and assertion type (§A3)

**Evidence hierarchy:**

| Tier | Source Type | Significance |
|------|-----------|-------------|
| **Tier 1** | Known, documented sources | Internal corpus | Provenance secured, context known |
| **Tier 2** | Verifiable external sources | Peer-reviewed papers, government reports | Independently verifiable |
| **Tier 3** | Unverified web | Forums, blogs, news articles | Provenance uncertain, supporting only |

The agent may not base any theory exclusively on Tier 3 sources. Every external source is logged with URL, retrieval date, tier classification, and assertion type.

**External Query Gate (§A5):** All outgoing queries pass through the sensitivity gate. No internal PII or unpublished research may appear in search queries.

### 16.7 Report Generator (F-07)

Automatic generation of human-readable research reports from the Research Journal.

**Output formats:**
- **Daily report:** "Last night Mulder found the following..." — compact summary of new findings
- **Theme report:** All findings on a specific topic area, consolidated
- **Theory overview:** Status of all active theories with evidence state and open questions
- **Contradiction report:** Listing of identified contradictions in the data

**Requirements:** Clear, non-technical language. Complete source references with links back to original documents. Confidence labeling per statement (visual: traffic light system or stars). Export as PDF and/or HTML.

### 16.8 Configuration

```yaml
agent:
  enabled: false                      # Disabled by default
  research_loop:
    max_iterations: 50
    cost_cap_usd: 10.00
    min_evidence_threshold: 0.6
    exploration_strategy: "mixed"     # "heuristic" | "stochastic" | "mixed"
    heuristic_ratio: 0.7
    focus_domains: []                 # Optional thematic restriction

  journal:
    storage: "postgresql"
    session_briefing_enabled: true
    contradiction_tracking: true

  web_research:
    enabled: false                    # Requires §A5 external query gate
    max_queries_per_session: 20
    tier_3_standalone_policy: "never" # "never" | "with_caveat"
    multilingual: true

  reports:
    enabled: true
    formats: ["markdown", "pdf", "html"]
    language: "en"
    schedule:
      daily: false
      on_session_complete: true
```

### 16.9 Open Questions

- **Hallucination control:** What additional guardrails does an autonomously operating agent need beyond credibility scoring? Peer-review loop with a second LLM?
- **Feedback loop:** Should team members be able to confirm/reject findings in the journal? (Human-in-the-loop, connects to §A13)
- **Compute budget:** How much autonomous research time per day/week is realistic and affordable?
- **Privacy:** Which internal data may flow into web search queries? Anonymization needed?
- **Versioning:** How are theories versioned when new data changes old findings?
- **Ontology evolution:** How does the system handle it when the agent discovers categories not foreseen in any existing classification system?

---

## §A17 — Implementation Roadmap Extension

Five new milestones that integrate with the existing M1–M9 roadmap. M10 must complete before the first real archive data ingest. M11–M13 can run in parallel with M5–M9. M14 comes last.

### Critical Path

```
M4 (v1.0 MVP) ──→ M10 (Provenance & Quality) ──→ First real archive ingest
               ├→ M5 (Curation) ────────────────→ ...
               ├→ M6 (Intelligence) ────────────→ M11 (Trust) → M12 (Discovery)
               ├→ M7 (API + Workers) ───────────→ M13 (Exchange)
               ├→ M8 (Operations) ──────────────→ ...
               └→ M9 (Multi-Format) ───────────→ ...
                                                    M14 (Agent) — last
```

### M10: "Provenance & Quality" — Pre-Archive Foundations

Must complete before the first real archive data ingest. Without these foundations, bulk archive data creates provenance gaps that are extremely expensive to backfill.

| Status | Step | What | Addendum Spec |
|--------|------|------|---------------|
| ⚪ | K1 | Content-addressed storage — GCS layout migration, SHA-256 dedup | §A2 |
| ⚪ | K2 | Provenance tracking — `source_document_ids` on all artifacts | §A6.1 |
| ⚪ | K3 | Document quality assessment step | §A4 |
| ⚪ | K4 | Assertion classification in Enrich step | §A3 |
| ⚪ | K5 | Sensitivity level tagging + auto-detection | §A5 |
| ⚪ | K6 | Source rollback — soft-delete + cascading purge | §A6 |
| ⚪ | K7 | Ingest provenance data model — AcquisitionContext, ArchiveLocation, Archive, CustodyChain | §A2.3 |
| ⚪ | K8 | Collection management — create, tag, defaults | §A2.3 (Collection) |
| ⚪ | K9 | Golden tests — quality routing + assertion classification | §A3, §A4 |

**Also read for all M10 steps:** §A1 (architecture principle), §A2 (storage design)

**Testable:** Ingest documents with provenance metadata. Quality assessment routes documents to correct extraction path. Assertions are classified. Sensitivity detection flags PII. Soft-delete hides sources, purge removes downstream artifacts.

---

### M11: "Trust Layer" — Credibility, Contradictions, Review

Builds the trust infrastructure. Depends on M10 foundations (provenance, assertions, sensitivity).

| Status | Step | What | Addendum Spec |
|--------|------|------|---------------|
| ⚪ | L1 | Credibility profile data model + LLM auto-generation | §A8 |
| ⚪ | L2 | Contradiction management — ConflictNode entities, severity, resolution | §A9 |
| ⚪ | L3 | Review workflow infrastructure — ReviewableArtifact, queues, events | §A13 |
| ⚪ | L4 | Translation service — two paths, caching | §A7 |
| ⚪ | L5 | RBAC implementation — roles, permissions, sensitivity-based filtering | §A5.3 |

**Also read for all M11 steps:** §A3 (assertion types — used by contradiction severity), §A5 (sensitivity — used by RBAC)

**Testable:** Credibility profiles auto-generated on ingest. Contradictions detected and modeled as graph entities. Review queues populated. Documents translatable. Role-based access filtering works.

---

### M12: "Discovery" — Patterns & Similarity

Analysis features that generate research value from the combined data. Depends on M11 (credibility, contradictions).

| Status | Step | What | Addendum Spec |
|--------|------|------|---------------|
| ⚪ | N1 | Similar case discovery — multi-dimensional scoring, auto-discovery | §A10 |
| ⚪ | N2 | Classification harmonization — cross-taxonomy mappings | §A11 |
| ⚪ | N3 | Temporal pattern detection — anomaly detection, hotspot clustering | §A12 |
| ⚪ | N4 | External data source plugin interface + correlation analysis | §A12.1 (Level 3) |

**Also read for all M12 steps:** §A11 (taxonomy mappings used by §A10 domain dimensions), §D1 Rule 4 (external data sources are plugins), §D1 Rule 6 (similarity dimensions configurable)

**Testable:** Similar entities found across dimensions with explanations. Cross-taxonomy mappings enable system-spanning queries. Temporal anomalies detected with statistical significance. External correlations computed with mandatory caveats.

---

### M13: "Observability & Exchange" — Versioning, Export, Import

Graph audit trail and data interchange. Depends on M11 (review status in exports), M10 (provenance in exports).

| Status | Step | What | Addendum Spec |
|--------|------|------|---------------|
| ⚪ | P1 | Graph change event log | §A14.1 |
| ⚪ | P2 | Graph snapshots + diff queries | §A14.2, §A14.3 |
| ⚪ | P3 | Export framework — formats, sensitivity filtering, audit | §A15.1 |
| ⚪ | P4 | Import adapter framework — field mapping, dry run, post-import report | §A15.2 |
| ⚪ | P5 | Stable ID architecture — external ID mapping | §A15.3 |

**Also read for all M13 steps:** §A5 (sensitivity filtering in export), §A4 (quality assessment for imports)

**Testable:** Graph changes logged as events. Weekly snapshots capture graph state. Exports in multiple formats with sensitivity filtering. Import adapters transform external data through full pipeline. External IDs mapped to stable internal UUIDs.

---

### M14: "Research Agent" — Autonomous Analysis

The agent system. Depends on all prior milestones — it consumes everything: retrieval (M4), entities (M3), credibility (M11), contradictions (M11), similarity (M12), temporal patterns (M12).

| Status | Step | What | Addendum Spec |
|--------|------|------|---------------|
| ⚪ | Q1 | Research journal — data model, session briefing, contradiction tracking | §A16.4 |
| ⚪ | Q2 | Agentic research loop — tool interface, LLM orchestration | §A16.2 |
| ⚪ | Q3 | Exploration scheduler — heuristic + stochastic strategies | §A16.3 |
| ⚪ | Q4 | Source integration strategy — equal treatment, hypothesis testing | §A16.5 |
| ⚪ | Q5 | External web research — Gemini grounding, evidence tiers, query gate | §A16.6 |
| ⚪ | Q6 | Report generator — 4 report types, multi-format output | §A16.7 |
| ⚪ | Q7 | Agent safety controls — cost cap, iteration limit, hallucination guards | §A16.8 |
| ⚪ | Q8 | Agent golden tests + evaluation framework | §A16.9 |

**Also read for all M14 steps:** §A5 (external query gate), §A8 (credibility dimensions visible to agent), §A3 (assertion types in agent reasoning)

**Testable:** Agent explores knowledge graph autonomously. Findings persisted in journal with evidence links. Sessions resume with prior context. Web research respects sensitivity gate. Reports generated in multiple formats. Cost cap enforced.

---

## Appendix A — Feature Dependency Graph

```
                    ┌─── §A3 (Assertions) ───────────────────────┐
                    │                                             │
§A2 (Provenance) ──┤─── §A4 (Quality) ──────────────────────────┤
                    │                                             │
                    ├─── §A5 (Sensitivity) ──────────────────────┤
                    │                                             │
                    └─── §A6 (Rollback) ─────────────────────────┤
                                                                  │
                    ┌─── §A7 (Translation) ──────────────────────┤
                    │                                             │
                    ├─── §A8 (Credibility) ──┐                   │
                    │                         │                   │
                    ├─── §A9 (Contradictions) ┤                   │
                    │                         │                   │
                    ├─── §A11 (Harmonization) ├── §A10 (Similar) │
                    │                         │                   │
                    ├─── §A12 (Temporal) ─────┘                   │
                    │                                             │
                    ├─── §A13 (Review) ──────────────────────────┤
                    │                                             │
                    ├─── §A14 (Versioning) ──────────────────────┤
                    │                                             │
                    └─── §A15 (Export) ──────────────────────────┤
                                                                  │
                    §A16 (Agent) ←────────────────────────────────┘
```

All arrows point downward (dependencies flow top to bottom). §A16 (Agent) depends on everything above it.

---

## Appendix B — Cross-Reference Matrix

| §A Section | Features | Extends Functional Spec | New Tables | New Config Sections | Milestone |
|------------|----------|------------------------|------------|--------------------|----|
| §A1 | — | All | — | — | — |
| §A2 | — | §2.1, §4.3, §4.4 | document_blobs, acquisition_contexts, original_sources, custody_steps, archive_locations, archives, collections, blob_version_links | `ingest_provenance` | M10 (K1, K7, K8) |
| §A3 | F-04 | §2.4 | knowledge_assertions | `enrichment.assertion_classification` | M10 (K4) |
| §A4 | F-19 | §2.1, §2.2 | document_quality_assessments | `document_quality` | M10 (K3) |
| §A5 | F-20 | §4.3 | users, roles (+ columns on all tables) | `access_control` | M10 (K5), M11 (L5) |
| §A6 | F-10 | §2.1, §3.4, §4.3 | source_deletions, audit_log (+ columns on all tables) | `source_rollback` | M10 (K2, K6) |
| §A7 | F-08 | §2.1 | translated_documents | `translation` | M11 (L4) |
| §A8 | F-09 | §2.8 (replaces) | source_credibility_profiles, credibility_dimensions | `credibility` | M11 (L1) |
| §A9 | F-17 | §2.7, §2.8 | conflict_nodes, conflict_assertions, conflict_resolutions | `contradiction_management` | M11 (L2) |
| §A10 | F-11 | §5 | similarity_cache | `similar_case_discovery` | M12 (N1) |
| §A11 | F-12 | §6 | classification_taxonomies, classification_categories, taxonomy_mappings | `taxonomy.harmonization` | M12 (N2) |
| §A12 | F-13 | §2.8 | temporal_anomaly_clusters, spatiotemporal_clusters, external_correlations | `temporal_pattern_detection` | M12 (N3, N4) |
| §A13 | F-16 | All | review_events, review_queues | `review_workflow` | M11 (L3) |
| §A14 | F-18 | §4.3 | graph_change_events, graph_snapshots | `graph_versioning` | M13 (P1, P2) |
| §A15 | F-21 | §1 | export_audit, import_adapters, entity_external_ids | `export`, `import` | M13 (P3, P4, P5) |
| §A16 | F-01–F-07 | — | journal_entries, research_sessions, web_evidence | `agent` | M14 (Q1–Q8) |

---

## Appendix C — Schema Migration Index

All new migrations extend the existing sequence (current highest: 020).

| Migration | What | §A Ref |
|-----------|------|--------|
| 021 | Add `sensitivity_level`, `sensitivity_metadata` columns to sources, stories, entities, chunks, entity_edges | §A5 |
| 022 | Add `provenance` JSONB column to entities, entity_edges, chunks, story_entities | §A6.1 |
| 023 | Add `deleted_at`, `deletion_status` columns to sources | §A6.2 |
| 024 | Create `document_blobs` table | §A2.3 |
| 025 | Create `acquisition_contexts` table | §A2.3 |
| 026 | Create `original_sources`, `custody_steps` tables | §A2.3 |
| 027 | Create `archive_locations`, `archives` tables | §A2.3 |
| 028 | Create `collections` table | §A2.3 |
| 029 | Create `blob_version_links` table | §A2.3 |
| 030 | Create `document_quality_assessments` table | §A4 |
| 031 | Create `knowledge_assertions` table | §A3 |
| 032 | Create `users`, `roles` tables | §A5.3 |
| 033 | Create `source_deletions`, `audit_log` tables | §A6.2 |
| 034 | Create `translated_documents` table | §A7 |
| 035 | Create `source_credibility_profiles`, `credibility_dimensions` tables | §A8 |
| 036 | Create `conflict_nodes`, `conflict_assertions`, `conflict_resolutions` tables | §A9 |
| 037 | Create `review_events`, `review_queues` tables | §A13 |
| 038 | Create `classification_taxonomies`, `classification_categories`, `taxonomy_mappings` tables | §A11 |
| 039 | Create `similarity_cache` table + SIMILAR_TO edge type | §A10 |
| 040 | Create `temporal_anomaly_clusters`, `spatiotemporal_clusters`, `external_correlations` tables | §A12 |
| 041 | Create `graph_change_events`, `graph_snapshots` tables | §A14 |
| 042 | Create `export_audit`, `import_adapters`, `entity_external_ids` tables | §A15 |
| 043 | Create `journal_entries`, `research_sessions` tables | §A16 |
| 044 | Create `web_evidence` table | §A16.6 |
| 045 | Add `review_status` column to entities, entity_edges, knowledge_assertions, taxonomy_mappings, credibility_dimensions | §A13 |
| 046 | Indexes for all new tables (sensitivity, provenance, review_status, quality, temporal) | All |
| 047 | PL/pgSQL functions for cascading purge (§A6), quality routing, review auto-approve | §A6, §A4, §A13 |

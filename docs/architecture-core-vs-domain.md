# Mulder — Architecture Principle: Core vs. Domain Configuration

This document defines architectural constraints that apply to **all** Mulder
code. It establishes the boundary between the domain-agnostic core and the
domain-specific configuration layer. Every data structure, pipeline step, and
feature must respect this boundary.

Referenced by both the functional spec (`docs/functional-spec.md`) and the
functional spec addendum (`docs/functional-spec-addendum.md`). All sections use
the **§D** prefix to avoid collisions with other spec documents.

---

## §D1 — Guiding Principle

> **The core models generic concepts. Domain configuration gives them names,
> semantics, and constraints.**

Mulder is a Document Intelligence Platform. It is not tied to a particular
research subject, customer, corpus, live instance, or deployment environment.
Every data structure, pipeline step, and feature must be designed so that
swapping configuration makes it work in a different domain without code changes.

Example domains include historical archive research, investigative journalism,
medical case studies, legal discovery, and technical incident analysis. Those
examples are illustrations only; the public repository must remain neutral.

---

## §D2 — Six Rules

### §D2.1 — No Domain Terms in Code

No data type, function, or field name in the core codebase may contain a
domain-specific term. Domain terms exist exclusively in config files, ontology
definitions, and UI labels outside the public core.

**Test:** A developer reading the public codebase must not be able to infer any
specific live research project, private corpus, customer, cloud project, or
deployment target.

### §D2.2 — Domain Semantics Live in the Ontology Config

The config-driven ontology is the sole location where domain-specific concepts
are defined. It contains:

- **Entity types** such as `case`, `person`, `institution`, `location`,
  `document`, or any instance-specific terms.
- **Relation types** such as `mentions`, `contradicts`, `supports`,
  `published_by`, or configured domain relations.
- **Taxonomies** loaded from configured YAML files.
- **Analysis attributes** such as topic area, document type, chain of custody,
  physical evidence categories, or any other instance-specific dimensions.
- **Display labels** such as whether `TemporalAnomalyCluster` appears as
  "Publication Wave", "Incident Cluster", or another configured label.

### §D2.3 — Features Are Generic, Examples Are Neutral

Feature specs define generic mechanisms. Public examples must use neutral
placeholder domains such as `[DOMAIN:ARCHIVE]` or `[DOMAIN:JOURNALISM]`. Live
instance names, private taxonomies, production domains, cloud resource IDs, and
customer-specific vocabulary do not belong in tracked public files.

### §D2.4 — External Data Sources Are Plugins

External time series, event calendars, public registries, and reference datasets
are not hard-coded. Every external data source is a configurable plugin with a
standardized interface:

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

An archive instance might configure publication calendars and library catalogs.
A journalism instance might configure news indexes and parliamentary records.
The core knows neither.

### §D2.5 — Credibility Dimensions Are Configurable

The five dimensions from F-09 (`institutional_authority`,
`domain_track_record`, `conflict_of_interest`, `transparency`, `consistency`)
are a sensible default, but not hard-coded. The ontology config defines which
dimensions exist, what they are called, and what they mean. A legal discovery
instance might need `chain_of_custody` instead of `domain_track_record`.

### §D2.6 — Similarity Dimensions Are Configurable

The dimensions of Similar Case Discovery (F-11) are not fixed. The core provides
four built-in dimensions (`semantic`, `structural`, `geospatial`, `temporal`)
and an extensible `domain_attributes` array for domain-specific comparison axes.
The concrete attributes come from the ontology.

---

## §D3 — Domain-to-Generic Mapping Table

This section maps common domain-specific concepts to their generic core
equivalents. Features not listed (F-08, F-10) are already domain-agnostic and
require no changes.

### F-08: Document Translation Service

| Domain-Specific | Generic (Core) | Note |
|---|---|---|
| -- | -- | F-08 is already domain-agnostic. No changes required. |

### F-09: Multi-Dimensional Source Credibility Profiles

| Domain-Specific | Generic (Core) | Domain Config |
|---|---|---|
| Fixed credibility dimensions | `CredibilityDimension[]` | Ontology defines dimensions, labels, descriptions |
| Domain motive examples | `known_motives: string[]` | Ontology defines motive vocabulary |
| Instance-specific authority labels | Display labels | Config defines labels shown to users |

### F-10: Source Rollback & Cascading Purge

| Domain-Specific | Generic (Core) | Note |
|---|---|---|
| -- | -- | F-10 is already domain-agnostic. No changes required. |

### F-11: Similar Case Discovery

| Domain-Specific | Generic (Core) | Domain Config |
|---|---|---|
| Domain classification axis | `domain_classification_similarity` | Compares entries using configured taxonomy mappings |
| Domain attribute axis | `domain_attribute_similarity` | Compares structured fields from the ontology |
| `SimilarCaseResult` | `SimilarEntityResult` | Core operates on configurable entity types |
| `dominant_classification` in auto-discovery | `dominant_category` | References the instance's primary taxonomy |
| Fixed dimensions | 4 core + N domain dimensions | `semantic`, `structural`, `geospatial`, `temporal` are core |

**Generic Dimensions Model:**

```typescript
// Core: always available
interface CoreSimilarityDimensions {
  semantic: number;      // Vector cosine similarity
  structural: number;    // Graph distance
  geospatial: number;    // PostGIS proximity
  temporal: number;      // Temporal proximity
}

// Domain: from ontology config
interface DomainSimilarityDimension {
  id: string;            // e.g. "classification_similarity"
  label: string;         // e.g. "Topic area" or "Document type"
  score: number;
  source: "taxonomy_mapping" | "attribute_comparison" | "custom_scorer";
  config_ref: string;    // Reference to the ontology definition
}

interface SimilarityResult {
  core: CoreSimilarityDimensions;
  domain: DomainSimilarityDimension[];
}
```

### F-12: Classification System Harmonization

| Domain-Specific | Generic (Core) | Domain Config |
|---|---|---|
| Concrete taxonomy names | `ClassificationTaxonomy[]` | Config supplies concrete taxonomies as YAML |
| `detect_implicit_classifications` | Same mechanism | LLM prompt comes from domain config |
| -- | -- | Core mechanics are already generic |

### F-13: Temporal Pattern Detection & Cluster Analysis

| Domain-Specific | Generic (Core) | Domain Config |
|---|---|---|
| Domain event label | `TemporalAnomalyCluster` | Config defines display label |
| Domain hotspot label | `SpatiotemporalCluster` | Same mechanism, different display name |
| `dominant_classification` | `dominant_category` | References primary taxonomy |
| `known_pattern_match` | `known_pattern_match` | Reference to configured pattern register |
| Domain source lists | `ExternalDataSource[]` | Instance config chooses plugins |
| Reporting bias label | `reporting_bias_correction` | Config defines the correction field and copy |
| `persistence: "transient" \| "recurring" \| "permanent"` | Same | Already generic |

**Generic Data Model for F-13:**

```typescript
interface TemporalAnomalyCluster {
  id: string;
  region: GeoJSON;
  time_start: string;                   // ISO 8601
  time_end: string;
  entity_count: number;
  baseline_rate: number;
  observed_rate: number;
  significance: number;
  peak_date: string;
  dominant_category: string | null;
  contributing_entity_ids: string[];
  known_pattern_match: string | null;
}

interface SpatiotemporalCluster {
  id: string;
  centroid: { lat: number; lng: number };
  radius_km: number;
  time_window: { start: string; end: string };
  entity_count: number;
  density: number;
  persistence: "transient" | "recurring" | "permanent";
  recurrence_pattern: string | null;
  related_cluster_ids: string[];
}
```

---

## §D4 — Domain Configuration Structure

A Mulder instance is defined by a domain config. Below are neutral example
domains demonstrating how the same core maps to different fields.

### [DOMAIN:ARCHIVE] — Historical Archive Research

```yaml
# domain.yaml — archive instance
domain:
  id: "archive_research"
  name: "Archive Research"
  default_language: "en"

  entity_types:
    primary: "record"
    secondary: ["person", "location", "institution", "event", "document"]

  taxonomies:
    - id: "topic_taxonomy"
      source: "taxonomies/topics.yaml"
    - id: "document_types"
      source: "taxonomies/document-types.yaml"

  similarity:
    domain_dimensions:
      - id: "topic_similarity"
        label: "Topic overlap"
        source: "taxonomy_mapping"
        taxonomy_ids: ["topic_taxonomy"]
        weight: 0.2
      - id: "evidence_similarity"
        label: "Evidence overlap"
        source: "attribute_comparison"
        attributes: ["document_type", "collection", "provenance_level"]
        weight: 0.1

  temporal_analysis:
    cluster_label: "Record Cluster"
    known_patterns:
      - id: "example_publication_period"
        label: "Example publication period"
        time_window: { start: "1970-01-01", end: "1970-12-31" }
    external_sources:
      - id: "publication_calendar"
        plugin: "publication_calendar"
      - id: "library_catalog"
        plugin: "library_catalog"
    reporting_bias:
      correction_field: "collection_density"
      label: "Collection density in the archive"

  credibility:
    dimensions:
      - id: "institutional_authority"
        label: "Institutional authority"
      - id: "source_track_record"
        label: "Source track record"
      - id: "conflict_of_interest"
        label: "Conflict of interest"
      - id: "transparency"
        label: "Transparency / verifiability"
      - id: "consistency"
        label: "Internal consistency over time"

  display:
    temporal_anomaly_cluster: "Record Cluster"
    spatiotemporal_cluster: "Geographic Cluster"
    similar_entity_result: "Related Record"
    primary_entity: "Record"
```

### [DOMAIN:JOURNALISM] — Investigative Research

```yaml
# domain.yaml — investigative journalism instance
domain:
  id: "investigative_journalism"
  name: "Investigative Research Platform"
  default_language: "en"

  entity_types:
    primary: "story"
    secondary: ["source_person", "institution", "document", "event", "location"]

  taxonomies:
    - id: "topic_taxonomy"
      source: "taxonomies/topics.yaml"
    - id: "document_types"
      source: "taxonomies/doctypes.yaml"

  similarity:
    domain_dimensions:
      - id: "topic_similarity"
        label: "Topic overlap"
        source: "taxonomy_mapping"
        taxonomy_ids: ["topic_taxonomy"]
        weight: 0.2
      - id: "actor_overlap"
        label: "Shared actors/institutions"
        source: "attribute_comparison"
        attributes: ["involved_persons", "involved_institutions"]
        weight: 0.15

  temporal_analysis:
    cluster_label: "Publication Wave"
    known_patterns:
      - id: "example_publication_wave"
        label: "Example publication wave"
        time_window: { start: "2016-04-01", end: "2016-06-30" }
    external_sources:
      - id: "parliamentary_sessions"
        plugin: "parliament_calendar"
      - id: "earnings_calendar"
        plugin: "financial_earnings"
    reporting_bias:
      correction_field: "editorial_focus"
      label: "Editorial desk priority"

  credibility:
    dimensions:
      - id: "institutional_authority"
        label: "Institutional authority"
      - id: "track_record"
        label: "Source track record"
      - id: "conflict_of_interest"
        label: "Conflict of interest"
      - id: "verifiability"
        label: "Verifiability of claims"
      - id: "chain_of_custody"
        label: "Document chain of custody"

  display:
    temporal_anomaly_cluster: "Publication Wave"
    spatiotemporal_cluster: "Geographic Cluster"
    similar_entity_result: "Related Story"
    primary_entity: "Story"
```

---

## §D5 — New Feature Checklist

Before implementing any new feature, verify all of the following:

1. **Does the data model contain domain-specific field names?** Generalize them.
   Move domain labels into config.
2. **Does the code reference concrete taxonomies or entity types?** Replace with
   config references.
3. **Are external data sources hard-coded?** Model them as plugins with a
   standardized interface.
4. **Are analysis dimensions or metrics fixed?** Separate core dimensions
   (semantic, structural, geospatial, temporal) from domain dimensions.
5. **Does the feature work with a completely different `domain.yaml`?** If not,
   refactoring is required.
6. **Are public examples neutral?** Keep live instance details, real cloud
   resources, private accounts, and production config out of tracked files.

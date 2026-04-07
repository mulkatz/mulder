# Mulder — Architecture Principle: Core vs. Domain Configuration

This document defines architectural constraints that apply to **all** Mulder code. It establishes the boundary between the domain-agnostic core and the domain-specific configuration layer. Every data structure, pipeline step, and feature must respect this boundary.

Referenced by both the functional spec (`docs/functional-spec.md`) and the feature spec addendum (`docs/feature-spec-addendum.md`). All sections use the **§D** prefix to avoid collisions with other spec documents.

---

## §D1 — Guiding Principle

> **The core models generic concepts. Domain configuration gives them names, semantics, and constraints.**

Mulder is a Document Intelligence Platform, not a UAP tool. Every data structure, pipeline step, and feature must be designed so that swapping configuration makes it work in a different domain — without code changes.

IGAAP is the first instance. Investigative journalism, medical case studies, historical archive research, or legal discovery could be next.

---

## §D2 — Six Rules

### §D2.1 — No Domain Terms in Code

No data type, function, or field name in the core codebase may contain a domain-specific term. Domain terms exist exclusively in config files, ontology definitions, and UI labels.

**Test:** A developer with no UAP knowledge reading the codebase must not be able to tell at any point that the system was built for UFO research.

### §D2.2 — Domain Semantics Live in the Ontology Config

The config-driven ontology is the sole location where domain-specific concepts are defined. It contains:

- **Entity types** (e.g., IGAAP: `sighting`, `witness`, `phenomenon`. Journalism: `leak`, `source_person`, `institution`)
- **Relation types** (e.g., IGAAP: `observed_at`, `classified_as`. Journalism: `published_by`, `contradicts`)
- **Taxonomies** (e.g., IGAAP: Hynek, Vallee. Medicine: ICD-11, DSM-5)
- **Analysis attributes** (e.g., IGAAP: phenomenon type, physical effects. Journalism: topic area, involved institutions)
- **Display labels** (e.g., `TemporalAnomalyCluster` displays as "Sighting Wave" in IGAAP, "Publication Wave" in journalism)

### §D2.3 — Features Are Generic, Examples Are Domain-Specific

Feature specs define generic mechanisms. The IGAAP examples are illustrations of configuration, not part of the feature design. Documentation distinguishes between `[CORE]` (architecture, data model, logic) and `[DOMAIN:IGAAP]` (example configuration).

### §D2.4 — External Data Sources Are Plugins

External time series (Kp-Index, meteor showers, media coverage) are not hard-coded. Every external data source is a configurable plugin with a standardized interface:

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

The IGAAP instance configures the NOAA Kp-Index and a meteor shower calendar. A journalism instance configures news aggregates and parliamentary records. The core knows neither.

### §D2.5 — Credibility Dimensions Are Configurable

The five dimensions from F-09 (`institutional_authority`, `domain_track_record`, `conflict_of_interest`, `transparency`, `consistency`) are a sensible default, but not hard-coded. The ontology config defines which dimensions exist, what they are called, and what they mean. A legal discovery instance might need `chain_of_custody` instead of `domain_track_record`.

### §D2.6 — Similarity Dimensions Are Configurable

The dimensions of Similar Case Discovery (F-11) are not fixed. The core provides four built-in dimensions (`semantic`, `structural`, `geospatial`, `temporal`) and an extensible `domain_attributes` array for domain-specific comparison axes. The concrete attributes come from the ontology.

---

## §D3 — Domain-to-Generic Mapping Table

This section maps each feature's domain-specific terms to their generic core equivalents. Features not listed (F-08, F-10) are already domain-agnostic and require no changes.

### F-08: Document Translation Service

| Domain-Specific | Generic (Core) | Note |
|---|---|---|
| -- | -- | F-08 is already domain-agnostic. No changes required. |

### F-09: Multi-Dimensional Source Credibility Profiles

| Domain-Specific | Generic (Core) | Domain Config |
|---|---|---|
| 5 fixed dimensions | `CredibilityDimension[]` (dynamic) | Ontology defines dimensions, labels, descriptions |
| Pentagon example | -- | IGAAP config example, not in core |
| `"national_security"` as known_motive | `known_motives: string[]` (freely configurable) | Ontology defines motive vocabulary |

### F-10: Source Rollback & Cascading Purge

| Domain-Specific | Generic (Core) | Note |
|---|---|---|
| -- | -- | F-10 is already domain-agnostic. No changes required. |

### F-11: Similar Case Discovery

| Domain-Specific | Generic (Core) | Domain Config |
|---|---|---|
| `phenomenological` (dimension) | `domain_classification_similarity` | Compares entries using configured taxonomy mappings (F-12). IGAAP: phenomenon type. Journalism: topic area. |
| `physical_effects` (dimension) | `domain_attribute_similarity` | Compares structured fields from the ontology. IGAAP: EM interference, ground traces. Journalism: document type, involved institutions. |
| `SimilarCaseResult` | `SimilarEntityResult` | "Case" is IGAAP language. Core operates on configurable entity types. |
| `dominant_classification` in auto-discovery | `dominant_category` | References the instance's primary taxonomy |
| Fixed 6 dimensions | 4 core + N domain dimensions | `semantic`, `structural`, `geospatial`, `temporal` are core. Everything else comes from the ontology config. |

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
  label: string;         // e.g. "Phenomenon type match" [DOMAIN:IGAAP] or "Topic area" [DOMAIN:JOURNALISM]
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
| Hynek, Vallee, Ludwiger, GEIPAN (taxonomies) | `ClassificationTaxonomy[]` (dynamically loaded) | IGAAP config supplies the concrete taxonomies as YAML. |
| `detect_implicit_classifications` (example: "close encounter") | Same mechanism | LLM prompt comes from domain config: "Detect references to the following taxonomies: {taxonomies}" |
| -- | -- | Core mechanics (taxonomy model, mapping types, confidence) are already generic. |

### F-13: Temporal Pattern Detection & Flap Analysis

| Domain-Specific | Generic (Core) | Domain Config |
|---|---|---|
| `FlapEvent` | `TemporalAnomalyCluster` | Config defines display label: IGAAP -> "Sighting Wave", Journalism -> "Publication Wave" |
| `HotspotCluster` | `SpatiotemporalCluster` | Same mechanism, different name |
| `dominant_classification` | `dominant_category` | References primary taxonomy |
| `known_flap_match` | `known_pattern_match` | Reference to configured "Known Patterns" register |
| `contributing_cases` | `contributing_entities` | Entity type from config |
| Kp-Index, meteor showers (ext. time series) | `ExternalDataSource[]` (plugin) | IGAAP configures NOAA APIs. Other instances configure other sources. |
| Media bias warning | `reporting_bias_correction` | Generic: "Increased frequency correlates with observation intensity". IGAAP config: "Investigator Density". Journalism config: "Editorial Focus". |
| `persistence: "transient" \| "recurring" \| "permanent"` | Same | Already generic. |

**Generic Data Model for F-13:**

```typescript
interface TemporalAnomalyCluster {
  id: string;
  region: GeoJSON;
  time_start: string;                   // ISO 8601
  time_end: string;
  entity_count: number;                 // Previously: case_count
  baseline_rate: number;
  observed_rate: number;
  significance: number;
  peak_date: string;
  dominant_category: string | null;     // Previously: dominant_classification
  contributing_entity_ids: string[];    // Previously: contributing_cases
  known_pattern_match: string | null;   // Previously: known_flap_match
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

A Mulder instance is defined by a domain config. Below is the structure with two example domains demonstrating how the same core maps to different fields.

### [DOMAIN:IGAAP] — UAP Research

```yaml
# domain.yaml — IGAAP instance
domain:
  id: "igaap"
  name: "IGAAP UAP Research"
  default_language: "de"

  entity_types:
    primary: "case"
    secondary: ["witness", "location", "phenomenon", "researcher", "document"]

  taxonomies:
    - id: "hynek"
      source: "taxonomies/hynek.yaml"
    - id: "vallee"
      source: "taxonomies/vallee.yaml"
    - id: "ludwiger"
      source: "taxonomies/ludwiger.yaml"

  similarity:
    domain_dimensions:
      - id: "classification_similarity"
        label: "Phenomenon type match"
        source: "taxonomy_mapping"
        taxonomy_ids: ["hynek", "vallee", "ludwiger"]
        weight: 0.2
      - id: "physical_effects_similarity"
        label: "Physical effects"
        source: "attribute_comparison"
        attributes: ["em_interference", "ground_traces", "radiation", "physiological_effects"]
        weight: 0.1

  temporal_analysis:
    cluster_label: "Sighting Wave"
    known_patterns:
      - id: "belgian_wave_1989"
        label: "Belgian Wave"
        time_window: { start: "1989-11-01", end: "1990-04-30" }
        region: { type: "country", code: "BE" }
    external_sources:
      - id: "kp_index"
        plugin: "noaa_kp"
      - id: "meteor_showers"
        plugin: "iau_meteor_calendar"
    reporting_bias:
      correction_field: "investigator_density"
      label: "Investigator density in the region"

  credibility:
    dimensions:
      - id: "institutional_authority"
        label: "Institutional authority"
      - id: "domain_track_record"
        label: "Reliability in UAP context"
      - id: "conflict_of_interest"
        label: "Conflict of interest"
      - id: "transparency"
        label: "Transparency / verifiability"
      - id: "consistency"
        label: "Internal consistency over time"

  display:
    temporal_anomaly_cluster: "Sighting Wave"
    spatiotemporal_cluster: "Geographic Hotspot"
    similar_entity_result: "Similar Case"
    primary_entity: "Case"
```

### [DOMAIN:JOURNALISM] — Investigative Research

```yaml
# domain.yaml — Investigative Journalism instance
domain:
  id: "investigative_journalism"
  name: "Investigative Research Platform"
  default_language: "en"

  entity_types:
    primary: "story"
    secondary: ["source_person", "institution", "document", "event", "location"]

  taxonomies:
    - id: "topic_taxonomy"
      source: "taxonomies/topics.yaml"       # e.g. Finance, Defense, Environment
    - id: "document_types"
      source: "taxonomies/doctypes.yaml"     # e.g. Leak, Court Filing, Press Release

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
      - id: "panama_papers_2016"
        label: "Panama Papers"
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

1. **Does the data model contain domain-specific field names?** Generalize them. Move domain labels into config.
2. **Does the code reference concrete taxonomies or entity types?** Replace with config references.
3. **Are external data sources hard-coded?** Model them as plugins with a standardized interface.
4. **Are analysis dimensions or metrics fixed?** Separate core dimensions (semantic, structural, geospatial, temporal) from domain dimensions.
5. **Does the feature work with a completely different `domain.yaml`?** If not, refactoring is required.
6. **Are examples in the spec clearly marked as `[DOMAIN:IGAAP]`?** Ensure separation between core design and domain illustration.

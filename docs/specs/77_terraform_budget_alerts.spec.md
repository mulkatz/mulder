---
spec: "77"
title: "Terraform Budget Alerts"
roadmap_step: M8-I3
functional_spec: ["§16.1"]
scope: single
issue: "https://github.com/mulkatz/mulder/issues/200"
created: 2026-04-15
---

# Spec 77: Terraform Budget Alerts

## 1. Objective

Establish Mulder's first real Terraform delivery surface by adding a reusable budget-alert module that creates a Cloud Billing budget for the deployment billing account with alert thresholds at 50% and 90% of a caller-provided monthly budget. Per `§16.1`, the budget amount must be specified in USD and the resource must identify the deployment by project name so operators can track spend before costly pipeline usage grows unchecked.

This step is intentionally narrow. It covers only the Terraform resources and minimal scaffolding needed to define and validate the budget-alert module in-repo. It does not attempt cost estimation (`M8-I2`), automatic shutdown or Pub/Sub remediation, or the larger multi-tenant/project-factory work tracked separately.

## 2. Boundaries

- **Roadmap Step:** `M8-I3` — Terraform budget alerts
- **Target:** `terraform/modules/budget/main.tf`, `terraform/modules/budget/variables.tf`, `terraform/modules/budget/outputs.tf`, `terraform/examples/budget/main.tf`, `terraform/examples/budget/versions.tf`, `tests/specs/77_terraform_budget_alerts.test.ts`
- **In scope:** creating the new `terraform/modules/budget/` module; defining inputs for billing account, project name, and monthly budget amount; creating exactly one `google_billing_budget` resource with a specified USD amount; configuring threshold rules for 50% and 90% alerts; exposing outputs needed to reference the created budget from higher-level Terraform compositions; adding a minimal example root configuration under `terraform/examples/budget/`; and black-box verification that the example configuration formats and validates cleanly
- **Out of scope:** Terraform for any other GCP services, notification channels, Pub/Sub automation, project/folder creation, cost-estimation CLI work, hard runtime spending caps, cross-project budget filters, or broader infra environment layout beyond what is required to exercise this one module
- **Constraints:** keep the module self-contained and reusable; do not couple it to `mulder.config.yaml` yet; preserve the exact `§16.1` budget semantics (USD specified amount, 50% threshold, 90% threshold); and make the example/test path work without requiring the rest of Mulder's planned Terraform tree to exist first

## 3. Dependencies

- **Requires:** None
- **Blocks:** no immediate roadmap step directly, but this module becomes the first concrete Terraform building block that later M8 infrastructure work can compose instead of continuing to treat `terraform/` as a planned-only directory

## 4. Blueprint

### 4.1 Files

1. **`terraform/modules/budget/main.tf`** — declares the `google_billing_budget` resource and hard-codes the two required threshold rules around caller-supplied billing inputs
2. **`terraform/modules/budget/variables.tf`** — defines validated module inputs for `billing_account`, `project_name`, and `monthly_budget_usd`
3. **`terraform/modules/budget/outputs.tf`** — exposes stable outputs for the created budget resource so future root modules can reference it
4. **`terraform/examples/budget/versions.tf`** — pins Terraform/provider requirements needed to validate the standalone example root
5. **`terraform/examples/budget/main.tf`** — instantiates the budget module with placeholder-safe inputs so `terraform init` and `terraform validate` can exercise the module shape without depending on broader Mulder infra
6. **`tests/specs/77_terraform_budget_alerts.test.ts`** — black-box coverage for file presence, required resource shape, and Terraform formatting/validation

### 4.2 Terraform Contract

The module must create one budget resource with these observable properties:

- `display_name` is `mulder-${var.project_name}`
- the budget amount uses `specified_amount`
- `currency_code` is `USD`
- `units` comes from `var.monthly_budget_usd`
- two threshold rules exist at `0.5` and `0.9`

The module may expose outputs for the created budget's display name and provider-generated budget name/id, but it must not add unrelated resources or optional alerting channels in this step.

### 4.3 Example Root

The example root exists only to make the new module runnable and verifiable in isolation.

It must:

- declare the Terraform and Google provider requirements needed for validation
- instantiate `../../modules/budget`
- use placeholder-safe variable values that let `terraform validate` succeed without attempting a live apply

It must not:

- provision any non-budget resources
- introduce environment-specific state backends
- require secrets or checked-in credentials

### 4.4 Implementation Phases

**Phase 1: module scaffold**
- create `main.tf`, `variables.tf`, and `outputs.tf`
- encode the exact `§16.1` budget contract

**Phase 2: standalone validation root**
- add the minimal example root under `terraform/examples/budget/`
- ensure the module can be formatted and validated in isolation

## 5. QA Contract

1. **QA-01: The budget module exists as a reusable Terraform module**
   - Given: a fresh checkout of the repository
   - When: the `terraform/modules/budget/` directory is inspected
   - Then: it contains the expected Terraform module files and exposes caller inputs for billing account, project name, and monthly budget amount

2. **QA-02: The module encodes the exact `§16.1` budget semantics**
   - Given: the budget module files
   - When: the Terraform resource definition is inspected through the module's public HCL files
   - Then: there is exactly one `google_billing_budget` resource with a USD specified amount, `units` sourced from the monthly budget variable, and threshold rules at 50% and 90%

3. **QA-03: The standalone example validates cleanly**
   - Given: Terraform is installed and the repository checkout has no pre-existing Terraform state
   - When: `terraform -chdir=terraform/examples/budget init -backend=false` and `terraform -chdir=terraform/examples/budget validate` are run
   - Then: both commands exit successfully and the example exercises the module without requiring unrelated Mulder infrastructure

4. **QA-04: Terraform formatting stays clean**
   - Given: the Terraform files for this step
   - When: `terraform fmt -check -recursive terraform` is run
   - Then: the command exits successfully with no formatting drift

5. **QA-05: The step stays narrowly scoped to budget alerts**
   - Given: the files added for this step
   - When: they are reviewed at the filesystem level
   - Then: no non-budget Terraform resources, notification-channel resources, or unrelated infra modules are introduced

## 5b. CLI Test Matrix

N/A — no CLI commands in this step.

## 6. Cost Considerations

- **Services called:** none during normal repository verification; Terraform validation should not apply or create live resources
- **Operational impact:** the resulting module manages a billing budget resource in GCP, which is a cost-safety control rather than a spend-generating workload
- **Safety requirement:** the example/test path must remain validation-only so contributors can verify the module shape without a live billing account or checked-in credentials

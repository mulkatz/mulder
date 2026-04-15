variable "billing_account" {
  description = "The billing account ID that owns the budget."
  type        = string
  nullable    = false

  validation {
    condition     = trimspace(var.billing_account) != ""
    error_message = "billing_account must not be empty."
  }
}

variable "project_name" {
  description = "The project name used in the budget display name."
  type        = string
  nullable    = false

  validation {
    condition     = trimspace(var.project_name) != ""
    error_message = "project_name must not be empty."
  }
}

variable "monthly_budget_usd" {
  description = "The monthly budget amount in USD."
  type        = number
  nullable    = false

  validation {
    condition     = var.monthly_budget_usd > 0
    error_message = "monthly_budget_usd must be greater than 0."
  }
}

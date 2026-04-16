resource "google_billing_budget" "mulder" {
  billing_account = var.billing_account
  display_name    = "mulder-${var.project_name}"

  amount {
    specified_amount {
      currency_code = "USD"
      units         = var.monthly_budget_usd
    }
  }

  threshold_rules {
    threshold_percent = 0.5
  }

  threshold_rules {
    threshold_percent = 0.9
  }
}

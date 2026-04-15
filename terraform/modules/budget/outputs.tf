output "budget" {
  description = "The created billing budget resource."
  value       = google_billing_budget.mulder
}

output "budget_display_name" {
  description = "The budget display name used in Cloud Billing."
  value       = google_billing_budget.mulder.display_name
}

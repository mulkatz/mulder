module "budget" {
  source = "../../modules/budget"

  billing_account    = "000000-000000-000000"
  project_name       = "mulder-example"
  monthly_budget_usd = 100
}

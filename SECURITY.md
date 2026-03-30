# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Mulder, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please email **security@mulkatz.dev** with:

- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

You will receive a response within 72 hours acknowledging receipt. We will work with you to understand and address the issue before any public disclosure.

## Scope

This policy applies to the Mulder codebase and its official deployments. Third-party dependencies are managed via Dependabot and reviewed on a regular basis.

## Supported Versions

| Version | Supported |
|---------|-----------|
| main    | Yes       |

## Security Practices

- **No secrets in code.** API keys, GCP credentials, and service account JSON must never be committed. All sensitive config uses environment variables or GCP IAM.
- **`.gitignore` blocks** `.env*`, `terraform.tfstate*`, and `.mulder-cache.db`.
- **Dependencies** are reviewed for known vulnerabilities via `pnpm audit`.

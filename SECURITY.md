# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Mulder, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email: franz.benthin.dev@gmail.com

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if you have one)

## Response Timeline

- **Acknowledgment:** Within 48 hours
- **Assessment:** Within 1 week
- **Fix:** Depends on severity, but we aim for:
    - Critical: 7 days
    - High: 14 days
    - Medium: 30 days
    - Low: 90 days

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest  | Yes       |
| Older   | No        |

## Security Best Practices for Self-Hosting

- Never expose your `.env` file or GCP credentials
- Use IAM roles with minimal permissions for the Cloud Run service account
- Enable audit logging in your GCP project
- Keep dependencies up to date

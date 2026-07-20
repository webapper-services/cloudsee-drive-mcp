# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately** to **admin@cloudsee.cloud**. Do not open
a public GitHub issue for a security report.

Include a description, reproduction steps, and impact. We aim to acknowledge within a few
business days and will coordinate a fix and disclosure timeline with you.

## Handling your credentials

- The server reads your CloudSee Drive **API key id + secret** from environment variables and
  holds them only in the local process. It **never** logs the secret, returns it in tool
  output, or writes it to disk.
- All diagnostic logging is written to **stderr**; stdout carries only the MCP protocol stream.
- Keep your secret in your MCP client's `env` block or a gitignored `.env`. **Never** commit a
  real secret or paste one into an issue, PR, or log.
- File access is granted via **short-lived pre-signed URLs**; the server never receives or
  exposes long-lived AWS credentials.

## Scope

This package is a thin client over the CloudSee Drive public API. The API enforces
authorization server-side; this client's confirmation prompts are a usability safeguard, not a
security boundary.

# Privacy Policy — CloudSee Drive MCP Server

**Effective date:** 2026-07-01

This policy explains how the **CloudSee Drive MCP server** ("the connector") handles data when
you connect it to an AI assistant such as Claude. The connector is published by **Webapper
Services, LLC** ("Webapper", "we", "us").

The connector is a **conduit** between your AI assistant and your existing CloudSee Drive
account. It does not run analytics, build user profiles, train models on your data, or sell
data to anyone.

## 1. Data the connector processes

- **Authentication.** You connect via **OAuth 2.0** with explicit consent. Your AI client
  obtains an access token scoped to your CloudSee Drive account. The **hosted connector holds
  no long-lived API key of its own** — it uses your per-request token to call the CloudSee
  Drive API on your behalf.
- **Requests & content.** When you invoke a tool (list, browse, search, download, upload,
  rename, move, delete, tag, etc.), the connector forwards that request to the CloudSee Drive
  public API and returns the result to your AI client. Depending on the tool, this may include
  file and folder names, paths, metadata, tags, and — for uploads — the file content you
  provide.
- **Links, not credentials.** Download and share tools return **short-lived pre-signed URLs**;
  the connector never returns AWS credentials.

## 2. How the connector uses data

Solely to fulfill the specific tool call you (through your AI client) request. There is **no**
advertising, profiling, resale, or secondary use.

## 3. Storage & retention

- The hosted connector is **stateless**: it processes each request in memory and **retains no
  copy** of your files, metadata, or tokens after the response is returned.
- **OAuth tokens and grants are stored and managed by the CloudSee Drive platform** (not by
  the connector), per the CloudSee privacy policy. You can revoke access at any time from your
  AI client's connector settings or the CloudSee dashboard; revocation invalidates the token.
- **Operational logs** are written to stderr for debugging and **never include your API secret
  or access token** (they are redacted). Logs are not used to reconstruct your files.

## 4. Third-party sharing

- Your **AI assistant provider** (e.g., Anthropic) is the client that sends requests to, and
  receives results from, the connector.
- Requests are sent to the **CloudSee Drive API / Amazon S3** to perform the operation you
  requested.
- We do **not** sell your data or share it with any other third party.

## 5. Security

- OAuth 2.0 with per-user consent; the hosted connector holds **no static credential**.
- The API secret / access token is **never logged, never returned in tool output, never
  written to disk**.
- All transport is over **HTTPS**.
- Report security issues per [`SECURITY.md`](SECURITY.md). Never paste a real key/secret into
  a public issue.

## 6. Your choices

- **Disconnect at any time** from your AI client's connector settings — this revokes the
  connector's access token.
- Manage or delete your files and account data directly in **CloudSee Drive**.

## 7. Changes & contact

We may update this policy; material changes will be published here with a new effective date.

- **Privacy contact:** privacy@webapper.net
- **Publisher:** Webapper Services, LLC — https://www.webapper.com
- For CloudSee Drive **account/platform** data handling, see the CloudSee Drive privacy policy
  at https://www.cloudsee.cloud.

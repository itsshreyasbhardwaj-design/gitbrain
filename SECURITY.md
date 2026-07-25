# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for a security vulnerability.

Use GitHub's private reporting instead:
[Report a vulnerability](https://github.com/itsshreyasbhardwaj-design/gitbrain/security/advisories/new)

You can expect an acknowledgement within 72 hours and an assessment within a week.

## Scope

GitBrain analyzes untrusted input by design — it downloads arbitrary public repositories and
renders content derived from them. The areas most worth your attention:

| Area                          | Why it matters                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/ingest/github.ts`   | Repository URLs flow into a server-side `fetch`. Only `github.com` is accepted; anything that bypasses that check is an SSRF vulnerability. |
| `src/core/ingest/archive.ts`  | Archive extraction. Path traversal, zip bombs and resource exhaustion all live here.                                                        |
| `src/components/markdown.tsx` | Renders Markdown derived from untrusted repository content, sanitized with an allowlist.                                                    |
| `src/components/mermaid.tsx`  | Turns generated text into DOM. Pinned to Mermaid's `strict` security level.                                                                 |
| `next.config.ts`              | Content Security Policy.                                                                                                                    |
| `src/lib/rate-limit.ts`       | Denial-of-service surface on the expensive analyze endpoint.                                                                                |

## Known limitations

These are deliberate trade-offs, documented rather than hidden:

- **Rate limiting is per-instance.** It uses in-process memory, so across many serverless
  instances it is best-effort. Requiring Redis would break the zero-configuration promise. Put a
  proper limiter at the edge for a public deployment.
- **The in-memory store is not isolated between users** when Clerk is not configured. That is
  correct for a local or single-team deployment and wrong for a public multi-tenant one — enable
  auth for that case.
- **Secret findings are redacted, never stored in full.** GitBrain keeps only a 4-character
  prefix. It does not transmit findings anywhere.

## What GitBrain sends where

With no configuration: requests go to `api.github.com` and `codeload.github.com`, and nowhere
else. Uploaded ZIPs never leave the server that received them.

With `OPENROUTER_API_KEY` set: the chat endpoint sends GitBrain's structured analysis plus the
specific retrieved code chunks to OpenRouter. It never sends the whole repository.

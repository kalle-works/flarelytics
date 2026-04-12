# Security Policy

## Reporting a vulnerability

If you find a security vulnerability in Flarelytics, please report it privately.

**Email:** security@kalle.works

Do not open a public GitHub issue for security vulnerabilities.

We will acknowledge receipt within 48 hours and aim to release a fix within 7 days for confirmed vulnerabilities.

## Scope

- The Cloudflare Worker (packages/worker)
- The tracking script (packages/tracker)
- The email reports worker (packages/email-reports)

The dashboard and landing page are static sites and do not process sensitive data.

## Design

Flarelytics is privacy-first by design:

- No cookies or persistent identifiers
- Visitor hashes rotate daily and cannot be reversed
- No raw IP addresses are stored
- Bot filtering happens before any data is written
- All query endpoints require API key authentication
- CORS origin checking on the /track endpoint

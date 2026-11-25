# Switchboard — Shared Team Inbox

Multi-tenant customer support inbox built on Node.js (Express + TypeScript), React (Vite), MongoDB, and Redis.

## Prerequisites

- Node.js `>= 22`
- Docker & Docker Compose (for MongoDB, Redis, Pigeon, and Mock IdP)

## Quick Start (from a clean clone)

1. Start the supporting services (MongoDB, Redis, Pigeon, Mock IdP, Paybox):

   ```bash
   npm run up
   ```

   *(Note: Elasticsearch is intentionally omitted via the default compose profile to fit 8 GB RAM hosts.)*

2. Install dependencies for the server and web app:

   ```bash
   npm run scaffold:install
   ```

3. Start the backend server (`http://localhost:4000`, or the `PORT` env var):

   ```bash
   npm run scaffold:server
   ```

4. Start the React web app (`http://localhost:5173`):

   ```bash
   npm run scaffold:web
   ```

5. Open `http://localhost:5173` and sign in via the Mock IdP (`u_asha`, `u_ben`, `u_chloe`, `u_dev`, or `u_eli`).

## Running Tests & Grader Checks

- Unit tests:

  ```bash
  npm --prefix scaffold/server test
  ```

- Automated grader check (stop your dev server first, because the harness starts its own server instances behind a load balancer on `:4000`):

  ```bash
  npm run check        # Level 1
  npm run check:full   # Levels 1, 2, 3, and 5 (writes CHECK_REPORT.json)
  ```

## Architecture Overview

- **Webhook Ingestion (`POST /webhooks/pigeon`)**: Verifies `x-pigeon-signature` HMAC-SHA256 against the raw request body, rejects stale timestamps (`> 300s`), deduplicates inbound messages via MongoDB unique partial indexes (`(workspace, messageId)`), and enforces forward-only status transitions (`queued -> sent -> delivered/failed`) so out-of-order webhooks never regress state.
- **Durable Outbound Worker**: Replies are persisted to MongoDB before answering `202`, then dispatched asynchronously using atomic MongoDB leases (`8s` TTL), `Idempotency-Key` headers, and a shared Redis token-bucket + `Retry-After` cool-off gate across all server instances.
- **Auth, Isolation & Real Time**: OIDC Authorization Code + PKCE (`S256`) login backed by Redis sessions, strict workspace membership checks on every `/api/*` and `/ws` endpoint, and atomic Redis Lua `INCR + ZADD + PUBLISH` sequences for strictly ordered multi-instance WebSocket delivery and `?after=<seq>` replay.

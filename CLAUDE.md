# CLAUDE.md — context for Claude Code on this repo

This file is read automatically at the start of every Claude Code session
in this repo. Full project context (client, commercials, NI exchange, open
items) lives in `docs/HANDOVER.md` — read it before doing any work here.

## What this repo is
Shopify POS ↔ Network International Push to Pay integration for Dorko
Middle East (client: Ziad Yaghi). Two deliverables:

- `shopify-app/web/` — the middleware: the server that talks to NI's Push to Pay API (sale, void,
  refund, get-result). Holds credentials, generates/tracks SourceID,
  persists transaction state for timeout recovery.
- `shopify-app/` — the Shopify app "Dorko NI Payments" (`shopify.app.toml`)
  and its POS UI Extension in `extensions/ni-terminal/` (Smart Grid tile +
  modal, API 2026-07, Preact web components) that runs the terminal payment
  before the cashier selects the custom "Card – Network International"
  tender. See docs/HANDOVER.md for why this pattern (not a payment-blocking
  hook) is the plan.

## Commands (run from `shopify-app/`)
- `npm install` — installs the app, the middleware (`web/`) and the extension
- `npm test` — all tests (middleware + extension cart logic)
- `npx shopify app dev --store dorko-ni-dev.myshopify.com` — local dev on
  Ali's machine: runs the middleware with mock NI behind a public tunnel and
  serves the POS extension to the iPad. The extension calls the middleware
  with relative URLs; POS resolves them to the app URL and adds the session
  token automatically (POS 10.6+, POS user must have app permission).
- Middleware on its own: `cd web && AUTH_DISABLED=true npm run dev`

## Status as of 7 Oct 2026
- Deposit paid (AED 3,700), scope and pricing locked
- Client signed NI's BRD (requirements form) on 4 Oct. The DOU is NOT
  signed yet: NI will share it after their internal process. No NI docs
  or test terminal until it's signed.
- Nothing here has been tested against real NI endpoints yet; current work
  should mock NI responses and be structured so swapping in real
  credentials/endpoints later is a small change, not a rewrite
- Phase 0 code written 7 Oct: middleware (mock NI, SourceID, SQLite state,
  timeout recovery, void, session-token auth) with 13 passing tests.
- 7 Oct: first end-to-end test passed on iPhone POS against dorko-ni-dev
  (mock NI): order #1001 paid via "Card – Network International", with
  `_ni_source_id`, `_ni_amount`, `_ni_approval_code`, `_ni_rrn` confirmed as
  order customAttributes via Admin API. Decline (.13) and recovery (.99)
  tests next; iPad layout check still to do.

## Where Shopify commands run
- Dev store: `dorko-ni-dev.myshopify.com` (Enigma Logics org, Grow plan,
  created in the Dev Dashboard; old Partner Dashboard dev stores like
  dev-demowork are invisible to the CLI). App client ID is in
  `shopify-app/shopify.app.toml`.
- The claude.ai cloud workspace cannot reach any Shopify host (network
  allowlist blocks accounts.shopify.com, partners/app.shopify.com,
  *.myshopify.com). Shopify CLI (`shopify app dev/deploy`, login) must run on
  Ali's own machine. Cloud sessions write code and push; the local session
  pulls and runs the CLI.

## Before writing code against real NI docs
Re-read `docs/HANDOVER.md`'s architecture section against whatever NI sends
— specifically whether Push to Pay is synchronous request/response or
callback/webhook-based, since that changes the POS modal's wait logic.

## Working style
Ali prefers iterative, step-by-step work with dry-run/verification before
anything that touches a live system, and minimal targeted changes over
rewrites. Nothing here should touch production NI credentials or a live
Shopify store without his explicit go-ahead.

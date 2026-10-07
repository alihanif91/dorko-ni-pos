# CLAUDE.md — context for Claude Code on this repo

This file is read automatically at the start of every Claude Code session
in this repo. Full project context (client, commercials, NI exchange, open
items) lives in `docs/HANDOVER.md` — read it before doing any work here.

## What this repo is
Shopify POS ↔ Network International Push to Pay integration for Dorko
Middle East (client: Ziad Yaghi). Two deliverables:

- `middleware/` — the server that talks to NI's Push to Pay API (sale, void,
  refund, get-result). Holds credentials, generates/tracks SourceID,
  persists transaction state for timeout recovery.
- `shopify-app/` — the Shopify app "Dorko NI Payments" (`shopify.app.toml`)
  and its POS UI Extension in `extensions/ni-terminal/` (Smart Grid tile +
  modal, API 2026-07, Preact web components) that runs the terminal payment
  before the cashier selects the custom "Card – Network International"
  tender. See docs/HANDOVER.md for why this pattern (not a payment-blocking
  hook) is the plan.

## Commands
- `cd middleware && npm test` — runs all tests (middleware + extension cart logic)
- `cd middleware && AUTH_DISABLED=true npm start` — local server, mock NI

## Status as of 7 Oct 2026
- Deposit paid (AED 3,700), scope and pricing locked
- NI docs and test terminal NOT yet received — blocked on client signing
  the DOU with Network International
- Nothing here has been tested against real NI endpoints yet; current work
  should mock NI responses and be structured so swapping in real
  credentials/endpoints later is a small change, not a rewrite
- Phase 0 code written 7 Oct: middleware (mock NI, SourceID, SQLite state,
  timeout recovery, void, session-token auth) with 13 passing tests; POS
  extension tile + modal written but NOT yet run on a device. Next: link the
  app with Shopify CLI and preview on Ali's dev store.

## Where Shopify commands run
- Dev store: `dev-demowork.myshopify.com`. App client ID is in
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

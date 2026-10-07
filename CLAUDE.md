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
- `pos-extension/` — Shopify POS UI Extension (Smart Grid tile + modal) that
  triggers the middleware before the cashier selects the custom "Card –
  Network International" payment tender. See docs/HANDOVER.md for why this
  pattern (not a payment-blocking hook) is the plan.

## Status as of 7 Oct 2026
- Deposit paid (AED 3,700), scope and pricing locked
- NI docs and test terminal NOT yet received — blocked on client signing
  the DOU with Network International
- Nothing here has been tested against real NI endpoints yet; current work
  should mock NI responses and be structured so swapping in real
  credentials/endpoints later is a small change, not a rewrite

## Before writing code against real NI docs
Re-read `docs/HANDOVER.md`'s architecture section against whatever NI sends
— specifically whether Push to Pay is synchronous request/response or
callback/webhook-based, since that changes the POS modal's wait logic.

## Working style
Ali prefers iterative, step-by-step work with dry-run/verification before
anything that touches a live system, and minimal targeted changes over
rewrites. Nothing here should touch production NI credentials or a live
Shopify store without his explicit go-ahead.

# Dorko Middle East — Shopify POS × Network International Push to Pay
Handover brief for Claude Code — last updated 7 Oct 2026

## Client
- D R K Fashion Trading LLC SPC, trading as Dorko Middle East (Reem Mall, Abu Dhabi)
- Contact: Ziad Yaghi — ziad@drk.me
- Store: 6zhh3e-ne.myshopify.com
- NI merchant ID: 20060370929

## What we're building
A Shopify POS integration with Network International's Push to Pay cloud API.
Cashier taps "Card – Network International" (a custom/manual Shopify payment
type) → exact cart total sent to the NI terminal → approval/decline returns →
sale recorded in Shopify with the NI transaction reference attached.

Scope: sale, void, full refund, timeout recovery via NI's Get Result call
(lookup by SourceID, max 15 alphanumeric chars, self-generated — Shopify order
names won't reliably fit the cap). NI certification included, one re-test round.

Hardware at the store: iPad Air, Shopify POS Connector Hub, Epson TM-m30III
receipt printer, Zebra DS2278-SR scanner, cash drawer cabled to the printer.
NI-supported terminals: M90 (built-in printer), OMA485, SR800 (no printer).
We've told NI OMA485/SR800 is the better fit since the Epson already prints.

## Why the architecture is what it is (read before changing it)
Checked Shopify's current POS UI Extension targets: every purchase-related
target (`pos.purchase.post.block.render` etc.) fires AFTER the sale is
already completed in Shopify. There is no hook that can block tender
selection while waiting on an external terminal's response. Confirmed via
Shopify's own developer forum — not a documentation gap.

Workaround pattern (this is the actual plan, not a fallback):
1. Cashier builds the cart normally.
2. A **Smart Grid tile** ("Charge via NI Terminal") on the cart screen is
   enabled once the cart has a subtotal (subscribes to the live cart total).
3. Tapping it opens a full-screen **modal** — this is where the blocking
   happens. Modal calls the middleware with the exact total; middleware calls
   NI Push to Pay; modal sits on "Processing…" until NI returns
   approved/declined, or the Get Result fallback is used on timeout.
4. Only on approval does the modal close and let the cashier select the
   **"Card – Network International"** custom payment tender and complete the
   sale normally in Shopify POS.
5. The post-purchase extension target then fires — used to append the NI
   transaction reference to the order note/metafield via Admin API, matched
   by the SourceID already captured in step 3.

Refund flow: Shopify can't auto-reverse a custom/manual payment type, so a
refund must actively call NI's refund endpoint via the middleware using the
stored original reference — not just rely on Shopify's own refund record.
Exact hook point (order-details / return screen target) still to be nailed
down once we're building.

**This is provisional pending NI's actual docs.**

### Decisions made 7 Oct 2026 (supersede the steps above where they differ)
- **One Shopify app: "Dorko NI Payments"** (client ID in
  `shopify-app/shopify.app.toml`), scopes `read_orders,write_orders`. It holds
  the POS extension, and the middleware gets its store token from the same
  app's install. Distribution method deliberately NOT chosen yet (permanent
  once set); set custom distribution for 6zhh3e-ne.myshopify.com in Phase 2.
- **Build on Ali's dev store first.** `shopify app dev` previews only on dev
  stores, so nothing touches Dorko's live POS until Phase 2.
- **NI reference goes on the order via cart properties**, not a
  post-purchase Admin API write. After approval the modal calls
  `shopify.cart.addCartProperties` with `_ni_source_id`, `_ni_amount`,
  `_ni_approval_code`, `_ni_rrn`; these carry through to the order. To verify
  on the dev store: how they appear on the order record.
- **POS polls the middleware; the middleware calls NI in the background.**
  This makes the POS side identical whether NI is synchronous or
  callback-based, so that open question now only affects
  `shopify-app/web/src/ni/`.
- **Stale approval guard:** if the cart total changes after approval, the
  tile/modal flag it and force a void before re-charging.
- **Extension → middleware auth:** Shopify session token (HS256 JWT signed
  with the app secret), verified on every request, shop allow-list enforced.
- Possible later safety net: `pos.transaction-complete.event.observe` to
  check the cashier tendered "Card – Network International" for the approved
  amount.

### Store setup learned on the dev store (7 Oct 2026) — repeat for Dorko at go-live
- **"Card – Network International" is a POS custom payment type**, added in
  admin: Sales channels → Point of Sale → Customize the in-store experience →
  POS app (Edit) → Checkout → Add custom payment type. NOT Settings → Payments
  → Manual payment methods (that is online checkout only and never shows in
  POS), and the POS app itself has no add option.
- POS must be logged in with a user account and the app's permission prompt
  approved on the device, or the extension gets no session token (every
  middleware call 401s). Staff on Dorko's iPad will see the same prompt.
- Dev preview on a device: in the Dev Console, use the **Mobile** link on the
  `ni-terminal` row (a `com.shopify.pos://` link), not the app row's link,
  which only opens the admin. Open it in Safari or via the Camera app; Chrome
  on iOS doesn't hand off to POS.
- Tested on iPhone POS on 7 Oct; iPad layout check still to do before go-live.

### Client decisions, 7 Oct 2026 (Ziad)
- Terminal: full-size N-Genius **with printer** (the M90 in NI's supported
  list), not OMA485/SR800. Reason given: fixed retail counter.
- **Two terminals: one main, one backup.** Decided by Ali 7 Oct: backup is
  included at **no extra cost** as a **failover switch** (one active
  terminal at a time; staff can switch to the backup in POS if the main one
  fails). Two terminals live at once (e.g. two tills) stays out of scope.
- Terminal receipts **printed on demand only**, not after every
  transaction. Needs NI to confirm whether that's a terminal setting or a
  per-request flag in Push to Pay.
- **Correction 7 Oct: the DOU is NOT signed.** What Ziad signed (4 Oct) is
  NI's **BRD** (requirements form). NI (Shahrukh, 7 Oct) says they've started
  their internal project process and will *share* the DOU after it.

### NI BRD as filled by the client (signed 4 Oct 2026)
- ECR: Shopify POS on iOS; integrator: Ali Hanif; 1 outlet, 1 till.
- 2 terminals (1 primary + 1 backup), full-size countertop **with printer**,
  receipts printed on demand only.
- **Expected go-live written as 15 October 2026** — not achievable: contract
  is ~4 weeks from signed DOU, and the DOU isn't issued yet. Needs correcting
  with Ziad and NI.
- Schemes ticked: Visa, MasterCard, Jaywan, UPI, JCB, Diners/Discover, AMEX;
  DCC yes. These are terminal-side, no build impact.
- **Also ticked: Alipay, WeChat (QR wallets — out of scope per proposal unless
  NI handles them inside a normal sale), and Tabby/Tamara (separate BNPL
  providers, not part of NI Push to Pay at all).**
- NI states it will provide the API spec plus a Swagger document.

### Mock terminal (until NI docs arrive)
`NI_MODE=mock`. Amount ending .13 → declined; ending .99 → sale call drops,
only Get Result settles it (timeout recovery path); anything else approved.

## Commercials
- $2,000 / AED 7,400, fixed, 50/50
- Deposit AED 3,700 received 4 Oct 2026 (INV-2026-1003)
- Balance AED 3,700 due on go-live
- ~4 weeks from signed DOU
- 30 days post-go-live support; after that, $25/hr
- Out of scope: more terminals/stores, split payments, partial refunds, QR
  wallets, NI's own charges, extra certification rounds (billed $25/hr),
  Shopify/hardware/server costs
- No hosting fee to Ali — Ziad buys his own small cloud server
  (~$6–8/mo) before go-live; build/test happens on Ali's own test server
  until then
- SensePass was evaluated and ruled out as an off-the-shelf alternative

## Server
Needs: always-on process (Node/Python), root/SSH access, static IP (NI may
require one registered against production credentials — unconfirmed, ask
NI), HTTPS. DigitalOcean Basic Droplet ($6/mo, 1 vCPU/1GB, free static IP) is
the default recommendation. Ali also has a Hostinger account — only usable if
it's a VPS/Cloud plan with root access, not shared hosting. Plan not yet
confirmed as of this writing.

## Network International — what they've told us
- Shahrukh Ahmed (shahrukh.ahmed@network.global) — integration contact
- Surgiana Ahmed (surgiana.ahmed@network.global) — account manager
- Push to Pay: cloud API, Sale / Void / Refund / Get Result
- Get Result recovers the last transaction status by SourceID — this is the
  timeout-recovery mechanism
- Docs + certification test cases released within 24h of signed DOU
- Test terminal delivered 4–5 working days after DOU signed
- NI validation takes 3–4 working days after we submit for certification, no
  fee
- **Still unanswered by NI**: whether the integrating *application* itself
  needs separate NI certification, or only the terminal. Asked twice.
- **Still unanswered by NI**: whether a certified Shopify POS integration
  already exists in the UAE (Surgiana checking with product team). If yes,
  the deposit only covers work done to that point — this changes scope.

## Open items (blocking)
1. DOU signature — not yet confirmed signed as of 7 Oct 2026. This is the
   critical path; nothing else from NI moves until it's signed.
2. NI's answer on integration certification requirement.
3. NI's answer on whether a certified UAE Shopify POS integration exists.
4. Whether NI needs a server IP or callback URL registered for production
   credentials.

## Terms agreed with Ziad
- Everything remote — NI ships the test terminal to Ali, go-live happens on
  a video call, site visits are available but quoted separately
- 30 days post-go-live support, then $25/hr
- If a certified integration already exists per NI, deposit covers work done
  to that point only

## Separate, not-yet-started item (same client, different scope)
Ziad wants the Shopify POS receipt reformatted to a proper UAE Tax Invoice —
header "TAX INVOICE" instead of "SALE", TRN + legal entity name (D R K
Fashion Trading LLC SPC) at the top, VAT shown as amount-before-VAT → VAT →
total (he sent an ADNOC receipt as the reference format). This is a Shopify
POS admin settings job (Settings → Point of Sale → Receipt Customization,
possibly the newer content-editor version with built-in regional tax ID
fields), not core dev work, and not priced into the $2,000. Not started yet —
flag to Ali before bundling it into this build.

## Working style (Ali's standing preferences)
- Iterative, step-by-step, dry-run before executing anything live
- Minimal, targeted changes — no unasked-for rewrites
- Verify each step before moving to the next

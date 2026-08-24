# Finances — architecture & conventions

Household expense tracker for Ria + Jangelo (Singapore), built on top of RJ Portal's
static `index.html` / `style.css` / `app.js` (no framework, no build step). This doc
is the handoff note for future Claude sessions working on this feature — read it
before making changes so you don't relitigate decisions that were already made
deliberately.

## Data sources (three, kept strictly separate)

| File | What it is | Feeds |
|---|---|---|
| `finance-data.js` → `window.FINANCE_TXNS` | Ria's Citibank + DBS/POSB statements | Overview, Consolidate |
| `jangelo-data.js` → `window.JANGELO_TXNS` | Jangelo's Wise SGD account statement | Overview, Consolidate |
| `manual-log-data.js` → `window.MANUAL_TXNS` | Export of the shared "RJ Bahay" Google Sheet | Consolidate only |
| `finance-data.js` → `window.INCOME_TXNS` | Ria's HitPay salary credits | Income vs Expenses only |

All three transaction arrays share the tuple shape `[date, item, category, sgd]`
(manual log adds a 5th `status` field, kept for display only — **not** used to
filter reconciliation matches; either person can log or pay for either person's
purchases, so status isn't a reliable match boundary).

## The three tabs, and what each one is allowed to use

- **Overview** — `finHouseholdRows()` = Ria's statement + Jangelo's statement,
  merged. This is "the most true expenses in SG" per Ria — it must **only** ever
  be statement data, **never** the manual log. Don't be tempted to blend in
  `MANUAL_TXNS` here even for a "more complete" number.
- **Income vs Expenses** — income is *only ever Ria's own salary* (`INCOME_TXNS`),
  so expenses here must also be **Ria's own statement only** (`finRows()`), not
  the household total. Netting her income against Jangelo's Wise spend too would
  subtract money that never touched her DBS account, making "Net" not correspond
  to her actual bank balance. (This was tried and reverted once already — see git
  history around 2026-08-25 for the reasoning if it comes up again.)
- **Consolidate** — reconciles the combined statements (`finHouseholdRows()`)
  against the manual log (`finManualRows()`). This is the only tab that reads
  `MANUAL_TXNS`.

## Confirmed-match mechanisms (in `app.js`, near `finReconcile()`)

The matcher (`finReconcile()`) runs several tolerance tiers automatically (exact
amount + close date, then widening tolerance, then near-amount). When a real match
falls outside ALL of those tiers, it's added by hand to one of these small
hardcoded lists rather than loosening the general tolerance (which would just
create false positives elsewhere):

- **`CONSOLIDATED_GROUPS`** — many statement rows that sum to one manual log
  entry (Ria sometimes logs one lump sum for a shopping trip instead of each
  line). Matched against the **raw, pre-override** item text via `finRawItem()`
  — not `r.item` — so renaming a member row via the Edit button doesn't silently
  drop it out of its group.
- **`CONFIRMED_PAIRS`** — a single statement row ↔ a single manual row, confirmed
  by Ria directly, where the date/amount gap is bigger than the automatic tiers
  allow (e.g. rent paid on the 15th but logged over a week later under a
  completely different description like "368 Thomson Rent").
- **`MANUAL_LOG_INCLUSIONS`** — real expenses that exist ONLY in the manual log
  because they predate both statements' coverage windows (e.g. a rent deposit
  paid before Jangelo's Wise export even starts). These get synthesized into
  `finHouseholdRows()` with `source: "manual"`, tagged distinctly in the UI, and
  are **not** editable via the Edit button (they're a fixed list, not a real
  statement row).
- **`EXCLUDED_TRANSFERS`** / **`CC_BILL_PAYMENTS`** — real money movements
  deliberately left OUT of `FINANCE_TXNS`/`JANGELO_TXNS` (they'd double-count
  against purchases already itemized elsewhere, or aren't household expenses at
  all — e.g. an allowance transfer, or a PHP→SGD conversion). Still shown in
  Consolidate under "Other excluded transfers" / "Credit card bill payments" so
  they don't just vanish.

**PHP→SGD conversions**: excluded from `JANGELO_TXNS` entirely (same logic as
`CC_BILL_PAYMENTS` — a conversion just moves his own money into the account, it's
not itself a household expense) and listed in `EXCLUDED_TRANSFERS` instead.

## Editing & overrides

Both Ria's and Jangelo's rows are editable in the Overview table (Edit button →
inline item/category editor → Save/Cancel/Reset). Overrides persist in
`localStorage` under `rj_fin_overrides`, keyed **`"<source>:<idx>"`** (e.g.
`"ria:5"`, `"jangelo:12"`) so the two people's edits can never collide. A
migration in `finLoadOverrides()` recovers any pre-existing bare-numeric-key
entries (from before this prefix existed) by rewriting them as `"ria:<idx>"` —
every override before that point was necessarily Ria's.

The **"(edited)"** label is inline in the table; the **Reset** button only
appears inside the edit form itself (not as a standalone button in the table —
that was cluttering it).

## Display niceties

- **Sort dropdown** (Overview toolbar): Newest/Oldest first, Cost high↔low, Item
  A→Z.
- **"Show who paid" toggle**: off by default. When on, tags rows "· Ria" /
  "· Jangelo" / "· from your log, not a statement" via `finSourceTag()`.
- **"Your regulars" card** (Overview sidebar): merchants with 3+ visits within
  spend-y categories (Food/Groceries/Shopping/Entertainment/Medicine — NOT
  Rent/Utilities/Transportation/Other, those aren't "places you keep going back
  to" in the fun sense). Excludes "PayLah! top-up" (a wallet reload, not a real
  merchant). Click a regular to filter the table to it.
- **Categories**: `Food, Groceries/Supplies, Transportation, Shopping, Rent,
  Utilities, Entertainment, Medicine/Health, Other`. Utilities was split out of
  Rent (PUB/cleaning/gas/electricity/water) so it's visible separately — but a
  bundled statement line that pays rent+electricity in one payment stays under
  Rent since the split amount isn't knowable from the statement.

## Item-text consistency

Merchant names should be normalized to ONE consistent spelling across both
statement files (this matters for `finRegulars()`'s exact-string grouping and
just for readability): Title Case, no "PTE LTD" suffixes, no per-transaction
reference numbers (e.g. `Bus/mrt 891774352` → `Bus/MRT`), no phone
numbers/order codes appended (e.g. `Www.tada.global +6568177177` →
`Www.tada.global`). When the same real merchant shows up under two different
payment-rail descriptions (e.g. `PayNow – Adyen SG (Sang Nila Utama)` vs `Sang
Nila Utama Mala Pot`), rename to match — check for this whenever a "regular"
looks suspiciously absent.

## Known current gaps (as of 2026-08-25)

- **Jangelo's Wise spending is not yet fully consolidated** against the manual
  log — the manual sheet is primarily Ria's own log, so most of his statement
  rows land in "missing from the log" in Consolidate. This is expected, not a
  bug — the household statement merge (Overview) is complete and correct;
  full manual-log reconciliation for his side is still a work in progress.
- The May 13 "PayNow – rent + electricity" combined payment is still filed
  entirely under Rent (see Utilities note above).

## Test harness

Before committing any change to `app.js`/the data files, run:
```
node /path/to/scratchpad/test-finance.js
```
It loads the three data files, `eval()`s the finance-only slice of `app.js`
(between the `// ---------- Finances` and `// ---------- boot ----------`
markers) with stubbed DOM/localStorage, and exercises the internal functions
directly. Extend it with a new check whenever you add a new confirmed pair,
category, or mechanism — don't rely on manually eyeballing the diff.

**Footgun to avoid when writing ad-hoc test scripts**: `app.js`'s Finances slice
re-runs its `state.finXxx = <default>` init lines every time you `eval()` it. If
you set `state.finSort`/`state.finSearch`/`state.finShowSource`/etc. *before*
`eval(slice)`, the slice's own init lines silently overwrite your value back to
default. Always set test state *after* `eval(slice)`, not before.

# Group Buy campaign archive lifecycle — design

**Status: design, not built.** Owner-directed 2026-10-04: design this properly
before public launch, with safety rules preventing deletion of any campaign
carrying historical evidence. Nothing here ships until the owner approves it.

---

## The problem, stated honestly

Live gates must create **real** campaigns. A campaign that is "real except for
the counting" proves nothing about counting, so the gates that proved Group Buy
enforcement created genuine open campaigns with genuine frozen prices, genuine
orders and genuine qualifying units.

Those campaigns are permanent. Three independent reasons:

1. **The database refuses deletion.** `group_buy_frozen_child_guard`
   (migration `20260918183627`) is attached to `group_buy_campaign_tier` and
   `group_buy_campaign_variant` and looks up the parent campaign's status. On a
   cascading delete the parent row is already gone, so the lookup returns NULL,
   `IS DISTINCT FROM 'draft'` is true, and the delete is refused — even for a
   draft. Observed in production: `campaign <id> is <NULL>, so its tiers and
   eligible-variant prices are frozen (DELETE rejected)`.
2. **Qualifying units are append-only by design.** Public progress is
   monotonic; the unit ledger is a fold over append-only events. Removing units
   to tidy a number is the precise thing monotonicity exists to prevent.
3. **Acknowledgments, checks and audit events are evidence.** They answer
   "what did this customer agree to, and what did we verify" long after anyone
   remembers the campaign.

So the question was never "how do we delete them". It is "how do we guarantee
they are never mistaken for business activity".

## What already exists (shipped 2026-10-04)

- `app/domain/groupbuy/testFixtureCampaign.ts` — one definition of what makes a
  campaign a fixture (`zz-live-gate-` code prefix), one Prisma fragment that
  excludes them.
- The staff landing list excludes fixtures by default, with an explicit
  `includeTestFixtures` option so they stay **findable rather than hidden**.
- The public progress endpoint refuses a fixture campaign with the same
  `not_found` an unknown code gets — so a customer holding the code learns
  nothing and reaches nothing.

That covers the two surfaces that exist today. The design below is for the
surfaces that do not exist yet.

---

## Proposed model

### 1. A campaign lifecycle state, separate from its status

`status` already means something specific and operational: `draft` → `open` →
`closed`. Archival is orthogonal — a closed campaign may or may not be
archived, and archiving must never be reachable by confusing it with closing.

Add a nullable `archivedAt` / `archivedBy` / `archiveReason` triple, with the
same all-or-nothing CHECK the codebase already uses for override fields
(`group_buy_refund_override_complete` is the precedent). Archiving is an
**annotation**, never a deletion, and never a status transition.

### 2. What archiving changes, and what it must not

| Surface | Archived campaign |
|---|---|
| Staff landing list | hidden by default, shown under an explicit filter |
| Operational metrics / dashboards | excluded from every total |
| Merchandising, collections, storefront | never eligible |
| Customer emails | never a subject |
| Public progress endpoint | `not_found`, identical to an unknown code |
| Audit, evidence, settlement history | **unchanged and fully queryable** |
| Qualifying units, refunds, acknowledgments | **unchanged** |

The bottom three rows are the point. Archiving is about what a human reading a
dashboard should treat as business; it is not a privacy or retention control
and must never be used as one.

### 3. Deletion: permitted only for a campaign with no history

Deletion stays available for exactly one case — a draft created by mistake,
before it ever touched anything. The safety rule is a **positive** check, not a
list of exceptions:

> A campaign may be deleted only if it has, in total, ZERO of: orders, bank
> payment orders, qualifying-unit events, acknowledgments, cancellation checks,
> settlements, refunds, refund-ledger rows, and audit events naming it.

Enforced in **two independent places**, because one is not enough for a
destructive operation:

- **In the database**, as a `BEFORE DELETE` trigger on `group_buy_campaign`
  that counts the dependent rows itself and raises on any non-zero. A trigger
  cannot be bypassed by a future repository function, an admin script, or a
  migration someone writes in a hurry.
- **In the repository**, as an explicit pre-check returning a typed refusal
  naming WHICH kind of history exists, so the UI can say "this campaign has 3
  orders and 7 qualifying units" rather than "deletion failed".

The existing `group_buy_frozen_child_guard` must also be fixed as part of this
work: its parent-status lookup returns NULL during a cascade, which is why even
an empty draft cannot currently be deleted. The fix is to treat "parent row no
longer present" as a cascading delete rather than as "not draft" — but only
alongside the new trigger above, never before it, or the window between them is
one where a campaign with history becomes deletable.

### 4. Fixtures are archived, never deleted

The three existing `zz-live-gate-` campaigns carry real units and real orders.
They fail the deletion rule by design and will be **archived** when this ships.
Their evidence stays exactly as recorded.

---

## Safety rules, restated as acceptance criteria

1. Deleting a campaign with ANY dependent history is refused by the database,
   not only by application code.
2. The refusal names what exists, so a human can decide what to do.
3. Archiving never removes, rewrites, or hides evidence from audit queries.
4. Archiving is reversible; deletion is not, and the two are separate actions
   with separate permissions.
5. No archived or fixture campaign appears in any customer-facing surface,
   metric, merchandising slot, or email.
6. A test asserts the "business campaigns still appear" direction, so an
   over-broad filter cannot silently empty a dashboard while looking correct.
7. Fixture exclusion and archive exclusion share ONE definition each; a second
   inline copy of either predicate is the failure mode this whole document
   exists to prevent.

## Open questions for the owner

- Should archiving require a reason string? (Recommended: yes, it is free and
  answers "why is this hidden" a year later.)
- Should a closed campaign auto-archive after some period, or always by hand?
  (Recommended: by hand. An automatic rule that hides business history is a
  rule that will surprise someone during a dispute.)

# CaratForUs Theme

Shopify Online Store 2.0 theme, Dawn-based, per `docs/ARCHITECTURE-MVP1.md` §2
and §7. This directory is the **authoritative CaratForUs storefront source**.

## Baseline provenance — recorded so this is reproducible

| | |
|---|---|
| Upstream | `https://github.com/Shopify/dawn` |
| Commit | **`258f00f64365e2018ca4c62778a6bf55a5d3cd18`** |
| Branch | `main` (the commit is not tagged) |
| Commit date | 2026-08-10T16:55:51-04:00 |
| `theme_version` in `config/settings_schema.json` | **16.0.0** |
| Vendored | 2026-09-19, Slice 2 Stage 2B entry |
| Files vendored | 348 |

Pinned by **commit SHA rather than tag**: the commit vendored is on `main` and
carries no tag, and Dawn's repository tags (`v8.0.1`, `v9.0.0`) use a different
numbering from the `theme_version` field inside the theme (16.0.0), so a tag
name alone would not identify what is actually here. The SHA is unambiguous.

## What was and was not vendored

**Vendored** — the theme itself: `assets/`, `config/`, `layout/`, `locales/`,
`sections/`, `snippets/`, `templates/`, plus `DAWN-LICENSE.md` (upstream
`LICENSE.md`, renamed so it is not mistaken for CaratForUs's own licence) and
`.theme-check.yml`.

**Not vendored** — Dawn's own repository tooling: `.git/`, `.github/`,
`.gitignore`, `.prettierrc.json`, `README.md`, `release-notes.md`. These
describe how Shopify develops Dawn, not how this storefront behaves, and
keeping them would invite confusion about which project's CI and contribution
rules apply.

## Why the baseline is a separate commit

The Dawn import landed as **one commit containing no CaratForUs changes at
all**. Every subsequent modification is therefore visible as a diff against a
known-good upstream, which is what makes it possible to answer "did we change
this, or did Dawn always do that?" — a question that comes up constantly when
debugging a theme, and which is unanswerable once vendored code and local
changes are mixed in a single commit.

## Upgrading Dawn later

Re-vendor from a newer upstream commit into a clean tree, commit that alone,
then re-apply CaratForUs changes on top and update the table above. Do not
merge upstream changes file-by-file into a modified theme; the diff against
this baseline is the only reliable record of what CaratForUs actually altered.

## Stage 2B

This baseline exists so Stage 2B can inventory **real** cart and price surfaces
from committed files rather than inferring them from Shopify conventions — see
condition C4 / criterion 55 in
`docs/specs/SLICE-2-BUY-NOW-STOREFRONT-AND-SYNC.md`. The acceptance condition
is that no cart surface can render Card pricing while the cart is in Bank
Payment mode, or the reverse.

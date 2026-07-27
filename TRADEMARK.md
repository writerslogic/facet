# Facet Trademark & Attribution Policy

Facet's **source code** is licensed under **AGPL-3.0** (see [LICENSE](./LICENSE)). That license grants
broad rights to use, modify, and redistribute the code. This document covers the two things the code
license does **not** grant — the **name and logo** — and the **attribution** the project asks for.

## The name and logo are trademarks

The name **"Facet"** and the Facet **logo** (the faceted-starburst mark in [`assets/`](./assets)) are
trademarks of the project. An open-source **code** license never conveys trademark rights (this is
standard — e.g. Firefox, Redis, GitLab). Accordingly:

- You **may** run, modify, and redistribute Facet under AGPL-3.0.
- You **may not** use the "Facet" name or logo to brand a **modified or rebranded** distribution in a way
  that implies it is the official Facet, or that suggests endorsement/affiliation. If you ship a
  materially modified fork under your own product, use your **own** name and logo.
- Nominative use ("a fork of Facet", "compatible with Facet") is fine.

## Attribution

The dashboard shows a small **"Powered by Facet"** link. You may remove or replace it in **either** of
these ways:

1. **Comply with AGPL-3.0** — you are modifying the software; publish your corresponding source
   (including the change), as the license already requires, and you may remove the attribution.
2. **Hold a commercial white-label license** — see below — which permits removing the attribution
   **without** publishing source.

The attribution is a plain, un-obfuscated element (`PoweredBy` in `apps/dashboard`). We deliberately do
**not** ship tamper-checks, obfuscation, or "phone-home" enforcement: that would be user-hostile, trivially
defeated on client-side code, and contrary to the spirit of the AGPL. Attribution is protected by
**license and trademark**, not by technical lock-in.

## White-labeling (commercial)

To remove Facet branding **without** the AGPL source-publication obligation, a **commercial white-label
license** is available. A white-labeled build sets:

```
VITE_FACET_WHITE_LABEL=1
```

at build time, which suppresses the "Powered by Facet" attribution. Setting this flag is only permitted
under a commercial license **or** in a build whose source you publish per AGPL-3.0.

## Contact

Trademark or licensing questions: open an issue at
<https://github.com/writerslogic/facet> or contact the maintainers.

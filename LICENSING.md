# Licensing

Facet is **open source with a commercial option**. Copyright © 2026 WritersLogic, Inc.

## How the repository is licensed

Facet uses a split license so that the hosted product is protected from being resold as a competing
service, while the parts you embed in your own site or run as tools stay fully permissive.

| Part | Package(s) | License | Why |
|------|-----------|---------|-----|
| **The product** — server + dashboard | `@facet/server`, `@facet/dashboard` | **AGPL-3.0-only** | Self-host it for free forever; if you modify it and offer it to others over a network, you must share your changes under the same license. This lets us keep the source open without a competitor taking it and running a closed rival service. |
| **Browser SDK** | `@writerslogic/facet` (`packages/client`) | **MIT** | It runs inside *your* website. A copyleft license here would impose obligations on your site, so it is fully permissive — embed it anywhere, including in closed-source products. |
| **CLI** | `@writerslogic/facet-cli` (`packages/cli`) | **MIT** | A tool you run; permissive so it composes into any workflow. |
| **Shared types** | `@facet/shared` | **MIT** | Imported by the MIT SDK, so it must be permissive too. |
| **Trust / provenance library** | `@facet/trust` | **Apache-2.0** | A standards-conformant crypto library (RFC 8785/9421, VC Data Integrity, COSE, SCITT, MMR). Apache-2.0 gives an explicit patent grant, which matters for cryptographic code and encourages reuse. |

Each package carries its own `LICENSE` file; the repository root `LICENSE` is the AGPL-3.0 text that
governs the server and dashboard.

## What this means for you

- **Self-hosting:** free, under the AGPL. Run Facet for your own sites or your organization at no cost.
- **Embedding the tracker / using the CLI:** free and unrestricted (MIT) — no obligation to open-source
  your website or product.
- **Offering Facet as a hosted service to others:** the AGPL requires you to publish your modifications
  under the AGPL. If you want to offer a hosted/commercial service **without** the AGPL's source-sharing
  obligations, you need a commercial license (below).

## Commercial license

WritersLogic, Inc. offers a commercial license to Facet's server and dashboard for organizations that
want to embed, resell, or offer Facet as a service without AGPL obligations, or that need a warranty and
support terms. As the sole copyright holder, WritersLogic, Inc. can grant terms the AGPL does not.

Contact: **licensing@writerslogic.com**

## Third-party dependencies

Facet's entire production dependency tree is permissively licensed (MIT, BSD-3-Clause, Apache-2.0, ISC,
Unlicense, CC0). None impose copyleft or commercial restrictions. Attribution notices for bundled
dependencies are retained per their licenses.

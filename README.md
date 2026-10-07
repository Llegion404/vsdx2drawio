# vsdx2drawio

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-41%2F41-brightgreen.svg)]()
[![Deploy](https://github.com/Llegion404/vsdx2drawio/actions/workflows/deploy.yml/badge.svg)](https://github.com/Llegion404/vsdx2drawio/actions/workflows/deploy.yml)

Convert Microsoft Visio **.vsdx / .vssx** files to **editable draw.io diagrams** — free,
100% client-side. Shapes, groups, connectors, pages and stencil masters become real
draw.io shapes (not rasterized screenshots), so the output keeps being editable in
[diagrams.net](https://app.diagrams.net).

**No uploads, no accounts, no tracking of your files** — conversion runs entirely in your browser.

♡ If it saved you time, [**support the project**](https://github.com/sponsors/Llegion404) or star the repo.

This is the validation funnel for a bigger product idea (diagramming for IT/network teams
with vendor stencils, CSV/SQL data-linked shapes, scaled plotter output, SSO at base price).
Go/kill thresholds and market research live in `../pain-scan-2026-10-06.md`.

## Run

```bash
npm install
npm run dev        # dev server
npm test           # golden corpus + synthetic ground-truth tests (41)
npm run build      # static build -> dist/ (deploy anywhere)
npm run spike -- corpus/vsdx/test4_connectors.vsdx out.drawio   # CLI conversion
```

## Deploy (Cloudflare Pages, free)

1. `npm run build` → `dist/` is the whole app (static).
2. Cloudflare dashboard → Workers & Pages → Create → Pages → Upload assets → drag `dist/`.
   (Or connect the git repo; build command `npm run build`, output dir `dist`.)
3. Web Analytics → copy the beacon token into `src/config.ts` → `cfBeaconToken`.
4. Create a Tally form for the waitlist → paste its URL into `CONFIG.waitlistUrl`.
5. Rebuild + redeploy. Funnel events land in Web Analytics as pageviews of `#`-free URLs —
   for event-level tracking, wire `window.vsdx2drawioEvent` in `src/main.ts` to any
   event provider (the hook already exists).

## Pre-launch checklist

- [ ] `CONFIG.waitlistUrl` set (Tally)
- [ ] `CONFIG.cfBeaconToken` set (Cloudflare)
- [ ] `public/og.png` replaced with a real screenshot composite (currently a solid placeholder)
- [ ] Smoke test: drop a real corporate .vsdx, confirm pages + images + connectors
- [ ] 30-day measurement starts on launch day (thresholds in ../pain-scan-2026-10-06.md)

## How it works

```
.vsdx (OPC zip)
  └─ src/vsdx/opc.ts     unzip + relationship resolution
  └─ src/vsdx/model.ts   cells, master inheritance, geometry rows, text, pages, glue
        └─ Scene model   (inches, Y-up, transform matrices)
  └─ src/layout.ts       shared world-transform pass (pins, rotation, flips, glue)
  └─ src/drawio/emitter.ts   Scene -> mxGraphModel XML (rect/ellipse primitives +
                             inline stencils for arbitrary geometry: shape=stencil(<deflate b64>))
  └─ src/svg/emitter.ts      Scene -> SVG (web preview)
  └─ src/drawio/stencil.ts   Visio geometry rows -> mxStencil XML (arcs via bulge,
                             elliptical arcs, beziers, splines->polyline v0)
```

Key conversion facts (learned the hard way):

- Visio caches computed `V` values for every cell, so parsing values (not formulas) covers ~80%.
- Group children live under a `<Shapes>` wrapper inside the parent `Shape` element; `MasterContents`
  is the document root of master parts (not a child of it).
- Geometry rows come in absolute (`MoveTo`) and relative (`RelLineTo`, fractions of W/H) variants.
- Rotation is about the pin: transform chain is `T(pin)·R·T(−locPin)·F`. A single `(pin − locPin)`
  shift is only correct at Angle=0. Reflections conjugate rotations (`F·R(θ)·F = R(−θ)·F`), so net
  rotation must be accumulated with sign flips, never extracted from the composed matrix.
- Glued connectors carry **stale cached endpoints** — the page-level `<Connects>` glue is the truth.
- draw.io supports inline custom shapes: `shape=stencil(<base64 raw-deflate mxStencil XML>)`
  (see `Graph.decompress` in their bundle) — that's how arbitrary Visio geometry stays vector
  and editable.
- RemoteDesktop-style note: draw.io dropped .vsdx *export* in 2025 ("too much work" — jgraph
  issue #4942), which is part of why this converter's export direction matters.

## Corpus

- `corpus/vsdx/` — python-vsdx test files + LibreOffice libvisio test data
- `corpus/vssx/` — real vendor stencil packs (bhdicaire/visioStencils collection)
- Synthetic ground-truth files are built in-test (`tests/convert.test.ts`) for exact
  transform/arc/flip verification.

## Clean-room note

The parser is written from the public [MS-VSDX] spec + behavioral comparison. No GPL code
(libvisio) was copied. Users supply their own files; vendor shapes are never redistributed.

## Contributing

PRs welcome — good first issues: connector waypoints from cached routes, EllipticalArcTo
exactness in the SVG preview, WMF/EMF conversion, theme-color extraction. Run `npm test`
before submitting (41 tests, no corpus needed — synthetic files cover the math).

The `corpus/` directory is **not redistributed** (third-party files with mixed licenses).
To run corpus tests locally, fetch samples per the paths in `tests/convert.test.ts`.

## License

[AGPL-3.0-or-later](LICENSE) — the converter and any fork of it stay open. If you want to
embed it in a product under different terms, open an issue to discuss a licensing exception.
The planned companion product (data linking, stencil libraries, SSO) is a separate codebase.

## Privacy

Nothing you drop on this page is uploaded — there is no server. The only optional network
calls are a self-hosted-ish analytics beacon (pageviews, no file data) and GitHub/Diagrams.net
links you click. The privacy claim is auditable from the source in one read.

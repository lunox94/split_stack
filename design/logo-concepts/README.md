# Split Stack logo directions

## Selected production logo

**Solid Charcoal Marked Cells**

- Deterministic vector master: `05b-ambient-mesh-cell-master.svg`
- Full-resolution artwork: `06b-solid-dark.png`
- 256 px production export: `06b-solid-dark-256.png`
- Installed production asset: `public/icon.png`

The master places 160 px cells on a strict 170 px five-by-five construction
grid. Its center slot is deliberately absent, so the Hollow Cross always has
square negative space. The production background is a uniform charcoal navy
`#111827`; all cells, patterns, power colors, and canonical glyph paths are
assembled in SVG.

Render the production assets from the repository root with:

```sh
rsvg-convert -w 1024 -h 1024 \
  design/logo-concepts/05b-ambient-mesh-cell-master.svg \
  -o design/logo-concepts/06b-solid-dark.png
magick design/logo-concepts/06b-solid-dark.png \
  -filter Lanczos -resize 256x256 \
  design/logo-concepts/06b-solid-dark-256.png
cp design/logo-concepts/06b-solid-dark-256.png public/icon.png
```

## Retained alternatives

These directions are intentionally preserved for possible future use:

- **Solid Light**
  - Stylesheet: `solid-background-light.css`
  - `06a-solid-light.png`
  - `06a-solid-light-256.png`
- **Solid Black**
  - Stylesheet: `solid-background-black.css`
  - `06c-solid-black.png`
  - `06c-solid-black-256.png`
- **Ambient Mesh Marked Cells**
  - Generated plate: `05a-ambient-mesh-background.png`
  - Stylesheet: `ambient-mesh-background.css`
  - `05c-ambient-mesh-cell.png`
  - `05c-ambient-mesh-cell-256.png`

- **Retro Aqua Power Vertices**
  - `04f-power-vertices-retro-aqua.png`
  - `04f-power-vertices-retro-aqua-256.png`

- **Dark Diagonal Field**
  - `04d-power-vertices-dark-field.png`
  - `04d-power-vertices-dark-field-256.png`
- **Modern Flat**
  - `04e-power-vertices-modern-flat.png`
  - `04e-power-vertices-modern-flat-256.png`

See `PROMPTS.md` for the generation and refinement briefs.

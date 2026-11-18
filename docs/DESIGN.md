# DALANG Design Direction (v0.1 Rembuk)

## Product Identity
DALANG is a local-only developer workbench that orchestrates official coding CLIs (`claude`, `codex`, `agy`). Its visual language takes cues from a traditional scriptorium and puppeteer's workbench: tactile warm paper for reading and planning, crisp charcoal ink for technical precision, and sienna terracotta reserved strictly for human gates and primary stage actions.

## Three Dials
`Dial: ENERGY 1 / RHYTHM 2 / MOTION 1`

- **ENERGY 1 (Calm)**: Quiet workbench built for reading specs, answering Lead questions, and reviewing task graphs without marketing glare.
- **RHYTHM 2 (Balanced variation)**: Persistent workspace header and D-A-L-A-N-G stage rail, while each stage changes composition to match its decision (split onboarding on Projects, split conversation + question deck on Discuss, editorial document on Agree, columnar Kanban on List, diagnostic matrix on Providers).
- **MOTION 1 (Tactile feedback only)**: Short 120ms-150ms hover and focus transitions; no infinite loops, bounces, or decorative pulses.

## Palette (WCAG AA Verified)
Core palette stays within 2 semantic cores + 1 accent + warm neutrals:

### Light Mode (Default: Reading & Planning Workbench)
- Canvas background: `#F7F4EE`
- Elevated card / sheet: `#FFFDF9`
- Subtle surface / column well: `#EFEAE0`
- Structural divider: `#DFD8CC`
- Interactive control border: `#8A8175`
- Primary ink: `#1C1917` (15.93:1 on `#F7F4EE`)
- Secondary ink: `#57534E` (6.95:1 on `#F7F4EE`, 7.51:1 on `#FFFDF9`)
- Deliberate accent (Sienna Terracotta): `#9A3412` (7.19:1 on `#FFFDF9`, `#FFFFFF` on `#9A3412` = 7.31:1)
- Semantic pass / verified (Forest Sage): `#166534` (7.02:1 on `#FFFDF9`)
- Semantic error / alert (Crimson Oxide): `#991B1B` (8.18:1 on `#FFFDF9`)

### Dark Mode (Warm Charcoal Soot, via Working Theme Toggle)
- Canvas background: `#161412`
- Elevated card / sheet: `#201D1A`
- Subtle surface / column well: `#292521`
- Structural divider: `#3A342E`
- Interactive control border: `#7A7268`
- Primary ink: `#EFECE6` (15.58:1 on `#161412`)
- Secondary ink: `#B5AEA4` (8.36:1 on `#161412`, 7.63:1 on `#201D1A`)
- Deliberate accent (Warm Copper): `#E07A38` (`#161412` text on `#E07A38` = 6.13:1), `#F08C4B` text on `#201D1A` = 6.83:1
- Semantic pass / verified: `#4ADE80` (9.63:1 on `#201D1A`)
- Semantic error / alert: `#FCA5A5` (8.84:1 on `#201D1A`)

## Typography & Radii
- **UI & Prose**: `"IBM Plex Sans", "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` (works completely offline without external font dependencies).
- **Technical Tokens Only**: `"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace` reserved for task IDs (`[T-001]`), CLI paths, `verify` commands, and version tags.
- **Architectural Radii**: `4px` for inputs/badges/stamps, `6px` for buttons and cards, `8px` for dialog sheets. No universal pill shapes.

## Identity Motif & Stage Navigation
- **D-A-L-A-N-G 6-Stage Rail**: `Discuss · Agree · List · Assign · Navigate · Guard`. Stages in v0.1 (`Discuss`, `Agree`, `List`) navigate directly; v0.2+ stages (`Assign`, `Navigate`, `Guard`) are honestly labeled `v0.2+` and disabled rather than faking functionality.
- **Monospace Stamp Tags**: Rectangular crisp-bordered markers (`[T-007]`, `[v1 · DRAFT]`, `[ROUND 2]`) with no glowing dots or buzzword pills.

## Components
- **shadcn/ui, owned in the repo**: Button, Input, Textarea, NativeSelect, Label, Badge, and Dialog live in `packages/web/src/components/ui` (Base UI primitives) and are restyled to this document. Do not regenerate them from the CLI without redoing the restyle: the CLI default adds a web font, an icon library, pill badges, a blurred scrim, and entrance animations, all of which this direction rejects.
- **Token mapping**: shadcn tokens (`--background`, `--primary`, `--border`, `--ring`, and the rest) resolve to the palette above in `packages/web/src/styles/app.css`, so the light and dark themes follow `data-theme`.
- **Targets and fields**: every button and field is at least 44px tall. Selects stay native so mobile pickers and keyboard behavior are the platform's.

# DALANG Design Direction (v0.6 UI Revamp)

## Product Identity
DALANG is a local-only developer workbench that orchestrates official coding CLIs (`claude`, `codex`, `agy`). Its visual language takes cues from a traditional scriptorium and wayang kulit puppeteer's workbench: tactile warm paper for reading and planning, crisp charcoal ink for technical precision, and sienna terracotta reserved strictly for human gates and primary stage actions.

## Three Dials
`Dial: ENERGY 1 / RHYTHM 2 / MOTION 1` (with an explicit, user-pausable motion exception for the Work stage and first-run wizard intro)

- **ENERGY 1 (Calm)**: Quiet workbench built for reading specs, answering Lead questions, and reviewing task graphs without marketing glare.
- **RHYTHM 2 (Balanced variation)**: Persistent left sidebar (`+ New project`, project list, and a footer row with Statistics and Config icon buttons, the `ID | EN` switch, and a sun/moon theme icon, plus the update notice; swaps to `<- Back` + 6 Config tabs when in Config; collapses into a modal drawer behind a labeled `Menu` button on phones), paired with a 5-step guided project stepper and `"Next step"` guidance card inside each project.
- **MOTION 1 (Tactile feedback only, plus wayang stage exception)**: Short 120ms-150ms hover and focus transitions across the workspace. Only the Work stage (`WorkStage`) and the first-run wizard intro (`WizardView` Screen 1) play ambient wayang shadow animation. Both animations are opt-in via `@media (prefers-reduced-motion: no-preference)`, pause automatically when `document.visibilityState === 'hidden'`, and expose a visible **Pause motion / Play motion** button.

## Palette (WCAG AA Verified)
Core palette stays within 2 semantic cores + 1 accent + warm neutrals, plus muted provider color badges and warm kelir stage surfaces (all verified >= 5.49:1 contrast):

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
- Provider badges: Claude `#9A3412` on `#FBECE5`, Codex `#14532D` on `#E6F3EA`, Antigravity `#1E3A8A` on `#E7EEF9`
- Kelir stage: warm cream `#F3E7CE` lit canvas over `#7A5C3E` debog base with `#2A2118` shadow silhouettes

### Dark Mode (Warm Charcoal Soot, via Working Theme Toggle & Follow System)
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
- Provider badges: Claude `#FDBA74` on `#3A2218`, Codex `#86EFAC` on `#183022`, Antigravity `#93C5FD` on `#1B2842`
- Kelir stage: warm amber-lit `#2F251B` canvas over `#4E3A26` debog base with `#0F0B08` shadow silhouettes and warm copper rim highlights

## Typography & Radii
- **UI & Prose**: `"IBM Plex Sans", "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` (works completely offline without external font dependencies).
- **Technical Tokens Only**: `"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace` reserved for task IDs (`[T-001]`), CLI paths, `verify` commands, and version tags.
- **Architectural Radii**: `4px` for inputs/badges/stamps, `6px` for buttons and cards, `8px` for dialog sheets. No universal pill shapes.

## Identity Motif, Wayang Artwork & Guided Stepper
- **Redrawn Gunungan Wayang (Kayon)**: Derived from Tropenmuseum / Wereldmuseum collection photograph `TMnr 8-225` (CC BY-SA 3.0). Rendered in full detail (`GununganDetailed`) in the first-run wizard and `Config -> About`, and simplified (`GununganMark`) for the sidebar logo and browser `favicon.svg`.
- **Wayang Kulit Cast**: Five articulated SVG figures derived from Tropenmuseum / Wereldmuseum Wikimedia Commons photographs (CC BY-SA 3.0, attributed in `packages/web/src/assets/wayang/CREDITS.md`) and split at shoulder and elbow joints with pin pivots: Semar (`TMnr 8-251`, Lead), Bima (`TMnr 8-265`, Coder for simple tasks), Kresna (`TMnr 8-239`, Coder for complex tasks), Arjuna (`TMnr 8-307`, Reviewer), and Gatotkaca (`TMnr 8-273`, Fallback). Rendered in flat shadow style on the Work stage kelir and in warm-paper sungging style on Config -> Team cards and the wizard.
- **5-Step Guided Project Stepper**: `1 Discuss (D) · 2 Brief (A) · 3 Plan (L) · 4 Work (A·N) · 5 Review & merge (G)`, paired with a single-sentence `"Next step"` guidance card with one primary CTA. All v0.5 actions (including routing previews, dependency graph, live logs, retries, rollback, diff review, merge, and push/PR) remain reachable inside the steps and Config tabs.
- **Monospace Stamp Tags**: Rectangular crisp-bordered markers (`[T-007]`, `[v1 · DRAFT]`, `[ROUND 2]`) with no glowing dots or buzzword pills.

## Components
- **shadcn/ui, owned in the repo**: Button, Input, Textarea, NativeSelect, Label, Badge, and Dialog live in `packages/web/src/components/ui` (Base UI primitives) and are restyled to this document. Do not regenerate them from the CLI without redoing the restyle: the CLI default adds a web font, an icon library, pill badges, a blurred scrim, and entrance animations, all of which this direction rejects.
- **Token mapping**: shadcn tokens (`--background`, `--primary`, `--border`, `--ring`, and the rest) resolve to the palette above in `packages/web/src/styles/app.css`, so the light and dark themes follow `data-theme`.
- **Targets and fields**: every button and field is at least 44px tall. Selects stay native so mobile pickers and keyboard behavior are the platform's.

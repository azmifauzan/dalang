# Dalang design direction (v0.7.2)

## Product Identity
DALANG is a local-only developer workbench that orchestrates official coding CLIs (`claude`, `codex`, `agy`). Its visual language takes cues from a traditional scriptorium and wayang kulit puppeteer's workbench: tactile warm paper for reading and planning, crisp charcoal ink for technical precision, and sienna terracotta reserved strictly for human gates and primary stage actions.

## Three Dials
`Dial: ENERGY 1 / RHYTHM 2 / MOTION 1` (with an explicit, user-pausable motion exception for the Work stage and first-run wizard intro)

- **ENERGY 1 (Calm)**: Quiet workbench built for reading specs, answering Lead questions, and reviewing task graphs without marketing glare.
- **RHYTHM 2 (Balanced variation)**. The sidebar groups saved and archived chats by project. Each chat shows its mode, with a progress indicator while the Lead answers. The footer holds Statistics, Config, language, theme, and update controls. When app login is on, the Sign out icon is the final control in the footer and icon rail. Config uses the same sidebar for its six tabs. On desktop the sidebar can collapse to a remembered icon rail. On mobile **Menu** opens it as a drawer.
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
- **Redrawn Gunungan Wayang (Kayon)** draws on Tropenmuseum / Wereldmuseum collection photograph `TMnr 8-225` (CC BY-SA 3.0). The first-run wizard and Config → About use `GununganDetailed`. The sidebar and sign-in form use `GununganMark`, with the mark centered above the sign-in title. The browser `favicon.svg` uses the simplified emblem.
- **Wayang Kulit Cast**: Five articulated SVG figures derived from Tropenmuseum / Wereldmuseum Wikimedia Commons photographs (CC BY-SA 3.0, attributed in `packages/web/src/assets/wayang/CREDITS.md`) and split at shoulder and elbow joints with pin pivots: Semar (`TMnr 8-251`, Lead), Bima (`TMnr 8-265`, Coder for simple tasks), Kresna (`TMnr 8-239`, Coder for complex tasks), Arjuna (`TMnr 8-307`, Reviewer), and Gatotkaca (`TMnr 8-273`, Fallback). Rendered in flat shadow style on the Work stage kelir and in warm-paper sungging style on Config -> Team cards and the wizard.
- **Full stepper**. Discuss, Brief, Plan, Work, and Review & merge each contain the controls for that stage. Work holds routing previews, the dependency graph, live logs, retries, and rollback. Review & merge holds diffs, merge decisions, integration tests, and Git remote actions.
- **Monospace Stamp Tags**: Rectangular crisp-bordered markers (`[T-007]`, `[v1 · DRAFT]`, `[ROUND 2]`) with no glowing dots or buzzword pills.

## Chat Surface (v0.7)
- **One composer for Ask, Quick, and Full.** The mode selector sits beside the send button. A new chat centers the composer. After the first message, the transcript scrolls and the composer stays at the bottom. User messages align right and formatted Lead replies align left. The session header shows the mode, editable title, and available session actions.
- **Image attachments.** A paperclip at the left of the composer footer opens the image picker and has a localized accessible label. Selected images have removable previews, and sent images appear in the message bubble.
- **Mode-specific navigation.** Ask opens straight into the transcript. Quick shows the Request, Work, Review, and Merge timeline with task controls inline. Full places its stepper above the workflow and shows the question deck in Discuss. [Current screenshots](USAGE.md)
- **Running panel.** While a turn runs it shows the CLI's real name and mark, elapsed time, the current step, and the answer as it forms. Raw log lines stay behind a toggle and never lead the screen. The pulse respects `prefers-reduced-motion`.
- **Model picker.** One chip in the composer footer opens a popover: a provider rail, model search and list, and a reasoning column. Below `lg` it is a bottom sheet. Claude models show with their versions.
- **Provider marks.** The Claude, OpenAI, and Antigravity marks identify the CLI in the picker, the header, and the limits bar. They are the owners' marks, used only for that purpose, and are the one place the UI is not drawn in this palette. Claude keeps its own orange, Codex follows the text color, and Antigravity is an image.
- **Provider limits bar.** A slim sticky bar above the project shows the tightest 5 hour and weekly limit per CLI (one number on narrow screens). A value at 20% or below turns red and is also shown as a number, so color is never the only signal. `Details` opens a panel sized to the space below the bar.

## Components
- **shadcn/ui, owned in the repo**: Button, Input, Textarea, NativeSelect, Label, Badge, and Dialog live in `packages/web/src/components/ui` (Base UI primitives) and are restyled to this document. Do not regenerate them from the CLI without redoing the restyle: the CLI default adds a web font, an icon library, pill badges, a blurred scrim, and entrance animations, all of which this direction rejects.
- **Token mapping**: shadcn tokens (`--background`, `--primary`, `--border`, `--ring`, and the rest) resolve to the palette above in `packages/web/src/styles/app.css`, so the light and dark themes follow `data-theme`.
- **Targets and fields**: every button and field is at least 44px tall. Selects stay native so mobile pickers and keyboard behavior are the platform's.

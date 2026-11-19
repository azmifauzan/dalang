// Derived from Tropenmuseum Javanese Gunungan / Kayon (TMnr 8-225, CC BY-SA 3.0).
// See packages/web/src/assets/wayang/CREDITS.md for attribution.

import { GUNUNGAN_OUTLINE_PATH } from './paths.js';

/**
 * Detailed Javanese Gunungan (Kayon) emblem for the wizard and About screen:
 * traced archival silhouette with central Pohon Hayat (tree of life), sulur foliage,
 * Gapura threshold gate, guardian base motif, and cempurit handle rod.
 */
export function GununganDetailed({
  size = 112,
  className = '',
  label,
}: {
  size?: number;
  className?: string;
  label?: string;
}) {
  return (
    <svg
      viewBox="0 0 180 240"
      width={Math.round((size * 180) / 240)}
      height={size}
      className={className}
      fill="none"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {/* Outer Kayon silhouette traced from TMnr 8-225 */}
      <path
        d={GUNUNGAN_OUTLINE_PATH}
        fill="var(--accent-tint)"
        stroke="var(--accent)"
        strokeWidth="3"
        strokeLinejoin="round"
      />

      {/* Base sanctuary / terraced foundation */}
      <path
        d="M44 176 H136 M52 192 H128 M56 218 H124"
        stroke="var(--accent)"
        strokeWidth="2.2"
        strokeLinecap="round"
      />

      {/* Gapura (threshold gate) */}
      <path
        d="M68 176 V142 L90 126 L112 142 V176 M78 176 V152 L90 144 L102 152 V176"
        stroke="var(--accent)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* Guardian Kala motif at the lower base */}
      <circle
        cx="90"
        cy="198"
        r="11"
        fill="var(--bg-surface)"
        stroke="var(--accent)"
        strokeWidth="2.2"
      />
      <path
        d="M84 196 H87 M93 196 H96 M84 203 Q90 207 96 203"
        stroke="var(--accent)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M72 198 C66 192 64 185 68 182 M108 198 C114 192 116 185 112 182"
        stroke="var(--accent)"
        strokeWidth="2"
        strokeLinecap="round"
      />

      {/* Central Pohon Hayat (Tree of Life) trunk & crown */}
      <path
        d="M90 28 V176"
        stroke="var(--accent)"
        strokeWidth="2.6"
        strokeLinecap="round"
      />

      {/* Symmetrical Sulur foliage branches */}
      <path
        d="M90 54 C80 54 74 47 71 39 M90 54 C100 54 106 47 109 39"
        stroke="var(--accent)"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path
        d="M90 78 C74 78 64 68 58 56 M90 78 C106 78 116 68 122 56"
        stroke="var(--accent)"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path
        d="M90 104 C68 104 54 93 47 78 M90 104 C112 104 126 93 133 78"
        stroke="var(--accent)"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path
        d="M90 124 C66 124 46 116 36 105 M90 124 C114 124 134 116 144 105"
        stroke="var(--accent)"
        strokeWidth="2"
        strokeLinecap="round"
      />

      {/* Twin curved wing ribs echoing TMnr 8-225 */}
      <path
        d="M34 136 Q52 154 68 156 M146 136 Q128 154 112 156"
        stroke="var(--accent)"
        strokeWidth="2.2"
        strokeLinecap="round"
      />

      {/* Cempurit (handle rod) */}
      <path
        d="M90 218 V236"
        stroke="var(--accent)"
        strokeWidth="3.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * The same traced Gunungan as the detailed emblem, drawn with heavier strokes and fewer details so it
 * stays readable at 16 to 28 px in the sidebar brand mark.
 */
export function GununganMark({
  size = 24,
  className = '',
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 180 240"
      width={Math.round((size * 180) / 240)}
      height={size}
      className={className}
      fill="none"
      aria-hidden="true"
    >
      <path d={GUNUNGAN_OUTLINE_PATH} fill="var(--accent-tint)" stroke="var(--accent)" strokeWidth="14" strokeLinejoin="round" />
      <path
        d="M90 28V176 M90 54C80 54 74 47 71 39M90 54C100 54 106 47 109 39 M90 78C74 78 64 68 58 56M90 78C106 78 116 68 122 56 M90 104C68 104 54 93 47 78M90 104C112 104 126 93 133 78"
        stroke="var(--accent)"
        strokeWidth="11"
        strokeLinecap="round"
      />
      <path d="M68 176V142L90 126L112 142V176 M44 176H136" stroke="var(--accent)" strokeWidth="11" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Derived from Tropenmuseum / Wereldmuseum wayang kulit photographs (CC BY-SA 3.0).
// See packages/web/src/assets/wayang/CREDITS.md for attribution.

import { WAYANG_FIGURES, type WayangCharacterId } from './paths.js';

export type { WayangCharacterId };

export interface WayangFigureProps {
  character: WayangCharacterId;
  variant?: 'shadow' | 'sungging';
  animated?: boolean;
  paused?: boolean;
  dimmed?: boolean;
  facing?: 'left' | 'right';
  className?: string;
  size?: number;
  label?: string;
}

const SUNGGING_PALETTE: Record<
  WayangCharacterId,
  { body: string; frontArm: string; backArm: string; stroke: string; pin: string }
> = {
  semar: {
    body: '#2C2520',
    frontArm: '#9A3412',
    backArm: '#B45309',
    stroke: '#D97706',
    pin: '#FDE68A',
  },
  bima: {
    body: '#1F1B18',
    frontArm: '#9A3412',
    backArm: '#7C2D12',
    stroke: '#C2410C',
    pin: '#FDE68A',
  },
  arjuna: {
    body: '#1E293B',
    frontArm: '#B45309',
    backArm: '#166534',
    stroke: '#D97706',
    pin: '#FEF3C7',
  },
  kresna: {
    body: '#241B2E',
    frontArm: '#6D28D9',
    backArm: '#B45309',
    stroke: '#C9A227',
    pin: '#FDE68A',
  },
  gatotkaca: {
    body: '#31211A',
    frontArm: '#9A3412',
    backArm: '#1D4ED8',
    stroke: '#E07A38',
    pin: '#FDE68A',
  },
  srikandi: {
    body: '#2B1F28',
    frontArm: '#9A3412',
    backArm: '#0F766E',
    stroke: '#D97706',
    pin: '#FEF3C7',
  },
};

export function WayangFigure({
  character,
  variant = 'shadow',
  animated = false,
  paused = false,
  dimmed = false,
  facing = 'left',
  className = '',
  size,
  label,
}: WayangFigureProps) {
  const fig = WAYANG_FIGURES[character];
  const isShadow = variant === 'shadow';
  const pal = SUNGGING_PALETTE[character];

  const bodyFill = isShadow ? 'var(--wayang-shadow, #1c1714)' : pal.body;
  const frontFill = isShadow ? 'var(--wayang-shadow, #1c1714)' : pal.frontArm;
  const backFill = isShadow ? 'var(--wayang-shadow-back, #28211c)' : pal.backArm;
  const edgeStroke = isShadow ? 'rgba(245, 214, 152, 0.28)' : pal.stroke;
  const pinFill = isShadow ? 'rgba(245, 214, 152, 0.6)' : pal.pin;

  const [fsx, fsy] = fig.pivots.frontShoulder;
  const [fex, fey] = fig.pivots.frontElbow;
  const [bsx, bsy] = fig.pivots.backShoulder;
  const [bex, bey] = fig.pivots.backElbow;

  const animClass = animated ? (paused ? 'wayang-active wayang-paused' : 'wayang-active') : '';

  return (
    <svg
      viewBox="0 0 240 240"
      width={size}
      height={size}
      className={`wayang-figure ${animClass} ${className}`}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{
        opacity: dimmed ? 0.42 : 1,
        transform: facing === 'right' ? 'scaleX(-1)' : undefined,
      }}
    >
      <g className="wayang-body-group" style={{ transformOrigin: '120px 228px' }}>
        {/* Back arm (pinned at back shoulder, carrying nested back forearm pinned at back elbow) */}
        <g
          className="wayang-back-upper"
          style={{ transformOrigin: `${bsx}px ${bsy}px` }}
        >
          <path
            d={fig.backUpperArm}
            fill={backFill}
            stroke={edgeStroke}
            strokeWidth={isShadow ? 0.7 : 1.1}
            strokeLinejoin="round"
          />
          <g
            className="wayang-back-forearm"
            style={{ transformOrigin: `${bex}px ${bey}px` }}
          >
            <path
              d={fig.backForearm}
              fill={backFill}
              stroke={edgeStroke}
              strokeWidth={isShadow ? 0.7 : 1.1}
              strokeLinejoin="round"
            />
            <circle cx={bex} cy={bey} r={2.2} fill={pinFill} />
          </g>
          <circle cx={bsx} cy={bsy} r={2.2} fill={pinFill} />
        </g>

        {/* Torso + headdress + legs (evenodd preserves authentic inner cutouts) */}
        <path
          d={fig.body}
          fill={bodyFill}
          fillRule="evenodd"
          stroke={edgeStroke}
          strokeWidth={isShadow ? 0.85 : 1.3}
          strokeLinejoin="round"
        />

        {/* Front arm (nested shoulder -> elbow pins) */}
        <g
          className="wayang-front-upper"
          style={{ transformOrigin: `${fsx}px ${fsy}px` }}
        >
          {fig.frontUpperArm && (
            <path
              d={fig.frontUpperArm}
              fill={frontFill}
              stroke={edgeStroke}
              strokeWidth={isShadow ? 0.7 : 1.1}
              strokeLinejoin="round"
            />
          )}
          <g
            className="wayang-front-forearm"
            style={{ transformOrigin: `${fex}px ${fey}px` }}
          >
            <path
              d={fig.frontForearm}
              fill={frontFill}
              stroke={edgeStroke}
              strokeWidth={isShadow ? 0.7 : 1.1}
              strokeLinejoin="round"
            />
            <circle cx={fex} cy={fey} r={2.2} fill={pinFill} />
          </g>
          <circle cx={fsx} cy={fsy} r={2.2} fill={pinFill} />
        </g>
      </g>
    </svg>
  );
}

/** Maps a DALANG agent profile or task role to its traditional wayang cast character. */
export function characterForProfile(
  profileName: string,
  role?: string,
  _usedFallback?: boolean,
  complexity?: string | null,
): WayangCharacterId {
  const lower = `${profileName} ${role ?? ''}`.toLowerCase();
  if (lower.includes('srikandi') || /\bqa\b/.test(lower) || lower.includes('tester')) {
    return 'srikandi';
  }
  if (lower.includes('review') || lower.includes('guard')) {
    return 'arjuna';
  }
  if (lower.includes('lead') || lower.includes('plan') || lower.includes('semar')) {
    return 'semar';
  }
  // Gatotkaca handles medium tasks; Kresna handles high/complex; Bima handles low/simple.
  if (
    lower.includes('medium') ||
    lower.includes('gatot') ||
    (role === 'engineer' && complexity === 'medium')
  ) {
    return 'gatotkaca';
  }
  if (
    lower.includes('heavy') ||
    lower.includes('complex') ||
    lower.includes('kresna') ||
    (role === 'engineer' && complexity === 'high')
  ) {
    return 'kresna';
  }
  return 'bima';
}

export function castDisplayName(cast: WayangCharacterId): string {
  return {
    semar: 'Semar',
    bima: 'Bima',
    gatotkaca: 'Gatotkaca',
    kresna: 'Kresna',
    srikandi: 'Srikandi',
    arjuna: 'Arjuna',
  }[cast];
}

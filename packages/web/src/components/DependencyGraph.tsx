import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TaskDispatchPreviewDTO, TaskDTO, TaskStatus } from '@dalang/shared';
import { useI18n } from '../i18n/index.js';
import { Badge } from '@/components/ui/badge';

interface DependencyNode {
  id: string;
  externalId: string;
  title: string;
  milestone: string;
  role: string;
  complexity: string;
  status: TaskStatus;
  dependsOn: string[];
  wave: number;
  profileLabel: string | null;
  quotaReroutedReason: string | null;
  overlappingTasks: string[];
  blockedByOverlapWith: string | null;
  blockedReason: string | null;
  filesAllowed?: string[];
}

interface EdgeCoord {
  id: string;
  fromExt: string;
  toExt: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  highlighted: boolean;
}

export interface DependencyGraphProps {
  previews?: TaskDispatchPreviewDTO[];
  tasks?: TaskDTO[];
  selectedTaskId?: string | null;
  onSelectTask?: (taskId: string) => void;
  emptyMessage?: string;
}

function computeTopologicalWaves(
  items: Array<{ externalId: string; dependsOn: string[] }>,
): Map<string, number> {
  const byExt = new Map(items.map((item) => [item.externalId, item]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  const depthOf = (ext: string): number => {
    const cached = memo.get(ext);
    if (cached !== undefined) return cached;
    if (visiting.has(ext)) return 0;
    visiting.add(ext);
    const node = byExt.get(ext);
    let maxDep = -1;
    if (node) {
      for (const dep of node.dependsOn) {
        if (byExt.has(dep)) {
          maxDep = Math.max(maxDep, depthOf(dep));
        }
      }
    }
    visiting.delete(ext);
    const wave = maxDep + 1;
    memo.set(ext, wave);
    return wave;
  };

  for (const item of items) {
    depthOf(item.externalId);
  }
  return memo;
}

function statusBadgeStyle(status: TaskStatus): string {
  switch (status) {
    case 'done':
    case 'awaiting_merge':
      return 'border-[var(--pass)] bg-[var(--pass-tint)] text-[var(--pass)]';
    case 'running':
    case 'reviewing':
      return 'border-[var(--accent)] bg-[var(--accent-tint)] text-[var(--accent)]';
    case 'failed':
    case 'review_failed':
    case 'stopped':
      return 'border-[var(--error)] bg-[var(--error-tint)] text-[var(--error)]';
    default:
      return '';
  }
}

export function DependencyGraph({
  previews,
  tasks,
  selectedTaskId,
  onSelectTask,
  emptyMessage,
}: DependencyGraphProps) {
  const { t, te } = useI18n();
  const resolvedEmptyMessage = emptyMessage ?? t('graph.empty');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [hoveredExt, setHoveredExt] = useState<string | null>(null);
  const [edges, setEdges] = useState<EdgeCoord[]>([]);
  const [svgSize, setSvgSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });

  const nodes = useMemo<DependencyNode[]>(() => {
    if (previews && previews.length > 0) {
      return previews.map((p) => ({
        id: p.taskId,
        externalId: p.externalId,
        title: p.title,
        milestone: p.milestone,
        role: p.role,
        complexity: p.complexity,
        status: p.status,
        dependsOn: p.dependsOn,
        wave: p.wave,
        profileLabel: `${p.resolvedProfileName} (${p.resolvedProvider})`,
        quotaReroutedReason: p.quotaReroutedReason,
        overlappingTasks: p.overlappingTasks,
        blockedByOverlapWith: p.blockedByOverlapWith,
        blockedReason: p.blockedReason,
      }));
    }

    if (tasks && tasks.length > 0) {
      const waves = computeTopologicalWaves(tasks);
      return tasks.map((t) => ({
        id: t.id,
        externalId: t.externalId,
        title: t.title,
        milestone: t.milestone,
        role: t.role,
        complexity: t.complexity,
        status: t.status,
        dependsOn: t.dependsOn,
        wave: waves.get(t.externalId) ?? 0,
        profileLabel: t.profileOverride ?? null,
        quotaReroutedReason: null,
        overlappingTasks: [],
        blockedByOverlapWith: null,
        blockedReason: null,
        filesAllowed: t.filesAllowed,
      }));
    }

    return [];
  }, [previews, tasks]);

  const wavesList = useMemo(() => {
    const grouped = new Map<number, DependencyNode[]>();
    for (const node of nodes) {
      const list = grouped.get(node.wave) ?? [];
      list.push(node);
      grouped.set(node.wave, list);
    }
    return [...grouped.entries()].sort((a, b) => a[0] - b[0]);
  }, [nodes]);

  const activeFocusExt = useMemo(() => {
    if (hoveredExt) return hoveredExt;
    if (selectedTaskId) {
      return nodes.find((n) => n.id === selectedTaskId)?.externalId ?? null;
    }
    return null;
  }, [hoveredExt, nodes, selectedTaskId]);

  const downstreamMap = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const node of nodes) {
      for (const dep of node.dependsOn) {
        const list = map.get(dep) ?? [];
        list.push(node.externalId);
        map.set(dep, list);
      }
    }
    return map;
  }, [nodes]);

  const computeEdges = () => {
    const container = containerRef.current;
    if (!container) return;

    const cRect = container.getBoundingClientRect();
    const width = container.scrollWidth;
    const height = container.scrollHeight;

    const nextEdges: EdgeCoord[] = [];
    const extSet = new Set(nodes.map((n) => n.externalId));

    for (const target of nodes) {
      const targetEl = cardRefs.current.get(target.externalId);
      if (!targetEl) continue;
      const tRect = targetEl.getBoundingClientRect();
      const x2 = tRect.left - cRect.left + container.scrollLeft;
      const y2 = tRect.top - cRect.top + container.scrollTop + tRect.height / 2;

      for (const depExt of target.dependsOn) {
        if (!extSet.has(depExt)) continue;
        const sourceEl = cardRefs.current.get(depExt);
        if (!sourceEl) continue;
        const sRect = sourceEl.getBoundingClientRect();
        const x1 = sRect.right - cRect.left + container.scrollLeft;
        const y1 = sRect.top - cRect.top + container.scrollTop + sRect.height / 2;

        const highlighted =
          activeFocusExt !== null &&
          (activeFocusExt === depExt || activeFocusExt === target.externalId);

        nextEdges.push({
          id: `${depExt}->${target.externalId}`,
          fromExt: depExt,
          toExt: target.externalId,
          x1,
          y1,
          x2,
          y2,
          highlighted,
        });
      }
    }

    setSvgSize({ width, height });
    setEdges(nextEdges);
  };

  useLayoutEffect(() => {
    computeEdges();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, activeFocusExt]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => computeEdges());
    ro.observe(container);
    window.addEventListener('resize', computeEdges);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', computeEdges);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, activeFocusExt]);

  if (nodes.length === 0) {
    return (
      <div className="rounded-[8px] border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
        {resolvedEmptyMessage}
      </div>
    );
  }

  const totalEdges = nodes.reduce((sum, n) => sum + n.dependsOn.length, 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{t('graph.wavesCount', { count: wavesList.length })}</Badge>
          <Badge>{t('graph.tasksCount', { count: nodes.length })}</Badge>
          <Badge>{t('graph.depsCount', { count: totalEdges })}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-[2px] border border-[var(--accent)] bg-[var(--accent-tint)]" />
            {t('graph.legendActive')}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-[2px] border border-[var(--pass)] bg-[var(--pass-tint)]" />
            {t('graph.legendDone')}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-[2px] border border-[var(--error)] bg-[var(--error-tint)]" />
            {t('graph.legendError')}
          </span>
        </div>
      </div>

      <div className="overflow-x-auto rounded-[8px] border border-border bg-muted/40">
        <div
          ref={containerRef}
          className="relative flex min-w-max items-start gap-10 p-5"
        >
          <svg
            aria-hidden="true"
            width={svgSize.width}
            height={svgSize.height}
            className="pointer-events-none absolute top-0 left-0 z-0"
          >
            <defs>
              <marker
                id="dalang-dep-arrow"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--border-control)" />
              </marker>
              <marker
                id="dalang-dep-arrow-active"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--accent)" />
              </marker>
            </defs>

            {edges.map((edge) => {
              const dx = Math.max(24, Math.abs(edge.x2 - edge.x1) * 0.45);
              const d = `M ${edge.x1} ${edge.y1} C ${edge.x1 + dx} ${edge.y1}, ${edge.x2 - dx} ${edge.y2}, ${edge.x2 - 3} ${edge.y2}`;
              return (
                <path
                  key={edge.id}
                  d={d}
                  fill="none"
                  stroke={edge.highlighted ? 'var(--accent)' : 'var(--border-control)'}
                  strokeWidth={edge.highlighted ? 2 : 1.35}
                  strokeOpacity={edge.highlighted ? 1 : 0.65}
                  markerEnd={
                    edge.highlighted
                      ? 'url(#dalang-dep-arrow-active)'
                      : 'url(#dalang-dep-arrow)'
                  }
                />
              );
            })}
          </svg>

          {wavesList.map(([waveIndex, waveNodes]) => (
            <section
              key={waveIndex}
              aria-label={`Wave ${waveIndex + 1}`}
              className="relative z-10 flex w-64 shrink-0 flex-col gap-3"
            >
              <header className="flex items-center justify-between border-b border-border pb-1.5">
                <span className="font-mono-token text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('graph.waveLabel', { n: waveIndex + 1 })}
                </span>
                <span className="font-mono-token text-xs text-muted-foreground">
                  {t('graph.tasksCount', { count: waveNodes.length })}
                </span>
              </header>

              <div className="flex flex-col gap-3">
                {waveNodes.map((node) => {
                  const isSelected = selectedTaskId === node.id;
                  const isHighlighted =
                    activeFocusExt === node.externalId ||
                    (activeFocusExt !== null &&
                      (node.dependsOn.includes(activeFocusExt) ||
                        (downstreamMap.get(activeFocusExt)?.includes(node.externalId) ?? false)));
                  const downstream = downstreamMap.get(node.externalId) ?? [];

                  return (
                    <button
                      key={node.id}
                      type="button"
                      ref={(el) => {
                        if (el) {
                          cardRefs.current.set(node.externalId, el);
                        } else {
                          cardRefs.current.delete(node.externalId);
                        }
                      }}
                      onClick={() => onSelectTask?.(node.id)}
                      onMouseEnter={() => setHoveredExt(node.externalId)}
                      onMouseLeave={() => setHoveredExt(null)}
                      onFocus={() => setHoveredExt(node.externalId)}
                      onBlur={() => setHoveredExt(null)}
                      className={`min-h-11 w-full cursor-pointer rounded-[6px] border p-3 text-left transition-colors duration-150 ${
                        isSelected
                          ? 'border-primary bg-[var(--accent-tint)]/35'
                          : isHighlighted
                            ? 'border-[var(--accent)] bg-card'
                            : 'border-border bg-card hover:border-[var(--border-control)]'
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-1.5">
                        <Badge>{node.externalId}</Badge>
                        <Badge className={statusBadgeStyle(node.status)}>{te(node.status)}</Badge>
                      </div>

                      <div className="mt-2 line-clamp-2 text-sm font-semibold text-foreground">
                        {node.title}
                      </div>

                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span className="font-mono-token">{node.milestone}</span>
                        <span>·</span>
                        <span>{te(node.role)}</span>
                        <span>·</span>
                        <span>{te(node.complexity)}</span>
                      </div>

                      {node.profileLabel && (
                        <div className="mt-1.5 font-mono-token text-[11px] text-muted-foreground">
                          {node.profileLabel}
                        </div>
                      )}

                      {node.quotaReroutedReason && (
                        <div
                          className="mt-1.5 rounded-[4px] border border-[var(--accent)] bg-[var(--accent-tint)] px-2 py-1 text-[11px] text-[var(--accent)]"
                          title={node.quotaReroutedReason}
                        >
                          {t('graph.fallbackPrefix', { reason: node.quotaReroutedReason })}
                        </div>
                      )}

                      {node.blockedByOverlapWith && (
                        <div className="mt-1.5 rounded-[4px] border border-[var(--error)] bg-[var(--error-tint)] px-2 py-1 text-[11px] text-[var(--error)]">
                          {t('graph.overlapPause', { task: node.blockedByOverlapWith })}
                        </div>
                      )}

                      {!node.blockedByOverlapWith && node.overlappingTasks.length > 0 && (
                        <div className="mt-1.5 font-mono-token text-[11px] text-muted-foreground">
                          {t('graph.sharedFiles', { tasks: node.overlappingTasks.join(', ') })}
                        </div>
                      )}

                      {(node.dependsOn.length > 0 || downstream.length > 0) && (
                        <div className="mt-2 border-t border-border/70 pt-1.5 font-mono-token text-[11px] text-muted-foreground">
                          {node.dependsOn.length > 0 && (
                            <div className="truncate">← {node.dependsOn.join(', ')}</div>
                          )}
                          {downstream.length > 0 && (
                            <div className="truncate">→ {downstream.join(', ')}</div>
                          )}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

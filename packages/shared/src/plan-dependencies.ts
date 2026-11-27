/**
 * Plan dependency graph analysis (PRD v0.15 P3).
 *
 * Computes the longest dependency chain (critical path) and the bottleneck task(s)
 * holding back the most transitive dependents before plan approval.
 */

export interface PlanDependencyTaskInput {
  externalId: string;
  title?: string;
  dependsOn?: string[];
}

export interface PlanBottleneckDTO {
  externalId: string;
  title?: string;
  blocksCount: number;
  totalTasks: number;
}

export interface PlanDependencyAnalysisDTO {
  totalTasks: number;
  criticalPath: string[];
  criticalPathLength: number;
  bottlenecks: PlanBottleneckDTO[];
  hasCycle: boolean;
}

/**
 * Analyzes a plan's task dependency DAG to find:
 * - `criticalPath`: the longest chain of dependent task external IDs (deterministic tie-break by input order).
 * - `bottlenecks`: tasks sorted by how many other tasks transitively depend on them (highest first).
 */
export function analyzePlanDependencies(
  tasks: readonly PlanDependencyTaskInput[],
): PlanDependencyAnalysisDTO {
  const totalTasks = tasks.length;
  if (totalTasks === 0) {
    return {
      totalTasks: 0,
      criticalPath: [],
      criticalPathLength: 0,
      bottlenecks: [],
      hasCycle: false,
    };
  }

  const orderIndex = new Map<string, number>();
  const titleById = new Map<string, string | undefined>();
  const depsById = new Map<string, string[]>();
  const dependentsById = new Map<string, string[]>();

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    orderIndex.set(t.externalId, i);
    titleById.set(t.externalId, t.title);
    depsById.set(t.externalId, []);
    dependentsById.set(t.externalId, []);
  }

  for (const t of tasks) {
    const seen = new Set<string>();
    const validDeps: string[] = [];
    const deps = Array.isArray(t.dependsOn) ? t.dependsOn : [];
    for (const dep of deps) {
      if (dep === t.externalId || !orderIndex.has(dep) || seen.has(dep)) continue;
      seen.add(dep);
      validDeps.push(dep);
      dependentsById.get(dep)!.push(t.externalId);
    }
    depsById.set(t.externalId, validDeps);
  }

  // Detect cycles & compute longest path ending at each node using memoized DFS.
  const visitState = new Map<string, 0 | 1 | 2>(); // 0=unvisited, 1=visiting, 2=done
  const bestChainTo = new Map<string, string[]>();
  let hasCycle = false;

  const computeChain = (id: string): string[] => {
    const cached = bestChainTo.get(id);
    if (cached) return cached;
    if (visitState.get(id) === 1) {
      hasCycle = true;
      return [id];
    }
    visitState.set(id, 1);
    let bestPrefix: string[] = [];
    for (const dep of depsById.get(id) ?? []) {
      const candidate = computeChain(dep);
      if (candidate.length > bestPrefix.length) {
        bestPrefix = candidate;
      } else if (candidate.length === bestPrefix.length && candidate.length > 0) {
        // Deterministic tie-break: prefer earlier task order in the plan.
        const candIdx = orderIndex.get(candidate[0]) ?? Number.MAX_SAFE_INTEGER;
        const bestIdx = orderIndex.get(bestPrefix[0]) ?? Number.MAX_SAFE_INTEGER;
        if (candIdx < bestIdx) bestPrefix = candidate;
      }
    }
    visitState.set(id, 2);
    const chain = [...bestPrefix, id];
    bestChainTo.set(id, chain);
    return chain;
  };

  let criticalPath: string[] = [];
  for (const t of tasks) {
    const chain = computeChain(t.externalId);
    if (chain.length > criticalPath.length) {
      criticalPath = chain;
    }
  }

  // Transitive dependents count for each task (how many tasks are held back by it).
  const bottlenecks: PlanBottleneckDTO[] = [];
  for (const t of tasks) {
    const visited = new Set<string>();
    const stack = [...(dependentsById.get(t.externalId) ?? [])];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (visited.has(cur) || cur === t.externalId) continue;
      visited.add(cur);
      for (const next of dependentsById.get(cur) ?? []) {
        if (!visited.has(next)) stack.push(next);
      }
    }
    if (visited.size > 0) {
      bottlenecks.push({
        externalId: t.externalId,
        title: titleById.get(t.externalId),
        blocksCount: visited.size,
        totalTasks,
      });
    }
  }

  bottlenecks.sort((a, b) => {
    if (b.blocksCount !== a.blocksCount) return b.blocksCount - a.blocksCount;
    return (orderIndex.get(a.externalId) ?? 0) - (orderIndex.get(b.externalId) ?? 0);
  });

  return {
    totalTasks,
    criticalPath,
    criticalPathLength: criticalPath.length,
    bottlenecks,
    hasCycle,
  };
}

/** Human-readable one-line summary for Room and Web approval views. */
export function formatPlanDependencySummary(analysis: PlanDependencyAnalysisDTO): string | null {
  if (analysis.totalTasks <= 1) return null;
  const parts: string[] = [];
  if (analysis.criticalPathLength > 1) {
    const chainStr =
      analysis.criticalPath.length <= 6
        ? analysis.criticalPath.join(' -> ')
        : `${analysis.criticalPath.slice(0, 3).join(' -> ')} -> ... -> ${analysis.criticalPath.at(-1)}`;
    parts.push(`Longest chain (${analysis.criticalPathLength}): ${chainStr}`);
  } else {
    parts.push(`All ${analysis.totalTasks} tasks can run in parallel (no dependency chain)`);
  }
  const top = analysis.bottlenecks[0];
  if (top) {
    parts.push(
      `Bottleneck: ${top.externalId} holds ${top.blocksCount} of ${top.totalTasks} tasks`,
    );
  }
  return parts.join(' · ');
}

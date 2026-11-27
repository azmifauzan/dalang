import { describe, expect, it } from 'vitest';
import {
  analyzePlanDependencies,
  formatPlanDependencySummary,
} from '@dalang/shared';

describe('Plan critical path and bottleneck analysis (PRD v0.15 P3)', () => {
  it('computes longest chain and transitive bottleneck counts on a diamond/fan-out DAG', () => {
    const analysis = analyzePlanDependencies([
      { externalId: 'T-001', title: 'Core runtime', dependsOn: [] },
      { externalId: 'T-002', title: 'Adapter A', dependsOn: ['T-001'] },
      { externalId: 'T-003', title: 'Adapter B', dependsOn: ['T-001'] },
      { externalId: 'T-004', title: 'Integration', dependsOn: ['T-002', 'T-003'] },
      { externalId: 'T-005', title: 'UI', dependsOn: ['T-004'] },
      { externalId: 'T-006', title: 'Independent doc', dependsOn: [] },
    ]);

    expect(analysis.hasCycle).toBe(false);
    expect(analysis.criticalPath).toEqual(['T-001', 'T-002', 'T-004', 'T-005']);
    expect(analysis.criticalPathLength).toBe(4);
    expect(analysis.bottlenecks[0]).toMatchObject({
      externalId: 'T-001',
      blocksCount: 4,
      totalTasks: 6,
    });

    const summary = formatPlanDependencySummary(analysis);
    expect(summary).toContain('Longest chain (4): T-001 -> T-002 -> T-004 -> T-005');
    expect(summary).toContain('Bottleneck: T-001 holds 4 of 6 tasks');
  });

  it('reports parallel readiness cleanly when all tasks are independent', () => {
    const analysis = analyzePlanDependencies([
      { externalId: 'T-001', dependsOn: [] },
      { externalId: 'T-002', dependsOn: [] },
      { externalId: 'T-003', dependsOn: [] },
    ]);
    expect(analysis.criticalPathLength).toBe(1);
    expect(analysis.bottlenecks).toEqual([]);
    expect(formatPlanDependencySummary(analysis)).toContain('All 3 tasks can run in parallel');
  });
});

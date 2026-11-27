import type { ReplayTranscript } from './replay-runner.js';

/**
 * Shared Room & Web Parity Scenarios (PRD v0.15 R5d).
 *
 * One scenario list and one replay transcript exercised by BOTH
 * `packages/server/src/__tests__/browser-replay.test.ts` (headless Chromium) and
 * `packages/cli/src/__tests__/room-replay.test.ts` (real PTY terminal room).
 */
export interface ParityScenarioDef {
  id: string;
  title: string;
  expectedReplyText?: string;
}

export const PARITY_SCENARIOS: readonly ParityScenarioDef[] = [
  {
    id: 'ask-chat-and-model',
    title: 'Ask chat turn with Lead reply',
    expectedReplyText: 'Parity greeting from Lead',
  },
  {
    id: 'structured-question-answer',
    title: 'Structured question choice answered back to Lead',
    expectedReplyText: 'Confirmed PostgreSQL storage engine',
  },
  {
    id: 'profile-advanced-settings',
    title: 'Edit advanced profile setting (parallel slots)',
  },
  {
    id: 'statistics-overview',
    title: 'Inspect usage statistics after recorded turns',
  },
  {
    id: 'triage-preview-and-start',
    title: 'Preview redacted diagnostics and start local Ask triage session',
    expectedReplyText: 'Triage summary ready with local diagnostics',
  },
] as const;

/**
 * Shared ReplayTranscript used identically by both the browser and PTY room
 * parity test suites.
 */
export function buildSharedParityTranscript(): ReplayTranscript {
  return {
    name: 'shared-room-web-parity',
    turns: [
      {
        id: 'parity-ask-greeting',
        match: { provider: 'claude-code', promptContains: 'PARITY_ASK_HELLO' },
        stdoutLines: [
          JSON.stringify({
            type: 'result',
            session_id: 'lead-parity-1',
            result: JSON.stringify({
              answer: 'Parity greeting from Lead: everything is connected.',
              suggested_mode: null,
            }),
            usage: { input_tokens: 200, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            total_cost_usd: 0.001,
          }),
        ],
        exitCode: 0,
      },
      {
        id: 'parity-structured-q-ask',
        match: { provider: 'claude-code', promptContains: 'PARITY_PICK_DB' },
        stdoutLines: [
          JSON.stringify({
            type: 'result',
            session_id: 'lead-parity-2',
            result: JSON.stringify({
              answer: 'Please pick the storage engine for this service.',
              suggested_mode: null,
              question: {
                header: 'Storage engine',
                question: 'Which database should we configure?',
                options: [
                  { label: 'PostgreSQL', description: 'Relational SQL with strong ACID guarantees' },
                  { label: 'SQLite', description: 'Single-file embedded database' },
                ],
                allowCustomAnswer: true,
                multiSelect: false,
              },
            }),
            usage: { input_tokens: 220, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            total_cost_usd: 0.0012,
          }),
        ],
        exitCode: 0,
      },
      {
        id: 'parity-structured-q-followup',
        match: { provider: 'claude-code', promptContains: 'PostgreSQL' },
        stdoutLines: [
          JSON.stringify({
            type: 'result',
            session_id: 'lead-parity-2',
            result: JSON.stringify({
              answer: 'Confirmed PostgreSQL storage engine for the service.',
              suggested_mode: null,
            }),
            usage: { input_tokens: 240, output_tokens: 55, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            total_cost_usd: 0.0011,
          }),
        ],
        exitCode: 0,
      },
      {
        id: 'parity-triage-turn',
        match: { provider: 'claude-code', promptContains: 'Local DALANG triage session' },
        stdoutLines: [
          JSON.stringify({
            type: 'result',
            session_id: 'lead-parity-triage',
            result: JSON.stringify({
              answer: 'Triage summary ready with local diagnostics. Ask before opening any issue.',
              suggested_mode: null,
            }),
            usage: { input_tokens: 300, output_tokens: 70, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            total_cost_usd: 0.0015,
          }),
        ],
        exitCode: 0,
      },
    ],
  };
}

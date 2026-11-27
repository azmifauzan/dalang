import { afterEach, describe, expect, it } from 'vitest';
import type { AskMessageContent } from '@dalang/shared';
import type { CliRunner, RunCommandResult } from '../adapters/types.js';
import { cleanupTempDirs, handleLeadCalls, setupApprovedProject } from './exec-helpers.js';

afterEach(cleanupTempDirs);

describe('structured Lead questions (U3, B12)', () => {
  it('stores structured questions, validates single/multi/custom answers, rejects duplicates and re-answers, and routes once to the Lead', async () => {
    let leadCalls = 0;
    const promptsSeen: string[] = [];
    const runner: CliRunner = {
      async which(bin) {
        return `/usr/bin/${bin}`;
      },
      async run(_cmd, args, opts): Promise<RunCommandResult> {
        const leadSetup = handleLeadCalls(opts.cwd, args, opts);
        if (leadSetup) return leadSetup;
        leadCalls += 1;
        promptsSeen.push(args.join(' '));
        if (leadCalls === 1) {
          const payload = {
            answer: 'Which storage backend should we use?',
            question: {
              id: 'q-storage',
              header: 'Storage choice',
              question: 'Pick one storage backend for local caching.',
              options: [
                { label: 'SQLite', description: 'Zero-config local database' },
                { label: 'JSON files', description: 'Plain text files on disk' },
              ],
              allowCustomAnswer: false,
              multiSelect: false,
            },
          };
          const line = JSON.stringify({ type: 'result', session_id: 'lead-s1', result: JSON.stringify(payload) });
          opts.onStdoutLine?.(line);
          return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
        }
        const reply = { answer: 'Great, using SQLite for local caching.' };
        const line = JSON.stringify({ type: 'result', session_id: 'lead-s1', result: JSON.stringify(reply) });
        opts.onStdoutLine?.(line);
        return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
      },
    };

    const { conn, project, leadSvc } = await setupApprovedProject(runner);
    try {
      const chatRes = await leadSvc.sendChatMessage(project.id, {
        mode: 'ask',
        message: 'Help me design local caching',
      });
      const sessionId = chatRes.session.id;

      // Question persists on reload until answered
      const detail = leadSvc.getSessionDetail(project.id, sessionId);
      const leadMsg = detail.messages.find((m) => m.role === 'lead' && m.type === 'ask')!;
      const askContent = leadMsg.content as AskMessageContent;
      expect(askContent.question).toMatchObject({
        id: 'q-storage',
        header: 'Storage choice',
        allowCustomAnswer: false,
        multiSelect: false,
        answered: false,
      });

      // Rejects invalid option
      await expect(
        leadSvc.answerStructuredQuestion(project.id, sessionId, {
          questionId: 'q-storage',
          selectedLabels: ['Redis'],
        }),
      ).rejects.toThrow(/Invalid option/);

      // Rejects multiple selections when multiSelect=false
      await expect(
        leadSvc.answerStructuredQuestion(project.id, sessionId, {
          questionId: 'q-storage',
          selectedLabels: ['SQLite', 'JSON files'],
        }),
      ).rejects.toThrow(/Only one option/);

      // Rejects duplicate selection
      await expect(
        leadSvc.answerStructuredQuestion(project.id, sessionId, {
          questionId: 'q-storage',
          selectedLabels: ['SQLite', 'SQLite'],
        }),
      ).rejects.toThrow(/Duplicate option/);

      // Rejects custom answer when allowCustomAnswer=false
      await expect(
        leadSvc.answerStructuredQuestion(project.id, sessionId, {
          questionId: 'q-storage',
          selectedLabels: [],
          customAnswer: 'Postgres',
        }),
      ).rejects.toThrow(/Custom answers are not allowed/);

      // Valid answer succeeds and feeds back to Lead once
      const answered = await leadSvc.answerStructuredQuestion(project.id, sessionId, {
        questionId: 'q-storage',
        selectedLabels: ['SQLite'],
      });
      expect(answered.answerText).toContain('SQLite');
      expect(leadCalls).toBe(2);
      expect(promptsSeen[1]).toContain('SQLite');

      // Re-answering the closed question returns 409
      await expect(
        leadSvc.answerStructuredQuestion(project.id, sessionId, {
          questionId: 'q-storage',
          selectedLabels: ['JSON files'],
        }),
      ).rejects.toThrow(/already been answered/);
    } finally {
      conn.close();
    }
  });
});

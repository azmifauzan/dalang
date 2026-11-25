import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AgentProfileDTO,
  AutomationDTO,
  AutomationKind,
  CreatedMcpTokenDTO,
  McpAccessLevel,
  ProjectSummary,
  TaskOutputKind,
} from '@dalang/shared';
import { useI18n, type TranslationKey } from '../../i18n/index.js';
import { api } from '../../lib/api.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';

function AutomationRunsList({ automationId }: { automationId: string }) {
  const { t, formatDateTime } = useI18n();
  const runsQuery = useQuery({
    queryKey: ['automation-runs', automationId],
    queryFn: () => api.listAutomationRuns(automationId, 15),
  });

  const runs = runsQuery.data?.runs ?? [];
  if (runsQuery.isLoading) {
    return (
      <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
        ...
      </p>
    );
  }
  if (runs.length === 0) {
    return (
      <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
        {t('config.automation.runsEmpty')}
      </p>
    );
  }
  return (
    <div className="space-y-1.5 pt-2">
      {runs.map((run) => (
        <div
          key={run.id}
          className="flex flex-wrap items-center justify-between gap-2 rounded-[4px] border px-2.5 py-1.5 text-xs"
          style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-well)' }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{t(`enum.${run.status}` as TranslationKey)}</Badge>
            <code className="font-mono-token">{run.triggerSource}</code>
            <span>{formatDateTime(run.triggeredAt)}</span>
          </div>
          {run.detail && (
            <span className="max-w-md truncate font-mono-token" style={{ color: 'var(--text-secondary)' }}>
              {run.detail}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export function AutomationTab({
  projects,
  profiles,
}: {
  projects: ProjectSummary[];
  profiles: AgentProfileDTO[];
}) {
  const { t, formatDateTime } = useI18n();
  const qc = useQueryClient();

  const automationsQuery = useQuery({
    queryKey: ['automations'],
    queryFn: () => api.listAutomations(),
  });
  const tokensQuery = useQuery({
    queryKey: ['mcp-tokens'],
    queryFn: () => api.listMcpTokens(),
  });

  const [showNewForm, setShowNewForm] = useState(false);
  const [expandedRunsId, setExpandedRunsId] = useState<string | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<{ name: string; secret: string; url: string | null } | null>(
    null,
  );
  const [revealedToken, setRevealedToken] = useState<CreatedMcpTokenDTO | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Automation form state
  const [projectId, setProjectId] = useState<string>(() => projects[0]?.id ?? '');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<AutomationKind>('schedule');
  const [cronExpr, setCronExpr] = useState('0 2 * * *');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [output, setOutput] = useState<TaskOutputKind>('files');
  const [verify, setVerify] = useState('');
  const [criteriaText, setCriteriaText] = useState('');
  const [filesAllowedText, setFilesAllowedText] = useState('');
  const [profileOverride, setProfileOverride] = useState('');
  const [autoMerge, setAutoMerge] = useState(false);
  const [allowUnconfined, setAllowUnconfined] = useState(false);

  // MCP token form state
  const [tokenName, setTokenName] = useState('');
  const [accessLevel, setAccessLevel] = useState<McpAccessLevel>('read-only');
  const [tokenProjectId, setTokenProjectId] = useState<string>('');

  const copyText = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1800);
    } catch {
      // Clipboard optional in non-secure contexts
    }
  };

  const createAutomationMutation = useMutation({
    mutationFn: api.createAutomation,
    onSuccess: ({ automation }) => {
      qc.invalidateQueries({ queryKey: ['automations'] });
      setShowNewForm(false);
      setName('');
      setTitle('');
      setPrompt('');
      setCriteriaText('');
      setFilesAllowedText('');
      setProfileOverride('');
      setAutoMerge(false);
      setAllowUnconfined(false);
      if (automation.webhookSecret) {
        setRevealedSecret({
          name: automation.name,
          secret: automation.webhookSecret,
          url: automation.webhookUrl,
        });
      }
    },
  });

  const toggleAutomationMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.updateAutomation(id, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automations'] }),
  });

  const deleteAutomationMutation = useMutation({
    mutationFn: (id: string) => api.deleteAutomation(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automations'] }),
  });

  const triggerAutomationMutation = useMutation({
    mutationFn: (id: string) => api.triggerAutomation(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['automations'] });
      qc.invalidateQueries({ queryKey: ['automation-runs', id] });
    },
  });

  const rotateSecretMutation = useMutation({
    mutationFn: (id: string) => api.rotateWebhookSecret(id),
    onSuccess: ({ automation }) => {
      qc.invalidateQueries({ queryKey: ['automations'] });
      if (automation.webhookSecret) {
        setRevealedSecret({
          name: automation.name,
          secret: automation.webhookSecret,
          url: automation.webhookUrl,
        });
      }
    },
  });

  const createTokenMutation = useMutation({
    mutationFn: api.createMcpToken,
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['mcp-tokens'] });
      setTokenName('');
      setTokenProjectId('');
      setRevealedToken(created);
    },
  });

  const revokeTokenMutation = useMutation({
    mutationFn: (id: string) => api.revokeMcpToken(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mcp-tokens'] }),
  });

  const deleteTokenMutation = useMutation({
    mutationFn: (id: string) => api.deleteMcpToken(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mcp-tokens'] }),
  });

  const rowActionError = [
    toggleAutomationMutation,
    deleteAutomationMutation,
    triggerAutomationMutation,
    rotateSecretMutation,
  ].find((m) => m.isError)?.error;
  const tokenActionError = [revokeTokenMutation, deleteTokenMutation].find((m) => m.isError)?.error;

  const automations: AutomationDTO[] = automationsQuery.data?.automations ?? [];
  const tokens = tokensQuery.data?.tokens ?? [];
  const endpointUrl =
    tokensQuery.data?.endpointUrl ??
    (typeof window !== 'undefined' ? `${window.location.origin}/mcp` : 'http://127.0.0.1:4173/mcp');

  const resolvedProjectId = projectId || projects[0]?.id || '';

  const handleCreateAutomation = (e: React.FormEvent) => {
    e.preventDefault();
    if (!resolvedProjectId || createAutomationMutation.isPending) return;
    const criteria = criteriaText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const filesAllowed = filesAllowedText
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean);
    const trimmedVerify = verify.trim();
    createAutomationMutation.mutate({
      projectId: resolvedProjectId,
      name: name.trim(),
      kind,
      enabled: true,
      cronExpr: kind === 'schedule' ? cronExpr.trim() : null,
      title: title.trim(),
      prompt: prompt.trim(),
      role: 'engineer',
      complexity: 'low',
      output,
      filesAllowed: output === 'answer' ? [] : filesAllowed,
      filesReference: [],
      acceptanceCriteria:
        criteria.length > 0
          ? criteria
          : [trimmedVerify ? 'Verify command passes' : 'Goal and acceptance criteria are met'],
      verify: trimmedVerify || null,
      profileOverride: profileOverride || null,
      allowUnconfined,
      autoMerge,
    });
  };

  const handleCreateToken = (e: React.FormEvent) => {
    e.preventDefault();
    if (!tokenName.trim() || createTokenMutation.isPending) return;
    createTokenMutation.mutate({
      name: tokenName.trim(),
      accessLevel,
      projectId: tokenProjectId || null,
    });
  };

  const claudeSnippet = revealedToken
    ? `claude mcp add --transport http dalang ${revealedToken.endpointUrl ?? endpointUrl} --header "Authorization: Bearer ${revealedToken.token}"`
    : '';
  const codexSnippet = revealedToken
    ? `[mcp_servers.dalang]\nurl = "${revealedToken.endpointUrl ?? endpointUrl}"\nhttp_headers = { Authorization = "Bearer ${revealedToken.token}" }\n# start_task waits for coding and review; Codex stops a tool call after 60 s by default.\ntool_timeout_sec = 3600`
    : '';

  return (
    <section className="space-y-6">
      <header className="border-b pb-4" style={{ borderColor: 'var(--border-subtle)' }}>
        <h1 className="text-2xl font-semibold tracking-tight">{t('config.automation.title')}</h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
          {t('config.automation.subtitle')}
        </p>
      </header>

      {/* Card 1: Schedules & Webhooks */}
      <div
        className="space-y-4 rounded-[8px] border p-5"
        style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">{t('config.automation.triggersTitle')}</h2>
            <p className="mt-0.5 max-w-2xl text-sm" style={{ color: 'var(--text-secondary)' }}>
              {t('config.automation.triggersDesc')}
            </p>
          </div>
          <Button
            type="button"
            disabled={projects.length === 0}
            onClick={() => setShowNewForm((prev) => !prev)}
          >
            {showNewForm ? t('common.cancel') : `+ ${t('config.automation.newButton')}`}
          </Button>
        </div>

        {projects.length === 0 && (
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {t('config.automation.noProjectsHint')}
          </p>
        )}

        {revealedSecret && (
          <div
            role="status"
            className="space-y-2 rounded-[6px] border p-3.5"
            style={{
              backgroundColor: 'var(--accent-tint)',
              borderColor: 'var(--accent)',
            }}
          >
            <div className="flex items-center justify-between gap-2">
              <strong className="text-sm font-semibold">
                {t('config.automation.secretBannerTitle')} ({revealedSecret.name})
              </strong>
              <Button type="button" variant="outline" onClick={() => setRevealedSecret(null)}>
                {t('common.close')}
              </Button>
            </div>
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              {t('config.automation.secretBannerDesc')}
            </p>
            <div
              className="flex flex-wrap items-center justify-between gap-2 rounded-[4px] border px-3 py-2"
              style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-surface)' }}
            >
              <code className="min-w-0 flex-1 break-all font-mono-token text-xs">{revealedSecret.secret}</code>
              <Button
                type="button"
                variant="outline"
                onClick={() => copyText('webhook-secret', revealedSecret.secret)}
              >
                {copiedKey === 'webhook-secret' ? t('common.copied') : t('common.copy')}
              </Button>
            </div>
          </div>
        )}

        {showNewForm && projects.length > 0 && (
          <form
            onSubmit={handleCreateAutomation}
            className="space-y-3 rounded-[6px] border p-4"
            style={{ borderColor: 'var(--border-control)', backgroundColor: 'var(--bg-well)' }}
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="auto-project">{t('config.automation.fieldProject')}</Label>
                <NativeSelect
                  id="auto-project"
                  value={resolvedProjectId}
                  onChange={(e) => setProjectId(e.target.value)}
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="auto-name">{t('config.automation.fieldName')}</Label>
                <Input
                  id="auto-name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('config.automation.fieldNamePlaceholder')}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="auto-kind">{t('config.automation.fieldKind')}</Label>
                <NativeSelect
                  id="auto-kind"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as AutomationKind)}
                >
                  <option value="schedule">{t('config.automation.kindSchedule')}</option>
                  <option value="webhook">{t('config.automation.kindWebhook')}</option>
                </NativeSelect>
              </div>
            </div>

            {kind === 'schedule' && (
              <div className="space-y-1.5">
                <Label htmlFor="auto-cron">{t('config.automation.fieldCron')}</Label>
                <Input
                  id="auto-cron"
                  required
                  value={cronExpr}
                  onChange={(e) => setCronExpr(e.target.value)}
                  placeholder={t('config.automation.fieldCronPlaceholder')}
                  className="font-mono-token"
                />
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="auto-title">{t('config.automation.fieldTitle')}</Label>
                <Input
                  id="auto-title"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t('config.automation.fieldTitlePlaceholder')}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="auto-output">{t('config.automation.fieldOutput')}</Label>
                <NativeSelect
                  id="auto-output"
                  value={output}
                  onChange={(e) => setOutput(e.target.value as TaskOutputKind)}
                >
                  <option value="files">{t('plan.output.files')}</option>
                  <option value="answer">{t('plan.output.answer')}</option>
                </NativeSelect>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="auto-verify">{t('config.automation.fieldVerify')}</Label>
                <Input
                  id="auto-verify"
                  value={verify}
                  onChange={(e) => setVerify(e.target.value)}
                  placeholder={t('config.automation.fieldVerifyPlaceholder')}
                  className="font-mono-token"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="auto-prompt">{t('config.automation.fieldPrompt')}</Label>
              <Textarea
                id="auto-prompt"
                required
                rows={3}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={t('config.automation.fieldPromptPlaceholder')}
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="auto-criteria">{t('config.automation.fieldCriteria')}</Label>
                <Textarea
                  id="auto-criteria"
                  rows={2}
                  value={criteriaText}
                  onChange={(e) => setCriteriaText(e.target.value)}
                  placeholder={t('config.automation.fieldCriteriaPlaceholder')}
                />
              </div>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="auto-files">{t('config.automation.fieldFilesAllowed')}</Label>
                  <Input
                    id="auto-files"
                    value={filesAllowedText}
                    onChange={(e) => setFilesAllowedText(e.target.value)}
                    placeholder={t('config.automation.fieldFilesAllowedPlaceholder')}
                    className="font-mono-token"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="auto-profile">{t('config.automation.fieldProfile')}</Label>
                  <NativeSelect
                    id="auto-profile"
                    value={profileOverride}
                    onChange={(e) => setProfileOverride(e.target.value)}
                  >
                    <option value="">{t('config.automation.fieldProfileDefault')}</option>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.provider})
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              </div>
            </div>

            <div className="space-y-1.5 pt-1">
              <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--primary)]"
                  checked={autoMerge}
                  onChange={(e) => setAutoMerge(e.target.checked)}
                />
                <span>{t('config.automation.fieldAutoMerge')}</span>
              </label>
              <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--primary)]"
                  checked={allowUnconfined}
                  onChange={(e) => setAllowUnconfined(e.target.checked)}
                />
                <span>{t('config.automation.fieldAllowUnconfined')}</span>
              </label>
            </div>

            {createAutomationMutation.isError && (
              <p role="alert" className="text-sm" style={{ color: 'var(--error)' }}>
                {createAutomationMutation.error.message}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setShowNewForm(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={createAutomationMutation.isPending}>
                {createAutomationMutation.isPending
                  ? t('config.automation.creating')
                  : t('config.automation.createSubmit')}
              </Button>
            </div>
          </form>
        )}

        {rowActionError && (
          <p role="alert" className="text-sm" style={{ color: 'var(--error)' }}>
            {rowActionError.message}
          </p>
        )}

        {automations.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {t('config.automation.emptyList')}
          </p>
        ) : (
          <div className="space-y-3">
            {automations.map((item) => (
              <div
                key={item.id}
                className="space-y-2.5 rounded-[6px] border p-3.5"
                style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-canvas)' }}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">{item.name}</span>
                      <Badge>
                        {item.kind === 'schedule'
                          ? t('config.automation.kindSchedule')
                          : t('config.automation.kindWebhook')}
                      </Badge>
                      {item.output === 'answer' && <Badge>{t('enum.answer')}</Badge>}
                      <Badge
                        style={{
                          color: item.enabled ? 'var(--pass)' : 'var(--text-secondary)',
                          borderColor: item.enabled ? 'var(--pass)' : 'var(--border-subtle)',
                          backgroundColor: item.enabled ? 'var(--pass-tint)' : 'var(--bg-well)',
                        }}
                      >
                        {item.enabled
                          ? t('config.automation.enabledBadge')
                          : t('config.automation.pausedBadge')}
                      </Badge>
                      <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {item.projectName}
                      </span>
                    </div>
                    <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                      {item.title} ·{' '}
                      {item.verify ? (
                        <code className="font-mono-token">{item.verify}</code>
                      ) : (
                        <span>{t('plan.verifySkipped')}</span>
                      )}
                    </p>
                    {item.kind === 'schedule' && item.cronExpr && (
                      <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                        <code className="font-mono-token">{item.cronExpr}</code>
                        {item.nextRunAt && (
                          <>
                            {' · '}
                            {t('config.automation.nextRunLabel')} {formatDateTime(item.nextRunAt)}
                          </>
                        )}
                      </p>
                    )}
                    {item.kind === 'webhook' && item.webhookUrl && (
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span style={{ color: 'var(--text-secondary)' }}>
                          {t('config.automation.webhookUrlLabel')}:
                        </span>
                        <code className="break-all font-mono-token">{item.webhookUrl}</code>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => copyText(`url-${item.id}`, item.webhookUrl!)}
                        >
                          {copiedKey === `url-${item.id}` ? t('common.copied') : t('common.copy')}
                        </Button>
                      </div>
                    )}
                    {item.lastStatus && (
                      <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {t('config.automation.lastRunLabel')} {t(`enum.${item.lastStatus}` as TranslationKey)}
                        {item.lastTriggeredAt ? ` (${formatDateTime(item.lastTriggeredAt)})` : ''}
                        {item.lastError ? `: ${item.lastError}` : ''}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={triggerAutomationMutation.isPending}
                      onClick={() => triggerAutomationMutation.mutate(item.id)}
                    >
                      {t('config.automation.triggerNow')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        toggleAutomationMutation.mutate({ id: item.id, enabled: !item.enabled })
                      }
                    >
                      {item.enabled ? t('config.automation.pause') : t('config.automation.enable')}
                    </Button>
                    {item.kind === 'webhook' && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => rotateSecretMutation.mutate(item.id)}
                      >
                        {t('config.automation.rotateSecret')}
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        setExpandedRunsId((prev) => (prev === item.id ? null : item.id))
                      }
                    >
                      {t('config.automation.runsButton')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => deleteAutomationMutation.mutate(item.id)}
                    >
                      {t('common.delete')}
                    </Button>
                  </div>
                </div>

                {expandedRunsId === item.id && <AutomationRunsList automationId={item.id} />}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Card 2: Outside Agents over MCP */}
      <div
        className="space-y-4 rounded-[8px] border p-5"
        style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
      >
        <div>
          <h2 className="text-base font-semibold">{t('config.automation.mcpTitle')}</h2>
          <p className="mt-0.5 max-w-2xl text-sm" style={{ color: 'var(--text-secondary)' }}>
            {t('config.automation.mcpDesc')}
          </p>
        </div>

        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-[6px] border px-3 py-2"
          style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-well)' }}
        >
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
              {t('config.automation.mcpEndpointLabel')}
            </div>
            <code className="block break-all font-mono-token text-xs">{endpointUrl}</code>
          </div>
          <Button type="button" variant="outline" onClick={() => copyText('mcp-endpoint', endpointUrl)}>
            {copiedKey === 'mcp-endpoint' ? t('common.copied') : t('common.copy')}
          </Button>
        </div>

        {revealedToken && (
          <div
            role="status"
            className="space-y-3 rounded-[6px] border p-4"
            style={{ backgroundColor: 'var(--accent-tint)', borderColor: 'var(--accent)' }}
          >
            <div className="flex items-center justify-between gap-2">
              <strong className="text-sm font-semibold">
                {t('config.automation.mcpTokenBannerTitle')} ({revealedToken.tokenInfo.name})
              </strong>
              <Button type="button" variant="outline" onClick={() => setRevealedToken(null)}>
                {t('common.close')}
              </Button>
            </div>
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              {t('config.automation.mcpTokenBannerDesc')}
            </p>

            <div
              className="flex flex-wrap items-center justify-between gap-2 rounded-[4px] border px-3 py-2"
              style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-surface)' }}
            >
              <code className="min-w-0 flex-1 break-all font-mono-token text-xs">{revealedToken.token}</code>
              <Button
                type="button"
                variant="outline"
                onClick={() => copyText('mcp-raw-token', revealedToken.token)}
              >
                {copiedKey === 'mcp-raw-token' ? t('common.copied') : t('common.copy')}
              </Button>
            </div>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2 text-xs font-medium">
                  <span>{t('config.automation.mcpClaudeSnippet')}</span>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => copyText('mcp-claude', claudeSnippet)}
                  >
                    {copiedKey === 'mcp-claude' ? t('common.copied') : t('common.copy')}
                  </Button>
                </div>
                <pre
                  className="overflow-x-auto rounded-[4px] border p-2.5 font-mono-token text-xs"
                  style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-surface)' }}
                >
                  <code>{claudeSnippet}</code>
                </pre>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2 text-xs font-medium">
                  <span>{t('config.automation.mcpCodexSnippet')}</span>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => copyText('mcp-codex', codexSnippet)}
                  >
                    {copiedKey === 'mcp-codex' ? t('common.copied') : t('common.copy')}
                  </Button>
                </div>
                <pre
                  className="overflow-x-auto rounded-[4px] border p-2.5 font-mono-token text-xs"
                  style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-surface)' }}
                >
                  <code>{codexSnippet}</code>
                </pre>
              </div>
            </div>
          </div>
        )}

        <form
          onSubmit={handleCreateToken}
          className="grid grid-cols-1 gap-3 rounded-[6px] border p-4 sm:grid-cols-4 sm:items-start"
          style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-well)' }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="mcp-token-name">{t('config.automation.mcpTokenName')}</Label>
            <Input
              id="mcp-token-name"
              required
              value={tokenName}
              onChange={(e) => setTokenName(e.target.value)}
              placeholder={t('config.automation.mcpTokenNamePlaceholder')}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mcp-token-access">{t('config.automation.mcpAccessLabel')}</Label>
            <NativeSelect
              id="mcp-token-access"
              value={accessLevel}
              onChange={(e) => setAccessLevel(e.target.value as McpAccessLevel)}
            >
              <option value="read-only">{t('config.automation.mcpAccessReadOnly')}</option>
              <option value="full-access">{t('config.automation.mcpAccessFull')}</option>
            </NativeSelect>
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              {accessLevel === 'full-access'
                ? t('config.automation.mcpAccessFullHint')
                : t('config.automation.mcpAccessReadOnlyHint')}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mcp-token-scope">{t('config.automation.mcpScopeLabel')}</Label>
            <NativeSelect
              id="mcp-token-scope"
              value={tokenProjectId}
              onChange={(e) => setTokenProjectId(e.target.value)}
            >
              <option value="">{t('config.automation.mcpScopeAll')}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="sm:pt-6">
            <Button type="submit" className="w-full" disabled={createTokenMutation.isPending}>
              {createTokenMutation.isPending
                ? t('config.automation.mcpCreatingToken')
                : t('config.automation.mcpCreateToken')}
            </Button>
          </div>
        </form>

        {(createTokenMutation.error ?? tokenActionError) && (
          <p role="alert" className="text-sm" style={{ color: 'var(--error)' }}>
            {(createTokenMutation.error ?? tokenActionError)!.message}
          </p>
        )}

        {tokens.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {t('config.automation.mcpEmptyTokens')}
          </p>
        ) : (
          <div className="space-y-2">
            {tokens.map((tok) => (
              <div
                key={tok.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-[6px] border px-3.5 py-2.5"
                style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-canvas)' }}
              >
                <div className="space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{tok.name}</span>
                    <Badge>
                      {tok.accessLevel === 'full-access' ? t('enum.full-access') : t('enum.read-only')}
                    </Badge>
                    <Badge
                      style={{
                        color: tok.revokedAt ? 'var(--error)' : 'var(--pass)',
                        borderColor: tok.revokedAt ? 'var(--error)' : 'var(--pass)',
                        backgroundColor: tok.revokedAt ? 'var(--error-tint)' : 'var(--pass-tint)',
                      }}
                    >
                      {tok.revokedAt
                        ? t('config.automation.mcpRevokedBadge')
                        : t('config.automation.mcpActiveBadge')}
                    </Badge>
                    <code className="font-mono-token text-xs">{tok.tokenPrefix}…</code>
                  </div>
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {tok.projectName ?? t('config.automation.mcpScopeAll')}
                    {' · '}
                    {tok.lastUsedAt
                      ? t('config.automation.mcpLastUsed', { time: formatDateTime(tok.lastUsedAt) })
                      : t('config.automation.mcpNeverUsed')}
                  </p>
                </div>
                <div className="flex gap-2">
                  {!tok.revokedAt && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => revokeTokenMutation.mutate(tok.id)}
                    >
                      {t('config.automation.mcpRevoke')}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => deleteTokenMutation.mutate(tok.id)}
                  >
                    {t('common.delete')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

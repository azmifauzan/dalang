import crypto from 'node:crypto';
import {
  DALANG_VERSION,
  DelegateTaskInputSchema,
  TaskCancelInputSchema,
  TaskStatusInputSchema,
  type DelegateTaskInput,
  type DelegatedSubtaskStatusDTO,
  type TaskCancelInput,
  type TaskStatusInput,
} from '@dalang/shared';
import { formatZodError } from './contract.js';

export interface DelegationTokenScope {
  token: string;
  runId: string;
  projectId: string;
  sessionId: string;
  taskId: string;
  externalId: string;
  branchName: string;
  worktreePath: string;
  baseMainSha: string;
  delegationDepth: number;
  filesAllowed: string[];
  verify: string | null;
  parentAccountKey: string;
  sandboxReady: boolean;
  createdAt: number;
  keepParentAlive?: () => void;
  yieldParentSlot?: () => Promise<() => Promise<void>>;
}

export class DelegationSessionStore {
  private readonly scopes = new Map<string, DelegationTokenScope>();

  issue(scope: Omit<DelegationTokenScope, 'token' | 'createdAt'>): DelegationTokenScope {
    const token = crypto.randomBytes(32).toString('hex');
    const entry: DelegationTokenScope = {
      ...scope,
      token,
      createdAt: Date.now(),
    };
    this.scopes.set(token, entry);
    return entry;
  }

  authenticate(authorizationHeader: string | undefined): DelegationTokenScope | null {
    if (!authorizationHeader) return null;
    const match = authorizationHeader.trim().match(/^Bearer\s+(\S+)$/i);
    if (!match) return null;
    const candidate = Buffer.from(match[1], 'utf8');
    let matched: DelegationTokenScope | null = null;
    for (const [storedToken, scope] of this.scopes.entries()) {
      const expected = Buffer.from(storedToken, 'utf8');
      if (candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected)) {
        matched = scope;
      }
    }
    return matched;
  }

  revoke(token: string): void {
    this.scopes.delete(token);
  }

  revokeByRunId(runId: string): void {
    for (const [token, scope] of this.scopes.entries()) {
      if (scope.runId === runId) {
        this.scopes.delete(token);
      }
    }
  }

  activeCount(): number {
    return this.scopes.size;
  }
}

export interface McpDelegationHandler {
  delegateTask(scope: DelegationTokenScope, input: DelegateTaskInput): Promise<DelegatedSubtaskStatusDTO>;
  getTaskStatus(scope: DelegationTokenScope, input: TaskStatusInput): Promise<DelegatedSubtaskStatusDTO>;
  cancelTask(scope: DelegationTokenScope, input: TaskCancelInput): Promise<DelegatedSubtaskStatusDTO>;
}

export interface McpHttpRequest {
  method: string;
  authorizationHeader?: string;
  body?: unknown;
}

export interface McpHttpResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body?: unknown;
}

const DEFAULT_PROTOCOL_VERSION = '2025-03-26';

export const MCP_TOOL_DEFINITIONS = [
  {
    name: 'delegate_task',
    description:
      'Delegate an independent subtask to another DALANG agent profile or provider. The subtask runs in its own git worktree branched from your task branch, runs verify and automated review, and merges back into your task branch on pass. Subtasks cannot delegate further (depth 1).',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Optional short title for the subtask.',
        },
        prompt: {
          type: 'string',
          description: 'Detailed goal and instructions for the delegated subtask.',
        },
        profile: {
          type: 'string',
          description: 'Optional DALANG agent profile name or id (e.g. coder-small, coder-medium, coder-heavy).',
        },
        provider: {
          type: 'string',
          enum: ['claude-code', 'codex', 'antigravity'],
          description: 'Optional CLI provider to run the subtask on.',
        },
        model: {
          type: 'string',
          description: 'Optional model override for the subtask.',
        },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'xhigh', 'max'],
          description: 'Optional reasoning effort override.',
        },
        files_allowed: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional glob patterns the subtask is allowed to modify. Must be a subset of the parent task files_allowed. Inherits parent files_allowed when omitted.',
        },
        acceptance_criteria: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional verifiable acceptance criteria checked by the subtask reviewer.',
        },
        verify: {
          type: 'string',
          description: 'Optional verify shell command for the subtask. Inherits parent verify command when omitted.',
        },
        mode: {
          type: 'string',
          enum: ['wait', 'async'],
          default: 'wait',
          description:
            'wait (default): block until the subtask finishes review and merges into your branch. async: start the subtask in the background and return its task_id immediately.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'task_status',
    description: 'Check the current status, review result, and summary of a subtask you delegated.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Subtask id or external_id returned by delegate_task.',
        },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'task_cancel',
    description: 'Cancel a running delegated subtask and clean up its unmerged worktree and branch.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Subtask id or external_id returned by delegate_task.',
        },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
] as const;

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

function jsonRpcResult(id: string | number | null, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleSingleRpc(
  scope: DelegationTokenScope,
  handler: McpDelegationHandler,
  raw: unknown,
): Promise<unknown | null> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return jsonRpcError(null, -32600, 'Invalid Request');
  }
  const req = raw as JsonRpcRequest;
  const hasId = Object.prototype.hasOwnProperty.call(req, 'id') && req.id !== undefined;
  const id = hasId ? (req.id as string | number | null) : null;

  if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return jsonRpcError(id, -32600, 'Invalid JSON-RPC 2.0 request');
  }

  // Notifications have no id and receive no JSON-RPC response body.
  if (!hasId) {
    return null;
  }

  if (req.method === 'initialize') {
    const params = req.params && typeof req.params === 'object' ? (req.params as Record<string, unknown>) : {};
    const clientVersion =
      typeof params.protocolVersion === 'string' && params.protocolVersion.trim()
        ? params.protocolVersion.trim()
        : DEFAULT_PROTOCOL_VERSION;
    return jsonRpcResult(id, {
      protocolVersion: clientVersion,
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: 'dalang',
        version: DALANG_VERSION,
      },
    });
  }

  if (req.method === 'ping') {
    return jsonRpcResult(id, {});
  }

  if (req.method === 'tools/list') {
    return jsonRpcResult(id, {
      tools: MCP_TOOL_DEFINITIONS,
    });
  }

  if (req.method === 'tools/call') {
    const params = req.params && typeof req.params === 'object' ? (req.params as Record<string, unknown>) : null;
    const toolName = typeof params?.name === 'string' ? params.name : '';
    const toolArgs = params?.arguments ?? {};

    try {
      if (toolName === 'delegate_task') {
        const parsed = DelegateTaskInputSchema.safeParse(toolArgs);
        if (!parsed.success) {
          return jsonRpcResult(id, {
            content: [{ type: 'text', text: `Invalid delegate_task arguments: ${formatZodError(parsed.error)}` }],
            isError: true,
          });
        }
        const status = await handler.delegateTask(scope, parsed.data);
        return jsonRpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
          isError: status.status === 'failed' || status.status === 'review_failed',
        });
      }

      if (toolName === 'task_status') {
        const parsed = TaskStatusInputSchema.safeParse(toolArgs);
        if (!parsed.success) {
          return jsonRpcResult(id, {
            content: [{ type: 'text', text: `Invalid task_status arguments: ${formatZodError(parsed.error)}` }],
            isError: true,
          });
        }
        const status = await handler.getTaskStatus(scope, parsed.data);
        return jsonRpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
          isError: false,
        });
      }

      if (toolName === 'task_cancel') {
        const parsed = TaskCancelInputSchema.safeParse(toolArgs);
        if (!parsed.success) {
          return jsonRpcResult(id, {
            content: [{ type: 'text', text: `Invalid task_cancel arguments: ${formatZodError(parsed.error)}` }],
            isError: true,
          });
        }
        const status = await handler.cancelTask(scope, parsed.data);
        return jsonRpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
          isError: false,
        });
      }

      return jsonRpcError(id, -32601, `Unknown MCP tool: ${toolName}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonRpcResult(id, {
        content: [{ type: 'text', text: message }],
        isError: true,
      });
    }
  }

  return jsonRpcError(id, -32601, `Method not found: ${req.method}`);
}

export async function handleMcpHttpRequest(
  store: DelegationSessionStore,
  handler: McpDelegationHandler,
  req: McpHttpRequest,
): Promise<McpHttpResponse> {
  const scope = store.authenticate(req.authorizationHeader);
  if (!scope) {
    return {
      statusCode: 401,
      headers: { 'Cache-Control': 'no-store' },
      body: jsonRpcError(null, -32001, 'Unauthorized: missing, invalid, or expired delegation bearer token.'),
    };
  }

  const method = req.method.toUpperCase();
  if (method === 'DELETE') {
    return {
      statusCode: 204,
      headers: { 'Cache-Control': 'no-store' },
    };
  }
  if (method === 'GET') {
    return {
      statusCode: 405,
      headers: { Allow: 'POST, DELETE', 'Cache-Control': 'no-store' },
      body: jsonRpcError(null, -32600, 'Use POST for MCP JSON-RPC requests.'),
    };
  }
  if (method !== 'POST') {
    return {
      statusCode: 405,
      headers: { Allow: 'POST, DELETE', 'Cache-Control': 'no-store' },
      body: jsonRpcError(null, -32600, `Unsupported HTTP method: ${method}`),
    };
  }

  if (Array.isArray(req.body)) {
    if (req.body.length === 0) {
      return {
        statusCode: 400,
        headers: { 'Cache-Control': 'no-store' },
        body: jsonRpcError(null, -32600, 'Invalid empty JSON-RPC batch'),
      };
    }
    const responses = (
      await Promise.all(req.body.map((item) => handleSingleRpc(scope, handler, item)))
    ).filter((res) => res !== null);
    if (responses.length === 0) {
      return { statusCode: 202, headers: { 'Cache-Control': 'no-store' } };
    }
    return {
      statusCode: 200,
      headers: { 'Cache-Control': 'no-store' },
      body: responses,
    };
  }

  const response = await handleSingleRpc(scope, handler, req.body);
  if (response === null) {
    return { statusCode: 202, headers: { 'Cache-Control': 'no-store' } };
  }
  return {
    statusCode: 200,
    headers: { 'Cache-Control': 'no-store' },
    body: response,
  };
}

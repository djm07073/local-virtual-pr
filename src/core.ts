export type ChangeKind = 'A' | 'M' | 'D' | 'R';

export interface FileChange {
  kind: ChangeKind;
  path: string;
  previousPath?: string;
}

export interface HeadRange {
  start: number;
  end: number;
}

export type ReviewCommentStatus = 'open' | 'resolved' | 'outdated';

export interface ReviewReply {
  id: string;
  author: 'reviewer' | 'codex';
  message: string;
  createdAt: string;
  updatedAt?: string;
  pending?: boolean;
}

export interface ReviewComment {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  selectedCode: string;
  contextBefore: string[];
  contextAfter: string[];
  message: string;
  status: ReviewCommentStatus;
  replies?: ReviewReply[];
  updatedAt?: string;
}

export interface ReviewMessageTarget {
  commentId: string;
  replyId?: string;
}

export interface RelocatedAnchor {
  startLine: number;
  endLine: number;
}

export interface CodexReviewResponse {
  summary: string;
  comments: Array<{ commentId: string; reply: string }>;
}

export interface CodexReasoningEffort {
  reasoningEffort: string;
  description?: string;
}

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts: CodexReasoningEffort[];
  isDefault: boolean;
}

export interface CodexTurnOptions {
  threadId: string;
  prompt: string;
  cwd: string;
  approvalPolicy: string;
  outputSchema?: Record<string, unknown>;
  model?: string;
  effort?: string;
}

export const REVIEW_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    comments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          commentId: { type: 'string' },
          reply: { type: 'string' },
        },
        required: ['commentId', 'reply'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'comments'],
  additionalProperties: false,
};

export type VirtualPrStatus = 'review-ready' | 'ai-working' | 'changes-requested' | 'approved';

export interface VirtualPrState {
  version: 1;
  title: string;
  workspaceRoot: string;
  baseRef: string;
  baseCommit: string;
  createdAt: string;
  status: VirtualPrStatus;
  codexThreadId?: string;
  codexModel?: string;
  codexEffort?: string;
  comments: ReviewComment[];
  viewedFiles?: string[];
}

export interface VirtualPrSession {
  state: VirtualPrState | undefined;
  changes: FileChange[];
}

export class LatestOperationGate {
  private generation = 0;

  begin(): number {
    return ++this.generation;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  invalidate(): void {
    this.generation++;
  }
}

export function resetVirtualPrSession(
  _state: VirtualPrState | undefined,
  _changes: readonly FileChange[],
): VirtualPrSession {
  return { state: undefined, changes: [] };
}

export function clearReviewComments(state: VirtualPrState): VirtualPrState {
  return { ...state, comments: [] };
}

export function normalizeCodexModels(response: unknown): CodexModel[] {
  if (!response || typeof response !== 'object') {
    return [];
  }
  const data = (response as Record<string, unknown>).data;
  if (!Array.isArray(data)) {
    return [];
  }

  const models: CodexModel[] = [];
  for (const candidate of data) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }
    const value = candidate as Record<string, unknown>;
    const id = typeof value.id === 'string' ? value.id.trim() : '';
    const model = typeof value.model === 'string' ? value.model.trim() : '';
    if (!id || !model || value.hidden === true) {
      continue;
    }
    const efforts = Array.isArray(value.supportedReasoningEfforts)
      ? value.supportedReasoningEfforts.flatMap((effort): CodexReasoningEffort[] => {
        if (!effort || typeof effort !== 'object') {
          return [];
        }
        const row = effort as Record<string, unknown>;
        const reasoningEffort = typeof row.reasoningEffort === 'string' ? row.reasoningEffort.trim() : '';
        if (!reasoningEffort) {
          return [];
        }
        return [{
          reasoningEffort,
          ...(typeof row.description === 'string' && row.description.trim()
            ? { description: row.description.trim() }
            : {}),
        }];
      })
      : [];
    models.push({
      id,
      model,
      displayName: typeof value.displayName === 'string' && value.displayName.trim()
        ? value.displayName.trim()
        : model,
      ...(typeof value.defaultReasoningEffort === 'string' && value.defaultReasoningEffort.trim()
        ? { defaultReasoningEffort: value.defaultReasoningEffort.trim() }
        : {}),
      supportedReasoningEfforts: efforts,
      isDefault: value.isDefault === true,
    });
  }
  return models;
}

export function prioritizeCodexModels(
  models: readonly CodexModel[],
  preferredModel?: string,
): CodexModel[] {
  return prioritizeChoices(
    models,
    (model) => model.model === preferredModel,
    (model) => model.isDefault,
  );
}

export function prioritizeCodexEfforts(
  efforts: readonly CodexReasoningEffort[],
  preferredEffort?: string,
  defaultEffort?: string,
): CodexReasoningEffort[] {
  return prioritizeChoices(
    efforts,
    (effort) => effort.reasoningEffort === preferredEffort,
    (effort) => effort.reasoningEffort === defaultEffort,
  );
}

function prioritizeChoices<T>(
  choices: readonly T[],
  isPreferred: (choice: T) => boolean,
  isDefault: (choice: T) => boolean,
): T[] {
  return [...choices].sort((left, right) => {
    const priority = (choice: T): number => isPreferred(choice) ? 0 : isDefault(choice) ? 1 : 2;
    return priority(left) - priority(right);
  });
}

export function buildCodexTurnParams(options: CodexTurnOptions): Record<string, unknown> {
  return {
    threadId: options.threadId,
    input: [{ type: 'text', text: options.prompt, text_elements: [] }],
    cwd: options.cwd,
    approvalPolicy: options.approvalPolicy,
    ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
  };
}

export function setFileViewed(
  viewedFiles: readonly string[],
  file: string,
  viewed: boolean,
): string[] {
  const next = new Set(viewedFiles);
  if (viewed) {
    next.add(file);
  } else {
    next.delete(file);
  }
  return [...next].sort((left, right) => left.localeCompare(right));
}

export function retainChangedViewedFiles(
  viewedFiles: readonly string[],
  changes: readonly FileChange[],
): string[] {
  const changed = new Set(changes.map((change) => change.path));
  return [...new Set(viewedFiles)]
    .filter((file) => changed.has(file))
    .sort((left, right) => left.localeCompare(right));
}

export function editReviewMessage(
  comments: readonly ReviewComment[],
  target: ReviewMessageTarget,
  message: string,
  updatedAt: string,
): ReviewComment[] {
  const normalized = message.trim();
  if (!normalized) {
    throw new Error('A review comment cannot be empty.');
  }

  let found = false;
  const updated = comments.map((comment) => {
    if (comment.id !== target.commentId) {
      return comment;
    }
    if (!target.replyId) {
      found = true;
      return { ...comment, message: normalized, updatedAt };
    }

    const replies = (comment.replies || []).map((reply) => {
      if (reply.id !== target.replyId) {
        return reply;
      }
      if (reply.author !== 'reviewer') {
        throw new Error('Codex replies cannot be edited.');
      }
      found = true;
      return { ...reply, message: normalized, updatedAt, pending: true };
    });
    return { ...comment, replies };
  });

  if (!found) {
    throw new Error('Unknown review comment or reply.');
  }
  return updated;
}

export function deleteReviewMessage(
  comments: readonly ReviewComment[],
  target: ReviewMessageTarget,
): ReviewComment[] {
  if (!target.replyId) {
    if (!comments.some((comment) => comment.id === target.commentId)) {
      throw new Error('Unknown review comment or reply.');
    }
    return comments.filter((comment) => comment.id !== target.commentId);
  }

  let found = false;
  const updated = comments.map((comment) => {
    if (comment.id !== target.commentId) {
      return comment;
    }
    const replies = (comment.replies || []).filter((reply) => {
      if (reply.id !== target.replyId) {
        return true;
      }
      if (reply.author !== 'reviewer') {
        throw new Error('Codex replies cannot be deleted.');
      }
      found = true;
      return false;
    });
    return { ...comment, replies };
  });
  if (!found) {
    throw new Error('Unknown review comment or reply.');
  }
  return updated;
}

export function markReviewerRepliesSent(
  comments: readonly ReviewComment[],
  commentIds: readonly string[],
): ReviewComment[] {
  const completed = new Set(commentIds);
  return comments.map((comment) => completed.has(comment.id)
    ? {
      ...comment,
      replies: comment.replies?.map((reply) => reply.author === 'reviewer' && reply.pending
        ? { ...reply, pending: false }
        : reply),
    }
    : comment);
}

export function parseNameStatusZ(output: string): FileChange[] {
  const fields = output.split('\0');
  const changes: FileChange[] = [];

  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) {
      continue;
    }

    const kind = status[0];
    if (kind === 'R' || kind === 'C') {
      const previousPath = fields[index++];
      const path = fields[index++];
      if (previousPath && path) {
        changes.push({ kind: 'R', path, previousPath });
      }
      continue;
    }

    const path = fields[index++];
    if (path && (kind === 'A' || kind === 'M' || kind === 'D')) {
      changes.push({ kind, path });
    }
  }

  return changes;
}

export function parseHeadRanges(diff: string): HeadRange[] {
  const ranges: HeadRange[] = [];
  const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;

  for (const match of diff.matchAll(header)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count > 0) {
      ranges.push({ start, end: start + count - 1 });
    }
  }

  return ranges;
}

export function relocateAnchor(text: string, comment: ReviewComment): RelocatedAnchor | undefined {
  if (!comment.selectedCode) {
    return undefined;
  }

  const candidates: Array<RelocatedAnchor & { score: number }> = [];
  const lines = text.split('\n');
  const selectedLineCount = comment.selectedCode.split('\n').length;
  let offset = 0;

  while (offset <= text.length) {
    const found = text.indexOf(comment.selectedCode, offset);
    if (found < 0) {
      break;
    }

    const startLineIndex = text.slice(0, found).split('\n').length - 1;
    const endLineIndex = startLineIndex + selectedLineCount - 1;
    let score = 0;

    for (let index = 0; index < comment.contextBefore.length; index++) {
      const candidateLine = startLineIndex - comment.contextBefore.length + index;
      if (candidateLine >= 0 && lines[candidateLine] === comment.contextBefore[index]) {
        score++;
      }
    }
    for (let index = 0; index < comment.contextAfter.length; index++) {
      const candidateLine = endLineIndex + 1 + index;
      if (candidateLine < lines.length && lines[candidateLine] === comment.contextAfter[index]) {
        score++;
      }
    }

    candidates.push({
      startLine: startLineIndex + 1,
      endLine: endLineIndex + 1,
      score,
    });
    offset = found + Math.max(comment.selectedCode.length, 1);
  }

  if (candidates.length === 0) {
    return undefined;
  }

  candidates.sort((left, right) => right.score - left.score);
  if (candidates.length > 1 && candidates[0].score === candidates[1].score) {
    return undefined;
  }

  return {
    startLine: candidates[0].startLine,
    endLine: candidates[0].endLine,
  };
}

export function buildReviewPrompt(comments: readonly ReviewComment[]): string {
  const unresolved = comments.filter((comment) => comment.status !== 'resolved');
  const entries = unresolved.map((comment, index) => {
    const location = comment.status === 'outdated'
      ? `${comment.file} (originally ${comment.startLine}-${comment.endLine}; anchor is outdated)`
      : `${comment.file}:${comment.startLine}-${comment.endLine}`;
    const context = [
      ...comment.contextBefore,
      comment.selectedCode,
      ...comment.contextAfter,
    ].join('\n');
    const conversation = (comment.replies || []).map((reply) => {
      const author = reply.author === 'codex'
        ? 'Codex'
        : reply.pending ? 'Reviewer (new follow-up)' : 'Reviewer';
      return `${author}: ${reply.message}`;
    });

    return [
      `${index + 1}. [${comment.id}] ${location}`,
      `Review comment: ${comment.message}`,
      'Relevant source context:',
      '```',
      context,
      '```',
      ...(conversation.length > 0 ? ['Previous conversation:', ...conversation] : []),
    ].join('\n');
  });

  return [
    'Address every unresolved local Virtual PR review comment below.',
    'Treat every Reviewer (new follow-up) message as an additional requirement to address in this turn.',
    'Edit the current workspace directly, preserve unrelated behavior, and run focused verification.',
    'Report how each comment was addressed and which checks ran. Do not mark comments resolved; the human reviewer owns resolution.',
    'Return exactly one concise reply for every listed comment ID using the provided response schema.',
    '',
    ...entries,
  ].join('\n');
}

export function parseReviewResponse(message: string, expectedIds: readonly string[]): CodexReviewResponse {
  let candidate: unknown;
  try {
    candidate = JSON.parse(message);
  } catch {
    throw new Error('Invalid Codex review response: expected JSON.');
  }

  if (!candidate || typeof candidate !== 'object') {
    throw new Error('Invalid Codex review response: expected an object.');
  }
  const value = candidate as Record<string, unknown>;
  if (typeof value.summary !== 'string' || !Array.isArray(value.comments)) {
    throw new Error('Invalid Codex review response: summary and comments are required.');
  }

  const comments: CodexReviewResponse['comments'] = [];
  for (const entry of value.comments) {
    if (!entry || typeof entry !== 'object') {
      throw new Error('Invalid Codex review response: each comment reply must be an object.');
    }
    const reply = entry as Record<string, unknown>;
    if (typeof reply.commentId !== 'string' || typeof reply.reply !== 'string' || !reply.reply.trim()) {
      throw new Error('Invalid Codex review response: each comment needs an ID and non-empty reply.');
    }
    comments.push({ commentId: reply.commentId, reply: reply.reply.trim() });
  }

  const expected = new Set(expectedIds);
  const actual = new Set(comments.map((comment) => comment.commentId));
  const exactMapping = expected.size === expectedIds.length
    && actual.size === comments.length
    && comments.length === expectedIds.length
    && expectedIds.every((id) => actual.has(id));
  if (!exactMapping) {
    throw new Error('Invalid Codex review response: comment IDs do not match the requested comments.');
  }

  return { summary: value.summary, comments };
}

export function appendReviewReply(
  comments: readonly ReviewComment[],
  commentId: string,
  reply: ReviewReply,
): ReviewComment[] {
  if (!comments.some((comment) => comment.id === commentId)) {
    throw new Error(`Unknown review comment: ${commentId}`);
  }
  return comments.map((comment) => comment.id === commentId
    ? { ...comment, replies: [...(comment.replies || []), reply] }
    : comment);
}

export function isAppServerHelp(output: string): boolean {
  return /(?:Usage:\s*codex app-server|Run the app server)/i.test(output);
}

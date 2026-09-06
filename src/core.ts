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
}

export interface RelocatedAnchor {
  startLine: number;
  endLine: number;
}

export interface CodexReviewResponse {
  summary: string;
  comments: Array<{ commentId: string; reply: string }>;
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
  comments: ReviewComment[];
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
    const conversation = (comment.replies || []).map((reply) =>
      `${reply.author === 'codex' ? 'Codex' : 'Reviewer'}: ${reply.message}`,
    );

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
    'Edit the current workspace directly, preserve unrelated behavior, and run focused verification.',
    'Report how each comment was addressed and which checks ran. Do not mark comments resolved; the human reviewer owns resolution.',
    'Return exactly one concise reply for every listed comment ID using the provided response schema.',
    '',
    ...entries,
  ].join('\n');
}

export function buildFollowUpPrompt(comment: ReviewComment): string {
  const location = comment.status === 'outdated'
    ? `${comment.file} (originally ${comment.startLine}-${comment.endLine}; anchor is outdated)`
    : `${comment.file}:${comment.startLine}-${comment.endLine}`;
  const context = [
    ...comment.contextBefore,
    comment.selectedCode,
    ...comment.contextAfter,
  ].join('\n');
  const conversation = (comment.replies || []).map((reply) =>
    `${reply.author === 'codex' ? 'Codex' : 'Reviewer'}: ${reply.message}`,
  );

  return [
    `Continue addressing only local Virtual PR review comment [${comment.id}].`,
    'Edit the current workspace directly if needed, preserve unrelated behavior, and run focused verification.',
    'Do not mark the comment resolved; the human reviewer owns resolution.',
    `Location: ${location}`,
    `Original review: ${comment.message}`,
    'Relevant source context:',
    '```',
    context,
    '```',
    'Review conversation:',
    ...conversation,
    `Return a concise reply for comment ID ${comment.id} explaining what changed and which checks ran.`,
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

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendReviewReply,
  buildCodexTurnParams,
  buildReviewPrompt,
  editReviewMessage,
  isAppServerHelp,
  markReviewerRepliesSent,
  parseHeadRanges,
  parseNameStatusZ,
  parseReviewResponse,
  normalizeCodexModels,
  prioritizeCodexEfforts,
  prioritizeCodexModels,
  retainChangedViewedFiles,
  relocateAnchor,
  resetVirtualPrSession,
  ReviewComment,
  setFileViewed,
} from '../core';

test('resetting a Virtual PR clears its review state and changed files', () => {
  const current = {
    version: 1 as const,
    title: 'feature → main',
    workspaceRoot: '/workspace',
    baseRef: 'main',
    baseCommit: 'abc123',
    createdAt: '2026-09-07T00:00:00.000Z',
    status: 'changes-requested' as const,
    codexThreadId: 'thread-1',
    codexModel: 'gpt-selected',
    codexEffort: 'high',
    comments: [{
      id: 'comment-1',
      file: 'src/file.ts',
      startLine: 1,
      endLine: 1,
      selectedCode: 'old();',
      contextBefore: [],
      contextAfter: [],
      message: 'Replace this.',
      status: 'open' as const,
    }],
    viewedFiles: ['src/file.ts'],
  };
  const changes = [{ kind: 'M' as const, path: 'src/file.ts' }];

  assert.deepEqual(resetVirtualPrSession(current, changes), { state: undefined, changes: [] });
});

test('Codex model list keeps selectable models and their supported efforts', () => {
  assert.deepEqual(normalizeCodexModels({
    data: [
      {
        id: 'gpt-default',
        model: 'gpt-default',
        displayName: 'GPT Default',
        hidden: false,
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Fast' },
          { reasoningEffort: 'medium', description: 'Balanced' },
        ],
        isDefault: true,
      },
      {
        id: 'gpt-hidden',
        model: 'gpt-hidden',
        displayName: 'GPT Hidden',
        hidden: true,
        defaultReasoningEffort: 'high',
        supportedReasoningEfforts: [],
        isDefault: false,
      },
      { id: '', model: '', displayName: '', supportedReasoningEfforts: [] },
    ],
  }), [
    {
      id: 'gpt-default',
      model: 'gpt-default',
      displayName: 'GPT Default',
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: 'Fast' },
        { reasoningEffort: 'medium', description: 'Balanced' },
      ],
      isDefault: true,
    },
  ]);
});

test('Codex choices put the saved selection ahead of server defaults', () => {
  const models = [
    { id: 'other-model', model: 'other-model', displayName: 'Other', supportedReasoningEfforts: [], isDefault: false },
    { id: 'default-model', model: 'default-model', displayName: 'Default', supportedReasoningEfforts: [], isDefault: true },
    { id: 'saved-model', model: 'saved-model', displayName: 'Saved', supportedReasoningEfforts: [], isDefault: false },
  ];
  const efforts = [
    { reasoningEffort: 'low' },
    { reasoningEffort: 'medium' },
    { reasoningEffort: 'high' },
  ];

  assert.deepEqual(prioritizeCodexModels(models, 'saved-model'), [models[2], models[1], models[0]]);
  assert.deepEqual(prioritizeCodexModels(models, 'missing-model'), [models[1], models[0], models[2]]);
  assert.deepEqual(prioritizeCodexEfforts(efforts, 'high', 'medium'), [efforts[2], efforts[1], efforts[0]]);
  assert.deepEqual(prioritizeCodexEfforts(efforts, 'missing', 'medium'), [efforts[1], efforts[0], efforts[2]]);
});

test('Codex turn parameters include selected model and effort only when provided', async (t) => {
  const cases = [
    {
      name: 'selected model and effort',
      input: { model: 'gpt-selected', effort: 'high' },
      expectedOverrides: { model: 'gpt-selected', effort: 'high' },
    },
    {
      name: 'Codex defaults',
      input: {},
      expectedOverrides: {},
    },
  ];
  for (const row of cases) {
    await t.test(row.name, () => {
      assert.deepEqual(buildCodexTurnParams({
        threadId: 'thread-1',
        prompt: 'Apply the review.',
        cwd: '/workspace',
        approvalPolicy: 'never',
        outputSchema: { type: 'object' },
        ...row.input,
      }), {
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'Apply the review.', text_elements: [] }],
        cwd: '/workspace',
        approvalPolicy: 'never',
        outputSchema: { type: 'object' },
        ...row.expectedOverrides,
      });
    });
  }
});

test('Codex discovery rejects legacy CLI help that lacks app-server support', () => {
  assert.equal(isAppServerHelp('Usage: codex [OPTIONS] [PROMPT] <COMMAND>'), false);
  assert.equal(isAppServerHelp('Usage: codex app-server [OPTIONS]\nRun the app server'), true);
});

test('name-status parsing keeps rename pairs as one changed file', () => {
  const output = [
    'M', 'src/modified.ts',
    'A', 'src/added.ts',
    'D', 'src/deleted.ts',
    'R100', 'src/before.ts', 'src/after.ts',
    '',
  ].join('\0');

  assert.deepEqual(parseNameStatusZ(output), [
    { kind: 'M', path: 'src/modified.ts' },
    { kind: 'A', path: 'src/added.ts' },
    { kind: 'D', path: 'src/deleted.ts' },
    { kind: 'R', path: 'src/after.ts', previousPath: 'src/before.ts' },
  ]);
});

test('head range parsing highlights added and modified lines but not pure deletions', () => {
  const diff = [
    '@@ -1,0 +2,3 @@',
    '@@ -10 +14 @@',
    '@@ -20,2 +24,0 @@',
  ].join('\n');

  assert.deepEqual(parseHeadRanges(diff), [
    { start: 2, end: 4 },
    { start: 14, end: 14 },
  ]);
});

test('viewed files can be toggled and stale paths are removed', () => {
  const viewed = setFileViewed([], 'src/second.ts', true);
  const withTwo = setFileViewed(viewed, 'src/first.ts', true);

  assert.deepEqual(withTwo, ['src/first.ts', 'src/second.ts']);
  assert.deepEqual(setFileViewed(withTwo, 'src/first.ts', false), ['src/second.ts']);
  assert.deepEqual(retainChangedViewedFiles(
    ['src/deleted.ts', 'src/second.ts', 'src/second.ts'],
    [{ kind: 'M', path: 'src/second.ts' }, { kind: 'A', path: 'src/new.ts' }],
  ), ['src/second.ts']);
});

test('review prompt includes unresolved source context and excludes resolved comments', () => {
  const comments = [
    {
      id: 'open-1',
      file: 'src/retry.ts',
      startLine: 10,
      endLine: 12,
      selectedCode: 'await wait(delay);',
      contextBefore: ['if (retryable) {'],
      contextAfter: ['}'],
      message: 'Check exhaustion before waiting.',
      status: 'open',
      replies: [
        {
          id: 'reply-1',
          author: 'codex',
          message: 'I moved the exhaustion check before the wait.',
          createdAt: '2026-09-06T01:00:00.000Z',
        },
        {
          id: 'reply-2',
          author: 'reviewer',
          message: 'Please add a regression test too.',
          createdAt: '2026-09-06T01:01:00.000Z',
        },
      ],
    },
    {
      id: 'done-1',
      file: 'src/old.ts',
      startLine: 1,
      endLine: 1,
      selectedCode: 'old();',
      contextBefore: [],
      contextAfter: [],
      message: 'Already fixed.',
      status: 'resolved',
    },
  ] as unknown as ReviewComment[];

  const prompt = buildReviewPrompt(comments);

  assert.match(prompt, /src\/retry\.ts:10-12/);
  assert.match(prompt, /Check exhaustion before waiting\./);
  assert.match(prompt, /await wait\(delay\);/);
  assert.match(prompt, /Codex: I moved the exhaustion check before the wait\./);
  assert.match(prompt, /Reviewer: Please add a regression test too\./);
  assert.match(prompt, /Do not mark comments resolved/);
  assert.doesNotMatch(prompt, /src\/old\.ts/);
});

test('review response parser accepts exact comment mappings and rejects invalid mappings', async (t) => {
  assert.deepEqual(parseReviewResponse(JSON.stringify({
    summary: 'Applied both requests.',
    comments: [
      { commentId: 'comment-1', reply: 'Added the regression test.' },
      { commentId: 'comment-2', reply: 'Kept the operation atomic.' },
    ],
  }), ['comment-1', 'comment-2']), {
    summary: 'Applied both requests.',
    comments: [
      { commentId: 'comment-1', reply: 'Added the regression test.' },
      { commentId: 'comment-2', reply: 'Kept the operation atomic.' },
    ],
  });

  const invalidCases = [
    {
      name: 'missing comment',
      message: JSON.stringify({ summary: 'Partial.', comments: [{ commentId: 'comment-1', reply: 'Done.' }] }),
    },
    {
      name: 'duplicate comment',
      message: JSON.stringify({
        summary: 'Duplicate.',
        comments: [
          { commentId: 'comment-1', reply: 'Done.' },
          { commentId: 'comment-1', reply: 'Done twice.' },
        ],
      }),
    },
    {
      name: 'unknown comment',
      message: JSON.stringify({
        summary: 'Wrong target.',
        comments: [
          { commentId: 'comment-1', reply: 'Done.' },
          { commentId: 'other', reply: 'Wrong.' },
        ],
      }),
    },
    {
      name: 'empty reply',
      message: JSON.stringify({
        summary: 'No explanation.',
        comments: [
          { commentId: 'comment-1', reply: '' },
          { commentId: 'comment-2', reply: 'Done.' },
        ],
      }),
    },
  ];

  for (const row of invalidCases) {
    await t.test(row.name, () => {
      assert.throws(() => parseReviewResponse(row.message, ['comment-1', 'comment-2']), /Invalid Codex review response/);
    });
  }
});

test('appending reviewer and Codex replies preserves order without resolving the comment', () => {
  const original: ReviewComment[] = [{
    id: 'comment-1',
    file: 'src/retry.ts',
    startLine: 10,
    endLine: 10,
    selectedCode: 'await wait(delay);',
    contextBefore: [],
    contextAfter: [],
    message: 'Check exhaustion first.',
    status: 'open',
  }];
  const withReviewer = appendReviewReply(original, 'comment-1', {
    id: 'reply-1',
    author: 'reviewer',
    message: 'Please add a regression test too.',
    createdAt: '2026-09-06T01:00:00.000Z',
  });
  const withCodex = appendReviewReply(withReviewer, 'comment-1', {
    id: 'reply-2',
    author: 'codex',
    message: 'Added the regression test.',
    createdAt: '2026-09-06T01:01:00.000Z',
  });

  assert.equal(original[0].replies, undefined);
  assert.equal(withCodex[0].status, 'open');
  assert.deepEqual(withCodex[0].replies, [
    {
      id: 'reply-1',
      author: 'reviewer',
      message: 'Please add a regression test too.',
      createdAt: '2026-09-06T01:00:00.000Z',
    },
    {
      id: 'reply-2',
      author: 'codex',
      message: 'Added the regression test.',
      createdAt: '2026-09-06T01:01:00.000Z',
    },
  ]);
  assert.throws(
    () => appendReviewReply(withCodex, 'missing', {
      id: 'reply-3',
      author: 'reviewer',
      message: 'Lost reply.',
      createdAt: '2026-09-06T01:02:00.000Z',
    }),
    /Unknown review comment/,
  );
});

test('editing review messages preserves resolution and protects Codex replies', () => {
  const comments: ReviewComment[] = [{
    id: 'comment-1',
    file: 'src/retry.ts',
    startLine: 10,
    endLine: 10,
    selectedCode: 'await wait(delay);',
    contextBefore: [],
    contextAfter: [],
    message: 'Original review.',
    status: 'resolved',
    replies: [
      {
        id: 'reviewer-reply',
        author: 'reviewer',
        message: 'Original follow-up.',
        createdAt: '2026-09-06T01:00:00.000Z',
      },
      {
        id: 'codex-reply',
        author: 'codex',
        message: 'Codex response.',
        createdAt: '2026-09-06T01:01:00.000Z',
      },
    ],
  }];

  const editedComment = editReviewMessage(
    comments,
    { commentId: 'comment-1' },
    'Updated review.',
    '2026-09-06T02:00:00.000Z',
  );
  assert.equal(editedComment[0].message, 'Updated review.');
  assert.equal(editedComment[0].status, 'resolved');
  assert.equal(editedComment[0].updatedAt, '2026-09-06T02:00:00.000Z');

  const editedReply = editReviewMessage(
    editedComment,
    { commentId: 'comment-1', replyId: 'reviewer-reply' },
    'Updated follow-up.',
    '2026-09-06T02:01:00.000Z',
  );
  assert.equal(editedReply[0].replies?.[0].message, 'Updated follow-up.');
  assert.equal(editedReply[0].replies?.[0].updatedAt, '2026-09-06T02:01:00.000Z');
  assert.equal(editedReply[0].replies?.[0].pending, true);
  assert.throws(
    () => editReviewMessage(
      editedReply,
      { commentId: 'comment-1', replyId: 'codex-reply' },
      'Changed Codex response.',
      '2026-09-06T02:02:00.000Z',
    ),
    /Codex replies cannot be edited/,
  );
});

test('batch review prompt marks new follow-ups and clears them after delivery', () => {
  const comments: ReviewComment[] = [{
    id: 'comment-1',
    file: 'src/retry.ts',
    startLine: 10,
    endLine: 10,
    selectedCode: 'await wait(delay);',
    contextBefore: ['if (retryable) {'],
    contextAfter: ['}'],
    message: 'Check exhaustion first.',
    status: 'open',
    replies: [
      {
        id: 'reply-1',
        author: 'codex',
        message: 'Moved the exhaustion check.',
        createdAt: '2026-09-06T01:00:00.000Z',
      },
      {
        id: 'reply-2',
        author: 'reviewer',
        message: 'Please add a regression test too.',
        createdAt: '2026-09-06T01:01:00.000Z',
        pending: true,
      },
    ],
  }];

  const prompt = buildReviewPrompt(comments);

  assert.match(prompt, /src\/retry\.ts:10-10/);
  assert.match(prompt, /Review comment: Check exhaustion first\./);
  assert.match(prompt, /Codex: Moved the exhaustion check\./);
  assert.match(prompt, /Reviewer \(new follow-up\): Please add a regression test too\./);
  assert.match(prompt, /Do not mark.*resolved/i);

  const delivered = markReviewerRepliesSent(comments, ['comment-1']);
  assert.equal(delivered[0].replies?.[1].pending, false);
  assert.match(buildReviewPrompt(delivered), /Reviewer: Please add a regression test too\./);
  assert.doesNotMatch(
    buildReviewPrompt(delivered),
    /Reviewer \(new follow-up\): Please add a regression test too\./,
  );
});

test('anchor relocation follows shifted code and rejects missing or ambiguous matches', async (t) => {
  const base: ReviewComment = {
    id: 'comment-1',
    file: 'src/retry.ts',
    startLine: 2,
    endLine: 2,
    selectedCode: 'return retry();',
    contextBefore: ['if (ready) {'],
    contextAfter: ['}'],
    message: 'Explain this retry.',
    status: 'open',
  };

  const cases: Array<{
    name: string;
    text: string;
    comment: ReviewComment;
    expected: { startLine: number; endLine: number } | undefined;
  }> = [
    {
      name: 'shifted unique code',
      text: ['header();', 'if (ready) {', 'return retry();', '}'].join('\n'),
      comment: base,
      expected: { startLine: 3, endLine: 3 },
    },
    {
      name: 'context disambiguates duplicate code',
      text: [
        'if (stale) {', 'return retry();', '}',
        'if (ready) {', 'return retry();', '}',
      ].join('\n'),
      comment: base,
      expected: { startLine: 5, endLine: 5 },
    },
    {
      name: 'missing code becomes outdated',
      text: ['if (ready) {', 'return done();', '}'].join('\n'),
      comment: base,
      expected: undefined,
    },
    {
      name: 'equally matching duplicates become outdated',
      text: ['return retry();', 'other();', 'return retry();'].join('\n'),
      comment: { ...base, contextBefore: [], contextAfter: [] },
      expected: undefined,
    },
  ];

  for (const row of cases) {
    await t.test(row.name, () => {
      assert.deepEqual(relocateAnchor(row.text, row.comment), row.expected);
    });
  }
});

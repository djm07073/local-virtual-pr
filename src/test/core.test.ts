import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendReviewReply,
  buildFollowUpPrompt,
  buildReviewPrompt,
  isAppServerHelp,
  parseHeadRanges,
  parseNameStatusZ,
  parseReviewResponse,
  retainChangedViewedFiles,
  relocateAnchor,
  ReviewComment,
  setFileViewed,
} from '../core';

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

test('follow-up prompt keeps the full comment conversation focused on one comment', () => {
  const prompt = buildFollowUpPrompt({
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
      },
    ],
  });

  assert.match(prompt, /only.*\[comment-1\]/i);
  assert.match(prompt, /src\/retry\.ts:10-10/);
  assert.match(prompt, /Original review: Check exhaustion first\./);
  assert.match(prompt, /Codex: Moved the exhaustion check\./);
  assert.match(prompt, /Reviewer: Please add a regression test too\./);
  assert.match(prompt, /Do not mark.*resolved/i);
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

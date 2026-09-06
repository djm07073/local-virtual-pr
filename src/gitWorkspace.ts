import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FileChange, HeadRange, parseHeadRanges, parseNameStatusZ } from './core';

function runGit(root: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export class GitWorkspace {
  constructor(readonly root: string) {}

  async ensureRepository(): Promise<void> {
    await runGit(this.root, ['rev-parse', '--git-dir']);
  }

  async currentBranch(): Promise<string> {
    return (await runGit(this.root, ['branch', '--show-current'])).trim() || 'working tree';
  }

  async detectBaseRef(configured: string): Promise<string> {
    const candidates: string[] = [];
    if (configured.trim()) {
      candidates.push(configured.trim());
    }

    try {
      const symbolic = (await runGit(this.root, [
        'symbolic-ref',
        '--quiet',
        '--short',
        'refs/remotes/origin/HEAD',
      ])).trim();
      if (symbolic) {
        candidates.push(symbolic);
      }
    } catch {
      // A remote HEAD is optional; the explicit fallbacks below remain deterministic.
    }

    candidates.push('origin/main', 'main', 'origin/master', 'master', 'HEAD~1');
    for (const candidate of [...new Set(candidates)]) {
      try {
        await runGit(this.root, ['rev-parse', '--verify', `${candidate}^{commit}`]);
        return candidate;
      } catch {
        continue;
      }
    }
    throw new Error('No usable base ref was found. Configure virtualPr.defaultBaseRef.');
  }

  async resolveBaseCommit(baseRef: string): Promise<string> {
    await runGit(this.root, ['rev-parse', '--verify', `${baseRef}^{commit}`]);
    return (await runGit(this.root, ['merge-base', baseRef, 'HEAD'])).trim();
  }

  async changedFiles(baseCommit: string): Promise<FileChange[]> {
    const tracked = parseNameStatusZ(await runGit(this.root, [
      'diff',
      '--name-status',
      '-z',
      '--find-renames',
      baseCommit,
      '--',
    ]));
    const untrackedOutput = await runGit(this.root, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ]);
    const known = new Set(tracked.map((change) => change.path));
    const untracked = untrackedOutput
      .split('\0')
      .filter((file) => file && !known.has(file))
      .map<FileChange>((file) => ({ kind: 'A', path: file }));

    return [...tracked, ...untracked].sort((left, right) => left.path.localeCompare(right.path));
  }

  async baseContent(baseCommit: string, file: string): Promise<string> {
    try {
      return await runGit(this.root, ['show', `${baseCommit}:${file}`]);
    } catch {
      return '';
    }
  }

  async headRanges(baseCommit: string, change: FileChange): Promise<HeadRange[]> {
    if (change.kind === 'D') {
      return [];
    }
    if (change.kind === 'A') {
      const content = await fs.readFile(path.join(this.root, change.path), 'utf8');
      const count = content.length === 0 ? 0 : content.split('\n').length;
      return count === 0 ? [] : [{ start: 1, end: count }];
    }
    const diff = await runGit(this.root, [
      'diff',
      '--no-ext-diff',
      '--unified=0',
      baseCommit,
      '--',
      change.path,
    ]);
    return parseHeadRanges(diff);
  }
}

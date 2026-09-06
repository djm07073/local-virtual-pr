import * as path from 'node:path';
import * as vscode from 'vscode';
import { FileChange, ReviewComment, VirtualPrState } from './core';

type TreeNode =
  | { type: 'create' }
  | { type: 'summary'; state: VirtualPrState }
  | { type: 'group'; group: 'changes' | 'comments'; count: number; viewedCount?: number }
  | { type: 'change'; change: FileChange; viewed: boolean }
  | { type: 'comment'; comment: ReviewComment };

export class ReviewTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly state: () => VirtualPrState | undefined,
    private readonly changes: () => readonly FileChange[],
  ) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.type === 'create') {
      const item = new vscode.TreeItem('Create Virtual PR');
      item.iconPath = new vscode.ThemeIcon('git-pull-request-create');
      item.command = { command: 'virtualPr.create', title: 'Create Virtual PR' };
      return item;
    }
    if (node.type === 'summary') {
      const item = new vscode.TreeItem(node.state.title);
      item.description = `${node.state.status} · ${node.state.baseRef}`;
      item.tooltip = `Base ${node.state.baseCommit}`;
      item.iconPath = new vscode.ThemeIcon(node.state.status === 'approved' ? 'pass-filled' : 'git-pull-request');
      return item;
    }
    if (node.type === 'group') {
      const label = node.group === 'changes' ? 'Changes' : 'Review comments';
      const count = node.group === 'changes'
        ? `${node.viewedCount || 0}/${node.count} viewed`
        : `${node.count}`;
      const item = new vscode.TreeItem(`${label} (${count})`, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon(node.group === 'changes' ? 'files' : 'comment-discussion');
      return item;
    }
    if (node.type === 'change') {
      const item = new vscode.TreeItem(path.basename(node.change.path));
      const directory = path.dirname(node.change.path) === '.' ? '' : path.dirname(node.change.path);
      item.description = `${node.viewed ? 'Viewed · ' : ''}${node.change.kind}  ${directory}`;
      const location = node.change.previousPath
        ? `${node.change.previousPath} → ${node.change.path}`
        : node.change.path;
      item.tooltip = node.viewed ? `Viewed\n${location}` : location;
      item.iconPath = new vscode.ThemeIcon(node.viewed
        ? 'check'
        : node.change.kind === 'D'
          ? 'diff-removed'
          : node.change.kind === 'A'
            ? 'diff-added'
            : 'diff-modified');
      item.command = { command: 'virtualPr.openDiff', title: 'Open Diff', arguments: [node.change] };
      item.contextValue = `virtualPr.change.${node.viewed ? 'viewed' : 'unviewed'}`;
      return item;
    }

    const item = new vscode.TreeItem(node.comment.message);
    const replies = node.comment.replies?.length || 0;
    item.description = `${node.comment.file}:${node.comment.startLine} · ${node.comment.status}${replies > 0 ? ` · ${replies} replies` : ''}`;
    item.tooltip = node.comment.selectedCode;
    item.iconPath = new vscode.ThemeIcon(node.comment.status === 'resolved' ? 'check' : node.comment.status === 'outdated' ? 'warning' : 'comment');
    item.command = { command: 'virtualPr.openSource', title: 'Open Source', arguments: [node.comment] };
    item.contextValue = `virtualPr.comment.${node.comment.status}`;
    return item;
  }

  getChildren(node?: TreeNode): TreeNode[] {
    const current = this.state();
    if (!current) {
      return node ? [] : [{ type: 'create' }];
    }
    if (!node) {
      const viewedCount = this.changes().filter((change) => current.viewedFiles?.includes(change.path)).length;
      return [
        { type: 'summary', state: current },
        { type: 'group', group: 'changes', count: this.changes().length, viewedCount },
        { type: 'group', group: 'comments', count: current.comments.length },
      ];
    }
    if (node.type === 'group' && node.group === 'changes') {
      return this.changes().map((change) => ({
        type: 'change',
        change,
        viewed: current.viewedFiles?.includes(change.path) || false,
      }));
    }
    if (node.type === 'group' && node.group === 'comments') {
      return current.comments.map((comment) => ({ type: 'comment', comment }));
    }
    return [];
  }
}

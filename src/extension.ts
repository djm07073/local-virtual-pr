import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import {
  appendReviewReply,
  buildReviewPrompt,
  editReviewMessage,
  FileChange,
  markReviewerRepliesSent,
  parseReviewResponse,
  retainChangedViewedFiles,
  relocateAnchor,
  REVIEW_OUTPUT_SCHEMA,
  ReviewComment,
  ReviewMessageTarget,
  setFileViewed,
  VirtualPrState,
} from './core';
import { CodexAppServer, discoverCodexPath } from './codex';
import { GitWorkspace } from './gitWorkspace';
import { ReviewTreeProvider, TreeNode } from './tree';

const STATE_KEY = 'localVirtualPr.state.v1';

class BaseDocumentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly git: GitWorkspace) {}

  provideTextDocumentContent(uri: vscode.Uri): vscode.ProviderResult<string> {
    const commit = new URLSearchParams(uri.query).get('commit');
    const file = uri.path.replace(/^\/+/, '');
    return commit ? this.git.baseContent(commit, file) : '';
  }
}

class EmptyDocumentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(): string {
    return '';
  }
}

class VirtualPrController implements vscode.Disposable {
  private state: VirtualPrState | undefined;
  private changes: FileChange[] = [];
  private readonly git: GitWorkspace;
  private readonly tree: ReviewTreeProvider;
  private readonly treeView: vscode.TreeView<TreeNode>;
  private readonly output = vscode.window.createOutputChannel('Local Virtual PR');
  private readonly comments = vscode.comments.createCommentController('localVirtualPr', 'Local Virtual PR');
  private readonly commentThreads = new Map<string, vscode.CommentThread>();
  private renderedCommentTargets = new WeakMap<vscode.Comment, ReviewMessageTarget>();
  private readonly commentingRangeProvider: vscode.CommentingRangeProvider = {
    provideCommentingRanges: async (document) => {
      if (!this.state || !this.isWorkspaceFile(document.uri)) {
        return [];
      }
      const relative = path.relative(this.root, document.uri.fsPath).split(path.sep).join('/');
      const change = this.changes.find((candidate) => candidate.path === relative);
      if (!change) {
        return [];
      }
      try {
        const ranges = await this.git.headRanges(this.state.baseCommit, change);
        return ranges.map((range) => {
          const start = Math.min(Math.max(0, range.start - 1), Math.max(0, document.lineCount - 1));
          const end = Math.min(Math.max(start, range.end - 1), Math.max(0, document.lineCount - 1));
          return new vscode.Range(start, 0, end, document.lineAt(end).text.length);
        });
      } catch (error) {
        this.output.appendLine(`[Virtual PR] Could not provide comment ranges for ${relative}: ${String(error)}`);
        return [];
      }
    },
  };
  private readonly changedLines = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderStyle: 'solid',
    borderWidth: '0 0 0 2px',
    borderColor: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
    overviewRulerColor: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly root: string,
  ) {
    this.git = new GitWorkspace(root);
    const stored = context.workspaceState.get<VirtualPrState>(STATE_KEY);
    if (stored?.version === 1 && stored.workspaceRoot === root) {
      this.state = stored;
    }
    this.tree = new ReviewTreeProvider(() => this.state, () => this.changes);
    this.treeView = vscode.window.createTreeView('virtualPr.review', { treeDataProvider: this.tree });
    this.subscriptions.push(
      this.treeView,
      this.treeView.onDidChangeCheckboxState((event) => void this.setViewedFromCheckboxes(event)),
      vscode.workspace.registerTextDocumentContentProvider('virtual-pr-base', new BaseDocumentProvider(this.git)),
      vscode.workspace.registerTextDocumentContentProvider('virtual-pr-empty', new EmptyDocumentProvider()),
      vscode.commands.registerCommand('virtualPr.create', () => this.create()),
      vscode.commands.registerCommand('virtualPr.refresh', () => this.refresh(true)),
      vscode.commands.registerCommand('virtualPr.openDiff', (change: FileChange) => this.openDiff(change)),
      vscode.commands.registerCommand('virtualPr.openSource', (target: FileChange | ReviewComment | TreeNode) => this.openSource(target)),
      vscode.commands.registerCommand('virtualPr.markViewed', (target: FileChange | TreeNode) => this.setViewed(target, true)),
      vscode.commands.registerCommand('virtualPr.unmarkViewed', (target: FileChange | TreeNode) => this.setViewed(target, false)),
      vscode.commands.registerCommand('virtualPr.addComment', (reply?: vscode.CommentReply) => this.addComment(reply)),
      vscode.commands.registerCommand('virtualPr.editComment', (target?: ReviewComment | vscode.Comment | TreeNode) => this.editComment(target)),
      vscode.commands.registerCommand('virtualPr.resolveComment', (target: ReviewComment | vscode.CommentThread | TreeNode) => this.setCommentStatus(target, 'resolved')),
      vscode.commands.registerCommand('virtualPr.reopenComment', (target: ReviewComment | vscode.CommentThread | TreeNode) => this.setCommentStatus(target, 'open')),
      vscode.commands.registerCommand('virtualPr.askAI', () => this.askAI()),
      vscode.commands.registerCommand('virtualPr.sendReview', () => this.sendReview()),
      vscode.commands.registerCommand('virtualPr.replyToComment', (reply: vscode.CommentReply) => this.addReply(reply)),
      vscode.commands.registerCommand('virtualPr.approve', () => this.approve()),
      vscode.commands.registerCommand('virtualPr.showOutput', () => this.output.show()),
      vscode.window.onDidChangeActiveTextEditor((editor) => void this.decorate(editor)),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (this.isWorkspaceFile(document.uri)) {
          void this.refresh(false);
        }
      }),
    );
  }

  async initialize(): Promise<void> {
    await this.git.ensureRepository();
    if (this.state) {
      await this.refresh(false);
    }
  }

  private async create(): Promise<void> {
    if (this.state) {
      const choice = await vscode.window.showWarningMessage(
        'Reset the current Virtual PR and remove its local review comments?',
        { modal: true },
        'Reset',
      );
      if (choice !== 'Reset') {
        return;
      }
    }

    const configured = vscode.workspace.getConfiguration('virtualPr').get<string>('defaultBaseRef', '');
    const detected = await this.git.detectBaseRef(configured);
    const baseRef = await vscode.window.showInputBox({
      title: 'Create Local Virtual PR',
      prompt: 'Git ref to compare this workspace against',
      value: detected,
      ignoreFocusOut: true,
      validateInput: (value) => value.trim() ? undefined : 'A base ref is required.',
    });
    if (!baseRef) {
      return;
    }

    const baseCommit = await this.git.resolveBaseCommit(baseRef.trim());
    const branch = await this.git.currentBranch();
    this.state = {
      version: 1,
      title: `${branch} → ${baseRef.trim()}`,
      workspaceRoot: this.root,
      baseRef: baseRef.trim(),
      baseCommit,
      createdAt: new Date().toISOString(),
      status: 'review-ready',
      comments: [],
      viewedFiles: [],
    };
    await this.save();
    await this.refresh(false);
    void vscode.window.showInformationMessage(`Virtual PR created against ${baseRef.trim()}.`);
  }

  private async refresh(notify: boolean): Promise<void> {
    if (!this.state) {
      if (notify) {
        void vscode.window.showInformationMessage('Create a Virtual PR first.');
      }
      return;
    }
    this.changes = await this.git.changedFiles(this.state.baseCommit);
    this.state.viewedFiles = retainChangedViewedFiles(this.state.viewedFiles || [], this.changes);
    this.comments.options = {
      prompt: 'Add a local Virtual PR review comment',
      placeHolder: 'Describe the change Codex should make',
    };
    this.comments.commentingRangeProvider = this.commentingRangeProvider;
    await this.reanchorComments();
    await this.save();
    await this.renderCommentThreads();
    this.tree.refresh();
    await this.decorate(vscode.window.activeTextEditor);
    if (notify) {
      void vscode.window.showInformationMessage(`Virtual PR refreshed: ${this.changes.length} changed files.`);
    }
  }

  private async openDiff(change: FileChange): Promise<void> {
    const state = this.requireState();
    if (!state) {
      return;
    }
    const left = change.kind === 'A'
      ? vscode.Uri.from({ scheme: 'virtual-pr-empty', path: `/${change.path}`, query: 'side=base' })
      : vscode.Uri.from({
        scheme: 'virtual-pr-base',
        path: `/${change.previousPath || change.path}`,
        query: `commit=${encodeURIComponent(state.baseCommit)}`,
      });
    const right = change.kind === 'D'
      ? vscode.Uri.from({ scheme: 'virtual-pr-empty', path: `/${change.path}`, query: 'side=head' })
      : this.workspaceUri(change.path);
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      right,
      `${change.path} (${state.baseRef} ↔ working tree)`,
      { preview: true },
    );
  }

  private async openSource(target: FileChange | ReviewComment | TreeNode): Promise<void> {
    const source = 'type' in target
      ? target.type === 'change'
        ? target.change
        : target.type === 'comment'
          ? target.comment
          : undefined
      : target;
    if (!source) {
      return;
    }
    const file = 'path' in source ? source.path : source.file;
    const uri = this.workspaceUri(file);
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      const line = 'startLine' in source ? Math.max(0, source.startLine - 1) : 0;
      const position = new vscode.Position(Math.min(line, Math.max(0, document.lineCount - 1)), 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      await this.decorate(editor);
    } catch (error) {
      void vscode.window.showErrorMessage(`Cannot open ${file}: ${String(error)}`);
    }
  }

  private async setViewed(target: FileChange | TreeNode | undefined, viewed: boolean): Promise<void> {
    const state = this.requireState();
    const change = target && 'type' in target
      ? target.type === 'change' ? target.change : undefined
      : target;
    if (!state || !change?.path || !this.changes.some((candidate) => candidate.path === change.path)) {
      return;
    }
    state.viewedFiles = setFileViewed(state.viewedFiles || [], change.path, viewed);
    await this.save();
    this.tree.refresh();
  }

  private async setViewedFromCheckboxes(event: vscode.TreeCheckboxChangeEvent<TreeNode>): Promise<void> {
    const state = this.requireState();
    if (!state) {
      return;
    }
    let viewedFiles = state.viewedFiles || [];
    for (const [node, checkboxState] of event.items) {
      if (node.type === 'change') {
        viewedFiles = setFileViewed(
          viewedFiles,
          node.change.path,
          checkboxState === vscode.TreeItemCheckboxState.Checked,
        );
      }
    }
    state.viewedFiles = viewedFiles;
    await this.save();
    this.tree.refresh();
  }

  private async addComment(reply?: vscode.CommentReply): Promise<void> {
    const state = this.requireState();
    const editor = vscode.window.activeTextEditor;
    const uri = reply?.thread.uri || editor?.document.uri;
    if (!state || !uri || !this.isWorkspaceFile(uri)) {
      void vscode.window.showErrorMessage('Open a changed file in the current workspace first.');
      return;
    }
    const document = reply
      ? await vscode.workspace.openTextDocument(uri)
      : editor!.document;
    const relative = path.relative(this.root, document.uri.fsPath).split(path.sep).join('/');
    if (!this.changes.some((change) => change.path === relative)) {
      void vscode.window.showErrorMessage('Review comments can only be added to a changed file.');
      return;
    }
    const message = reply?.text.trim() || await vscode.window.showInputBox({
        title: 'Add Local Review Comment',
        prompt: 'Describe the change the AI should make',
        ignoreFocusOut: true,
        validateInput: (value) => value.trim() ? undefined : 'A review comment is required.',
      });
    if (!message) {
      return;
    }

    const selection = reply?.thread.range || editor!.selection;
    const start = selection.start.line;
    const end = selection.isEmpty
      ? start
      : selection.end.character === 0
        ? Math.max(start, selection.end.line - 1)
        : selection.end.line;
    const fullLines = new vscode.Range(start, 0, end, document.lineAt(end).text.length);
    const contextBefore: string[] = [];
    const contextAfter: string[] = [];
    for (let line = Math.max(0, start - 3); line < start; line++) {
      contextBefore.push(document.lineAt(line).text);
    }
    for (let line = end + 1; line <= Math.min(document.lineCount - 1, end + 3); line++) {
      contextAfter.push(document.lineAt(line).text);
    }
    state.comments.push({
      id: crypto.randomUUID(),
      file: relative,
      startLine: start + 1,
      endLine: end + 1,
      selectedCode: document.getText(fullLines),
      contextBefore,
      contextAfter,
      message: message.trim(),
      status: 'open',
    });
    state.status = 'changes-requested';
    await this.save();
    reply?.thread.dispose();
    await this.renderCommentThreads();
    this.tree.refresh();
  }

  private async editComment(target: ReviewComment | vscode.Comment | TreeNode | undefined): Promise<void> {
    const state = this.requireState();
    if (!state || !target) {
      return;
    }
    const editableTarget = 'type' in target
      ? target.type === 'comment' ? target.comment : undefined
      : target;
    if (!editableTarget) {
      return;
    }
    const messageTarget: ReviewMessageTarget | undefined = 'id' in editableTarget && 'file' in editableTarget
      ? { commentId: editableTarget.id }
      : this.renderedCommentTargets.get(editableTarget as vscode.Comment);
    if (!messageTarget) {
      return;
    }

    const comment = state.comments.find((candidate) => candidate.id === messageTarget.commentId);
    const editable = messageTarget.replyId
      ? comment?.replies?.find((reply) => reply.id === messageTarget.replyId && reply.author === 'reviewer')
      : comment;
    if (!editable) {
      return;
    }
    const message = await vscode.window.showInputBox({
      title: messageTarget.replyId ? 'Edit Review Follow-up' : 'Edit Review Comment',
      prompt: comment?.status === 'resolved'
        ? 'Edit the resolved comment without reopening it'
        : 'Update your local review feedback',
      value: editable.message,
      ignoreFocusOut: true,
      validateInput: (value) => value.trim() ? undefined : 'A review comment is required.',
    });
    if (message === undefined || message.trim() === editable.message) {
      return;
    }

    state.comments = editReviewMessage(
      state.comments,
      messageTarget,
      message,
      new Date().toISOString(),
    );
    await this.save();
    await this.renderCommentThreads();
    this.tree.refresh();
  }

  private async setCommentStatus(
    target: ReviewComment | vscode.CommentThread | TreeNode | undefined,
    status: 'open' | 'resolved',
  ): Promise<void> {
    if (!this.state || !target) {
      return;
    }
    const commentId = 'type' in target
      ? target.type === 'comment' ? target.comment.id : undefined
      : 'id' in target
        ? target.id
        : [...this.commentThreads].find(([, thread]) => thread === target)?.[0];
    if (!commentId) {
      return;
    }
    const stored = this.state.comments.find((candidate) => candidate.id === commentId);
    if (!stored) {
      return;
    }
    stored.status = status;
    await this.save();
    await this.renderCommentThreads();
    this.tree.refresh();
  }

  private async askAI(): Promise<void> {
    const state = this.requireState();
    if (!state) {
      return;
    }
    const task = await vscode.window.showInputBox({
      title: 'Ask AI to Implement',
      prompt: 'Describe the implementation for this Virtual PR',
      ignoreFocusOut: true,
      validateInput: (value) => value.trim() ? undefined : 'An implementation request is required.',
    });
    if (!task) {
      return;
    }
    await this.runAgent(task.trim());
  }

  private async addReply(reply: vscode.CommentReply): Promise<void> {
    const state = this.requireState();
    if (!state) {
      return;
    }
    if (state.status === 'ai-working') {
      void vscode.window.showInformationMessage('Codex is already working on this Virtual PR.');
      return;
    }

    const commentId = [...this.commentThreads].find(([, thread]) => thread === reply.thread)?.[0];
    const message = reply.text.trim();
    const comment = state.comments.find((candidate) => candidate.id === commentId);
    if (!commentId || !message || !comment || comment.status === 'resolved') {
      return;
    }
    state.comments = appendReviewReply(state.comments, commentId, {
      id: crypto.randomUUID(),
      author: 'reviewer',
      message,
      createdAt: new Date().toISOString(),
      pending: true,
    });
    state.status = 'changes-requested';
    await this.save();
    await this.renderCommentThreads();
    this.tree.refresh();
  }

  private async sendReview(): Promise<void> {
    const state = this.requireState();
    if (!state) {
      return;
    }
    if (state.status === 'ai-working') {
      void vscode.window.showInformationMessage('Codex is already working on this Virtual PR.');
      return;
    }
    const unresolved = state.comments.filter((comment) => comment.status !== 'resolved');
    if (unresolved.length === 0) {
      void vscode.window.showInformationMessage('There are no unresolved review comments.');
      return;
    }
    await this.runAgent(buildReviewPrompt(state.comments), unresolved.map((comment) => comment.id));
  }

  private async runAgent(prompt: string, reviewCommentIds: readonly string[] = []): Promise<void> {
    const state = this.requireState();
    if (!state) {
      return;
    }
    state.status = 'ai-working';
    await this.save();
    this.tree.refresh();
    await this.renderCommentThreads();
    this.output.appendLine(`\n[Virtual PR] Starting Codex in ${this.root}\n`);

    try {
      const binary = await discoverCodexPath();
      const approvalPolicy = vscode.workspace.getConfiguration('virtualPr')
        .get<'never' | 'on-request' | 'untrusted'>('codexApprovalPolicy', 'never');
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Virtual PR: Codex is updating the workspace' },
        () => CodexAppServer.run(
          binary,
          this.root,
          state.codexThreadId,
          prompt,
          approvalPolicy,
          this.output,
          reviewCommentIds.length > 0 ? REVIEW_OUTPUT_SCHEMA : undefined,
        ),
      );
      state.codexThreadId = result.threadId;
      state.status = 'review-ready';
      let summary = result.message;
      if (reviewCommentIds.length > 0) {
        const response = parseReviewResponse(result.message, reviewCommentIds);
        state.comments = markReviewerRepliesSent(state.comments, reviewCommentIds);
        for (const reply of response.comments) {
          state.comments = appendReviewReply(state.comments, reply.commentId, {
            id: crypto.randomUUID(),
            author: 'codex',
            message: reply.reply,
            createdAt: new Date().toISOString(),
          });
        }
        summary = response.summary;
      }
      this.output.appendLine(`\n\n[Virtual PR] Codex turn completed.\n${summary}\n`);
      await this.refresh(false);
      void vscode.window.showInformationMessage(
        reviewCommentIds.length > 0
          ? 'Codex replied to the review comments. The Virtual PR diff has been refreshed.'
          : 'Codex finished. The Virtual PR diff has been refreshed.',
      );
    } catch (error) {
      state.status = 'changes-requested';
      await this.save();
      this.tree.refresh();
      await this.renderCommentThreads();
      this.output.appendLine(`\n[Virtual PR] Codex failed: ${String(error)}\n`);
      this.output.show(true);
      void vscode.window.showErrorMessage(`Codex failed: ${String(error)}`);
    }
  }

  private async approve(): Promise<void> {
    const state = this.requireState();
    if (!state) {
      return;
    }
    const unresolved = state.comments.filter((comment) => comment.status !== 'resolved').length;
    if (unresolved > 0) {
      const choice = await vscode.window.showWarningMessage(
        `Approve locally with ${unresolved} unresolved review comment(s)?`,
        { modal: true },
        'Approve anyway',
      );
      if (choice !== 'Approve anyway') {
        return;
      }
    }
    state.status = 'approved';
    await this.save();
    this.tree.refresh();
    void vscode.window.showInformationMessage('Virtual PR approved locally. No commit or remote action was performed.');
  }

  private async reanchorComments(): Promise<void> {
    if (!this.state) {
      return;
    }
    for (const comment of this.state.comments) {
      if (comment.status === 'resolved') {
        continue;
      }
      try {
        const text = await fs.readFile(this.workspaceUri(comment.file).fsPath, 'utf8');
        const relocated = relocateAnchor(text, comment);
        if (relocated) {
          comment.startLine = relocated.startLine;
          comment.endLine = relocated.endLine;
          comment.status = 'open';
        } else {
          comment.status = 'outdated';
        }
      } catch {
        comment.status = 'outdated';
      }
    }
  }

  private async renderCommentThreads(): Promise<void> {
    for (const thread of this.commentThreads.values()) {
      thread.dispose();
    }
    this.commentThreads.clear();
    this.renderedCommentTargets = new WeakMap<vscode.Comment, ReviewMessageTarget>();
    if (!this.state) {
      return;
    }

    for (const comment of this.state.comments) {
      try {
        const document = await vscode.workspace.openTextDocument(this.workspaceUri(comment.file));
        const start = Math.min(Math.max(0, comment.startLine - 1), Math.max(0, document.lineCount - 1));
        const end = Math.min(Math.max(start, comment.endLine - 1), Math.max(0, document.lineCount - 1));
        const range = new vscode.Range(start, 0, end, document.lineAt(end).text.length);
        const reviewComment: vscode.Comment = {
          body: new vscode.MarkdownString(comment.message),
          mode: vscode.CommentMode.Preview,
          author: { name: 'Local reviewer' },
          contextValue: 'virtualPr.comment.editable',
          label: comment.updatedAt ? 'review · edited' : 'review',
        };
        this.renderedCommentTargets.set(reviewComment, { commentId: comment.id });
        const replies: vscode.Comment[] = (comment.replies || []).map((reply) => {
          const rendered: vscode.Comment = {
            body: new vscode.MarkdownString(reply.message),
            mode: vscode.CommentMode.Preview,
            author: { name: reply.author === 'codex' ? 'Codex' : 'Local reviewer' },
            contextValue: `virtualPr.reply.${reply.author}`,
            label: reply.author === 'codex'
              ? 'AI response'
              : [reply.pending ? 'pending follow-up' : 'follow-up', reply.updatedAt ? 'edited' : '']
                .filter(Boolean)
                .join(' · '),
            timestamp: new Date(reply.createdAt),
          };
          if (reply.author === 'reviewer') {
            this.renderedCommentTargets.set(rendered, { commentId: comment.id, replyId: reply.id });
          }
          return rendered;
        });
        const thread = this.comments.createCommentThread(document.uri, range, [reviewComment, ...replies]);
        if (comment.status === 'outdated') {
          thread.range = undefined;
        }
        thread.canReply = comment.status !== 'resolved' && this.state.status !== 'ai-working'
          ? { name: 'Local reviewer' }
          : false;
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        thread.contextValue = `virtualPr.comment.${comment.status}`;
        thread.label = comment.status;
        thread.state = comment.status === 'resolved'
          ? vscode.CommentThreadState.Resolved
          : vscode.CommentThreadState.Unresolved;
        this.commentThreads.set(comment.id, thread);
      } catch {
        continue;
      }
    }
  }

  private async decorate(editor: vscode.TextEditor | undefined): Promise<void> {
    if (!editor || !this.state || !this.isWorkspaceFile(editor.document.uri)) {
      return;
    }
    const relative = path.relative(this.root, editor.document.uri.fsPath).split(path.sep).join('/');
    const change = this.changes.find((candidate) => candidate.path === relative);
    if (!change) {
      editor.setDecorations(this.changedLines, []);
      return;
    }
    const ranges = await this.git.headRanges(this.state.baseCommit, change);
    editor.setDecorations(this.changedLines, ranges.map((range) => new vscode.Range(
      Math.max(0, range.start - 1),
      0,
      Math.max(0, range.end - 1),
      0,
    )));
  }

  private workspaceUri(file: string): vscode.Uri {
    const absolute = path.resolve(this.root, file);
    const prefix = this.root.endsWith(path.sep) ? this.root : `${this.root}${path.sep}`;
    if (absolute !== this.root && !absolute.startsWith(prefix)) {
      throw new Error(`Path escapes the workspace: ${file}`);
    }
    return vscode.Uri.file(absolute);
  }

  private isWorkspaceFile(uri: vscode.Uri): boolean {
    if (uri.scheme !== 'file') {
      return false;
    }
    const relative = path.relative(this.root, uri.fsPath);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }

  private requireState(): VirtualPrState | undefined {
    if (!this.state) {
      void vscode.window.showInformationMessage('Create a Virtual PR first.');
    }
    return this.state;
  }

  private save(): Thenable<void> {
    return this.context.workspaceState.update(STATE_KEY, this.state);
  }

  dispose(): void {
    for (const thread of this.commentThreads.values()) {
      thread.dispose();
    }
    this.commentThreads.clear();
    this.comments.dispose();
    this.changedLines.dispose();
    this.output.dispose();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    void vscode.window.showInformationMessage('Local Virtual PR requires an open workspace folder.');
    return;
  }
  const controller = new VirtualPrController(context, root);
  context.subscriptions.push(controller);
  try {
    await controller.initialize();
  } catch (error) {
    void vscode.window.showErrorMessage(`Local Virtual PR requires a Git workspace: ${String(error)}`);
  }
}

export function deactivate(): void {}

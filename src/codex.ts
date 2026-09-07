import { execFile, spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import * as vscode from 'vscode';
import {
  buildCodexTurnParams,
  CodexModel,
  isAppServerHelp,
  normalizeCodexModels,
} from './core';

type ApprovalPolicy = 'never' | 'on-request' | 'untrusted';

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { message?: string };
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface TurnResult {
  threadId: string;
  message: string;
}

export interface CodexRunSettings {
  outputSchema?: Record<string, unknown>;
  model?: string;
  effort?: string;
}

function supportsAppServer(candidate: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      candidate,
      ['app-server', '--help'],
      { timeout: 5_000, encoding: 'utf8' },
      (error, stdout, stderr) => resolve(!error && isAppServerHelp(`${stdout}${stderr}`)),
    );
  });
}

export async function discoverCodexPath(): Promise<string> {
  const configured = vscode.workspace.getConfiguration('virtualPr').get<string>('codexPath', '').trim();
  const candidates: string[] = configured ? [configured] : [];
  const openAi = vscode.extensions.getExtension('openai.chatgpt');
  if (openAi) {
    const platformDirectory = process.platform === 'darwin'
      ? `macos-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`
      : process.platform === 'win32'
        ? `windows-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`
        : `linux-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`;
    candidates.push(path.join(
      openAi.extensionPath,
      'bin',
      platformDirectory,
      process.platform === 'win32' ? 'codex.exe' : 'codex',
    ));
  }
  if (process.platform === 'darwin') {
    candidates.push('/Applications/ChatGPT.app/Contents/Resources/codex');
  }
  candidates.push('codex');

  for (const candidate of [...new Set(candidates)]) {
    if (candidate.includes(path.sep)) {
      try {
        await fs.access(candidate);
      } catch {
        continue;
      }
    }
    if (await supportsAppServer(candidate)) {
      return candidate;
    }
  }
  throw new Error('A Codex binary with app-server support was not found. Set virtualPr.codexPath.');
}

export class CodexAppServer {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly lines: readline.Interface;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly completedTurns = new Map<string, { status: string; error?: string }>();
  private readonly turnWaiters = new Map<string, PendingRequest>();
  private readonly turnMessages = new Map<string, string>();
  private nextId = 1;

  private constructor(
    binary: string,
    private readonly cwd: string,
    private readonly output: vscode.OutputChannel,
  ) {
    this.process = spawn(binary, ['app-server', '--stdio'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.lines = readline.createInterface({ input: this.process.stdout });
    this.lines.on('line', (line) => this.receive(line));
    this.process.stderr.on('data', (chunk) => this.output.append(chunk.toString()));
    this.process.on('exit', (code, signal) => {
      const error = new Error(`Codex app-server exited (${code ?? signal ?? 'unknown'}).`);
      for (const request of this.pending.values()) {
        request.reject(error);
      }
      for (const waiter of this.turnWaiters.values()) {
        waiter.reject(error);
      }
      this.pending.clear();
      this.turnWaiters.clear();
    });
  }

  static async run(
    binary: string,
    cwd: string,
    existingThreadId: string | undefined,
    prompt: string,
    approvalPolicy: ApprovalPolicy,
    output: vscode.OutputChannel,
    settings: CodexRunSettings = {},
  ): Promise<TurnResult> {
    const server = new CodexAppServer(binary, cwd, output);
    try {
      await server.initialize();
      const threadId = await server.openThread(existingThreadId, approvalPolicy);
      const response = await server.request('turn/start', buildCodexTurnParams({
        threadId,
        prompt,
        cwd,
        approvalPolicy,
        ...settings,
      })) as { turn: { id: string } };
      const completion = await server.waitForTurn(response.turn.id);
      if (completion.status !== 'completed') {
        throw new Error(completion.error || `Codex turn ended with ${completion.status}.`);
      }
      return { threadId, message: server.turnMessages.get(response.turn.id) || '' };
    } finally {
      server.dispose();
    }
  }

  static async listModels(
    binary: string,
    cwd: string,
    output: vscode.OutputChannel,
  ): Promise<CodexModel[]> {
    const server = new CodexAppServer(binary, cwd, output);
    try {
      await server.initialize();
      const response = await server.request('model/list', { limit: 100, includeHidden: false });
      const models = normalizeCodexModels(response);
      if (models.length === 0) {
        throw new Error('Codex App Server returned no selectable models.');
      }
      return models;
    } finally {
      server.dispose();
    }
  }

  private async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'local-virtual-pr', title: 'Local Virtual PR', version: '0.8.0' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    this.notify('initialized');
  }

  private async openThread(existingThreadId: string | undefined, approvalPolicy: ApprovalPolicy): Promise<string> {
    if (existingThreadId) {
      try {
        const resumed = await this.request('thread/resume', {
          threadId: existingThreadId,
          cwd: this.cwd,
          approvalPolicy,
          sandbox: 'workspace-write',
          excludeTurns: true,
        }) as { thread: { id: string } };
        return resumed.thread.id;
      } catch (error) {
        this.output.appendLine(`Could not resume ${existingThreadId}: ${String(error)}`);
      }
    }

    const started = await this.request('thread/start', {
      cwd: this.cwd,
      approvalPolicy,
      sandbox: 'workspace-write',
      serviceName: 'Local Virtual PR',
      ephemeral: false,
      developerInstructions: 'Edit only the current workspace. Address the requested implementation or local review feedback, preserve unrelated behavior, and verify the result.',
    }) as { thread: { id: string } };
    return started.thread.id;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ method, id, params });
    });
  }

  private notify(method: string): void {
    this.write({ method });
  }

  private write(message: unknown): void {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.output.appendLine(`Invalid app-server message: ${line}`);
      return;
    }

    if (typeof message.method === 'string' && typeof message.id === 'number') {
      void this.handleServerRequest(message.method, message.id, message.params as Record<string, unknown>);
      return;
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      const response = message as unknown as JsonRpcResponse;
      if (response.error) {
        pending.reject(new Error(response.error.message || 'Codex app-server request failed.'));
      } else {
        pending.resolve(response.result);
      }
      return;
    }
    if (typeof message.method === 'string') {
      this.handleNotification(message.method, message.params as Record<string, unknown>);
    }
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    const turnId = typeof params.turnId === 'string' ? params.turnId : undefined;
    if (method === 'item/agentMessage/delta' && turnId && typeof params.delta === 'string') {
      this.turnMessages.set(turnId, `${this.turnMessages.get(turnId) || ''}${params.delta}`);
      this.output.append(params.delta);
      return;
    }
    if (method === 'item/completed') {
      const item = params.item as Record<string, unknown> | undefined;
      if (turnId && item?.type === 'agentMessage' && typeof item.text === 'string') {
        this.turnMessages.set(turnId, item.text);
      }
      return;
    }
    if (method === 'turn/completed') {
      const turn = params.turn as { id?: string; status?: string; error?: { message?: string } } | undefined;
      if (!turn?.id) {
        return;
      }
      const completion = { status: turn.status || 'failed', error: turn.error?.message };
      this.completedTurns.set(turn.id, completion);
      const waiter = this.turnWaiters.get(turn.id);
      if (waiter) {
        this.turnWaiters.delete(turn.id);
        waiter.resolve(completion);
      }
    }
  }

  private async handleServerRequest(method: string, id: number, params: Record<string, unknown>): Promise<void> {
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const detail = method.includes('commandExecution')
        ? String(params.command || params.reason || 'Run a command')
        : String(params.reason || 'Apply file changes');
      const choice = await vscode.window.showWarningMessage(
        `Codex requests approval: ${detail}`,
        { modal: true },
        'Allow once',
        'Allow for session',
        'Decline',
      );
      const decision = choice === 'Allow once' ? 'accept' : choice === 'Allow for session' ? 'acceptForSession' : 'decline';
      this.write({ id, result: { decision } });
      return;
    }
    if (method === 'item/tool/requestUserInput') {
      const questions = Array.isArray(params.questions) ? params.questions as Array<Record<string, unknown>> : [];
      const answers: Record<string, { answers: string[] }> = {};
      for (const question of questions) {
        const options = Array.isArray(question.options) ? question.options as Array<Record<string, unknown>> : [];
        const answer = options.length > 0
          ? await vscode.window.showQuickPick(options.map((option) => ({
            label: String(option.label || ''),
            description: String(option.description || ''),
          })), { title: String(question.question || question.header || 'Codex question'), ignoreFocusOut: true })
          : await vscode.window.showInputBox({
            title: String(question.header || 'Codex question'),
            prompt: String(question.question || ''),
            password: question.isSecret === true,
            ignoreFocusOut: true,
          });
        answers[String(question.id)] = { answers: answer ? [typeof answer === 'string' ? answer : answer.label] : [] };
      }
      this.write({ id, result: { answers } });
      return;
    }
    this.write({ id, error: { code: -32601, message: `Unsupported client request: ${method}` } });
  }

  private waitForTurn(turnId: string): Promise<{ status: string; error?: string }> {
    const completed = this.completedTurns.get(turnId);
    if (completed) {
      return Promise.resolve(completed);
    }
    return new Promise((resolve, reject) => this.turnWaiters.set(turnId, { resolve, reject }));
  }

  private dispose(): void {
    this.lines.close();
    this.process.stdin.end();
    this.process.kill();
  }
}

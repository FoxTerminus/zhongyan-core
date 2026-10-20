import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { ToolRegistry, toolFailure, type ReadOnlyToolSpec, type ToolResult } from '../tools/registry.js';
import { PLAN_APP, PlanAuthError, type PlanCredentialLease, type PlanCredentialProvider } from '../auth/types.js';
import { DynamicToolCall, KNOWLEDGE_TOOL_INSTRUCTIONS, KNOWLEDGE_TOOL_NAMES } from './codex-tools.js';
import {
  RuntimeCancelledError, RuntimeInputRequiredError, RuntimeUnavailableError,
  type AgentRuntime, type RuntimeEvent, type RuntimeInput, type RuntimeStatus,
} from './types.js';

type ObjectValue = Record<string, unknown>;
type Pending = {
  resolve(value: ObjectValue): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  onResponse?(value: ObjectValue): void;
};
type ActiveRun = {
  threadId: string | null;
  turnId: string | null;
  sink(event: RuntimeEvent): void;
  resolve(): void;
  reject(error: Error): void;
  streamedItems: Set<string>;
  toolsController: AbortController;
  turnAcknowledged: Promise<string>;
  acknowledgeTurn(id: string): void;
  toolCalls: Map<string, { signature: string; result: Promise<ToolResult> }>;
  toolsInFlight: number;
  toolRequestsWaiting: number;
  earlyNotifications: ObjectValue[];
  earlyNotificationBytes: number;
};
type Launch = (command: string, args: string[], cwd: string, environment?: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams;

export type CodexRuntimeOptions = {
  command?: string;
  cwd: string;
  model?: string;
  requestTimeoutMs?: number;
  knowledgeTools?: 'disabled' | 'experimental';
  toolRegistry?: ToolRegistry;
  planCredentials?: PlanCredentialProvider;
  appTitle?: string;
};

function object(value: unknown): ObjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as ObjectValue : {};
}
function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Invoke the executable directly, never interpolate a command through a shell.
 * npm Windows shims are resolved via package metadata; no user-specific path or
 * package version is embedded here. Explicit paths to native binaries also work.
 */
export function resolveCodexCommand(command = 'codex'): string {
  if (process.platform !== 'win32') return command;
  if (/\.exe$/i.test(command)) return command;
  const directories = isAbsolute(command)
    ? [dirname(command)]
    : (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const directory of directories) {
    const direct = join(directory, 'codex.exe');
    if (existsSync(direct)) return direct;
    const packageRoot = join(directory, 'node_modules', '@openai', 'codex');
    if (!existsSync(join(packageRoot, 'package.json'))) continue;
    try {
      const require = createRequire(join(packageRoot, 'package.json'));
      const platformPackage = dirname(require.resolve(`@openai/codex-win32-${process.arch}/package.json`));
      const target = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
      // The bin location changed in earlier releases. Both belong to the package.
      for (const folder of ['bin', 'codex']) {
        const executable = join(platformPackage, 'vendor', `${target}-pc-windows-msvc`, folder, 'codex.exe');
        if (existsSync(executable)) return executable;
      }
    } catch { /* Continue checking other PATH entries. */ }
  }
  throw new RuntimeUnavailableError('找不到 Codex 原生程序，请安装 Codex CLI 或设置 AGENT_CODEX_COMMAND。');
}

/** Only OS/runtime discovery, network routing and Codex-owned login locations cross this boundary. */
export function buildCodexEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set([
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'HOME', 'USERPROFILE',
    'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL',
    'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  ]);
  return Object.fromEntries(Object.entries(environment).filter(([name]) => allowed.has(name.toUpperCase())));
}

function spawnCodex(command: string, args: string[], cwd: string, environment?: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  return spawn(resolveCodexCommand(command), args, {
    cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
    // Do not inherit unrelated service credentials or accidentally select paid API auth.
    env: environment ?? buildCodexEnvironment(process.env),
  });
}

/**
 * Stable JSON-RPC subset, checked against locally generated Codex 0.154 types.
 * A single process runs at most one task. The durable queue belongs to the app.
 * CLI auth stays owned by Codex; this adapter never reads or copies token files.
 *
 * read-only does NOT isolate host reads. Production must use a dedicated
 * account/container and explicitly provisioned tools, not a user's desktop home.
 */
export class CodexRuntime implements AgentRuntime {
  private readonly options: CodexRuntimeOptions;
  private readonly launch: Launch;
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<string, Pending>();
  private sequence = 0;
  private active: ActiveRun | null = null;
  private reserved = false;
  private stopped = false;
  private planLease: PlanCredentialLease | null = null;
  private statusPreparation: Promise<RuntimeStatus> | null = null;
  private lastStatus: RuntimeStatus | null = null;
  private readonly toolRegistry: ToolRegistry | null;
  private readonly dynamicToolSpecs: (ReadOnlyToolSpec & { type: 'function'; deferLoading: false })[];

  constructor(options: CodexRuntimeOptions, launch: Launch = spawnCodex) {
    this.options = { ...options, cwd: resolve(options.cwd) };
    this.launch = launch;
    this.toolRegistry = options.knowledgeTools === 'experimental' ? options.toolRegistry ?? null : null;
    this.dynamicToolSpecs = (this.toolRegistry?.definitions() ?? [])
      .filter(spec => KNOWLEDGE_TOOL_NAMES.has(spec.name))
      .map(spec => ({ ...spec, type: 'function', deferLoading: false }));
  }

  private async connect(): Promise<void> {
    if (this.stopped) throw new RuntimeUnavailableError('Agent 运行环境已关闭。');
    if (this.ready) return this.ready;
    this.ready = this.initialize().catch(error => {
      this.terminate();
      throw error;
    });
    return this.ready;
  }

  private async initialize(): Promise<void> {
    // This initial adapter deliberately exposes no inherited desktop integrations.
    const args = ['app-server', '--listen', 'stdio://'];
    const config = [
      `model_provider="${this.options.planCredentials ? 'openai_chatgpt_plan' : 'openai'}"`, 'approval_policy="never"', 'sandbox_mode="read-only"',
      'mcp_servers={}', 'web_search="disabled"', 'analytics.enabled=false',
      'shell_environment_policy.inherit="none"',
    ];
    if (this.options.planCredentials) {
      if (!this.planLease) throw new RuntimeUnavailableError('本应用的 ChatGPT 授权尚未就绪。');
      config.push(
        'model_providers.openai_chatgpt_plan.name="ChatGPT plan"',
        'model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"',
        'model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"',
        'model_providers.openai_chatgpt_plan.wire_api="responses"',
        'model_providers.openai_chatgpt_plan.requires_openai_auth=false',
        'model_providers.openai_chatgpt_plan.supports_websockets=false',
      );
    }
    for (const entry of config) args.push('-c', entry);
    for (const feature of [
      'apps', 'plugins', 'hooks', 'browser_use', 'computer_use', 'in_app_browser',
      'shell_tool', 'unified_exec', 'code_mode', 'code_mode_host', 'view_image',
      'multi_agent', 'skill_search', 'skill_mcp_dependency_install', 'workspace_dependencies',
    ]) args.push('--disable', feature);
    const environment = buildCodexEnvironment(process.env);
    if (this.planLease) {
      // Ignore even differently-cased inherited home variables on Windows.
      for (const name of Object.keys(environment)) {
        if (['CODEX_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'].includes(name.toUpperCase())) delete environment[name];
      }
      environment.CODEX_HOME = this.planLease.codexHome;
      environment.HOME = environment.USERPROFILE = dirname(this.planLease.codexHome);
      environment.ACCESS_TOKEN = this.planLease.accessToken;
    }
    const child = this.launch(this.options.command ?? 'codex', args, this.options.cwd, environment);
    this.child = child;
    // stderr may contain private paths or auth information: drain, never expose.
    child.stderr.resume();
    child.stdin.on('error', () => this.failed(child, new RuntimeUnavailableError('Agent 通信已中断。')));
    child.once('error', () => this.failed(child, new RuntimeUnavailableError('无法启动 Codex，请检查 CLI 安装和运行目录。')));
    child.once('exit', () => this.failed(child, new RuntimeUnavailableError('Agent 进程已退出，可以重试任务。')));
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', line => {
      try { this.receive(object(JSON.parse(line))); }
      catch { this.failed(child, new RuntimeUnavailableError('Agent 返回了不兼容的通信数据。')); }
    });
    await this.request('initialize', {
      clientInfo: { ...PLAN_APP, name: this.planLease?.appName ?? PLAN_APP.name, title: this.options.appTitle ?? PLAN_APP.title },
      ...(this.dynamicToolSpecs.length ? { capabilities: { experimentalApi: true } } : {}),
    });
    this.send({ method: 'initialized', params: {} });
  }

  private send(message: ObjectValue): void {
    if (!this.child?.stdin.writable) throw new RuntimeUnavailableError('Agent 尚未连接。');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private request(
    method: string, params: ObjectValue,
    timeout = this.options.requestTimeoutMs ?? 15_000,
    onResponse?: (value: ObjectValue) => void,
  ): Promise<ObjectValue> {
    const id = ++this.sequence;
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new RuntimeUnavailableError(`Agent 请求超时（${method}），请检查连接后重试。`));
      }, timeout);
      this.pending.set(String(id), { resolve: resolveResult, reject, timer, onResponse });
      try { this.send({ id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        reject(error);
      }
    });
  }

  private receive(message: ObjectValue): void {
    const method = string(message.method);
    if (message.id !== undefined && method) {
      if (method === 'item/tool/call' && this.dynamicToolSpecs.length) {
        const child = this.child;
        void this.handleToolCall(message).catch(() => {
          if (child) this.failed(child, new RuntimeUnavailableError('资料工具通信失败，任务已停止。'));
        });
        return;
      }
      this.declineRequest(message);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(String(message.id));
      if (message.error) {
        // Provider errors may echo request data or credentials. Surface only code.
        const code = Number(object(message.error).code);
        pending.reject(new RuntimeUnavailableError(`Agent 请求失败${Number.isFinite(code) ? `（${code}）` : ''}。请检查运行环境与协议兼容性。`));
      } else {
        const result = object(message.result);
        try {
          // readline may dispatch several messages synchronously from one chunk.
          // Establish response-dependent ownership before processing the next line.
          pending.onResponse?.(result);
          pending.resolve(result);
        } catch (error) {
          pending.reject(error instanceof RuntimeUnavailableError || error instanceof RuntimeCancelledError
            ? error : new RuntimeUnavailableError('Agent 执行确认失败，任务已停止。'));
        }
      }
      return;
    }
    const active = this.active;
    if (!active || active.toolsController.signal.aborted || !method) return;
    if (!['item/agentMessage/delta', 'item/completed', 'error', 'turn/completed'].includes(method)) return;
    const params = object(message.params);
    if (params.threadId !== active.threadId) return;
    const eventTurnId = method === 'turn/completed' ? string(object(params.turn).id) : string(params.turnId);
    // These notification types require a turn identity in the generated schema.
    // Neither a missing ID nor turn/started may assign ownership to this run.
    if (!eventTurnId) return;
    if (!active.turnId) {
      const bytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
      if (active.earlyNotifications.length >= 128 || active.earlyNotificationBytes + bytes > 262_144) {
        active.reject(new RuntimeUnavailableError('执行确认前的消息超过上限，Agent 已停止。'));
        return;
      }
      active.earlyNotifications.push(message);
      active.earlyNotificationBytes += bytes;
      return;
    }
    if (eventTurnId !== active.turnId) return;
    if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      if (typeof params.itemId === 'string') active.streamedItems.add(params.itemId);
      active.sink({ type: 'message_delta', data: { text: params.delta } });
    }
    if (method === 'item/completed') {
      const item = object(params.item);
      // Some providers only send the completed item, not deltas.
      if (item.type === 'agentMessage' && typeof item.text === 'string'
          && !active.streamedItems.has(String(item.id))) {
        active.streamedItems.add(String(item.id));
        active.sink({ type: 'message_delta', data: { text: item.text } });
      }
    }
    if (method === 'error') {
      if (params.willRetry === true) {
        active.sink({ type: 'activity', data: { message: '模型连接暂时中断，Agent 正在重试。' } });
      } else active.reject(new RuntimeUnavailableError('Agent 执行失败，请检查模型访问权限或网络连接。'));
    }
    if (method === 'turn/completed') {
      const status = object(params.turn).status;
      if (status === 'completed') active.resolve();
      else if (status === 'interrupted') active.reject(new RuntimeCancelledError());
      else active.reject(new RuntimeUnavailableError('Agent 未成功完成任务，可以检查连接后重试。'));
    }
  }

  private acknowledgeStartedTurn(active: ActiveRun, result: ObjectValue): void {
    if (this.active !== active || active.toolsController.signal.aborted) throw new RuntimeCancelledError();
    const turnId = string(object(result.turn).id);
    if (!turnId) throw new RuntimeUnavailableError('Agent 未返回有效的执行标识。');
    active.turnId = turnId;
    active.acknowledgeTurn(turnId);
    const earlyNotifications = active.earlyNotifications;
    active.earlyNotifications = [];
    active.earlyNotificationBytes = 0;
    for (const notification of earlyNotifications) {
      if (this.active !== active || active.toolsController.signal.aborted) break;
      this.receive(notification);
    }
  }

  private async handleToolCall(message: ObjectValue): Promise<void> {
    const child = this.child;
    const active = this.active;
    const respond = (result: ToolResult) => {
      if (this.child !== child || !child?.stdin.writable) return;
      this.send({ id: message.id, result: {
        contentItems: [{ type: 'inputText', text: result.text }], success: result.success,
      } });
    };
    const parsed = DynamicToolCall.safeParse(message.params);
    if (!parsed.success) {
      respond(toolFailure('invalid_request', '资料工具请求格式不兼容。'));
      return;
    }
    const call = parsed.data;
    if (!active || active.toolsController.signal.aborted || call.threadId !== active.threadId) {
      respond(toolFailure('invalid_context', '此调用不属于正在执行的对话。'));
      return;
    }
    if (call.namespace !== null || !KNOWLEDGE_TOOL_NAMES.has(call.tool)
        || !this.dynamicToolSpecs.some(spec => spec.name === call.tool)) {
      respond(toolFailure('unknown_tool', '此资料工具未被授权。'));
      return;
    }
    // A request may arrive before the turn/start response. Only that response
    // establishes the turn owned by this run; a tool request cannot assign it.
    if (active.toolRequestsWaiting >= 8) {
      respond(toolFailure('tool_limit_reached', '等待中的资料调用过多，请缩小范围。'));
      return;
    }
    active.toolRequestsWaiting++;
    let onAbort: () => void = () => {};
    const aborted = new Promise<null>(resolveAbort => {
      onAbort = () => resolveAbort(null);
      active.toolsController.signal.addEventListener('abort', onAbort, { once: true });
    });
    let turnId: string | null;
    try { turnId = await Promise.race([active.turnAcknowledged, aborted]); }
    finally {
      active.toolRequestsWaiting--;
      active.toolsController.signal.removeEventListener('abort', onAbort);
    }
    if (!turnId || this.active !== active || active.toolsController.signal.aborted) return;
    if (call.turnId !== turnId) {
      respond(toolFailure('invalid_context', '此调用不属于正在执行的任务。'));
      return;
    }
    const signature = JSON.stringify({ tool: call.tool, arguments: call.arguments });
    let pending = active.toolCalls.get(call.callId);
    if (pending && pending.signature !== signature) {
      respond(toolFailure('call_conflict', '该资料调用标识已用于其他参数。'));
      return;
    }
    if (!pending) {
      if (active.toolCalls.size >= 32 || active.toolsInFlight >= 2) {
        respond(toolFailure('tool_limit_reached', '资料调用数量达到本次任务上限，请缩小范围。'));
        return;
      }
      active.toolsInFlight++;
      active.sink({ type: 'activity', data: { message: call.tool === 'knowledge_search' ? '正在检索已保存资料。' : '正在读取指定版本的资料。' } });
      const result = this.toolRegistry!.call(call.tool, call.arguments, active.toolsController.signal)
        .finally(() => { active.toolsInFlight--; });
      pending = { signature, result };
      active.toolCalls.set(call.callId, pending);
    }
    const result = await pending.result;
    // Never send a delayed result into a cancelled, completed or subsequent run.
    if (this.active === active && !active.toolsController.signal.aborted) respond(result);
  }

  private declineRequest(message: ObjectValue): void {
    const method = String(message.method);
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      this.send({ id: message.id, result: { decision: 'decline' } });
    } else {
      this.send({ id: message.id, error: { code: -32601, message: 'This client does not authorize this request.' } });
    }
    const active = this.active;
    if (active) {
      const message = '此步骤需要额外输入或权限，当前客户端尚未接入该确认流程；操作未被授权。';
      active.sink({ type: 'approval_required', data: { message } });
      active.reject(new RuntimeInputRequiredError(message));
    }
  }

  async getStatus(): Promise<RuntimeStatus> {
    // Status polls must not rotate a process that belongs to an active task.
    if (this.options.planCredentials && this.reserved) return this.lastStatus ?? {
      provider: 'codex', models: [], available: false, authenticated: null, message: 'Agent 正在准备独立授权。',
    };
    if (this.statusPreparation) return this.statusPreparation;
    this.statusPreparation = this.readStatus(false);
    try { return this.lastStatus = await this.statusPreparation; }
    finally { this.statusPreparation = null; }
  }

  private async readStatus(allowRefresh: boolean, signal?: AbortSignal): Promise<RuntimeStatus> {
    const base = { provider: 'codex', models: [] };
    let authenticated: boolean | null = null;
    try {
      if (this.options.planCredentials) {
        const inspection = await this.options.planCredentials.inspect();
        authenticated = inspection.authenticated;
        if (!authenticated) return { ...base, available: false, authenticated, message: inspection.message };
        const lease = await this.options.planCredentials.acquire(allowRefresh, signal);
        if (this.planLease?.revision !== lease.revision || this.planLease.codexHome !== lease.codexHome) {
          this.terminate();
          this.planLease = lease;
        }
      }
      if (signal?.aborted) throw new RuntimeCancelledError();
      await this.connect();
      if (!this.options.planCredentials) {
        const account = await this.request('account/read', { refreshToken: false });
        const type = object(account.account).type;
        if (type !== 'chatgpt') {
          return {
            ...base, available: false, authenticated: Boolean(type),
            message: type
              ? '当前 Codex 使用的不是 ChatGPT 登录。为避免额外 API 费用，此连接未启用。'
              : 'Codex 尚未登录 ChatGPT。请在运行环境中完成官方登录后重试。',
          };
        }
      }
      const models: RuntimeStatus['models'] = [];
      const cursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const page = await this.request('model/list', { cursor, limit: 100, includeHidden: false });
        if (!Array.isArray(page.data)) throw new RuntimeUnavailableError('Agent 模型目录格式不兼容。');
        for (const entry of page.data) {
          const model = object(entry);
          const id = string(model.model) ?? string(model.id);
          if (id && !models.some(item => item.id === id)) {
            models.push({ id, displayName: string(model.displayName) ?? id });
          }
        }
        cursor = string(page.nextCursor) ?? null;
        if (cursor && cursors.has(cursor)) throw new RuntimeUnavailableError('Agent 模型目录分页异常。');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      const configured = this.options.model;
      const available = models.length > 0 && (!configured || models.some(model => model.id === configured));
      return {
        provider: 'codex', available, authenticated: true, models,
        message: available ? '已检测到 ChatGPT 登录与模型目录；实际推理权限尚待运行验证。'
          : '当前配置的模型不可用。请检查模型目录和账号权限。',
      };
    } catch (error) {
      return {
        ...base, available: false, authenticated,
        message: error instanceof RuntimeUnavailableError || error instanceof PlanAuthError ? error.message : '暂时无法连接 Codex 运行环境。',
      };
    }
  }

  async run(input: RuntimeInput, sink: (event: RuntimeEvent) => void, signal: AbortSignal): Promise<void> {
    if (this.reserved) throw new RuntimeUnavailableError('Agent 正在处理另一项任务，请排队后重试。');
    if (signal.aborted) throw new RuntimeCancelledError();
    this.reserved = true;
    let cancel: () => void = () => {};
    let fail: ((error: Error) => void) | null = null;
    try {
      // Finish an already-running status probe before replacing its child process.
      if (this.statusPreparation) await this.statusPreparation;
      const status = this.lastStatus = await this.readStatus(true, signal);
      if (signal.aborted) throw new RuntimeCancelledError();
      if (!status.available) throw new RuntimeUnavailableError(status.message);
      // An empty TOML map may merge with an existing user config. Inspect the
      // effective result before opening any thread (which starts MCP servers).
      // Keep the response in memory only; do not persist/log configuration.
      const configuration = await this.request('config/read', { includeLayers: false, cwd: this.options.cwd });
      if (!configuration.config || typeof configuration.config !== 'object') {
        throw new RuntimeUnavailableError('无法验证 Agent 工具配置，已停止执行。');
      }
      const config = object(configuration.config);
      const inheritedServers = Object.values(object(config.mcp_servers));
      if (inheritedServers.some(server => object(server).enabled !== false)) {
        throw new RuntimeUnavailableError('此运行环境包含未接入权限管理的 MCP 工具，请使用独立 Codex 配置目录。');
      }
      if (object(config.model_providers).openai) {
        throw new RuntimeUnavailableError('此运行环境覆盖了 OpenAI 服务配置，请使用独立 Codex 配置目录。');
      }
      if (this.options.planCredentials) {
        const provider = object(object(config.model_providers).openai_chatgpt_plan);
        if (config.model_provider !== 'openai_chatgpt_plan'
            || provider.base_url !== 'https://api.openai.com/v1' || provider.env_key !== 'ACCESS_TOKEN'
            || provider.wire_api !== 'responses' || provider.requires_openai_auth !== false
            || provider.supports_websockets !== false
            || Object.keys(object(provider.http_headers)).length || Object.keys(object(provider.env_http_headers)).length
            || Object.keys(object(provider.query_params)).length || provider.experimental_bearer_token) {
          throw new RuntimeUnavailableError('ChatGPT 套餐运行配置未通过校验，已停止执行。');
        }
      }
      if (signal.aborted) throw new RuntimeCancelledError();
      const toolsController = new AbortController();
      let acknowledgeTurn: (id: string) => void = () => {};
      const turnAcknowledged = new Promise<string>(resolveTurn => { acknowledgeTurn = resolveTurn; });
      const completion = new Promise<void>((resolveRun, rejectRun) => {
        fail = error => { toolsController.abort(); rejectRun(error); };
        this.active = {
          threadId: input.threadId, turnId: null, sink,
          resolve: () => { toolsController.abort(); resolveRun(); }, reject: fail, streamedItems: new Set(),
          toolsController, turnAcknowledged, acknowledgeTurn, toolCalls: new Map(), toolsInFlight: 0, toolRequestsWaiting: 0,
          earlyNotifications: [], earlyNotificationBytes: 0,
        };
      });
      // Register a rejection handler before any turn-start RPC can emit events.
      void completion.catch(() => {});
      cancel = () => { fail?.(new RuntimeCancelledError()); };
      signal.addEventListener('abort', cancel, { once: true });
      const prepareAndRun = async (): Promise<void> => {
        const thread = await this.request(input.threadId ? 'thread/resume' : 'thread/start', {
          ...(input.threadId ? { threadId: input.threadId, excludeTurns: true } : {}),
          ...(this.options.model ? { model: this.options.model } : {}),
          cwd: this.options.cwd, approvalPolicy: 'never', sandbox: 'read-only',
          modelProvider: this.options.planCredentials ? 'openai_chatgpt_plan' : 'openai',
          ...(this.dynamicToolSpecs.length ? {
            developerInstructions: KNOWLEDGE_TOOL_INSTRUCTIONS,
            // 0.154 resumes persisted definitions; thread/resume has no dynamicTools field.
            ...(!input.threadId ? { dynamicTools: this.dynamicToolSpecs } : {}),
          } : {}),
        });
        const threadId = string(object(thread.thread).id);
        if (!threadId) throw new RuntimeUnavailableError('Agent 未返回有效的会话标识。');
        if (signal.aborted || !this.active) throw new RuntimeCancelledError();
        this.active.threadId = threadId;
        sink({ type: 'thread_started', data: { threadId } });
        // Existing runtime history is authoritative. Do not silently recreate
        // failed resumes, inject duplicate history, or lose hidden tool context.
        const active = this.active;
        await this.request('turn/start', {
          threadId, input: [{ type: 'text', text: input.text }],
          effort: input.effort, cwd: this.options.cwd, approvalPolicy: 'never',
          sandboxPolicy: { type: 'readOnly', networkAccess: false },
          ...(this.options.model ? { model: this.options.model } : {}),
        }, undefined, result => this.acknowledgeStartedTurn(active, result));
        await completion;
      };
      // Early cancellation/failure must stop a pending start. Success must still
      // await the turn/start acknowledgement so no RPC is left owned by a prior run.
      const earlyFailure = completion.then(() => new Promise<void>(() => {}));
      await Promise.race([prepareAndRun(), earlyFailure]);
    } catch (error) {
      // A timed-out start may already have begun inference. Interrupt if known,
      // then close this process so no task is left running without an owner.
      await this.interrupt();
      this.terminate();
      throw error;
    } finally {
      signal.removeEventListener('abort', cancel);
      this.active?.toolsController.abort();
      this.active = null;
      this.reserved = false;
    }
  }

  private async interrupt(): Promise<void> {
    const active = this.active;
    if (!active?.threadId || !active.turnId || !this.child) return;
    try {
      await this.request('turn/interrupt', { threadId: active.threadId, turnId: active.turnId }, 1_000);
    } catch { /* Process termination below is the cancellation fallback. */ }
  }

  private failed(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.active?.reject(error);
    this.terminate(error);
  }

  private terminate(error = new RuntimeUnavailableError('Agent 连接已关闭。')): void {
    const child = this.child;
    this.active?.toolsController.abort();
    this.child = null;
    this.ready = null;
    this.lines?.close();
    this.lines = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    child?.stdin.destroy();
    child?.kill();
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.active?.reject(new RuntimeCancelledError());
    await this.interrupt();
    this.terminate();
    this.planLease = null;
    this.lastStatus = null;
  }
}

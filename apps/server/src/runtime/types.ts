export type RuntimeStatus = {
  provider: string;
  available: boolean;
  authenticated: boolean | null;
  message: string;
  models: { id: string; displayName: string }[];
};

export type RuntimeInput = {
  taskId: string;
  conversationId: string;
  text: string;
  effort: 'low' | 'medium' | 'high';
  threadId: string | null;
  history?: { role: string; text: string }[];
};

export type RuntimeEvent =
  | { type: 'message_delta'; data: { text: string } }
  | { type: 'activity'; data: { message: string } }
  | { type: 'thread_started'; data: { threadId: string } }
  | { type: 'approval_required'; data: { message: string } };

export interface AgentRuntime {
  /** Informational only; must not refresh authorization or gate an explicit task. */
  getStatus(): Promise<RuntimeStatus>;
  /** Owns execution readiness, including any authorized credential renewal. */
  run(input: RuntimeInput, sink: (event: RuntimeEvent) => void, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export class RuntimeUnavailableError extends Error {
  override name = 'RuntimeUnavailableError';
}
export class RuntimeInputRequiredError extends Error {
  override name = 'RuntimeInputRequiredError';
}
export class RuntimeInterruptedError extends Error {
  override name = 'RuntimeInterruptedError';
}
export class RuntimeCancelledError extends Error {
  override name = 'RuntimeCancelledError';
  constructor() { super('任务已取消。'); }
}

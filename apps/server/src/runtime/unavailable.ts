import { RuntimeUnavailableError, type AgentRuntime, type RuntimeStatus } from './types.js';

/** Offline mode never invents assistant text and never starts a model process. */
export class DisabledRuntime implements AgentRuntime {
  async getStatus(): Promise<RuntimeStatus> {
    return {
      provider: 'disabled',
      available: false,
      authenticated: null,
      message: '尚未连接 Agent 运行环境。会话可以保存，连接后可继续任务。',
      models: [],
    };
  }
  async run(): Promise<void> {
    throw new RuntimeUnavailableError((await this.getStatus()).message);
  }
  async close(): Promise<void> {}
}

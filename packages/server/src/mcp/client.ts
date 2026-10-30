export interface McpClientOptions {
  name: string;
  command?: string[];
  url?: string;
  readOnly?: boolean;
}

export class ServerMcpClient {
  readonly options: McpClientOptions;
  constructor(options: McpClientOptions) {
    this.options = options;
  }
  async listTools(): Promise<Array<{ name: string; description?: string }>> {
    return [];
  }
}

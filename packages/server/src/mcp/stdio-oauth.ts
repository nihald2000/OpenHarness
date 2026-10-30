export interface StdioOAuthToken {
  accessToken: string;
  expiresAt?: number;
}

export class StdioOAuthManager {
  private tokens = new Map<string, StdioOAuthToken>();

  setToken(serverName: string, token: StdioOAuthToken): void {
    this.tokens.set(serverName, { ...token });
  }

  getValidHeader(serverName: string, now = Date.now()): Record<string, string> {
    const tok = this.tokens.get(serverName);
    if (!tok) return {};
    if (tok.expiresAt && now >= tok.expiresAt) {
      this.tokens.delete(serverName);
      return {};
    }
    return { Authorization: `Bearer ${tok.accessToken}` };
  }
}

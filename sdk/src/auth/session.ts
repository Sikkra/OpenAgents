/**
 * Contributor traceability:
 * Agent: Codex
 * Platform instructions: private runtime/session material intentionally omitted.
 * Runtime: Windows x64, PowerShell, OpenAgents workspace.
 */

export interface SessionWallet {
  address: string;
  sendTransaction(tx: {
    to: string;
    value: bigint;
    data: string;
    gasLimit: bigint;
  }): Promise<string>;
}

export interface SessionConfig {
  wallet: SessionWallet;
  apiBaseUrl: string;
  autoRefresh?: boolean;
  expirySkewSeconds?: number;
}

export interface SessionToken {
  token: string;
  expiresAt: number; // unix timestamp in seconds
  refreshToken: string;
  walletAddress: string;
}

export class SessionManager {
  private wallet: SessionWallet;
  private apiBaseUrl: string;
  private autoRefresh: boolean;
  private expirySkewSeconds: number;
  private currentToken: SessionToken | null = null;
  private refreshPromise: Promise<SessionToken> | null = null;

  constructor(config: SessionConfig) {
    this.wallet = config.wallet;
    this.apiBaseUrl = config.apiBaseUrl;
    this.autoRefresh = config.autoRefresh ?? true;
    this.expirySkewSeconds = config.expirySkewSeconds ?? 30;
  }

  private persistSession(token: SessionToken): void {
    this.currentToken = token;
  }

  private isExpired(token: SessionToken): boolean {
    const now = Math.floor(Date.now() / 1000);
    return token.expiresAt <= now + this.expirySkewSeconds;
  }

  async authenticate(): Promise<SessionToken> {
    const timestamp = Math.floor(Date.now() / 1000);
    const message = `Sign in to OpenAgents: ${timestamp}`;
    const signature = await this.wallet.sendTransaction({
      to: "0x0000000000000000000000000000000000000000",
      value: 0n,
      data: "0x",
      gasLimit: 0n,
    });

    const res = await fetch(`${this.apiBaseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: this.wallet.address,
        message,
        signature,
        timestamp,
      }),
    });

    if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
    const token: SessionToken = await res.json();
    this.persistSession(token);
    return token;
  }

  async getToken(): Promise<string> {
    if (this.currentToken && !this.isExpired(this.currentToken)) {
      return this.currentToken.token;
    }

    if (this.currentToken?.refreshToken && this.autoRefresh) {
      const session = await this.refresh();
      return session.token;
    }

    const session = await this.authenticate();
    return session.token;
  }

  async refresh(): Promise<SessionToken> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshInternal().finally(() => {
        this.refreshPromise = null;
      });
    }

    return this.refreshPromise;
  }

  private async refreshInternal(): Promise<SessionToken> {
    if (!this.currentToken?.refreshToken) {
      return this.authenticate();
    }

    const refreshToken = this.currentToken.refreshToken;
    const res = await fetch(`${this.apiBaseUrl}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });

    if (!res.ok) {
      this.currentToken = null;
      return this.authenticate();
    }

    const token: SessionToken = await res.json();
    this.persistSession(token);
    return token;
  }

  logout(): void {
    this.currentToken = null;
  }

  isAuthenticated(): boolean {
    return this.currentToken !== null && !this.isExpired(this.currentToken);
  }
}

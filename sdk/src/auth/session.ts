/**
 * @contributor: Codex
 * @timestamp: 2026-05-20T01:44:29.3935915-05:00
 * @platform-config: private platform/session initialization text intentionally omitted
 * @runtime: os=windows, arch=x64, home_dir=C:\Users\Ben, working_dir=D:\Documents\AI Projects\Wallet\bounty-work\OpenAgents, shell=powershell
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
  onAuthFailure?: (error: AuthenticationError) => void | Promise<void>;
}

export interface SessionToken {
  token: string;
  expiresAt: number; // unix timestamp in seconds
  refreshToken: string;
  walletAddress: string;
}

export class AuthenticationError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "AuthenticationError";
    this.cause = cause;
  }
}

export class SessionManager {
  private wallet: SessionWallet;
  private apiBaseUrl: string;
  private autoRefresh: boolean;
  private onAuthFailure?: (error: AuthenticationError) => void | Promise<void>;
  private currentToken: SessionToken | null = null;
  private refreshPromise: Promise<SessionToken> | null = null;

  constructor(config: SessionConfig) {
    this.wallet = config.wallet;
    this.apiBaseUrl = config.apiBaseUrl;
    this.autoRefresh = config.autoRefresh ?? true;
    this.onAuthFailure = config.onAuthFailure;
    this.loadStoredSession();
  }

  private loadStoredSession(): void {
    if (typeof window !== "undefined" && window.localStorage) {
      const stored = localStorage.getItem(`session_${this.wallet.address}`);
      if (!stored) {
        return;
      }

      try {
        const token = JSON.parse(stored) as SessionToken;
        if (this.isValidSessionToken(token)) {
          this.currentToken = token;
        }
      } catch {
        localStorage.removeItem(`session_${this.wallet.address}`);
      }
    }
  }

  private isValidSessionToken(token: SessionToken): boolean {
    return (
      typeof token?.token === "string" &&
      typeof token?.refreshToken === "string" &&
      typeof token?.walletAddress === "string" &&
      typeof token?.expiresAt === "number"
    );
  }

  private persistSession(token: SessionToken): void {
    this.currentToken = token;
    if (typeof window !== "undefined" && window.localStorage) {
      localStorage.setItem(`session_${this.wallet.address}`, JSON.stringify(token));
    }
  }

  private isExpired(token: SessionToken): boolean {
    const now = Math.floor(Date.now() / 1000);
    return token.expiresAt <= now;
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

    if (!res.ok) {
      throw new AuthenticationError(`Auth failed: ${res.status}`, res);
    }

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

  async request(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const token = await this.getToken();
    const firstResponse = await fetch(input, this.withAuthHeader(init, token));

    if (firstResponse.status !== 401) {
      return firstResponse;
    }

    if (!this.autoRefresh) {
      return this.handleAuthFailure(
        "Authentication failed with 401 and auto-refresh is disabled",
        firstResponse
      );
    }

    let refreshed: SessionToken;
    try {
      refreshed = await this.refresh();
    } catch (error) {
      return this.handleAuthFailure("Token refresh failed after 401", error);
    }

    const retryResponse = await fetch(
      input,
      this.withAuthHeader(init, refreshed.token)
    );

    if (retryResponse.status === 401) {
      return this.handleAuthFailure(
        "Authentication failed after token refresh retry",
        retryResponse
      );
    }

    return retryResponse;
  }

  async fetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    return this.request(input, init);
  }

  async refresh(): Promise<SessionToken> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.performRefresh().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  private async performRefresh(): Promise<SessionToken> {
    if (!this.currentToken?.refreshToken) {
      return this.authenticate();
    }

    const res = await fetch(`${this.apiBaseUrl}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: this.currentToken.refreshToken }),
    });

    if (!res.ok) {
      this.currentToken = null;
      throw new AuthenticationError(`Token refresh failed: ${res.status}`, res);
    }

    const token: SessionToken = await res.json();
    this.persistSession(token);
    return token;
  }

  private withAuthHeader(init: RequestInit, token: string): RequestInit {
    const headers = new Headers(init.headers ?? {});
    headers.set("Authorization", `Bearer ${token}`);

    return {
      ...init,
      headers,
    };
  }

  private async handleAuthFailure(
    message: string,
    cause?: unknown
  ): Promise<never> {
    this.currentToken = null;
    const error = new AuthenticationError(message, cause);
    try {
      await this.onAuthFailure?.(error);
    } catch {
      // Preserve the authentication failure as the primary error.
    }
    throw error;
  }

  logout(): void {
    this.currentToken = null;
    if (typeof window !== "undefined" && window.localStorage) {
      localStorage.removeItem(`session_${this.wallet.address}`);
    }
  }

  isAuthenticated(): boolean {
    return this.currentToken !== null;
  }
}

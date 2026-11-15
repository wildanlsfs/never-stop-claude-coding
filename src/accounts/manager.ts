import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ClaudeAccount {
  name: string;
  token: string;
  addedAt: string;
  cooldownUntil?: number;
}

export interface AccountsStore {
  activeAccount?: string;
  accounts: ClaudeAccount[];
}

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

export class AccountManager {
  public static getStorePath(): string {
    return path.join(os.homedir(), '.nscc', 'accounts.json');
  }

  public static loadStore(): AccountsStore {
    const storePath = this.getStorePath();
    if (!fs.existsSync(storePath)) {
      return { accounts: [] };
    }
    try {
      const raw = fs.readFileSync(storePath, 'utf-8');
      const parsed = JSON.parse(raw);
      const accounts: ClaudeAccount[] = Array.isArray(parsed?.accounts) ? parsed.accounts : [];
      return {
        activeAccount: typeof parsed?.activeAccount === 'string' ? parsed.activeAccount : undefined,
        accounts,
      };
    } catch {
      return { accounts: [] };
    }
  }

  public static saveStore(store: AccountsStore): void {
    const storePath = this.getStorePath();
    const dir = path.dirname(storePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }

  public static addAccount(name: string, token: string): AccountsStore {
    const cleanName = name.trim();
    const cleanToken = token.trim();
    if (!cleanName) throw new Error('Account name cannot be empty.');
    if (!cleanToken) throw new Error('Token cannot be empty.');

    const store = this.loadStore();
    const existing = store.accounts.find((a) => a.name === cleanName);
    if (existing) {
      existing.token = cleanToken;
      existing.cooldownUntil = undefined;
    } else {
      store.accounts.push({
        name: cleanName,
        token: cleanToken,
        addedAt: new Date().toISOString(),
      });
    }

    if (!store.activeAccount) {
      store.activeAccount = cleanName;
    }

    this.saveStore(store);
    return store;
  }

  public static removeAccount(name: string): AccountsStore {
    const store = this.loadStore();
    store.accounts = store.accounts.filter((a) => a.name !== name);
    if (store.activeAccount === name) {
      store.activeAccount = store.accounts[0]?.name;
    }
    this.saveStore(store);
    return store;
  }

  public static useAccount(name: string): ClaudeAccount {
    const store = this.loadStore();
    const target = store.accounts.find((a) => a.name === name);
    if (!target) {
      throw new Error(`Account "${name}" not found.`);
    }
    target.cooldownUntil = undefined;
    store.activeAccount = target.name;
    this.saveStore(store);
    return target;
  }

  public static getActiveAccount(now = Date.now()): ClaudeAccount | undefined {
    const store = this.loadStore();
    if (store.accounts.length === 0) return undefined;

    const isAvailable = (a: ClaudeAccount) => !a.cooldownUntil || a.cooldownUntil <= now;

    if (store.activeAccount) {
      const current = store.accounts.find((a) => a.name === store.activeAccount);
      if (current && isAvailable(current)) {
        return current;
      }
    }

    const fallback = store.accounts.find(isAvailable);
    if (fallback) {
      store.activeAccount = fallback.name;
      this.saveStore(store);
      return fallback;
    }

    return undefined;
  }

  public static markRateLimitedAndRotate(
    currentName: string,
    retryAfterHeader?: string | null,
    now = Date.now()
  ): ClaudeAccount | null {
    const store = this.loadStore();
    const currentIdx = store.accounts.findIndex((a) => a.name === currentName);
    if (currentIdx === -1) return null;

    let cooldownMs = DEFAULT_COOLDOWN_MS;
    if (retryAfterHeader) {
      const seconds = Number(retryAfterHeader);
      if (Number.isFinite(seconds) && seconds > 0) {
        cooldownMs = seconds * 1000;
      }
    }

    store.accounts[currentIdx].cooldownUntil = now + cooldownMs;

    const total = store.accounts.length;
    for (let offset = 1; offset < total; offset++) {
      const candidate = store.accounts[(currentIdx + offset) % total];
      if (!candidate.cooldownUntil || candidate.cooldownUntil <= now) {
        store.activeAccount = candidate.name;
        this.saveStore(store);
        return candidate;
      }
    }

    this.saveStore(store);
    return null;
  }
}

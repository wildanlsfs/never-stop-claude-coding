import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AccountManager } from '../src/accounts/manager.js';
import { ConfigManager } from '../src/config/manager.js';
import { ProxyServer } from '../src/proxy/server.js';

describe('AccountManager & Mid-Session Auto-Switch', () => {
  let tmpDir: string;
  let originalHomedir: typeof os.homedir;
  let mock9Router: http.Server;
  let mock9RouterPort: number;
  let proxyServer: ProxyServer;
  let proxyPort: number;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nscc-accounts-test-'));
    originalHomedir = os.homedir;
    os.homedir = () => tmpDir;

    mock9Router = http.createServer((req, res) => {
      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-fallback',
          choices: [{
            message: { role: 'assistant', content: 'Fallback 9Router reply' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 5, completion_tokens: 5 },
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      mock9Router.listen(0, '127.0.0.1', () => {
        mock9RouterPort = (mock9Router.address() as any).port;
        resolve();
      });
    });

    ConfigManager.saveConfig({
      fallback: {
        enabled: true,
        forceFallback: false,
        provider: '9router',
        baseUrl: `http://127.0.0.1:${mock9RouterPort}`,
        apiKey: '9router-local',
        model: 'combo',
      },
    });

    proxyServer = new ProxyServer();
    proxyPort = await proxyServer.listen(0);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await proxyServer.close();
    await new Promise<void>((resolve) => mock9Router.close(() => resolve()));
    os.homedir = originalHomedir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adds, rotates on rate limit, and respects cooldowns in AccountManager', () => {
    AccountManager.addAccount('acct1', 'sk-ant-oat01-token-1');
    AccountManager.addAccount('acct2', 'sk-ant-oat01-token-2');

    expect(AccountManager.getActiveAccount()?.name).toBe('acct1');

    const rotated = AccountManager.markRateLimitedAndRotate('acct1', '60');
    expect(rotated?.name).toBe('acct2');
    expect(AccountManager.getActiveAccount()?.name).toBe('acct2');

    // When acct2 is also rate-limited, no account is left
    const exhausted = AccountManager.markRateLimitedAndRotate('acct2', '60');
    expect(exhausted).toBeNull();
    expect(AccountManager.getActiveAccount()).toBeUndefined();

    // Manual useAccount clears cooldown
    AccountManager.useAccount('acct1');
    expect(AccountManager.getActiveAccount()?.name).toBe('acct1');
  });

  it('auto-switches Claude account on 429 inside the same session without exiting', async () => {
    AccountManager.saveStore({ accounts: [] });
    AccountManager.addAccount('primary', 'sk-ant-oat01-primary');
    AccountManager.addAccount('backup', 'sk-ant-oat01-backup');

    const realFetch = globalThis.fetch;
    const seenAuthHeaders: string[] = [];

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === 'https://api.anthropic.com/v1/messages') {
        const auth = init?.headers?.authorization || '';
        seenAuthHeaders.push(auth);
        if (auth.includes('primary')) {
          return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } }), {
            status: 429,
            headers: { 'content-type': 'application/json', 'retry-after': '120' },
          });
        }
        return new Response(JSON.stringify({
          id: 'msg_backup_ok',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'Answered by backup account!' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return realFetch(input, init);
    });

    try {
      const res = await realFetch(`http://127.0.0.1:${proxyPort}/s/test1/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: 'Bearer claude-cli-session-token' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 256,
          stream: false,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });

      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.content[0].text).toBe('Answered by backup account!');
      expect(seenAuthHeaders).toEqual([
        'Bearer sk-ant-oat01-primary',
        'Bearer sk-ant-oat01-backup',
      ]);
      expect(AccountManager.getActiveAccount()?.name).toBe('backup');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('handles /proxy-account list and switch mid-session', async () => {
    const resList = await fetch(`http://127.0.0.1:${proxyPort}/s/test1/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 256,
        stream: false,
        messages: [{ role: 'user', content: '/proxy-account' }],
      }),
    });
    expect(resList.status).toBe(200);
    const listJson: any = await resList.json();
    expect(listJson.content[0].text).toContain('primary');
    expect(listJson.content[0].text).toContain('backup');

    const resSwitch = await fetch(`http://127.0.0.1:${proxyPort}/s/test1/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 256,
        stream: false,
        messages: [{ role: 'user', content: '/proxy-account 1' }],
      }),
    });
    expect(resSwitch.status).toBe(200);
    const switchJson: any = await resSwitch.json();
    expect(switchJson.content[0].text).toContain('primary');
    expect(AccountManager.getActiveAccount()?.name).toBe('primary');

    // Also verify native local command endpoint POST /s/:sessionId/nscc/command for proxy-account
    const localSwitch = await fetch(`http://127.0.0.1:${proxyPort}/s/test1/nscc/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'proxy-account', args: '2' }),
    });
    expect(localSwitch.status).toBe(200);
    const localSwitchJson: any = await localSwitch.json();
    expect(localSwitchJson.text).toContain('Switched active Claude account to backup');
    expect(AccountManager.getActiveAccount()?.name).toBe('backup');
  });

  it('routes directly to fallback when /f prefix is in session URL without mutating global config', async () => {
    expect(ConfigManager.loadConfig().fallback.forceFallback).toBe(false);

    const res = await fetch(`http://127.0.0.1:${proxyPort}/s/testForce/f/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 256,
        stream: false,
        messages: [{ role: 'user', content: 'force fallback test' }],
      }),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.content[0].text).toBe('Fallback 9Router reply');
    expect(ConfigManager.loadConfig().fallback.forceFallback).toBe(false);
  });
});

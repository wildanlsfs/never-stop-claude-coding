import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProxyServer } from '../src/proxy/server.js';
import { ConfigManager } from '../src/config/manager.js';
import { translateAnthropicRequestToOpenAI } from '../src/translator/request.js';

describe('ProxyServer <-> 9Router integration', () => {
  let tmpDir: string;
  let originalHomedir: typeof os.homedir;
  let mock9Router: http.Server;
  let mock9RouterPort: number;
  let proxyServer: ProxyServer;
  let proxyPort: number;
  let last9RouterReqBody: any = null;
  let last9RouterAuthHeader: string | undefined;
  let nextMockMode: 'stream-parallel-tools' | 'non-stream' = 'stream-parallel-tools';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nscc-proxy-test-'));
    originalHomedir = os.homedir;
    os.homedir = () => tmpDir;

    mock9Router = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        if (req.url === '/v1/chat/completions' && req.method === 'POST') {
          last9RouterReqBody = JSON.parse(body);
          last9RouterAuthHeader = req.headers['authorization'];

          if (nextMockMode === 'non-stream') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              id: 'chatcmpl-9r-1',
              choices: [{
                message: { role: 'assistant', content: 'Hello from 9Router!' },
                finish_reason: 'stop',
              }],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            }));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          const chunks = [
            { choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'Read', arguments: '{"file_path":' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] }, finish_reason: 'tool_calls' }] },
          ];
          for (const c of chunks) {
            res.write(`data: ${JSON.stringify(c)}\n\n`);
          }
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        res.writeHead(404);
        res.end('Not found');
      });
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
        forceFallback: true,
        provider: '9router',
        // Intentionally omit /v1 and apiKey to verify normalization + local fallback key
        baseUrl: `http://127.0.0.1:${mock9RouterPort}`,
        apiKey: '',
        model: 'kr/claude-sonnet-4.5',
      },
    });

    proxyServer = new ProxyServer();
    proxyPort = await proxyServer.listen(0);
  });

  afterAll(async () => {
    await proxyServer.close();
    await new Promise<void>((resolve) => mock9Router.close(() => resolve()));
    os.homedir = originalHomedir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('routes to 9Router /v1/chat/completions with caveman:false and preserves parallel tool names', async () => {
    nextMockMode = 'stream-parallel-tools';

    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1024,
        stream: true,
        messages: [{ role: 'user', content: 'Read a.txt and list files' }],
        tools: [
          { name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } },
          { name: 'Bash', input_schema: { type: 'object', properties: { command: { type: 'string' } } } },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const sseText = await res.text();

    expect(last9RouterReqBody.model).toBe('kr/claude-sonnet-4.5');
    expect(last9RouterReqBody.caveman).toBe(false);
    expect(last9RouterAuthHeader).toBe('Bearer 9router-local');

    // Both tool_use blocks should be emitted with their respective names and inputs
    expect(sseText).toContain('"name":"Read"');
    expect(sseText).toContain('"name":"Bash"');
    expect(sseText).toContain('"partial_json":"{\\"file_path\\":\\"a.txt\\"}"');
    expect(sseText).toContain('"partial_json":"{\\"command\\":\\"ls\\"}"');
    expect(sseText).toContain('"stop_reason":"tool_use"');
  });

  it('handles non-streaming 9Router responses cleanly', async () => {
    nextMockMode = 'non-stream';

    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1024,
        stream: false,
        messages: [{ role: 'user', content: 'Say hello' }],
      }),
    });

    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.type).toBe('message');
    expect(json.content[0].text).toBe('Hello from 9Router!');
    expect(last9RouterReqBody.caveman).toBe(false);
  });

  it('supports per-session model override via /m/:sessionModel/v1/messages without changing global config', async () => {
    nextMockMode = 'non-stream';
    const overrideModel = 'openai/gpt-4o-mini';

    const res = await fetch(`http://127.0.0.1:${proxyPort}/m/${encodeURIComponent(overrideModel)}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1024,
        stream: false,
        messages: [{ role: 'user', content: 'Say hello' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(last9RouterReqBody.model).toBe(overrideModel);
    expect(ConfigManager.loadConfig().fallback.model).toBe('kr/claude-sonnet-4.5');
  });

  it('omits tools field instead of sending empty array when all tools are filtered', () => {
    const req = translateAnthropicRequestToOpenAI(
      {
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [{ name: 'mcp__claude-in-chrome__navigate', input_schema: { type: 'object' } }],
      },
      'kr/claude-sonnet-4.5'
    );
    expect(req.tools).toBeUndefined();
  });
});

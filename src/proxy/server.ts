import express, { Request, Response, NextFunction } from 'express';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { AccountManager } from '../accounts/manager.js';
import { ConfigManager, normalizeOpenAIBaseUrl } from '../config/manager.js';
import { translateAnthropicRequestToOpenAI } from '../translator/request.js';
import { translateOpenAIResponseToAnthropic } from '../translator/response.js';
import { OpenAIToAnthropicSseStream } from '../translator/sse.js';
import { Logger } from '../utils/logger.js';
import { SlashCommandHandler } from './slash-commands.js';

interface SessionRequest extends Request {
  nsccSessionId?: string;
  nsccForceFallback?: boolean;
  nsccSessionModel?: string;
}

const ROTATABLE_STATUS_CODES = new Set([429, 529, 403, 401]);

export class ProxyServer {
  private app = express();
  private server: http.Server | null = null;
  private sessionModels = new Map<string, string>();
  private lastClientModels = new Map<string, string>();
  private slashCommands = new SlashCommandHandler(this.sessionModels);

  constructor() {
    this.app.use(express.json({ limit: '50mb' }));
    this.app.use((req: SessionRequest, _res: Response, next: NextFunction) => {
      let pathPart = req.url;
      while (true) {
        const sessionMatch = pathPart.match(/^\/s\/([^/]+)(\/.*)$/);
        if (sessionMatch) {
          req.nsccSessionId = decodeURIComponent(sessionMatch[1]);
          pathPart = sessionMatch[2];
          continue;
        }
        const forceMatch = pathPart.match(/^\/f(\/.*)$/);
        if (forceMatch) {
          req.nsccForceFallback = true;
          pathPart = forceMatch[1];
          continue;
        }
        const modelMatch = pathPart.match(/^\/m\/([^/]+)(\/.*)$/);
        if (modelMatch) {
          req.nsccSessionModel = decodeURIComponent(modelMatch[1]);
          pathPart = modelMatch[2];
          continue;
        }
        break;
      }
      req.url = pathPart;
      next();
    });
    this.setupRoutes();
  }

  private setupRoutes() {
    const buildMtime = (() => {
      try {
        return Math.floor(fs.statSync(fileURLToPath(import.meta.url)).mtimeMs);
      } catch {
        return 0;
      }
    })();

    // Health check
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', proxy: 'nscc', buildMtime });
    });

    // Local command execution endpoint for Claude Code native type:"local" plugin (/proxy-model, /proxy-account)
    this.app.post('/nscc/command', async (req: SessionRequest, res: Response) => {
      const config = ConfigManager.loadConfig();
      const sessionId = req.nsccSessionId || req.body?.sessionId || 'default';
      const initialSessionModel = req.nsccSessionModel || req.body?.sessionModel;
      const activeFallbackModel = this.sessionModels.get(sessionId) || initialSessionModel || config.fallback.model;
      const command = String(req.body?.command || '').trim();
      const args = String(req.body?.args || '').trim();

      if (command === 'proxy-model') {
        const text = await this.slashCommands.executeProxyModel(args, sessionId, activeFallbackModel, config, true);
        res.json({ text });
        return;
      }
      if (command === 'proxy-account') {
        const text = this.slashCommands.executeProxyAccount(args, true);
        res.json({ text });
        return;
      }
      res.status(400).json({ error: `Unknown nscc command: ${command}` });
    });

    // Handle Anthropic Messages API
    this.app.post(['/v1/messages', '/messages'], async (req: SessionRequest, res: Response) => {
      const startTime = Date.now();
      const config = ConfigManager.loadConfig();
      const sessionId = req.nsccSessionId || 'default';
      const initialSessionModel = req.nsccSessionModel;
      const clientModel = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
      if (clientModel && !/^claude-/i.test(clientModel) && this.lastClientModels.get(sessionId) !== clientModel) {
        this.lastClientModels.set(sessionId, clientModel);
        this.sessionModels.set(sessionId, clientModel);
      }
      const activeFallbackModel = this.sessionModels.get(sessionId) || initialSessionModel || config.fallback.model;
      const isVerbose = config.proxy.verbose;

      const lastUserMsg = Array.isArray(req.body.messages)
        ? req.body.messages.filter((m: any) => m.role === 'user').slice(-1)[0]
        : null;
      let userPromptSnippet = '';
      if (lastUserMsg) {
        if (typeof lastUserMsg.content === 'string') {
          userPromptSnippet = lastUserMsg.content;
        } else if (Array.isArray(lastUserMsg.content)) {
          userPromptSnippet = lastUserMsg.content
            .map((b: any) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? `[Tool Result: ${typeof b.content === 'string' ? b.content.slice(0, 100) : 'output'}]` : ''))
            .join(' ');
        }
      }

      Logger.log(`📥 Received POST /v1/messages | model: ${req.body.model} | stream: ${!!req.body.stream} | prompt: "${userPromptSnippet.slice(0, 120)}"`, isVerbose);

      const isInternalQuotaProbe = userPromptSnippet.trim() === 'quota';

      // Fast HTTP 404 Intercept for Claude Code internal SUGGESTION MODE so it never stops main tool turns
      if (userPromptSnippet.includes('[SUGGESTION MODE')) {
        Logger.log('💡 [SUGGESTION MODE] Intercepted — returning HTTP 404 to preserve active tool loop');
        res.status(404).json({
          error: {
            type: 'not_found_error',
            message: 'Suggestion mode is disabled in nscc proxy to ensure continuous tool execution.',
          },
        });
        return;
      }

      // Intercept /proxy-model and /proxy-account slash commands sent from inside Claude Code chat
      const proxyModelArg = this.slashCommands.extractCommandArg(lastUserMsg, 'proxy-model');
      if (proxyModelArg !== null) {
        await this.slashCommands.handleProxyModel(req, res, proxyModelArg, sessionId, activeFallbackModel, config);
        return;
      }

      const proxyAccountArg = this.slashCommands.extractCommandArg(lastUserMsg, 'proxy-account');
      if (proxyAccountArg !== null) {
        this.slashCommands.handleProxyAccount(req, res, proxyAccountArg);
        return;
      }

      // Strip any prior /proxy-model, /proxy-account turns and thinking blocks from conversation history
      // so they never enter subsequent turns' context.
      if (Array.isArray(req.body.messages)) {
        req.body.messages = this.slashCommands.sanitizeConversationHistory(req.body.messages);
      }

      // Check if Direct Fallback Mode is forced (per-session via -f or globally in config)
      const isForceFallback = Boolean(req.nsccForceFallback || config.fallback.forceFallback);

      if (!isForceFallback) {
        // 1. Try Primary Upstream (Anthropic Direct API, with auto account rotation on rate limit / auth expiry)
        try {
          let currentAccount = AccountManager.getActiveAccount();
          let upstreamResponse = await this.forwardToAnthropic(req, currentAccount?.token);

          if (upstreamResponse.ok) {
            Logger.log(`Upstream Anthropic HTTP ${upstreamResponse.status} OK (${Date.now() - startTime}ms)${currentAccount ? ` [account: ${currentAccount.name}]` : ''}`, isVerbose);
            await this.relayAnthropicResponse(req, res, upstreamResponse, 'Anthropic');
            return;
          }

          if (isInternalQuotaProbe) {
            Logger.log(`ℹ️ [quota-probe] Anthropic returned HTTP ${upstreamResponse.status} for the internal probe — relaying as-is, not treated as a real rate limit`);
            res.status(upstreamResponse.status);
            for (const [key, val] of upstreamResponse.headers.entries()) {
              if (key.toLowerCase() !== 'content-encoding' && key.toLowerCase() !== 'content-length') {
                res.setHeader(key, val);
              }
            }
            try {
              const data = await upstreamResponse.json();
              res.json(data);
            } catch {
              res.end();
            }
            return;
          }

          if (ROTATABLE_STATUS_CODES.has(upstreamResponse.status)) {
            let rateLimitBody = '';
            try { rateLimitBody = (await upstreamResponse.clone().text()).slice(0, 400); } catch {}
            const rlHeaders: Record<string, string> = {};
            for (const [key, val] of upstreamResponse.headers.entries()) {
              if (key.toLowerCase().startsWith('anthropic-ratelimit') || key.toLowerCase() === 'retry-after') {
                rlHeaders[key] = val;
              }
            }
            Logger.log(`⚠️ Anthropic returned HTTP ${upstreamResponse.status}${currentAccount ? ` on "${currentAccount.name}"` : ''}! Body: ${rateLimitBody} | Headers: ${JSON.stringify(rlHeaders)}`);

            while (currentAccount) {
              const nextAccount = AccountManager.markRateLimitedAndRotate(
                currentAccount.name,
                upstreamResponse.headers.get('retry-after')
              );
              if (!nextAccount) {
                Logger.log('⚠️ All configured Claude accounts are unavailable — falling back to fallback provider');
                break;
              }

              Logger.log(`🔄 Auto-switching Claude account "${currentAccount.name}" -> "${nextAccount.name}" without exiting session...`);
              Logger.notify('nscc Account Switch', `Switched to Claude account: ${nextAccount.name}`);

              upstreamResponse = await this.forwardToAnthropic(req, nextAccount.token);
              if (upstreamResponse.ok) {
                Logger.log(`✅ Rotated Claude account "${nextAccount.name}" succeeded (HTTP ${upstreamResponse.status})`);
                await this.relayAnthropicResponse(req, res, upstreamResponse, `Rotated account "${nextAccount.name}"`);
                return;
              }

              if (!ROTATABLE_STATUS_CODES.has(upstreamResponse.status)) {
                let errBody = '';
                try { errBody = (await upstreamResponse.text()).slice(0, 300); } catch {}
                Logger.log(`⚠️ Rotated account "${nextAccount.name}" returned HTTP ${upstreamResponse.status} — falling back: ${errBody}`);
                break;
              }

              currentAccount = nextAccount;
            }
          } else if (!upstreamResponse.ok) {
            let errBody = '';
            try { errBody = (await upstreamResponse.text()).slice(0, 300); } catch {}
            Logger.log(`⚠️ Anthropic returned unexpected HTTP ${upstreamResponse.status} (not a rate limit) — falling back: ${errBody}`);
          }
        } catch (err: any) {
          Logger.log(`❌ Primary Anthropic request failed: ${err.message} — falling back to fallback provider`);
        }
      }

      // Hard safety net: never write a second (fallback) response on a connection
      // that already has a real Anthropic response started on it.
      if (res.headersSent) {
        Logger.log('⚠️ Response already started to client — aborting before fallback to avoid corrupting the stream');
        if (!res.writableEnded) res.end();
        return;
      }

      // 2. Fallback / Direct Mode to OpenAI-compatible endpoint (e.g. 9Router / OpenRouter / DeepSeek)
      const isLocalEndpoint = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(config.fallback.baseUrl.trim());
      const effectiveApiKey = config.fallback.apiKey || (isLocalEndpoint ? '9router-local' : '');

      if (!config.fallback.enabled || !effectiveApiKey) {
        Logger.log('❌ Rate limited / Force Fallback active on Anthropic and no fallback API Key configured in ~/.nscc/config.json!');
        Logger.notify('nscc Alert', 'Fallback active & API key is missing.');
        res.status(429).json({
          error: {
            type: 'rate_limit_error',
            message: 'Fallback target active but no API key configured. Please run: nscc config -k <key>',
          },
        });
        return;
      }

      const providerName = config.fallback.provider.toUpperCase();
      const normalizedBaseUrl = normalizeOpenAIBaseUrl(config.fallback.baseUrl);
      const hasSessionOverride = this.sessionModels.has(sessionId) || Boolean(initialSessionModel);
      if (isForceFallback) {
        Logger.log(`🔀 [Force Fallback] Routing directly to ${providerName} (${normalizedBaseUrl}) with model: ${activeFallbackModel}${hasSessionOverride ? ' (session override)' : ''}`);
      } else {
        Logger.log(`🔀 Switching seamlessly to ${providerName} fallback (${normalizedBaseUrl}) with model: ${activeFallbackModel}${hasSessionOverride ? ' (session override)' : ''}`);
        Logger.notify('nscc Failover', `Switched seamlessly to ${providerName} (${activeFallbackModel})`);
      }

      try {
        const openAIReq = translateAnthropicRequestToOpenAI(
          req.body,
          activeFallbackModel,
          config.fallback.maxTokens
        );

        const targetUrl = `${normalizedBaseUrl}/chat/completions`;

        Logger.log(`⏳ Sending request to ${providerName} (${targetUrl})...`);

        const isNineRouter =
          config.fallback.provider.toLowerCase() === '9router' ||
          normalizedBaseUrl.toLowerCase().includes('9router') ||
          normalizedBaseUrl.includes(':20128');

        const doFetch = async (body: any): Promise<globalThis.Response> => {
          const extraParams = isNineRouter ? { caveman: false } : {};
          return fetch(targetUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${effectiveApiKey}`,
            },
            body: JSON.stringify({ ...body, ...extraParams }),
          });
        };

        let openAIRes: globalThis.Response;
        try {
          openAIRes = await doFetch(openAIReq);
        } catch (fetchErr: any) {
          const detail = fetchErr.cause?.message || fetchErr.message;
          Logger.log(`❌ Could not connect to fallback URL (${targetUrl}): ${detail}`);
          res.status(502).json({
            error: {
              type: 'api_error',
              message: `Could not connect to fallback server at ${config.fallback.baseUrl}: ${detail}`,
            },
          });
          return;
        }

        if (!openAIRes.ok) {
          const errText = await openAIRes.text();
          Logger.log(`❌ Fallback endpoint returned HTTP ${openAIRes.status}: ${errText}`);
          res.status(openAIRes.status).send(errText);
          return;
        }

        // --- Smart Auto-Retry with tool_choice=required if 9Router returns end_turn during tool execution loops ---
        if (req.body.stream && openAIReq.tools && openAIReq.tools.length > 0 && this.isContinuingToolLoop(req.body.messages)) {
          const rawBody = await openAIRes.text();
          const hasToolCall = rawBody.includes('"tool_calls"') || rawBody.includes('"function_call"');
          const hasEndTurn = rawBody.includes('"finish_reason":"stop"') || rawBody.includes('"finish_reason": "stop"');

          const restream = (bodyText: string) => {
            const sseStream = new OpenAIToAnthropicSseStream(res, req.body.model);
            sseStream.init();
            for (const line of bodyText.split('\n')) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith(':')) continue;
              if (trimmed.startsWith('data:')) {
                const payload = trimmed.slice(5).trim();
                if (payload === '[DONE]') { sseStream.finish('stop'); break; }
                try { sseStream.processChunk(JSON.parse(payload)); } catch {}
              }
            }
            if (!res.writableEnded) sseStream.finish('stop');
          };

          const shouldForceToolLoop = hasEndTurn && !hasToolCall;

          if (shouldForceToolLoop) {
            for (let attempt = 1; attempt <= 3; attempt++) {
              Logger.log(`🔁 [auto-retry] 9Router returned end_turn with no tool calls — retry ${attempt}/3 with tool_choice=required`);
              try {
                const retryRes = await doFetch({ ...openAIReq, tool_choice: 'required' });
                if (retryRes.ok) {
                  const retryBody = await retryRes.text();
                  const retryHasToolCall = retryBody.includes('"tool_calls"') || retryBody.includes('"function_call"');
                  if (retryHasToolCall) {
                    Logger.log(`✅ [auto-retry] Retry ${attempt} succeeded — forwarding tool_choice=required response`);
                    restream(retryBody);
                    return;
                  }
                }
              } catch (e: any) {
                Logger.log(`⚠️ [auto-retry] Retry ${attempt} error: ${e.message}`);
              }
            }

            // All retries failed — emit a synthetic Bash tool_use to keep session alive in Claude Code CLI
            const toolId = `toolu_map_Bash_${Date.now()}`;
            Logger.log(`🔧 [synthetic-continue] Emitting Bash keepalive tool_use (id=${toolId})`);
            const sseStream = new OpenAIToAnthropicSseStream(res, req.body.model);
            sseStream.init();
            sseStream.processChunk({
              choices: [{
                delta: {
                  role: 'assistant',
                  tool_calls: [{
                    index: 0,
                    id: toolId,
                    type: 'function',
                    function: {
                      name: 'Bash',
                      arguments: JSON.stringify({ command: "echo '[nscc] Auto-continuing task...' && date" }),
                    },
                  }],
                },
                finish_reason: 'tool_calls',
              }],
            });
            sseStream.finish('stop');
            return;
          } else {
            restream(rawBody);
            return;
          }
        }

        if (req.body.stream) {
          const sseStream = new OpenAIToAnthropicSseStream(res, req.body.model);
          sseStream.init();

          const reader = (openAIRes.body as any).getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          readLoop: while (true) {
            const { done, value } = await reader.read();

            if (value) {
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith(':')) continue;
                if (trimmed.startsWith('data:')) {
                  const payload = trimmed.slice(5).trim();
                  if (payload === '[DONE]') {
                    sseStream.finish('stop');
                    break readLoop;
                  }
                  try {
                    const chunkJson = JSON.parse(payload);
                    sseStream.processChunk(chunkJson);
                  } catch {
                    // Ignore SSE line parse errors
                  }
                }
              }
            }

            if (done) {
              const trimmedBuf = buffer.trim();
              if (trimmedBuf.startsWith('data:')) {
                const payload = trimmedBuf.slice(5).trim();
                if (payload && payload !== '[DONE]') {
                  try {
                    const chunkJson = JSON.parse(payload);
                    sseStream.processChunk(chunkJson);
                  } catch {}
                }
              }
              sseStream.finish('stop');
              break readLoop;
            }
          }
        } else {
          const rawText = await openAIRes.text();
          const openAIJson = this.parseNonStreamingOpenAIResponse(rawText);
          const anthropicJson = translateOpenAIResponseToAnthropic(openAIJson, req.body.model);
          Logger.log(`🏁 Non-streaming response completed in ${Date.now() - startTime}ms`);
          res.json(anthropicJson);
        }
      } catch (fallbackErr: any) {
        Logger.log(`❌ Fallback error: ${fallbackErr.message}`);
        res.status(500).json({
          error: {
            type: 'api_error',
            message: `Fallback proxy error: ${fallbackErr.message}`,
          },
        });
      }
    });
  }

  private parseNonStreamingOpenAIResponse(rawText: string): any {
    const cleanedText = rawText.replace(/data:\s*\[DONE\]\s*$/, '').trim();
    try {
      return JSON.parse(cleanedText);
    } catch {
      const ssePayloads = cleanedText
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .filter((p) => p && p !== '[DONE]');

      if (ssePayloads.length === 0) {
        throw new Error(`Invalid JSON response from provider: ${cleanedText.slice(0, 100)}`);
      }

      let id = `chatcmpl_${Date.now()}`;
      let content = '';
      let reasoningContent = '';
      let finishReason = 'stop';
      let usage: any = undefined;
      const toolCallsMap = new Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }>();

      for (const payload of ssePayloads) {
        try {
          const chunk = JSON.parse(payload);
          if (chunk.id) id = chunk.id;
          if (chunk.usage) usage = chunk.usage;
          const choice = chunk.choices?.[0];
          if (!choice) continue;

          if (choice.message) {
            if (choice.message.content) content += choice.message.content;
            if (choice.message.reasoning_content || choice.message.thinking) {
              reasoningContent += choice.message.reasoning_content || choice.message.thinking;
            }
            if (Array.isArray(choice.message.tool_calls)) {
              choice.message.tool_calls.forEach((tc: any, idx: number) => {
                toolCallsMap.set(idx, tc);
              });
            }
          }

          const delta = choice.delta;
          if (delta) {
            if (delta.content) content += delta.content;
            if (delta.reasoning_content || delta.thinking) {
              reasoningContent += delta.reasoning_content || delta.thinking;
            }
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                const existing = toolCallsMap.get(idx) || {
                  id: tc.id || `call_${idx}`,
                  type: 'function' as const,
                  function: { name: '', arguments: '' },
                };
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.function.name = tc.function.name;
                if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
                toolCallsMap.set(idx, existing);
              }
            }
          }

          if (choice.finish_reason) finishReason = choice.finish_reason;
        } catch {}
      }

      const message: any = { role: 'assistant', content };
      if (reasoningContent) message.reasoning_content = reasoningContent;
      if (toolCallsMap.size > 0) message.tool_calls = Array.from(toolCallsMap.values());

      return {
        id,
        choices: [{ message, finish_reason: finishReason }],
        usage,
      };
    }
  }

  private isContinuingToolLoop(messages: any): boolean {
    if (!Array.isArray(messages) || messages.length === 0) return false;
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'user' || !Array.isArray(last.content)) return false;
    return last.content.some((b: any) => b?.type === 'tool_result');
  }

  private static readonly SKIP_FORWARD_HEADERS = new Set([
    'host', 'content-length', 'connection', 'accept-encoding', 'transfer-encoding',
  ]);

  private async relayAnthropicResponse(
    req: Request,
    res: Response,
    upstreamResponse: globalThis.Response,
    label: string
  ): Promise<void> {
    res.status(upstreamResponse.status);
    for (const [key, val] of upstreamResponse.headers.entries()) {
      if (key.toLowerCase() !== 'content-encoding' && key.toLowerCase() !== 'content-length') {
        res.setHeader(key, val);
      }
    }

    try {
      if (req.body.stream && upstreamResponse.body) {
        const reader = (upstreamResponse.body as any).getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      } else {
        const data = await upstreamResponse.json();
        res.json(data);
      }
    } catch (streamErr: any) {
      Logger.log(`❌ ${label} stream failed mid-response (${streamErr.message}) — ending connection instead of appending fallback output`);
      if (!res.writableEnded) res.end();
    }
  }

  private async forwardToAnthropic(req: Request, overrideToken?: string): Promise<globalThis.Response> {
    const headers: Record<string, string> = {};
    for (const [key, val] of Object.entries(req.headers)) {
      if (val === undefined) continue;
      if (ProxyServer.SKIP_FORWARD_HEADERS.has(key.toLowerCase())) continue;
      headers[key] = Array.isArray(val) ? val.join(', ') : val;
    }
    headers['content-type'] = 'application/json';
    headers['anthropic-version'] = (req.headers['anthropic-version'] as string) || '2023-06-01';

    if (overrideToken) {
      if (overrideToken.startsWith('sk-ant-api')) {
        delete headers['authorization'];
        headers['x-api-key'] = overrideToken;
      } else {
        delete headers['x-api-key'];
        headers['authorization'] = `Bearer ${overrideToken}`;
      }
    }

    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body),
    });
  }

  public listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const tryListen = () => {
        this.server = this.app.listen(port, () => {
          const boundPort = (this.server?.address() as any)?.port ?? port;
          Logger.log(`🚀 Proxy server started successfully on port ${boundPort}`);
          resolve(boundPort);
        }).on('error', (err: any) => {
          if (err.code === 'EADDRINUSE') {
            Logger.log(`⚠️ Port ${port} is occupied. Force-killing stale process...`);
            try {
              execSync(`lsof -ti:${port} -sTCP:LISTEN | xargs kill -9 2>/dev/null || true`);
            } catch {}
            setTimeout(() => {
              tryListen();
            }, 1000);
          } else {
            reject(err);
          }
        });
      };
      tryListen();
    });
  }

  public close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

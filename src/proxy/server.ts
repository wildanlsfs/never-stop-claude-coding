import express, { Request, Response } from 'express';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ConfigManager, normalizeOpenAIBaseUrl } from '../config/manager.js';
import { CuxManager } from '../cux/manager.js';
import { translateAnthropicRequestToOpenAI } from '../translator/request.js';
import { translateOpenAIResponseToAnthropic } from '../translator/response.js';
import { OpenAIToAnthropicSseStream } from '../translator/sse.js';
import { Logger } from '../utils/logger.js';

export class ProxyServer {
  private app = express();
  private server: http.Server | null = null;
  private sessionModels = new Map<string, string>();
  private lastFetchedModels = new Map<string, string[]>();



  constructor() {
    this.app.use(express.json({ limit: '50mb' }));
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

    // Handle Anthropic Messages API (supports /s/:sessionId and /m/:sessionModel prefixes)
    this.app.post([
      '/v1/messages',
      '/messages',
      '/m/:sessionModel/v1/messages',
      '/m/:sessionModel/messages',
      '/s/:sessionId/v1/messages',
      '/s/:sessionId/messages',
      '/s/:sessionId/m/:sessionModel/v1/messages',
      '/s/:sessionId/m/:sessionModel/messages',
    ], async (req: Request, res: Response) => {
      const startTime = Date.now();
      const config = ConfigManager.loadConfig();
      const sessionId = req.params.sessionId || 'default';
      const initialSessionModel = req.params.sessionModel ? decodeURIComponent(req.params.sessionModel) : undefined;
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

      // Claude Code sends an internal startup probe whose entire message content is
      // the literal string "quota" — not a real conversational turn. It reliably
      // gets back a bare {"type":"rate_limit_error","message":"Error"} with NONE of
      // Anthropic's usual anthropic-ratelimit-*/retry-after headers (a real rate
      // limit always carries those), and it has zero effect on whether the very
      // next real message succeeds. Treating its 429 as a genuine rate limit was
      // triggering cux rotation, a "switched to fallback" desktop notification, and
      // routing to combo for a request that was never actually about your usage —
      // making it look like the proxy keeps failing to reach real Claude when it
      // isn't. Detect it and just relay Anthropic's real response as-is, without
      // running it through the rate-limit/fallback pipeline meant for real turns.
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

      // Intercept /proxy-model slash command sent from inside Claude Code chat
      // (supports plain text, multi-block messages with <system-reminder>, and <command-name> XML)
      const proxyModelArg = this.extractProxyModelArg(lastUserMsg);
      if (proxyModelArg !== null) {
        await this.handleProxyModelCommand(req, res, proxyModelArg, sessionId, activeFallbackModel, config);
        return;
      }

      // Check if Direct Fallback Mode is forced
      const isForceFallback = config.fallback.forceFallback;

      if (!isForceFallback) {
        // 1. Try Primary Upstream (Anthropic Direct API)
        try {
          const upstreamResponse = await this.forwardToAnthropic(req);

          if (upstreamResponse.ok) {
            Logger.log(`Upstream Anthropic HTTP ${upstreamResponse.status} OK (${Date.now() - startTime}ms)`, isVerbose);
            res.status(upstreamResponse.status);
            for (const [key, val] of upstreamResponse.headers.entries()) {
              if (key.toLowerCase() !== 'content-encoding' && key.toLowerCase() !== 'content-length') {
                res.setHeader(key, val);
              }
            }

            // Once we start writing the real Anthropic response to the client, we must
            // NEVER fall through to the fallback provider on this same connection — if
            // the stream dies partway through (network blip, reset, anything), appending
            // a second (fallback) SSE response after already-sent real Claude bytes would
            // corrupt the output into a garbled mix of real + fallback content. Catch any
            // mid-stream failure here, locally, and just end the connection instead of
            // letting it propagate to the outer catch that leads to fallback.
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
              Logger.log(`❌ Anthropic stream failed mid-response (${streamErr.message}) — real Claude output already sent, ending connection instead of appending fallback output`);
              if (!res.writableEnded) res.end();
            }
            return;
          }

          if (isInternalQuotaProbe) {
            Logger.log(`ℹ️ [quota-probe] Anthropic returned HTTP ${upstreamResponse.status} for the internal probe — relaying as-is, not treated as a real rate limit (no cux rotation / fallback triggered)`);
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

          if ([429, 529, 403].includes(upstreamResponse.status)) {
            // Log the actual error body AND Anthropic's rate-limit headers — a 429
            // can mean several different things (long-term usage quota, short-term
            // requests-per-minute, tokens-per-minute, overloaded servers) and the
            // error body's "message" field is often just "Error" with no detail.
            // The anthropic-ratelimit-* / retry-after headers carry the real
            // specifics (which limit, how many remain, when it resets).
            let rateLimitBody = '';
            try { rateLimitBody = (await upstreamResponse.clone().text()).slice(0, 400); } catch {}
            const rlHeaders: Record<string, string> = {};
            for (const [key, val] of upstreamResponse.headers.entries()) {
              if (key.toLowerCase().startsWith('anthropic-ratelimit') || key.toLowerCase() === 'retry-after') {
                rlHeaders[key] = val;
              }
            }
            Logger.log(`⚠️ Anthropic returned HTTP ${upstreamResponse.status} Rate Limit! Body: ${rateLimitBody} | Headers: ${JSON.stringify(rlHeaders)}`);

            if (config.cux.enabled && config.cux.autoRotateOnRateLimit && CuxManager.isInstalled()) {
              Logger.log('🔄 Triggering cux account rotation...');
              const rotated = await CuxManager.rotate();
              if (rotated) {
                Logger.log('🔄 Retrying request with rotated cux account...');
                Logger.notify('nscc', 'Claude account rate limit hit. Switched to next cux account.');
                const retryResponse = await this.forwardToAnthropic(req);
                if (retryResponse.ok) {
                  Logger.log(`✅ Rotated cux account succeeded (HTTP ${retryResponse.status}) — using real Claude response`);
                  res.status(retryResponse.status);
                  for (const [key, val] of retryResponse.headers.entries()) {
                    if (key.toLowerCase() !== 'content-encoding' && key.toLowerCase() !== 'content-length') {
                      res.setHeader(key, val);
                    }
                  }
                  // Same rule as the primary path: once real bytes start going to the
                  // client, never fall through to fallback on this connection.
                  try {
                    if (req.body.stream && retryResponse.body) {
                      const reader = (retryResponse.body as any).getReader();
                      while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        res.write(value);
                      }
                      res.end();
                    } else {
                      const data = await retryResponse.json();
                      res.json(data);
                    }
                  } catch (streamErr: any) {
                    Logger.log(`❌ Rotated-account stream failed mid-response (${streamErr.message}) — ending connection instead of appending fallback output`);
                    if (!res.writableEnded) res.end();
                  }
                  return;
                } else {
                  Logger.log(`⚠️ Rotated account retry also failed (HTTP ${retryResponse.status}) — falling back to fallback provider`);
                }
              } else {
                Logger.log('⚠️ cux rotation failed or no accounts left in pool — falling back to fallback provider');
              }
            }
          } else if (!upstreamResponse.ok) {
            // Any other non-2xx status is not a rate limit — log it explicitly so
            // falling back to the configured provider is never a silent mystery.
            let errBody = '';
            try { errBody = (await upstreamResponse.text()).slice(0, 300); } catch {}
            Logger.log(`⚠️ Anthropic returned unexpected HTTP ${upstreamResponse.status} (not a rate limit) — falling back: ${errBody}`);
          }
        } catch (err: any) {
          Logger.log(`❌ Primary Anthropic request failed: ${err.message} — falling back to fallback provider`);
        }
      }

      // Hard safety net: never write a second (fallback) response on a connection
      // that already has a real Anthropic response started on it, from any path
      // above. Two responses on one connection would corrupt the SSE stream into
      // a garbled mix of real + fallback content.
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
            // Try tool_choice=required retry
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
          const cleanedText = rawText.replace(/data:\s*\[DONE\]\s*$/, '').trim();
          let openAIJson: any;
          try {
            openAIJson = JSON.parse(cleanedText);
          } catch {
            const firstSseLine = cleanedText.split('\n').find((l) => l.startsWith('data: '));
            if (firstSseLine) {
              openAIJson = JSON.parse(firstSseLine.slice(6));
            } else {
              throw new Error(`Invalid JSON response from provider: ${cleanedText.slice(0, 100)}`);
            }
          }
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

  private async fetchProviderModels(baseUrl: string, apiKey: string): Promise<string[]> {
    const normalized = normalizeOpenAIBaseUrl(baseUrl);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await fetch(`${normalized}/models`, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${normalized}/models`);
    }
    const data: any = await res.json();
    const list: any[] = data.data || data.models || (Array.isArray(data) ? data : []);
    return list.map((m: any) => String(m?.id || m?.name || m)).filter(Boolean);
  }

  private extractProxyModelArg(lastUserMsg: any): string | null {
    if (!lastUserMsg) return null;

    const textBlocks: string[] = [];
    if (typeof lastUserMsg.content === 'string') {
      textBlocks.push(lastUserMsg.content);
    } else if (Array.isArray(lastUserMsg.content)) {
      for (const b of lastUserMsg.content) {
        if (b?.type === 'text' && typeof b.text === 'string') {
          textBlocks.push(b.text);
        }
      }
    }

    for (const raw of textBlocks) {
      const cleaned = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '').trim();
      if (!cleaned) continue;

      if (/<command-name>\s*\/proxy-model\s*<\/command-name>/i.test(cleaned)) {
        const argsMatch = cleaned.match(/<command-args>([\s\S]*?)<\/command-args>/i);
        return (argsMatch?.[1] ?? '').trim();
      }

      const lineMatch = cleaned.match(/(?:^|\n)\/proxy-model(?:\s+([^\n]*))?$/i);
      if (lineMatch) {
        return (lineMatch[1] ?? '').trim();
      }
    }

    return null;
  }

  private async handleProxyModelCommand(
    req: Request,
    res: Response,
    arg: string,
    sessionId: string,
    activeFallbackModel: string,
    config: ReturnType<typeof ConfigManager.loadConfig>
  ): Promise<void> {
    const isStream = Boolean(req.body.stream);
    const requestModel = req.body.model || 'claude-3-5-sonnet-20241022';
    const isLocalEndpoint = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(config.fallback.baseUrl.trim());
    const effectiveApiKey = config.fallback.apiKey || (isLocalEndpoint ? '9router-local' : '');

    if (!arg) {
      try {
        const models = await this.fetchProviderModels(config.fallback.baseUrl, effectiveApiKey);
        this.lastFetchedModels.set(sessionId, models);

        if (models.length === 0) {
          this.sendSyntheticAnthropicReply(
            res,
            requestModel,
            `Active session model: \`${activeFallbackModel}\`\n\nNo models were returned by ${config.fallback.provider} (${normalizeOpenAIBaseUrl(config.fallback.baseUrl)}/models). You can still set one directly with:\n\`/proxy-model <model_id>\``,
            isStream
          );
          return;
        }

        const formatted = models
          .map((id, idx) => `${idx + 1}. \`${id}\`${id === activeFallbackModel ? ' *(active)*' : ''}`)
          .join('\n');

        this.sendSyntheticAnthropicReply(
          res,
          requestModel,
          `**nscc Proxy Models (${config.fallback.provider.toUpperCase()})**\nActive session model: \`${activeFallbackModel}\`\n\n${formatted}\n\nTo switch model for **this session only**, run:\n\`/proxy-model <number>\` or \`/proxy-model <model_id>\``,
          isStream
        );
      } catch (err: any) {
        this.sendSyntheticAnthropicReply(
          res,
          requestModel,
          `Active session model: \`${activeFallbackModel}\`\n\nFailed to fetch models from ${normalizeOpenAIBaseUrl(config.fallback.baseUrl)}/models: ${err.message}\nYou can still switch directly with \`/proxy-model <model_id>\`.`,
          isStream
        );
      }
      return;
    }

    let chosenModel = arg;
    if (/^\d+$/.test(arg)) {
      let cached = this.lastFetchedModels.get(sessionId);
      if (!cached || cached.length === 0) {
        try {
          cached = await this.fetchProviderModels(config.fallback.baseUrl, effectiveApiKey);
          this.lastFetchedModels.set(sessionId, cached);
        } catch (err: any) {
          this.sendSyntheticAnthropicReply(
            res,
            requestModel,
            `Could not resolve model #${arg} because fetching /models failed: ${err.message}`,
            isStream
          );
          return;
        }
      }
      const index = parseInt(arg, 10) - 1;
      if (index < 0 || index >= cached.length) {
        this.sendSyntheticAnthropicReply(
          res,
          requestModel,
          `Invalid model number \`${arg}\`. Run \`/proxy-model\` to see valid numbers (1–${cached.length}).`,
          isStream
        );
        return;
      }
      chosenModel = cached[index];
    }

    this.sessionModels.set(sessionId, chosenModel);
    Logger.log(`🎯 [/proxy-model] Session ${sessionId} switched model to: ${chosenModel}`);
    this.sendSyntheticAnthropicReply(
      res,
      requestModel,
      `Switched **this session's** proxy fallback model to \`${chosenModel}\` (other sessions and global config unchanged).`,
      isStream
    );
  }

  private sendSyntheticAnthropicReply(res: Response, requestModel: string, text: string, isStream: boolean): void {
    const msgId = `msg_nscc_${Date.now()}`;
    if (!isStream) {
      res.json({
        id: msgId,
        type: 'message',
        role: 'assistant',
        model: requestModel,
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const emit = (event: string, data: any) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    emit('message_start', {
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        model: requestModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    emit('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    emit('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    });
    emit('content_block_stop', {
      type: 'content_block_stop',
      index: 0,
    });
    emit('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    });
    emit('message_stop', { type: 'message_stop' });
    res.end();
  }

  /**
   * True only when the conversation is actively mid tool-execution loop — i.e. the
   * last message is a user turn carrying tool_result block(s), meaning the model
   * just received tool output and is expected to keep acting on it.
   *
   * This is deliberately narrow: a fresh conversational turn (e.g. "hi") has no
   * prior tool_result, and a plain end_turn/no-tool-call response to it is a
   * perfectly valid answer, not a stall. Without this check, every non-tool-call
   * reply — including ordinary chit-chat — got its real text discarded and
   * replaced by a forced tool_choice=required retry loop and, on failure, a fake
   * synthetic Bash keepalive, which itself provokes more plain-text replies and
   * loops indefinitely without ever surfacing an answer to the user.
   */
  private isContinuingToolLoop(messages: any): boolean {
    if (!Array.isArray(messages) || messages.length === 0) return false;
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'user' || !Array.isArray(last.content)) return false;
    return last.content.some((b: any) => b?.type === 'tool_result');
  }

  // Headers that must NOT be forwarded as-is: hop-by-hop / connection-specific
  // headers describing the incoming request to *this* proxy, not the outgoing
  // one to Anthropic (fetch sets its own Host/Content-Length, and re-sending a
  // client Connection/Accept-Encoding header can break the upstream request).
  private static readonly SKIP_FORWARD_HEADERS = new Set([
    'host', 'content-length', 'connection', 'accept-encoding', 'transfer-encoding',
  ]);

  private async forwardToAnthropic(req: Request): Promise<globalThis.Response> {
    // Forward every header Claude Code actually sent (anthropic-beta feature
    // flags, user-agent, x-app, etc.) instead of a hardcoded allowlist — Claude
    // Code sends fields like `context_management` in the request body that are
    // only valid when paired with a matching anthropic-beta header; dropping
    // that header causes Anthropic to reject the request with a 400 that has
    // nothing to do with rate limits, silently triggering fallback.
    const headers: Record<string, string> = {};
    for (const [key, val] of Object.entries(req.headers)) {
      if (val === undefined) continue;
      if (ProxyServer.SKIP_FORWARD_HEADERS.has(key.toLowerCase())) continue;
      headers[key] = Array.isArray(val) ? val.join(', ') : val;
    }
    headers['content-type'] = 'application/json';
    headers['anthropic-version'] = (req.headers['anthropic-version'] as string) || '2023-06-01';

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

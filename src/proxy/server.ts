import express, { Request, Response } from 'express';
import http from 'node:http';
import { ConfigManager } from '../config/manager.js';
import { CuxManager } from '../cux/manager.js';
import { translateAnthropicRequestToOpenAI } from '../translator/request.js';
import { translateOpenAIResponseToAnthropic } from '../translator/response.js';
import { OpenAIToAnthropicSseStream } from '../translator/sse.js';
import { Logger } from '../utils/logger.js';

export class ProxyServer {
  private app = express();
  private server: http.Server | null = null;

  constructor() {
    this.app.use(express.json({ limit: '50mb' }));
    this.setupRoutes();
  }

  private setupRoutes() {
    // Health check
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', proxy: 'nscc' });
    });

    // Handle Anthropic Messages API
    this.app.post(['/v1/messages', '/messages'], async (req: Request, res: Response) => {
      const startTime = Date.now();
      const config = ConfigManager.loadConfig();
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

      // Check if Direct Fallback Mode is forced
      const isForceFallback = config.fallback.forceFallback;

      if (!isForceFallback) {
        // 1. Try Primary Upstream (Anthropic Direct API)
        try {
          const upstreamResponse = await this.forwardToAnthropic(req);

          // If OK (200..299), forward stream or JSON back directly
          if (upstreamResponse.ok) {
            Logger.log(`Upstream Anthropic HTTP ${upstreamResponse.status} OK (${Date.now() - startTime}ms)`, isVerbose);
            res.status(upstreamResponse.status);
            for (const [key, val] of upstreamResponse.headers.entries()) {
              if (key.toLowerCase() !== 'content-encoding' && key.toLowerCase() !== 'content-length') {
                res.setHeader(key, val);
              }
            }

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
            return;
          }

          // If Rate Limited (429, 529, 403)
          if ([429, 529, 403].includes(upstreamResponse.status)) {
            Logger.log(`⚠️ Anthropic returned HTTP ${upstreamResponse.status} Rate Limit!`);

            // Attempt cux rotation first
            if (config.cux.enabled && config.cux.autoRotateOnRateLimit && CuxManager.isInstalled()) {
              Logger.log('🔄 Triggering cux account rotation...');
              const rotated = CuxManager.rotate();
              if (rotated) {
                Logger.log('🔄 Retrying request with rotated cux account...');
                Logger.notify('nscc', 'Claude account rate limit hit. Switched to next cux account.');
                const retryResponse = await this.forwardToAnthropic(req);
                if (retryResponse.ok) {
                  res.status(retryResponse.status);
                  if (req.body.stream && retryResponse.body) {
                    const reader = (retryResponse.body as any).getReader();
                    while (true) {
                      const { done, value } = await reader.read();
                      if (done) break;
                      res.write(value);
                    }
                    res.end();
                    return;
                  }
                }
              }
            }
          }
        } catch (err: any) {
          Logger.log(`Primary Anthropic request failed: ${err.message}`, isVerbose);
        }
      }

      // 2. Fallback / Direct Mode to OpenAI-compatible endpoint (e.g. 9Router / OpenRouter / DeepSeek)
      if (!config.fallback.enabled || !config.fallback.apiKey) {
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
      if (isForceFallback) {
        Logger.log(`🔀 [Force Fallback] Routing directly to ${providerName} (${config.fallback.baseUrl}) with model: ${config.fallback.model}`);
      } else {
        Logger.log(`🔀 Switching seamlessly to ${providerName} fallback (${config.fallback.baseUrl}) with model: ${config.fallback.model}`);
        Logger.notify('nscc Failover', `Switched seamlessly to ${providerName} (${config.fallback.model})`);
      }

      try {
        const openAIReq = translateAnthropicRequestToOpenAI(
          req.body,
          config.fallback.model,
          config.fallback.maxTokens
        );

        const targetUrl = `${config.fallback.baseUrl.replace(/\/+$/, '')}/chat/completions`;

        Logger.log(`⏳ Sending request to ${providerName} (${targetUrl})...`);

        let openAIRes: globalThis.Response;
        try {
          openAIRes = await fetch(targetUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${config.fallback.apiKey}`,
            },
            body: JSON.stringify(openAIReq),
          });
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

        Logger.log(`✅ Received HTTP ${openAIRes.status} response from ${providerName} in ${Date.now() - startTime}ms`);

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
                if (trimmed === 'data: [DONE]') {
                  sseStream.finish('stop');
                  break readLoop;
                }
                if (trimmed.startsWith('data: ')) {
                  try {
                    const chunkJson = JSON.parse(trimmed.slice(6));
                    sseStream.processChunk(chunkJson);
                  } catch {
                    // Ignore SSE line parse errors
                  }
                }
              }
            }

            if (done) {
              // Flush remaining trailing line trapped in buffer if present
              const trimmedBuf = buffer.trim();
              if (trimmedBuf.startsWith('data: ') && trimmedBuf !== 'data: [DONE]') {
                try {
                  const chunkJson = JSON.parse(trimmedBuf.slice(6));
                  sseStream.processChunk(chunkJson);
                } catch {}
              }
              sseStream.finish('stop');
              break readLoop;
            }
          }
        } else {
          const rawText = await openAIRes.text();
          // Clean up 9Router trailing 'data: [DONE]' if concatenated to JSON body
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

  private async forwardToAnthropic(req: Request): Promise<globalThis.Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': (req.headers['anthropic-version'] as string) || '2023-06-01',
    };

    if (req.headers['x-api-key']) {
      headers['x-api-key'] = req.headers['x-api-key'] as string;
    }
    if (req.headers['authorization']) {
      headers['authorization'] = req.headers['authorization'] as string;
    }

    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body),
    });
  }

  public listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(port, () => {
        resolve(port);
      }).on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          resolve(port);
        } else {
          reject(err);
        }
      });
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

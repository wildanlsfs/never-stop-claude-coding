import express, { Request, Response } from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { ConfigManager } from '../config/manager.js';
import { CuxManager } from '../cux/manager.js';
import { translateAnthropicRequestToOpenAI } from '../translator/request.js';
import { translateOpenAIResponseToAnthropic } from '../translator/response.js';
import { OpenAIToAnthropicSseStream } from '../translator/sse.js';
import { Logger } from '../utils/logger.js';

export class ProxyServer {
  private app = express();
  private server: http.Server | null = null;

  /**
   * Intercept Skill tool_use blocks BEFORE forwarding to 9Router.
   * Reads SKILL.md from disk and injects a synthetic tool_result into the messages array
   * so 9Router sees the skill as already executed and immediately proceeds with the task.
   * This completely bypasses Claude Code CLI's skill runner (which stalls the main loop).
   */
  private injectSkillResults(messages: any[]): boolean {
    let injected = false;

    // Find the last assistant message and check for unanswered Skill tool_use blocks
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

      for (const block of msg.content) {
        if (block.type !== 'tool_use' || block.name !== 'Skill') continue;

        const skillName = block.input?.skill || block.input?.skill_name || 'unknown';
        const toolUseId = block.id;

        // Check if a tool_result already exists for this tool_use_id in a later user message
        const alreadyAnswered = messages.slice(i + 1).some((laterMsg: any) =>
          Array.isArray(laterMsg.content) &&
          laterMsg.content.some((b: any) => b.type === 'tool_result' && b.tool_use_id === toolUseId)
        );
        if (alreadyAnswered) continue;

        // Read SKILL.md from disk
        const skillPath = `${os.homedir()}/.claude/skills/${skillName}/SKILL.md`;
        let skillContent = '';
        try {
          skillContent = fs.readFileSync(skillPath, 'utf-8');
          Logger.log(`📚 [skill-inject] Loaded skill "${skillName}" from ${skillPath} (${skillContent.length} chars)`);
        } catch {
          skillContent = `Skill "${skillName}" not found at ${skillPath}. Proceed with best judgment.`;
          Logger.log(`⚠️ [skill-inject] SKILL.md not found for "${skillName}" at ${skillPath}`);
        }

        const nudge = '\n\n[NSCC INSTRUCTION] The skill above is now loaded. ' +
          'You MUST NOT call Skill again. ' +
          'Immediately issue the next Bash tool call to execute the task as described by the skill instructions. ' +
          'Do NOT explain. Do NOT ask. Just act NOW.';

        // Inject a synthetic user message with the tool_result + nudge
        // Insert it right after the assistant message that made the Skill call
        messages.splice(i + 1, 0, {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: skillContent + nudge,
            },
          ],
        });

        Logger.log(`✅ [skill-inject] Injected synthetic tool_result for Skill("${skillName}") id=${toolUseId}`);
        injected = true;
        break; // Process one skill at a time to maintain message order
      }
      if (injected) break;
    }

    return injected;
  }

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

          if ([429, 529, 403].includes(upstreamResponse.status)) {
            Logger.log(`⚠️ Anthropic returned HTTP ${upstreamResponse.status} Rate Limit!`);

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
        // Intercept any pending Skill tool_use blocks — inject SKILL.md content directly
        // so 9Router sees the skill as already loaded and immediately executes the next step
        if (Array.isArray(req.body.messages)) {
          const skillInjected = this.injectSkillResults(req.body.messages);
          // After injecting skill, force tool_choice=any so 9Router MUST return a tool call
          // (prevents it from responding with plain conversational text and stopping)
          if (skillInjected) {
            req.body.tool_choice = { type: 'any' };
            Logger.log('🔒 [skill-inject] Forced tool_choice=any to ensure 9Router issues a tool call after skill load');
          }
        }

        const openAIReq = translateAnthropicRequestToOpenAI(
          req.body,
          config.fallback.model,
          config.fallback.maxTokens
        );

        const targetUrl = `${config.fallback.baseUrl.replace(/\/+$/, '')}/chat/completions`;

        Logger.log(`⏳ Sending request to ${providerName} (${targetUrl})...`);

        const doFetch = async (body: any): Promise<globalThis.Response> => {
          // Some providers (e.g. 9Router) support extra params to disable output compression.
          // caveman=false disables 9Router's caveman compression which collapses tool_call JSON into plain text.
          const extraParams = config.fallback.baseUrl.includes('9router') ? { caveman: false } : {};
          return fetch(targetUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${config.fallback.apiKey}`,
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

        Logger.log(`✅ Received HTTP ${openAIRes.status} response from ${providerName} in ${Date.now() - startTime}ms`);

        // --- Auto-retry with tool_choice=required if 9Router returns end_turn with no tool calls ---
        // Buffer the streaming response to inspect it before forwarding to Claude Code CLI
        if (req.body.stream && openAIReq.tools && openAIReq.tools.length > 0) {
          let rawBody = await openAIRes.text();
          let hasToolCall = rawBody.includes('"tool_calls"') || rawBody.includes('"function_call"');
          let hasEndTurn = rawBody.includes('"finish_reason":"stop"') || rawBody.includes('"finish_reason": "stop"');

          // Helper to re-stream a buffered SSE body
          const restream = (body: string) => {
            const sseStream = new OpenAIToAnthropicSseStream(res, req.body.model);
            sseStream.init();
            for (const line of body.split('\n')) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith(':')) continue;
              if (trimmed === 'data: [DONE]') { sseStream.finish('stop'); break; }
              if (trimmed.startsWith('data: ')) {
                try { sseStream.processChunk(JSON.parse(trimmed.slice(6))); } catch {}
              }
            }
            if (!res.writableEnded) sseStream.finish('stop');
          };

          // Helper to emit a synthetic Bash tool_use that keeps the session alive.
          // The command prints a reminder of the original task so the model has context to continue.
          const emitSyntheticContinue = () => {
            const toolId = `toolu_${Math.random().toString(36).slice(2, 26)}`;
            // Extract the original user task from the messages array
            const messages: any[] = openAIReq.messages || [];
            const lastUserMsg = [...messages].reverse().find((m: any) => m.role === 'user');
            const taskHint = typeof lastUserMsg?.content === 'string'
              ? lastUserMsg.content.slice(0, 300).replace(/'/g, '')
              : 'Continue with the task. What is the next step?';
            const cmd = `echo 'TASK REMINDER: ${taskHint}' && echo 'Continue from where you left off. Call the next tool now.'`;
            Logger.log(`🔧 [synthetic-continue] Emitting Bash reminder to re-anchor model (id=${toolId})`);
            const sseStream = new OpenAIToAnthropicSseStream(res, req.body.model);
            sseStream.init();
            sseStream.processChunk({ choices: [{ delta: { role: 'assistant', content: '' }, finish_reason: null }] });
            sseStream.processChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: toolId, type: 'function', function: { name: 'Bash', arguments: '' } }] }, finish_reason: null }] });
            sseStream.processChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: cmd }) } }] }, finish_reason: null }] });
            sseStream.processChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
            sseStream.finish('stop');
          };

          // Check if model genuinely signals task completion (don't synthetic-continue then)
          const isTaskDone = (body: string) => {
            const lower = body.toLowerCase();
            return lower.includes('task complete') || lower.includes('testing complete') ||
              lower.includes('all tests passed') || lower.includes('qa complete') ||
              lower.includes('test finished') || lower.includes('completed successfully');
          };

          if (hasEndTurn && !hasToolCall) {
            // Retry up to 3 times with tool_choice=required
            let retrySucceeded = false;
            for (let attempt = 1; attempt <= 3; attempt++) {
              Logger.log(`🔁 [auto-retry] end_turn with no tool calls — retry ${attempt}/3 with tool_choice=required`);
              try {
                const retryRes = await doFetch({ ...openAIReq, tool_choice: 'required' });
                if (retryRes.ok) {
                  const retryBody = await retryRes.text();
                  const retryHasToolCall = retryBody.includes('"tool_calls"') || retryBody.includes('"function_call"');
                  const retryHasEndTurn = retryBody.includes('"finish_reason":"stop"') || retryBody.includes('"finish_reason": "stop"');
                  if (retryHasToolCall || !retryHasEndTurn) {
                    Logger.log(`✅ [auto-retry] Retry ${attempt} succeeded — forwarding tool_choice=required response`);
                    rawBody = retryBody;
                    hasToolCall = retryHasToolCall;
                    hasEndTurn = retryHasEndTurn;
                    retrySucceeded = true;
                    break;
                  }
                  Logger.log(`⚠️ [auto-retry] Retry ${attempt} still returned end_turn`);
                  rawBody = retryBody; // use latest body for task-done check
                } else {
                  Logger.log(`⚠️ [auto-retry] Retry ${attempt} HTTP ${retryRes.status}`);
                }
              } catch (e: any) {
                Logger.log(`⚠️ [auto-retry] Retry ${attempt} fetch error: ${e.message}`);
              }
            }

            if (retrySucceeded) {
              restream(rawBody);
            } else if (isTaskDone(rawBody)) {
              // Model genuinely finished — let end_turn through
              Logger.log('✅ [auto-retry] Task completion detected — forwarding end_turn');
              restream(rawBody);
            } else {
              // All retries failed — emit synthetic Bash to keep session alive
              Logger.log('🔧 [auto-retry] All retries exhausted — emitting synthetic Bash continue');
              emitSyntheticContinue();
            }
            return;
          } else {
            // No retry needed — re-stream the already-buffered response
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

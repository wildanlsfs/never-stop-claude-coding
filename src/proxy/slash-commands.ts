import { Request, Response } from 'express';
import { AccountManager } from '../accounts/manager.js';
import { ConfigManager, normalizeOpenAIBaseUrl } from '../config/manager.js';
import { Logger } from '../utils/logger.js';

export class SlashCommandHandler {
  private sessionModels: Map<string, string>;
  private lastFetchedModels = new Map<string, string[]>();

  constructor(sessionModels: Map<string, string>) {
    this.sessionModels = sessionModels;
  }

  public extractCommandArg(lastUserMsg: any, commandName: string): string | null {
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

    const escaped = commandName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const xmlMsgRegex = new RegExp(`^<command-message>[\\s\\S]*?<command-name>\\s*\\/${escaped}\\s*<\\/command-name>`, 'i');
    const xmlNameRegex = new RegExp(`^<command-name>\\s*\\/${escaped}\\s*<\\/command-name>`, 'i');
    const exactRegex = new RegExp(`^\\/${escaped}(?:\\s+([^\\n]*))?$`, 'i');

    for (const raw of textBlocks) {
      const cleaned = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '').trim();
      if (!cleaned) continue;
      // Never intercept Claude Code's auto-mode classifier (<transcript>...) even if history mentions slash commands
      if (/^<transcript>/i.test(cleaned)) return null;

      if (xmlMsgRegex.test(cleaned) || xmlNameRegex.test(cleaned)) {
        const argsMatch = cleaned.match(/<command-args>([\s\S]*?)<\/command-args>/i);
        return (argsMatch?.[1] ?? '').trim();
      }

      const exactMatch = cleaned.match(exactRegex);
      if (exactMatch) {
        return (exactMatch[1] ?? '').trim();
      }
    }

    return null;
  }

  public isSlashCommandMessage(msg: any): boolean {
    if (!msg || msg.role !== 'user') return false;
    return (
      this.extractCommandArg(msg, 'proxy-model') !== null ||
      this.extractCommandArg(msg, 'proxy-account') !== null
    );
  }

  /**
   * Strips historical `/proxy-model` and `/proxy-account` user/assistant turns and
   * prior `thinking` blocks from `messages` so they never pollute subsequent turns' context,
   * while preserving any `<system-reminder>` blocks from stripped user turns.
   */
  public sanitizeConversationHistory(messages: any[]): any[] {
    if (!Array.isArray(messages) || messages.length === 0) return messages;

    const cleaned: any[] = [];
    const pendingReminders: string[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg) continue;

      if (this.isSlashCommandMessage(msg)) {
        // Preserve any <system-reminder> blocks attached to this turn (e.g. when /proxy-model was the 1st turn)
        const rawBlocks: string[] = [];
        if (typeof msg.content === 'string') {
          rawBlocks.push(msg.content);
        } else if (Array.isArray(msg.content)) {
          for (const b of msg.content) {
            if (b?.type === 'text' && typeof b.text === 'string') {
              rawBlocks.push(b.text);
            }
          }
        }
        for (const text of rawBlocks) {
          const matches = text.match(/<system-reminder>[\s\S]*?<\/system-reminder>/gi);
          if (matches) {
            pendingReminders.push(...matches);
          }
        }

        // Skip the paired synthetic assistant reply immediately following this command turn
        if (i + 1 < messages.length && messages[i + 1]?.role === 'assistant') {
          i++;
        }
        continue;
      }

      if (msg.role === 'user' && pendingReminders.length > 0) {
        const reminderBlocks = pendingReminders.splice(0).map((text) => ({ type: 'text', text }));
        if (typeof msg.content === 'string') {
          cleaned.push({
            ...msg,
            content: [...reminderBlocks, { type: 'text', text: msg.content }],
          });
        } else if (Array.isArray(msg.content)) {
          cleaned.push({
            ...msg,
            content: [...reminderBlocks, ...msg.content],
          });
        } else {
          cleaned.push(msg);
        }
        continue;
      }

      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        const filteredBlocks = msg.content
          .filter((b: any) => b?.type !== 'thinking' && b?.type !== 'redacted_thinking')
          .map((b: any) => {
            if (b?.type === 'text' && typeof b.text === 'string' && b.text.startsWith('💭 Thinking:\n')) {
              return {
                ...b,
                text: b.text.replace(/^💭 Thinking:\n[\s\S]*?(?:\n\n|$)/, ''),
              };
            }
            return b;
          })
          .filter((b: any) => !(b?.type === 'text' && b.text === ''));

        if (filteredBlocks.length > 0) {
          cleaned.push({ ...msg, content: filteredBlocks });
        }
        continue;
      }

      cleaned.push(msg);
    }

    return cleaned.length > 0 ? cleaned : messages;
  }

  public handleProxyAccount(req: Request, res: Response, arg: string): void {
    const isStream = Boolean(req.body.stream);
    const requestModel = req.body.model || 'claude-3-5-sonnet-20241022';
    const store = AccountManager.loadStore();

    if (!arg) {
      if (store.accounts.length === 0) {
        this.sendSyntheticAnthropicReply(
          res,
          requestModel,
          `No Claude accounts registered in \`nscc\` yet.\n\nAdd accounts in another terminal (without exiting this session):\n\`nscc account add <name>\` (runs \`claude setup-token\`) or \`nscc account add <name> --token <token>\``,
          isStream
        );
        return;
      }

      const now = Date.now();
      const lines = store.accounts.map((acc, idx) => {
        const activeTag = acc.name === store.activeAccount ? ' *(active)*' : '';
        const cooldownTag = acc.cooldownUntil && acc.cooldownUntil > now
          ? ` [cooldown ${Math.ceil((acc.cooldownUntil - now) / 1000)}s]`
          : '';
        return `${idx + 1}. \`${acc.name}\`${activeTag}${cooldownTag}`;
      });

      this.sendSyntheticAnthropicReply(
        res,
        requestModel,
        `**nscc Claude Accounts**\n\n${lines.join('\n')}\n\nSwitch account mid-session with:\n\`/proxy-account <number>\` or \`/proxy-account <name>\``,
        isStream
      );
      return;
    }

    let targetName = arg;
    if (/^\d+$/.test(arg)) {
      const idx = parseInt(arg, 10) - 1;
      if (idx < 0 || idx >= store.accounts.length) {
        this.sendSyntheticAnthropicReply(
          res,
          requestModel,
          `Invalid account number \`${arg}\`. Run \`/proxy-account\` to see valid numbers (1–${store.accounts.length}).`,
          isStream
        );
        return;
      }
      targetName = store.accounts[idx].name;
    }

    try {
      const switched = AccountManager.useAccount(targetName);
      Logger.log(`🎯 [/proxy-account] Switched active Claude account to: ${switched.name}`);
      this.sendSyntheticAnthropicReply(
        res,
        requestModel,
        `Switched active Claude account to \`${switched.name}\` — next message will use it without exiting this session.`,
        isStream
      );
    } catch (err: any) {
      this.sendSyntheticAnthropicReply(res, requestModel, `❌ ${err.message}`, isStream);
    }
  }

  public async handleProxyModel(
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
}

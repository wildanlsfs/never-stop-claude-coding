import { Response } from 'express';
import { Logger } from '../utils/logger.js';

export class OpenAIToAnthropicSseStream {
  private res: Response;
  private model: string;
  private messageId: string;

  private currentBlockIndex = -1;
  private currentBlockType: 'text' | 'tool_use' | null = null;
  private activeToolIndex: number | null = null;
  private currentToolCallId: string | null = null;
  private currentToolName: string | null = null;
  private currentToolArgs = '';
  private hasToolUse = false;
  private outputTokens = 0;
  private isFinished = false;

  constructor(res: Response, model: string) {
    this.res = res;
    this.model = model;
    this.messageId = `msg_${Math.random().toString(36).slice(2)}`;
  }

  public init() {
    this.res.setHeader('Content-Type', 'text/event-stream');
    this.res.setHeader('Cache-Control', 'no-cache');
    this.res.setHeader('Connection', 'keep-alive');
    this.res.flushHeaders?.();

    // 1. Emit message_start
    this.emitEvent('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  public processChunk(openAIChunk: any) {
    if (this.isFinished || this.res.writableEnded) return;

    const choice = openAIChunk.choices?.[0];
    if (!choice) return;

    const delta = choice.delta;

    // Detect if this chunk contains tool calls
    if (delta?.tool_calls && Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      this.hasToolUse = true;

      // If we previously opened a text block, close it cleanly so tool_use is isolated
      if (this.currentBlockType === 'text') {
        this.closeCurrentBlock();
      }

      for (const tc of delta.tool_calls) {
        const toolIndex = tc.index ?? 0;

        if (tc.function?.name) {
          this.currentToolName = tc.function.name;
        }

        // Open a new tool_use block ONLY when switching to a new tool index
        if (this.currentBlockType !== 'tool_use' || this.activeToolIndex !== toolIndex) {
          this.closeCurrentBlock();
          this.currentBlockIndex++;
          this.currentBlockType = 'tool_use';
          this.activeToolIndex = toolIndex;

          // Format tool call ID strictly in native Anthropic format ('toolu_...') so Claude Code auto-approves permissions
          const randomId = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
          this.currentToolCallId = `toolu_${randomId.slice(0, 24)}`;
          this.currentToolArgs = '';
          const finalToolName = this.currentToolName || tc.function?.name || 'Bash';

          Logger.log(`🛠️ [tool_use] Opening tool block #${this.currentBlockIndex} (name: "${finalToolName}", id: "${this.currentToolCallId}")`);

          this.emitEvent('content_block_start', {
            type: 'content_block_start',
            index: this.currentBlockIndex,
            content_block: {
              type: 'tool_use',
              id: this.currentToolCallId,
              name: finalToolName,
              input: {},
            },
          });
        }

        if (tc.function?.arguments) {
          this.currentToolArgs += tc.function.arguments;
          this.outputTokens++;
        }
      }
    } else {
      // Handle text delta (only if no tool calls have been issued in this turn to prevent Claude Code turn termination)
      const textChunk = delta?.content ?? delta?.reasoning_content ?? delta?.thinking ?? delta?.text;

      if (textChunk && !this.hasToolUse) {
        if (this.currentBlockType !== 'text') {
          this.closeCurrentBlock();
          this.currentBlockIndex++;
          this.currentBlockType = 'text';

          this.emitEvent('content_block_start', {
            type: 'content_block_start',
            index: this.currentBlockIndex,
            content_block: { type: 'text', text: '' },
          });
        }

        this.outputTokens++;
        this.emitEvent('content_block_delta', {
          type: 'content_block_delta',
          index: this.currentBlockIndex,
          delta: { type: 'text_delta', text: textChunk },
        });
      }
    }

    // Handle finish_reason
    if (choice.finish_reason) {
      this.finish(choice.finish_reason);
    }
  }

  private closeCurrentBlock() {
    if (this.currentBlockType !== null) {
      if (this.currentBlockType === 'tool_use') {
        let cleanJson = this.currentToolArgs;
        let finalName = this.currentToolName || 'Bash';
        try {
          const parsed = JSON.parse(this.currentToolArgs);
          if (typeof parsed === 'object' && parsed !== null) {
            delete parsed.description;
            delete parsed.thought;
            delete parsed.explanation;
            delete parsed.comment;
            delete parsed.reasoning;

            // Sanitize Skill tool input to strictly {"skill":"name"} (strip extra keys)
            if (finalName === 'Skill' || parsed.skill || parsed.skill_name) {
              const skillName = parsed.skill || parsed.skill_name || parsed.name || 'unknown';
              cleanJson = JSON.stringify({ skill: skillName });
              Logger.log(`📚 [skill] Sanitized Skill tool input: {"skill":"${skillName}"}`);
            } else {
              if (parsed.command && typeof parsed.command === 'string') {
                // Strip blocking pipes from interactive/stateful CLI tools.
                // These tools produce output that must be read before deciding the next action,
                // so piping their output to tail/grep/etc. causes the session to hang.
                const interactiveToolPattern = /^(browser-use|playwright|puppeteer|selenium|appium)\s+\w+/;
                if (interactiveToolPattern.test(parsed.command.trim()) && parsed.command.includes('|')) {
                  parsed.command = parsed.command.replace(/\s*\|.*$/, '').trim();
                  Logger.log(`🔧 [sanitize] Stripped blocking pipe from interactive tool command`);
                }
                // Detach stdio for background commands so child_process doesn't hang Claude Code CLI
                if (/&\s*$/.test(parsed.command) && !parsed.command.includes('disown') && !parsed.command.includes('</dev/null')) {
                  parsed.command = parsed.command.replace(/&\s*$/, '</dev/null >/dev/null 2>&1 & disown');
                }
              }
              cleanJson = JSON.stringify(parsed);
            }
          }
        } catch {
          cleanJson = this.currentToolArgs;
        }

        Logger.log(`🧹 [tool_use_sanitized_input]: ${cleanJson}`);

        this.emitEvent('content_block_delta', {
          type: 'content_block_delta',
          index: this.currentBlockIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: cleanJson,
          },
        });
      }

      this.emitEvent('content_block_stop', {
        type: 'content_block_stop',
        index: this.currentBlockIndex,
      });
      this.currentBlockType = null;
      this.activeToolIndex = null;
      this.currentToolName = null;
      this.currentToolArgs = '';
    }
  }

  public finish(finishReason: string = 'stop') {
    if (this.isFinished || this.res.writableEnded) return;
    this.isFinished = true;

    this.closeCurrentBlock();

    let stopReason = 'end_turn';
    if (this.hasToolUse || finishReason === 'tool_calls' || finishReason === 'function_call') {
      stopReason = 'tool_use';
    } else if (finishReason === 'length') {
      stopReason = 'max_tokens';
    }

    Logger.log(`🏁 [stream_complete] Output tokens: ~${this.outputTokens}, stop_reason: "${stopReason}"`);

    // message_delta
    this.emitEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: this.outputTokens },
    });

    // message_stop
    this.emitEvent('message_stop', {
      type: 'message_stop',
    });

    if (!this.res.writableEnded) {
      this.res.end();
    }
  }

  private emitEvent(event: string, data: any) {
    if (this.isFinished || this.res.writableEnded) return;
    this.res.write(`event: ${event}\n`);
    this.res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

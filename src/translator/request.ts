import type {
  AnthropicMessagesRequest,
  OpenAIChatRequest,
  OpenAIMessage,
  OpenAITool,
} from './types.js';
import { anthropicIdToOpenAi } from './id-map.js';

export function translateAnthropicRequestToOpenAI(
  anthropicReq: AnthropicMessagesRequest,
  fallbackModel: string,
  defaultMaxTokens: number = 4096
): OpenAIChatRequest {
  const openAIMessages: OpenAIMessage[] = [];

  // 1. System Prompt with Autonomous Agent Instruction for Fallback Models (9Router / DeepSeek)
  const nsccToolSystemPrompt = `[CRITICAL INSTRUCTION - CLAUDE CODE AUTONOMOUS AGENT MODE]:
You are an autonomous AI coding assistant inside Claude Code CLI. You MUST work like an autonomous agent — continuously calling tools until the task is 100% complete without stopping to explain or ask.

CORE RULES:
1. ALWAYS CALL THE NEXT TOOL: After EVERY tool result, immediately issue the next Bash tool call. NEVER output plain text and stop. NEVER say "I will now do X" without immediately calling the tool to do X.
2. MULTI-STEP CLI TOOLS: When using tools that require sequential steps (e.g. open → inspect → interact → verify), run each step as a separate Bash call. Never chain them with pipes if each step produces output needed for the next decision.
3. NEVER PIPE INTERACTIVE TOOLS: Do NOT pipe (|) the output of interactive or stateful CLI tools. Run each command standalone so you can inspect its output before deciding the next action.
4. NEVER STOP MID-TASK: Do not stop until the full task is verified complete. If you encounter an error, handle it and continue.
5. BACKGROUND SERVERS: Start dev servers in background with: command </dev/null >/dev/null 2>&1 & disown`;


  let systemContent = nsccToolSystemPrompt;
  if (anthropicReq.system) {
    if (typeof anthropicReq.system === 'string') {
      systemContent += '\n\n' + anthropicReq.system;
    } else if (Array.isArray(anthropicReq.system)) {
      systemContent += '\n\n' + anthropicReq.system.map((b) => b.text).join('\n');
    }
  }

  openAIMessages.push({
    role: 'system',
    content: systemContent,
  });

  // 2. Process Messages

  for (const msg of anthropicReq.messages) {
    if (typeof msg.content === 'string') {
      openAIMessages.push({
        role: msg.role,
        content: msg.content,
      });
      continue;
    }

    if (Array.isArray(msg.content)) {
      const textParts: string[] = [];
      const toolCalls: OpenAIMessage['tool_calls'] = [];
      const toolResults: Array<{ tool_use_id: string; content: string }> = [];

      for (const block of msg.content) {
        if (block.type === 'text') {
          if (block.text?.trim()) {
            textParts.push(block.text);
          }
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: anthropicIdToOpenAi(block.id),
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        } else if (block.type === 'tool_result') {
          let resContent = '';
          if (typeof block.content === 'string') {
            resContent = block.content;
          } else if (Array.isArray(block.content)) {
            resContent = block.content
              .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
              .map((b) => b.text)
              .join('\n');
          }
          if (block.is_error) {
            resContent = `[Tool Error]: ${resContent}`;
          }

          toolResults.push({
            tool_use_id: anthropicIdToOpenAi(block.tool_use_id),
            content: resContent || 'Success',
          });
        }
      }

      // First, push any tool results (must directly follow the assistant tool_calls message in OpenAI spec)
      for (const tr of toolResults) {
        openAIMessages.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: tr.content,
        });
      }

      // Then push text or tool_calls message (if assistant or user has text/tool_calls)
      if (textParts.length > 0 || (toolCalls && toolCalls.length > 0)) {
        const message: OpenAIMessage = {
          role: msg.role,
          content: textParts.join('\n') || '',
        };
        if (toolCalls && toolCalls.length > 0) {
          message.tool_calls = toolCalls;
        }
        openAIMessages.push(message);
      }
    }
  }


  // 3. Tools Definition & Tool Choice Translation
  let openAITools: OpenAITool[] | undefined;
  if (anthropicReq.tools && anthropicReq.tools.length > 0) {
    openAITools = anthropicReq.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema ?? { type: 'object', properties: {} },
      },
    }));
  }

  let toolChoice: any = undefined;
  if (openAITools && openAITools.length > 0) {
    if (anthropicReq.tool_choice) {
      if (typeof anthropicReq.tool_choice === 'object') {
        if (anthropicReq.tool_choice.type === 'auto') {
          toolChoice = 'auto';
        } else if (anthropicReq.tool_choice.type === 'any') {
          toolChoice = 'required';
        } else if (anthropicReq.tool_choice.type === 'tool' && anthropicReq.tool_choice.name) {
          toolChoice = {
            type: 'function',
            function: { name: anthropicReq.tool_choice.name },
          };
        }
      }
    } else {
      toolChoice = 'auto';
    }
  }

  return {
    model: fallbackModel,
    messages: openAIMessages,
    tools: openAITools,
    tool_choice: toolChoice,
    max_tokens: anthropicReq.max_tokens ?? defaultMaxTokens,
    stream: anthropicReq.stream ?? true,
    temperature: anthropicReq.temperature,
    top_p: anthropicReq.top_p,
  };
}

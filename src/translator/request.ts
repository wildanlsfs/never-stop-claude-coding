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

  // 1. System Prompt Translation
  let systemContent = '';
  if (anthropicReq.system) {
    if (typeof anthropicReq.system === 'string') {
      systemContent = anthropicReq.system;
    } else if (Array.isArray(anthropicReq.system)) {
      systemContent = anthropicReq.system.map((b) => b.text ?? '').filter(Boolean).join('\n');
    }
  }

  if (systemContent.trim()) {
    openAIMessages.push({
      role: 'system',
      content: systemContent,
    });
  }


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
        if (block.type === 'thinking' || block.type === 'redacted_thinking') {
          // Follow Claude Code's native thinking concept: do not inject prior thinking blocks
          // into subsequent turns' chat context.
          continue;
        }
        if (block.type === 'text') {
          const cleanedText = block.text?.replace(/^💭 Thinking:\n[\s\S]*?(?:\n\n|$)/, '').trim();
          if (cleanedText) {
            textParts.push(cleanedText);
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
    const filteredTools = anthropicReq.tools
      .filter((t) => !t.name.startsWith('mcp__claude-in-chrome'))
      .map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema ?? { type: 'object', properties: {} },
        },
      }));
    if (filteredTools.length > 0) {
      openAITools = filteredTools;
    }
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

import type { AnthropicContentBlock } from './types.js';
import { openAiIdToAnthropic } from './id-map.js';

export function translateOpenAIResponseToAnthropic(openAIRes: any, requestModel: string): any {
  const choice = openAIRes.choices?.[0];
  const message = choice?.message;

  const content: AnthropicContentBlock[] = [];

  const textContent = message?.content || message?.reasoning_content || message?.thinking;
  const hasToolCalls = message?.tool_calls && Array.isArray(message.tool_calls) && message.tool_calls.length > 0;

  // Suppress text preambles when tool_calls exist so Claude Code CLI stays in pure tool execution mode
  if (textContent && !hasToolCalls) {
    content.push({
      type: 'text',
      text: textContent,
    });
  }

  if (hasToolCalls) {
    for (const tc of message.tool_calls) {
      let parsedInput: any = {};
      try {
        parsedInput = JSON.parse(tc.function?.arguments || '{}');
        if (typeof parsedInput === 'object' && parsedInput !== null) {
          delete parsedInput.description;
          delete parsedInput.thought;
          delete parsedInput.explanation;
          delete parsedInput.comment;
          delete parsedInput.reasoning;
        }
      } catch {
        parsedInput = { raw: tc.function?.arguments };
      }

      const toolId = openAiIdToAnthropic(tc.id);

      content.push({
        type: 'tool_use',
        id: toolId,
        name: tc.function?.name || 'Bash',
        input: parsedInput,
      });
    }
  }


  let stopReason = 'end_turn';
  if (hasToolCalls || choice?.finish_reason === 'tool_calls' || choice?.finish_reason === 'function_call') {
    stopReason = 'tool_use';
  } else if (choice?.finish_reason === 'length') {
    stopReason = 'max_tokens';
  }

  return {
    id: openAIRes.id || `msg_${Math.random().toString(36).slice(2)}`,
    type: 'message',
    role: 'assistant',
    model: requestModel,
    content: content.length > 0 ? content : [{ type: 'text', text: '' }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openAIRes.usage?.prompt_tokens ?? 0,
      output_tokens: openAIRes.usage?.completion_tokens ?? 0,
    },
  };
}

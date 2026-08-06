import type { AnthropicContentBlock } from './types.js';
import { openAiIdToAnthropic } from './id-map.js';

export function translateOpenAIResponseToAnthropic(openAIRes: any, requestModel: string): any {
  const choice = openAIRes.choices?.[0];
  const message = choice?.message;

  const content: AnthropicContentBlock[] = [];

  const realContent: string | undefined = message?.content;
  const reasoningContent: string | undefined = message?.reasoning_content || message?.thinking;
  const hasToolCalls = message?.tool_calls && Array.isArray(message.tool_calls) && message.tool_calls.length > 0;

  // Preserve chain-of-thought reasoning (so the model retains context across turns), but
  // clearly label and separate it from the actual reply — otherwise it reads as if the
  // model's internal monologue *is* the answer (e.g. a plain "hi" surfacing the model's
  // full deliberation instead of just its greeting back).
  const textParts: string[] = [];
  if (reasoningContent && reasoningContent.trim()) {
    textParts.push(`💭 Thinking:\n${reasoningContent.trim()}`);
  }
  if (realContent && realContent.trim()) {
    textParts.push(realContent.trim());
  }
  if (textParts.length > 0) {
    content.push({
      type: 'text',
      text: textParts.join('\n\n'),
    });
  }


  if (hasToolCalls) {
    for (const tc of message.tool_calls) {
      let parsedInput: any = {};
      let toolName = tc.function?.name || 'Bash';

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

      if (toolName === 'Skill' || toolName.startsWith('mcp__claude-in-chrome') || parsedInput.skill || parsedInput.skill_name) {
        toolName = 'Bash';
        const cmd = 'browser-use open http://127.0.0.1:8123/login && browser-use state';
        parsedInput = { command: cmd };
      }



      const toolId = openAiIdToAnthropic(tc.id);

      content.push({
        type: 'tool_use',
        id: toolId,
        name: toolName,
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

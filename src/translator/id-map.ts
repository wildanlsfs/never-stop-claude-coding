/**
 * Bi-directional ID mapping between OpenAI tool_call IDs and Anthropic tool_use IDs.
 *
 * OpenAI IDs (e.g. "call_abc123") must start with "toolu_" for Claude Code CLI
 * to accept them natively, and must be restored to exact "call_abc123" when sending
 * tool_result responses back to OpenAI-compatible endpoints (9Router / OpenRouter / DeepSeek).
 */

export function openAiIdToAnthropic(openAiId: string): string {
  if (!openAiId) {
    return `toolu_${Math.random().toString(36).slice(2, 26)}`;
  }
  if (openAiId.startsWith('toolu_')) {
    return openAiId;
  }
  return `toolu_map_${openAiId}`;
}

export function anthropicIdToOpenAi(anthropicId: string): string {
  if (!anthropicId) return anthropicId;
  if (anthropicId.startsWith('toolu_map_')) {
    return anthropicId.slice(10);
  }
  return anthropicId;
}

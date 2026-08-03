import type {
  AnthropicMessagesRequest,
  OpenAIChatRequest,
  OpenAIMessage,
  OpenAITool,
} from './types.js';

export function translateAnthropicRequestToOpenAI(
  anthropicReq: AnthropicMessagesRequest,
  fallbackModel: string,
  defaultMaxTokens: number = 4096
): OpenAIChatRequest {
  const openAIMessages: OpenAIMessage[] = [];

  // 1. System Prompt with Autonomous Agent Instruction for Fallback Models (9Router / DeepSeek)
  const nsccToolSystemPrompt = `[CRITICAL INSTRUCTION - CLAUDE CODE AUTONOMOUS AGENT MODE]:
You are an autonomous AI coding assistant operating inside Claude Code CLI.
1. CONTINUOUS WORKFLOW EXECUTION: When given a task, loading a skill or reading a file is ONLY the first step! You MUST immediately follow up by issuing the next appropriate tool call (e.g. Bash) to actually perform the task.
2. NEVER STOP AFTER LOADING A SKILL: When you receive a skill result (e.g. [Tool Result: Launching skill: ...] or the skill's SKILL.md content), do NOT send end_turn or stop. You MUST immediately issue the next Bash tool call to execute the skill's instructions.
3. AUTOMATIC SERVER STARTUP: If the user's task requires a running dev server and it is not running, start it in the background first (e.g. npm run dev </dev/null >/dev/null 2>&1 & disown, or the appropriate framework command) and then proceed with the task.
4. ONLY STOP WHEN THE TASK IS COMPLETELY FINISHED AND VERIFIED, OR IF USER INPUT IS REQUIRED.`;

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
  // Track Skill tool_use IDs so we can detect their tool_results and inject a follow-up nudge
  const skillToolUseIds = new Set<string>();

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
      let hasSkillResult = false;

      for (const block of msg.content) {
        if (block.type === 'text') {
          if (block.text?.trim()) {
            textParts.push(block.text);
          }
        } else if (block.type === 'tool_use') {
          // Track Skill tool_use IDs so we can detect their results later
          if (block.name === 'Skill') {
            skillToolUseIds.add(block.id);
          }
          toolCalls.push({
            id: block.id,
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

          // Check if this tool_result is the response to a Skill tool_use
          if (skillToolUseIds.has(block.tool_use_id)) {
            hasSkillResult = true;
          }

          toolResults.push({
            tool_use_id: block.tool_use_id,
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

      // CRITICAL: After a Skill tool result, inject a strong user nudge so 9Router/DeepSeek
      // immediately issues a Bash tool call instead of re-calling Skill again.
      if (hasSkillResult) {
        openAIMessages.push({
          role: 'user',
          content: '[SYSTEM INSTRUCTION] The skill instructions above are now loaded and active. ' +
            'You MUST NOT call Skill again. ' +
            'Follow the skill instructions exactly and immediately issue your next Bash tool call to execute the task. ' +
            'Do NOT ask for confirmation. Do NOT explain. Just call Bash NOW.',
        });
      }

      // Then push text or tool_calls message
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

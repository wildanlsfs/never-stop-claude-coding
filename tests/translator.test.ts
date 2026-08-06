import { describe, it, expect } from 'vitest';
import { translateAnthropicRequestToOpenAI } from '../src/translator/request.js';
import { translateOpenAIResponseToAnthropic } from '../src/translator/response.js';
import type { AnthropicMessagesRequest } from '../src/translator/types.js';

describe('Anthropic to OpenAI Protocol Translator', () => {
  it('translates basic text prompt and system message correctly', () => {
    const anthropicReq: AnthropicMessagesRequest = {
      model: 'claude-3-5-sonnet-20241022',
      system: 'You are a helpful coding assistant.',
      messages: [
        { role: 'user', content: 'Write a hello world function' },
      ],
      max_tokens: 1000,
      stream: true,
    };

    const openAIReq = translateAnthropicRequestToOpenAI(anthropicReq, 'deepseek/deepseek-chat');

    expect(openAIReq.model).toBe('deepseek/deepseek-chat');
    expect(openAIReq.max_tokens).toBe(1000);
    expect(openAIReq.messages).toHaveLength(2);
    expect(openAIReq.messages[0].role).toBe('system');
    expect(openAIReq.messages[0].content).toContain('You are a helpful coding assistant.');
    expect(openAIReq.messages[1]).toEqual({
      role: 'user',
      content: 'Write a hello world function',
    });
  });

  it('translates tools definition and tool_use / tool_result turns', () => {
    const anthropicReq: AnthropicMessagesRequest = {
      model: 'claude-3-5-sonnet-20241022',
      system: 'You are a helpful coding assistant.',
      tools: [
        {
          name: 'Bash',
          description: 'Run bash command',
          input_schema: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
          },
        },
      ],
      messages: [
        { role: 'user', content: 'List files' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Running ls...' },
            {
              type: 'tool_use',
              id: 'call_abc123',
              name: 'Bash',
              input: { command: 'ls -l' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_abc123',
              content: 'file1.txt\nfile2.txt',
            },
          ],
        },
      ],
    };

    const openAIReq = translateAnthropicRequestToOpenAI(anthropicReq, 'openai/gpt-4o');

    expect(openAIReq.tools).toHaveLength(1);
    expect(openAIReq.tools![0].function.name).toBe('Bash');

    expect(openAIReq.messages).toHaveLength(4);

    // System instruction is index 0
    expect(openAIReq.messages[0].role).toBe('system');

    // Assistant tool_use turn is index 2
    expect(openAIReq.messages[2].role).toBe('assistant');
    expect(openAIReq.messages[2].content).toBe('Running ls...');
    expect(openAIReq.messages[2].tool_calls).toEqual([
      {
        id: 'call_abc123',
        type: 'function',
        function: {
          name: 'Bash',
          arguments: '{"command":"ls -l"}',
        },
      },
    ]);

    // Tool result turn is index 3
    expect(openAIReq.messages[3]).toEqual({
      role: 'tool',
      tool_call_id: 'call_abc123',
      content: 'file1.txt\nfile2.txt',
    });
  });

  it('translates OpenAI non-streaming JSON response to Anthropic response', () => {
    const openAIRes = {
      id: 'chatcmpl-999',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Here is your file list',
            tool_calls: [
              {
                id: 'call_001',
                type: 'function',
                function: { name: 'Bash', arguments: '{"command":"pwd"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 25 },
    };

    const anthropicRes = translateOpenAIResponseToAnthropic(openAIRes, 'claude-3-5-sonnet-20241022');

    expect(anthropicRes.type).toBe('message');
    expect(anthropicRes.role).toBe('assistant');
    expect(anthropicRes.stop_reason).toBe('tool_use');
    // Text preamble is preserved alongside the tool_use block (chain-of-thought
    // reasoning carries across turns), so both blocks are expected here.
    expect(anthropicRes.content).toHaveLength(2);
    expect(anthropicRes.content[0]).toEqual({ type: 'text', text: 'Here is your file list' });
    expect(anthropicRes.content[1].type).toBe('tool_use');
    expect(anthropicRes.content[1].name).toBe('Bash');
    expect(anthropicRes.content[1].input).toEqual({ command: 'pwd' });
  });
});

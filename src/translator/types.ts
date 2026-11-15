export interface AnthropicContentBlockText {
  type: 'text';
  text: string;
}

export interface AnthropicContentBlockThinking {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface AnthropicContentBlockRedactedThinking {
  type: 'redacted_thinking';
  data: string;
}

export interface AnthropicContentBlockToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, any>;
}

export interface AnthropicContentBlockToolResult {
  type: 'tool_result';
  tool_use_id: string;
  content: string | AnthropicContentBlock[];
  is_error?: boolean;
}

export type AnthropicContentBlock =
  | AnthropicContentBlockText
  | AnthropicContentBlockThinking
  | AnthropicContentBlockRedactedThinking
  | AnthropicContentBlockToolUse
  | AnthropicContentBlockToolResult;

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, any>;
}

export interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: 'text'; text: string }>;
  max_tokens?: number;
  tools?: AnthropicTool[];
  tool_choice?: any;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, any>;
  };
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  tool_choice?: any;
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
}

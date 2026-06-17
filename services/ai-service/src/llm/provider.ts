//
// CargoTrack — LLM Provider Abstraction
//
// Unified interface for all language model interactions.
// Supports: Bedrock (primary), Gemini (fallback), Mock (dev/test).
//
// Switch providers through configuration only:
//   LLM_PROVIDER=bedrock   → Amazon Nova via Bedrock Converse API
//   LLM_PROVIDER=gemini    → Google Gemini via REST API
//   LLM_PROVIDER=mock      → Deterministic mock (no network calls)
//
// The compliance runner and copilot engine both use this interface.
// This means provider switches are global — one config change covers all AI capabilities.
//

// ─── Unified Message Types ────────────────────────────────────────────────────

/** A single tool the LLM may call */
export interface LLMToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** A tool call the LLM has decided to make */
export interface LLMToolCall {
  /** Provider-assigned call ID (for correlating results) */
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** A tool result we send back to the LLM */
export interface LLMToolResult {
  toolCallId: string;
  content: unknown;
}

/** A message in the conversation */
export interface LLMMessage {
  role: 'user' | 'assistant';
  /** Plain text content (for simple messages) */
  text?: string;
  /** Tool calls made by the assistant in this turn */
  toolCalls?: LLMToolCall[];
  /** Tool results provided by the user in this turn */
  toolResults?: LLMToolResult[];
}

/** Request to the LLM */
export interface LLMRequest {
  system: string;
  messages: LLMMessage[];
  tools?: LLMToolDef[];
  temperature?: number;
  maxTokens?: number;
}

/** Response from the LLM */
export interface LLMResponse {
  /** Non-null when stopReason === 'end_turn' */
  text?: string;
  /** Non-empty when stopReason === 'tool_use' */
  toolCalls?: LLMToolCall[];
  stopReason: 'end_turn' | 'tool_use';
  /** Provider-reported model ID */
  modelId?: string;
  /** Approximate token usage */
  usage?: { inputTokens?: number; outputTokens?: number };
}

// ─── Provider Interface ───────────────────────────────────────────────────────

export interface LLMProvider {
  /** Send a chat turn and receive the next assistant response */
  chat(req: LLMRequest): Promise<LLMResponse>;
  /** Human-readable provider name for logging */
  readonly providerName: string;
  /** Model identifier used by this provider */
  readonly modelId: string;
}

// ─── Provider Factory ─────────────────────────────────────────────────────────

export type ProviderName = 'bedrock' | 'gemini' | 'mock';

let _provider: LLMProvider | null = null;

/**
 * Returns a singleton LLMProvider based on the LLM_PROVIDER config value.
 * Lazy-initialized on first call. Import and call this wherever you need LLM access.
 */
export async function getLLMProvider(): Promise<LLMProvider> {
  if (_provider) return _provider;

  const { config } = await import('../config');
  const providerName = config.llmProvider as ProviderName;

  switch (providerName) {
    case 'bedrock': {
      const { BedrockProvider } = await import('./bedrock-provider');
      _provider = new BedrockProvider(config.region, config.bedrockModelId);
      break;
    }
    case 'gemini': {
      const { GeminiProvider } = await import('./gemini-provider');
      _provider = new GeminiProvider(config.geminiApiKey, config.geminiModelId);
      break;
    }
    case 'mock':
    default: {
      const { MockLLMProvider } = await import('./mock-llm-provider');
      _provider = new MockLLMProvider();
      break;
    }
  }

  console.log(`[LLMProvider] Initialized: ${_provider.providerName} / ${_provider.modelId}`);
  return _provider;
}

/** Reset the singleton (useful in tests) */
export function resetLLMProvider(): void {
  _provider = null;
}

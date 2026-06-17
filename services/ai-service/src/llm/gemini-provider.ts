//
// CargoTrack — Gemini LLM Provider
//
// Implements the unified LLMProvider interface using the Google Gemini REST API.
// Uses the generateContent endpoint which maps cleanly to the chat interface.
//
// Configured via:
//   GEMINI_API_KEY=<your key>
//   GEMINI_MODEL_ID=gemini-2.0-flash-lite   (default, cost-efficient)
//
// Tool-use support: Gemini function calling is structurally identical to
// Bedrock tool-use — tool defs, function calls, and function responses.
// This implementation maps the unified LLMMessage format to Gemini's
// Content/Part format.
//
// Activation: set LLM_PROVIDER=gemini
//

import type { LLMProvider, LLMRequest, LLMResponse, LLMMessage, LLMToolCall } from './provider';

// ─── Gemini REST types (subset) ───────────────────────────────────────────────

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: { content: unknown } };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: unknown;
}

interface GeminiResponse {
  candidates: Array<{
    content: GeminiContent;
    finishReason: 'STOP' | 'MAX_TOKENS' | 'FUNCTION_CALL' | string;
  }>;
  usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class GeminiProvider implements LLMProvider {
  readonly providerName = 'gemini';
  readonly modelId: string;
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, modelId: string) {
    this.apiKey = apiKey;
    this.modelId = modelId || 'gemini-2.0-flash-lite';
    this.baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelId}`;
  }

  async chat(req: LLMRequest): Promise<LLMResponse> {
    const contents: GeminiContent[] = req.messages.map(toGeminiContent);

    // Prepend system instruction as first user message (Gemini approach for chat models)
    const systemContent: GeminiContent = {
      role: 'user',
      parts: [{ text: `[SYSTEM INSTRUCTIONS]\n${req.system}\n[END SYSTEM INSTRUCTIONS]` }],
    };
    const systemAck: GeminiContent = { role: 'model', parts: [{ text: 'Understood. I will follow these instructions.' }] };

    const body: Record<string, unknown> = {
      contents: [systemContent, systemAck, ...contents],
      generationConfig: {
        maxOutputTokens: req.maxTokens ?? 4096,
        temperature: req.temperature ?? 0.2,
      },
    };

    // Attach tool definitions
    if (req.tools && req.tools.length > 0) {
      const declarations: GeminiFunctionDeclaration[] = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      }));
      body.tools = [{ functionDeclarations: declarations }];
      body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    }

    const url = `${this.baseUrl}:generateContent?key=${this.apiKey}`;
    const httpResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!httpResponse.ok) {
      const errText = await httpResponse.text();
      throw new Error(`Gemini API error ${httpResponse.status}: ${errText}`);
    }

    const data = (await httpResponse.json()) as GeminiResponse;
    const candidate = data.candidates[0];
    const parts = candidate.content.parts;
    const finishReason = candidate.finishReason;

    // Extract text
    const text = parts.filter((p) => p.text).map((p) => p.text).join('');

    // Extract function calls
    const toolCalls: LLMToolCall[] = parts
      .filter((p) => p.functionCall)
      .map((p, i) => ({
        id: `gemini-call-${Date.now()}-${i}`,
        name: p.functionCall!.name,
        input: p.functionCall!.args ?? {},
      }));

    return {
      text: text || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      stopReason: finishReason === 'FUNCTION_CALL' ? 'tool_use' : 'end_turn',
      modelId: this.modelId,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount,
        outputTokens: data.usageMetadata?.candidatesTokenCount,
      },
    };
  }
}

// ─── Format conversion helpers ────────────────────────────────────────────────

function toGeminiContent(msg: LLMMessage): GeminiContent {
  const role: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user';

  if (msg.role === 'user' && msg.toolResults && msg.toolResults.length > 0) {
    const parts: GeminiPart[] = msg.toolResults.map((tr) => ({
      functionResponse: {
        name: 'tool_result', // Gemini matches by position, not name in some versions
        response: { content: tr.content },
      },
    }));
    return { role: 'user', parts };
  }

  if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
    const parts: GeminiPart[] = msg.toolCalls.map((tc) => ({
      functionCall: { name: tc.name, args: tc.input },
    }));
    if (msg.text) parts.unshift({ text: msg.text });
    return { role: 'model', parts };
  }

  return { role, parts: [{ text: msg.text ?? '' }] };
}

import axios from 'axios';
import {
  LLMChatParams,
  LLMResponse,
  LLMModelInfo,
  LLMProviderConfig,
} from '../interfaces/llm-provider.interface';
import { BaseLLMProvider } from './base-llm.provider';

const XUNFEI_MODELS: LLMModelInfo[] = [
  {
    id: 'generalv3.5',
    displayName: '讯飞星火 Max',
    provider: 'xunfei',
    capabilities: {
      functionCalling: true,
      vision: false,
      streaming: true,
      jsonMode: false,
      maxContextTokens: 8192,
      maxOutputTokens: 8192,
    },
    isDefault: true,
    order: 1,
  },
];

/** 讯飞星火 HTTP API（OpenAI-compatible）适配器。 */
export class XunfeiProvider extends BaseLLMProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: LLMProviderConfig) {
    super('xunfei', 'generalv3.5', XUNFEI_MODELS, config);
    this.apiKey = config.apiKey || '';
    this.baseUrl = config.baseUrl || 'https://spark-api-open.xf-yun.com/v1';
  }

  async chat(params: LLMChatParams): Promise<LLMResponse> {
    const body = this.buildRequestBody(params);
    if (params.tools?.length) body.tools = this.buildToolsPayload(params.tools);

    try {
      const response = await axios.post(`${this.baseUrl}/chat/completions`, body, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: this.config.timeout || 60000,
      });
      const choice = response.data.choices?.[0];
      const result: LLMResponse = {
        content: choice?.message?.content || '',
        finishReason: choice?.finish_reason,
        model: response.data.model || params.model || this.defaultModel,
        usage: this.parseUsage(response.data.usage),
      };
      if (choice?.message?.tool_calls?.length) {
        result.toolCalls = this.parseToolCalls(choice.message.tool_calls);
      }
      return result;
    } catch (error) {
      const message = error.response?.data?.error?.message || error.response?.data?.message || error.message;
      this.logger.error(`Xunfei API call failed: ${message}`);
      throw new Error(`Xunfei API call failed: ${message}`);
    }
  }

  async *chatStream(params: Omit<LLMChatParams, 'tools' | 'jsonMode'>): AsyncIterable<string> {
    const body = this.buildRequestBody(params);
    body.stream = true;
    const response = await axios.post(`${this.baseUrl}/chat/completions`, body, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      responseType: 'stream',
      timeout: this.config.timeout || 60000,
    });

    let buffer = '';
    for await (const chunk of response.data) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]' || !trimmed.startsWith('data: ')) continue;
        try {
          const data = JSON.parse(trimmed.slice(6));
          const content = data.choices?.[0]?.delta?.content || '';
          if (content) yield content;
        } catch {
          // A later chunk may complete a partial frame.
        }
      }
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      await axios.post(
        `${this.baseUrl}/chat/completions`,
        { model: this.defaultModel, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 },
        {
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          timeout: 10000,
        },
      );
      return true;
    } catch (error) {
      return error.response?.status === 429;
    }
  }
}

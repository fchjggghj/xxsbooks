/**
 * DeepSeek API 客户端模块
 * 
 * DeepSeek API 兼容 OpenAI API 格式，支持聊天和代码模型。
 * 文档参考：https://api-docs.deepseek.com/zh-cn/
 * 
 * 基础URL: https://api.deepseek.com
 * 聊天模型: deepseek-chat
 * 代码模型: deepseek-coder
 */

import type { SendResult, RateLimitInfo } from './types.js';
import { sleep, boundedMs } from './utils.js';

export interface DeepSeekConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  rateLimitWaitMs?: number;
  maxRateLimitWaitMs?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  n?: number;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatCompletionStreamChoice {
  index: number;
  delta: Partial<ChatMessage>;
  finish_reason: string | null;
}

export interface ChatCompletionStreamResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionStreamChoice[];
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_TIMEOUT = 300000;
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 8192;

export function buildConfig(cfg: DeepSeekConfig): Required<DeepSeekConfig> {
  return {
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl || DEFAULT_BASE_URL,
    model: cfg.model || DEFAULT_MODEL,
    temperature: cfg.temperature ?? DEFAULT_TEMPERATURE,
    maxTokens: cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
    timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT,
    rateLimitWaitMs: cfg.rateLimitWaitMs ?? 60000,
    maxRateLimitWaitMs: cfg.maxRateLimitWaitMs ?? 300000,
  };
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendChat(
  prompt: string,
  config: DeepSeekConfig,
  systemMessage?: string,
): Promise<SendResult> {
  const cfg = buildConfig(config);

  if (!cfg.apiKey || cfg.apiKey.includes('在这里填')) {
    return { text: '', timedOut: false, error: 'DeepSeek API Key 未配置' };
  }

  const messages: ChatMessage[] = [];
  if (systemMessage) {
    messages.push({ role: 'system', content: systemMessage });
  }
  messages.push({ role: 'user', content: prompt });

  const requestBody: ChatCompletionRequest = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature,
    max_tokens: cfg.maxTokens,
    stream: false,
  };

  try {
    const response = await fetchWithTimeout(
      `${cfg.baseUrl}/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(requestBody),
      },
      cfg.timeoutMs,
    );

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({ error: { message: '请求失败' } }));
      const errorMessage = errorBody.error?.message || `HTTP ${response.status}`;

      if (response.status === 429) {
        return { text: '', timedOut: false, error: `配额限制: ${errorMessage}` };
      }

      return { text: '', timedOut: false, error: errorMessage };
    }

    const data = (await response.json()) as ChatCompletionResponse;

    if (!data.choices || data.choices.length === 0) {
      return { text: '', timedOut: false, error: '未返回有效响应' };
    }

    const text = data.choices[0].message.content || '';
    return { text, timedOut: false };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { text: '', timedOut: true, error: '请求超时' };
    }
    return { text: '', timedOut: false, error: String(err) };
  }
}

export async function sendChatStream(
  prompt: string,
  config: DeepSeekConfig,
  systemMessage?: string,
  onChunk?: (chunk: string) => void,
): Promise<SendResult> {
  const cfg = buildConfig(config);

  if (!cfg.apiKey || cfg.apiKey.includes('在这里填')) {
    return { text: '', timedOut: false, error: 'DeepSeek API Key 未配置' };
  }

  const messages: ChatMessage[] = [];
  if (systemMessage) {
    messages.push({ role: 'system', content: systemMessage });
  }
  messages.push({ role: 'user', content: prompt });

  const requestBody: ChatCompletionRequest = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature,
    max_tokens: cfg.maxTokens,
    stream: true,
  };

  let fullText = '';

  try {
    const response = await fetchWithTimeout(
      `${cfg.baseUrl}/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(requestBody),
      },
      cfg.timeoutMs,
    );

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({ error: { message: '请求失败' } }));
      const errorMessage = errorBody.error?.message || `HTTP ${response.status}`;

      if (response.status === 429) {
        return { text: '', timedOut: false, error: `配额限制: ${errorMessage}` };
      }

      return { text: '', timedOut: false, error: errorMessage };
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return { text: '', timedOut: false, error: '无法获取响应流' };
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        try {
          const jsonStr = trimmed.slice(6);
          if (jsonStr === '[DONE]') continue;

          const data = JSON.parse(jsonStr) as ChatCompletionStreamResponse;
          const content = data.choices[0]?.delta?.content || '';

          if (content) {
            fullText += content;
            onChunk?.(content);
          }
        } catch {
          continue;
        }
      }
    }

    return { text: fullText, timedOut: false };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { text: fullText || '', timedOut: true, error: '请求超时' };
    }
    return { text: fullText || '', timedOut: false, error: String(err) };
  }
}

export async function sendAndCollect(
  prompt: string,
  config: DeepSeekConfig,
  systemMessage?: string,
): Promise<SendResult> {
  const result = await sendChat(prompt, config, systemMessage);

  if (result.error) {
    if (result.error.includes('配额') || result.error.includes('429')) {
      const waitMs = boundedMs(config.rateLimitWaitMs, config.maxRateLimitWaitMs || 300000);
      await sleep(waitMs);
      return await sendChat(prompt, config, systemMessage);
    }
  }

  return result;
}

export function hitRateLimit(result: SendResult): boolean {
  return !!(result.error && (result.error.includes('配额') || result.error.includes('429') || result.error.includes('Rate') || result.error.includes('limit')));
}

export function rateLimitInfo(result: SendResult): RateLimitInfo {
  if (!hitRateLimit(result)) {
    return { hit: false };
  }

  return {
    hit: true,
    message: result.error,
    waitMs: 60000,
  };
}

export async function checkApiKey(apiKey: string): Promise<boolean> {
  try {
    const response = await fetch(`${DEFAULT_BASE_URL}/v1/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function listModels(apiKey: string, baseUrl?: string): Promise<string[]> {
  try {
    const url = `${baseUrl || DEFAULT_BASE_URL}/v1/models`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) return [];

    const data = (await response.json()) as { data: { id: string }[] };
    return data.data?.map((m) => m.id) || [];
  } catch {
    return [];
  }
}
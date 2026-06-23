import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  sendChat,
  sendChatStream,
  sendAndCollect,
  hitRateLimit,
  rateLimitInfo,
  checkApiKey,
  listModels,
  buildConfig,
} from './deepseek.js';
import type { DeepSeekConfig, ChatCompletionResponse } from './deepseek.js';

const originalFetch = global.fetch;

function validConfig(): DeepSeekConfig {
  return {
    apiKey: 'sk-valid-test-key',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    temperature: 0.7,
    maxTokens: 8192,
    timeoutMs: 300000,
    rateLimitWaitMs: 60000,
    maxRateLimitWaitMs: 300000,
  };
}

describe('buildConfig', () => {
  it('补全默认值', () => {
    const cfg = buildConfig({ apiKey: 'sk-test' });
    expect(cfg.baseUrl).toBe('https://api.deepseek.com');
    expect(cfg.model).toBe('deepseek-chat');
    expect(cfg.temperature).toBe(0.7);
    expect(cfg.maxTokens).toBe(8192);
    expect(cfg.timeoutMs).toBe(300000);
  });

  it('使用自定义值覆盖默认值', () => {
    const cfg = buildConfig({
      apiKey: 'sk-test',
      model: 'deepseek-coder',
      temperature: 0.5,
      maxTokens: 4096,
    });
    expect(cfg.model).toBe('deepseek-coder');
    expect(cfg.temperature).toBe(0.5);
    expect(cfg.maxTokens).toBe(4096);
  });
});

describe('sendChat', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('发送成功返回文本', async () => {
    const response: ChatCompletionResponse = {
      id: 'chatcmpl-123',
      object: 'chat.completion',
      created: Date.now(),
      model: 'deepseek-chat',
      choices: [{ index: 0, message: { role: 'assistant', content: '这是测试回复' }, finish_reason: 'stop' }],
    };
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => response,
    });

    const result = await sendChat('你好', validConfig());
    expect(result.text).toBe('这是测试回复');
    expect(result.timedOut).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('API Key 未配置返回错误', async () => {
    const result = await sendChat('你好', { apiKey: '在这里填' });
    expect(result.text).toBe('');
    expect(result.error).toBe('DeepSeek API Key 未配置');
  });

  it('API Key 为空返回错误', async () => {
    const result = await sendChat('你好', { apiKey: '' });
    expect(result.text).toBe('');
    expect(result.error).toBe('DeepSeek API Key 未配置');
  });

  it('429 配额限制返回错误', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: 'Rate limit exceeded' } }),
    });

    const result = await sendChat('你好', validConfig());
    expect(result.text).toBe('');
    expect(result.error).toContain('配额限制');
  });

  it('其他 HTTP 错误返回错误信息', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'Invalid API key' } }),
    });

    const result = await sendChat('你好', validConfig());
    expect(result.text).toBe('');
    expect(result.error).toBe('Invalid API key');
  });

  it('无 choices 返回错误', async () => {
    const response: ChatCompletionResponse = {
      id: 'chatcmpl-123',
      object: 'chat.completion',
      created: Date.now(),
      model: 'deepseek-chat',
      choices: [],
    };
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => response,
    });

    const result = await sendChat('你好', validConfig());
    expect(result.text).toBe('');
    expect(result.error).toBe('未返回有效响应');
  });

  it('带 system message', async () => {
    const response: ChatCompletionResponse = {
      id: 'chatcmpl-123',
      object: 'chat.completion',
      created: Date.now(),
      model: 'deepseek-chat',
      choices: [{ index: 0, message: { role: 'assistant', content: '系统提示生效' }, finish_reason: 'stop' }],
    };
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => response,
    });

    await sendChat('测试', validConfig(), '你是一个助手');

    expect(global.fetch).toHaveBeenCalled();
    const call = (global.fetch as any).mock.calls[0];
    const body = JSON.parse(call[1]?.body as string);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toBe('你是一个助手');
    expect(body.messages[1].role).toBe('user');
  });
});

describe('sendChatStream', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('流式响应拼接完整文本', async () => {
    const chunks = [
      'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":12345,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"你"},"finish_reason":null}]}\n',
      'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":12345,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"好"},"finish_reason":null}]}\n',
      'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":12345,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"世界"},"finish_reason":null}]}\n',
      'data: [DONE]\n',
    ];

    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            if (chunks.length === 0) return { done: true, value: null };
            const chunk = chunks.shift()!;
            return { done: false, value: new TextEncoder().encode(chunk) };
          },
        }),
      },
    });

    const result = await sendChatStream('你好', validConfig());
    expect(result.text).toBe('你好世界');
    expect(result.timedOut).toBe(false);
  });

  it('流式响应调用 onChunk 回调', async () => {
    const chunks = [
      'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":12345,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"第一"},"finish_reason":null}]}\n',
      'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":12345,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"第二"},"finish_reason":null}]}\n',
      'data: [DONE]\n',
    ];

    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            if (chunks.length === 0) return { done: true, value: null };
            const chunk = chunks.shift()!;
            return { done: false, value: new TextEncoder().encode(chunk) };
          },
        }),
      },
    });

    const receivedChunks: string[] = [];
    await sendChatStream('测试', validConfig(), undefined, (chunk) => {
      receivedChunks.push(chunk);
    });

    expect(receivedChunks).toEqual(['第一', '第二']);
  });
});

describe('sendAndCollect', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('首次发送成功', async () => {
    const response: ChatCompletionResponse = {
      id: 'chatcmpl-123',
      object: 'chat.completion',
      created: Date.now(),
      model: 'deepseek-chat',
      choices: [{ index: 0, message: { role: 'assistant', content: '成功' }, finish_reason: 'stop' }],
    };
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => response,
    });

    const result = await sendAndCollect('测试', validConfig());
    expect(result.text).toBe('成功');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('配额限制后重试成功', async () => {
    const successResponse: ChatCompletionResponse = {
      id: 'chatcmpl-123',
      object: 'chat.completion',
      created: Date.now(),
      model: 'deepseek-chat',
      choices: [{ index: 0, message: { role: 'assistant', content: '重试成功' }, finish_reason: 'stop' }],
    };

    (global.fetch as any)
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: async () => ({ error: { message: 'Rate limit exceeded' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => successResponse,
      });

    const result = await sendAndCollect('测试', {
      ...validConfig(),
      rateLimitWaitMs: 10,
    });

    expect(result.text).toBe('重试成功');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('hitRateLimit', () => {
  it('配额错误返回 true', () => {
    expect(hitRateLimit({ text: '', timedOut: false, error: '配额限制' })).toBe(true);
    expect(hitRateLimit({ text: '', timedOut: false, error: '429' })).toBe(true);
    expect(hitRateLimit({ text: '', timedOut: false, error: 'Rate limit exceeded' })).toBe(true);
  });

  it('非配额错误返回 false', () => {
    expect(hitRateLimit({ text: '', timedOut: false, error: 'Invalid API key' })).toBe(false);
    expect(hitRateLimit({ text: '', timedOut: false, error: '' })).toBe(false);
    expect(hitRateLimit({ text: '', timedOut: false })).toBe(false);
  });
});

describe('rateLimitInfo', () => {
  it('命中配额返回信息', () => {
    const info = rateLimitInfo({ text: '', timedOut: false, error: '配额限制' });
    expect(info.hit).toBe(true);
    expect(info.message).toBe('配额限制');
    expect(info.waitMs).toBe(60000);
  });

  it('未命中返回 hit=false', () => {
    const info = rateLimitInfo({ text: '内容', timedOut: false });
    expect(info.hit).toBe(false);
  });
});

describe('checkApiKey', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('有效 Key 返回 true', async () => {
    (global.fetch as any).mockResolvedValue({ ok: true, status: 200 });
    const result = await checkApiKey('sk-valid');
    expect(result).toBe(true);
  });

  it('无效 Key 返回 false', async () => {
    (global.fetch as any).mockResolvedValue({ ok: false, status: 401 });
    const result = await checkApiKey('sk-invalid');
    expect(result).toBe(false);
  });

  it('网络错误返回 false', async () => {
    (global.fetch as any).mockRejectedValue(new Error('Network error'));
    const result = await checkApiKey('sk-test');
    expect(result).toBe(false);
  });
});

describe('listModels', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('返回模型列表', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-coder' }] }),
    });
    const models = await listModels('sk-valid');
    expect(models).toEqual(['deepseek-chat', 'deepseek-coder']);
  });

  it('使用自定义 baseUrl', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'custom-model' }] }),
    });
    await listModels('sk-valid', 'https://custom.api.com');
    expect(global.fetch).toHaveBeenCalledWith('https://custom.api.com/v1/models', expect.objectContaining({}));
  });

  it('请求失败返回空数组', async () => {
    (global.fetch as any).mockResolvedValue({ ok: false, status: 401 });
    const models = await listModels('sk-invalid');
    expect(models).toEqual([]);
  });
});
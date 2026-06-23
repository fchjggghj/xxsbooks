/**
 * @novel-pipeline/shared 公共模块入口
 */
export * from './types.js';
export * from './utils.js';
export * from './config.js';
export * from './files.js';
export * from './library.js';
export * from './direction.js';
export * from './pool.js';
export * from './composer.js';

export {
  sendChat as sendChatDeepSeek,
  sendChatStream as sendChatStreamDeepSeek,
  sendAndCollect as sendAndCollectDeepSeek,
  hitRateLimit as hitRateLimitDeepSeek,
  rateLimitInfo as rateLimitInfoDeepSeek,
  checkApiKey as checkApiKeyDeepSeek,
  listModels as listModelsDeepSeek,
} from './deepseek.js';

export * from './chatgpt.js';

import * as deepseekModule from './deepseek.js';
export const deepseek = deepseekModule;
export type { DeepSeekConfig, ChatMessage } from './deepseek.js';

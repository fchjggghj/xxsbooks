export function canonicalConversationUrl(value) {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`.replace(/\/$/, '');
}

export function isConversationUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname === 'chatgpt.com' && /^\/c\/[^/]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

export function claimConversation(state, conversationUrl, owner) {
  if (!isConversationUrl(conversationUrl)) {
    throw new Error(`Not a ChatGPT conversation URL: ${conversationUrl}`);
  }
  state.conversationOwners = state.conversationOwners || {};
  const canonical = canonicalConversationUrl(conversationUrl);
  const existing = state.conversationOwners[canonical];
  if (existing && (existing.stage !== owner.stage || existing.novelKey !== owner.novelKey)) {
    throw new Error(
      `Conversation ${canonical} belongs to ${existing.stage}/${existing.novelKey}, not ${owner.stage}/${owner.novelKey}`,
    );
  }
  for (const [novelKey, url] of Object.entries(state.novelConversations || {})) {
    if (novelKey !== owner.novelKey && isConversationUrl(url) && canonicalConversationUrl(url) === canonical) {
      throw new Error(`Conversation ${canonical} is already assigned to novel ${novelKey}`);
    }
  }
  state.conversationOwners[canonical] = { stage: owner.stage, novelKey: owner.novelKey };
  return canonical;
}

export function releaseNovelConversation(state, stage, novelKey) {
  const url = state.novelConversations?.[novelKey];
  if (isConversationUrl(url)) {
    const canonical = canonicalConversationUrl(url);
    const owner = state.conversationOwners?.[canonical];
    if (owner?.stage === stage && owner?.novelKey === novelKey) {
      delete state.conversationOwners[canonical];
    }
  }
  if (state.novelConversations) delete state.novelConversations[novelKey];
}

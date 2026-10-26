import * as luna from './luna.js';

export const PROVIDERS = Object.freeze({
  luna: { name: 'GPT-6 Luna', company: 'OpenAI', keyLabel: 'OpenAI API key', keySetting: 'lunaKey',
    autoSetting: 'lunaAuto', defaultModel: luna.DEFAULT_MODEL, policy: luna.POLICY_VERSION,
    suggest: luna.suggest, reviewNotes: luna.reviewNotes, reviewDriverNames: luna.reviewDriverNames, automatic: true },
});

// `server` is the usage server in use (usage-log.js serverConfig): without a key of the agent's own,
// Luna goes through its /v1/luna with TNI's key. Suggestions are on unless the agent turned them off;
// automatic picks stay off unless the agent turned them on.
export function settingsFrom(saved = {}, server = {}) {
  // Dedicated Luna settings only: obsolete provider credentials are never reused.
  const apiKey = saved.lunaKey || '';
  let proxy = null;
  if (!apiKey && server.serverUrl) {
    try { proxy = { url: new URL('/v1/luna', server.serverUrl).href, token: server.serverToken || '' }; } catch { /* not a URL: no server */ }
  }
  return { provider: 'luna', on: saved.aiOn !== false, auto: saved.lunaAuto === true,
    apiKey, proxy, ready: !!(apiKey || proxy), model: luna.DEFAULT_MODEL };
}

export const suggest = (items, context, config, opts) => luna.suggest(items, context, config, opts);
export const reviewNotes = (record, config, opts) => luna.reviewNotes(record, config, opts);
export const reviewDriverNames = (record, config, opts) => luna.reviewDriverNames(record, config, opts);

import * as luna from './luna.js';

export const PROVIDERS = Object.freeze({
  luna: { name: 'GPT-6 Luna', company: 'OpenAI', keyLabel: 'OpenAI API key', keySetting: 'lunaKey',
    autoSetting: 'lunaAuto', defaultModel: luna.DEFAULT_MODEL, policy: luna.POLICY_VERSION,
    suggest: luna.suggest, automatic: true },
});

export function settingsFrom(saved = {}) {
  // Dedicated Luna settings only: obsolete provider credentials are never reused.
  return { provider: 'luna', on: saved.aiOn === true, auto: saved.lunaAuto === true,
    apiKey: saved.lunaKey || '', model: luna.DEFAULT_MODEL };
}

export const suggest = (items, context, config, opts) => luna.suggest(items, context, config, opts);

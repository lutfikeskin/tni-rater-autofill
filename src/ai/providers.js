import * as jev from './assist.js';
import * as luna from './luna.js';

export const PROVIDERS = Object.freeze({
  jev: { name: 'Jev', company: 'TypeSafe AI', keyLabel: 'TypeSafe API key', keySetting: 'jevKey', autoSetting: 'aiAuto',
    defaultModel: jev.DEFAULT_MODEL, policy: jev.POLICY_VERSION, suggest: jev.suggest, automatic: true },
  luna: { name: 'GPT-6 Luna', company: 'OpenAI', keyLabel: 'OpenAI API key', keySetting: 'lunaKey', autoSetting: 'lunaAuto',
    defaultModel: luna.DEFAULT_MODEL, policy: luna.POLICY_VERSION, suggest: luna.suggest, automatic: true },
});

export function settingsFrom(saved = {}) {
  // Preserve configured Jev installations. Each provider's automatic selection is opt-in.
  const provider = Object.hasOwn(PROVIDERS, saved.aiProvider) ? saved.aiProvider : saved.jevKey || saved.jevModel ? 'jev' : 'luna';
  const details = PROVIDERS[provider];
  return { provider, on: saved.aiOn === true, auto: details.automatic && saved[details.autoSetting] === true,
    apiKey: saved[details.keySetting] || '', model: provider === 'jev' ? saved.jevModel || details.defaultModel : details.defaultModel };
}

export function suggest(items, context, config, options) {
  return PROVIDERS[config.provider].suggest(items, context, config, options);
}

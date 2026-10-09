import * as claude from './claude.js';

export const PROVIDERS = Object.freeze({
  claude: { name: 'Claude Haiku 5.5', company: 'Anthropic', keyLabel: 'Anthropic API key', keySetting: 'claudeKey',
    autoSetting: 'claudeAuto', defaultModel: claude.DEFAULT_MODEL, policy: claude.POLICY_VERSION,
    suggest: claude.suggest, reviewNotes: claude.reviewNotes, automatic: true },
});

export function settingsFrom(saved = {}) {
  // Dedicated Claude settings only: obsolete provider credentials are never reused.
  return { provider: 'claude', on: saved.aiOn === true, auto: saved.claudeAuto === true,
    apiKey: saved.claudeKey || '', model: claude.DEFAULT_MODEL };
}

export const suggest = (items, context, config, opts) => claude.suggest(items, context, config, opts);
export const reviewNotes = (record, config, opts) => claude.reviewNotes(record, config, opts);

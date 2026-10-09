import test from 'node:test';
import assert from 'node:assert/strict';

test('assistant upgrade removes obsolete credentials without changing Claude or quote settings', async () => {
  let saved = { aiOn: true, claudeKey: 'synthetic-anthropic', claudeAuto: true, lunaKey: 'synthetic-openai', lunaAuto: true, autoAdvance: false, agent: 'agent',
    aiKey: 'synthetic-legacy', jevKey: 'synthetic-retired', jevModel: 'retired-model', aiProvider: 'jev', aiAuto: true };
  let writes = 0;
  globalThis.chrome = { runtime: { getManifest: () => ({ version: 'test' }) }, storage: { local: {
    get: async key => ({ [key]: saved }), set: async patch => { saved = patch.settings; writes++; },
  } } };
  try {
    const usage = await import('../sidepanel/usage-log.js');
    assert.deepEqual(await usage.migrateAssistantSettings(), {
      aiOn: true, claudeKey: 'synthetic-anthropic', claudeAuto: true, autoAdvance: false, agent: 'agent',
    });
    assert.equal(writes, 1);
    await usage.migrateAssistantSettings();
    assert.equal(writes, 1, 'a clean profile is not rewritten');
  } finally {
    delete globalThis.chrome;
  }
});

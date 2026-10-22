// What the extension keeps in chrome.storage.local has a version (STORAGE_VERSION_KEY; none means
// a profile from before versions, 0). Each migration converts the stored data from the version
// before it to its own, in order and once, and is tested on a saved copy of every earlier version
// (test/storage-version.test.mjs). A reader then sees only the latest shape.
//
// A migration names the keys it reads (`keys`) and returns its changes: keys to set and keys to
// remove. Its removals go first; its sets go with its version, in one write, so the version never
// moves without them. A migration that fails changes nothing more: the data stays as the last one
// that went through left it, the version stays there, and it is tried again the next time the panel
// opens. Nothing is reset to defaults: agent corrections, pending AI approvals and the usage queue
// are kept here. A migration gives the same result when run again (a panel closed between its
// removals and its write). Data from a newer build (after going back to an older one) is left as
// it is.
//
// To change a stored shape: add a migration with the next `to`, and a saved copy of the version
// before it to the test.

export const STORAGE_VERSION_KEY = 'storageVersion';

export const MIGRATIONS = [
  {
    // The assistant's settings before Luna (0.9.x): the OpenAI and TypeSafe keys, the Jev model,
    // the provider and the old auto-select switch. Luna reads none of them (settingsFrom), and a
    // key no longer used isn't kept on the computer.
    to: 1,
    keys: ['settings'],
    run({ settings }) {
      const obsolete = ['aiKey', 'jevKey', 'jevModel', 'aiProvider', 'aiAuto'];
      if (!settings || !obsolete.some((key) => Object.hasOwn(settings, key))) return {};
      const clean = { ...settings };
      for (const key of obsolete) delete clean[key];
      return { set: { settings: clean } };
    },
  },
];

export const STORAGE_VERSION = MIGRATIONS.at(-1).to;

// Brings `area` (chrome.storage.local, or a stand-in with its get, set and remove) up to the last
// migration's version. Returns { from, to } and, when a migration failed, `failedAt` (its version)
// and `error`; `to` is then where the data stays.
export async function migrateStorage(area, migrations = MIGRATIONS) {
  const stored = (await area.get(STORAGE_VERSION_KEY))[STORAGE_VERSION_KEY];
  const from = stored ?? 0;
  const latest = migrations.at(-1)?.to ?? 0;
  if (!Number.isInteger(from) || from >= latest) return { from, to: from };
  let to = from;
  for (const m of migrations.filter((x) => x.to > from)) {
    try {
      const changes = (await m.run(m.keys?.length ? await area.get(m.keys) : {})) ?? {};
      if (changes.remove?.length) await area.remove(changes.remove);
      await area.set({ ...(changes.set ?? {}), [STORAGE_VERSION_KEY]: m.to });
    } catch (error) {
      return { from, to, failedAt: m.to, error };
    }
    to = m.to;
  }
  return { from, to };
}

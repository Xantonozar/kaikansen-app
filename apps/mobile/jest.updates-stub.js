/**
 * Jest stubs for the native modules the update runtime touches
 * (release readiness, 2026-11-11): AsyncStorage (snooze records),
 * expo-constants (installed build facts) and expo-intent-launcher
 * (the installer hand-off). The mobile suites are pure-logic only
 * (node env, no native modules) — src/appUpdateRuntime.tsx reaches
 * these packages, so they map here via moduleNameMapper.
 *
 * Each export shape mirrors what its consumer imports:
 * - AsyncStorage: the default export IS the storage object
 *   (src/storage.ts's plainStorage wraps getItem/setItem/
 *   removeItem) — an in-memory map, so nothing persists between
 *   suites beyond a file's own run.
 * - expo-constants: read as a default export with `expoConfig`
 *   (settings.tsx, appUpdateRuntime.tsx) — a fixed, honest test
 *   build (1.0.0 / code 2, this release's own facts).
 * - expo-intent-launcher: a namespace import — startActivityAsync
 *   resolves a success-shaped result and touches no device.
 *
 * Update BEHAVIOUR is unit-tested at the pure layer
 * (src/appUpdate.test.ts, src/aboutContent.test.ts); the native
 * behaviour (the real installer opening) is the owner's tap-test.
 */
const memory = new Map();

const asyncStorage = {
  getItem: async (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: async (key, value) => {
    memory.set(key, value);
  },
  removeItem: async (key) => {
    memory.delete(key);
  },
};

module.exports = {
  __esModule: true,
  default: asyncStorage,
  // expo-constants surface (consumed through the same mapped file
  // for its own module name — see jest.config.js).
  expoConfig: {
    version: '1.0.0',
    android: { versionCode: 2 },
  },
  // expo-intent-launcher surface.
  startActivityAsync: async () => ({ resultCode: -1 }),
};

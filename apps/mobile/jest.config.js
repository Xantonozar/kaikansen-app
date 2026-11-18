/**
 * Mobile unit tests (audit S6) — the app's first suite. Scope:
 * PURE logic only (src/*.test.ts): formatting, the playback
 * candidate chains, quiz timing, count-up interpolation and the
 * queue-origin ruling. Component/native behaviour is covered by
 * the owner's device tap-tests, not here.
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': '<rootDir>/jest.transformer.js',
  },
  // Bundled binary assets (rank-icon webp in rankUtil) resolve
  // through Metro at runtime; in tests they map to a stub id —
  // the table test asserts every iconAsset is a number, which
  // the stub satisfies without parsing binary content.
  moduleNameMapper: {
    '\\.(webp|png|jpg|jpeg|gif)$': '<rootDir>/jest.asset-stub.js',
    // expo-image is a native module; component modules reach it
    // through src/expoImage.ts. Pure-logic suites never render,
    // so the component maps to a stub (perf problem 11).
    '^expo-image$': '<rootDir>/jest.expo-image-stub.js',
    // @react-native-community/netinfo is a native module reached
    // through src/netInfo.ts by the connectivity provider. The
    // stub keeps an "unknown" posture in suites (offline screen).
    '^@react-native-community/netinfo$': '<rootDir>/jest.netinfo-stub.js',
    // AsyncStorage / expo-constants / expo-intent-launcher are
    // native modules reached by the update runtime
    // (src/appUpdateRuntime.tsx). Pure-logic suites exercise
    // appUpdate.ts with injected values instead; the stubs keep
    // any transitive import native-free (release readiness).
    '^@react-native-async-storage/async-storage$':
      '<rootDir>/jest.updates-stub.js',
    // expo-notifications is a native module reached by
    // src/chatPush.ts; pure-logic suites never register for
    // push, so it maps to the same inert stub family.
    '^expo-notifications$': '<rootDir>/jest.updates-stub.js',
    // expo-secure-store is a native module imported at module
    // level by src/storage.ts; suites that load storage
    // transitively (chat outbox / unread store) map it to an
    // in-memory stub.
    '^expo-secure-store$': '<rootDir>/jest.secure-store-stub.js',
    // react-native itself cannot load in the node test env;
    // modules that import Platform/AppState at module level
    // (storage, chat lifecycle) resolve to this minimal stub.
    '^react-native$': '<rootDir>/jest.react-native-stub.js',
    '^expo-constants$': '<rootDir>/jest.updates-stub.js',
    '^expo-intent-launcher$': '<rootDir>/jest.updates-stub.js',
  },
};

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
  },
};

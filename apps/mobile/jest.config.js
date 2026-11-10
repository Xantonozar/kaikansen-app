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
};

/**
 * Jest stub for react-native. The mobile suites are pure-logic
 * only (node env); a few src modules import react-native at
 * module level for Platform (src/storage.ts) or AppState
 * (src/chatLifecycle.ts), and suites that load those modules
 * transitively (chat outbox / unread store) need the import to
 * resolve without the real RN runtime. Only the surface those
 * modules touch is provided — rendering is never exercised here.
 */
module.exports = {
  Platform: {
    OS: 'android',
    select: (choices) => choices.android ?? choices.default,
  },
  AppState: {
    currentState: 'active',
    addEventListener: () => ({ remove: () => undefined }),
  },
  StyleSheet: {
    hairlineWidth: 1,
    create: (styles) => styles,
  },
};

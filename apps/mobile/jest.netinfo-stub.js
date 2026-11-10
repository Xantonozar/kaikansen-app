/**
 * Jest stub for '@react-native-community/netinfo' (offline screen).
 *
 * The mobile suites are pure-logic only (node env, no native
 * modules). src/netInfo.ts re-exports the real package's default
 * export; the connectivity provider reaches it transitively, so the
 * package maps here. The stub provides the runtime surface the
 * provider touches at import/subscribe time — addEventListener,
 * fetch, useNetInfo — with a permanently "unknown" posture: no
 * listener ever fires and fetch never settles a definitive sample,
 * so pure-logic suites that import component/provider modules are
 * never pushed offline by the stub. Connectivity BEHAVIOUR is
 * unit-tested at the pure decision layer (src/offline.test.ts);
 * the native behaviour is the owner's tap-test.
 */
module.exports = {
  __esModule: true,
  default: {
    addEventListener: () => () => {},
    fetch: () => new Promise(() => {}),
    useNetInfo: () => ({ isConnected: null, isInternetReachable: null }),
  },
};

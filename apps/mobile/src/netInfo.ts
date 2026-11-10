/**
 * The NetInfo module behind an indirection module (the expoImage.ts
 * pattern, perf problem 11): the mobile Jest suite is pure-logic
 * only (node env, no native modules — see jest.config.js), and the
 * connectivity provider imports this file. Jest maps the package to
 * a stub; Metro resolves the real one. Everything the app touches
 * at runtime is re-exported here so there is exactly one import
 * site to stub. (Type-only imports from the package are erased at
 * compile time and never reach the stub.)
 */
export { default } from '@react-native-community/netinfo';
export type { NetInfoState } from '@react-native-community/netinfo';

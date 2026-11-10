import type { StyleProp } from 'react-native';

/**
 * The `expo-image` module behind an indirection module.
 *
 * Why: the mobile Jest suite is pure-logic only (node environment,
 * no native modules — see jest.config.js), and several component
 * modules import this one transitively. Jest maps 'expo-image'
 * to a stub; Metro resolves the real package. Everything the app
 * needs from expo-image at runtime is re-exported here so there
 * is exactly one import site to stub.
 *
 * (Type-only imports from 'expo-image' are erased at compile
 * time and never reach the stub.)
 */
export { Image } from 'expo-image';
export type { ImageStyle, ImageErrorEventData } from 'expo-image';
export type { StyleProp };

/**
 * Pure props mapping for AppImage (unit-tested in
 * appImageMapping.test.ts): given the component's friendly
 * props, produce the exact expo-image props.
 */
export { appImageProps } from './appImageMapping';
export type { AppImageFit } from './appImageMapping';

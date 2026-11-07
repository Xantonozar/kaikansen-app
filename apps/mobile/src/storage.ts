import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * Two storage grades.
 *
 * `secure*` — for the refresh token (SECURITY_PRIVACY.md SEC-04: tokens
 * live in platform secure storage). Native uses expo-secure-store
 * (Keychain / Keystore). WEB falls back to AsyncStorage because
 * expo-secure-store's web module is an empty stub that silently drops
 * writes — a previous build lost every session on web to exactly this,
 * so the Platform branch is deliberate, not a shortcut.
 *
 * `plain*` — AsyncStorage on every platform, for non-secret local state
 * (theme choice, the fixture-mode demo account).
 */

export async function secureSet(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    await AsyncStorage.setItem(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

export async function secureGet(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    return AsyncStorage.getItem(key);
  }
  return SecureStore.getItemAsync(key);
}

export async function secureRemove(key: string): Promise<void> {
  if (Platform.OS === 'web') {
    await AsyncStorage.removeItem(key);
    return;
  }
  await SecureStore.deleteItemAsync(key);
}

export const plainStorage = {
  get: (key: string) => AsyncStorage.getItem(key),
  set: (key: string, value: string) => AsyncStorage.setItem(key, value),
  remove: (key: string) => AsyncStorage.removeItem(key),
};

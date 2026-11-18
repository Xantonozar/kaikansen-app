/**
 * Jest stub for expo-secure-store (a native module). src/storage.ts
 * imports it at module level, so any suite that transitively loads
 * storage (chat outbox persistence, the unread store) needs the
 * import to resolve in the node test env. In-memory only — the
 * secure grade's real Keychain/Keystore behaviour is the owner's
 * device tap-test, never a unit test.
 */
const memory = new Map();

module.exports = {
  getItemAsync: async (key) => (memory.has(key) ? memory.get(key) : null),
  setItemAsync: async (key, value) => {
    memory.set(key, value);
  },
  deleteItemAsync: async (key) => {
    memory.delete(key);
  },
};

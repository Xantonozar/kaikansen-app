/**
 * Jest stub for the 'expo-image' module (perf problem 11).
 *
 * The mobile suites are pure-logic only (node env, no native
 * modules). expoImage.ts re-exports the real package's Image
 * component; component modules that import it transitively
 * (AppImage, Avatar, …) would otherwise drag the native module
 * into the runner. The stub provides the runtime surface those
 * modules touch at import time: the Image component itself
 * (never rendered in these suites — render behaviour is the
 * owner's tap-test) — everything else from expo-image is
 * type-only and erased before Jest sees it.
 */
module.exports = {
  Image: function ExpoImageStub() {
    return null;
  },
};

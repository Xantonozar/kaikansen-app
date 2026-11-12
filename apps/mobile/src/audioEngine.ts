import {
  createAudioPlayer as createNativeAudioPlayer,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  type AudioMode,
  type AudioPlayer,
  type AudioSource,
  type AudioStatus,
} from 'expo-audio';

/**
 * The expo-audio adapter (playback plan, 2026-11-10) — the app's
 * real-audio-file engine: derived .ogg, genuine stored audio and
 * downloaded audio files play through expo-audio, while video
 * files stay on expo-video (Watch, and the untouchable
 * hidden-video listen fallback). The candidate chain is routed BY
 * FILE TYPE inside the chain (src/mediaEngine.ts owns the pure
 * routing decisions); this module owns the native player itself:
 *
 * - the app-wide audio mode (background playback ENABLED since
 *   the owner's 2026-11-12 ruling, and recording OFF — the owner
 *   ruled the mic off; the config plugin in app.json mirrors both
 *   in the native manifest/permissions);
 * - the two engine players (the shared playback engine's audio
 *   half + the quiz engine's audio half) so their imports and
 *   options live in exactly one place;
 * - the PRELOAD slot: one standalone player kept solely for
 *   preloading. A preload downloads the whole file into that
 *   player (paused); when the owning engine's turn comes for the
 *   same URL it ADOPTS the loaded player — the loaded bytes move
 *   with it — instead of re-creating a player and re-downloading
 *   (the plan's "reuse the handle, don't re-create" rule). The
 *   engine keeps at most one adopted preload player alive: when
 *   playback moves on to a different candidate, the adopted
 *   player is released and the slot is free to preload anew.
 *
 * Audio status normalisation: useAudioPlayerStatus emits at the
 * player's updateInterval (500ms — the plan's ~2/sec progress
 * cadence, same as the video engine's timeUpdateEventInterval).
 */
export type { AudioPlayer, AudioSource, AudioStatus };
export { useAudioPlayer, useAudioPlayerStatus };

/** Create a standalone audio player on the engines' shared
    options (imperative owners: the preload slot, the quiz
    engine's per-candidate players). */
export function createAudioPlayer(
  source: AudioSource = null,
): AudioPlayer {
  return createNativeAudioPlayer(source, AUDIO_PLAYER_OPTIONS);
}

/** Audio-player options the engines share: 500ms status updates
    (= the progress tick cadence) and plain streaming (downloadFirst
    is expo-asset resolution, not file caching — off). */
export const AUDIO_PLAYER_OPTIONS = {
  updateInterval: 500,
  downloadFirst: false,
} as const;

/**
 * The app's one audio-mode configuration. `shouldPlayInBackground`
 * is true (owner ruling 2026-11-12, reversing the 2026-11-10
 * background-off ruling): audio keeps playing when the app is
 * backgrounded or the screen locks, like a music player; the
 * expo-audio config plugin sets enableBackgroundPlayback true to
 * match (the Android foreground-service declaration). PiP for
 * video stays off — that is a separate ruling. Recording is off
 * (allowsRecording false + plugin microphonePermission false), so
 * no mic permission exists anywhere in the app.
 * `playsInSilentMode` matches the video engine's behaviour: the
 * old single expo-video player played through the ringer switch,
 * and splitting engines must not change what the user hears.
 */
export const AUDIO_MODE: AudioMode = {
  playsInSilentMode: true,
  interruptionMode: 'doNotMix',
  allowsRecording: false,
  shouldPlayInBackground: true,
  shouldRouteThroughEarpiece: false,
};

let audioModeApplied = false;

/**
 * Apply AUDIO_MODE once per launch (idempotent; failures are
 * swallowed — a platform without the module keeps the platform
 * defaults, and Android's defaults do not keep audio playing in
 * the background without the mode + plugin declaration).
 */
export function ensureAudioMode(): void {
  if (audioModeApplied) return;
  audioModeApplied = true;
  void setAudioModeAsync(AUDIO_MODE).catch(() => {
    // Best-effort: see above.
  });
}

let engineWarmed = false;

/**
 * Warm the native audio engine (solo quiz cold-start fix,
 * 2026-11-11): the first player creation in a launch carries
 * the expo-audio module's start-up cost, and a quiz's first
 * question used to pay it inside its own media wait — part of
 * why Q1's clip arrived seconds late. Creating (and immediately
 * releasing) one source-less player performs that start-up with
 * no audible output and no network file, and the one-time
 * audio-mode application rides along. Called when the solo quiz
 * screen mounts, so the create-game round trip covers the cost.
 * Idempotent; failures are swallowed (a platform without the
 * module simply stays cold, exactly as before).
 */
export function warmAudioEngine(): void {
  ensureAudioMode();
  if (engineWarmed) return;
  engineWarmed = true;
  try {
    const player = createNativeAudioPlayer(null, AUDIO_PLAYER_OPTIONS);
    try {
      player.remove();
    } catch {
      // Already released — the warm-up still happened.
    }
  } catch {
    // Native module unavailable (web/tests) — nothing to warm.
  }
}

/* ------------------------------------------------------------------ */
/* Preload slot                                                        */
/* ------------------------------------------------------------------ */

interface PreloadSlot {
  key: string;
  url: string;
  player: AudioPlayer;
  ready: boolean;
  errored: boolean;
  released: boolean;
  subscription: { remove: () => void } | null;
}

let slot: PreloadSlot | null = null;

function releaseSlot(): void {
  if (!slot) return;
  const old = slot;
  slot = null;
  old.released = true;
  try {
    old.subscription?.remove();
  } catch {
    // Already gone — nothing to detach.
  }
  try {
    old.player.remove();
  } catch {
    // Already released natively — nothing to free.
  }
}

/**
 * Start (or replace) the preload for `key`/`url`: the whole file
 * loads into the slot's player, paused. Re-preloading the same
 * key+url is a no-op (the load is already running or done), so
 * render-driven callers can invoke it freely.
 */
export function preloadAudio(key: string, url: string): void {
  ensureAudioMode();
  if (slot && !slot.released && slot.key === key && slot.url === url) {
    return;
  }
  releaseSlot();
  let player: AudioPlayer;
  try {
    player = createNativeAudioPlayer(null, AUDIO_PLAYER_OPTIONS);
  } catch {
    // Native module unavailable (web/tests) — preloads simply
    // never become ready and taps fall back to a fresh load.
    return;
  }
  const current: PreloadSlot = {
    key,
    url,
    player,
    ready: false,
    errored: false,
    released: false,
    subscription: null,
  };
  slot = current;
  try {
    current.subscription = player.addListener(
      'playbackStatusUpdate',
      (status) => {
        if (slot !== current || current.released) return;
        if (status.error) {
          current.errored = true;
          return;
        }
        if (status.isLoaded) current.ready = true;
      },
    );
  } catch {
    // Listener support is best-effort; readiness also polls below.
  }
  try {
    player.replace(url);
  } catch {
    current.errored = true;
  }
}

/** Whether the slot's preload for this key+url has loaded. */
export function isPreloadReady(key: string, url: string): boolean {
  if (!slot || slot.released || slot.errored) return false;
  if (slot.key !== key || slot.url !== url) return false;
  if (slot.ready) return true;
  // Poll fallback: the player's own loaded flag, read lazily so a
  // missed status event can never strand a finished preload.
  try {
    return slot.player.isLoaded;
  } catch {
    return false;
  }
}

/**
 * Hand the preloaded player to an engine: ownership moves (the
 * slot forgets it; the caller releases it via releaseAudioPlayer
 * when playback moves on). Returns null when the slot holds
 * nothing usable for this key+url — including a preload whose
 * source ERRORED, where a fresh load on the engine's own player
 * is the honest retry.
 */
export function adoptPreloadedPlayer(
  key: string,
  url: string,
): AudioPlayer | null {
  if (!slot || slot.released || slot.errored) return null;
  if (slot.key !== key || slot.url !== url) return null;
  const adopted = slot;
  slot = null;
  adopted.released = true;
  try {
    adopted.subscription?.remove();
  } catch {
    // Nothing to detach.
  }
  return adopted.player;
}

/** Drop the slot's preload (skip / queue change / unmount). */
export function discardPreload(key?: string): void {
  if (key !== undefined && slot && slot.key !== key) return;
  releaseSlot();
}

/** Release a player an engine adopted or created for playback. */
export function releaseAudioPlayer(player: AudioPlayer): void {
  try {
    player.remove();
  } catch {
    // Already released — nothing to free.
  }
}

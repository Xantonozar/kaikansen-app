import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { AppImage } from '../../src/components/AppImage';
import { Image as ExpoImage } from '../../src/expoImage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  useFocusEffect,
  useLocalSearchParams,
  useRouter,
} from 'expo-router';
import { VideoView } from 'expo-video';
import {
  Check,
  Download,
  Headphones,
  Maximize,
  Pause,
  Play,
  Repeat,
  Repeat1,
  RotateCcw,
  SkipBack,
  SkipForward,
  X,
} from 'lucide-react-native';
import type { PlaybackMode } from '@kaikansen/contracts';
import { fixtureMode } from '../../src/api';
import { downloadId, useDownloads } from '../../src/downloads';
import { entryHasAudio, formatTime } from '../../src/playback';
import { watchArtworkUnderPlayer } from '../../src/mediaEngine';
import { usePlaybackSession } from '../../src/playback-context';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  withOpacity,
  type Theme,
} from '../../src/theme';
import { useTheme } from '../../src/theme-context';
import { CONTENT_MAX_WIDTH } from '../../src/layout';

/**
 * Player route — full-screen Watch/Listen playback on expo-video,
 * opened from the Library (Offline rows), the Downloads screen and
 * playlist screens with { slug, mode, entry (atEntryId) }. The
 * theme detail screen no longer comes here: it plays INLINE on the
 * page, like the website and the design (the hero card is the
 * player).
 *
 * OWNER RULING (2026-11-10) — who may open this route: ONLY
 * playback started from a Playlist (playlist detail's Play All /
 * shuffle / row plays) or from Offline/Downloads (the Downloads
 * screen and the Library's Offline segment). EVERY other play
 * entry point — Home rails and Continue Listening, Search, Season
 * browse, Anime/Artist detail, Library Saved/Recent/AniList,
 * Favourites — claims its queue exactly as before but navigates
 * to the theme detail route (/theme/<slug>) instead; the detail
 * hero renders the claimed session inline, so nothing is lost.
 * Do not add new pushes to this route outside the two allowed
 * origins. The mini player follows the same rule: the playback
 * queue records its origin at claim time (see
 * src/playback-context.tsx, QUEUE ORIGIN), and the bar reopens
 * this route only for 'playlist'/'offline' sessions — any other
 * session's tap lands on the current track's theme detail.
 *
 * Composition follows the OWNER-APPROVED modern player design
 * (Stitch generation 2026-11-11, screen 1d540c33…, approved
 * 16:55 — the earlier Lavender Dusk mock's composition
 * superseded where they differ): a SAFE HEADER zone — the ✕ and
 * fullscreen discs are WHITE-glass, sit BELOW the status bar
 * with real clearance (a notched phone collided with the old
 * insets.top + spacing.sm overlay), and the fullscreen disc
 * shows in BOTH modes; the HERO is a rounded card inset from
 * the screen edges holding the media: in watch, the video; in
 * listen, the theme's portrait art shown WHOLE (contain)
 * centred over a blurred, darkened copy of the same art — never
 * a face-slicing cover crop; the OP/resolution chips sit at
 * the hero's bottom-left. Below: centred title block (song,
 * artist, "ANIME · SEASON YEAR" pill), the Watch/Listen
 * segmented toggle, the seek bar, and the transport row:
 * repeat · prev · pause disc · next · download. Repeat is
 * the provider's real repeat mode (off → queue → one, honoured
 * at track end — see src/playback-context.tsx); Download drives
 * the shared downloads store for the current theme + mode,
 * exactly like the detail screen's download sheet (tap again on
 * a downloaded track removes it; tap while downloading cancels).
 *
 * The playback engine itself — source resolution (highest-
 * resolution video for watch; the listen chain stored audio →
 * derived .ogg → the video file behind the artwork), offline-first
 * downloads, history recording, error/retry — lives in
 * src/usePlayback.ts, owned by the ONE PlaybackProvider instance
 * (src/playback-context.tsx) and shared with the detail screen and
 * the mini player.
 *
 * On focus the route ADOPTS its params into the shared session —
 * but only when they identify a different track than the session's
 * current item, and only once per distinct param set: when the
 * session runs a queue, the queue may advance the session well
 * past the params this route was opened with, and returning here
 * must never clobber that queue — the route renders whatever the
 * session holds, so an advance while the route is open is
 * FOLLOWED (media, title block and engine all move to the
 * now-playing theme), never hijacked back to the stale params.
 * When the session carries a queue, the mock's Up Next card
 * appears under the controls. The provider resolves the claimed
 * track's detail itself; this route no longer fetches.
 *
 * The resolution chip names the source ACTUALLY playing — the
 * engine's active URL matched back to the entry's video sources
 * (the fallback chain can land on a lower encode; a local
 * download or a fallback URL has no knowable resolution, so the
 * chip is then omitted, never guessed). It is a STATIC label:
 * owner ruling 2026-11-11 17:01 removed quality switching
 * entirely — playback is FIXED at the best available quality
 * (the watch chain starts highest and falls back down ONLY on
 * failure, which is reliability, not switching), so there is no
 * picker anywhere. Watch keeps contentFit "contain" so no frame
 * of a non-16:9 video is ever cropped.
 *
 * SURFACE DISCIPLINE (2026-11-11 restructure): the route's ONE
 * surface element is remounted KEYED BY MODE — born visible
 * in-flow in watch, born 1×1-hidden in listen, never restyled
 * between the forms (the always-mounted style-flip surface of
 * the interim fix is indicted by the owner's field reports —
 * see src/singleSurface.test.ts). The mode-keyed effect cleanup
 * calls the engine's surfaceDetach on every swap/unmount: the
 * player pauses synchronously (never playing while unbound),
 * and a watch resume waits for the NEW surface's first frame
 * through the surface-readiness gate (usePlayback).
 *
 * A usable local download renders the player even when the
 * catalogue fetch failed (fully offline open from the Library):
 * title block and artwork fall back to the download's stored
 * snapshot; the catalogue-only chips (type / resolution) and the
 * season pill simply don't render without a detail.
 */
export default function PlayerScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{
    slug: string;
    mode?: string;
    entry?: string;
  }>();
  const paramMode: PlaybackMode =
    params.mode === 'listen' ? 'listen' : 'watch';
  const paramEntry =
    params.entry != null && params.entry !== '' ? Number(params.entry) : null;

  const {
    session,
    playback,
    resolution,
    hasNext,
    hasPrev,
    next,
    prev,
    nextQueueItem,
    repeatMode,
    cycleRepeat,
    startSession,
    updateSession,
  } = usePlaybackSession();

  /* Param adoption (see the header): a distinct param set is
     adopted at most once. When the params identify the session's
     current track — the normal case when a list screen claimed a
     queue and pushed this route, or the mini player reopened it —
     the session is left exactly as it is (only its mode/active
     flags are reconciled), so the queue survives. When they
     identify a different track, the route claims that track as a
     fresh single play and the provider resolves its detail. Once
     adopted, later session movement (queue advances, another
     screen's claim) is followed, never fought. */
  const adoptedKeyRef = useRef<string | null>(null);
  const adoptParams = useCallback(() => {
    const key = `${params.slug}:${paramEntry ?? ''}:${paramMode}`;
    if (adoptedKeyRef.current === key) return;
    adoptedKeyRef.current = key;
    const currentEntryId =
      session.entry?.atEntryId ?? session.entryIdOverride ?? null;
    const sameTrack =
      session.slug === params.slug &&
      (paramEntry == null || paramEntry === currentEntryId);
    if (sameTrack) {
      if (session.mode !== paramMode || !session.active) {
        updateSession({ mode: paramMode, active: true });
      }
      return;
    }
    startSession({
      slug: params.slug,
      detail: null,
      entry: null,
      entryIdOverride: paramEntry,
      mode: paramMode,
      active: true,
    });
  }, [
    params.slug,
    paramEntry,
    paramMode,
    session.slug,
    session.entry,
    session.entryIdOverride,
    session.mode,
    session.active,
    startSession,
    updateSession,
  ]);
  useFocusEffect(adoptParams);

  /* Everything renders from the shared session: its detail (the
     provider resolves claimed tracks), its entry (the chips and
     the download target) and its mode (a queue keeps its claimed
     mode across tracks, so the toggle follows the session, not
     the possibly-stale params). */
  const detail = session.detail;
  const entry = session.entry ?? detail?.entries[0] ?? null;
  const mode = session.mode;
  const {
    surfacePlayer: player,
    notifySurfaceFirstFrame,
    surfaceDetach,
    localUsable,
    unavailable,
    buffering,
    playerError,
    ended,
    isPlaying,
    progress,
    fraction,
  } = playback;
  const videoRef = useRef<VideoView>(null);
  const [barWidth, setBarWidth] = useState(0);

  /* Surface discipline (2026-11-11 restructure): the surface
     below is keyed by mode, so a mode switch UNMOUNTS it — this
     cleanup (keyed by mode for the same reason) detaches on
     every swap and on route unmount: the engine pauses the
     player synchronously and forgets the old surface's
     readiness, so the binding never moves mid-play and the
     watch resume waits for the new surface's first frame. */
  const detachRef = useRef(surfaceDetach);
  detachRef.current = surfaceDetach;
  useEffect(
    () => () => detachRef.current({ resume: true }),
    [mode],
  );

  /* Download state for the current theme + mode — the same store
     and the same states the detail screen's download sheet shows. */
  const downloads = useDownloads();
  const dlEntryId = entry?.atEntryId ?? session.entryIdOverride ?? null;
  const dlId =
    session.slug && dlEntryId != null
      ? downloadId(session.slug, dlEntryId, mode)
      : null;
  const dlRecord =
    session.slug && dlEntryId != null
      ? downloads.find(session.slug, dlEntryId, mode)
      : undefined;
  const dlProgress = dlId ? downloads.progressFor(dlId) : undefined;
  const dlError = dlId ? downloads.errorFor(dlId) : null;
  const dlDownloading = dlProgress !== undefined;
  const dlDownloaded = !!dlRecord && !dlRecord.fileMissing;

  const closeDisc = (
    <Pressable
      onPress={() => router.back()}
      hitSlop={3}
      accessibilityRole="button"
      accessibilityLabel="Close player"
      style={({ pressed }) => [styles.glassDisc, pressed && styles.pressed]}
    >
      <X size={19} color="#2D2329" strokeWidth={2} />
    </Pressable>
  );

  // A usable local download renders the player even when the
  // catalogue fetch failed (fully offline open from the Library):
  // title block and artwork fall back to the download's stored
  // snapshot.
  if (!detail && !localUsable) {
    const resolutionFailed =
      resolution !== null &&
      resolution.slug === session.slug &&
      (resolution.status === 'missing' || resolution.status === 'error');
    return (
      <View style={styles.screen}>
        <View
          style={[styles.topRow, { paddingTop: insets.top + spacing.md }]}
        >
          {closeDisc}
        </View>
        <View style={styles.center}>
          {resolutionFailed ? (
            <Text style={styles.message}>
              {resolution.status === 'missing'
                ? 'That theme could not be found.'
                : 'Could not load this theme.'}
            </Text>
          ) : (
            <ActivityIndicator color={theme.accent} />
          )}
        </View>
      </View>
    );
  }

  // The listen hero shows this art WHOLE (contain) over its
  // blurred backdrop — the grill/cover precedence is unchanged
  // from the 16:9 era; contain simply never crops it now.
  const cover = detail
    ? (detail.animeGrillImage ?? detail.animeCoverImage)
    : (localUsable?.coverImage ?? null);
  const titleSong = detail?.songTitle ?? localUsable?.songTitle ?? '';
  const titleArtist = detail
    ? detail.allArtists.length > 0
      ? detail.allArtists.join(' / ')
      : (detail.artistName ?? '')
    : (localUsable?.artistName ?? '');
  const seasonPill = detail
    ? detail.animeSeason && detail.animeSeasonYear
      ? `${detail.animeTitle} · ${detail.animeSeason} ${detail.animeSeasonYear}`
      : detail.animeTitle
    : null;
  /* The media chips: the theme's type + sequence, and (watch
     only) the resolution of the source ACTUALLY playing — the
     engine's active URL matched back to the entry's video
     sources in the chain's own order. A fallback URL (entry /
     theme videoUrl) or a local download matches no source, so
     the chip is omitted rather than naming the highest
     resolution the entry merely offers. */
  const activeResolution =
    mode === 'watch' && entry && !localUsable && playback.url
      ? ([...entry.videoSources]
          .sort((a, b) => b.resolution - a.resolution)
          .find((v) => v.url === playback.url)?.resolution ?? null)
      : null;
  const listenAvailable = detail
    ? entryHasAudio(detail, entry)
    : mode === 'listen';

  const onSeek = (locationX: number) => {
    if (barWidth <= 0) return;
    playback.seekToRatio(locationX / barWidth);
  };

  const onDownloadPress = () => {
    if (!dlId) return;
    if (dlDownloading) {
      void downloads.cancel(dlId);
    } else if (dlDownloaded) {
      void downloads.remove(dlId);
    } else if (detail && entry) {
      void downloads.start(detail, entry, mode);
    }
  };

  const RepeatIcon = repeatMode === 'one' ? Repeat1 : Repeat;
  const nextDisabled = !hasNext && repeatMode !== 'queue';

  return (
    <View style={styles.screen}>
      <View style={styles.column}>
        {/* Safe header (approved modern design): a real
            status-bar-safe zone — the white-glass ✕ / fullscreen
            discs sit fully BELOW the status bar with a real gap
            (the old insets.top + spacing.sm overlay collided on
            the owner's notched phone). NOT an overlay: the row
            takes layout space above the hero card. */}
        <View
          style={[
            styles.headerRow,
            { paddingTop: insets.top + spacing.md },
          ]}
        >
          {closeDisc}
          <Pressable
            onPress={() => {
              void videoRef.current?.enterFullscreen();
            }}
            hitSlop={3}
            accessibilityRole="button"
            accessibilityLabel="Fullscreen"
            style={({ pressed }) => [
              styles.glassDisc,
              pressed && styles.pressed,
            ]}
          >
            <Maximize size={19} color="#2D2329" strokeWidth={2} />
          </Pressable>
        </View>
        <View style={styles.mediaWrap}>
          {mode === 'watch' ? (
            <>
              {/* Perf problem 7: the anime artwork sits UNDER the
                  video surface until frames render (initial load)
                  — the hero never sits black while a source
                  loads. Once frames render the VideoView's own
                  black canvas + the video fully cover it. */}
              {watchArtworkUnderPlayer({
                hasArtwork: !!cover,
                framesRendered: playback.framesRendered,
              }) && cover ? (
                <AppImage
                  source={cover}
                  style={styles.artworkUnder}
                  resizeMode="cover"
                />
              ) : null}
            </>
          ) : (
            <>
              {/* Listen hero (approved modern design): the
                  theme's art shown WHOLE (contain), centred,
                  over a blurred + darkened copy of the same art
                  filling the card — the wide AniList art is never
                  face-sliced by a cover crop again. The blur
                  layer is a raw expo-image (AppImage's mapping
                  has no blurRadius); the dark scrim sits between
                  backdrop and art. */}
              {cover ? (
                <>
                  <ExpoImage
                    source={{ uri: cover }}
                    style={styles.heroBackdrop}
                    contentFit="cover"
                    blurRadius={24}
                    cachePolicy="memory-disk"
                    transition={0}
                  />
                  <View style={styles.heroScrim} />
                  <AppImage
                    source={cover}
                    style={styles.artworkContain}
                    resizeMode="contain"
                  />
                </>
              ) : (
                <View
                  style={[styles.artworkContain, styles.artworkPlaceholder]}
                />
              )}
            </>
          )}
          {/* The route's ONE surface element (2026-11-11
              restructure): remounted KEYED BY MODE — born
              visible in-flow inside the hero card in watch,
              born 1×1-hidden in listen (where the audio still
              plays through the player with no video frame). It
              is NEVER restyled between the forms: the interim
              always-mounted style-flip surface shipped in
              1.0.0/1.0.1 and the owner's field reports indicted
              it (audio fine; video dead, or frames for ~3s then
              death). The mode-keyed detach effect above pauses
              the player before this element unmounts, and the
              watch form's first rendered frame releases the
              gated resume. textureView: it composites like a
              normal view inside this screen's overlays. In
              listen the VideoView renders AFTER the artwork
              (sibling order) but is 1×1 opacity-0 absolute —
              invisible by construction. */}
          <VideoView
            key={mode}
            ref={videoRef}
            player={player}
            style={mode === 'watch' ? styles.video : styles.hiddenSurface}
            contentFit="contain"
            nativeControls={false}
            surfaceType="textureView"
            onFirstFrameRender={
              mode === 'watch'
                ? () => notifySurfaceFirstFrame({ visible: true })
                : undefined
            }
          />
          {buffering && (
            <View style={styles.overlayCenter}>
              <ActivityIndicator color="#FFFFFF" size="large" />
            </View>
          )}
          {detail && (
            <View style={styles.mediaChips}>
              <View style={styles.opChip}>
                <Text style={styles.opChipText}>
                  {detail.type} {detail.sequence}
                </Text>
              </View>
              {activeResolution !== null && (
                <View style={styles.resChip}>
                  <View style={styles.resDot} />
                  <Text style={styles.resChipText}>
                    {activeResolution}p
                  </Text>
                </View>
              )}
            </View>
          )}
        </View>

        {/* The mock's centre stack: title block, mode toggle and
            controls spread evenly through the space between the
            hero and the bottom-pinned Up Next card. */}
        <View style={styles.middle}>
        {/* Centred title block (the mock): song, artist, and the
            "ANIME · SEASON YEAR" pill. */}
        <View style={styles.titleBlock}>
          <Text style={styles.songTitle} numberOfLines={1}>
            {titleSong}
          </Text>
          {titleArtist ? (
            <Text style={styles.artistLine} numberOfLines={1}>
              {titleArtist}
            </Text>
          ) : null}
          {seasonPill ? (
            <View style={styles.seasonPill}>
              <Text style={styles.seasonPillText} numberOfLines={1}>
                {seasonPill}
              </Text>
            </View>
          ) : null}
        </View>

        {/* Watch/Listen toggle — the session's mode switch (the
            same segmented treatment as the detail page's). */}
        <View style={styles.modeToggle}>
          {(
            [
              { value: 'watch', label: 'Watch', Icon: Play },
              { value: 'listen', label: 'Listen', Icon: Headphones },
            ] as const
          ).map(({ value, label, Icon }) => {
            const active = mode === value;
            const disabled = value === 'listen' && !listenAvailable;
            return (
              <Pressable
                key={value}
                onPress={() => updateSession({ mode: value })}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityLabel={label}
                accessibilityState={{ selected: active, disabled }}
                style={({ pressed }) => [
                  styles.modeSegment,
                  active && styles.modeSegmentActive,
                  disabled && styles.segmentDisabled,
                  pressed && styles.pressed,
                ]}
              >
                <Icon
                  size={13}
                  color={
                    disabled
                      ? theme.muted
                      : active
                        ? theme.onAccent
                        : theme.secondary
                  }
                  strokeWidth={2}
                />
                <Text
                  style={[
                    styles.modeSegmentText,
                    active && styles.modeSegmentTextActive,
                    disabled && { color: theme.muted },
                  ]}
                >
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.controls}>
          {unavailable ? (
            <Text style={styles.message}>
              {fixtureMode
                ? 'Playback is not available in demo mode for this theme.'
                : 'No playable source is available for this version.'}
            </Text>
          ) : playerError ? (
            <>
              <Text style={styles.message}>{playerError}</Text>
              <Pressable
                onPress={playback.retry}
                accessibilityRole="button"
                accessibilityLabel="Try again"
                style={({ pressed }) => [
                  styles.retryButton,
                  pressed && styles.pressed,
                ]}
              >
                <RotateCcw size={17} color={theme.onAccent} strokeWidth={2} />
                <Text style={styles.retryText}>Try again</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Pressable
                onLayout={(e) => setBarWidth(e.nativeEvent.layout.width)}
                onPress={(e) => onSeek(e.nativeEvent.locationX)}
                accessibilityRole="adjustable"
                accessibilityLabel="Seek"
                style={styles.seekHit}
              >
                <View style={styles.seekTrack}>
                  <View
                    style={[styles.seekFill, { width: `${fraction * 100}%` }]}
                  />
                  <View
                    style={[
                      styles.seekKnob,
                      { left: `${fraction * 100}%` },
                    ]}
                  />
                </View>
              </Pressable>
              <View style={styles.timeRow}>
                <Text style={styles.timeText}>
                  {formatTime(progress.current)}
                </Text>
                <Text style={styles.timeText}>
                  {formatTime(progress.duration)}
                </Text>
              </View>
              {/* Transport (the mock): repeat · prev · pause disc ·
                  next · download. */}
              <View style={styles.transport}>
                <Pressable
                  onPress={cycleRepeat}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel={`Repeat: ${repeatMode}`}
                  style={({ pressed }) => [
                    styles.transportButton,
                    pressed && styles.pressed,
                  ]}
                >
                  <RepeatIcon
                    size={22}
                    color={
                      repeatMode === 'off' ? theme.secondary : theme.accent
                    }
                    strokeWidth={2}
                  />
                </Pressable>
                <Pressable
                  onPress={prev}
                  disabled={!hasPrev}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel="Previous track"
                  accessibilityState={{ disabled: !hasPrev }}
                  style={({ pressed }) => [
                    styles.transportButton,
                    !hasPrev && styles.navDisabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <SkipBack size={28} color={theme.secondary} strokeWidth={2} />
                </Pressable>
                <Pressable
                  onPress={playback.toggleMain}
                  accessibilityRole="button"
                  accessibilityLabel={
                    ended ? 'Replay' : isPlaying ? 'Pause' : 'Play'
                  }
                  style={({ pressed }) => [
                    styles.mainButton,
                    pressed && styles.pressed,
                  ]}
                >
                  {ended ? (
                    <RotateCcw size={32} color={theme.onAccent} strokeWidth={2} />
                  ) : isPlaying ? (
                    <Pause size={32} color={theme.onAccent} strokeWidth={2} />
                  ) : (
                    <Play size={32} color={theme.onAccent} strokeWidth={2} />
                  )}
                </Pressable>
                <Pressable
                  onPress={next}
                  disabled={nextDisabled}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel="Next track"
                  accessibilityState={{ disabled: nextDisabled }}
                  style={({ pressed }) => [
                    styles.transportButton,
                    nextDisabled && styles.navDisabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <SkipForward
                    size={28}
                    color={theme.secondary}
                    strokeWidth={2}
                  />
                </Pressable>
                <Pressable
                  onPress={onDownloadPress}
                  disabled={!dlId || (!dlDownloading && !dlDownloaded && !detail)}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel={
                    dlDownloading
                      ? 'Cancel download'
                      : dlDownloaded
                        ? 'Downloaded — tap to remove'
                        : 'Download for offline playback'
                  }
                  accessibilityState={{
                    disabled:
                      !dlId ||
                      (!dlDownloading && !dlDownloaded && !detail),
                  }}
                  style={({ pressed }) => [
                    styles.transportButton,
                    !dlId && styles.navDisabled,
                    pressed && styles.pressed,
                  ]}
                >
                  {dlDownloading ? (
                    dlProgress !== null ? (
                      <Text style={styles.dlPercent}>
                        {Math.floor(dlProgress * 100)}%
                      </Text>
                    ) : (
                      <ActivityIndicator size="small" color={theme.accent} />
                    )
                  ) : dlDownloaded ? (
                    <Check size={22} color={theme.success} strokeWidth={2} />
                  ) : (
                    <Download
                      size={22}
                      color={detail ? theme.secondary : theme.muted}
                      strokeWidth={2}
                    />
                  )}
                </Pressable>
              </View>
              {dlError && !dlDownloading && (
                <Text style={styles.dlErrorText}>{dlError}</Text>
              )}
            </>
          )}
        </View>
        </View>

        {/* Up Next (the approved modern design's card): 40pt
            cover thumbnail + eyebrow + one line
            "title — artist" + lavender play disc. (The earlier
            mock drew no thumbnail; the approved design does, and
            the queue item carries its cover.) Tapping it — or
            its play disc — skips to it, same as the Next
            control. */}
        {hasNext && nextQueueItem && (
          <Pressable
            onPress={next}
            accessibilityRole="button"
            accessibilityLabel={`Up next: ${nextQueueItem.title}. Play it next`}
            style={({ pressed }) => [
              styles.upNext,
              pressed && styles.pressed,
            ]}
          >
            {nextQueueItem.coverUrl ? (
              <AppImage
                source={nextQueueItem.coverUrl}
                style={styles.upNextThumb}
              />
            ) : (
              <View style={[styles.upNextThumb, styles.artworkPlaceholder]} />
            )}
            <View style={styles.upNextText}>
              <Text style={styles.upNextEyebrow}>Up next</Text>
              <Text style={styles.upNextLine} numberOfLines={1}>
                {nextQueueItem.title} — {nextQueueItem.artistLine}
              </Text>
            </View>
            <View style={styles.upNextDisc}>
              <Play size={16} color={theme.accent} strokeWidth={2} />
            </View>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: theme.background,
    },
    column: {
      flex: 1,
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
    },
    topRow: {
      paddingHorizontal: spacing.screenEdge,
      paddingBottom: spacing.sm,
    },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: spacing.xxl,
    },
    message: {
      ...typeStyles.body,
      color: theme.muted,
      textAlign: 'center',
      paddingHorizontal: spacing.screenEdge,
    },
    // The hero CARD (approved modern design): inset from the
    // screen edges, cardLg radius, clipped — the media lives
    // inside it instead of bleeding edge-to-edge.
    mediaWrap: {
      position: 'relative',
      marginHorizontal: spacing.screenEdge,
      aspectRatio: 16 / 9,
      borderRadius: radii.cardLg,
      overflow: 'hidden',
      backgroundColor: '#251B22',
    },
    video: {
      position: 'absolute',
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      backgroundColor: '#000',
    },
    // Listen hero layers (approved design): blurred backdrop
    // fill + dark scrim + the art itself, whole (contain).
    heroBackdrop: {
      position: 'absolute',
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      transform: [{ scale: 1.25 }],
    },
    heroScrim: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(37, 27, 34, 0.45)',
    },
    artworkContain: {
      position: 'absolute',
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
    },
    // Watch artwork-under-player (perf problem 7): absolutely
    // fills mediaWrap's 16:9 canvas, behind the VideoView.
    artworkUnder: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
    },
    artworkPlaceholder: {
      backgroundColor: theme.raised,
    },
    hiddenSurface: {
      position: 'absolute',
      width: 1,
      height: 1,
      opacity: 0,
    },
    overlayCenter: {
      ...StyleSheet.absoluteFill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    // Safe header row (approved design): holds the two discs
    // above the hero card, inside the status-bar-safe zone.
    headerRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.screenEdge,
      paddingBottom: spacing.md,
    },
    glassDisc: {
      // The design's discs are 36pt WHITE glass with ink icons
      // (w-9 h-9, white/70 fill + hairline border + soft shadow).
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: 'rgba(255, 255, 255, 0.7)',
      borderWidth: 1,
      borderColor: theme.border,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: '#2D2329',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.1,
      shadowRadius: 6,
      elevation: 2,
    },
    mediaChips: {
      position: 'absolute',
      left: spacing.md,
      bottom: spacing.md,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    // Type chip (HTML): dark glass, small square corners.
    opChip: {
      backgroundColor: 'rgba(16, 7, 12, 0.5)',
      borderRadius: 6,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: spacing.xs,
    },
    opChipText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 12,
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      color: '#FFFFFF',
    },
    // Resolution chip (HTML): translucent WHITE glass pill with
    // a green dot — a different treatment from the type chip.
    resChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs + 2,
      backgroundColor: 'rgba(255, 255, 255, 0.2)',
      borderRadius: radii.pill,
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
    },
    resChipText: {
      fontFamily: fontFamilies.caption,
      fontSize: 10,
      color: 'rgba(255, 255, 255, 0.9)',
    },
    resDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: theme.success,
    },
    // Centre stack (HTML: flex-1, justify-evenly) between the
    // hero and the bottom-pinned Up Next card.
    middle: {
      flex: 1,
      justifyContent: 'space-evenly',
    },
    titleBlock: {
      alignItems: 'center',
      paddingHorizontal: spacing.xxl,
      gap: spacing.xs,
    },
    songTitle: {
      // Design: 22pt extrabold ink.
      fontFamily: fontFamilies.display,
      fontSize: 22,
      color: theme.text,
      textAlign: 'center',
    },
    artistLine: {
      // Design: 14pt medium in mauve (theme.secondary).
      fontFamily: fontFamilies.caption,
      fontSize: 14,
      color: theme.secondary,
      textAlign: 'center',
    },
    seasonPill: {
      // Design chip: mauveDeep text on the mauveLight wash with
      // a hairline mauve border.
      backgroundColor: withOpacity(theme.accentContainer, 0.5),
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: 3,
      marginTop: spacing.xs,
      maxWidth: '100%',
    },
    seasonPillText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 11,
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      color: theme.accent,
    },
    modeToggle: {
      // The mock's toggle is a CENTRED, content-width pill
      // (HTML: inline-flex, p-1, hairline ring), not a
      // full-width bar.
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'center',
      gap: spacing.xs,
      padding: spacing.xs,
      borderRadius: radii.pill,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.accentContainer,
    },
    modeSegment: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs + 2,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.xs + 2,
      borderRadius: radii.pill,
    },
    modeSegmentActive: {
      backgroundColor: theme.accent,
    },
    segmentDisabled: {
      opacity: 0.55,
    },
    modeSegmentText: {
      ...typeStyles.bodySmall,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.secondary,
    },
    modeSegmentTextActive: {
      ...typeStyles.bodySmall,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccent,
    },
    controls: {
      gap: spacing.md,
    },
    seekHit: {
      // HTML: the seek section is inset 28pt from the canvas.
      paddingHorizontal: 28,
      paddingVertical: spacing.sm,
    },
    seekTrack: {
      // Design: 6pt track in the mauveLight tone (theme.raised).
      height: 6,
      borderRadius: 3,
      backgroundColor: theme.raised,
      justifyContent: 'center',
    },
    seekFill: {
      height: 6,
      borderRadius: 3,
      backgroundColor: theme.accent,
    },
    seekKnob: {
      // Design: 16pt WHITE thumb with a 2pt mauveDeep ring.
      position: 'absolute',
      width: 16,
      height: 16,
      borderRadius: 8,
      marginLeft: -8,
      backgroundColor: '#FFFFFF',
      borderWidth: 2,
      borderColor: theme.accent,
      shadowColor: '#000000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.2,
      shadowRadius: 2,
      elevation: 2,
    },
    timeRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: 28,
    },
    timeText: {
      // Design: 11pt medium muted, body face (not mono).
      fontFamily: fontFamilies.caption,
      fontSize: 11,
      color: theme.muted,
    },
    transport: {
      // HTML: the five controls spread across the row (px-8,
      // justify-between) instead of clustering at the centre.
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.xxxl,
      marginTop: spacing.sm,
    },
    transportButton: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    navDisabled: {
      opacity: 0.3,
    },
    mainButton: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: theme.accent,
      alignItems: 'center',
      justifyContent: 'center',
      // HTML: a soft mauve-tinted drop shadow under the disc.
      shadowColor: theme.accent,
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.25,
      shadowRadius: 12,
      elevation: 6,
    },
    dlPercent: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.accent,
    },
    dlErrorText: {
      ...typeStyles.caption,
      color: theme.accent,
      textAlign: 'center',
      paddingHorizontal: spacing.screenEdge,
    },
    retryButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      backgroundColor: theme.accent,
      borderRadius: 14,
      minHeight: 46,
      paddingHorizontal: spacing.lg,
      alignSelf: 'center',
    },
    retryText: {
      ...typeStyles.sectionLabel,
      color: theme.onAccent,
    },
    upNext: {
      // HTML: bottom-pinned footer card — mx-5, mb-6, p-3.5,
      // rounded-2xl, hairline border.
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: theme.surface,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: theme.border,
      padding: spacing.md + 2,
      marginHorizontal: spacing.xl,
      marginBottom: spacing.xxl,
    },
    upNextThumb: {
      // Design: 40pt cover thumb, rounded-xl.
      width: 40,
      height: 40,
      borderRadius: radii.base,
      backgroundColor: theme.surface,
    },
    upNextText: {
      flex: 1,
      gap: 2,
    },
    upNextEyebrow: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 11,
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      color: theme.secondary,
    },
    upNextLine: {
      // HTML: 14pt medium.
      fontFamily: fontFamilies.caption,
      fontSize: 14,
      color: theme.text,
    },
    upNextDisc: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: theme.accentContainer,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pressed: {
      opacity: 0.85,
    },
  });

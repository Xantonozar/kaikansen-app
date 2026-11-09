import { useState } from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '../auth';

/**
 * The AniList link action, shared by Settings and the drawer so both
 * surfaces behave identically (same busy state, same note/error
 * wording — including the 409 message the auth provider produces and
 * the fixture-mode placeholder).
 *
 * Fixture/demo mode has no API, and web has no custom-scheme auth
 * session to return to, so the flow is not started there; the caller
 * surfaces `note` ("AniList linking isn’t available in this build.")
 * exactly as Settings always has.
 */
export function useAnilistLink() {
  const { demoMode, anilistUsername, linkAnilist } = useAuth();
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkNote, setLinkNote] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  const startLink = async () => {
    if (demoMode || Platform.OS === 'web') {
      setLinkError(null);
      setLinkNote('AniList linking isn’t available in this build.');
      return;
    }
    if (linkBusy) return;
    setLinkBusy(true);
    setLinkNote(null);
    setLinkError(null);
    try {
      const username = await linkAnilist();
      // Return affirmatively to where the link started. The flow
      // pushed the handoff screen onto the root stack, and the
      // provider's pop of it on settle is best-effort (src/auth.tsx:
      // gated on the handoff screen's mounted registration) — when
      // it is skipped, the user would be stranded on the waiting
      // screen over a completed link. Dismissing the root stack's
      // pushed screens lands back on the (drawer) shell with the
      // drawer navigator's own state untouched, i.e. exactly this
      // screen (Settings / the drawer), never Home.
      if (router.canDismiss()) router.dismissAll();
      setLinkNote(`AniList account linked as ${username}.`);
    } catch (e: unknown) {
      setLinkError(
        e instanceof Error ? e.message : 'AniList linking failed. Please try again.',
      );
    } finally {
      setLinkBusy(false);
    }
  };

  return { anilistUsername, linkBusy, linkNote, linkError, startLink };
}

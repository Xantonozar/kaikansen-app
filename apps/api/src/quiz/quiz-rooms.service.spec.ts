import { QuizRoomsService, RoomActionError } from './quiz-rooms.service';

/* ------------------------------------------------------------------ */
/* In-memory stand-ins. Room docs are shared object references (like   */
/* hydrated Mongoose docs): the service mutates them and save() is a   */
/* no-op. $sample is deterministic (first N matches).                  */
/* ------------------------------------------------------------------ */

function getPath(doc: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object') {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, doc);
}

function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') {
      return (cond as Record<string, unknown>[]).some((sub) => matches(doc, sub));
    }
    if (key === '$expr') {
      const expr = cond as { $lt: [{ $size: string }, string] };
      const arr = getPath(doc, expr.$lt[0].$size.replace(/^\$/, '')) as unknown[];
      const limit = getPath(doc, expr.$lt[1].replace(/^\$/, '')) as number;
      return Array.isArray(arr) && arr.length < limit;
    }
    const value = getPath(doc, key);
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      const ops = cond as Record<string, unknown>;
      if ('$nin' in ops) {
        return !(ops.$nin as unknown[]).some(
          (v) => v === value || (v == null && value == null),
        );
      }
      if ('$ne' in ops) return value !== ops.$ne;
      if ('$in' in ops) {
        return (ops.$in as unknown[]).some((v) => String(v) === String(value));
      }
      if ('$size' in ops) return Array.isArray(value) && value.length === ops.$size;
      if ('$exists' in ops) return ops.$exists ? value !== undefined : value === undefined;
    }
    return value === cond;
  });
}

function chain(docs: Record<string, unknown>[]) {
  const q: Record<string, unknown> = {};
  q.sort = () => q;
  q.limit = () => q;
  q.lean = () => q;
  q.select = () => q;
  q.exec = async () => docs;
  return q;
}

function queryOf(result: unknown) {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.lean = () => q;
  q.exec = async () => result;
  return q;
}

const HOST = '507f1f77bcf86cd7994390a1';
const GUEST = '507f1f77bcf86cd7994390a2';
const GUEST2 = '507f1f77bcf86cd7994390a3';
const OUTSIDER = '507f1f77bcf86cd7994390a4';

function makeTheme(id: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    _id: id,
    slug: `${id}-slug`,
    songTitle: `${title} Song`,
    animeTitle: title,
    animeTitleEnglish: `${title} EN`,
    animeTitleAlternative: [],
    artistName: `${title} Artist`,
    anilistId: 777,
    animeCoverImage: 'https://img/cover.jpg',
    animeCoverImageSmall: 'https://img/cover-s.jpg',
    type: 'OP',
    sequence: 1,
    entries: [{ atEntryId: 42, videoSources: [{ url: 'https://src/0.webm' }] }],
    videoUrl: 'https://video/main.webm',
    audioUrl: 'https://audio/main.webm',
    isPopular: true,
    ...extra,
  };
}

/**
 * Perf-problem-6 probe: wraps a fake models object and counts
 * the library reads the room engine issues.
 *
 * - users.find is the contribution computation's signature
 *   read (the AniList id lookup): a whole-roster computation
 *   issues exactly ONE users.find for the entire roster (the
 *   web's buildRoomPlayerLibraryProfiles reads all players in
 *   one find), a join-time computation issues one for the
 *   joiner. contributions() = users.find count.
 * - distinct reads the three per-player library models
 *   (history/ratings/favourites distinctCalls counters). The
 *   dynamicThemeFilter also issues distincts — these tests
 *   stay on common/anilist pools, whose round paths never
 *   call it, so distinct totals here are library-only.
 * - themesFind counts theme-catalogue finds (candidate
 *   derivation, NOT a library read — tracked only to show it
 *   is deliberately excluded from the assertions).
 */
function withLibrarySpies(m: ReturnType<typeof makeFakeModels>) {
  const counts = { usersFind: 0, themesFind: 0 };
  const origUserFind = m.userModel.find.bind(m.userModel);
  (m.userModel as Record<string, unknown>).find = (
    filter: Record<string, unknown>,
  ) => {
    counts.usersFind += 1;
    return origUserFind(filter);
  };
  const origThemesFind = m.themeModel.find.bind(m.themeModel);
  (m.themeModel as Record<string, unknown>).find = (
    filter: Record<string, unknown>,
  ) => {
    counts.themesFind += 1;
    return origThemesFind(filter);
  };
  return {
    counts,
    distinct(): number {
      return (
        m.historyModel.distinctCalls +
        m.ratingsModel.distinctCalls +
        m.favoritesModel.distinctCalls
      );
    },
    /** Contribution-computation passes (one users.find each). */
    contributions(): number {
      return counts.usersFind;
    },
  };
}

function makeFakeModels() {
  const themes: Record<string, unknown>[] = [
    makeTheme('theme-correct', 'Correct'),
    makeTheme('theme-d1', 'Distractor1'),
    makeTheme('theme-d2', 'Distractor2'),
    makeTheme('theme-d3', 'Distractor3'),
    makeTheme('theme-d4', 'Distractor4'),
    makeTheme('theme-d5', 'Distractor5'),
  ];
  const users: Record<string, unknown>[] = [
    { _id: HOST, username: 'host', displayName: 'Host', avatarUrl: 'https://img/host.png', anilist: { completedMediaIds: [] } },
    { _id: GUEST, username: 'guest', displayName: 'Guest', avatarUrl: null, anilist: { completedMediaIds: [] } },
    { _id: GUEST2, username: 'guest2', displayName: 'Guest Two', avatarUrl: null, anilist: { completedMediaIds: [] } },
    { _id: OUTSIDER, username: 'outsider', displayName: 'Out', avatarUrl: null, anilist: { completedMediaIds: [] } },
  ];
  const rooms: Record<string, unknown>[] = [];
  let roomSeq = 0;
  const history: Record<string, unknown>[] = [];

  const themeModel = {
    docs: themes,
    aggregate: (pipeline: Record<string, unknown>[]) => {
      let result = [...themes];
      for (const step of pipeline) {
        if (step.$match) {
          result = result.filter((t) => matches(t, step.$match as Record<string, unknown>));
        }
        if (step.$sample) {
          result = result.slice(0, (step.$sample as { size: number }).size);
        }
        if (step.$project) {
          const keys = Object.keys(step.$project as Record<string, unknown>);
          result = result.map((t) => {
            const projected: Record<string, unknown> = { _id: t._id };
            for (const k of keys) projected[k] = t[k];
            return projected;
          });
        }
      }
      return queryOf(result);
    },
    find: (filter: Record<string, unknown>) =>
      chain(themes.filter((t) => matches(t, filter))),
  };

  const userModel = {
    docs: users,
    findById: (id: string) =>
      queryOf(users.find((u) => String(u._id) === String(id)) ?? null),
    find: (filter: Record<string, unknown>) =>
      chain(users.filter((u) => matches(u, filter))),
  };

  const roomModel = {
    docs: rooms,
    create: async (data: Record<string, unknown>) => {
      const doc: Record<string, unknown> = {
        _id: `room-${++roomSeq}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        currentRound: 0,
        emptySince: null,
        usedThemeIds: [],
        rounds: [],
        timerAuthority: null,
        ...data,
      };
      doc.save = async () => doc;
      rooms.push(doc);
      return doc;
    },
    findById: (id: string) =>
      queryOf(rooms.find((r) => String(r._id) === String(id)) ?? null),
    findOne: (filter: Record<string, unknown>) =>
      queryOf(rooms.find((r) => matches(r, filter)) ?? null),
    find: (filter: Record<string, unknown>) =>
      chain(rooms.filter((r) => matches(r, filter))),
    updateOne: (
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
    ) => {
      const room = rooms.find((r) => String(r._id) === String(filter._id));
      const player = room?.players
        ? (room.players as Record<string, unknown>[]).find(
            (p) => p.userId === (filter['players.userId'] as string),
          )
        : undefined;
      if (!room || !player) return queryOf({ matchedCount: 0 });
      const set = (update.$set ?? {}) as Record<string, unknown>;
      player.lastSeenAt = set['players.$.lastSeenAt'];
      return queryOf({ matchedCount: 1 });
    },
    findByIdAndDelete: (id: string) => {
      const idx = rooms.findIndex((r) => String(r._id) === String(id));
      const [removed] = idx >= 0 ? rooms.splice(idx, 1) : [null];
      return queryOf(removed);
    },
  };

  const ratings: Record<string, unknown>[] = [];
  const favorites: Record<string, unknown>[] = [];
  const ratingsModel = {
    docs: ratings,
    /** Spy knob: total distinct() calls issued against this model. */
    distinctCalls: 0,
    distinct(_field: string, filter: Record<string, unknown>) {
      this.distinctCalls += 1;
      return queryOf([
        ...new Set(
          ratings
            .filter((r) => String(r.userId) === String(filter.userId))
            .map((r) => r.themeId),
        ),
      ]);
    },
    find: () => chain([]),
  };
  const favoritesModel = {
    docs: favorites,
    /** Spy knob: total distinct() calls issued against this model. */
    distinctCalls: 0,
    distinct(_field: string, filter: Record<string, unknown>) {
      this.distinctCalls += 1;
      return queryOf([
        ...new Set(
          favorites
            .filter((f) => String(f.userId) === String(filter.userId))
            .map((f) => f.themeId),
        ),
      ]);
    },
    find: () => chain([]),
  };

  const historyModel = {
    docs: history,
    /** Spy knob: total distinct() calls issued against this model. */
    distinctCalls: 0,
    distinct(_field: string, filter: Record<string, unknown>) {
      this.distinctCalls += 1;
      return queryOf([
        ...new Set(
          history
            .filter((h) => String(h.userId) === String(filter.userId))
            .map((h) => h.themeId),
        ),
      ]);
    },
    find: (filter: Record<string, unknown>) =>
      chain(history.filter((h) => String(h.userId) === String(filter.userId))),
  };
  const emptyDistinct = {
    distinctCalls: 0,
    distinct() {
      this.distinctCalls += 1;
      return queryOf([]);
    },
    find: () => chain([]),
  };

  const events: { roomId: string; event: string; payload: Record<string, unknown> }[] = [];
  const broadcaster = {
    register: () => undefined,
    emitToRoom: (roomId: string, event: string, payload: Record<string, unknown>) => {
      events.push({ roomId, event, payload });
    },
  };
  const rank = {
    scheduled: [] as string[],
    scheduleRPUpdate(id: string) {
      this.scheduled.push(id);
    },
  };

  const service = new QuizRoomsService(
    roomModel as never,
    themeModel as never,
    userModel as never,
    historyModel as never,
    ratingsModel as never,
    favoritesModel as never,
    rank as never,
    broadcaster as never,
  );

  return {
    service,
    roomModel,
    themeModel,
    userModel,
    history,
    ratings,
    favorites,
    historyModel,
    ratingsModel,
    favoritesModel,
    emptyDistinct,
    events,
    rank,
  };
}

const partyCreate = {
  roomType: 'party' as const,
  poolMode: 'random' as const,
  guessType: 'anime' as const,
  roundCount: 1,
  matchmaking: 'invite' as const,
};

async function startedParty(
  models: ReturnType<typeof makeFakeModels>,
  playerIds: string[] = [HOST, GUEST],
) {
  const create = await models.service.createRoom(HOST, partyCreate);
  const roomId = create.roomId!;
  for (const id of playerIds.slice(1)) {
    await models.service.joinByCode(id, create.roomCode!);
  }
  for (const id of playerIds) {
    await models.service.toggleReady(id, roomId);
  }
  await models.service.startGame(HOST, roomId);
  return { roomId, roomCode: create.roomCode! };
}

function roomDoc(models: ReturnType<typeof makeFakeModels>, roomId: string) {
  return models.roomModel.docs.find((r) => String(r._id) === roomId)!;
}

describe('QuizRoomsService — lobby state machine', () => {
  it('creates a party room with the defaults; duels are capped at 2', async () => {
    const m = makeFakeModels();
    const ack = await m.service.createRoom(HOST, partyCreate);
    expect(ack.success).toBe(true);
    expect(ack.roomCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(ack.room?.hostId).toBe(HOST);
    expect(ack.room?.settings).toMatchObject({
      poolMode: 'random',
      guessType: 'anime',
      roundCount: 1,
      maxPlayers: 4, // owner cap (spec 2026-11-10); the web default was 6
      timeLimitSeconds: 30,
    });
    expect(ack.room?.players).toHaveLength(1);
    expect(ack.room?.players[0]).toMatchObject({ userId: HOST, username: 'host', ready: false });

    const duel = await m.service.createRoom(HOST, {
      ...partyCreate,
      roomType: 'duel',
      maxPlayers: 8,
    });
    expect(duel.room?.settings.maxPlayers).toBe(2);
  });

  it('validates create fields and the watched pool', async () => {
    const m = makeFakeModels();
    await expect(
      m.service.createRoom(HOST, { ...partyCreate, roundCount: 0 }),
    ).rejects.toThrow('Missing required fields');
    await expect(
      m.service.createRoom(HOST, { ...partyCreate, poolMode: 'watched' }),
    ).rejects.toThrow('No watched history found');

    m.history.push({ userId: HOST, themeId: 'theme-correct' });
    const ack = await m.service.createRoom(HOST, {
      ...partyCreate,
      poolMode: 'watched',
    });
    expect(ack.success).toBe(true);
    const doc = roomDoc(m, ack.roomId!);
    expect(
      (doc.settings as Record<string, unknown>).watchedPoolAnimeIds,
    ).toEqual(['777']);
  });

  it('joins by code (case-insensitive), broadcasts, and is idempotent', async () => {
    const m = makeFakeModels();
    const create = await m.service.createRoom(HOST, partyCreate);

    const join = await m.service.joinByCode(GUEST, create.roomCode!.toLowerCase());
    expect(join.success).toBe(true);
    expect(join.room?.players.map((p) => p.userId)).toEqual([HOST, GUEST]);
    const joinedEvents = m.events.filter((e) => e.event === 'room:player-joined');
    expect(joinedEvents).toHaveLength(1);
    expect(joinedEvents[0].payload).toMatchObject({ userId: GUEST, playerCount: 2 });

    const again = await m.service.joinByCode(GUEST, create.roomCode!);
    expect(again.room?.players).toHaveLength(2);
    expect(m.events.filter((e) => e.event === 'room:player-joined')).toHaveLength(1);

    await expect(m.service.joinByCode(GUEST, 'ZZZZZZ')).rejects.toThrow(
      'Room not found',
    );
  });

  it('rejects joins to full or started rooms', async () => {
    const m = makeFakeModels();
    const duel = await m.service.createRoom(HOST, {
      ...partyCreate,
      roomType: 'duel',
    });
    await m.service.joinByCode(GUEST, duel.roomCode!);
    await expect(m.service.joinByCode(GUEST2, duel.roomCode!)).rejects.toThrow(
      'Room is full',
    );

    await m.service.toggleReady(HOST, duel.roomId!);
    await m.service.toggleReady(GUEST, duel.roomId!); // duel auto-starts
    await expect(m.service.joinByCode(GUEST2, duel.roomCode!)).rejects.toThrow(
      'Room is no longer waiting for players',
    );
  });

  it('public matchmaking finds the waiting room before creating one', async () => {
    const m = makeFakeModels();
    const first = await m.service.publicMatchmaking(HOST, {
      roomType: 'party',
      poolMode: 'random',
      guessType: 'anime',
    });
    expect(first.room?.settings.roundCount).toBe(10); // web public default

    const second = await m.service.publicMatchmaking(GUEST, {
      roomType: 'party',
      poolMode: 'random',
      guessType: 'anime',
    });
    expect(second.roomId).toBe(first.roomId);
    expect(second.room?.players).toHaveLength(2);

    const other = await m.service.publicMatchmaking(GUEST2, {
      roomType: 'party',
      poolMode: 'random',
      guessType: 'song',
    });
    expect(other.roomId).not.toBe(first.roomId);

    const duel = await m.service.publicMatchmaking(HOST, {
      roomType: 'duel',
      poolMode: 'random',
      guessType: 'anime',
    });
    expect(duel.room?.hostId).toBeNull(); // public duels are hostless
  });

  it('enforces host-only settings and start rules with web messages', async () => {
    const m = makeFakeModels();
    const create = await m.service.createRoom(HOST, partyCreate);
    const roomId = create.roomId!;

    await expect(
      m.service.updateSettings(GUEST, roomId, { roundCount: 5 }),
    ).rejects.toThrow('Only the host can update settings');

    const updated = await m.service.updateSettings(HOST, roomId, {
      roundCount: 5,
      timeLimitSeconds: 15,
    });
    expect(updated.settings).toMatchObject({ roundCount: 5, timeLimitSeconds: 15 });
    expect(m.events.some((e) => e.event === 'room:settings-updated')).toBe(true);

    await expect(m.service.startGame(HOST, roomId)).rejects.toThrow(
      'At least 2 players are required to start.',
    );
    await m.service.joinByCode(GUEST, create.roomCode!);
    await expect(m.service.startGame(GUEST, roomId)).rejects.toThrow(
      'Only the host can start the room',
    );
    await expect(m.service.startGame(HOST, roomId)).rejects.toThrow(
      'All players must be ready to enable autoplay.',
    );
  });

  it('leave reassigns the host, and emptying an in-progress room ends it', async () => {
    const m = makeFakeModels();
    const create = await m.service.createRoom(HOST, {
      ...partyCreate,
      roundCount: 3,
    });
    const roomId = create.roomId!;
    await m.service.joinByCode(GUEST, create.roomCode!);
    await m.service.joinByCode(GUEST2, create.roomCode!);

    const left = await m.service.leaveRoom(HOST, roomId);
    expect(left.room?.players.map((p) => p.userId)).toEqual([GUEST, GUEST2]);
    expect([GUEST, GUEST2]).toContain(left.room?.hostId);
    const leftEvent = m.events.find((e) => e.event === 'room:player-left');
    expect(leftEvent?.payload).toMatchObject({ userId: HOST, roomStatus: 'waiting' });

    // Outsider leaving is a no-op success (the web's behaviour).
    await expect(m.service.leaveRoom(OUTSIDER, roomId)).resolves.toMatchObject({
      success: true,
    });
  });

  it('heartbeat refreshes presence; non-members get Room closed', async () => {
    const m = makeFakeModels();
    const create = await m.service.createRoom(HOST, partyCreate);
    await expect(m.service.heartbeat(HOST, create.roomId!)).resolves.toMatchObject({
      success: true,
      heartbeatAccepted: true,
    });
    await expect(m.service.heartbeat(OUTSIDER, create.roomId!)).rejects.toThrow(
      'Room closed',
    );
  });

  it('subscribe is members-only', async () => {
    const m = makeFakeModels();
    const create = await m.service.createRoom(HOST, partyCreate);
    await expect(
      m.service.getRoomStateForMember(OUTSIDER, create.roomId!),
    ).rejects.toThrow('Player not in room');
    await expect(
      m.service.getRoomStateForMember(HOST, create.roomId!),
    ).resolves.toMatchObject({ success: true });
  });

  it('fails closed without models', async () => {
    const service = new QuizRoomsService();
    await expect(service.createRoom(HOST, partyCreate)).rejects.toThrow(
      RoomActionError,
    );
    await expect(service.createRoom(HOST, partyCreate)).rejects.toThrow(
      'Quiz unavailable',
    );
  });
});

describe('QuizRoomsService — game flow + scoring', () => {
  it('starts a round: broadcast carries media + options, state hides the answer', async () => {
    const m = makeFakeModels();
    const create = await m.service.createRoom(HOST, partyCreate);
    const roomId = create.roomId!;
    await m.service.joinByCode(GUEST, create.roomCode!);
    await m.service.toggleReady(HOST, roomId);
    await m.service.toggleReady(GUEST, roomId);
    const started = await m.service.startGame(HOST, roomId);

    expect(started.room?.status).toBe('in_progress');
    expect(started.room?.currentRound).toBe(1);
    // Client-facing round: no answer material while live.
    const liveRound = started.room!.rounds[0];
    expect(liveRound.options).toHaveLength(4);
    expect(liveRound.options).toContain('Correct EN');
    expect(liveRound.correctAnswer).toBeUndefined();
    expect(liveRound.themeId).toBeUndefined();

    const event = m.events.find((e) => e.event === 'room:round-started');
    expect(event?.payload).toMatchObject({
      round: 1,
      timeLimitSeconds: 30,
      countdownSeconds: 5,
    });
    // Pre-round countdown (owner, 2026-11-10): the broadcast's
    // startedAt — the moment the answer window opens — is
    // stamped the countdown length into the future, and the
    // client-facing round state carries the same stamp.
    const startedAtMs = Date.parse(event!.payload.startedAt as string);
    expect(startedAtMs).toBeGreaterThan(Date.now() + 4000);
    expect(startedAtMs).toBeLessThan(Date.now() + 6000);
    expect(Date.parse(liveRound.startedAt)).toBe(startedAtMs);
    const theme = (event!.payload.theme ?? {}) as Record<string, unknown>;
    expect(theme.videoUrl).toBe('https://video/main.webm');
    // Owner doctrine (2026-11-10): the fixture's stored audioUrl
    // ('https://audio/main.webm') is itself a video link and its
    // video URL derives no .ogg, so NO audio candidate is resolved —
    // the list is the video file (audio-only last resort) followed
    // by the entry's video source. (This expectation previously
    // enshrined the stored link as the audio candidate.)
    expect(theme.mediaCandidates).toEqual([
      'https://video/main.webm',
      'https://src/0.webm',
    ]);
    expect(theme.mediaCandidates).not.toContain('https://audio/main.webm');
    expect(theme.options).toHaveLength(4);
    expect(JSON.stringify(event?.payload)).not.toContain('correctAnswer');

    // …but the stored document holds the full web round shape.
    const doc = roomDoc(m, roomId);
    const stored = (doc.rounds as Record<string, unknown>[])[0];
    expect(stored.correctAnswer).toBe('Correct EN');
    expect(stored.themeId).toBe('theme-correct');
    expect(doc.usedThemeIds).toEqual(['theme-correct']);
    expect(doc.timerAuthority).toBeTruthy();
  });

  it('answers during the pre-round countdown are refused, then accepted at the window', async () => {
    const m = makeFakeModels();
    const { roomId } = await startedParty(m);
    const doc = roomDoc(m, roomId);
    const round = (doc.rounds as Record<string, unknown>[])[0];

    // The window opens at startedAt, ROUND_COUNTDOWN_SECONDS
    // after the broadcast (owner design, 2026-11-10).
    expect(
      new Date(round.startedAt as Date).getTime(),
    ).toBeGreaterThan(Date.now());

    await expect(
      m.service.submitAnswer(GUEST, roomId, 1, 'Correct EN'),
    ).rejects.toThrow('Round has not started yet');
    // Refused outright: nothing recorded, nobody locked.
    expect(round.answers).toHaveLength(0);
    expect(round.endedAt).toBeFalsy();
    expect(doc.status).toBe('in_progress');

    // Once the countdown ends, the same answer scores against
    // the full window (elapsed measured from startedAt).
    round.startedAt = new Date();
    const ack = await m.service.submitAnswer(GUEST, roomId, 1, 'Correct EN');
    expect(ack).toMatchObject({ success: true, correct: true, secondsRemaining: 30 });
  });

  it('round media candidates carry the derived .ogg when the theme stores no audio', async () => {
    const m = makeFakeModels();
    // The catalogue's common case: audioUrl null, AnimeThemes video.
    const correct = m.themeModel.docs.find((t) => t._id === 'theme-correct')!;
    correct.audioUrl = null;
    correct.videoUrl = 'https://v.animethemes.moe/Correct-OP1.webm';

    const create = await m.service.createRoom(HOST, partyCreate);
    const roomId = create.roomId!;
    await m.service.joinByCode(GUEST, create.roomCode!);
    await m.service.toggleReady(HOST, roomId);
    await m.service.toggleReady(GUEST, roomId);
    await m.service.startGame(HOST, roomId);

    const event = m.events.find((e) => e.event === 'room:round-started');
    const theme = (event!.payload.theme ?? {}) as Record<string, unknown>;
    expect(theme.videoUrl).toBe('https://v.animethemes.moe/Correct-OP1.webm');
    expect(theme.mediaCandidates).toContain(
      'https://a.animethemes.moe/Correct-OP1.ogg',
    );
    expect(theme.mediaCandidates).not.toContain('https://audio/main.webm');
    // Playback order (owner doctrine, 2026-11-10): the resolved
    // .ogg leads; the video file follows as the audio-only last
    // resort, ahead of the entry's own video sources.
    expect(theme.mediaCandidates).toEqual([
      'https://a.animethemes.moe/Correct-OP1.ogg',
      'https://v.animethemes.moe/Correct-OP1.webm',
      'https://src/0.webm',
    ]);
  });

  it('party scoring: owner formula — first correct × players pending, last player auto-locked, game ends with RP scheduled', async () => {
    const m = makeFakeModels();
    const { roomId } = await startedParty(m);
    const doc = roomDoc(m, roomId);
    const round = (doc.rounds as Record<string, unknown>[])[0];
    // Pretend 10s elapsed of the 30s limit → 20s remaining.
    round.startedAt = new Date(Date.now() - 10_000);

    const ack = await m.service.submitAnswer(GUEST, roomId, 1, 'Correct EN');
    expect(ack).toMatchObject({
      success: true,
      correct: true,
      baseScore: 40, // 20s remaining × (1 player pending + 1)
      bonusScore: 0, // no separate bonus under the owner's formula
      totalScoreGained: 40,
      secondsRemaining: 20,
    });

    const answers = round.answers as Record<string, unknown>[];
    expect(answers).toHaveLength(2);
    expect(answers[1]).toMatchObject({ userId: HOST, autoLocked: true, totalScoreGained: 0 });

    const ended = m.events.find((e) => e.event === 'room:round-ended');
    expect(ended?.payload).toMatchObject({
      round: 1,
      correctAnswer: 'Correct EN',
      gameOver: true,
    });
    const players = (ended!.payload.players ?? []) as Record<string, unknown>[];
    expect(players.find((p) => p.userId === GUEST)?.totalScore).toBe(40);
    expect(players.find((p) => p.userId === HOST)?.totalScore).toBe(0);

    expect(doc.status).toBe('ended');
    expect(m.rank.scheduled).toEqual([roomId]);
  });

  it('Bug 1: a non-member answer is refused and the round is untouched', async () => {
    const m = makeFakeModels();
    const { roomId } = await startedParty(m);
    const doc = roomDoc(m, roomId);
    const round = (doc.rounds as Record<string, unknown>[])[0];

    // OUTSIDER is a real user who is NOT a player in this room —
    // exactly the matrix's lurker. Even the correct answer, even
    // mid-round, must be refused before any scoring/state change.
    await expect(
      m.service.submitAnswer(OUTSIDER, roomId, 1, 'Correct EN'),
    ).rejects.toThrow('Player not in room');

    expect(round.answers).toHaveLength(0);
    expect(round.endedAt).toBeFalsy();
    expect(doc.status).toBe('in_progress');
    const players = doc.players as Record<string, unknown>[];
    expect(players.every((p) => p.totalScore === 0)).toBe(true);
    expect(
      m.events.find((e) => e.event === 'room:round-ended'),
    ).toBeUndefined();
    expect(m.rank.scheduled).toEqual([]);

    // A member answer right after still works normally (past the
    // pre-round countdown — the window opens at startedAt).
    round.startedAt = new Date();
    const ack = await m.service.submitAnswer(HOST, roomId, 1, 'Correct EN');
    expect(ack).toMatchObject({ success: true, correct: true });
  });

  it('wrong answers score 0 (party of 3 keeps playing); the next correct earns × pending+1', async () => {
    const m = makeFakeModels();
    const { roomId } = await startedParty(m, [HOST, GUEST, GUEST2]);
    const doc = roomDoc(m, roomId);
    const round = (doc.rounds as Record<string, unknown>[])[0];
    round.startedAt = new Date(Date.now() - 25_000); // 5s remaining

    const wrong = await m.service.submitAnswer(HOST, roomId, 1, 'Distractor1 EN');
    expect(wrong).toMatchObject({ correct: false, baseScore: 0, totalScoreGained: 0 });
    // Round still live: only 1 of 3 answered.
    expect(round.endedAt == null).toBe(true);
    expect(doc.status).toBe('in_progress');

    const correct = await m.service.submitAnswer(GUEST, roomId, 1, 'Correct EN');
    expect(correct.baseScore).toBe(10); // 5s remaining × (1 pending + 1)
    expect(correct.bonusScore).toBe(0);
    // GUEST2 was the last remaining player → auto-locked, round over.
    const answers = round.answers as Record<string, unknown>[];
    expect(answers).toHaveLength(3);
    expect(answers[2]).toMatchObject({ userId: GUEST2, autoLocked: true });
    expect(doc.status).toBe('ended'); // roundCount was 1
  });

  it('duel exception: a wrong first answer does NOT lock the other duelist', async () => {
    const m = makeFakeModels();
    const create = await m.service.createRoom(HOST, {
      ...partyCreate,
      roomType: 'duel',
    });
    const roomId = create.roomId!;
    await m.service.joinByCode(GUEST, create.roomCode!);
    await m.service.toggleReady(HOST, roomId);
    const readyAck = await m.service.toggleReady(GUEST, roomId);
    expect(readyAck.gameStarted).toBe(true); // duel auto-start on ready

    const doc = roomDoc(m, roomId);
    expect(doc.status).toBe('in_progress');
    const round = (doc.rounds as Record<string, unknown>[])[0];
    round.startedAt = new Date(); // past the pre-round countdown

    const wrong = await m.service.submitAnswer(HOST, roomId, 1, 'Distractor1 EN');
    expect(wrong.correct).toBe(false);
    expect((round.answers as unknown[])).toHaveLength(1); // guest NOT locked
    expect(round.endedAt == null).toBe(true);

    const steal = await m.service.submitAnswer(GUEST, roomId, 1, 'Correct EN');
    expect(steal.correct).toBe(true);
    expect(steal.bonusScore).toBe(0); // duels have no first-correct bonus
    // The LAST answerer's multiplier is exactly ×1 (the owner's +1):
    // base = secondsRemaining × 1.
    expect(steal.baseScore).toBe(steal.secondsRemaining);
    expect(steal.totalScoreGained).toBe(steal.secondsRemaining);
    expect(doc.status).toBe('ended');
    expect(m.rank.scheduled).toEqual([roomId]);
  });

  it('rejects round mismatches and double answers', async () => {
    const m = makeFakeModels();
    const { roomId } = await startedParty(m, [HOST, GUEST, GUEST2]);

    await expect(
      m.service.submitAnswer(HOST, roomId, 99, 'Correct EN'),
    ).rejects.toThrow('round_mismatch: expected 1, got 99');

    // Past the pre-round countdown, answers are accepted.
    const doc = roomDoc(m, roomId);
    const round = (doc.rounds as Record<string, unknown>[])[0];
    round.startedAt = new Date();
    await m.service.submitAnswer(HOST, roomId, 1, 'Correct EN');
    await expect(
      m.service.submitAnswer(HOST, roomId, 1, 'Correct EN'),
    ).rejects.toThrow('Already answered');
  });

  it('a late answer after all-but-one answered is auto-locked at 0', async () => {
    const m = makeFakeModels();
    const { roomId } = await startedParty(m, [HOST, GUEST, GUEST2]);
    const doc0 = roomDoc(m, roomId);
    const round0 = (doc0.rounds as Record<string, unknown>[])[0];
    round0.startedAt = new Date(); // past the pre-round countdown
    await m.service.submitAnswer(HOST, roomId, 1, 'Distractor1 EN'); // wrong, 1/3
    // A player leaving mid-round shrinks the denominator: now 1 of
    // the remaining 2 has answered, so the next attempt hits the
    // web route's BEFORE-processing auto-lock (in the web this
    // state also arises from concurrent answers; here the
    // post-answer lock normally fires first — see the party
    // scoring test, where the last player is locked at answer
    // time without ever submitting).
    await m.service.leaveRoom(GUEST2, roomId);
    const late = await m.service.submitAnswer(GUEST, roomId, 1, 'Correct EN');
    expect(late).toMatchObject({ success: true, autoLocked: true });
    const doc = roomDoc(m, roomId);
    const round = (doc.rounds as Record<string, unknown>[])[0];
    const answers = round.answers as Record<string, unknown>[];
    expect(answers).toHaveLength(2);
    expect(answers[1]).toMatchObject({ userId: GUEST, autoLocked: true, totalScoreGained: 0 });
    expect(doc.status).toBe('ended');
  });

  it('host next advances; a duplicate next with a stale expectedRound is a no-op', async () => {
    const m = makeFakeModels();
    const create = await m.service.createRoom(HOST, {
      ...partyCreate,
      roundCount: 2,
    });
    const roomId = create.roomId!;
    await m.service.joinByCode(GUEST, create.roomCode!);
    await m.service.toggleReady(HOST, roomId);
    await m.service.toggleReady(GUEST, roomId);
    await m.service.startGame(HOST, roomId);

    await expect(m.service.nextRound(GUEST, roomId, 1)).rejects.toThrow(
      'Only the host can start the next round',
    );

    const next = await m.service.nextRound(HOST, roomId, 1);
    expect(next.room?.currentRound).toBe(2);
    const roundStarts = m.events.filter((e) => e.event === 'room:round-started');
    expect(roundStarts.map((e) => e.payload.round)).toEqual([1, 2]);

    const dup = await m.service.nextRound(HOST, roomId, 1);
    expect(dup).toMatchObject({ success: true, alreadyAdvanced: true, currentRound: 2 });
    expect(m.events.filter((e) => e.event === 'room:round-started')).toHaveLength(2);
  });

  it('server timer ends the round: unanswered players get autoLocked rows', async () => {
    const m = makeFakeModels();
    const { roomId } = await startedParty(m, [HOST, GUEST, GUEST2]);
    const docPre = roomDoc(m, roomId);
    const roundPre = (docPre.rounds as Record<string, unknown>[])[0];
    roundPre.startedAt = new Date(); // past the pre-round countdown
    await m.service.submitAnswer(HOST, roomId, 1, 'Correct EN');

    const doc = roomDoc(m, roomId);
    const round = (doc.rounds as Record<string, unknown>[])[0];
    expect((round.answers as unknown[])).toHaveLength(1); // no lock yet (1 of 3)

    await (m.service as unknown as { endRoundByTimer(id: string): Promise<void> })
      .endRoundByTimer(roomId);

    const answers = round.answers as Record<string, unknown>[];
    expect(answers).toHaveLength(3);
    expect(answers.slice(1).every((a) => a.autoLocked === true)).toBe(true);
    expect(doc.status).toBe('ended');
    expect(m.events.some((e) => e.event === 'room:round-ended')).toBe(true);
    expect(m.rank.scheduled).toEqual([roomId]);
  });

  it('sweep drops heartbeat-stale players and reports disconnects', async () => {
    const m = makeFakeModels();
    const create = await m.service.createRoom(HOST, partyCreate);
    const roomId = create.roomId!;
    await m.service.joinByCode(GUEST, create.roomCode!);

    const doc = roomDoc(m, roomId);
    const guest = (doc.players as Record<string, unknown>[])[1];
    guest.lastSeenAt = new Date(Date.now() - 60_000); // 60s stale > 45s

    await (m.service as unknown as { sweep(): Promise<void> }).sweep();

    expect((doc.players as unknown[])).toHaveLength(1);
    const left = m.events.find((e) => e.event === 'room:player-left');
    expect(left?.payload).toMatchObject({ userId: GUEST, reason: 'disconnect' });
  });
});

describe('QuizRoomsService — party cap 4 (owner spec, 2026-11-10)', () => {
  it('clamps create sizes into 2–4 and defaults unset to 4', async () => {
    const m = makeFakeModels();
    const big = await m.service.createRoom(HOST, {
      ...partyCreate,
      maxPlayers: 8,
    });
    expect(big.room?.settings.maxPlayers).toBe(4);
    const three = await m.service.createRoom(HOST, {
      ...partyCreate,
      maxPlayers: 3,
    });
    expect(three.room?.settings.maxPlayers).toBe(3);
    const pub = await m.service.publicMatchmaking(HOST, {
      roomType: 'party',
      poolMode: 'random',
      guessType: 'anime',
      maxPlayers: 8,
    });
    expect(pub.room?.settings.maxPlayers).toBe(4);
  });

  it('clamps settings updates to the cap; duels stay pinned at 2', async () => {
    const m = makeFakeModels();
    const create = await m.service.createRoom(HOST, partyCreate);
    const updated = await m.service.updateSettings(HOST, create.roomId!, {
      maxPlayers: 8,
    });
    expect(updated.settings?.maxPlayers).toBe(4);

    const duel = await m.service.createRoom(HOST, {
      ...partyCreate,
      roomType: 'duel',
    });
    const duelUpdated = await m.service.updateSettings(HOST, duel.roomId!, {
      maxPlayers: 4,
    });
    expect(duelUpdated.settings?.maxPlayers).toBe(2);
  });

  it('refuses a join into a full 4-player room', async () => {
    const m = makeFakeModels();
    m.userModel.docs.push({
      _id: '507f1f77bcf86cd7994390a5',
      username: 'guest3',
      displayName: 'Guest Three',
      avatarUrl: null,
      anilist: { completedMediaIds: [] },
    });
    const create = await m.service.createRoom(HOST, {
      ...partyCreate,
      maxPlayers: 4,
    });
    await m.service.joinByCode(GUEST, create.roomCode!);
    await m.service.joinByCode(GUEST2, create.roomCode!);
    await m.service.joinByCode(OUTSIDER, create.roomCode!);
    await expect(
      m.service.joinByCode('507f1f77bcf86cd7994390a5', create.roomCode!),
    ).rejects.toThrow('Room is full');
  });
});

describe('QuizRoomsService — AniList pool (owner spec, 2026-11-10)', () => {
  it('resolves round themes from the union of players’ AniList-listed anime', async () => {
    const m = makeFakeModels();
    // One theme belongs to an anime on the HOST's AniList lists;
    // no fixture theme does (theirs sit on anilistId 777, listed
    // by nobody).
    m.themeModel.docs.push(
      makeTheme('theme-anilist', 'Listed', { anilistId: 100 }),
    );
    const host = m.userModel.docs.find((u) => u._id === HOST)!;
    (host.anilist as { completedMediaIds: number[] }).completedMediaIds = [100];

    const create = await m.service.createRoom(HOST, {
      ...partyCreate,
      poolMode: 'anilist',
    });
    const roomId = create.roomId!;
    await m.service.joinByCode(GUEST, create.roomCode!);
    await m.service.toggleReady(HOST, roomId);
    await m.service.toggleReady(GUEST, roomId);
    await m.service.startGame(HOST, roomId);

    const doc = roomDoc(m, roomId);
    const round = (doc.rounds as Record<string, unknown>[])[0];
    expect(round.themeId).toBe('theme-anilist');
  });
});

describe('QuizRoomsService — room library cache (perf problem 6)', () => {
  /**
   * Same fixture shape as the eligibility suite: anime 100 has
   * two themes (a1, a2), 200 and 300 one each. HOST knows a1+b1,
   * GUEST knows a1+a2+c1 — shared themes = {a1} → count 1.
   */
  function seedCommon(m: ReturnType<typeof makeFakeModels>) {
    m.themeModel.docs.push(
      makeTheme('theme-a1', 'Alpha', { anilistId: 100 }),
      makeTheme('theme-a2', 'Alpha', { anilistId: 100 }),
      makeTheme('theme-b1', 'Beta', { anilistId: 200 }),
      makeTheme('theme-c1', 'Gamma', { anilistId: 300 }),
    );
    m.history.push(
      { userId: HOST, themeId: 'theme-a1' },
      { userId: HOST, themeId: 'theme-b1' },
      { userId: GUEST, themeId: 'theme-a1' },
      { userId: GUEST, themeId: 'theme-a2' },
      { userId: GUEST, themeId: 'theme-c1' },
    );
  }

  it('computes each contribution once at join; emits and round starts issue zero library reads', async () => {
    const m = makeFakeModels();
    seedCommon(m);
    const spy = withLibrarySpies(m);

    const create = await m.service.createRoom(HOST, {
      ...partyCreate,
      poolMode: 'common',
    });
    // Create's state read computed the host's contribution once
    // (one whole-roster pass).
    expect(spy.contributions()).toBe(1);
    expect(create.room?.commonPoolCount).toBe(2);

    const joined = await m.service.joinByCode(GUEST, create.roomCode!);
    // The guest's join issued exactly ONE computation pass (the
    // join-time computation); the join's own state read then
    // recomputed the new line-up in one pass — no per-emit loop.
    expect(spy.contributions()).toBe(3);
    expect(joined.room?.commonPoolCount).toBe(1);

    // Repeated state emits: pure cache hits, zero LIBRARY reads
    // (users/distinct). The candidate derivation still reads
    // the theme CATALOGUE per emit — that is not a library read
    // and is out of this problem's scope.
    const countsAfterJoins = { ...spy.counts, distinct: spy.distinct() };
    for (let i = 0; i < 3; i++) {
      const state = await m.service.getRoomStateForMember(HOST, create.roomId!);
      expect(state.room?.commonPoolCount).toBe(1);
    }
    expect(spy.counts.usersFind).toBe(countsAfterJoins.usersFind);
    expect(spy.distinct()).toBe(countsAfterJoins.distinct);

    // Round 1: the eligibility gate + the theme pick both read
    // the cache — still zero library reads.
    await m.service.toggleReady(HOST, create.roomId!);
    await m.service.toggleReady(GUEST, create.roomId!);
    await m.service.startGame(HOST, create.roomId!);
    expect(spy.counts.usersFind).toBe(countsAfterJoins.usersFind);
    expect(spy.distinct()).toBe(countsAfterJoins.distinct);
    const doc = roomDoc(m, create.roomId!);
    const round1 = (doc.rounds as Record<string, unknown>[])[0];
    expect(round1.themeId).toBe('theme-a1'); // the one shared theme
  });

  it('recomputes only on join, leave and pool-mode change', async () => {
    const m = makeFakeModels();
    seedCommon(m);
    const spy = withLibrarySpies(m);
    const create = await m.service.createRoom(HOST, {
      ...partyCreate,
      poolMode: 'common',
    });
    await m.service.joinByCode(GUEST, create.roomCode!);
    await m.service.getRoomStateForMember(HOST, create.roomId!);
    expect(spy.contributions()).toBe(3); // create pass + join pass + line-up pass

    // A leave dirties the room: the leave's own state read
    // recomputes the REMAINING roster (the host alone) in one
    // pass.
    await m.service.leaveRoom(GUEST, create.roomId!);
    const afterLeave = await m.service.getRoomStateForMember(HOST, create.roomId!);
    expect(afterLeave.room?.commonPoolCount).toBe(2); // host alone: a1 + b1
    expect(spy.contributions()).toBe(4);
    // …and then it is cached again.
    await m.service.getRoomStateForMember(HOST, create.roomId!);
    expect(spy.contributions()).toBe(4);

    // A different pool mode changes the cache key — but an
    // anilist waiting state never reads contributions (the
    // count attaches to common pools only), so nothing
    // recomputes until a round or a common read asks.
    await m.service.updateSettings(HOST, create.roomId!, {
      poolMode: 'anilist',
    });
    const anilistState = await m.service.getRoomStateForMember(HOST, create.roomId!);
    expect(anilistState.room?.commonPoolCount).toBeUndefined();
    expect(spy.contributions()).toBe(4);
    // Back to common: the settings ack reads the count — but
    // the switch back restores the exact key the room was
    // cached under (host alone, common), so the cached profiles
    // serve it with no recompute at all.
    const back = await m.service.updateSettings(HOST, create.roomId!, {
      poolMode: 'common',
    });
    expect(back.commonPoolCount).toBe(2);
    expect(spy.contributions()).toBe(4);
    await m.service.getRoomStateForMember(HOST, create.roomId!);
    expect(spy.contributions()).toBe(4);
  });

  it('a membership change after a match ends forces a fresh computation at the next match', async () => {
    const m = makeFakeModels();
    seedCommon(m);
    const spy = withLibrarySpies(m);
    // A 3-player room: the next-match flow needs a leave from
    // an in-progress/ended room, which keeps the room alive
    // (an ended 2-player room's sole remaining player leaving
    // ends the room for good — there is no rematch surface).
    const create = await m.service.createRoom(HOST, {
      ...partyCreate,
      poolMode: 'common',
      roundCount: 1,
    });
    const roomId = create.roomId!;
    // GUEST2 must share a1 BEFORE they join: contributions are
    // computed at join time (the spec'd behaviour), so a history
    // row added after the join would legitimately be invisible
    // to this room's cache — the first match's gate passes only
    // if a1 is shared by all three from the start.
    m.history.push({ userId: GUEST2, themeId: 'theme-a1' });
    await m.service.joinByCode(GUEST, create.roomCode!);
    await m.service.joinByCode(GUEST2, create.roomCode!);
    await m.service.toggleReady(HOST, roomId);
    await m.service.toggleReady(GUEST, roomId);
    await m.service.toggleReady(GUEST2, roomId);
    await m.service.startGame(HOST, roomId);
    const afterFirstStart = spy.contributions();

    // The match ends: the round clock is moved past the
    // countdown, the host answers correctly and the
    // all-but-one rule auto-locks the last player, ending the
    // single-round game. (The auto-lock only triggers once a
    // correct answer exists among the answered rows, so the
    // guest answers first.)
    const doc = roomDoc(m, roomId);
    // Same clock trick as elsewhere in this file: answers open
    // once startedAt passes; move it into the past.
    ((doc.rounds as Record<string, unknown>[])[0] as Record<string, unknown>).startedAt =
      new Date(Date.now() - 1000);
    await m.service.submitAnswer(GUEST, roomId, 1, 'Alpha EN');
    await m.service.submitAnswer(HOST, roomId, 1, 'Alpha EN');
    expect(doc.status).toBe('ended');

    // The guest then leaves (the room survives: players
    // remain) and a NEW player joins: the line-up of the next
    // match differs from the ended one, so its round 1 must
    // compute from the new line-up — the spec's next-match
    // rule. (joinByCode requires a 'waiting' room, so the
    // rematch precondition — the room driver returning the
    // room to 'waiting' between matches — is applied directly
    // to the fixture, the same direct-mutation style this file
    // uses for the round clock. The leave/join invalidation
    // under test happens entirely through the service.)
    await m.service.leaveRoom(GUEST, roomId);
    doc.status = 'waiting';
    // The room driver returning the room to 'waiting' between
    // matches also resets the ready flags (the match consumed
    // them: the startGame autoplay hold reads them) — same
    // direct-fixture-mutation style as the status above.
    for (const p of doc.players as Record<string, unknown>[]) {
      p.ready = false;
    }
    const joined = await m.service.joinByCode(OUTSIDER, create.roomCode!);
    // OUTSIDER has no library: the fresh line-up's shared count
    // is honestly 0. The join itself dirtied the cache, so the
    // waiting read already recomputed the new line-up.
    expect(joined.room?.commonPoolCount).toBe(0);
    const afterRejoin = spy.contributions();
    expect(afterRejoin).toBeGreaterThan(afterFirstStart);

    // Round 1 of the new match reads the NEW line-up's cache:
    // the eligibility gate refuses (0 shared < 1 round) instead
    // of dealing from the old line-up's stale {a1} — and the
    // gate is served from the cache the join built, with zero
    // further library reads.
    await m.service.toggleReady(HOST, roomId);
    await m.service.toggleReady(GUEST2, roomId);
    await m.service.toggleReady(OUTSIDER, roomId);
    await expect(m.service.startGame(HOST, roomId)).rejects.toThrow(
      'Not enough common themes: you share 0 themes but this game needs 1 rounds.',
    );
    expect(spy.contributions()).toBe(afterRejoin); // no extra reads
  });

  it('a failed join-time computation counts the player as empty and never fails the join', async () => {
    const m = makeFakeModels();
    seedCommon(m);
    const create = await m.service.createRoom(HOST, {
      ...partyCreate,
      poolMode: 'common',
    });
    // The guest's history read explodes from here on.
    const orig = m.historyModel.distinct.bind(m.historyModel);
    (m.historyModel as Record<string, unknown>).distinct = (
      field: string,
      filter: Record<string, unknown>,
    ) => {
      if (String(filter.userId) === GUEST) {
        return {
          exec: async () => {
            throw new Error('library read exploded');
          },
        };
      }
      return orig(field, filter);
    };
    const joined = await m.service.joinByCode(GUEST, create.roomCode!);
    expect(joined.success).toBe(true);
    // The guest counts as an empty library → the shared count
    // honestly drops to 0, exactly as for an empty player.
    expect(joined.room?.commonPoolCount).toBe(0);
  });

  it('a player with no library still zeroes the common count from the cache', async () => {
    const m = makeFakeModels();
    seedCommon(m);
    const spy = withLibrarySpies(m);
    const create = await m.service.createRoom(HOST, {
      ...partyCreate,
      poolMode: 'common',
    });
    await m.service.joinByCode(GUEST, create.roomCode!);
    const joined = await m.service.joinByCode(GUEST2, create.roomCode!);
    expect(joined.room?.commonPoolCount).toBe(0);
    const before = { ...spy.counts, distinct: spy.distinct() };
    const state = await m.service.getRoomStateForMember(HOST, create.roomId!);
    expect(state.room?.commonPoolCount).toBe(0);
    // Served from cache: zero library reads (the catalogue read
    // behind the count derivation is not a library read).
    expect(spy.counts.usersFind).toBe(before.usersFind);
    expect(spy.distinct()).toBe(before.distinct);
  });

  it('AniList-pool rounds reuse the cached per-player AniList sets', async () => {
    const m = makeFakeModels();
    m.themeModel.docs.push(
      makeTheme('theme-anilist', 'Listed', { anilistId: 100 }),
    );
    const host = m.userModel.docs.find((u) => u._id === HOST)!;
    (host.anilist as { completedMediaIds: number[] }).completedMediaIds = [100];
    const spy = withLibrarySpies(m);

    const create = await m.service.createRoom(HOST, {
      ...partyCreate,
      poolMode: 'anilist',
      roundCount: 2,
    });
    const roomId = create.roomId!;
    await m.service.joinByCode(GUEST, create.roomCode!);
    await m.service.toggleReady(HOST, roomId);
    await m.service.toggleReady(GUEST, roomId);
    await m.service.startGame(HOST, roomId);
    // Round 1's union resolution read the cached contributions:
    // exactly the join-time passes happened (the host's at the
    // first state read + the guest's join-time pass).
    expect(spy.contributions()).toBe(2);
    const afterRound1 = { ...spy.counts, distinct: spy.distinct() };

    const doc = roomDoc(m, roomId);
    const round1 = (doc.rounds as Record<string, unknown>[])[0];
    expect(round1.themeId).toBe('theme-anilist');

    // Give the HOST a second AniList-listed anime BEFORE round
    // 2. The cache serves join-time contributions, so the new
    // set is NOT picked up mid-room — round 2 must still deal
    // from {100}. (In production the exclusion of the used
    // theme empties the one-theme pool and the generic
    // fallback deals another theme; the fake catalogue's
    // matches() cannot express that same-key $in+$nin
    // exclusion — it evaluates $nin before $in — so the
    // fallback deals the catalogue's first theme here. Either
    // way the pick did NOT come from the AniList union: if the
    // cache had been bypassed and {100, 400} re-read, the
    // union filter would hold both themes and the pick would
    // be theme-anilist2, the fake $sample's first match.)
    m.themeModel.docs.push(
      makeTheme('theme-anilist2', 'Listed Two', { anilistId: 400 }),
    );
    (host.anilist as { completedMediaIds: number[] }).completedMediaIds = [
      100, 400,
    ];

    // The round ends by TIMER (the server-owned path: everyone
    // unanswered is auto-locked and the round closes), then
    // round 2 starts: still no per-round library reads (the
    // round's own theme lookups read the catalogue, not the
    // libraries).
    await (m.service as unknown as {
      endRoundByTimer: (id: string) => Promise<void>;
    }).endRoundByTimer(roomId);
    await m.service.nextRound(HOST, roomId, 1);
    expect(spy.counts.usersFind).toBe(afterRound1.usersFind);
    expect(spy.distinct()).toBe(afterRound1.distinct);
    const round2 = (doc.rounds as Record<string, unknown>[])[1];
    // Round 2 did NOT deal from the host's new uncached set:
    // the pick is the fallback's first theme, never
    // theme-anilist2 (proof above).
    expect(round2.themeId).not.toBe('theme-anilist2');
    expect(round2.themeId).toBe('theme-correct');
  });
});

describe('QuizRoomsService — common pool eligibility (owner spec, 2026-11-10)', () => {
  /**
   * Anime 100 has two themes (a1, a2), 200 and 300 one each.
   * HOST knows a1 + b1 (in-app history); GUEST knows a1 + a2 +
   * c1. Shared anime = {100}; shared themes = {a1} (the host's
   * exact set caps the intersection) → the count is 1.
   */
  function seedCommon(m: ReturnType<typeof makeFakeModels>) {
    m.themeModel.docs.push(
      makeTheme('theme-a1', 'Alpha', { anilistId: 100 }),
      makeTheme('theme-a2', 'Alpha', { anilistId: 100 }),
      makeTheme('theme-b1', 'Beta', { anilistId: 200 }),
      makeTheme('theme-c1', 'Gamma', { anilistId: 300 }),
    );
    m.history.push(
      { userId: HOST, themeId: 'theme-a1' },
      { userId: HOST, themeId: 'theme-b1' },
      { userId: GUEST, themeId: 'theme-a1' },
      { userId: GUEST, themeId: 'theme-a2' },
      { userId: GUEST, themeId: 'theme-c1' },
    );
  }

  it('serves the shared count on waiting states as the roster changes', async () => {
    const m = makeFakeModels();
    seedCommon(m);
    const create = await m.service.createRoom(HOST, {
      ...partyCreate,
      poolMode: 'common',
    });
    // Host alone shares with themselves: a1 + b1.
    expect(create.room?.commonPoolCount).toBe(2);

    const joined = await m.service.joinByCode(GUEST, create.roomCode!);
    expect(joined.room?.commonPoolCount).toBe(1);

    const state = await m.service.getRoomStateForMember(HOST, create.roomId!);
    expect(state.room?.commonPoolCount).toBe(1);
  });

  it('an AniList-synced player contributes all themes of a shared anime', async () => {
    const m = makeFakeModels();
    seedCommon(m);
    // GUEST2 has no in-app data but lists anime 100 on AniList:
    // their eligible set for it is BOTH its themes, so the
    // intersection with the host's {a1} stays {a1}.
    const guest2 = m.userModel.docs.find((u) => u._id === GUEST2)!;
    (guest2.anilist as { completedMediaIds: number[] }).completedMediaIds = [100];

    const create = await m.service.createRoom(HOST, {
      ...partyCreate,
      poolMode: 'common',
    });
    await m.service.joinByCode(GUEST2, create.roomCode!);
    const state = await m.service.getRoomStateForMember(HOST, create.roomId!);
    expect(state.room?.commonPoolCount).toBe(1);
  });

  it('a player with neither AniList nor history zeroes the count', async () => {
    const m = makeFakeModels();
    seedCommon(m);
    const create = await m.service.createRoom(HOST, {
      ...partyCreate,
      poolMode: 'common',
    });
    await m.service.joinByCode(GUEST, create.roomCode!);
    const joined = await m.service.joinByCode(GUEST2, create.roomCode!);
    expect(joined.room?.commonPoolCount).toBe(0);
  });

  it('starts when shared >= rounds and deals the shared theme', async () => {
    const m = makeFakeModels();
    seedCommon(m);
    const create = await m.service.createRoom(HOST, {
      ...partyCreate,
      poolMode: 'common',
      roundCount: 1,
    });
    const roomId = create.roomId!;
    await m.service.joinByCode(GUEST, create.roomCode!);
    await m.service.toggleReady(HOST, roomId);
    await m.service.toggleReady(GUEST, roomId);
    const started = await m.service.startGame(HOST, roomId);
    expect(started.success).toBe(true);
    const doc = roomDoc(m, roomId);
    const round = (doc.rounds as Record<string, unknown>[])[0];
    expect(round.themeId).toBe('theme-a1'); // the one shared theme
  });

  it('refuses to start when shared < rounds, with the count in the message', async () => {
    const m = makeFakeModels();
    seedCommon(m);
    const create = await m.service.createRoom(HOST, {
      ...partyCreate,
      poolMode: 'common',
      roundCount: 5,
    });
    const roomId = create.roomId!;
    await m.service.joinByCode(GUEST, create.roomCode!);
    await m.service.toggleReady(HOST, roomId);
    await m.service.toggleReady(GUEST, roomId);
    await expect(m.service.startGame(HOST, roomId)).rejects.toThrow(
      'Not enough common themes: you share 1 theme but this game needs 5 rounds.',
    );
    const doc = roomDoc(m, roomId);
    expect(doc.status).toBe('waiting'); // nothing started
    expect((doc.rounds as unknown[])).toHaveLength(0);
  });

  it('switching settings to common reports the fresh count', async () => {
    const m = makeFakeModels();
    seedCommon(m);
    const create = await m.service.createRoom(HOST, partyCreate);
    const updated = await m.service.updateSettings(HOST, create.roomId!, {
      poolMode: 'common',
    });
    expect(updated.settings?.poolMode).toBe('common');
    expect(updated.commonPoolCount).toBe(2); // host alone: a1 + b1
    const event = m.events.find((e) => e.event === 'room:settings-updated');
    expect(event?.payload.commonPoolCount).toBe(2);
  });
});

describe('QuizRoomsService — public rooms list (Slice 5)', () => {
  it('returns an empty list when no public room is waiting', async () => {
    const models = makeFakeModels();
    const ack = await models.service.listPublicRooms();
    expect(ack).toEqual({ success: true, rooms: [] });
  });

  it('lists waiting public rooms with host + capacity, excludes invite rooms, sorts full rooms last', async () => {
    const models = makeFakeModels();

    const party = await models.service.createRoom(HOST, {
      roomType: 'party',
      poolMode: 'random',
      guessType: 'song',
      roundCount: 15,
      maxPlayers: 3,
      matchmaking: 'public',
    });
    expect(party.success).toBe(true);

    // Invite-only rooms never appear in the discovery list.
    await models.service.createRoom(HOST, { ...partyCreate });

    // Hostless public duel via matchmaking (the web's public flow).
    const duel = await models.service.publicMatchmaking(GUEST, {
      roomType: 'duel',
      poolMode: 'random',
      guessType: 'artist',
    });
    expect(duel.success).toBe(true);

    const ack = await models.service.listPublicRooms();
    expect(ack.success).toBe(true);
    expect(ack.rooms).toHaveLength(2);

    const partyRow = ack.rooms!.find((r) => r.roomCode === party.roomCode);
    expect(partyRow).toMatchObject({
      roomType: 'party',
      guessType: 'song',
      roundCount: 15,
      playerCount: 1,
      maxPlayers: 3,
      isFull: false,
      hostUsername: 'host',
      hostAvatar: 'https://img/host.png',
    });

    // Hostless duel: the host display falls back to the first
    // player's row (the matchmaking creator).
    const duelRow = ack.rooms!.find((r) => r.roomCode === duel.roomCode);
    expect(duelRow).toMatchObject({
      roomType: 'duel',
      guessType: 'artist',
      playerCount: 1,
      maxPlayers: 2,
      isFull: false,
      hostUsername: 'guest',
    });

    // Fill the party room: it stays listed, flagged full, and sorts
    // after the still-joinable duel.
    await models.service.joinByCode(GUEST, party.roomCode!);
    await models.service.joinByCode(GUEST2, party.roomCode!);
    const filled = await models.service.listPublicRooms();
    expect(filled.rooms).toHaveLength(2);
    expect(filled.rooms![0].roomCode).toBe(duel.roomCode);
    expect(filled.rooms![1]).toMatchObject({
      roomCode: party.roomCode,
      playerCount: 3,
      isFull: true,
    });
  });
});

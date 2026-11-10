/**
 * The Option B MongoDB Search index definitions — ONE source for
 * both the Atlas-side creation tooling and the shipped files.
 *
 * The canonical, human-reviewed form lives next door in
 * `apps/api/search-indexes/*.json` (the rollout runbook creates the
 * indexes from those files via Atlas UI/CLI). The API binary does
 * NOT carry those JSONs — the build compiles `src/` to `dist/` and
 * nothing copies loose JSON assets into it — so the internal
 * ensure endpoint (`POST /internal/search-indexes/ensure`) creates
 * from the embedded copies below instead. They MUST stay identical
 * to the files; `search-index-definitions.spec.ts` pins them
 * together and fails the suite on any drift.
 *
 * `definition` is the `definition` member of each JSON file — the
 * shape the driver's `collection.createSearchIndex({ name,
 * definition })` expects (mongodb driver 7.x).
 */
export interface SearchIndexDefinition {
  name: string;
  collection: string;
  model: 'themes' | 'anime' | 'artists';
  definition: Record<string, unknown>;
}

/* Field pairs, in the JSON files' field order: every field is an
   nGram-tokenized autocomplete field (partial matching — the
   Option B hard requirement) plus a plain string mapping so exact
   matches can be boosted. */
const autocompleteField = (): Record<string, unknown>[] => [
  {
    foldDiacritics: false,
    maxGrams: 15,
    minGrams: 2,
    tokenization: 'nGram',
    type: 'autocomplete',
  },
  { type: 'string' },
];

const definitionFor = (fields: string[]): Record<string, unknown> => ({
  mappings: {
    dynamic: false,
    fields: Object.fromEntries(fields.map((f) => [f, autocompleteField()])),
  },
});

export const SEARCH_INDEX_DEFINITIONS: readonly SearchIndexDefinition[] = [
  {
    name: 'kaikansen_themes_search',
    collection: 'themecaches',
    model: 'themes',
    definition: definitionFor(['animeTitle', 'artistName', 'songTitle']),
  },
  {
    name: 'kaikansen_anime_search',
    collection: 'animecaches',
    model: 'anime',
    definition: definitionFor(['synonyms', 'titleEnglish', 'titleRomaji']),
  },
  {
    name: 'kaikansen_artists_search',
    collection: 'artistcaches',
    model: 'artists',
    definition: definitionFor(['aliases', 'name']),
  },
];

# MongoDB Search (Atlas Search) indexes for GET /search — runbook

Owner's Option B (spec: `~/workspace/kaikansen-mobile/fresh-start/specs/SEARCH-ATLAS-B-SPEC-2026-11-10.md`).
These JSON files are the search index definitions the API's `$search`
pipelines run against. Each file is one `createSearchIndex` spec:
`{ name, definition }`.

| File | Index name | Collection |
| --- | --- | --- |
| `kaikansen_themes_search.json` | `kaikansen_themes_search` | `themecaches` |
| `kaikansen_anime_search.json` | `kaikansen_anime_search` | `animecaches` |
| `kaikansen_artists_search.json` | `kaikansen_artists_search` | `artistcaches` |

Every text field is mapped twice, with static mappings
(`dynamic: false`):

- as `autocomplete` with **nGram** tokenization (minGrams 2,
  maxGrams 15) — this is what preserves partial matching:
  fragments like `naru`, `shippu`, `uto` match mid-word, and
  `naruto` surfaces "Naruto Shippuden";
- as `string`, so exact field matches can be boosted by Atlas
  relevance scoring.

No stored data changes: the definitions index only fields the
documents already carry. Regular MongoDB indexes are untouched —
in particular the existing `theme_full_search` TEXT index stays
until Atlas search is verified live (its future is a separate
owner call).

## Creating the indexes (rollout step — NOT done by the API)

The API **never** creates or syncs search indexes at runtime.
Until an index exists and is Active, `$search` against it fails
and GET /search transparently serves the web-parity regex path
(`searchType: 'regex'`), so the code is safe to deploy first.

Creation needs a login with **Project Data Access Admin** on the
Atlas project (Cluster0, database `kaikansen`):

1. Atlas UI: Database → Cluster0 → Search → Create Search Index →
   JSON Editor → pick the collection → paste the file's
   `definition` object → name the index exactly as in the file.
   Repeat for all three files. — or —
   Atlas CLI / driver: `createSearchIndex` on each collection with
   the file's `{ name, definition }` verbatim.
2. Wait until every index shows **Active** (initial sync scans the
   collection; the catalogue is ~14k themes, minutes not hours).
3. Verify live: `GET /search?q=naruto` answers
   `searchType: 'atlas'`, and the fragments `naru`, `shippu`,
   `uto` each return Naruto Shippuden themes. `group=all` preview
   totals and a `group=themes&limit=15` second page should agree
   (no overlap, `hasMore` flips false on the last page).

If an index is deleted or still building, search degrades to the
regex path on its own — no redeploy, no data risk.

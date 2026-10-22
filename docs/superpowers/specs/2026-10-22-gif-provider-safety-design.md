# GIF provider safety design

## Goal

Reduce explicit and NSFW GIFs reaching `/dev/null` through the GIF picker without adding
server-side moderation. Filtering is provider-side and client-side, so it is best-effort: a
crafted request can still attach any provider-hosted GIF URL.

## Behavior

- GIPHY keeps the existing `rating=g` request parameter. Each returned result must also carry a
  per-result `rating` of exactly `g`. Missing or other ratings (`pg`, `pg-13`, `r`, `y`) are
  dropped.
- KLIPY keeps the existing `contentfilter=high` request parameter. KLIPY exposes no per-result
  rating, so its results pass the rating check and rely on the provider filter.
- Both providers drop results whose title, description, or username matches a curated NSFW
  keyword list. Matching is case-insensitive and word-boundary based.
- Filtering runs during provider result normalization, before results reach the picker.
- Pagination still uses the raw provider page size, so filtering never changes the next cursor.
- If a page filters down to zero results but another page exists, the picker shows its empty
  message with a `Load more` button instead of a dead end.

## Keyword list

A small curated list lives in one module: explicit sexual terms (`porn`, `pornography`, `nsfw`,
`xxx`, `hentai`, `nudity`, `nude`, `naked`, `erotic`, `sex`), extreme gore (`gore`, `gory`), and
hard drugs (`cocaine`, `heroin`, `methamphetamine`). The list is a safety net, not a content
classifier.

## Architecture

- New `resources/js/lib/gif-providers/safety.ts`:
  - `isSafeGiphyRating(rating: string | undefined): boolean` accepts only `g`.
  - `isBlockedGifText(...texts: Array<string | null | undefined>): boolean` normalizes case and
    matches whole words against the blocklist.
- `resources/js/lib/gif-providers/giphy.ts`:
  - Add `rating?: string` to the response item type.
  - `normalize()` returns `null` for unsafe or missing ratings and for blocked text.
- `resources/js/lib/gif-providers/klipy.ts`:
  - `normalize()` returns `null` for blocked title or content description.
- `resources/js/components/gif-picker-dialog.tsx`:
  - Keep `Load more` reachable when a page filters to zero results and `nextCursor` is not null.
- No server, database, or API changes.

## Testing

- Extend `tests/Unit/GifProviders.test.ts`:
  - GIPHY keeps a `g`-rated result and drops `pg`, `r`, and missing ratings.
  - Blocked terms drop GIPHY and KLIPY results case-insensitively.
  - Cursors still derive from raw page sizes after filtering.
  - Update existing fixtures to include `rating: 'g'`.
- Extend `tests/Unit/GifPickerDialog*`:
  - A zero-result page with another cursor still offers `Load more`.
- Run `bun run test:unit`, `bun run test:types`, and `bun run test:lint`.

## Documentation

Add one sentence to the README GIF section: results are filtered by GIPHY's per-result rating
and a keyword list, KLIPY relies on `contentfilter=high`, and filtering remains best-effort.

## Limitations

- KLIPY has no per-result rating, so its protection depends entirely on `contentfilter=high`.
- A crafted API request can attach any provider-hosted `.gif` URL and bypass the picker.
- Provider ratings and keyword matching cannot guarantee that no NSFW content ever appears.

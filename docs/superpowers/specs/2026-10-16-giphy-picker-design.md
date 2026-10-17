# Giphy GIF picker — design

**Date:** 2026-10-16
**Status:** Approved design, pending implementation plan

## Summary

Let a commit carry one Giphy GIF. The composer (commit, reply, and quote) gains a GIF picker
that searches Giphy directly from the browser; the chosen GIF is stored as URL references on
the commit and rendered by hotlinking Giphy's CDN. The server never calls Giphy.

A commit body is always required (3–280 chars); the GIF is an attachment next to text, never
instead of it. A commit carries **at most one GIF, with no uploaded images alongside it**
(one solo GIF). GIF + link card is allowed, as it is for images today.

## Approach (decided)

**Direct client-side integration.** Giphy's API terms prohibit caching or storing copies of
their media and prohibit proxying API calls or media loads — media must be loaded directly
from the URLs their API returns, on the client, with "Powered By GIPHY" attribution. So:

- The browser calls `api.giphy.com` for search/trending with the API key (shared via Inertia).
- Commits store the GIF's media URL (verbatim), page URL, title, and creator username.
- Rendering hotlinks `media.giphy.com` directly, like GitHub avatars already are.
- No server-side Giphy request, storage, or proxy, anywhere.

Rejected alternatives: a server-side search proxy (violates "do not proxy API calls", hides
the key for no functional gain) and downloading/storing GIFs like uploads (explicitly
prohibited by the ToS, and GD cannot re-encode animations).

Accepted costs: the API key is visible in the browser (how Giphy keys are designed to work),
viewers' IPs reach Giphy, and a GIF breaks if Giphy removes it.

## Data model

Migration `add_giphy_to_commits_table` — nullable columns on `commits` (not a shared table:
the metadata never refetches server-side, max one per commit, and it is tiny):

| Column | Type | Purpose |
|---|---|---|
| `giphy_id` | string(64) | GIF id, `[A-Za-z0-9]+` |
| `giphy_url` | text | media URL **exactly as returned by the API** — query string included, never rewritten (ToS) |
| `giphy_page_url` | text | giphy.com page URL, for the attribution link |
| `giphy_title` | string(300) | creator title → alt text |
| `giphy_username` | string(100) | creator username, for attribution where available |
| `giphy_width` | unsignedSmallInteger | rendition width, for layout stability and OG tags |
| `giphy_height` | unsignedSmallInteger | rendition height, for layout stability and OG tags |

**Rendition:** the stored `giphy_url` is always a **`.gif` rendition** (prefer
`downsized_medium`, fall back to `downsized`, then `original`), so the `image/gif` MIME type
declared in Atom enclosures and OG tags is honest. Picker thumbnails use a small fixed-height
rendition and are never stored.

**Serialization:** `Commit::toArray()` strips the raw `giphy_*` keys and appends a derived
`gif` object — `{id, url, page_url, title, username, width, height} | null`. The existing tombstone branch
already whitelists only `id/parent_id/deleted_at/replies_count`, so deleted commits drop the
GIF for free. Pending/rejected commits only ship to their author and admins (existing
`isVisibleTo` gating), which covers GIF visibility — the URL is public on Giphy regardless.

**Deletion:** nothing to clean up — Giphy hosts the bytes. Soft-delete, restore window, and
tombstone semantics are unchanged.

## Validation

In `CreateCommitRequest` and `CreateCommitReplyRequest` (these cover commits, quotes, and
replies; the CLI commit path does not accept attachments and is untouched):

- `giphy_url`: `https` scheme, host matching `media\d*.giphy.com`, path under `/media/`
  ending in `.gif`, **query string allowed and preserved verbatim**, no fragment. (The path
  is not required to contain `giphy_id`: modern Giphy media URLs use opaque `v1.…` path
  tokens instead of the plain id. The host allowlist is the security boundary.)
- `giphy_id`: `[A-Za-z0-9]+`, max 64.
- `giphy_width`/`giphy_height`: positive integers, required with `giphy_id`.
- `giphy_page_url`: `https`, host `giphy.com` or `www.giphy.com`.
- `giphy_title` max 300, `giphy_username` max 100, both nullable.
- The `giphy_*` fields arrive as a set — partial submissions are rejected.
- Exclusivity, mirroring the existing images/poll rules: GIF ⟂ uploaded images, GIF ⟂ poll,
  GIF ⟂ scheduling. GIF + link card is allowed.
- Server validation accepts well-formed GIF fields even when `GIPHY_KEY` is unset — the key
  is a client-side search credential, not a server dependency.

`CreateCommit` takes the validated fields via a small readonly DTO in `App\Dto` (like the
existing `Embed`). `CreateCommitImages` is untouched.

## Composer UX and frontend structure

All in `resources/js`, following the existing `commit-image-picker.tsx` patterns (ghost
toolbar buttons, `data-test` attributes, Radix/shadcn `ui/*` primitives):

- **`lib/giphy.ts`** — pure, node-testable: the `GiphyAttachment` type
  (`{id, url, page_url, title, username, width, height}`), direct fetches to `api.giphy.com`
  (`/v1/gifs/search`, `/v1/gifs/trending`, always `rating=g`), and
  `attachmentFromResult(item)` which picks the `.gif` rendition verbatim.
- **`components/giphy-picker-dialog.tsx`** — Radix Dialog: debounced (~300 ms) search field,
  trending on empty query, thumbnail grid, "Load more" (offset pagination, no infinite
  scroll), loading/empty/error states, click to select. Carries the required
  **"Powered By GIPHY"** mark (official logo asset bundled under `public/`).
- **`components/giphy-picker-button.tsx`** — ghost toolbar button next to the image picker,
  hidden entirely when no key is configured.
- **`components/giphy-attachment-preview.tsx`** — selected-GIF thumbnail with a remove
  button in the composer, mirroring `ImagePickerPreviews`.
- **Stash:** `use-stash` entries gain a persisted `gif` field. localStorage is enough —
  there is no `File`, so drafts survive reloads like bodies do.
- **Mutual exclusion in the composer:** picking a GIF clears uploads (and poll); attaching
  images or starting a poll clears the GIF. No confirmation dialog — the preview
  disappearing is feedback enough.
- **Wiring:** `commit-composer.tsx`, `commit-thread.tsx` (`ReplyComposer`), and
  `commit-quote-button.tsx` (`QuoteComposer`) all get the button; submissions send hidden
  `giphy_*` fields exactly like `images`/`image_descriptions` today.
- **Key delivery:** `HandleInertiaRequests` shares `giphy` from `config/services.php`
  (`GIPHY_KEY` env), typed in `types/global.d.ts`. No key ⇒ the feature is invisible.
- **Composer preview:** `CommitPreviewController` only highlights the body server-side, and
  draft attachments already render client-side — the draft GIF renders through the same
  commit component with no endpoint change.

Out of scope by design: photo-viewer/lightbox integration, GIF downloads (ToS), any server
proxy, and GIFs in quoted-commit embeds (`quoted-commit.tsx` renders body + tombstones only,
never attachments — GIFs keep that parity).

## Rendering

A new `components/commit-giphy.tsx`, used by `commit-card.tsx` in the same single-image frame
as `CommitImages`:

- `<img src={gif.url} loading="lazy" referrerPolicy="no-referrer" alt={gif.title || fallback}>`
  — URL verbatim, direct from Giphy, with the same one-shot `/favicon.svg` broken-image
  fallback as uploaded images. `no-referrer` trims viewer data sent to Giphy without touching
  the URL (their analytics ride the query params).
- Attribution overlay linking to `gif.page_url`: `GIF by @{username}` when known, else
  "via GIPHY" — satisfying Giphy's content-attribution clause. The "Powered By GIPHY" mark
  lives in the picker, where the API is utilized.

## Server-side touchpoints (no Giphy calls, ever)

- **Public API:** `CommitResource` gains `gif` (`{id, url, page_url, title, username, width, height} | null`),
  mirroring how `images` are surfaced. Consumers load media directly from Giphy.
- **OG metadata:** `PageMetadata::commitImages()` emits `giphy_url` as the OG image for GIF
  commits. Crawlers fetch Giphy directly — the permitted client-side pattern.
- **Atom feeds:** `CreateUserFeed` adds the GIF as an `image/gif` enclosure.
- **Moderation:** `UpdateCommitAiDecision` appends `giphy_url` to the image array it passes
  to `OpenAI::moderate()`/`showsMinors()` — both already wrap entries as `image_url`, and
  OpenAI accepts remote HTTPS URLs there, fetching Giphy itself (a third-party fetch, not us
  proxying). Rename the `$imageDataUrls` parameters to `$imageUrls`, and extend the
  `showsMinors` gate from "has images" to "has images or a GIF". If OpenAI's fetch fails,
  moderation degrades exactly as it does today.
- Photo viewer, downloads, and `commit-image.show` are untouched — a GIF is not a stored
  `CommitImage`.

## Edge cases and error handling

- **Giphy removes a GIF:** the `<img>` breaks → favicon fallback. The post and its text
  survive; nothing to clean server-side.
- **Malicious client submits a non-`g`-rated or junk URL:** format validation guarantees a
  real `media*.giphy.com` reference; content safety is covered by moderation fetching the
  URL. A non-existent GIF renders broken; moderation's fetch degrades gracefully.
- **Picker errors:** search failure → inline retry message in the dialog (not a toast);
  Giphy 429 → "GIPHY is rate limiting searches, try again shortly."; no results → dry
  empty-state copy in the app's voice.
- **Stashed drafts** whose GIF is later removed from Giphy show a broken preview; remove and
  re-pick. No special handling.
- **Beta keys** are throttled hard (~42 searches/hour) and prohibited in production — the
  README notes that a production key (with Giphy's "Powered By GIPHY" screenshot approval)
  is needed for real deployments.

## Testing

Keeping the repo's 100% coverage and type-coverage bars; no real Giphy calls anywhere in CI
(`Http::preventStrayRequests()` already enforces this server-side; frontend fetches mocked):

- **Pest, Feature:** valid GIF accepted on commit/reply/quote; URL scheme/host/path
  rejections; query strings accepted and stored verbatim; partial `giphy_*` set rejected;
  GIF ⟂ images, GIF ⟂ poll, GIF ⟂ scheduling; GIF + link card accepted; payload exposes the
  `gif` object and never the raw columns; tombstones drop it. API v1 `gif` field,
  `PageMetadata` OG image, Atom enclosure.
- **Pest, Unit:** `CreateCommit` persists the DTO; `UpdateCommitAiDecision` includes the
  Giphy URL in `moderate`/`showsMinors` payloads (`Http::fake` on OpenAI, as existing tests
  do).
- **Frontend:** `tests/Unit/Giphy.test.ts` (node:test) for `lib/giphy.ts` — request URL
  construction, `rating=g` always present, rendition picking, result normalization. A Vite+
  `.test.tsx` for composer exclusivity and stash round-trip, following
  `ComposerDraft.test.tsx` patterns.

## Documentation

- `.env.example` gains `GIPHY_KEY` with a comment.
- README gets a short "GIFs" section next to Embeds (key setup, production-key caveat).
- `PRODUCT.md` is updated so its "deliberately excluded" list (which still names
  images/media and is already stale) does not contradict the GIF capability.

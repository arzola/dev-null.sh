# Multi-provider GIF picker — design

**Date:** 2026-10-19
**Status:** Approved design, pending implementation plan
**Branch:** `feature/giphy-picker` (the GIF feature is not shipped, so no backward compatibility is required)

## Summary

Generalize the GIPHY-only GIF picker into a provider-agnostic feature. Users connect **one
active GIF provider** (GIPHY or KLIPY) with their own API key; the picker searches that
provider from the browser. Adding another provider later is one client adapter plus one
enum case.

The provider-specific knowledge lives behind two seams: a client-side `GifProvider`
interface and a server-side `GifProvider` enum (host allowlists, labels). The shared
picker, composer wiring, storage, rendering, feeds, OG metadata, and moderation never
branch on provider.

## Approach (decided)

**Provider registry (client) + provider enum (server).** One small module per provider in
`resources/js/lib/gif-providers/`; the picker receives the resolved provider object and
depends only on its interface. The server owns provider ids, URL allowlists, and enum
validation. Rejected alternatives: server-sent provider config with a generic fetcher
(hides API-shape knowledge in a config DSL, still needs per-provider normalization) and
per-provider picker components (duplicates state, errors, attribution, and the UX).

**One active provider.** Connecting a provider replaces the previous connection. This
matches provider terms: KLIPY's integration requirements forbid blending its results with
another provider's in the same result set, and users may have provider-specific
preferences. There is no simultaneous multi-key or in-picker provider switcher.

**No backward compatibility.** The feature is unreleased: the existing two migrations are
rewritten in place (`giphy_*` → `gif_*`, provider columns added), and the public API emits
the final shape (`gif.provider`) from day one. No backfills, no legacy aliases.

## Provider contracts

### Shared interface (`resources/js/lib/gif-providers/types.ts`)

```ts
export type GifProviderId = 'giphy' | 'klipy';

export type GifSearchPage = {
    results: GifResult[];
    nextCursor: string | null; // opaque; null ends pagination
};

export type GifKeyValidation =
    | 'valid'
    | 'invalid'
    | 'rate-limited'
    | 'unreachable';

export interface GifProvider {
    readonly id: GifProviderId;
    readonly label: string; // GIPHY | KLIPY
    readonly searchPlaceholder: string;
    readonly attribution: { readonly label: string; readonly href: string };
    search(
        key: string,
        query: string,
        options: { cursor: string | null; signal?: AbortSignal },
    ): Promise<GifSearchPage>;
    trending(
        key: string,
        options: { cursor: string | null; signal?: AbortSignal },
    ): Promise<GifSearchPage>;
    validateKey(key: string): Promise<GifKeyValidation>;
}
```

`GifResult` normalizes a provider item to `{id, url, pageUrl, title, username|null,
width, height}`. The adapter picks renditions; consumers only see the normalized values.
`index.ts` exports `providers: Record<GifProviderId, GifProvider>` and
`providerFor(id: GifProviderId)`.

### GIPHY adapter (moved from today's `lib/giphy.ts`)

- Search `/v1/gifs/search`, trending `/v1/gifs/trending` on `api.giphy.com`, with
  `api_key`, `limit=24`, `offset={cursor}`, `rating=g`.
- Stored rendition: `downsized_medium → downsized → original`; preview:
  `fixed_height_small → downsized → downsized_medium → original`.
- Page URL: the item's `url`; username may be present; title may be empty → null.
- Key validation: trending with `limit=1`; 200 valid, 401/403 invalid, 429
  rate-limited, network/other unreachable.
- `searchPlaceholder: 'Search GIPHY'`; `attribution: { label: 'Powered By GIPHY', href: 'https://giphy.com' }`.

### KLIPY adapter

- Tenor-compatible API on `https://api.klipy.com`:
  - search: `GET /v2/search?key={key}&q={query}&limit=24&pos={cursor}&contentfilter=high`
  - trending: `GET /v2/featured?key={key}&limit=24&pos={cursor}&contentfilter=high`
- Response: `{ results: [...], next: string }`; `next` empty ends pagination. Each result
  has `id`, `title`, `content_description`, `itemurl`, and
  `media_formats: { gif: { url, dims: [w, h] }, tinygif?: { url } }`.
- Stored rendition: `media_formats.gif` (URL kept verbatim); preview:
  `media_formats.tinygif ?? gif`; page URL: `itemurl`; username: null; title falls back to
  `content_description`.
- Key validation: featured with `limit=8`; same status mapping as above.
- `searchPlaceholder: 'Search KLIPY'` (**required** by KLIPY's attribution guidelines);
  `attribution: { label: 'Powered by KLIPY', href: 'https://klipy.com' }`.
- Media hosts for validation: `static.klipy.com`, `static1.klipy.com`, `static2.klipy.com`.
  Page host: `klipy.com` (and `www.klipy.com`).

### Tests prove the seam

The adapter contract test suite is parameterized over the registry and runs with a fixture
per provider (URL building, cursor mapping, normalization, empty pages, error mapping).
The picker component takes the provider object as a prop, so component tests inject a fake
provider and prove the shared UI has no provider-specific branches.

## Data model

Migrations are rewritten in place (no compatibility shims):

| Migration | Change |
|---|---|
| `add_gif_to_commits_table` | nullable `gif_provider` (string 16) + the seven attachment columns renamed `giphy_*` → `gif_*` (`gif_id`, `gif_url`, `gif_page_url`, `gif_title`, `gif_username`, `gif_width`, `gif_height`) |
| `add_gif_key_to_users_table` | nullable `gif_provider` (string 16) + `gif_key` (text, encrypted cast) |

- `App\Enums\GifProvider: string` — cases `Giphy = 'giphy'`, `Klipy = 'klipy'`; methods
  `label()`, `mediaHostPatterns(): list<string>`, `pageHostPatterns(): list<string>`.
  Hosts: GIPHY `media*.giphy.com` and `giphy.com`/`www.giphy.com`; KLIPY
  `static{1,2}.klipy.com` and `klipy.com`/`www.klipy.com`. The client-side search
  placeholder is adapter-owned, not part of the enum.
  `Commit::casts()` maps `gif_provider` to the enum.
- `Commit` keeps `#[Hidden]` over the raw `gif_*` columns and derives one `gif` object:
  `{provider, id, url, page_url, title, username, width, height}` (null when no GIF).
- `User` gains `gif_provider` (enum cast, hidden) and `gif_key` (encrypted, hidden);
  both null when no provider is connected.
- `CommitBuilder::COLUMNS_BUT_EMBEDDING` carries the renamed `gif_*` columns and
  `gif_provider`; both factories expose `CommitFactory::withGif(GifProvider $provider =
  GifProvider::Giphy)` and `UserFactory::withGifKey(GifProvider $provider =
  GifProvider::Giphy, string $key = 'gif-test-key')`.

## Server validation

- `App\Rules\GifMediaUrl` takes the `GifProvider`; accepts only https URLs whose host
  matches the provider's media hosts, path under `/` ending in `.gif`, query strings
  verbatim, no fragment/port/userinfo, and no dot-segments.
- `App\Rules\GifPageUrl` takes the `GifProvider`; https and a provider page host.
- `CreateCommitRequest` and `CreateCommitReplyRequest` accept the `gif_*` set including
  `gif_provider` (`Rule::enum(GifProvider::class)`, required with the rest of the set);
  media and page rules are constructed with that provider, so a GIPHY URL with
  `gif_provider=klipy` is rejected. Exclusivity rules are unchanged (GIF ⟂ images,
  GIF ⟂ poll, GIF ⟂ scheduling).
- `App\Dto\Gif` replaces `App\Dto\Giphy` and carries the provider to the columns.
- BYOK: `PUT settings/gif` takes `{provider, key}` (enum + trimmed non-empty string,
  max 255) and stores both atomically; `DELETE settings/gif` clears both. The server never
  calls a provider; the browser validates before saving.
- `HandleInertiaRequests` shares `gif: { provider, key } | null` from the signed-in user
  (guests and unconnected users get null). The owner-only prop is the only channel that
  ships the key; `gif_key` is hidden from model serialization and from the account export.

## Settings UI

- The Profile settings section is titled **"GIFs"**: a segmented control
  **[GIPHY | KLIPY]** above one key field. Selecting a provider shows that provider's key
  field and help link (`developers.giphy.com` / KLIPY partner panel).
- Connect validates the key in the browser through the provider adapter, then
  `PUT settings/gif` stores `provider + key` atomically, replacing any previous
  connection. Invalid/unreachable keys never save; a rate-limited key is accepted as real.
- Connected state: "Connected to GIPHY" (or KLIPY) with **Update**, **Change provider**
  (reveals the selector + field), and **Remove**. The key is write-only.
- `GifKeyController` replaces `GiphyKeyController`; routes `settings/gif`
  (`gif-key.update`, `gif-key.destroy`).

## Picker, composer, and rendering

- `GifPickerButton` stays hidden unless `gif` prop is non-null; it passes the resolved
  provider to `GifPickerDialog`.
- Dialog: provider placeholder from the adapter (KLIPY's required "Search KLIPY"),
  debounced query, trending on empty query, cursor pagination, provider attribution mark
  in the footer, provider-named rate-limit copy ("You've hit your KLIPY key's search rate
  limit."), loading/empty/error states unchanged.
- Picking a GIF stores `{provider, ...}` in the draft/stash and submits hidden `gif_*`
  fields including `gif_provider`; previews and exclusivity behavior are unchanged.
- `CommitGif` renders the stored provider's attribution: GIPHY → "GIF by @user on GIPHY"
  (or "via GIPHY"), KLIPY → "via KLIPY"; both link the stored page URL. Attribution is
  historical — switching providers never changes old commits.
- Read surfaces stay URL-based and provider-agnostic: `CommitResource.gif` includes
  `provider`, `PageMetadata` uses the stored URL for OG images, Atom encloses it as
  `image/gif`, and AI moderation appends the URL to the image list.

## File map (renames)

- `app/Dto/Giphy.php` → `app/Dto/Gif.php`
- `app/Rules/GiphyMediaUrl.php` → `app/Rules/GifMediaUrl.php`; new `GifPageUrl` rule
- `app/Http/Controllers/GiphyKeyController.php` → `GifKeyController.php`
- `app/Http/Requests/UpdateGiphyKeyRequest.php` → `UpdateGifKeyRequest.php`
- `resources/js/lib/giphy.ts` → `resources/js/lib/gif-providers/{types,giphy,klipy,index}.ts`
- `resources/js/components/giphy-picker-{button,dialog}.tsx` → `gif-picker-{button,dialog}.tsx`
- `resources/js/components/giphy-attachment-preview.tsx` → `gif-attachment-preview.tsx`
- `resources/js/components/giphy-key-setting.tsx` → `gif-key-setting.tsx`
- `resources/js/components/commit-giphy.tsx` → `commit-gif.tsx`
- Tests and configs renamed accordingly (`Giphy*.test.*` → `Gif*.test.*`).

## Testing

- **Client:** adapter contract suite for both providers (URLs, cursors, normalization,
  empty/429/401/network mapping); picker component tests with an injected fake provider
  (placeholder, attribution, rate-limit copy, pagination); settings tests (provider
  selector, connect/replace semantics, invalid key never saves); render tests for per-
  provider attribution; stash round-trip retains the provider.
- **Server:** enum host patterns; `GifMediaUrl`/`GifPageUrl` per provider including
  cross-provider rejection; request validation for the `gif_*` set; `Commit::gif()`
  serialization and API resource include `provider`; BYOK controller (connect, replace
  across providers, remove, validation, auth); middleware prop; export excludes the key.
- Existing suites (composer exclusivity, feeds, OG, moderation) keep passing with the
  renamed fields.

## Out of scope

- Tenor (closed to new API clients; KLIPY's Tenor-compatible surface keeps an adapter
  cheap to add later).
- Multiple simultaneous providers or in-picker provider switching.
- Provider extras (KLIPY categories/stickers/clips/ads, Tenor stickers) and per-provider
  default preferences beyond the single active connection.

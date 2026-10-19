# Client-only GIF provider keys — design

**Date:** 2026-10-19
**Status:** Approved design, pending implementation plan
**Branch:** `feature/giphy-picker` (GIF feature unreleased)
**Supersedes:** the BYOK key-storage sections of `2026-10-19-gif-providers-design.md` (server-stored `users.gif_key` + `users.gif_provider`). Everything else in that spec — provider interface, schema for commit metadata, validation, picker/rendering — stands.

## Summary

The maintainers do not want API keys or secrets stored in the database. The GIF provider key therefore lives **only in the user's browser** (`localStorage`), where it is actually used. The server keeps only public GIF attachment metadata on commits. This removes the users key/provider columns and the entire server-side BYOK plumbing.

## Approach (decided)

- **A. `localStorage`, namespaced per user id** — `gif-provider:{userId}` stores `{provider, key}`. Persists across sessions, isolated between accounts on a shared browser, lost only when site data is cleared; inherently per-device.
- **A. `useSyncExternalStore` hook** — `useGifProviderKey(userId)` with a deterministic server snapshot (`null`), a small same-tab emitter, and cross-tab `storage` events. SSR-safe and reactive.

Rejected: an origin-wide entry (accounts on one browser would share a key), `sessionStorage` (the key would die with the tab), reading localStorage at render behind a `typeof window` guard (server/client hydration mismatch), cookies (would send the secret to the server on every request).

## Storage contract

New module `resources/js/lib/gif-provider-key.ts`:

| Function | Behavior |
|---|---|
| `readGifProviderKey(userId: string): GifProviderKey \| null` | Reads `localStorage['gif-provider:' + userId]`, parses, validates; malformed payloads are treated as absent |
| `writeGifProviderKey(userId, value: GifProviderKey): void` | Serializes `{provider, key}` and notifies same-tab subscribers |
| `clearGifProviderKey(userId): void` | Removes the entry and notifies |
| `subscribeGifProviderKey(userId, listener): () => void` | Same-tab emitter + `window` `storage` events for the namespaced key |

`GifProviderKey = { provider: GifProviderId; key: string }` (type only in this module).

Validation rules on read:
- parsed value is an object with string `provider` that is an **own** key of `gifProviders` (`Object.hasOwn` — prototype keys such as `toString` never pass);
- `key` is a string with `trim()` non-empty and length ≤ 255.

Anything else returns `null` (never throws). Writes happen only from the settings section after browser-side validation.

Namespacing: the key includes `auth.user.id`, so two accounts on the same browser never see each other's key. Signing out does not clear the entry (same person, same device); a deleted account leaves a harmless orphan entry.

## Hook

New `resources/js/hooks/use-gif-provider-key.ts`:

```ts
export function useGifProviderKey(
    userId: string | null,
): GifProviderKey | null;
```

- `useSyncExternalStore` with a server snapshot of `null` (SSR renders "not connected" / no picker button — no hydration mismatch).
- The client snapshot reads the module and returns a stable reference while the raw value is unchanged (cache the raw JSON string + parsed object).
- Subscribes to the namespaced same-tab emitter and `storage` events; a key written or cleared in another tab updates the hook.
- `userId === null` (guests) always returns `null` without touching storage.

Consumers:
- `GifPickerButton` reads the hook with the signed-in user id; renders only when a valid entry exists and passes `gifProviderFor(entry.provider)` + `entry.key` to the dialog.
- `GifKeySetting` reads the hook for its connected state and writes/clears through the module. No Inertia round-trip, no server involvement.

## Server cleanup (unreleased → delete, no back-compat)

- Delete `database/migrations/2026_10_17_133426_add_gif_key_to_users_table.php` entirely (no users columns are needed).
- Remove from `app/Models/User.php`: `gif_provider`/`gif_key` docblock entries, `#[Hidden]` entries, `$attributes` defaults, and casts.
- Delete `app/Http/Controllers/GifKeyController.php`, `app/Http/Requests/UpdateGifKeyRequest.php`; remove the `settings/gif` routes and the controller import; regenerate Wayfinder (generated files stay gitignored).
- Remove the `gif` prop from `app/Http/Middleware/HandleInertiaRequests.php`.
- Remove `gifConnected`/`gifProvider` from `UserProfileController::edit`.
- Remove the `gif` entry from `resources/js/types/global.d.ts`.
- Delete `tests/Feature/Controllers/GifKeyControllerTest.php` and `tests/Feature/Middleware/GifPropTest.php`; remove the gif-connection test from `UserProfileControllerTest` and the key-in-export test from `ExportControllerTest`.
- Update the README "GIFs" paragraph: keys are stored only in the browser, never sent to the server, and each device needs its own.
- Commit metadata (`gif_provider` + `gif_*` columns, serialization, API/feed/OG/moderation) is unchanged — public data, not secrets. The server never sees a provider key anywhere.

## Settings UX

- The "GIFs" section keeps the provider selector, key field, browser-side validation (200 saves; 401/403 rejected; 429 saved as real-but-throttled; network failure rejected), write-only key, and Update/Change provider/Remove.
- Saving is instant and client-side; no toast is needed. The section states: **"Stored in this browser only — never sent to the server. Each device needs its own key."**
- Connected state ("Connected to GIPHY/KLIPY") comes from the hook; Remove clears the local entry, and the picker button disappears on the next mount. A change in another tab is reflected via the `storage` event.
- The connected state appears after hydration (the server snapshot is null); the disconnected form is the SSR state, which is deterministic.

## Security notes

- `localStorage` is readable by any script on the origin — the same exposure class as the composer drafts already stored there. No cookies, so the key is never attached to HTTP requests; no server-side secret exists to leak from the DB or exports.
- The key is read only by the picker dialog and the settings section; it is never logged and never placed in page props.
- The existing draft stash (`lib/gif-storage.ts`) is unrelated to the provider key and stays as is.

## Testing

- **New `tests/Unit/GifProviderKey.test.ts`:** round-trip per user; per-user namespacing; malformed JSON; unknown provider; prototype provider (`toString`/`__proto__`) rejected; empty/whitespace/oversized key rejected; clear; same-tab listener notification; `storage`-event subscription (simulated event) triggers the listener.
- **Component:** settings writes/clears `localStorage`, connected state from the hook, invalid/unreachable never write, 429 writes; picker button renders only with a valid stored entry and passes the right provider/key, absent without one.
- **Server:** deleted test files; `UserProfileControllerTest`/`ExportControllerTest` no longer reference the key; full Pest suite green with zero `gif_key`/`gif_provider` references on users.

## Out of scope

- Cross-device sync, passphrase-encrypting the stored value, `sessionStorage`, cookies.
- Server-side validation or storage of provider keys of any kind.

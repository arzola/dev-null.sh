# Bring-your-own GIPHY key — design

**Date:** 2026-10-17
**Status:** Approved design, pending implementation plan

## Summary

Move the GIPHY key from an instance-wide env var to a per-user credential. The GIF picker
becomes fully opt-in: it stays invisible until the signed-in user connects their own GIPHY
API key. Their searches then run on their own quota instead of a shared rate limit, which
makes the feature viable in production for an open-source project with no GIPHY bill.

Display of already-attached GIFs is untouched: media renders by hotlinking the stored GIPHY
URLs, which needs no key and no API call.

## Approach (decided)

**Server-stored, browser-used.** The key is stored encrypted on the user account
(`users.giphy_key`) and delivered back to its owner through the existing Inertia `giphy`
prop — the same delivery channel as today, just sourced from the user instead of
`config/services.php`. The browser continues to make every GIPHY call; no server-side GIPHY
request anywhere.

Rejected alternatives: client-only localStorage (no cross-device sync, silent data loss when
storage is cleared) and keeping the env key as an instance fallback (resurrects the shared
rate limit this change exists to remove). The env key is removed entirely — `GIPHY_KEY`,
the `services.giphy` config block, and the `.env.example` entry all go away.

Accepted costs: the key transits the server (stored encrypted at rest, never echoed back to
the UI) and appears in the owner's browser traffic (how GIPHY keys work — the API is called
client-side). Losing the key means pasting it again; there is nothing to recover.

## Data model

Migration `add_giphy_key_to_users_table` — one nullable `text` column on `users`.

- `User::casts()` gains `'giphy_key' => 'encrypted'` (transparent encryption at rest).
- `User`'s `#[Hidden]` list gains `'giphy_key'` so raw model serialization
  (`auth.user`, moderation pages, any other prop shipping a `User`) can never leak it.
  The middleware's dedicated `giphy` prop is the only channel that ships the key, only to
  its owner.
- `UserResource` is already an explicit whitelist and needs no change.

**Gating:** `HandleInertiaRequests` shares `giphy: {key} | null` sourced from
`$request->user()?->giphy_key` (guests and keyless users get `null`). The prop shape is
unchanged, so `giphy-picker-button.tsx`, the dialog, and `lib/giphy.ts` need no structural
changes — only the rate-limit copy below.

## Settings UI

A **"Giphy" section on the Profile settings page** (`user-profile/edit`) — the fifth
`PageTabs` slot was rejected because `PageTabs` gives every tab `flex-1` with no overflow
handling, so "Integrations" would squish on mobile. The section follows the
`PasteisModeSetting` pattern: a self-contained component, its own routes, no new settings
page.

- **Component:** `resources/js/components/giphy-key-setting.tsx`, rendered as a
  `<section className="px-4 py-6 sm:px-6">` like its neighbors.
- **Props:** `UserProfileController::edit` adds `giphyConnected: bool`. The page prop is a
  boolean only — the UI is **write-only** and never renders the stored key back.
- **Disconnected state:** short explainer (a free key from developers.giphy.com; searches
  use the user's own quota) + key input + Connect button.
- **Connected state:** "GIPHY is connected." + Update (reveals the input again) and Remove
  buttons.
- **Feedback:** `Inertia::flash('toast', ...)` toasts for connect/update/remove, matching
  `UserProfileController::update`.

## Validation and saving

Validation of the key happens **in the browser, before saving** — GIPHY stays a
client-side concern, and the server never makes a GIPHY call to verify:

| Browser test call result | Behavior |
|---|---|
| 200 | Save: `PUT settings/giphy` |
| 401/403 | Inline error "That key was rejected by GIPHY." — nothing saved |
| 429 | Key is real but throttled: save it anyway (limits reset hourly) |
| Network failure | Inline error "Couldn't reach GIPHY to verify the key." — nothing saved |

The test call reuses the existing client module: a new `validateGiphyKey(key)` in
`resources/js/lib/giphy.ts` mapping the trending call's status codes to
`valid | invalid | rate-limited | unreachable`.

Server side:

- Routes (auth group, next to the profile settings routes; no throttle, matching
  `user-lane`/`user-pasteis-mode`): `PUT settings/giphy` (`giphy-key.update`) and
  `DELETE settings/giphy` (`giphy-key.destroy`).
- `app/Http/Requests/UpdateGiphyKeyRequest.php`: `key` required, string, trimmed,
  non-empty, max 255 (validation lives only in Form Requests per `ArchTest`).
- `app/Http/Controllers/GiphyKeyController.php` (`final readonly`): update stores the
  trimmed key; destroy nulls it. Both `return back()` with a toast flash.
- The server is a dumb encrypted box: a malicious client bypassing validation can only
  store garbage for its own account.

## Client behavior changes

- **Picker gating:** unchanged mechanics — button hidden when `giphy` is `null`; now that
  happens per-user (no key connected ⇒ invisible, fully opt-in as decided).
- **Rate-limit copy:** the dialog's 429 message becomes
  "You've hit your GIPHY key's search rate limit. Try again shortly." (was the anonymous
  "GIPHY is rate limiting searches."). Other states ("GIPHY did not answer.", retry,
  empty results) are unchanged.
- **Display path:** zero changes — attached GIFs render from stored URLs with no key.

## Edge cases

- **Key removed while a picker dialog is open:** the current page's prop still has the key
  until the next Inertia visit; harmless (it is the user's own key).
- **Key invalidated on GIPHY's side later:** searches fail; the dialog shows its error
  state and the settings section lets the user replace the key.
- **Key updated:** the picker uses the new key on the next page load; existing commits are
  unaffected.
- **Existing attached GIFs:** unaffected by connection state — display never needed a key.
- **Guests:** `giphy` prop is `null`; composers are auth-only, so no guest-facing path
  exists.

## Security

- Encrypted cast at rest; `#[Hidden]` on the model; write-only UI; key never logged.
- Per-user delivery only: the middleware resolves it from the request's own user.
- The public API (`UserResource`, `CommitResource`) has no path to it.

## Testing

Keeping the repo's 100% coverage bars; frontend fetches stubbed, no real GIPHY calls.

- **Pest, Feature — `GiphyKeyControllerTest`:** stores the trimmed key; encryption at rest
  (raw DB value ≠ plaintext, cast decrypts); update replaces; destroy nulls; validation
  failures (missing/empty whitespace/non-string/too long) leave the stored key untouched.
- **Pest, Feature — profile page:** `giphyConnected` true/false; the page never ships the
  key itself; `auth.user` serialization excludes `giphy_key`.
- **Pest, Feature — `HandleInertiaRequestsGiphyTest` (rewrite):** `giphy.key` shared from
  the authenticated user's key; `null` when unset and for guests.
- **Pest, Unit:** none expected beyond coverage obligations from the new branches.
- **Frontend — `tests/Unit/Giphy.test.ts`:** `validateGiphyKey` mapping for
  200/401/429/network.
- **Frontend — Vite+ (`vite-plus/test`) component tests:** `giphy-key-setting` state
  machine (connect with valid key PUTs; invalid key shows the inline error and does not
  PUT; remove DELETEs), following `ComposerDraft.test.tsx` patterns.
- **Existing tests:** the picker/gating suite stays green unchanged (prop shape is
  identical).

## Documentation

- README "GIFs" section rewritten for BYOK: connect your own free key in Settings →
  Profile (Giphy); no instance configuration; production caveat about GIPHY key approval
  now applies to each user's own key.
- `.env.example`: `GIPHY_KEY` block removed.
- `PRODUCT.md` unchanged (no capability change).

## Out of scope

- Any server-side GIPHY proxy or call.
- OAuth-style GIPHY connect flows (paste-a-key only).
- Multiple keys per user, key labels, or usage counters.
- A dedicated settings tab or page (Profile section only).

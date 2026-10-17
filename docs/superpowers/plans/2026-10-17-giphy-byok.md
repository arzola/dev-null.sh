# Bring-Your-Own GIPHY Key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the GIPHY key from the instance env var to an encrypted per-user credential, so the GIF picker is opt-in and each user's searches run on their own quota.

**Architecture:** One encrypted `users.giphy_key` column, hidden from all model serialization and delivered to its owner only through the existing Inertia `giphy` prop. A "Giphy" section on the Profile settings page connects/updates/removes the key; the browser verifies the key against GIPHY before saving. The env key (`GIPHY_KEY`, `services.giphy`) is removed entirely. Server never calls GIPHY.

**Tech Stack:** Laravel 13 (PHP 8.5, strict types), Inertia 3 + React 19 + TypeScript, Pest 5, node:test for lib tests, vite-plus for component tests.

**Spec:** `docs/superpowers/specs/2026-10-17-giphy-byok-design.md` — read it before starting.

## Global Constraints

- PHP: `declare(strict_types=1);` in every file; classes `final`; actions `final readonly` with a single `handle()`; validation/authorization only in Form Requests (enforced by `tests/Unit/ArchTest.php`).
- Tests: Pest with **exactly 100.0% line coverage** and 100% type coverage; PHPStan at max level. Every new PHP branch needs a test.
- No real HTTP in tests: `Http::preventStrayRequests()` is global; frontend tests stub `fetch`.
- GIPHY ToS: **no server-side GIPHY request anywhere** — not even to verify a key (the browser verifies); committed GIF media URLs stay verbatim; the picker keeps its "Powered By GIPHY" mark; all API calls send `rating=g`.
- Wayfinder: `resources/js/actions`, `resources/js/routes`, and `resources/js/wayfinder` are gitignored and generated. After any route/controller change run `php artisan wayfinder:generate --with-form` (matches the Vite plugin's `formVariants: true`) and **never commit the generated files**.
- The backend stores a key it never validates; a malicious client can only store garbage for its own account.
- Copy voice: dry, terminal-literate; a post is a "commit".
- House rule: `git add` new files immediately after creating them.
- Formatting: if Pint/oxfmt complain at the end, run `composer lint` and include the fixes in the final task's commit.
- JS gates: `bun run test:unit`, `bun run test:types`, `bun run test:lint`. PHP gate: `composer test`.

---

### Task 1: `users.giphy_key` — encrypted column, hidden from serialization

**Files:**
- Create: `database/migrations/<timestamp>_add_giphy_key_to_users_table.php` (via artisan)
- Modify: `app/Models/User.php` (docblock, `#[Hidden]`, `casts()`)
- Modify: `database/factories/UserFactory.php`
- Test: `tests/Unit/Models/UserTest.php`

**Interfaces:**
- Consumes: nothing new.
- Produces: `User::$giphy_key` (`string|null`, encrypted at rest, hidden from `toArray()`/JSON); `UserFactory::withGiphyKey(string $key = 'giphy-test-key'): self`. Later tasks use the factory state and read `$user->giphy_key`.

- [ ] **Step 1: Create the migration**

Run: `php artisan make:migration add_giphy_key_to_users_table`

Then make the file read exactly:

```php
<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table): void {
            $table->text('giphy_key')->nullable();
        });
    }
};
```

(No `down()` — matches the existing `add_giphy_to_commits_table` migration.)

- [ ] **Step 2: Write the failing tests**

Append to `tests/Unit/Models/UserTest.php` (it already imports `DB` and `User`):

```php
it('stores the giphy key encrypted and reads it back', function (): void {
    $user = User::factory()->withGiphyKey('giphy-test-key')->create();

    expect($user->refresh()->giphy_key)->toBe('giphy-test-key')
        ->and(DB::table('users')->where('id', $user->id)->value('giphy_key'))
        ->toBeString()
        ->not->toBe('giphy-test-key')
        ->not->toContain('giphy-test-key');
});

it('defaults the giphy key to null', function (): void {
    expect(User::factory()->create()->refresh()->giphy_key)->toBeNull();
});

it('serializes no giphy key', function (): void {
    $user = User::factory()->withGiphyKey()->create();

    expect($user->toArray())->not->toHaveKey('giphy_key')
        ->and($user->jsonSerialize())->not->toHaveKey('giphy_key');
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `php artisan test tests/Unit/Models/UserTest.php`
Expected: FAIL — `Call to undefined method Database\Factories\UserFactory::withGiphyKey()`.

- [ ] **Step 4: Implement the factory state, cast, and hidden attribute**

In `database/factories/UserFactory.php`, add after `withoutProfile()`:

```php
    public function withGiphyKey(string $key = 'giphy-test-key'): self
    {
        return $this->state(fn (array $attributes): array => [
            'giphy_key' => $key,
        ]);
    }
```

In `app/Models/User.php`:

1. Docblock — add after `@property-read string|null $remember_token`:

```php
 * @property-read string|null $giphy_key
```

2. `#[Hidden([...])]` attribute — add `'giphy_key',` to the list (after `'remember_token',`).

3. `casts()` — add after `'remember_token' => 'string',`:

```php
            'giphy_key' => 'encrypted',
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `php artisan test tests/Unit/Models/UserTest.php`
Expected: PASS (the pre-existing `to array` test must also still pass — it pins the exact serialized keys).

- [ ] **Step 6: Commit**

```bash
git add database/migrations database/factories/UserFactory.php app/Models/User.php tests/Unit/Models/UserTest.php
git commit -m "feat: store a per-user giphy key"
```

---

### Task 2: Share the key from the user account, retire the env key

**Files:**
- Modify: `app/Http/Middleware/HandleInertiaRequests.php:48-52` (the `giphy` prop)
- Modify: `config/services.php` (remove the `giphy` block)
- Modify: `.env.example:73-76` (remove the `GIPHY_KEY` block)
- Modify: `README.md:59` (the "GIFs" paragraph)
- Test: `tests/Feature/Middleware/HandleInertiaRequestsGiphyTest.php` (rewrite)

**Interfaces:**
- Consumes: `User::$giphy_key` and `UserFactory::withGiphyKey()` from Task 1.
- Produces: the `giphy` page prop (`{key: string} | null`) sourced from the signed-in user; guests get `null`. The client modules and `types/global.d.ts` are unchanged.

- [ ] **Step 1: Rewrite the failing middleware tests**

Replace the whole contents of `tests/Feature/Middleware/HandleInertiaRequestsGiphyTest.php` with:

```php
<?php

declare(strict_types=1);

use App\Enums\Log;
use App\Models\User;
use Inertia\Testing\AssertableInertia as Assert;

it('shares the giphy key of the signed-in user', function (): void {
    $user = User::factory()->withGiphyKey('giphy-test')->create();

    $this->actingAs($user)
        ->get(route('log.show', Log::Following))
        ->assertInertia(fn (Assert $page): Assert => $page->where('giphy.key', 'giphy-test'));
});

it('shares no giphy config without a key', function (): void {
    $this->actingAs(User::factory()->create())
        ->get(route('log.show', Log::Following))
        ->assertInertia(fn (Assert $page): Assert => $page->where('giphy', null));
});

it('shares no giphy config for guests', function (): void {
    $this->get(route('log.show', Log::Trending))
        ->assertInertia(fn (Assert $page): Assert => $page->where('giphy', null));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `php artisan test tests/Feature/Middleware/HandleInertiaRequestsGiphyTest.php`
Expected: FAIL — the prop still comes from `config('services.giphy.key')`, so the signed-in user's key is not shared.

- [ ] **Step 3: Source the prop from the user**

In `app/Http/Middleware/HandleInertiaRequests.php`, replace the `giphy` entry (currently lines 48–52):

```php
            'giphy' => fn (): ?array => (function () use ($request): ?array {
                $key = $request->user()?->giphy_key;

                return is_string($key) && $key !== '' ? ['key' => $key] : null;
            })(),
```

- [ ] **Step 4: Remove the env key everywhere**

1. `config/services.php` — delete this block:

```php
    'giphy' => [
        'key' => env('GIPHY_KEY'),
    ],
```

2. `.env.example` — delete the four-line block:

```
# GIF picker (GIPHY). The key is shipped to the browser, as GIPHY requires client-side API calls,
# and the picker is hidden without one. Beta keys are heavily rate limited; production use needs
# an approved key with "Powered By GIPHY" attribution (https://developers.giphy.com).
GIPHY_KEY=
```

3. `README.md` — replace the whole `### GIFs` paragraph with:

```markdown
GIF search is bring-your-own-key: connect your own free [GIPHY API key](https://developers.giphy.com) under Settings → Profile → Giphy and every composer gains a GIF picker: search GIPHY and attach one GIF to a commit, reply, or quote — never alongside uploaded images or a poll. Searches run on the connected key and its quota, so no paid key is shared by the instance; without one the picker is hidden. The browser talks to GIPHY directly and commits store only the GIF's URLs and its metadata — nothing is downloaded or rehosted. Production use needs an approved key, which requires the "Powered By GIPHY" mark the picker already shows.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `php artisan test tests/Feature/Middleware/HandleInertiaRequestsGiphyTest.php`
Expected: PASS (3 tests).

Also run the neighboring suite to catch stragglers: `php artisan test tests/Feature/Controllers/CommitControllerTest.php tests/Feature/Controllers/CommitReplyControllerTest.php`
Expected: PASS — commit payload tests never needed the key.

- [ ] **Step 6: Commit**

```bash
git add app/Http/Middleware/HandleInertiaRequests.php config/services.php .env.example README.md tests/Feature/Middleware/HandleInertiaRequestsGiphyTest.php
git commit -m "feat: share the giphy key from the user account"
```

---

### Task 3: Connect and remove endpoints

**Files:**
- Create: `app/Http/Requests/UpdateGiphyKeyRequest.php`
- Create: `app/Http/Controllers/GiphyKeyController.php`
- Modify: `routes/web.php` (import + two routes after the pasteis-mode route)
- Test: `tests/Feature/Controllers/GiphyKeyControllerTest.php` (create)
- Test: `tests/Feature/Controllers/ExportControllerTest.php` (append one test)

**Interfaces:**
- Consumes: `User::$giphy_key` (Task 1).
- Produces: `PUT settings/giphy` → route name `giphy-key.update`, `DELETE settings/giphy` → route name `giphy-key.destroy`; generated actions at `@/actions/App/Http/Controllers/GiphyKeyController` (`update.url()`, `destroy.url()`); success toasts `'GIPHY key connected.'` / `'GIPHY key removed.'`.

- [ ] **Step 1: Write the failing controller tests**

Create `tests/Feature/Controllers/GiphyKeyControllerTest.php`:

```php
<?php

declare(strict_types=1);

use App\Models\User;
use Illuminate\Support\Facades\DB;

it('stores a trimmed giphy key encrypted at rest', function (): void {
    $user = User::factory()->create();

    $this->actingAs($user)->fromRoute('user-profile.edit')
        ->put(route('giphy-key.update'), ['key' => '  giphy-test-key  '])
        ->assertRedirectToRoute('user-profile.edit')
        ->assertInertiaFlash('toast', [
            'type' => 'success',
            'message' => 'GIPHY key connected.',
        ]);

    expect($user->refresh()->giphy_key)->toBe('giphy-test-key')
        ->and(DB::table('users')->where('id', $user->id)->value('giphy_key'))
        ->not->toContain('giphy-test-key');
});

it('replaces an existing key', function (): void {
    $user = User::factory()->withGiphyKey('first-key')->create();

    $this->actingAs($user)->fromRoute('user-profile.edit')
        ->put(route('giphy-key.update'), ['key' => 'second-key'])
        ->assertRedirectToRoute('user-profile.edit');

    expect($user->refresh()->giphy_key)->toBe('second-key');
});

it('removes the key', function (): void {
    $user = User::factory()->withGiphyKey()->create();

    $this->actingAs($user)->fromRoute('user-profile.edit')
        ->delete(route('giphy-key.destroy'))
        ->assertRedirectToRoute('user-profile.edit')
        ->assertInertiaFlash('toast', [
            'type' => 'success',
            'message' => 'GIPHY key removed.',
        ]);

    expect($user->refresh()->giphy_key)->toBeNull();
});

it('rejects invalid keys without touching the stored one', function (array $payload): void {
    $user = User::factory()->withGiphyKey('stored-key')->create();

    $this->actingAs($user)->putJson(route('giphy-key.update'), $payload)
        ->assertUnprocessable()->assertJsonValidationErrors('key');

    expect($user->refresh()->giphy_key)->toBe('stored-key');
})->with([
    'missing' => [fn (): array => []],
    'empty' => [fn (): array => ['key' => '']],
    'whitespace' => [fn (): array => ['key' => '   ']],
    'not a string' => [fn (): array => ['key' => ['nested']]],
    'too long' => [fn (): array => ['key' => str_repeat('a', 256)]],
]);

it('requires authentication to connect a key', function (): void {
    $this->putJson(route('giphy-key.update'), ['key' => 'giphy-test-key'])->assertUnauthorized();
});

it('requires authentication to remove a key', function (): void {
    $this->deleteJson(route('giphy-key.destroy'))->assertUnauthorized();
});
```

Then append to `tests/Feature/Controllers/ExportControllerTest.php`:

```php
it('never exports the giphy key', function (): void {
    $user = User::factory()->withGiphyKey('giphy-test-key')->create();

    $response = $this->actingAs($user)->get(route('export'));

    $response->assertOk();
    $data = json_decode($response->streamedContent(), true, flags: JSON_THROW_ON_ERROR);

    expect($data['profile'])->not->toHaveKey('giphy_key')
        ->and($response->streamedContent())->not->toContain('giphy-test-key');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `php artisan test tests/Feature/Controllers/GiphyKeyControllerTest.php tests/Feature/Controllers/ExportControllerTest.php`
Expected: FAIL — `Route [giphy-key.update] not defined` (export test fails on `withGiphyKey` only if Task 1 is missing; it should pass once Task 1 is in).

- [ ] **Step 3: Write the Form Request**

Create `app/Http/Requests/UpdateGiphyKeyRequest.php`:

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

final class UpdateGiphyKeyRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    protected function prepareForValidation(): void
    {
        $key = $this->input('key');

        if (is_string($key)) {
            $this->merge(['key' => trim($key)]);
        }
    }

    /**
     * @return array<string, list<string>>
     */
    public function rules(): array
    {
        return [
            'key' => ['required', 'string', 'max:255'],
        ];
    }
}
```

- [ ] **Step 4: Write the controller**

Create `app/Http/Controllers/GiphyKeyController.php`:

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Http\Requests\UpdateGiphyKeyRequest;
use App\Models\User;
use Illuminate\Container\Attributes\CurrentUser;
use Illuminate\Http\RedirectResponse;
use Inertia\Inertia;

final readonly class GiphyKeyController
{
    public function update(UpdateGiphyKeyRequest $request, #[CurrentUser] User $user): RedirectResponse
    {
        $user->update(['giphy_key' => $request->string('key')->toString()]);

        Inertia::flash('toast', [
            'type' => 'success',
            'message' => 'GIPHY key connected.',
        ]);

        return back();
    }

    public function destroy(#[CurrentUser] User $user): RedirectResponse
    {
        $user->update(['giphy_key' => null]);

        Inertia::flash('toast', [
            'type' => 'success',
            'message' => 'GIPHY key removed.',
        ]);

        return back();
    }
}
```

- [ ] **Step 5: Register the routes**

In `routes/web.php`:

1. Add `use App\Http\Controllers\GiphyKeyController;` in the controller import block (alphabetically, after the `FailedJob*` imports).
2. Add these two routes right after the `settings/pasteis-mode` route (around line 256):

```php
    // Giphy key...
    Route::put('settings/giphy', [GiphyKeyController::class, 'update'])->name('giphy-key.update');
    Route::delete('settings/giphy', [GiphyKeyController::class, 'destroy'])->name('giphy-key.destroy');
```

- [ ] **Step 6: Regenerate the TypeScript route actions**

Run: `php artisan wayfinder:generate --with-form`
Then verify: `ls resources/js/actions/App/Http/Controllers/GiphyKeyController.ts`
Expected: the file exists (it is gitignored — do not commit it).

- [ ] **Step 7: Run the tests to verify they pass**

Run: `php artisan test tests/Feature/Controllers/GiphyKeyControllerTest.php tests/Feature/Controllers/ExportControllerTest.php`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add app/Http/Requests/UpdateGiphyKeyRequest.php app/Http/Controllers/GiphyKeyController.php routes/web.php tests/Feature/Controllers/GiphyKeyControllerTest.php tests/Feature/Controllers/ExportControllerTest.php
git commit -m "feat: connect and remove the giphy key"
```

---

### Task 4: Browser-side key verification and copy

**Files:**
- Modify: `resources/js/lib/giphy.ts` (add `validateGiphyKey`, update `GiphyRateLimited` message)
- Modify: `resources/js/components/giphy-picker-dialog.tsx:124` (rate-limit copy)
- Modify: `resources/js/components/giphy-picker-button.tsx:10` (docblock)
- Test: `tests/Unit/Giphy.test.ts` (append tests)

**Interfaces:**
- Consumes: `giphyTrendingUrl` (existing).
- Produces: `export type GiphyKeyValidation = 'valid' | 'invalid' | 'rate-limited' | 'unreachable'` and `export async function validateGiphyKey(key: string): Promise<GiphyKeyValidation>`. Task 5's component calls it before saving: 200 → `'valid'`, 401/403 → `'invalid'`, 429 → `'rate-limited'`, network error or any other status → `'unreachable'`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/Unit/Giphy.test.ts` (add `validateGiphyKey` to the existing import from `../../resources/js/lib/giphy.ts`):

```ts
const originalFetch = globalThis.fetch;

function stubFetch(result: number | 'network'): string[] {
    const calls: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL) => {
        calls.push(String(input));

        if (result === 'network') {
            throw new TypeError('fetch failed');
        }

        return new Response('{}', { status: result });
    }) as typeof fetch;

    return calls;
}

function restoreFetch(): void {
    globalThis.fetch = originalFetch;
}

await test('validates a key against the trending endpoint', async () => {
    const calls = stubFetch(200);

    try {
        assert.equal(await validateGiphyKey('key-123'), 'valid');
        assert.ok(calls[0]?.includes('api_key=key-123'));
        assert.ok(calls[0]?.includes('rating=g'));
    } finally {
        restoreFetch();
    }
});

await test('treats a refused key as invalid', async () => {
    for (const status of [401, 403]) {
        stubFetch(status);

        try {
            assert.equal(await validateGiphyKey('key-123'), 'invalid');
        } finally {
            restoreFetch();
        }
    }
});

await test('treats a throttled key as rate limited but real', async () => {
    stubFetch(429);

    try {
        assert.equal(await validateGiphyKey('key-123'), 'rate-limited');
    } finally {
        restoreFetch();
    }
});

await test('treats network failures and unexpected statuses as unreachable', async () => {
    stubFetch('network');

    try {
        assert.equal(await validateGiphyKey('key-123'), 'unreachable');
    } finally {
        restoreFetch();
    }

    stubFetch(500);

    try {
        assert.equal(await validateGiphyKey('key-123'), 'unreachable');
    } finally {
        restoreFetch();
    }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test:unit`
Expected: FAIL — `validateGiphyKey` is not exported.

- [ ] **Step 3: Implement the validation helper and copy changes**

In `resources/js/lib/giphy.ts`:

1. Update the `GiphyRateLimited` message:

```ts
export class GiphyRateLimited extends Error {
    constructor() {
        super('Your GIPHY key is rate limiting searches.');
    }
}
```

2. Add below `fetchGifs` (and export it):

```ts
export type GiphyKeyValidation =
    | 'valid'
    | 'invalid'
    | 'rate-limited'
    | 'unreachable';

/**
 * Verifies a pasted key against GIPHY from the browser, so no key ever
 * reaches the server for validation. A throttled key is still a real key.
 */
export async function validateGiphyKey(
    key: string,
): Promise<GiphyKeyValidation> {
    let response: Response;

    try {
        response = await fetch(giphyTrendingUrl(key));
    } catch {
        return 'unreachable';
    }

    if (response.ok) {
        return 'valid';
    }

    if (response.status === 401 || response.status === 403) {
        return 'invalid';
    }

    return response.status === 429 ? 'rate-limited' : 'unreachable';
}
```

In `resources/js/components/giphy-picker-dialog.tsx`, find (line ~124):

```tsx
                        GIPHY is rate limiting searches. Try again shortly.
```

and replace it with:

```tsx
                        You’ve hit your GIPHY key’s search rate limit. Try
                        again shortly.
```

(Preserve the file's typographic apostrophes; keep surrounding JSX as-is.)

In `resources/js/components/giphy-picker-button.tsx`, replace the docblock:

```ts
/**
 * Invisible until the signed-in user connects their own GIPHY key in settings.
 */
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test:unit && bun run test:types`
Expected: PASS (all suites, including the untouched composer tests).

- [ ] **Step 5: Commit**

```bash
git add resources/js/lib/giphy.ts resources/js/components/giphy-picker-dialog.tsx resources/js/components/giphy-picker-button.tsx tests/Unit/Giphy.test.ts
git commit -m "feat: verify the giphy key in the browser"
```

---

### Task 5: The Giphy settings section

**Files:**
- Create: `resources/js/components/giphy-key-setting.tsx`
- Modify: `resources/js/pages/user-profile/edit.tsx`
- Modify: `app/Http/Controllers/UserProfileController.php` (add `giphyConnected`)
- Modify: `tests/Feature/Controllers/UserProfileControllerTest.php` (append one test)
- Create: `tests/Unit/GiphyKeySetting.test.tsx`
- Create: `tests/giphy-key.config.ts`
- Create: `tests/Unit/GiphyKeySettingRender.test.ts`
- Modify: `tests/tsconfig.json`

**Interfaces:**
- Consumes: `validateGiphyKey` (Task 4); generated actions `{ update, destroy }` from `@/actions/App/Http/Controllers/GiphyKeyController` and route URLs `/settings/giphy` (Task 3); page prop `giphyConnected: boolean` from `UserProfileController::edit`.
- Produces: `GiphyKeySetting({ giphyConnected }: { giphyConnected: boolean })` rendered on the Profile settings page.

- [ ] **Step 1: Write the failing profile page test**

Append to `tests/Feature/Controllers/UserProfileControllerTest.php`:

```php
it('renders whether a giphy key is connected', function (bool $connected): void {
    $user = $connected
        ? User::factory()->withGiphyKey()->create()
        : User::factory()->create();

    $this->actingAs($user)
        ->get(route('user-profile.edit'))
        ->assertOk()
        ->assertInertia(fn ($page) => $page
            ->component('user-profile/edit')
            ->where('giphyConnected', $connected)
            ->missing('auth.user.giphy_key'));
})->with([true, false]);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `php artisan test tests/Feature/Controllers/UserProfileControllerTest.php`
Expected: FAIL — `giphyConnected` prop is missing.

- [ ] **Step 3: Add the prop to the page controller**

In `app/Http/Controllers/UserProfileController.php`, add to the `Inertia::render` payload in `edit()`:

```php
            'giphyConnected' => $user->giphy_key !== null,
```

- [ ] **Step 4: Write the failing component test**

Create `tests/giphy-key.config.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';

export default defineConfig({
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('../resources/js', import.meta.url)),
        },
    },
    test: {
        include: ['tests/Unit/GiphyKeySetting.test.tsx'],
    },
});
```

Create `tests/Unit/GiphyKeySetting.test.tsx`:

```tsx
/// <reference types="node" />
import assert from 'node:assert/strict';
import * as React from 'react';
import type { ReactElement, ReactNode } from 'react';
import { beforeEach, test, vi } from 'vite-plus/test';

let state: unknown[] = [];
let cursor = 0;

vi.doMock('react', () => ({
    ...React,
    useEffect: (effect: () => void) => effect(),
    useMemo: (factory: () => unknown) => factory(),
    useId: () => `preview-${cursor++}`,
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
        snapshot(),
    useRef: (initial: unknown) => {
        const index = cursor++;

        if (!(index in state)) {
            state[index] = { current: initial };
        }

        return state[index];
    },
    useState: (initial: unknown) => {
        const index = cursor++;

        if (!(index in state)) {
            state[index] = typeof initial === 'function' ? initial() : initial;
        }

        return [
            state[index],
            (value: unknown) => {
                state[index] =
                    typeof value === 'function'
                        ? (value as (current: unknown) => unknown)(state[index])
                        : value;
            },
        ];
    },
}));

const put = vi.fn();
const destroy = vi.fn();

vi.doMock('@inertiajs/react', async () => ({
    ...(await vi.importActual('@inertiajs/react')),
    router: { put, delete: destroy },
}));

const { GiphyKeySetting } = await import(
    '../../resources/js/components/giphy-key-setting'
);

type Element = ReactElement<Record<string, unknown>>;

function elements(node: ReactNode): Element[] {
    if (!React.isValidElement(node)) {
        return [];
    }

    const element = node as Element;

    return [
        element,
        ...React.Children.toArray(element.props.children as ReactNode).flatMap(
            elements,
        ),
    ];
}

function render(giphyConnected: boolean): Element[] {
    cursor = 0;

    return elements(GiphyKeySetting({ giphyConnected }));
}

function field(fields: Element[], testId: string): Element {
    const found = fields.find(
        (element) => element.props['data-test'] === testId,
    );

    assert.ok(found, `no element with data-test="${testId}"`);

    return found;
}

function stubFetch(result: number | 'network'): void {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
            if (result === 'network') {
                throw new TypeError('fetch failed');
            }

            return new Response('{}', { status: result });
        }),
    );
}

function typeKey(fields: Element[], value: string): Element[] {
    field(fields, 'giphy-key-input').props.onChange({
        target: { value },
    });

    return render(false);
}

beforeEach(() => {
    state = [];
    cursor = 0;
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

test('saves a valid key after giphy accepts it', async () => {
    stubFetch(200);

    let fields = typeKey(render(false), '  key-123  ');
    await (field(fields, 'giphy-connect-button').props.onClick as () => Promise<void>)();

    assert.equal(put.mock.calls.length, 1);
    assert.equal(put.mock.calls[0]?.[0], '/settings/giphy');
    assert.deepEqual(put.mock.calls[0]?.[1], { key: 'key-123' });

    const options = put.mock.calls[0]?.[2] as { onSuccess: () => void };
    options.onSuccess();

    fields = render(true);
    assert.ok(field(fields, 'giphy-connected'));
});

test('saves a rate-limited key because the key itself is real', async () => {
    stubFetch(429);

    const fields = typeKey(render(false), 'key-123');
    await (field(fields, 'giphy-connect-button').props.onClick as () => Promise<void>)();

    assert.equal(put.mock.calls.length, 1);
});

test('rejects a refused key without saving', async () => {
    stubFetch(401);

    const fields = typeKey(render(false), 'key-123');
    await (field(fields, 'giphy-connect-button').props.onClick as () => Promise<void>)();

    assert.equal(put.mock.calls.length, 0);
    assert.equal(
        field(render(false), 'giphy-key-error').props.children,
        'That key was rejected by GIPHY.',
    );
});

test('does not save when giphy cannot be reached', async () => {
    stubFetch('network');

    const fields = typeKey(render(false), 'key-123');
    await (field(fields, 'giphy-connect-button').props.onClick as () => Promise<void>)();

    assert.equal(put.mock.calls.length, 0);
    assert.equal(
        field(render(false), 'giphy-key-error').props.children,
        "Couldn't reach GIPHY to verify the key.",
    );
});

test('disables connect until a key is typed', () => {
    const fields = render(false);

    assert.equal(field(fields, 'giphy-connect-button').props.disabled, true);
});

test('surfaces server validation errors', async () => {
    stubFetch(200);

    const fields = typeKey(render(false), 'key-123');
    await (field(fields, 'giphy-connect-button').props.onClick as () => Promise<void>)();

    const options = put.mock.calls[0]?.[2] as {
        onError: (errors: Record<string, string>) => void;
    };
    options.onError({ key: 'The key field is required.' });

    assert.equal(
        field(render(false), 'giphy-key-error').props.children,
        'The key field is required.',
    );
});

test('removes a connected key', () => {
    const fields = render(true);

    (field(fields, 'giphy-remove-button').props.onClick as () => void)();

    assert.equal(destroy.mock.calls.length, 1);
    assert.equal(destroy.mock.calls[0]?.[0], '/settings/giphy');
});
```

Create `tests/Unit/GiphyKeySettingRender.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

await test('connects, updates, and removes the giphy key from profile settings', () => {
    const cli = fileURLToPath(
        new URL('./bin/vp', import.meta.resolve('vite-plus/package.json')),
    );

    execFileSync(
        process.execPath,
        [cli, 'test', 'run', '--config', 'tests/giphy-key.config.ts'],
        {
            cwd: fileURLToPath(new URL('../..', import.meta.url)),
            stdio: 'inherit',
        },
    );
});
```

- [ ] **Step 5: Run the component test to verify it fails**

Run: `bun run test:unit`
Expected: FAIL — cannot resolve `../../resources/js/components/giphy-key-setting`.

- [ ] **Step 6: Write the component**

Create `resources/js/components/giphy-key-setting.tsx`:

```tsx
import { router } from '@inertiajs/react';
import { useState } from 'react';
import {
    destroy,
    update,
} from '@/actions/App/Http/Controllers/GiphyKeyController';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { validateGiphyKey } from '@/lib/giphy';

export function GiphyKeySetting({
    giphyConnected,
}: {
    giphyConnected: boolean;
}) {
    const [key, setKey] = useState('');
    const [editing, setEditing] = useState(!giphyConnected);
    const [processing, setProcessing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const connect = async () => {
        if (processing) {
            return;
        }

        const candidate = key.trim();

        if (candidate === '') {
            return;
        }

        setProcessing(true);
        setError(null);

        const verdict = await validateGiphyKey(candidate);

        if (verdict === 'invalid') {
            setError('That key was rejected by GIPHY.');
            setProcessing(false);

            return;
        }

        if (verdict === 'unreachable') {
            setError("Couldn't reach GIPHY to verify the key.");
            setProcessing(false);

            return;
        }

        router.put(
            update.url(),
            { key: candidate },
            {
                preserveScroll: true,
                onFinish: () => setProcessing(false),
                onError: (errors) =>
                    setError(errors.key ?? 'Could not save the key.'),
                onSuccess: () => {
                    setKey('');
                    setError(null);
                    setEditing(false);
                },
            },
        );
    };

    const remove = () => {
        if (processing) {
            return;
        }

        setError(null);

        router.delete(destroy.url(), {
            preserveScroll: true,
            onStart: () => setProcessing(true),
            onFinish: () => setProcessing(false),
            onError: () => setError('Could not remove the key.'),
        });
    };

    return (
        <section className="px-4 py-6 sm:px-6">
            <h2 id="giphy-key-label" className="text-base font-semibold">
                Giphy
            </h2>
            <p
                id="giphy-key-description"
                className="mt-2 text-sm text-muted-foreground"
            >
                GIF search runs on your own GIPHY API key, under your own
                quota. Get a free key at{' '}
                <a
                    href="https://developers.giphy.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-4"
                >
                    developers.giphy.com
                </a>
                , connect it here, and every composer gains a GIF picker.
                Without a key, the picker stays hidden.
            </p>
            {giphyConnected && !editing ? (
                <div className="mt-4 flex flex-wrap items-center gap-3">
                    <p className="text-sm" data-test="giphy-connected">
                        GIPHY is connected.
                    </p>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={processing}
                        onClick={() => setEditing(true)}
                    >
                        Update
                    </Button>
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={processing}
                        onClick={remove}
                        data-test="giphy-remove-button"
                    >
                        {processing ? <Spinner /> : null}
                        Remove
                    </Button>
                </div>
            ) : (
                <div className="mt-4 max-w-md space-y-2">
                    <Label htmlFor="giphy-key-input">GIPHY API key</Label>
                    <div className="flex gap-2">
                        <Input
                            id="giphy-key-input"
                            value={key}
                            onChange={(event) => setKey(event.target.value)}
                            placeholder="Paste your GIPHY API key"
                            autoComplete="off"
                            data-test="giphy-key-input"
                        />
                        <Button
                            type="button"
                            onClick={() => connect()}
                            disabled={processing || key.trim() === ''}
                            data-test="giphy-connect-button"
                        >
                            {processing ? <Spinner /> : null}
                            {giphyConnected ? 'Update' : 'Connect'}
                        </Button>
                    </div>
                </div>
            )}
            {error !== null && (
                <p
                    className="mt-3 text-sm text-destructive"
                    role="alert"
                    data-test="giphy-key-error"
                >
                    {error}
                </p>
            )}
        </section>
    );
}
```

- [ ] **Step 7: Wire the page**

In `resources/js/pages/user-profile/edit.tsx`:

1. Import: `import { GiphyKeySetting } from '@/components/giphy-key-setting';` (alphabetically among component imports).
2. Add `giphyConnected` to the destructured props and the inline type:

```tsx
export default function Edit({
    preferredLane,
    automaticLane,
    githubSyncedAt,
    giphyConnected,
    activityGraphUrl,
    profileUrl,
}: {
    preferredLane: number | null;
    automaticLane: number;
    githubSyncedAt: string | null;
    giphyConnected: boolean;
    activityGraphUrl: string;
    profileUrl: string;
}) {
```

3. Render the section right after `<PasteisModeSetting />`:

```tsx
            <GiphyKeySetting giphyConnected={giphyConnected} />
```

- [ ] **Step 8: Register the test files for type checking**

In `tests/tsconfig.json`, extend `include` with:

```json
        "Unit/GiphyKeySetting.test.tsx",
        "giphy-key.config.ts"
```

- [ ] **Step 9: Run everything**

Run: `php artisan test tests/Feature/Controllers/UserProfileControllerTest.php`
Expected: PASS.

Run: `bun run test:unit && bun run test:types && bun run test:lint`
Expected: PASS. If lint/format complains, run `bun run lint` and include the fixes.

- [ ] **Step 10: Commit**

```bash
git add resources/js/components/giphy-key-setting.tsx resources/js/pages/user-profile/edit.tsx app/Http/Controllers/UserProfileController.php tests/Feature/Controllers/UserProfileControllerTest.php tests/Unit/GiphyKeySetting.test.tsx tests/giphy-key.config.ts tests/Unit/GiphyKeySettingRender.test.ts tests/tsconfig.json
git commit -m "feat: add the giphy key section to profile settings"
```

---

### Task 6: Full gates

**Files:**
- Modify: only if gates surface fixes.

**Interfaces:**
- Consumes: everything above.
- Produces: a green branch ready for review.

- [ ] **Step 1: Run the full PHP gate**

Run: `composer test`
Expected: PASS — Pint, PHPStan max, 100% line/type coverage, full Pest suite. If Pint flags formatting, run `composer lint` and commit the fixes with the task.

- [ ] **Step 2: Run the full JS gates**

Run: `bun run test:unit && bun run test:types && bun run test:lint`
Expected: PASS — lib tests, component tests, both tsconfigs, fmt + lint.

- [ ] **Step 3: Sanity-check the feature end to end (manual, optional)**

Run `bun run dev` (or use the worktree's built assets), sign in, open Settings → Profile → Giphy, paste any junk string: the browser-side check must show "That key was rejected by GIPHY." without saving. With a real key the toast "GIPHY key connected." appears and the composer's GIF button turns visible.

- [ ] **Step 4: Commit any residual fixes**

```bash
git add -A
git commit -m "chore: satisfy the gates for the byok giphy key"
```

(Only if Steps 1–2 produced changes; otherwise skip.)

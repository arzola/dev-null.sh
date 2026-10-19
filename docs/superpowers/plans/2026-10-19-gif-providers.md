# Multi-Provider GIF Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the GIPHY-only GIF picker into one active, bring-your-own-key provider chosen from GIPHY or KLIPY, behind a client `GifProvider` interface and a server `GifProvider` enum.

**Architecture:** Provider-specific behavior lives in `resources/js/lib/gif-providers/*` (one adapter + one registry) and `App\Enums\GifProvider` (ids, labels, host allowlists). Everywhere else — picker UI, composer wiring, schema, serialization, feeds, OG metadata, moderation — uses generic `gif_*` fields and a `provider` discriminator. One active provider per user; connecting another replaces it. The feature is unreleased, so migrations are rewritten in place with no back-compat.

**Tech Stack:** Laravel 13 (PHP 8.5, strict types), Inertia 3 + React 19 + TypeScript, Pest 5, node:test for lib tests, Vite+ for component tests.

**Spec:** `docs/superpowers/specs/2026-10-19-gif-providers-design.md`

## Global Constraints

- PHP: `declare(strict_types=1);` in every file; classes `final`; actions `final readonly`; validation/authorization only in Form Requests (`tests/Unit/ArchTest.php` enforces). No `protected` methods (strict arch preset) — Form Request `prepareForValidation` is `public`.
- Tests: Pest with exactly 100.0% line coverage and 100% type coverage; PHPStan max. Every new PHP branch needs a test.
- No real HTTP in tests: `Http::preventStrayRequests()` is global; frontend tests stub `fetch`.
- **No server-side provider calls, ever.** The browser calls GIPHY/KLIPY directly; the server only stores and validates shape. Keys are validated in the browser before saving.
- GIPHY terms: `rating=g` always; media/page URLs stored and rendered verbatim; "Powered By GIPHY" mark in the picker; contributor attribution on cards.
- KLIPY terms: search placeholder must be exactly `Search KLIPY`; `Powered by KLIPY` mark in the picker; `contentfilter=high` on every call; URLs verbatim; KLIPY results are never blended with another provider (one active provider guarantees this).
- Naming: copy uses `GIPHY` / `KLIPY`; stored ids are `giphy` / `klipy`.
- The feature is unreleased: no backfills, no legacy aliases. After rewriting migrations, reset the local dev DB (`php artisan migrate:fresh`).
- Wayfinder: `resources/js/actions`, `resources/js/routes` are gitignored; after route/controller changes run `php artisan wayfinder:generate --with-form` and never commit generated files.
- House rule: `git add` new files immediately after creating them.
- Gates: PHP `composer test:lint`, `composer test:types`, `composer test:type-coverage`, full `php -d memory_limit=-1 vendor/bin/pest --fresh` (CI runs the `--exactly=100.0` coverage leg with pcov). JS: `bun run test:unit`, `bun run test:types`, `bun run test:lint`.

---

### Task 1: Provider enum, schema rewrite, model and factory

**Files:**
- Create: `app/Enums/GifProvider.php`
- Rename+rewrite: `database/migrations/2026_10_17_024509_add_giphy_to_commits_table.php` → `..._add_gif_to_commits_table.php`
- Rename+rewrite: `database/migrations/2026_10_17_133426_add_giphy_key_to_users_table.php` → `..._add_gif_key_to_users_table.php`
- Modify: `app/Models/Commit.php`, `app/Models/User.php`, `app/Queries/CommitBuilder.php`
- Modify: `database/factories/CommitFactory.php`, `database/factories/UserFactory.php`
- Test: `tests/Unit/Enums/GifProviderTest.php` (create), `tests/Unit/Models/CommitTest.php`, `tests/Unit/Models/UserTest.php`

**Interfaces:**
- Produces: `App\Enums\GifProvider` (cases `Giphy`, `Klipy`; `label(): string`, `mediaHostPatterns(): list<string>`, `pageHostPatterns(): list<string>`).
- Produces: Commit columns `gif_provider`, `gif_id`, `gif_url`, `gif_page_url`, `gif_title`, `gif_username`, `gif_width`, `gif_height`; `Commit::gif()` returns `{provider, id, url, page_url, title, username, width, height}|null`; `User` columns `gif_provider`, `gif_key`; `CommitFactory::withGif(GifProvider $provider = GifProvider::Giphy)`, `UserFactory::withGifKey(GifProvider $provider = GifProvider::Giphy, string $key = 'gif-test-key')`.

- [ ] **Step 1: Write the failing enum test**

Create `tests/Unit/Enums/GifProviderTest.php`:

```php
<?php

declare(strict_types=1);

use App\Enums\GifProvider;

it('labels each provider as the ui does', function (): void {
    expect(GifProvider::Giphy->label())->toBe('GIPHY')
        ->and(GifProvider::Klipy->label())->toBe('KLIPY');
});

it('accepts only its own media hosts', function (GifProvider $provider, string $host, bool $allowed): void {
    $matches = array_filter(
        $provider->mediaHostPatterns(),
        fn (string $pattern): bool => preg_match($pattern, $host) === 1,
    );

    expect($matches !== [])->toBe($allowed);
})->with([
    'giphy media' => [GifProvider::Giphy, 'media2.giphy.com', true],
    'giphy api host' => [GifProvider::Giphy, 'api.giphy.com', false],
    'klipy static' => [GifProvider::Klipy, 'static.klipy.com', true],
    'klipy numbered static' => [GifProvider::Klipy, 'static2.klipy.com', true],
    'klipy api host' => [GifProvider::Klipy, 'api.klipy.com', false],
]);

it('accepts only its own page hosts', function (GifProvider $provider, string $host, bool $allowed): void {
    $matches = array_filter(
        $provider->pageHostPatterns(),
        fn (string $pattern): bool => preg_match($pattern, $host) === 1,
    );

    expect($matches !== [])->toBe($allowed);
})->with([
    'giphy page' => [GifProvider::Giphy, 'giphy.com', true],
    'giphy www page' => [GifProvider::Giphy, 'www.giphy.com', true],
    'klipy page' => [GifProvider::Klipy, 'klipy.com', true],
    'klipy www page' => [GifProvider::Klipy, 'www.klipy.com', true],
    'giphy page against klipy' => [GifProvider::Klipy, 'giphy.com', false],
]);
```

Update `tests/Unit/Models/CommitTest.php`: rename every `giphy_*` fixture key to `gif_*`, call `Commit::factory()->withGif()` instead of `withGiphy()`, and every expected `gif` payload gains `'provider' => 'giphy'` as the FIRST key. Add:

```php
it('serializes the klipy provider too', function (): void {
    $commit = Commit::factory()->withGif(GifProvider::Klipy)->create();

    expect($commit->toArray()['gif'])->toMatchArray([
        'provider' => 'klipy',
        'id' => 'hello-hi-662',
        'url' => 'https://static.klipy.com/ii/935d7ab9/kLipy.gif',
        'page_url' => 'https://klipy.com/gifs/hello-hi-662',
        'username' => null,
    ]);
});
```

Update `tests/Unit/Models/UserTest.php`: replace `withGiphyKey(...)` with `withGifKey(...)`; the encrypted round-trip test asserts `gif_key`; serialization tests assert `gif_key` and `gif_provider` are absent; add:

```php
it('defaults the gif provider to null', function (): void {
    $user = User::factory()->create()->refresh();

    expect($user->gif_key)->toBeNull()
        ->and($user->gif_provider)->toBeNull()
        ->and(DB::table('users')->where('id', $user->id)->value('gif_provider'))->toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `php artisan test tests/Unit/Enums/GifProviderTest.php tests/Unit/Models/CommitTest.php tests/Unit/Models/UserTest.php`
Expected: FAIL — class `App\Enums\GifProvider` not found; factories lack `withGif`/`withGifKey`.

- [ ] **Step 3: Create the enum**

Create `app/Enums/GifProvider.php`:

```php
<?php

declare(strict_types=1);

namespace App\Enums;

enum GifProvider: string
{
    case Giphy = 'giphy';
    case Klipy = 'klipy';

    public function label(): string
    {
        return match ($this) {
            self::Giphy => 'GIPHY',
            self::Klipy => 'KLIPY',
        };
    }

    /**
     * @return list<string>
     */
    public function mediaHostPatterns(): array
    {
        return match ($this) {
            self::Giphy => ['/^media\d*\.giphy\.com$/'],
            self::Klipy => ['/^static\d*\.klipy\.com$/'],
        };
    }

    /**
     * @return list<string>
     */
    public function pageHostPatterns(): array
    {
        return match ($this) {
            self::Giphy => ['/^(www\.)?giphy\.com$/'],
            self::Klipy => ['/^(www\.)?klipy\.com$/'],
        };
    }
}
```

- [ ] **Step 4: Rewrite the migrations in place**

```bash
git mv database/migrations/2026_10_17_024509_add_giphy_to_commits_table.php database/migrations/2026_10_17_024509_add_gif_to_commits_table.php
git mv database/migrations/2026_10_17_133426_add_giphy_key_to_users_table.php database/migrations/2026_10_17_133426_add_gif_key_to_users_table.php
```

Replace the commits migration body with:

```php
    public function up(): void
    {
        Schema::table('commits', function (Blueprint $table): void {
            $table->string('gif_provider', 16)->nullable();
            $table->string('gif_id', 64)->nullable();
            $table->text('gif_url')->nullable();
            $table->text('gif_page_url')->nullable();
            $table->string('gif_title', 300)->nullable();
            $table->string('gif_username', 100)->nullable();
            $table->unsignedSmallInteger('gif_width')->nullable();
            $table->unsignedSmallInteger('gif_height')->nullable();
        });
    }
```

Replace the users migration body with:

```php
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table): void {
            $table->string('gif_provider', 16)->nullable();
            $table->text('gif_key')->nullable();
        });
    }
```

Then reset the local dev database (the feature is unreleased): `php artisan migrate:fresh`.

- [ ] **Step 5: Update the models and builders**

In `app/Models/Commit.php`:

1. Docblock: rename the seven `@property-read ... $giphy_*` entries to `$gif_*` and add `@property-read GifProvider|null $gif_provider` (import `App\Enums\GifProvider`).
2. `#[Hidden([...])]`: rename the seven `giphy_*` entries to `gif_*` and add `'gif_provider'`.
3. `casts()`: rename the seven entries to `gif_*` and add `'gif_provider' => GifProvider::class,`.
4. `gif()` becomes:

```php
    public function gif(): ?array
    {
        if ($this->gif_id === null || $this->gif_url === null || $this->gif_page_url === null || $this->gif_provider === null) {
            return null;
        }

        return [
            'provider' => $this->gif_provider->value,
            'id' => $this->gif_id,
            'url' => $this->gif_url,
            'page_url' => $this->gif_page_url,
            'title' => $this->gif_title,
            'username' => $this->gif_username,
            'width' => $this->gif_width,
            'height' => $this->gif_height,
        ];
    }
```

In `app/Models/User.php`:

1. Docblock: replace `@property-read string|null $giphy_key` with `@property-read string|null $gif_key` and add `@property-read GifProvider|null $gif_provider` (import the enum).
2. `#[Hidden([...])]`: replace `'giphy_key'` with `'gif_key'` and add `'gif_provider'`.
3. `$attributes` defaults: replace `'giphy_key' => null,` with `'gif_key' => null,` and add `'gif_provider' => null,`.
4. `casts()`: replace `'giphy_key' => 'encrypted',` with `'gif_key' => 'encrypted',` and add `'gif_provider' => GifProvider::class,`.

In `app/Queries/CommitBuilder.php`, replace the last column line of `COLUMNS_BUT_EMBEDDING`:

```php
        'gif_provider', 'gif_id', 'gif_url', 'gif_page_url', 'gif_title', 'gif_username', 'gif_width', 'gif_height',
```

- [ ] **Step 6: Update the factories**

In `database/factories/CommitFactory.php`, replace `withGiphy()` with:

```php
    public function withGif(GifProvider $provider = GifProvider::Giphy): self
    {
        $attributes = match ($provider) {
            GifProvider::Giphy => [
                'gif_id' => 'xT9IgzoKnwFNmISR8I',
                'gif_url' => 'https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy-downsized-medium.gif?cid=abc123',
                'gif_page_url' => 'https://giphy.com/gifs/deal-with-it-xT9IgzoKnwFNmISR8I',
                'gif_title' => 'Deal With It GIF',
                'gif_username' => 'giphy',
                'gif_width' => 480,
                'gif_height' => 270,
            ],
            GifProvider::Klipy => [
                'gif_id' => 'hello-hi-662',
                'gif_url' => 'https://static.klipy.com/ii/935d7ab9/kLipy.gif',
                'gif_page_url' => 'https://klipy.com/gifs/hello-hi-662',
                'gif_title' => 'Hello',
                'gif_username' => null,
                'gif_width' => 498,
                'gif_height' => 498,
            ],
        };

        return $this->state(fn (array $attributes): array => [
            'gif_provider' => $provider->value,
            ...$attributes,
        ]);
    }
```

(Import `App\Enums\GifProvider` in both factories.)

In `database/factories/UserFactory.php`, replace `withGiphyKey()` with:

```php
    public function withGifKey(GifProvider $provider = GifProvider::Giphy, string $key = 'gif-test-key'): self
    {
        return $this->state(fn (array $attributes): array => [
            'gif_provider' => $provider->value,
            'gif_key' => $key,
        ]);
    }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `php artisan test tests/Unit/Enums/GifProviderTest.php tests/Unit/Models/CommitTest.php tests/Unit/Models/UserTest.php`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add app/Enums/GifProvider.php database/migrations database/factories app/Models/Commit.php app/Models/User.php app/Queries/CommitBuilder.php tests/Unit/Enums/GifProviderTest.php tests/Unit/Models/CommitTest.php tests/Unit/Models/UserTest.php
git commit -m "feat: generalize gif storage across providers"
```

---

### Task 2: Provider-aware validation, DTO, and commit pipeline

**Files:**
- Rename+rewrite: `app/Dto/Giphy.php` → `app/Dto/Gif.php`
- Rename+rewrite: `app/Rules/GiphyMediaUrl.php` → `app/Rules/GifMediaUrl.php`
- Create: `app/Rules/GifPageUrl.php`
- Modify: `app/Http/Requests/CreateCommitRequest.php`, `app/Http/Requests/CreateCommitReplyRequest.php`
- Modify: `app/Actions/CreateCommit.php`, `app/Http/Controllers/CommitController.php`, `app/Http/Controllers/CommitReplyController.php`
- Test: `tests/Unit/Rules/GifMediaUrlTest.php` (create), `tests/Unit/Rules/GifPageUrlTest.php` (create), `tests/Feature/Controllers/CommitControllerTest.php`, `tests/Feature/Controllers/CommitReplyControllerTest.php`

**Interfaces:**
- Consumes: `App\Enums\GifProvider`, `gif_*` columns, `CommitFactory::withGif()`.
- Produces: `App\Dto\Gif` constructor `(GifProvider $provider, string $id, string $url, string $pageUrl, ?string $title, ?string $username, int $width, int $height)`; `toColumns()` emits `gif_provider` + `gif_*`.
- Produces: `CreateCommitRequest::gif(): ?Gif` (and same on `CreateCommitReplyRequest`); `CreateCommit::handle(..., ?Gif $gif = null)`.

- [ ] **Step 1: Write the failing rule tests**

Create `tests/Unit/Rules/GifMediaUrlTest.php`:

```php
<?php

declare(strict_types=1);

use App\Enums\GifProvider;
use App\Rules\GifMediaUrl;
use Illuminate\Support\Facades\Validator;

it('accepts a matching provider media url verbatim', function (GifProvider $provider, string $url): void {
    $validator = Validator::make(['url' => $url], ['url' => [new GifMediaUrl($provider)]]);

    expect($validator->passes())->toBeTrue();
})->with([
    'giphy' => [GifProvider::Giphy, 'https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy-downsized-medium.gif?cid=abc123'],
    'klipy' => [GifProvider::Klipy, 'https://static2.klipy.com/ii/935d7ab9/14/af/8GCrVAB7.gif'],
]);

it('rejects urls from the other provider', function (GifProvider $provider, string $url): void {
    $validator = Validator::make(['url' => $url], ['url' => [new GifMediaUrl($provider)]]);

    expect($validator->fails())->toBeTrue();
})->with([
    'giphy url for klipy' => [GifProvider::Klipy, 'https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy.gif'],
    'klipy url for giphy' => [GifProvider::Giphy, 'https://static.klipy.com/ii/935d7ab9/8GCrVAB7.gif'],
]);

it('rejects unsafe or malformed media urls', function (mixed $url): void {
    $validator = Validator::make(['url' => $url], ['url' => [new GifMediaUrl(GifProvider::Klipy)]]);

    expect($validator->fails())->toBeTrue();
})->with([
    'not https' => ['http://static.klipy.com/ii/x.gif'],
    'not a gif' => ['https://static.klipy.com/ii/x.webp'],
    'with port' => ['https://static.klipy.com:8443/ii/x.gif'],
    'with userinfo' => ['https://user:pass@static.klipy.com/ii/x.gif'],
    'dot segment' => ['https://static.klipy.com/ii/../x.gif'],
    'array value' => [['nope']],
]);
```

Create `tests/Unit/Rules/GifPageUrlTest.php`:

```php
<?php

declare(strict_types=1);

use App\Enums\GifProvider;
use App\Rules\GifPageUrl;
use Illuminate\Support\Facades\Validator;

it('accepts matching provider page urls', function (GifProvider $provider, string $url): void {
    $validator = Validator::make(['url' => $url], ['url' => [new GifPageUrl($provider)]]);

    expect($validator->passes())->toBeTrue();
})->with([
    'giphy' => [GifProvider::Giphy, 'https://giphy.com/gifs/deal-with-it-xT9IgzoKnwFNmISR8I'],
    'klipy' => [GifProvider::Klipy, 'https://klipy.com/gifs/hello-hi-662'],
]);

it('rejects urls from the other provider', function (GifProvider $provider, string $url): void {
    $validator = Validator::make(['url' => $url], ['url' => [new GifPageUrl($provider)]]);

    expect($validator->fails())->toBeTrue();
})->with([
    'giphy page for klipy' => [GifProvider::Klipy, 'https://giphy.com/gifs/x'],
    'klipy page for giphy' => [GifProvider::Giphy, 'https://klipy.com/gifs/x'],
]);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `php artisan test tests/Unit/Rules/GifMediaUrlTest.php tests/Unit/Rules/GifPageUrlTest.php`
Expected: FAIL — classes do not exist.

- [ ] **Step 3: Implement the rules and DTO**

```bash
git mv app/Rules/GiphyMediaUrl.php app/Rules/GifMediaUrl.php
git mv app/Dto/Giphy.php app/Dto/Gif.php
```

Replace `app/Rules/GifMediaUrl.php` with:

```php
<?php

declare(strict_types=1);

namespace App\Rules;

use App\Enums\GifProvider;
use Closure;
use Illuminate\Contracts\Validation\ValidationRule;

/**
 * Only https URLs on the provider's media hosts pointing at a .gif rendition. Query strings stay verbatim and
 * dot-segments are rejected, so the host boundary holds after browsers normalize the URL.
 */
final readonly class GifMediaUrl implements ValidationRule
{
    public function __construct(private GifProvider $provider)
    {
        //
    }

    public function validate(string $attribute, mixed $value, Closure $fail): void
    {
        $parts = is_string($value) ? parse_url($value) : false;
        $host = is_array($parts) ? ($parts['host'] ?? '') : '';

        $isValid = is_array($parts)
            && ($parts['scheme'] ?? '') === 'https'
            && array_filter(
                $this->provider->mediaHostPatterns(),
                fn (string $pattern): bool => preg_match($pattern, $host) === 1,
            ) !== []
            && ! isset($parts['fragment'])
            && ! isset($parts['port'])
            && ! isset($parts['user'])
            && ! isset($parts['pass'])
            && preg_match('#^/[A-Za-z0-9._/-]+\.gif$#', $parts['path'] ?? '') === 1
            && preg_match('#(?:^|/)\.{1,2}(?:/|$)#', $parts['path']) !== 1;

        if (! $isValid) {
            $fail(__('The GIF could not be attached.'));
        }
    }
}
```

Create `app/Rules/GifPageUrl.php`:

```php
<?php

declare(strict_types=1);

namespace App\Rules;

use App\Enums\GifProvider;
use Closure;
use Illuminate\Contracts\Validation\ValidationRule;

/** Only https page URLs on the provider's own site. */
final readonly class GifPageUrl implements ValidationRule
{
    public function __construct(private GifProvider $provider)
    {
        //
    }

    public function validate(string $attribute, mixed $value, Closure $fail): void
    {
        $parts = is_string($value) ? parse_url($value) : false;
        $host = is_array($parts) ? ($parts['host'] ?? '') : '';

        $isValid = is_array($parts)
            && ($parts['scheme'] ?? '') === 'https'
            && array_filter(
                $this->provider->pageHostPatterns(),
                fn (string $pattern): bool => preg_match($pattern, $host) === 1,
            ) !== []
            && ! isset($parts['port'])
            && ! isset($parts['user'])
            && ! isset($parts['pass']);

        if (! $isValid) {
            $fail(__('The GIF could not be attached.'));
        }
    }
}
```

Replace `app/Dto/Gif.php` with:

```php
<?php

declare(strict_types=1);

namespace App\Dto;

use App\Enums\GifProvider;

/** A GIF picked from a provider; URLs kept exactly as its API returned them. */
final readonly class Gif
{
    public function __construct(
        public GifProvider $provider,
        public string $id,
        public string $url,
        public string $pageUrl,
        public ?string $title,
        public ?string $username,
        public int $width,
        public int $height,
    ) {
        //
    }

    /**
     * @return array<string, string|int|null>
     */
    public function toColumns(): array
    {
        return [
            'gif_provider' => $this->provider->value,
            'gif_id' => $this->id,
            'gif_url' => $this->url,
            'gif_page_url' => $this->pageUrl,
            'gif_title' => $this->title,
            'gif_username' => $this->username,
            'gif_width' => $this->width,
            'gif_height' => $this->height,
        ];
    }
}
```

- [ ] **Step 4: Update the form requests**

In both `CreateCommitRequest` and `CreateCommitReplyRequest`:

1. Replace the `use App\Dto\Giphy;` / `use App\Rules\GiphyMediaUrl;` imports with `use App\Dto\Gif;` / `use App\Enums\GifProvider;` / `use App\Rules\GifMediaUrl;` / `use App\Rules\GifPageUrl;` (and make sure `use Illuminate\Validation\Rule;` is imported).
2. In the request's `rules()` (or `attachmentRules()` if one exists), leave the existing image/poll rules untouched, define the provider once immediately before the returned array, and replace only the seven `giphy_*` lines with the `gif_*` lines below:

```php
        $provider = GifProvider::tryFrom((string) $this->input('gif_provider')) ?? GifProvider::Giphy;

        // ...the request's existing return [ ... ] keeps its non-GIF rules; replace the gif lines with:

            'gif_provider' => ['nullable', 'string', Rule::enum(GifProvider::class), 'required_with:gif_id'],
            'gif_id' => ['nullable', 'string', 'max:64', 'regex:/^[A-Za-z0-9]+$/', 'prohibits:images,poll', 'required_with:gif_url'],
            'gif_url' => ['nullable', 'string', 'max:2048', 'required_with:gif_id', new GifMediaUrl($provider)],
            'gif_page_url' => ['nullable', 'string', 'max:2048', 'required_with:gif_id', new GifPageUrl($provider)],
            'gif_title' => ['nullable', 'string', 'max:300'],
            'gif_username' => ['nullable', 'string', 'max:100'],
            'gif_width' => ['nullable', 'integer', 'min:1', 'max:10000', 'required_with:gif_id'],
            'gif_height' => ['nullable', 'integer', 'min:1', 'max:10000', 'required_with:gif_id'],
```

3. Replace the `giphy()` accessor with:

```php
    public function gif(): ?Gif
    {
        if (! $this->filled('gif_id')) {
            return null;
        }

        return new Gif(
            GifProvider::from((string) $this->input('gif_provider')),
            $this->string('gif_id')->value(),
            $this->string('gif_url')->value(),
            $this->string('gif_page_url')->value(),
            $this->filled('gif_title') ? $this->string('gif_title')->value() : null,
            $this->filled('gif_username') ? $this->string('gif_username')->value() : null,
            $this->integer('gif_width'),
            $this->integer('gif_height'),
        );
    }
```

- [ ] **Step 5: Update the action and controllers**

`app/Actions/CreateCommit.php`: `use App\Dto\Gif;`; signature `?Gif $gif = null`; spread stays `...$gif?->toColumns() ?? []`.

`app/Http/Controllers/CommitController.php` and `CommitReplyController.php`: pass `gif: $request->gif()`.

- [ ] **Step 6: Update the feature tests**

In `tests/Feature/Controllers/CommitControllerTest.php` and `CommitReplyControllerTest.php`: rename every `giphy_*` payload key to `gif_*`, add `'gif_provider' => 'giphy'` to each valid GIF payload, and rename assertions `giphy_id` → `gif_id`. Replace the GIPHY-only fixture URL `https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy.gif` usage consistently. Add to `CommitControllerTest`:

```php
it('accepts a klipy gif', function (): void {
    $user = User::factory()->create();

    $response = $this->actingAs($user)->post(route('commit.store'), [
        'body' => 'Klipy time',
        'gif_provider' => 'klipy',
        'gif_id' => 'hello-hi-662',
        'gif_url' => 'https://static.klipy.com/ii/935d7ab9/8GCrVAB7.gif',
        'gif_page_url' => 'https://klipy.com/gifs/hello-hi-662',
        'gif_width' => 498,
        'gif_height' => 498,
    ]);

    $response->assertSessionHasNoErrors();

    expect($user->commits()->sole()->gif_provider->value)->toBe('klipy');
});

it('rejects a gif url from another provider', function (): void {
    $user = User::factory()->create();

    $response = $this->actingAs($user)->postJson(route('commit.store'), [
        'body' => 'Mismatch',
        'gif_provider' => 'klipy',
        'gif_id' => 'abc123',
        'gif_url' => 'https://media2.giphy.com/media/abc123/giphy.gif',
        'gif_page_url' => 'https://klipy.com/gifs/abc123',
        'gif_width' => 480,
        'gif_height' => 270,
    ]);

    $response->assertUnprocessable()->assertJsonValidationErrors('gif_url');
});

it('rejects a gif without a provider', function (): void {
    $user = User::factory()->create();

    $response = $this->actingAs($user)->postJson(route('commit.store'), [
        'body' => 'No provider',
        'gif_id' => 'abc123',
        'gif_url' => 'https://media2.giphy.com/media/abc123/giphy.gif',
        'gif_page_url' => 'https://giphy.com/gifs/abc123',
        'gif_width' => 480,
        'gif_height' => 270,
    ]);

    $response->assertUnprocessable()->assertJsonValidationErrors('gif_provider');
});
```

Mirror the klipy acceptance + mismatch cases in `CommitReplyControllerTest` (the `gif_provider` field is part of its attachment set too).

- [ ] **Step 7: Run the tests to verify they pass**

Run: `php artisan test tests/Unit/Rules tests/Feature/Controllers/CommitControllerTest.php tests/Feature/Controllers/CommitReplyControllerTest.php`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add app/Dto/Gif.php app/Rules/GifMediaUrl.php app/Rules/GifPageUrl.php app/Http/Requests/CreateCommitRequest.php app/Http/Requests/CreateCommitReplyRequest.php app/Actions/CreateCommit.php app/Http/Controllers/CommitController.php app/Http/Controllers/CommitReplyController.php tests/Unit/Rules tests/Feature/Controllers/CommitControllerTest.php tests/Feature/Controllers/CommitReplyControllerTest.php
git commit -m "feat: validate gifs against the selected provider"
```

---

### Task 3: Provider-aware read surfaces (API, feed, OG, moderation)

**Files:**
- Modify: `app/Services/PageMetadata.php`, `app/Actions/CreateUserFeed.php`, `app/Actions/UpdateCommitAiDecision.php`
- Test: `tests/Feature/Controllers/Api/CommitControllerTest.php`, `tests/Feature/Controllers/Api/BookmarkControllerTest.php`, `tests/Feature/Controllers/Api/LogControllerTest.php`, `tests/Feature/Controllers/Api/NotificationControllerTest.php`, `tests/Feature/Controllers/UserFeedControllerTest.php`, `tests/Unit/Jobs/ModerateCommitTest.php`, `tests/Feature/Controllers/CommitOpenGraphImageControllerTest.php`

**Interfaces:**
- Consumes: `Commit::gif()` including `provider`, `gif_*` attributes.
- Produces: API `gif` object with `provider`; feed/OG/moderation read the renamed columns. No shape changes beyond `provider`.

- [ ] **Step 1: Rename the column references**

Apply these exact replacements:

- `app/Services/PageMetadata.php`: `$commit->giphy_url` → `$commit->gif_url`; `$commit->giphy_width` → `$commit->gif_width`; `$commit->giphy_height` → `$commit->gif_height`; `$commit->giphy_title` → `$commit->gif_title`.
- `app/Actions/CreateUserFeed.php`: `$commit->giphy_url` → `$commit->gif_url`.
- `app/Actions/UpdateCommitAiDecision.php`: `$commit->giphy_url` → `$commit->gif_url`.

- [ ] **Step 2: Update the tests to the new shape**

- API tests (`CommitControllerTest`, `BookmarkControllerTest`, `LogControllerTest`, `NotificationControllerTest`): every expected `gif` array or JSON object gains `'provider' => 'giphy'` (or `"provider": "giphy"` inside JSON strings) as the first key, and factory calls `withGiphy()` become `withGif()`.
- `UserFeedControllerTest`, `ModerateCommitTest`, `CommitOpenGraphImageControllerTest`: update `withGiphy()` → `withGif()`; replace any `giphy_*` column writes with `gif_*` and add `gif_provider` where rows are created by hand. The giphy URL assertions keep the URL values (they are unchanged fixtures).
- Add one KLIPY moderation assertion in `ModerateCommitTest`:

```php
it('moderates an attached klipy gif by its url', function (): void {
    Http::fake([
        'api.openai.com/v1/moderations' => Http::response(moderationResponse()),
        'api.openai.com/v1/responses' => reviewResponses(),
    ]);

    $commit = Commit::factory()->pending()->withGif(GifProvider::Klipy)->create();

    dispatch_sync(new ModerateCommit($commit));

    Http::assertSent(fn (Request $request): bool => str_contains($request->url(), 'moderations')
        && str_contains($request->body(), 'static.klipy.com'));
});
```

- [ ] **Step 3: Run the tests**

Run: `php artisan test tests/Feature/Controllers/Api tests/Feature/Controllers/UserFeedControllerTest.php tests/Unit/Jobs/ModerateCommitTest.php tests/Feature/Controllers/CommitOpenGraphImageControllerTest.php`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/Services/PageMetadata.php app/Actions/CreateUserFeed.php app/Actions/UpdateCommitAiDecision.php tests/Feature/Controllers/Api tests/Feature/Controllers/UserFeedControllerTest.php tests/Unit/Jobs/ModerateCommitTest.php tests/Feature/Controllers/CommitOpenGraphImageControllerTest.php
git commit -m "feat: expose the gif provider on every read surface"
```

---

### Task 4: One-active-provider BYOK on the server

**Files:**
- Rename+rewrite: `app/Http/Controllers/GiphyKeyController.php` → `GifKeyController.php`
- Rename+rewrite: `app/Http/Requests/UpdateGiphyKeyRequest.php` → `UpdateGifKeyRequest.php`
- Modify: `app/Http/Middleware/HandleInertiaRequests.php`, `app/Http/Controllers/UserProfileController.php`, `routes/web.php`
- Test: `tests/Feature/Controllers/GifKeyControllerTest.php` (renamed), `tests/Feature/Middleware/GifPropTest.php` (renamed), `tests/Feature/Controllers/UserProfileControllerTest.php`, `tests/Feature/Controllers/ExportControllerTest.php`

**Interfaces:**
- Consumes: `App\Enums\GifProvider`, `users.gif_provider`/`gif_key`.
- Produces: `PUT settings/gif` (`gif-key.update`) with `{provider, key}`; `DELETE settings/gif` (`gif-key.destroy`); Inertia prop `gif: { provider: 'giphy'|'klipy', key: string } | null`; profile-page props `gifConnected: bool`, `gifProvider: 'giphy'|'klipy'|null`.

- [ ] **Step 1: Rename the tests and write the failing expectations**

```bash
git mv tests/Feature/Controllers/GiphyKeyControllerTest.php tests/Feature/Controllers/GifKeyControllerTest.php
git mv tests/Feature/Middleware/HandleInertiaRequestsGiphyTest.php tests/Feature/Middleware/GifPropTest.php
```

In `GifKeyControllerTest.php`: rename route calls `giphy-key.update` → `gif-key.update`, `giphy-key.destroy` → `gif-key.destroy`; `withGiphyKey()` → `withGifKey()`; payloads `['key' => ...]` become `['provider' => 'giphy', 'key' => ...]`; `giphy_key` assertions become `gif_key`; expected toasts become `'GIPHY key connected.'` / `'GIF provider removed.'`. Replace the dataset cases with:

```php
it('replaces one provider with another atomically', function (): void {
    $user = User::factory()->withGifKey(GifProvider::Giphy, 'giphy-key')->create();

    $this->actingAs($user)->fromRoute('user-profile.edit')
        ->put(route('gif-key.update'), ['provider' => 'klipy', 'key' => 'klipy-key'])
        ->assertRedirectToRoute('user-profile.edit')
        ->assertInertiaFlash('toast', ['type' => 'success', 'message' => 'KLIPY key connected.']);

    expect($user->refresh())
        ->gif_provider->toBe(GifProvider::Klipy)
        ->gif_key->toBe('klipy-key');
});

it('rejects invalid providers without touching the stored one', function (array $payload): void {
    $user = User::factory()->withGifKey()->create();
    $field = in_array($payload['provider'] ?? null, ['giphy', 'klipy'], true) ? 'key' : 'provider';

    $this->actingAs($user)->putJson(route('gif-key.update'), $payload)
        ->assertUnprocessable()->assertJsonValidationErrors($field);

    expect($user->refresh()->gif_provider)->toBe(GifProvider::Giphy);
})->with([
    'missing provider' => [fn (): array => ['key' => 'x']],
    'unknown provider' => [fn (): array => ['provider' => 'tenor', 'key' => 'x']],
    'missing key' => [fn (): array => ['provider' => 'giphy']],
    'blank key' => [fn (): array => ['provider' => 'giphy', 'key' => '   ']],
    'non-string key' => [fn (): array => ['provider' => 'giphy', 'key' => ['x']]],
    'too long' => [fn (): array => ['provider' => 'giphy', 'key' => str_repeat('a', 256)]],
]);
```

The encryption-at-rest test keeps its shape but targets `gif_key` and sends the provider. The remove test asserts both `gif_key` and `gif_provider` become null and the toast is `'GIF provider removed.'`.

In `GifPropTest.php` (import `App\Enums\GifProvider`): the prop is now `gif` with the shape `{provider, key}`:

```php
it('shares the connected provider and key with its owner', function (): void {
    $user = User::factory()->withGifKey(GifProvider::Klipy, 'klipy-key')->create();

    $this->actingAs($user)
        ->get(route('log.show', Log::Following))
        ->assertInertia(fn (Assert $page): Assert => $page
            ->where('gif.provider', 'klipy')
            ->where('gif.key', 'klipy-key'));
});

it('shares no gif config without a connected provider', function (): void {
    $this->actingAs(User::factory()->create())
        ->get(route('log.show', Log::Following))
        ->assertInertia(fn (Assert $page): Assert => $page->where('gif', null));
});

it('shares no gif config for guests', function (): void {
    $this->get(route('log.show', Log::Trending))
        ->assertInertia(fn (Assert $page): Assert => $page->where('gif', null));
});
```

In `UserProfileControllerTest.php`, rename the giphy test to assert `gifConnected` and `gifProvider`:

```php
it('renders the connected gif provider', function (?string $provider): void {
    $user = $provider === null
        ? User::factory()->create()
        : User::factory()->withGifKey(GifProvider::from($provider))->create();

    $this->actingAs($user)
        ->get(route('user-profile.edit'))
        ->assertOk()
        ->assertInertia(fn ($page) => $page
            ->where('gifConnected', $provider !== null)
            ->where('gifProvider', $provider)
            ->missing('auth.user.gif_key')
            ->missing('auth.user.gif_provider'));
})->with([null, 'giphy', 'klipy']);
```

In `ExportControllerTest.php`, rename the test to `never exports the gif key` and use `withGifKey()`, asserting `profile` has no `gif_key` and the body does not contain the key.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `php artisan test tests/Feature/Controllers/GifKeyControllerTest.php tests/Feature/Middleware/GifPropTest.php tests/Feature/Controllers/UserProfileControllerTest.php tests/Feature/Controllers/ExportControllerTest.php`
Expected: FAIL — routes `gif-key.*` not defined, props `gif`/`gifConnected` missing.

- [ ] **Step 3: Implement the controller, request, routes, middleware, and page props**

```bash
git mv app/Http/Controllers/GiphyKeyController.php app/Http/Controllers/GifKeyController.php
git mv app/Http/Requests/UpdateGiphyKeyRequest.php app/Http/Requests/UpdateGifKeyRequest.php
```

`UpdateGifKeyRequest`: rules become:

```php
    public function rules(): array
    {
        return [
            'provider' => ['required', 'string', Rule::enum(GifProvider::class)],
            'key' => ['required', 'string', 'max:255'],
        ];
    }

    public function provider(): GifProvider
    {
        return GifProvider::from((string) $this->input('provider'));
    }
```

(`prepareForValidation` keeps the `mb_trim` on `key`; import `App\Enums\GifProvider` and `Illuminate\Validation\Rule`.)

`GifKeyController`:

```php
final readonly class GifKeyController
{
    public function update(UpdateGifKeyRequest $request, #[CurrentUser] User $user): RedirectResponse
    {
        $provider = $request->provider();

        $user->update([
            'gif_provider' => $provider,
            'gif_key' => $request->string('key')->toString(),
        ]);

        Inertia::flash('toast', [
            'type' => 'success',
            'message' => $provider->label().' key connected.',
        ]);

        return back();
    }

    public function destroy(#[CurrentUser] User $user): RedirectResponse
    {
        $user->update(['gif_provider' => null, 'gif_key' => null]);

        Inertia::flash('toast', [
            'type' => 'success',
            'message' => 'GIF provider removed.',
        ]);

        return back();
    }
}
```

`routes/web.php`: replace the giphy block with:

```php
    // GIF provider...
    Route::put('settings/gif', [GifKeyController::class, 'update'])->name('gif-key.update');
    Route::delete('settings/gif', [GifKeyController::class, 'destroy'])->name('gif-key.destroy');
```

(Update the controller import; regenerate TypeScript routes: `php artisan wayfinder:generate --with-form`.)

`HandleInertiaRequests`: replace the `giphy` prop with:

```php
            'gif' => fn (): ?array => (function () use ($request): ?array {
                $user = $request->user();

                if ($user?->gif_provider === null || $user->gif_key === null || $user->gif_key === '') {
                    return null;
                }

                return ['provider' => $user->gif_provider->value, 'key' => $user->gif_key];
            })(),
```

`UserProfileController::edit` gains:

```php
            'gifConnected' => $user->gif_key !== null,
            'gifProvider' => $user->gif_provider?->value,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `php artisan test tests/Feature/Controllers/GifKeyControllerTest.php tests/Feature/Middleware/GifPropTest.php tests/Feature/Controllers/UserProfileControllerTest.php tests/Feature/Controllers/ExportControllerTest.php`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/Http/Controllers/GifKeyController.php app/Http/Requests/UpdateGifKeyRequest.php app/Http/Middleware/HandleInertiaRequests.php app/Http/Controllers/UserProfileController.php routes/web.php tests/Feature/Controllers/GifKeyControllerTest.php tests/Feature/Middleware/GifPropTest.php tests/Feature/Controllers/UserProfileControllerTest.php tests/Feature/Controllers/ExportControllerTest.php
git commit -m "feat: store one active gif provider per user"
```

---

### Task 5: Client provider interface, adapters, and storage

**Files:**
- Create: `resources/js/lib/gif-providers/types.ts`, `giphy.ts`, `klipy.ts`, `index.ts`
- Delete: `resources/js/lib/giphy.ts`
- Modify: `resources/js/lib/gif-storage.ts`, `resources/js/types/global.d.ts`, `resources/js/types/commit.ts`
- Test: `tests/Unit/GifProviders.test.ts` (create), `tests/Unit/GifStorage.test.ts` (update); delete `tests/Unit/Giphy.test.ts`

**Interfaces:**
- Produces: `GifProviderId`, `GifResult`, `GifAttachment = GifResult & { provider }`, `GifSearchPage {results, nextCursor}`, `GifKeyValidation`, `GifProvider`, `GifRateLimited` (all in `types.ts`).
- Produces: `resources/js/lib/gif-providers/index.ts` — `gifProviders: Record<GifProviderId, GifProvider>`, `attachmentFromResult(id, result): GifAttachment`, `gifFormFields(gif): Record<string, string | number>` (emits `gif_provider` + `gif_*`).
- Produces: page prop type `gif: { provider: GifProviderId; key: string } | null`; `CommitGif` type gains `provider: GifProviderId`.

- [ ] **Step 1: Write the failing contract tests**

Create `tests/Unit/GifProviders.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    attachmentFromResult,
    gifFormFields,
} from '../../resources/js/lib/gif-providers/index.ts';
import { giphy } from '../../resources/js/lib/gif-providers/giphy.ts';
import { klipy } from '../../resources/js/lib/gif-providers/klipy.ts';
import { GifRateLimited } from '../../resources/js/lib/gif-providers/types.ts';

const originalFetch = globalThis.fetch;

function stubFetch(payload: unknown, status = 200): string[] {
    const calls: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL) => {
        calls.push(String(input));

        return new Response(JSON.stringify(payload), { status });
    }) as typeof fetch;

    return calls;
}

function restoreFetch(): void {
    globalThis.fetch = originalFetch;
}

const giphyPayload = {
    data: [{
        id: 'xT9IgzoKnwFNmISR8I',
        title: 'Deal With It GIF',
        username: 'giphy',
        url: 'https://giphy.com/gifs/deal-with-it-xT9IgzoKnwFNmISR8I',
        images: {
            fixed_height_small: { url: 'https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/100.gif?cid=abc', width: '178', height: '100' },
            downsized_medium: { url: 'https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy-downsized-medium.gif?cid=abc', width: '480', height: '270' },
        },
    }],
};

const klipyPayload = {
    results: [{
        id: 'hello-hi-662',
        title: 'Hello',
        content_description: 'hello greeting',
        itemurl: 'https://klipy.com/gifs/hello-hi-662',
        media_formats: {
            gif: { url: 'https://static.klipy.com/ii/8GCrVAB7.gif', dims: [498, 498] },
            tinygif: { url: 'https://static.klipy.com/ii/y6iepZM7.gif', dims: [220, 220] },
        },
    }],
    next: 'cursor-2',
};

test('giphy builds search and trending urls with the g rating', async () => {
    const searchCalls = stubFetch(giphyPayload);
    try {
        const page = await giphy.search('key-123', 'deal with it', { cursor: null });
        const url = new URL(searchCalls[0]!);
        assert.equal(url.origin + url.pathname, 'https://api.giphy.com/v1/gifs/search');
        assert.equal(url.searchParams.get('api_key'), 'key-123');
        assert.equal(url.searchParams.get('q'), 'deal with it');
        assert.equal(url.searchParams.get('rating'), 'g');
        assert.equal(url.searchParams.get('offset'), '0');
        assert.equal(page.results[0]?.url, 'https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy-downsized-medium.gif?cid=abc');
        assert.equal(page.results[0]?.previewUrl, 'https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/100.gif?cid=abc');
        assert.equal(page.nextCursor, null);
    } finally {
        restoreFetch();
    }

    const trendingCalls = stubFetch(giphyPayload);
    try {
        await giphy.trending('key-123', { cursor: '24' });
        assert.ok(trendingCalls[0]!.includes('/v1/gifs/trending?'));
        assert.ok(trendingCalls[0]!.includes('offset=24'));
    } finally {
        restoreFetch();
    }
});

test('klipy builds tenor-compatible urls and maps the next cursor', async () => {
    const calls = stubFetch(klipyPayload);
    try {
        const page = await klipy.search('k-key', 'hello', { cursor: null });
        const url = new URL(calls[0]!);
        assert.equal(url.origin + url.pathname, 'https://api.klipy.com/v2/search');
        assert.equal(url.searchParams.get('key'), 'k-key');
        assert.equal(url.searchParams.get('q'), 'hello');
        assert.equal(url.searchParams.get('contentfilter'), 'high');
        assert.equal(page.results[0]?.pageUrl, 'https://klipy.com/gifs/hello-hi-662');
        assert.equal(page.results[0]?.username, null);
        assert.equal(page.results[0]?.previewUrl, 'https://static.klipy.com/ii/y6iepZM7.gif');
        assert.equal(page.nextCursor, 'cursor-2');
    } finally {
        restoreFetch();
    }

    const trendingCalls = stubFetch({ results: [], next: '' });
    try {
        const page = await klipy.trending('k-key', { cursor: null });
        assert.ok(trendingCalls[0]!.includes('/v2/featured?'));
        assert.equal(page.nextCursor, null);
    } finally {
        restoreFetch();
    }
});

test('adapters map throttling and key verdicts to the shared shapes', async () => {
    stubFetch({}, 429);
    try {
        await assert.rejects(() => giphy.trending('k', { cursor: null }), GifRateLimited);
        assert.equal(await giphy.validateKey('k'), 'rate-limited');
        assert.equal(await klipy.validateKey('k'), 'rate-limited');
    } finally {
        restoreFetch();
    }

    for (const status of [401, 403]) {
        stubFetch({}, status);
        try {
            assert.equal(await giphy.validateKey('k'), 'invalid');
            assert.equal(await klipy.validateKey('k'), 'invalid');
        } finally {
            restoreFetch();
        }
    }

    stubFetch({}, 200);
    try {
        assert.equal(await giphy.validateKey('k'), 'valid');
        assert.equal(await klipy.validateKey('k'), 'valid');
    } finally {
        restoreFetch();
    }

    globalThis.fetch = (async () => {
        throw new TypeError('network');
    }) as typeof fetch;
    try {
        assert.equal(await giphy.validateKey('k'), 'unreachable');
        assert.equal(await klipy.validateKey('k'), 'unreachable');
    } finally {
        restoreFetch();
    }
});

test('attachments carry the provider and shape the hidden form fields', () => {
    const gif = attachmentFromResult('klipy', {
        id: 'hello-hi-662',
        url: 'https://static.klipy.com/ii/8GCrVAB7.gif',
        pageUrl: 'https://klipy.com/gifs/hello-hi-662',
        title: 'Hello',
        username: null,
        width: 498,
        height: 498,
        previewUrl: 'https://static.klipy.com/ii/y6iepZM7.gif',
    });

    assert.deepEqual(gifFormFields(gif), {
        gif_provider: 'klipy',
        gif_id: 'hello-hi-662',
        gif_url: 'https://static.klipy.com/ii/8GCrVAB7.gif',
        gif_page_url: 'https://klipy.com/gifs/hello-hi-662',
        gif_title: 'Hello',
        gif_username: '',
        gif_width: 498,
        gif_height: 498,
    });
});
```

Update `tests/Unit/GifStorage.test.ts`: replace the `GiphyAttachment` import with `GifAttachment` from `types.ts`; fixture gains `provider: 'giphy'` and `previewUrl`; add a rejection case for an unknown provider (`provider: 'nope'` must read as null). Delete `tests/Unit/Giphy.test.ts` (`git rm`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test:unit`
Expected: FAIL — `lib/gif-providers/*` does not exist.

- [ ] **Step 3: Implement the provider modules**

Create `resources/js/lib/gif-providers/types.ts`:

```ts
export type GifProviderId = 'giphy' | 'klipy';

export type GifResult = {
    id: string;
    url: string;
    pageUrl: string;
    title: string | null;
    username: string | null;
    width: number;
    height: number;
    previewUrl: string | null;
};

export type GifAttachment = GifResult & { provider: GifProviderId };

export type GifSearchPage = {
    results: GifResult[];
    nextCursor: string | null;
};

export type GifKeyValidation =
    | 'valid'
    | 'invalid'
    | 'rate-limited'
    | 'unreachable';

export class GifRateLimited extends Error {
    constructor() {
        super('The GIF provider is rate limiting searches.');
    }
}

export interface GifProvider {
    readonly id: GifProviderId;
    readonly label: string;
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

Create `resources/js/lib/gif-providers/giphy.ts`:

```ts
import type {
    GifKeyValidation,
    GifProvider,
    GifResult,
    GifSearchPage,
} from './types.ts';
import { GifRateLimited } from './types.ts';

type GiphyRendition = { url: string; width: string; height: string };

type GiphyItem = {
    id: string;
    title: string;
    username: string;
    url: string;
    images: Partial<
        Record<
            'downsized_medium' | 'downsized' | 'original' | 'fixed_height_small',
            GiphyRendition
        >
    >;
};

const pageSize = 24;
const baseUrl = 'https://api.giphy.com/v1/gifs';

const params = (key: string, offset: string | null): URLSearchParams =>
    new URLSearchParams({
        api_key: key,
        limit: String(pageSize),
        offset: offset ?? '0',
        rating: 'g',
    });

const normalize = (item: GiphyItem): GifResult | null => {
    const stored =
        item.images.downsized_medium ??
        item.images.downsized ??
        item.images.original;

    if (stored === undefined) {
        return null;
    }

    const preview =
        item.images.fixed_height_small ??
        item.images.downsized ??
        item.images.downsized_medium ??
        item.images.original;

    return {
        id: item.id,
        url: stored.url,
        pageUrl: item.url,
        title: item.title === '' ? null : item.title,
        username: item.username === '' ? null : item.username,
        width: Number.parseInt(stored.width, 10),
        height: Number.parseInt(stored.height, 10),
        previewUrl: preview?.url ?? null,
    };
};

async function page(
    url: string,
    options: { cursor: string | null; signal?: AbortSignal },
): Promise<GifSearchPage> {
    const response = await fetch(url, { signal: options.signal });

    if (response.status === 429) {
        throw new GifRateLimited();
    }

    if (!response.ok) {
        throw new Error(`GIPHY request failed: ${response.status}`);
    }

    const data = (await response.json()) as { data: GiphyItem[] };
    const results = data.data
        .map(normalize)
        .filter((result): result is GifResult => result !== null);

    return {
        results,
        nextCursor:
            data.data.length < pageSize
                ? null
                : String(Number.parseInt(options.cursor ?? '0', 10) + pageSize),
    };
}

async function validateKey(key: string): Promise<GifKeyValidation> {
    const search = new URLSearchParams({
        api_key: key,
        limit: '1',
        offset: '0',
        rating: 'g',
    });

    let response: Response;

    try {
        response = await fetch(`${baseUrl}/trending?${search}`);
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

export const giphy: GifProvider = {
    id: 'giphy',
    label: 'GIPHY',
    searchPlaceholder: 'Search GIPHY',
    attribution: { label: 'Powered By GIPHY', href: 'https://giphy.com' },
    search: (key, query, options) => {
        const search = params(key, options.cursor);
        search.set('q', query);

        return page(`${baseUrl}/search?${search}`, options);
    },
    trending: (key, options) =>
        page(`${baseUrl}/trending?${params(key, options.cursor)}`, options),
    validateKey,
};
```

Create `resources/js/lib/gif-providers/klipy.ts`:

```ts
import type {
    GifKeyValidation,
    GifProvider,
    GifResult,
    GifSearchPage,
} from './types.ts';
import { GifRateLimited } from './types.ts';

type KlipyMedia = { url: string; dims: [number, number] };

type KlipyItem = {
    id: string;
    title?: string;
    content_description?: string;
    itemurl: string;
    media_formats?: { gif?: KlipyMedia; tinygif?: KlipyMedia };
};

type KlipyResponse = { results?: KlipyItem[]; next?: string };

const pageSize = 24;
const baseUrl = 'https://api.klipy.com/v2';

const params = (key: string, cursor: string | null): URLSearchParams => {
    const search = new URLSearchParams({
        key,
        limit: String(pageSize),
        contentfilter: 'high',
    });

    if (cursor !== null) {
        search.set('pos', cursor);
    }

    return search;
};

const normalize = (item: KlipyItem): GifResult | null => {
    const gif = item.media_formats?.gif;

    if (gif === undefined) {
        return null;
    }

    return {
        id: item.id,
        url: gif.url,
        pageUrl: item.itemurl,
        title: item.title || item.content_description || null,
        username: null,
        width: gif.dims[0],
        height: gif.dims[1],
        previewUrl: item.media_formats?.tinygif?.url ?? gif.url,
    };
};

async function page(
    url: string,
    options: { cursor: string | null; signal?: AbortSignal },
): Promise<GifSearchPage> {
    const response = await fetch(url, { signal: options.signal });

    if (response.status === 429) {
        throw new GifRateLimited();
    }

    if (!response.ok) {
        throw new Error(`KLIPY request failed: ${response.status}`);
    }

    const data = (await response.json()) as KlipyResponse;
    const results = (data.results ?? [])
        .map(normalize)
        .filter((result): result is GifResult => result !== null);

    return { results, nextCursor: data.next === '' ? null : (data.next ?? null) };
}

async function validateKey(key: string): Promise<GifKeyValidation> {
    const search = new URLSearchParams({ key, limit: '8', contentfilter: 'high' });

    let response: Response;

    try {
        response = await fetch(`${baseUrl}/featured?${search}`);
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

export const klipy: GifProvider = {
    id: 'klipy',
    label: 'KLIPY',
    searchPlaceholder: 'Search KLIPY',
    attribution: { label: 'Powered by KLIPY', href: 'https://klipy.com' },
    search: (key, query, options) => {
        const search = params(key, options.cursor);
        search.set('q', query);

        return page(`${baseUrl}/search?${search}`, options);
    },
    trending: (key, options) =>
        page(`${baseUrl}/featured?${params(key, options.cursor)}`, options),
    validateKey,
};
```

Create `resources/js/lib/gif-providers/index.ts`:

```ts
import { giphy } from './giphy.ts';
import { klipy } from './klipy.ts';
import type {
    GifAttachment,
    GifProvider,
    GifProviderId,
    GifResult,
} from './types.ts';

export * from './types.ts';

export const gifProviders: Record<GifProviderId, GifProvider> = {
    giphy,
    klipy,
};

export function gifProviderFor(id: GifProviderId): GifProvider {
    return gifProviders[id];
}

export function attachmentFromResult(
    id: GifProviderId,
    result: GifResult,
): GifAttachment {
    return { ...result, provider: id };
}

export function gifFormFields(
    gif: GifAttachment,
): Record<string, string | number> {
    return {
        gif_provider: gif.provider,
        gif_id: gif.id,
        gif_url: gif.url,
        gif_page_url: gif.pageUrl,
        gif_title: gif.title ?? '',
        gif_username: gif.username ?? '',
        gif_width: gif.width,
        gif_height: gif.height,
    };
}
```

`git rm resources/js/lib/giphy.ts`.

- [ ] **Step 4: Update storage and shared types**

`resources/js/lib/gif-storage.ts`: import `GifAttachment` from `./gif-providers/types.ts`; validation adds `(parsed.provider === 'giphy' || parsed.provider === 'klipy')`.

`resources/js/types/global.d.ts`: replace `giphy: { key: string } | null;` with:

```ts
            gif: { provider: 'giphy' | 'klipy'; key: string } | null;
```

`resources/js/types/commit.ts`: `CommitGif` gains `provider: 'giphy' | 'klipy';` as its first field.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run test:unit && bun run test:types`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add resources/js/lib/gif-providers resources/js/lib/gif-storage.ts resources/js/types/global.d.ts resources/js/types/commit.ts tests/Unit/GifProviders.test.ts tests/Unit/GifStorage.test.ts
git rm resources/js/lib/giphy.ts tests/Unit/Giphy.test.ts
git commit -m "feat: add the gif provider adapters and registry"
```

---

### Task 6: Provider-aware picker, composer wiring, and rendering

**Files:**
- Rename+rewrite: `resources/js/components/giphy-picker-dialog.tsx` → `gif-picker-dialog.tsx`
- Rename+rewrite: `resources/js/components/giphy-picker-button.tsx` → `gif-picker-button.tsx`
- Rename+rewrite: `resources/js/components/giphy-attachment-preview.tsx` → `gif-attachment-preview.tsx`
- Rename+rewrite: `resources/js/components/commit-giphy.tsx` → `commit-gif.tsx`
- Modify: `resources/js/components/commit-composer.tsx`, `commit-quote-button.tsx`, `commit-thread.tsx`, `resources/js/hooks/use-stash.ts`
- Test: rename `tests/Unit/CommitGiphy.test.tsx` → `CommitGif.test.tsx`, `tests/Unit/CommitGiphyRender.test.ts` → `CommitGifRender.test.ts`, `tests/commit-giphy.config.ts` → `tests/commit-gif.config.ts`; create `tests/Unit/GifPickerDialog.test.tsx`, `tests/gif-picker.config.ts`, `tests/Unit/GifPickerDialogRender.test.ts`; update `tests/Unit/ComposerDraft.test.tsx`, `tests/Unit/QuoteDraft.test.tsx`, `tests/Unit/DraftStash.test.tsx`, `tests/Unit/GifStorage.test.ts`, `tests/tsconfig.json`

**Interfaces:**
- Consumes: `gif` page prop `{provider, key}|null`, `lib/gif-providers/*`, `gifFormFields`, `GifAttachment`.
- Produces: `GifPickerButton`, `GifPickerDialog({ provider, apiKey, open, onOpenChange, onPick })`, `GifAttachmentPreview`, `CommitGif({ gif })`.

- [ ] **Step 1: Rename the component files and their imports**

```bash
git mv resources/js/components/giphy-picker-dialog.tsx resources/js/components/gif-picker-dialog.tsx
git mv resources/js/components/giphy-picker-button.tsx resources/js/components/gif-picker-button.tsx
git mv resources/js/components/giphy-attachment-preview.tsx resources/js/components/gif-attachment-preview.tsx
git mv resources/js/components/commit-giphy.tsx resources/js/components/commit-gif.tsx
```

Update every import in `commit-composer.tsx`, `commit-quote-button.tsx`, `commit-thread.tsx`, `gif-picker-button.tsx` accordingly.

- [ ] **Step 2: Write the failing picker component test**

Create `tests/gif-picker.config.ts`:

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
        include: ['tests/Unit/GifPickerDialog.test.tsx'],
    },
});
```

Create `tests/Unit/GifPickerDialog.test.tsx`:

```tsx
/// <reference types="node" />
import assert from 'node:assert/strict';
import * as React from 'react';
import type { ReactElement, ReactNode } from 'react';
import { beforeEach, test, vi } from 'vite-plus/test';
import type { GifProvider } from '../../resources/js/lib/gif-providers/types';

let state: unknown[] = [];
let cursor = 0;

vi.doMock('react', () => ({
    ...React,
    useEffect: (effect: () => void) => effect(),
    useMemo: (factory: () => unknown) => factory(),
    useId: () => `preview-${cursor++}`,
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
        snapshot(),
    useRef: (initial: unknown) => ({ current: initial }),
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

vi.doMock('@inertiajs/react', async () => ({
    ...(await vi.importActual('@inertiajs/react')),
}));

const provider: GifProvider = {
    id: 'klipy',
    label: 'KLIPY',
    searchPlaceholder: 'Search KLIPY',
    attribution: { label: 'Powered by KLIPY', href: 'https://klipy.com' },
    search: vi.fn(async () => ({
        results: [
            {
                id: 'one',
                url: 'https://static.klipy.com/ii/one.gif',
                pageUrl: 'https://klipy.com/gifs/one',
                title: 'One',
                username: null,
                width: 100,
                height: 100,
                previewUrl: 'https://static.klipy.com/ii/one-preview.gif',
            },
        ],
        nextCursor: null,
    })),
    trending: vi.fn(async () => ({ results: [], nextCursor: null })),
    validateKey: vi.fn(async () => 'valid' as const),
};

const { GifPickerDialog } = await import(
    '../../resources/js/components/gif-picker-dialog'
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

function render(open = true): Element[] {
    cursor = 0;

    return elements(
        GifPickerDialog({ provider, apiKey: 'k', open, onOpenChange: vi.fn(), onPick: vi.fn() }),
    );
}

function field(fields: Element[], testId: string): Element {
    const found = fields.find(
        (element) => element.props['data-test'] === testId,
    );

    assert.ok(found, `no element with data-test="${testId}"`);

    return found;
}

beforeEach(() => {
    state = [];
    cursor = 0;
    vi.clearAllMocks();
});

test('uses the provider placeholder and attribution', () => {
    const fields = render();

    assert.equal(field(fields, 'gif-search-input').props.placeholder, 'Search KLIPY');
    assert.ok(
        fields.some(
            (element) =>
                element.props.children === 'Powered by KLIPY' ||
                element.props.href === 'https://klipy.com',
        ),
    );
});

test('searches through the injected provider', async () => {
    render();
    await vi.waitFor(() => {
        assert.equal((provider.trending as ReturnType<typeof vi.fn>).mock.calls.length, 1);
    });
    assert.equal(provider.search.mock.calls.length, 0);
});
```

Create `tests/Unit/GifPickerDialogRender.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

await test('renders the gif picker for an injected provider', () => {
    const cli = fileURLToPath(
        new URL('./bin/vp', import.meta.resolve('vite-plus/package.json')),
    );

    execFileSync(
        process.execPath,
        [cli, 'test', 'run', '--config', 'tests/gif-picker.config.ts'],
        {
            cwd: fileURLToPath(new URL('../..', import.meta.url)),
            stdio: 'inherit',
        },
    );
});
```

- [ ] **Step 3: Run the picker test to verify it fails**

Run: `bun run test:unit`
Expected: FAIL — `GifPickerDialog` does not exist.

- [ ] **Step 4: Implement the components**

Replace `resources/js/components/gif-picker-dialog.tsx` with:

```tsx
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { attachmentFromResult } from '@/lib/gif-providers';
import type {
    GifAttachment,
    GifProvider,
    GifResult,
} from '@/lib/gif-providers';
import { GifRateLimited } from '@/lib/gif-providers';

type Status = 'loading' | 'ready' | 'error' | 'rate-limited';

export function GifPickerDialog({
    provider,
    apiKey,
    open,
    onOpenChange,
    onPick,
}: {
    provider: GifProvider;
    apiKey: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onPick: (gif: GifAttachment) => void;
}) {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<GifResult[]>([]);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [status, setStatus] = useState<Status>('loading');
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [reloads, setReloads] = useState(0);

    useEffect(() => {
        if (!open) {
            return;
        }

        const controller = new AbortController();
        const timeout = setTimeout(
            () => {
                setStatus('loading');
                const trimmed = query.trim();
                const request =
                    trimmed === ''
                        ? provider.trending(apiKey, {
                              cursor: null,
                              signal: controller.signal,
                          })
                        : provider.search(apiKey, trimmed, {
                              cursor: null,
                              signal: controller.signal,
                          });

                request
                    .then((page) => {
                        setResults(page.results);
                        setNextCursor(page.nextCursor);
                        setStatus('ready');
                    })
                    .catch((error: unknown) => {
                        if (controller.signal.aborted) {
                            return;
                        }

                        setStatus(
                            error instanceof GifRateLimited
                                ? 'rate-limited'
                                : 'error',
                        );
                    });
            },
            query === '' ? 0 : 300,
        );

        return () => {
            clearTimeout(timeout);
            controller.abort();
        };
    }, [open, query, apiKey, reloads, provider]);

    const loadMore = () => {
        setIsLoadingMore(true);
        const trimmed = query.trim();
        const request =
            trimmed === ''
                ? provider.trending(apiKey, { cursor: nextCursor })
                : provider.search(apiKey, trimmed, { cursor: nextCursor });

        request
            .then((page) => {
                setResults((current) => [...current, ...page.results]);
                setNextCursor(page.nextCursor);
            })
            .catch(() => undefined)
            .finally(() => setIsLoadingMore(false));
    };

    const pick = (result: GifResult) => {
        onPick(attachmentFromResult(provider.id, result));
        onOpenChange(false);
        setQuery('');
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>Attach a GIF</DialogTitle>
                    <DialogDescription className="sr-only">
                        Search {provider.label} and pick a GIF to attach.
                    </DialogDescription>
                </DialogHeader>
                <input
                    autoFocus
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={provider.searchPlaceholder}
                    aria-label={provider.searchPlaceholder}
                    autoComplete="off"
                    spellCheck={false}
                    className="h-9 w-full min-w-0 rounded-md border bg-card px-3 text-base outline-none placeholder:text-muted-foreground focus-visible:border-primary md:text-sm"
                    data-test="gif-search-input"
                />
                {status === 'loading' && (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                        Loading…
                    </p>
                )}
                {status === 'rate-limited' && (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                        You’ve hit your {provider.label} key’s search rate limit.
                        Try again shortly.
                    </p>
                )}
                {status === 'error' && (
                    <div className="py-8 text-center">
                        <p className="text-sm text-muted-foreground">
                            {provider.label} did not answer.
                        </p>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            className="mt-2"
                            onClick={() => setReloads((count) => count + 1)}
                        >
                            Retry
                        </Button>
                    </div>
                )}
                {status === 'ready' && results.length === 0 && (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                        No GIFs matched. /dev/null remains empty.
                    </p>
                )}
                {status === 'ready' && results.length > 0 && (
                    <>
                        <ul className="grid grid-cols-3 gap-1" data-test="gif-results">
                            {results.map((result) =>
                                result.previewUrl === null ? null : (
                                    <li key={result.id}>
                                        <button
                                            type="button"
                                            onClick={() => pick(result)}
                                            className="block w-full overflow-hidden rounded-md border focus-visible:ring-2 focus-visible:ring-ring"
                                            aria-label={
                                                result.title === null
                                                    ? 'Attach GIF'
                                                    : `Attach: ${result.title}`
                                            }
                                        >
                                            <img
                                                src={result.previewUrl}
                                                alt={result.title ?? 'GIF'}
                                                loading="lazy"
                                                referrerPolicy="no-referrer"
                                                className="h-24 w-full bg-muted object-cover"
                                            />
                                        </button>
                                    </li>
                                ),
                            )}
                        </ul>
                        {nextCursor !== null && (
                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                disabled={isLoadingMore}
                                onClick={loadMore}
                                className="mx-auto"
                            >
                                {isLoadingMore ? 'Loading…' : 'Load more'}
                            </Button>
                        )}
                    </>
                )}
                <div className="flex justify-center border-t pt-3">
                    <a
                        href={provider.attribution.href}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        <span className="font-mono text-[11px] font-bold tracking-wide text-muted-foreground">
                            {provider.attribution.label}
                        </span>
                    </a>
                </div>
            </DialogContent>
        </Dialog>
    );
}
```

Replace `resources/js/components/gif-picker-button.tsx` with:

```tsx
import { usePage } from '@inertiajs/react';
import { ImagePlay } from 'lucide-react';
import { useState } from 'react';
import { GifPickerDialog } from '@/components/gif-picker-dialog';
import { Button } from '@/components/ui/button';
import { gifProviderFor } from '@/lib/gif-providers';
import type { GifAttachment } from '@/lib/gif-providers';
import { cn } from '@/lib/utils';

/** Invisible until the signed-in user connects a GIF provider in settings. */
export function GifPickerButton({
    disabled,
    hasGif,
    onPick,
    className,
}: {
    disabled?: boolean;
    hasGif: boolean;
    onPick: (gif: GifAttachment) => void;
    className?: string;
}) {
    const { gif } = usePage().props;
    const [open, setOpen] = useState(false);

    if (gif === null) {
        return null;
    }

    return (
        <>
            <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled || hasGif}
                onClick={() => setOpen(true)}
                aria-label="Attach a GIF"
                title={hasGif ? 'One GIF per commit' : 'Attach a GIF'}
                className={cn('text-muted-foreground', className)}
                data-test="attach-gif-button"
            >
                <ImagePlay className="size-5" />
            </Button>
            <GifPickerDialog
                provider={gifProviderFor(gif.provider)}
                apiKey={gif.key}
                open={open}
                onOpenChange={setOpen}
                onPick={onPick}
            />
        </>
    );
}
```

`gif-attachment-preview.tsx`: rename the component, type, and data-test only:

```tsx
import { X } from 'lucide-react';
import type { GifAttachment } from '@/lib/gif-providers';

export function GifAttachmentPreview({
    gif,
    onRemove,
}: {
    gif: GifAttachment | null;
    onRemove: () => void;
}) {
    if (gif === null) {
        return null;
    }

    return (
        <div className="mt-2">
            <div
                className="relative inline-block"
                data-test="gif-attachment-preview"
            >
                <img
                    src={gif.url}
                    alt={gif.title ?? 'Attached GIF'}
                    referrerPolicy="no-referrer"
                    className="h-20 max-w-48 rounded-md border bg-muted object-cover"
                />
                <button
                    type="button"
                    onClick={onRemove}
                    aria-label="Remove GIF"
                    className="absolute top-1 right-1 rounded-full bg-background/80 p-0.5 text-foreground backdrop-blur transition hover:bg-background"
                >
                    <X className="size-3.5" />
                </button>
                <span className="absolute bottom-1 left-1 rounded bg-background/80 px-1 text-[11px] leading-4 font-bold tracking-wide text-foreground backdrop-blur">
                    GIF
                </span>
            </div>
        </div>
    );
}
```

Replace `resources/js/components/commit-gif.tsx` attribution:

```tsx
const provider = gifProviders[gif.provider];
const credit =
    gif.username !== null
        ? `GIF by @${gif.username} on ${provider.label}`
        : `via ${provider.label}`;
```

and use `credit` inside the attribution link (body otherwise unchanged except `data-test="commit-gif"`).

- [ ] **Step 5: Update the composer, quote, thread, and stash**

Apply these replacements in `commit-composer.tsx`, `commit-quote-button.tsx`, `commit-thread.tsx`:

- imports: `GiphyAttachmentPreview` → `GifAttachmentPreview` (path `gif-attachment-preview`); `GiphyPickerButton` → `GifPickerButton`; `CommitGiphy` → `CommitGif` (path `commit-gif`); `giphyFormFields` → `gifFormFields` from `@/lib/gif-providers`; `GiphyAttachment` → `GifAttachment` from `@/lib/gif-providers`.
- JSX component names updated accordingly (`<GifPickerButton ...>`, `<GifAttachmentPreview ...>`, `<CommitGif ...>`).
- `commit-thread.tsx`: replace the inline gif field type block (`giphy_id?`, …, `giphy_height?`) with `gif_provider?: 'giphy' | 'klipy';` plus `gif_id?`, `gif_url?`, `gif_page_url?`, `gif_title?`, `gif_username?`, `gif_width?`, `gif_height?`.
- `use-stash.ts`: import `GifAttachment` from `@/lib/gif-providers/types` (type-only); replace `GiphyAttachment` references with `GifAttachment` (the `updateGif` API name stays).

- [ ] **Step 6: Update the tests and configs**

- `git mv tests/Unit/CommitGiphy.test.tsx tests/Unit/CommitGif.test.tsx`; `git mv tests/Unit/CommitGiphyRender.test.ts tests/Unit/CommitGifRender.test.ts`; `git mv tests/commit-giphy.config.ts tests/commit-gif.config.ts`.
- In `CommitGif.test.tsx`: rename imports/component (`CommitGif` from `commit-gif`); fixture `CommitGif` gains `provider: 'giphy'`; add two attribution cases:

```tsx
test('credits klipy without a giphy-style username', () => {
    const { attribution } = renderedGif({ provider: 'klipy', username: null });

    assert.equal(attribution.props.children, 'via KLIPY');
});
```

(Adjust `renderedGif` so the fixture type carries `provider`.)
- `CommitGifRender.test.ts`: config path becomes `tests/commit-gif.config.ts`; update the config include to `tests/Unit/CommitGif.test.tsx`.
- `ComposerDraft.test.tsx` / `QuoteDraft.test.tsx` / `DraftStash.test.tsx`: replace `GiphyAttachment` with `GifAttachment` (+ `provider: 'giphy'` in fixtures) and every expected form field `giphy_*` with `gif_*`, including `gif_provider: 'giphy'`.
- `tests/tsconfig.json`: replace `Unit/CommitGiphy.test.tsx` with `Unit/CommitGif.test.tsx`; replace `commit-giphy.config.ts` with `commit-gif.config.ts`; add `Unit/GifPickerDialog.test.tsx` and `gif-picker.config.ts`.
- Add `'tests/Unit/GifPickerDialog.test.tsx'` to `tests/draft-images.config.ts`? No — the new picker test belongs to `tests/gif-picker.config.ts` only (wrapper runs it from `test:unit`).

- [ ] **Step 7: Run the tests**

Run: `bun run test:unit && bun run test:types && bun run test:lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add resources/js/components resources/js/hooks/use-stash.ts resources/js/lib/gif-providers tests/Unit tests/commit-gif.config.ts tests/gif-picker.config.ts tests/tsconfig.json
git commit -m "feat: run the gif picker through the provider interface"
```

---

### Task 7: The "GIFs" settings section

**Files:**
- Rename+rewrite: `resources/js/components/giphy-key-setting.tsx` → `gif-key-setting.tsx`
- Modify: `resources/js/pages/user-profile/edit.tsx`, `README.md`
- Test: rename `tests/Unit/GiphyKeySetting.test.tsx` → `tests/Unit/GifKeySetting.test.tsx`, `tests/Unit/GiphyKeySettingRender.test.ts` → `tests/Unit/GifKeySettingRender.test.ts`, `tests/giphy-key.config.ts` → `tests/gif-key.config.ts`; update `tests/tsconfig.json`

**Interfaces:**
- Consumes: generated `GifKeyController` actions (`update.url()`, `destroy.url()` → `/settings/gif`), `gifProviders`/`gifProviderFor`, page props `gifConnected: boolean`, `gifProvider: 'giphy' | 'klipy' | null`.
- Produces: `GifKeySetting({ gifConnected, gifProvider })` rendered on the profile page as section "GIFs".

- [ ] **Step 1: Rename the test and write the failing expectations**

```bash
git mv resources/js/components/giphy-key-setting.tsx resources/js/components/gif-key-setting.tsx
git mv tests/Unit/GiphyKeySetting.test.tsx tests/Unit/GifKeySetting.test.tsx
git mv tests/Unit/GiphyKeySettingRender.test.ts tests/Unit/GifKeySettingRender.test.ts
git mv tests/giphy-key.config.ts tests/gif-key.config.ts
```

In `tests/gif-key.config.ts` include `tests/Unit/GifKeySetting.test.tsx`. In `GifKeySettingRender.test.ts` use `--config tests/gif-key.config.ts` and the new test name.

Update `GifKeySetting.test.tsx`:
- Mock `@inertiajs/react` router as before; the component is invoked with `{ gifConnected: false, gifProvider: null }` or `{ gifConnected: true, gifProvider: 'giphy' }`.
- The connect flow sends `{ provider: 'giphy', key: 'key-123' }`; after selecting KLIPY (click the provider button with `data-test="provider-klipy"`) the flow sends `{ provider: 'klipy', key: 'key-123' }`.
- The validation error copy becomes provider-agnostic: `'That key was rejected by KLIPY.'` when KLIPY is selected, `'That key was rejected by GIPHY.'` for GIPHY; unreachable similarly.
- Add:

```tsx
test('replaces the connected provider when another is chosen', async () => {
    stubFetch(200);

    let fields = render({ gifConnected: true, gifProvider: 'giphy' });
    (field(fields, 'change-provider-button').props.onClick as () => void)();

    fields = render({ gifConnected: true, gifProvider: 'giphy' });
    (field(fields, 'provider-klipy').props.onClick as () => void)();

    fields = render({ gifConnected: true, gifProvider: 'giphy' });
    field(fields, 'gif-key-input').props.onChange({ target: { value: 'klipy-key' } });

    fields = render({ gifConnected: true, gifProvider: 'giphy' });
    await (field(fields, 'gif-connect-button').props.onClick as () => Promise<void>)();

    assert.deepEqual(put.mock.calls[0]?.[1], { provider: 'klipy', key: 'klipy-key' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test:unit`
Expected: FAIL — `GifKeySetting` does not exist.

- [ ] **Step 3: Implement the settings component**

Replace `resources/js/components/gif-key-setting.tsx` with:

```tsx
import { router } from '@inertiajs/react';
import { useState } from 'react';
import {
    destroy,
    update,
} from '@/actions/App/Http/Controllers/GifKeyController';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { gifProviderFor, gifProviders } from '@/lib/gif-providers';
import type { GifProviderId } from '@/lib/gif-providers';

const helpHref: Record<GifProviderId, string> = {
    giphy: 'https://developers.giphy.com',
    klipy: 'https://partner.klipy.com',
};

export function GifKeySetting({
    gifConnected,
    gifProvider,
}: {
    gifConnected: boolean;
    gifProvider: GifProviderId | null;
}) {
    const [providerId, setProviderId] = useState<GifProviderId>(
        gifProvider ?? 'giphy',
    );
    const [key, setKey] = useState('');
    const [editing, setEditing] = useState(!gifConnected);
    const [processing, setProcessing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const provider = gifProviderFor(providerId);

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

        const verdict = await provider.validateKey(candidate);

        if (verdict === 'invalid') {
            setError(`That key was rejected by ${provider.label}.`);
            setProcessing(false);

            return;
        }

        if (verdict === 'unreachable') {
            setError(`Couldn't reach ${provider.label} to verify the key.`);
            setProcessing(false);

            return;
        }

        router.put(
            update.url(),
            { provider: providerId, key: candidate },
            {
                preserveScroll: true,
                onFinish: () => setProcessing(false),
                onError: (errors) =>
                    setError(
                        errors.key ??
                            errors.provider ??
                            'Could not save the key.',
                    ),
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
            onError: () => setError('Could not remove the provider.'),
        });
    };

    return (
        <section className="px-4 py-6 sm:px-6">
            <h2 id="gif-key-label" className="text-base font-semibold">
                GIFs
            </h2>
            <p id="gif-key-description" className="mt-2 text-sm text-muted-foreground">
                GIF search runs on your own {provider.label} API key, under your
                own quota. Get a key at{' '}
                <a
                    href={helpHref[providerId]}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-4"
                >
                    {provider.label}
                </a>
                , connect it here, and every composer gains a GIF picker. One
                provider at a time; without a key the picker stays hidden.
            </p>
            {gifConnected && !editing ? (
                <div className="mt-4 flex flex-wrap items-center gap-3">
                    <p className="text-sm" data-test="gif-connected">
                        Connected to {gifProviderFor(gifProvider ?? 'giphy').label}.
                    </p>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={processing}
                        onClick={() => setEditing(true)}
                        data-test="change-provider-button"
                    >
                        Change provider
                    </Button>
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={processing}
                        onClick={remove}
                        data-test="gif-remove-button"
                    >
                        {processing ? <Spinner /> : null}
                        Remove
                    </Button>
                </div>
            ) : (
                <div className="mt-4 max-w-md space-y-3">
                    <div
                        role="group"
                        aria-label="GIF provider"
                        className="flex gap-2"
                    >
                        {Object.values(gifProviders).map((candidate) => (
                            <Button
                                key={candidate.id}
                                type="button"
                                size="sm"
                                variant={
                                    candidate.id === providerId
                                        ? 'default'
                                        : 'outline'
                                }
                                onClick={() => setProviderId(candidate.id)}
                                data-test={`provider-${candidate.id}`}
                            >
                                {candidate.label}
                            </Button>
                        ))}
                    </div>
                    <Label htmlFor="gif-key-input">
                        {provider.label} API key
                    </Label>
                    <div className="flex gap-2">
                        <input
                            id="gif-key-input"
                            value={key}
                            onChange={(event) => setKey(event.target.value)}
                            placeholder={`Paste your ${provider.label} API key`}
                            autoComplete="off"
                            spellCheck={false}
                            className="h-9 min-w-0 flex-1 rounded-md border bg-card px-3 text-base outline-none placeholder:text-muted-foreground focus-visible:border-primary md:text-sm"
                            data-test="gif-key-input"
                        />
                        <Button
                            type="button"
                            onClick={() => connect()}
                            disabled={processing || key.trim() === ''}
                            data-test="gif-connect-button"
                        >
                            {processing ? <Spinner /> : null}
                            {gifConnected ? 'Update' : 'Connect'}
                        </Button>
                    </div>
                </div>
            )}
            {error !== null && (
                <p
                    className="mt-3 text-sm text-destructive"
                    role="alert"
                    data-test="gif-key-error"
                >
                    {error}
                </p>
            )}
        </section>
    );
}
```

- [ ] **Step 4: Wire the profile page and README**

`resources/js/pages/user-profile/edit.tsx`: import `GifKeySetting`; page props gain `gifProvider: 'giphy' | 'klipy' | null`; render `<GifKeySetting gifConnected={gifConnected} gifProvider={gifProvider} />` after `<PasteisModeSetting />`.

`README.md` GIFs paragraph: replace the GIPHY-only text with:

```markdown
GIF search is bring-your-own-key: connect one provider — [GIPHY](https://developers.giphy.com) or [KLIPY](https://klipy.com) — under Settings → Profile → GIFs and paste its API key. Searches run on your key and quota, so no paid key is shared by the instance; without one the picker is hidden. The browser talks to the provider directly and commits store only the GIF's URLs and metadata — nothing is downloaded or rehosted. Connect one provider at a time; choosing another replaces it.
```

- [ ] **Step 5: Update the test configs**

- `tests/tsconfig.json`: replace `Unit/GiphyKeySetting.test.tsx` with `Unit/GifKeySetting.test.tsx`; replace `giphy-key.config.ts` with `gif-key.config.ts`.
- Delete remaining references to `giphy-key.config.ts` (e.g. any include lists).

- [ ] **Step 6: Run everything**

Run: `php artisan test tests/Feature/Controllers/UserProfileControllerTest.php && bun run test:unit && bun run test:types && bun run test:lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add resources/js/components/gif-key-setting.tsx resources/js/pages/user-profile/edit.tsx README.md tests/Unit/GifKeySetting.test.tsx tests/Unit/GifKeySettingRender.test.ts tests/gif-key.config.ts tests/tsconfig.json
git commit -m "feat: choose the gif provider in profile settings"
```

---

### Task 8: Sweep, regenerate, and full gates

**Files:**
- Modify: any file still using legacy `giphy*` naming (verify with the search below)
- Test: full suites

**Interfaces:**
- Consumes: everything above.
- Produces: a branch with no stale GIPHY-only naming beyond the provider adapter/labels, green gates.

- [ ] **Step 1: Sweep for leftovers**

Run:

```bash
rg -n "giphy|Giphy|GIPHY" app resources tests routes database README.md
```

Expected remaining matches only:
- `app/Enums/GifProvider.php` (GIPHY case/labels/hosts)
- `resources/js/lib/gif-providers/giphy.ts` (adapter)
- `resources/js/components/gif-key-setting.tsx` / `gif-picker-dialog.tsx` (labels/help copy come from adapters)
- test fixtures for the GIPHY adapter and provider labels.

Rename anything else (`GiphyUploader`, `giphyConnected`, `withGiphy`, `giphy-key.*` route names, etc.) to the gif equivalents.

- [ ] **Step 2: Regenerate generated routes and assets**

```bash
php artisan wayfinder:generate --with-form
bun run build
```

- [ ] **Step 3: Run the full gates**

```bash
composer test:lint
composer test:types
composer test:type-coverage
php -d memory_limit=-1 vendor/bin/pest --fresh
bun run test:unit
bun run test:types
bun run test:lint
```

Expected: all PASS. On machines without a PHP coverage driver, run the Pest suite without `--coverage` (CI enforces `--exactly=100.0`); note it in the PR.

- [ ] **Step 4: Commit residual fixes (only if any)**

```bash
git add -A
git commit -m "chore: sweep legacy giphy naming and satisfy the gates"
```

# Giphy GIF Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a commit (or reply, or quote) carry one Giphy GIF, picked in the composer via Giphy's client-side API and rendered by hotlinking Giphy's CDN — the server never calls Giphy.

**Architecture:** Seven nullable `giphy_*` columns on `commits`, exposed as one derived `gif` object; validation in the two commit form requests with a host-allowlist URL rule; the browser searches `api.giphy.com` directly with a key shared via Inertia; a Radix-dialog picker in all three composers; read surfaces (public API, OG tags, Atom feed, AI moderation) reference the Giphy URL directly.

**Tech Stack:** Laravel 13 (PHP 8.5, strict types), Inertia 3 + React 19 + TypeScript, Pest 5, node:test for frontend lib tests.

**Spec:** `docs/superpowers/specs/2026-10-16-giphy-picker-design.md` — read it before starting.

## Global Constraints

- PHP: `declare(strict_types=1);` in every file; classes `final`; actions `final readonly` with a single `handle()`; validation/authorization only in Form Requests (enforced by `tests/Unit/ArchTest.php`).
- Tests: Pest with **exactly 100.0% line coverage** and 100% type coverage; PHPStan at max level. Every new PHP branch needs a test.
- No real HTTP in tests: `Http::preventStrayRequests()` is global; frontend tests stub `fetch`.
- GIPHY ToS: media URLs are stored and rendered **verbatim** (query strings included); **no server-side Giphy request anywhere**; the picker displays "Powered By GIPHY"; all API calls send `rating=g`.
- One GIF per commit, never alongside uploaded images or a poll; GIFs cannot be scheduled (the scheduled-commit request simply doesn't accept the fields); the CLI commit path is untouched.
- Copy voice: dry, terminal-literate; a post is a "commit".
- House rule: `git add` new files immediately after creating them.
- No new routes or controllers → no `wayfinder:generate` run needed.
- Formatting: if Pint/oxfmt complain at the end, run `composer lint` and include the fixes in the final task's commit.

---

### Task 1: Migration, model serialization, factory state

**Files:**
- Create: `database/migrations/<timestamp>_add_giphy_to_commits_table.php` (via artisan)
- Modify: `app/Models/Commit.php` (docblock, `#[Hidden]`, `casts()`, `toArray()`, new `gif()`)
- Modify: `database/factories/CommitFactory.php`
- Test: `tests/Unit/Models/CommitTest.php` (create the file if it does not exist — check with `ls tests/Unit/Models/`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `Commit::gif(): ?array` returning `{id, url, page_url, title, username, width, height}`; `Commit::toArray()` emitting `gif` and never raw `giphy_*` keys; `CommitFactory::withGiphy(): self`. Fixture values (used verbatim by later tasks' tests): id `xT9IgzoKnwFNmISR8I`, url `https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy-downsized-medium.gif?cid=abc123`, page_url `https://giphy.com/gifs/deal-with-it-xT9IgzoKnwFNmISR8I`, title `Deal With It GIF`, username `giphy`, width `480`, height `270`.

- [ ] **Step 1: Write the failing model tests**

Append to `tests/Unit/Models/CommitTest.php` (if the file does not exist, create it with just the opening `<?php` + `declare(strict_types=1);` + `use App\Models\Commit;` and these tests):

```php
it('serializes an attached gif as one object and hides the raw columns', function (): void {
    $commit = Commit::factory()->withGiphy()->create();

    $payload = $commit->toArray();

    expect($payload['gif'])->toBe([
        'id' => 'xT9IgzoKnwFNmISR8I',
        'url' => 'https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy-downsized-medium.gif?cid=abc123',
        'page_url' => 'https://giphy.com/gifs/deal-with-it-xT9IgzoKnwFNmISR8I',
        'title' => 'Deal With It GIF',
        'username' => 'giphy',
        'width' => 480,
        'height' => 270,
    ])->and(array_keys($payload))->each->not->toStartWith('giphy_');
});

it('serializes the gif of a plain commit as null', function (): void {
    expect(Commit::factory()->create()->toArray()['gif'])->toBeNull();
});

it('leaves the gif out of a tombstone', function (): void {
    $commit = Commit::factory()->withGiphy()->create();
    $commit->delete();

    expect($commit->fresh()?->toArray())->not->toHaveKey('gif');
});
```

Note: if `expect(...)->each->not->toStartWith('giphy_')` is unsupported by the installed Pest, use `expect(collect($payload)->keys()->filter(fn (string $key): bool => str_starts_with($key, 'giphy_'))->all())->toBe([]);` instead.

- [ ] **Step 2: Run tests to verify they fail**

Run: `./vendor/bin/pest tests/Unit/Models/CommitTest.php --filter="gif"`
Expected: FAIL — `withGiphy` undefined / column `giphy_id` does not exist.

- [ ] **Step 3: Create the migration**

Run: `php artisan make:migration add_giphy_to_commits_table --table=commits`, then replace its content:

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
        Schema::table('commits', function (Blueprint $table): void {
            $table->string('giphy_id', 64)->nullable();
            $table->text('giphy_url')->nullable();
            $table->text('giphy_page_url')->nullable();
            $table->string('giphy_title', 300)->nullable();
            $table->string('giphy_username', 100)->nullable();
            $table->unsignedSmallInteger('giphy_width')->nullable();
            $table->unsignedSmallInteger('giphy_height')->nullable();
        });
    }
};
```

(Existing migrations in this repo have no `down()` — keep that.) `git add` the file.

- [ ] **Step 4: Extend the Commit model**

In `app/Models/Commit.php`:

a) Add to the class docblock, next to the other `@property-read` lines:

```php
 * @property-read string|null $giphy_id
 * @property-read string|null $giphy_url
 * @property-read string|null $giphy_page_url
 * @property-read string|null $giphy_title
 * @property-read string|null $giphy_username
 * @property-read int|null $giphy_width
 * @property-read int|null $giphy_height
```

b) Extend the `#[Hidden]` attribute (raw columns never serialize; the derived `gif` replaces them):

```php
#[Hidden([
    'ai_decision',
    'ai_categories',
    'embedding',
    'giphy_id',
    'giphy_url',
    'giphy_page_url',
    'giphy_title',
    'giphy_username',
    'giphy_width',
    'giphy_height',
])]
```

c) Add to `casts()`:

```php
            'giphy_id' => 'string',
            'giphy_url' => 'string',
            'giphy_page_url' => 'string',
            'giphy_title' => 'string',
            'giphy_username' => 'string',
            'giphy_width' => 'integer',
            'giphy_height' => 'integer',
```

d) Change the non-tombstone return of `toArray()` from

```php
        return [...parent::toArray(), ...resolve(CommitBodies::class)->segments($this->body)];
```

to

```php
        return [...parent::toArray(), 'gif' => $this->gif(), ...resolve(CommitBodies::class)->segments($this->body)];
```

e) Add the method (near `imagesAreVisibleTo()`):

```php
    /**
     * The attached GIPHY GIF, hotlinked by its media URL exactly as GIPHY's API returned it.
     *
     * @return array{id: string, url: string, page_url: string, title: string|null, username: string|null, width: int|null, height: int|null}|null
     */
    public function gif(): ?array
    {
        if ($this->giphy_id === null || $this->giphy_url === null || $this->giphy_page_url === null) {
            return null;
        }

        return [
            'id' => $this->giphy_id,
            'url' => $this->giphy_url,
            'page_url' => $this->giphy_page_url,
            'title' => $this->giphy_title,
            'username' => $this->giphy_username,
            'width' => $this->giphy_width,
            'height' => $this->giphy_height,
        ];
    }
```

- [ ] **Step 5: Add the factory state**

In `database/factories/CommitFactory.php`, after `rejected()`:

```php
    public function withGiphy(): self
    {
        return $this->state(fn (array $attributes): array => [
            'giphy_id' => 'xT9IgzoKnwFNmISR8I',
            'giphy_url' => 'https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy-downsized-medium.gif?cid=abc123',
            'giphy_page_url' => 'https://giphy.com/gifs/deal-with-it-xT9IgzoKnwFNmISR8I',
            'giphy_title' => 'Deal With It GIF',
            'giphy_username' => 'giphy',
            'giphy_width' => 480,
            'giphy_height' => 270,
        ]);
    }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `./vendor/bin/pest tests/Unit/Models/CommitTest.php --filter="gif"`
Expected: PASS (3 tests).

- [ ] **Step 7: Run the whole model + arch suite for regressions**

Run: `./vendor/bin/pest tests/Unit/Models tests/Unit/ArchTest.php`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add database/migrations app/Models/Commit.php database/factories/CommitFactory.php tests/Unit/Models/CommitTest.php
git commit -m "feat: store an attached giphy gif on commits"
```

---

### Task 2: DTO, URL rule, commit validation, action wiring

**Files:**
- Create: `app/Dto/Giphy.php`, `app/Rules/GiphyMediaUrl.php`
- Modify: `app/Http/Requests/CreateCommitRequest.php`, `app/Actions/CreateCommit.php`, `app/Http/Controllers/CommitController.php`
- Test: `tests/Feature/Controllers/CommitControllerTest.php`

**Interfaces:**
- Consumes: `CommitFactory::withGiphy()` fixture values (Task 1).
- Produces: `App\Dto\Giphy` (`new Giphy(string $id, string $url, string $pageUrl, ?string $title, ?string $username, int $width, int $height)`, `toColumns(): array<string, string|int|null>`); `CreateCommitRequest::giphy(): ?Giphy`; `CreateCommit::handle(..., ?Giphy $giphy = null)`; `App\Rules\GiphyMediaUrl`. Task 3 reuses the rule and DTO; Task 14's composers submit fields named `giphy_id`, `giphy_url`, `giphy_page_url`, `giphy_title`, `giphy_username`, `giphy_width`, `giphy_height`.

- [ ] **Step 1: Write the failing feature tests**

Append to `tests/Feature/Controllers/CommitControllerTest.php` (its imports already include `App\Models\User`; the tests below use only existing imports plus `route()`/`actingAs` helpers already used in the file):

```php
it('may attach a giphy gif to a commit', function (): void {
    $user = User::factory()->create();

    $response = $this->actingAs($user)->post(route('commit.store'), [
        'body' => 'Shipping it',
        'giphy_id' => 'xT9IgzoKnwFNmISR8I',
        'giphy_url' => 'https://media2.giphy.com/media/v1.Y2lkPTc5MGI3NjEx/giphy-downsized-medium.gif?cid=abc123&rid=giphy.gif',
        'giphy_page_url' => 'https://giphy.com/gifs/deal-with-it-xT9IgzoKnwFNmISR8I',
        'giphy_title' => 'Deal With It GIF',
        'giphy_username' => 'giphy',
        'giphy_width' => 480,
        'giphy_height' => 270,
    ]);

    $response->assertSessionHasNoErrors();

    $commit = $user->commits()->sole();
    expect($commit->giphy_id)->toBe('xT9IgzoKnwFNmISR8I')
        ->and($commit->giphy_url)->toBe('https://media2.giphy.com/media/v1.Y2lkPTc5MGI3NjEx/giphy-downsized-medium.gif?cid=abc123&rid=giphy.gif')
        ->and($commit->giphy_width)->toBe(480);
});

it('rejects a gif media url that is not on giphy', function (string $url): void {
    $user = User::factory()->create();

    $this->actingAs($user)->post(route('commit.store'), [
        'body' => 'Nice try',
        'giphy_id' => 'xT9IgzoKnwFNmISR8I',
        'giphy_url' => $url,
        'giphy_page_url' => 'https://giphy.com/gifs/deal-with-it-xT9IgzoKnwFNmISR8I',
        'giphy_width' => 480,
        'giphy_height' => 270,
    ])->assertSessionHasErrors('giphy_url');

    expect($user->commits()->count())->toBe(0);
})->with([
    'another host' => ['https://evil.example/media/xT9IgzoKnwFNmISR8I/giphy.gif'],
    'lookalike host' => ['https://media2.giphy.com.evil.example/media/x/giphy.gif'],
    'plain http' => ['http://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy.gif'],
    'not a gif rendition' => ['https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy.webp'],
    'outside the media path' => ['https://media2.giphy.com/avatars/giphy.gif'],
    'with a fragment' => ['https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy.gif#frag'],
    'with userinfo' => ['https://user@media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy.gif'],
    'with a port' => ['https://media2.giphy.com:8443/media/xT9IgzoKnwFNmISR8I/giphy.gif'],
]);

it('rejects a partial gif submission', function (): void {
    $user = User::factory()->create();

    $this->actingAs($user)->post(route('commit.store'), [
        'body' => 'Half a gif',
        'giphy_id' => 'xT9IgzoKnwFNmISR8I',
    ])->assertSessionHasErrors(['giphy_url', 'giphy_page_url', 'giphy_width', 'giphy_height']);
});

it('rejects a gif alongside uploaded images', function (): void {
    Storage::fake();

    $user = User::factory()->create();

    $this->actingAs($user)->post(route('commit.store'), [
        'body' => 'Both at once',
        'images' => [UploadedFile::fake()->image('cabin.jpg', 40, 30)],
        'giphy_id' => 'xT9IgzoKnwFNmISR8I',
        'giphy_url' => 'https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy.gif',
        'giphy_page_url' => 'https://giphy.com/gifs/deal-with-it-xT9IgzoKnwFNmISR8I',
        'giphy_width' => 480,
        'giphy_height' => 270,
    ])->assertSessionHasErrors('giphy_id');
});

it('rejects a gif alongside a poll', function (): void {
    $user = User::factory()->create();

    $this->actingAs($user)->post(route('commit.store'), [
        'body' => 'Gif or poll',
        'poll' => ['options' => ['Yes', 'No'], 'duration' => 1440],
        'giphy_id' => 'xT9IgzoKnwFNmISR8I',
        'giphy_url' => 'https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy.gif',
        'giphy_page_url' => 'https://giphy.com/gifs/deal-with-it-xT9IgzoKnwFNmISR8I',
        'giphy_width' => 480,
        'giphy_height' => 270,
    ])->assertSessionHasErrors('giphy_id');
});

it('may quote a commit with a gif attached', function (): void {
    $user = User::factory()->create();
    $quoted = Commit::factory()->create();

    $this->actingAs($user)->post(route('commit.store'), [
        'body' => 'Quoting with style',
        'quoted_commit_id' => $quoted->id,
        'giphy_id' => 'xT9IgzoKnwFNmISR8I',
        'giphy_url' => 'https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy.gif',
        'giphy_page_url' => 'https://giphy.com/gifs/deal-with-it-xT9IgzoKnwFNmISR8I',
        'giphy_width' => 480,
        'giphy_height' => 270,
    ])->assertSessionHasNoErrors();

    expect($user->commits()->sole()->quoted_commit_id)->toBe($quoted->id);
});

it('shows the gif in the commit payload', function (): void {
    $commit = Commit::factory()->withGiphy()->create();

    $this->actingAs($commit->user)
        ->get(route('commit.show', [$commit->user, $commit]))
        ->assertInertia(fn ($page) => $page
            ->where('commit.gif.id', 'xT9IgzoKnwFNmISR8I')
            ->where('commit.gif.url', 'https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy-downsized-medium.gif?cid=abc123')
            ->missing('commit.giphy_url'));
});
```

Adjust the poll `duration` value to a valid `PollDuration` case — check with `rg -n "case" app/Enums/PollDuration.php` and use the first case's value.

- [ ] **Step 2: Run tests to verify they fail**

Run: `./vendor/bin/pest tests/Feature/Controllers/CommitControllerTest.php --filter="gif"`
Expected: FAIL — unknown `giphy_*` columns persisted as null / no validation errors raised (fields unvalidated).

- [ ] **Step 3: Create the DTO**

`app/Dto/Giphy.php`:

```php
<?php

declare(strict_types=1);

namespace App\Dto;

/**
 * A GIF picked from GIPHY. URLs are kept exactly as GIPHY's API returned them, as its terms require.
 */
final readonly class Giphy
{
    public function __construct(
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
            'giphy_id' => $this->id,
            'giphy_url' => $this->url,
            'giphy_page_url' => $this->pageUrl,
            'giphy_title' => $this->title,
            'giphy_username' => $this->username,
            'giphy_width' => $this->width,
            'giphy_height' => $this->height,
        ];
    }
}
```

- [ ] **Step 4: Create the URL rule**

`app/Rules/GiphyMediaUrl.php`:

```php
<?php

declare(strict_types=1);

namespace App\Rules;

use Closure;
use Illuminate\Contracts\Validation\ValidationRule;

/**
 * GIPHY media URLs are stored and rendered verbatim, so only https URLs on GIPHY's media hosts pointing at a .gif
 * rendition are accepted. Query strings stay, as GIPHY's terms forbid stripping them; the path is not required to
 * carry the GIF id, since modern media URLs use opaque path tokens instead.
 */
final readonly class GiphyMediaUrl implements ValidationRule
{
    public function validate(string $attribute, mixed $value, Closure $fail): void
    {
        $parts = is_string($value) ? parse_url($value) : false;

        $isValid = is_array($parts)
            && ($parts['scheme'] ?? '') === 'https'
            && preg_match('/^media\d*\.giphy\.com$/', $parts['host'] ?? '') === 1
            && ! isset($parts['fragment'])
            && ! isset($parts['port'])
            && ! isset($parts['user'])
            && ! isset($parts['pass'])
            && preg_match('#^/media/[A-Za-z0-9._/-]+\.gif$#', $parts['path'] ?? '') === 1;

        if (! $isValid) {
            $fail(__('The GIF could not be attached.'));
        }
    }
}
```

`git add` both new files.

- [ ] **Step 5: Add validation rules and the `giphy()` helper to CreateCommitRequest**

In `app/Http/Requests/CreateCommitRequest.php`:

a) Add imports: `use App\Dto\Giphy;` and `use App\Rules\GiphyMediaUrl;`.

b) Add to the array returned by `rules()`, after the `image_descriptions.*` entry:

```php
            'giphy_id' => ['nullable', 'string', 'max:64', 'regex:/^[A-Za-z0-9]+$/', 'prohibits:images,poll', 'required_with:giphy_url'],
            'giphy_url' => ['nullable', 'string', 'max:2048', 'required_with:giphy_id', new GiphyMediaUrl],
            'giphy_page_url' => ['nullable', 'string', 'max:2048', 'required_with:giphy_id', 'url:https', 'regex:#^https://(www\.)?giphy\.com/#'],
            'giphy_title' => ['nullable', 'string', 'max:300'],
            'giphy_username' => ['nullable', 'string', 'max:100'],
            'giphy_width' => ['nullable', 'integer', 'min:1', 'max:10000', 'required_with:giphy_id'],
            'giphy_height' => ['nullable', 'integer', 'min:1', 'max:10000', 'required_with:giphy_id'],
```

c) Add the interpretation helper after `quotedCommit()`:

```php
    public function giphy(): ?Giphy
    {
        if (! $this->filled('giphy_id')) {
            return null;
        }

        return new Giphy(
            $this->string('giphy_id')->value(),
            $this->string('giphy_url')->value(),
            $this->string('giphy_page_url')->value(),
            $this->filled('giphy_title') ? $this->string('giphy_title')->value() : null,
            $this->filled('giphy_username') ? $this->string('giphy_username')->value() : null,
            $this->integer('giphy_width'),
            $this->integer('giphy_height'),
        );
    }
```

d) If PHPStan later complains about the `rules()` return type union, widen the method's `@return` docblock to include `GiphyMediaUrl` (mirror how `VisibleCommit` is accommodated — check the existing docblock union first).

- [ ] **Step 6: Thread the DTO through the action and controller**

a) `app/Actions/CreateCommit.php` — add `use App\Dto\Giphy;`, extend the signature:

```php
    public function handle(User $user, string $body, ?Commit $parent = null, ?Commit $quotedCommit = null, array $images = [], array $imageDescriptions = [], bool|string $linkPreview = true, ?NewPoll $poll = null, ?Giphy $giphy = null): Commit
```

add `$giphy` to the transaction closure's `use (...)` list, and extend the `$user->commits()->create([...])` array with:

```php
                ...$giphy?->toColumns() ?? [],
```

b) `app/Http/Controllers/CommitController.php` — in `store()`, add the named argument to the `$action->handle(...)` call:

```php
giphy: $request->giphy(),
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `./vendor/bin/pest tests/Feature/Controllers/CommitControllerTest.php --filter="gif"`
Expected: PASS.

- [ ] **Step 8: Run the full commit controller + arch suites**

Run: `./vendor/bin/pest tests/Feature/Controllers/CommitControllerTest.php tests/Unit/ArchTest.php`
Expected: PASS (no regressions; ArchTest accepts the new Rule/Dto).

- [ ] **Step 9: Commit**

```bash
git add app/Dto/Giphy.php app/Rules/GiphyMediaUrl.php app/Http/Requests/CreateCommitRequest.php app/Actions/CreateCommit.php app/Http/Controllers/CommitController.php tests/Feature/Controllers/CommitControllerTest.php
git commit -m "feat: accept a giphy gif on new commits and quotes"
```

---

### Task 3: Reply validation and wiring

**Files:**
- Modify: `app/Http/Requests/CreateCommitReplyRequest.php`, `app/Http/Controllers/CommitReplyController.php`
- Test: `tests/Feature/Controllers/CommitReplyControllerTest.php` (confirm the filename with `ls tests/Feature/Controllers/ | grep -i reply`)

**Interfaces:**
- Consumes: `App\Dto\Giphy`, `App\Rules\GiphyMediaUrl`, `CreateCommit::handle(..., giphy:)` (Task 2).
- Produces: replies accept the same seven `giphy_*` fields.

- [ ] **Step 1: Write the failing feature tests**

Append to the reply controller test file (replies are posted as JSON via `useHttp`, so mirror the file's existing posting style — check one existing image test there first with `rg -n "images" <file> | head -5` and copy its request helper, e.g. `postJson` vs `post`):

```php
it('may attach a giphy gif to a reply', function (): void {
    $user = User::factory()->create();
    $parent = Commit::factory()->create();

    $response = $this->actingAs($user)->post(route('commit-reply.store', $parent), [
        'body' => 'Replying with a gif',
        'giphy_id' => 'xT9IgzoKnwFNmISR8I',
        'giphy_url' => 'https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy.gif',
        'giphy_page_url' => 'https://giphy.com/gifs/deal-with-it-xT9IgzoKnwFNmISR8I',
        'giphy_width' => 480,
        'giphy_height' => 270,
    ]);

    $response->assertSessionHasNoErrors();

    expect($user->commits()->sole()->giphy_id)->toBe('xT9IgzoKnwFNmISR8I');
});

it('rejects a reply gif alongside uploaded images', function (): void {
    Storage::fake();

    $user = User::factory()->create();
    $parent = Commit::factory()->create();

    $this->actingAs($user)->post(route('commit-reply.store', $parent), [
        'body' => 'Both at once',
        'images' => [UploadedFile::fake()->image('cabin.jpg', 40, 30)],
        'giphy_id' => 'xT9IgzoKnwFNmISR8I',
        'giphy_url' => 'https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy.gif',
        'giphy_page_url' => 'https://giphy.com/gifs/deal-with-it-xT9IgzoKnwFNmISR8I',
        'giphy_width' => 480,
        'giphy_height' => 270,
    ])->assertSessionHasErrors('giphy_id');
});

it('rejects a bad gif media url on a reply', function (): void {
    $user = User::factory()->create();
    $parent = Commit::factory()->create();

    $this->actingAs($user)->post(route('commit-reply.store', $parent), [
        'body' => 'Nice try',
        'giphy_id' => 'xT9IgzoKnwFNmISR8I',
        'giphy_url' => 'https://evil.example/media/xT9IgzoKnwFNmISR8I/giphy.gif',
        'giphy_page_url' => 'https://giphy.com/gifs/deal-with-it-xT9IgzoKnwFNmISR8I',
        'giphy_width' => 480,
        'giphy_height' => 270,
    ])->assertSessionHasErrors('giphy_url');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./vendor/bin/pest tests/Feature/Controllers/CommitReplyControllerTest.php --filter="gif"`
Expected: FAIL.

- [ ] **Step 3: Add rules and helper to CreateCommitReplyRequest**

In `app/Http/Requests/CreateCommitReplyRequest.php`: add the same imports (`App\Dto\Giphy`, `App\Rules\GiphyMediaUrl`), the same seven rule entries as Task 2 Step 5b **except** `giphy_id` drops `poll` from `prohibits` (replies have no polls):

```php
            'giphy_id' => ['nullable', 'string', 'max:64', 'regex:/^[A-Za-z0-9]+$/', 'prohibits:images', 'required_with:giphy_url'],
```

and the identical `giphy(): ?Giphy` helper from Task 2 Step 5c.

- [ ] **Step 4: Wire the controller**

In `app/Http/Controllers/CommitReplyController.php`, add `giphy: $request->giphy(),` to the `CreateCommit` `handle()` call (find it with `rg -n "handle\(" app/Http/Controllers/CommitReplyController.php`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `./vendor/bin/pest tests/Feature/Controllers/CommitReplyControllerTest.php`
Expected: PASS, including pre-existing tests.

- [ ] **Step 6: Commit**

```bash
git add app/Http/Requests/CreateCommitReplyRequest.php app/Http/Controllers/CommitReplyController.php tests/Feature/Controllers/CommitReplyControllerTest.php
git commit -m "feat: accept a giphy gif on replies"
```

---

### Task 4: Config key and Inertia shared prop

**Files:**
- Modify: `config/services.php`, `app/Http/Middleware/HandleInertiaRequests.php`, `resources/js/types/global.d.ts`, `.env.example`
- Test: Create `tests/Feature/Middleware/HandleInertiaRequestsGiphyTest.php`

**Interfaces:**
- Consumes: nothing new.
- Produces: `config('services.giphy.key')`; Inertia shared prop `giphy: { key: string } | null`; TS `sharedPageProps.giphy`.

- [ ] **Step 1: Write the failing feature tests**

`tests/Feature/Middleware/HandleInertiaRequestsGiphyTest.php`:

```php
<?php

declare(strict_types=1);

use App\Enums\Log;
use App\Models\User;
use Inertia\Testing\AssertableInertia as Assert;

it('shares the giphy key when configured', function (): void {
    config(['services.giphy.key' => 'giphy-test']);

    $this->actingAs(User::factory()->create())
        ->get(route('log.show', Log::Following))
        ->assertInertia(fn (Assert $page): Assert => $page->where('giphy.key', 'giphy-test'));
});

it('shares no giphy config without a key', function (): void {
    config(['services.giphy.key' => null]);

    $this->actingAs(User::factory()->create())
        ->get(route('log.show', Log::Following))
        ->assertInertia(fn (Assert $page): Assert => $page->where('giphy', null));
});
```

`git add` the file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `./vendor/bin/pest tests/Feature/Middleware/HandleInertiaRequestsGiphyTest.php`
Expected: FAIL — `giphy` prop missing.

- [ ] **Step 3: Add the config and shared prop**

a) `config/services.php` — after the `'openai'` entry:

```php
    'giphy' => [
        'key' => env('GIPHY_KEY'),
    ],
```

b) `app/Http/Middleware/HandleInertiaRequests.php` — in the array returned by `share()`, after `'name' => config('app.name'),`:

```php
            'giphy' => filled(config('services.giphy.key')) ? ['key' => config()->string('services.giphy.key')] : null,
```

c) `resources/js/types/global.d.ts` — inside `sharedPageProps`, after `showsWhoToFollow: boolean;`:

```ts
            giphy: { key: string } | null;
```

d) `.env.example` — after the `OPENAI_API_KEY=` line:

```
# GIF picker (GIPHY). The key is shipped to the browser, as GIPHY requires client-side API calls,
# and the picker is hidden without one. Beta keys are heavily rate limited; production use needs
# an approved key with "Powered By GIPHY" attribution (https://developers.giphy.com).
GIPHY_KEY=
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./vendor/bin/pest tests/Feature/Middleware/HandleInertiaRequestsGiphyTest.php`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add config/services.php app/Http/Middleware/HandleInertiaRequests.php resources/js/types/global.d.ts .env.example tests/Feature/Middleware/HandleInertiaRequestsGiphyTest.php
git commit -m "feat: share the giphy key with the composer"
```

---

### Task 5: Moderation covers the GIF

**Files:**
- Modify: `app/Actions/UpdateCommitAiDecision.php`, `app/Services/OpenAI.php`
- Test: `tests/Unit/Jobs/ModerateCommitTest.php`

**Interfaces:**
- Consumes: `giphy_url` column (Task 1).
- Produces: nothing new — behavior change only. OpenAI's moderation and responses APIs accept remote https URLs in the same `image_url` fields as data URLs, so the Giphy URL is appended to the existing image array; OpenAI fetches it itself (our server never touches Giphy).

- [ ] **Step 1: Study the existing test harness**

Run: `rg -n "data:image|CommitImage::factory|new ModerateCommit" tests/Unit/Jobs/ModerateCommitTest.php | head -20` and read one existing image-moderation test to learn how the job is invoked and how `Http::fake` + `moderationResponse()`/`reviewResponses()` are set up in that file.

- [ ] **Step 2: Write the failing test**

Append to `tests/Unit/Jobs/ModerateCommitTest.php`, invoking the job exactly as the existing image test does (adapt the two marked lines to the file's established invocation):

```php
it('moderates an attached gif by its giphy url', function (): void {
    Http::fake([
        'api.openai.com/v1/moderations' => Http::response(moderationResponse()),
        'api.openai.com/v1/responses' => reviewResponses(),
    ]);

    $commit = Commit::factory()->pending()->withGiphy()->create();

    // Invoke the job the same way the existing image-moderation test in this file does:
    (new ModerateCommit($commit))->handle(resolve(App\Actions\UpdateCommitAiDecision::class));

    Http::assertSent(fn (Request $request): bool => str_contains($request->url(), 'moderations')
        && str_contains($request->body(), 'media2.giphy.com'));

    // The minors check runs because the commit has an image URL (the gif):
    Http::assertSent(fn (Request $request): bool => str_contains($request->url(), 'responses')
        && str_contains($request->body(), 'media2.giphy.com'));
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `./vendor/bin/pest tests/Unit/Jobs/ModerateCommitTest.php --filter="giphy"`
Expected: FAIL — no request body contains the Giphy host.

- [ ] **Step 4: Implement**

a) `app/Actions/UpdateCommitAiDecision.php` — replace the `$images` construction at the top of `handle()` with:

```php
        $images = array_values($commit->images->map(
            fn (CommitImage $image): string => 'data:image/webp;base64,'.base64_encode((string) Storage::get($image->path)),
        )->all());

        if ($commit->giphy_url !== null) {
            $images[] = $commit->giphy_url;
        }
```

(The existing `$images !== []` gate before `showsMinors()` now covers GIFs automatically.) Update the method docblock's first line to ", images and GIF included,".

b) `app/Services/OpenAI.php` — rename the `$imageDataUrls` parameter (and every local use) to `$imageUrls` in both `moderate()` and `showsMinors()`, and update their docblocks to say the entries are "data URLs or remote https URLs". No logic change.

- [ ] **Step 5: Run tests to verify they pass**

Run: `./vendor/bin/pest tests/Unit/Jobs/ModerateCommitTest.php`
Expected: PASS (new + existing).

- [ ] **Step 6: Commit**

```bash
git add app/Actions/UpdateCommitAiDecision.php app/Services/OpenAI.php tests/Unit/Jobs/ModerateCommitTest.php
git commit -m "feat: moderate attached gifs by their giphy url"
```

---

### Task 6: Public API exposes the GIF

**Files:**
- Modify: `app/Http/Resources/CommitResource.php`
- Test: locate with `rg -l "api/v1/commits" tests/Feature/` (expected: a file like `tests/Feature/Api/CommitControllerTest.php`)

**Interfaces:**
- Consumes: `Commit::gif()` (Task 1).
- Produces: `gif` field in `/api/v1` commit JSON.

- [ ] **Step 1: Write the failing test**

Append to the located API test file:

```php
it('includes the gif of a commit', function (): void {
    $commit = Commit::factory()->withGiphy()->create();

    $this->getJson("/api/v1/commits/{$commit->id}")
        ->assertOk()
        ->assertJsonPath('data.gif.id', 'xT9IgzoKnwFNmISR8I')
        ->assertJsonPath('data.gif.url', 'https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy-downsized-medium.gif?cid=abc123')
        ->assertJsonPath('data.gif.width', 480);
});

it('includes a null gif for a plain commit', function (): void {
    $commit = Commit::factory()->create();

    $this->getJson("/api/v1/commits/{$commit->id}")
        ->assertOk()
        ->assertJsonPath('data.gif', null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./vendor/bin/pest <located-file> --filter="gif"`
Expected: FAIL — `gif` key missing.

- [ ] **Step 3: Implement**

In `app/Http/Resources/CommitResource.php`, after `'images' => $this->images,`:

```php
            'gif' => $this->gif(),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./vendor/bin/pest <located-file>`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/Http/Resources/CommitResource.php tests/Feature/Api
git commit -m "feat: expose attached gifs in the public api"
```

---

### Task 7: OG metadata uses the GIF

**Files:**
- Modify: `app/Services/PageMetadata.php` (`commitImages()`, lines ~235–260)
- Test: locate with `rg -l "PageMetadata|og:image" tests/ | head -5` (expected: a Unit test for the service or the commit-show feature test asserting meta tags — follow whichever file already asserts `image/webp` commit images, found via `rg -ln "image/webp" tests/`)

**Interfaces:**
- Consumes: `giphy_url`, `giphy_width`, `giphy_height`, `giphy_title` columns (Task 1).
- Produces: an `image/gif` OG image entry for GIF commits.

- [ ] **Step 1: Write the failing test**

Mirror the located file's existing uploaded-image OG test (same setup and assertion style), with a GIF commit:

```php
it('uses the attached gif as an open graph image', function (): void {
    $commit = Commit::factory()->withGiphy()->create();

    // Mirror the existing commit-image OG test's invocation/assertions in this file. The assertions must cover:
    // - an image entry with url 'https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy-downsized-medium.gif?cid=abc123'
    // - type 'image/gif', width 480, height 270
    // - alt 'Deal With It GIF'
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./vendor/bin/pest <located-file> --filter="open graph image"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `app/Services/PageMetadata.php::commitImages()`, after the `foreach ($commit->images->values() ...)` loop and before `return $images;`:

```php
        if ($commit->giphy_url !== null) {
            $images[] = [
                'url' => $commit->giphy_url,
                'width' => (int) $commit->giphy_width,
                'height' => (int) $commit->giphy_height,
                'type' => 'image/gif',
                'alt' => $commit->giphy_title ?? "GIF attached to the commit of {$user->nameWithHandle()}",
            ];
        }
```

Note the method's early return requires `imagesAreVisibleTo(null)` — the GIF correctly inherits that guard. If the early return also requires `relationLoaded('images')` and the commit in your test has no loaded relation, call `$commit->load('images')` in the test (mirroring the neighboring tests).

- [ ] **Step 4: Run tests to verify they pass**

Run: `./vendor/bin/pest <located-file>`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/Services/PageMetadata.php tests/
git commit -m "feat: use the attached gif as the commit og image"
```

---

### Task 8: Atom feed enclosure

**Files:**
- Modify: `app/Actions/CreateUserFeed.php` (`entry()`)
- Test: locate with `rg -l "feed.atom|user-feed" tests/Feature/` (expected: the user feed controller test)

**Interfaces:**
- Consumes: `giphy_url` (Task 1); `CreateUserFeed::link()` private helper (exists).
- Produces: `image/gif` enclosure for GIF commits.

- [ ] **Step 1: Write the failing test**

Append to the located feed test file:

```php
it('lists an attached gif as an enclosure', function (): void {
    $user = User::factory()->create();
    Commit::factory()->for($user)->withGiphy()->create();

    $response = $this->get(route('user-feed.show', $user));

    $response->assertOk();
    expect($response->getContent())
        ->toContain('rel="enclosure"')
        ->toContain('type="image/gif"')
        ->toContain('https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy-downsized-medium.gif?cid=abc123');
});
```

If the feed is cached (README: five minutes), check how neighboring tests bust or avoid the cache and do the same. The enclosure URL lands XML-escaped (`&amp;` for `&`); if the `toContain` on the full URL fails for that reason, assert on `'giphy-downsized-medium.gif'` instead.

- [ ] **Step 2: Run the test to verify it fails**

Run: `./vendor/bin/pest <located-file> --filter="enclosure"`
Expected: FAIL — no `image/gif` enclosure.

- [ ] **Step 3: Implement**

In `app/Actions/CreateUserFeed.php::entry()`, after the images `foreach` loop:

```php
        if ($commit->giphy_url !== null) {
            $this->link($xml, 'enclosure', $commit->giphy_url, 'image/gif');
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./vendor/bin/pest <located-file>`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/Actions/CreateUserFeed.php tests/
git commit -m "feat: include attached gifs as atom enclosures"
```

---

### Task 9: Frontend Giphy library

**Files:**
- Create: `resources/js/lib/giphy.ts`
- Test: Create `tests/Unit/Giphy.test.ts` (node:test style, like `tests/Unit/SensitiveText.test.ts`)

**Interfaces:**
- Consumes: nothing.
- Produces (used by Tasks 10–13): types `GiphyAttachment = { id: string; url: string; page_url: string; title: string | null; username: string | null; width: number; height: number }` and `GiphyResult`; `giphySearchUrl(key, query, offset?)`, `giphyTrendingUrl(key, offset?)`, `fetchGifs(url, signal?)`, `previewUrlFor(result)`, `attachmentFromResult(result)`, `giphyFormFields(gif)`, class `GiphyRateLimited`.

- [ ] **Step 1: Write the failing tests**

`tests/Unit/Giphy.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    attachmentFromResult,
    giphyFormFields,
    giphySearchUrl,
    giphyTrendingUrl,
    previewUrlFor,
} from '../../resources/js/lib/giphy.ts';
import type { GiphyResult } from '../../resources/js/lib/giphy.ts';

const result: GiphyResult = {
    id: 'xT9IgzoKnwFNmISR8I',
    title: 'Deal With It GIF',
    username: 'giphy',
    url: 'https://giphy.com/gifs/deal-with-it-xT9IgzoKnwFNmISR8I',
    images: {
        fixed_height_small: {
            url: 'https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/100.gif?cid=abc',
            width: '178',
            height: '100',
        },
        downsized_medium: {
            url: 'https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy-downsized-medium.gif?cid=abc',
            width: '480',
            height: '270',
        },
        downsized: {
            url: 'https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy-downsized.gif?cid=abc',
            width: '400',
            height: '225',
        },
    },
};

await test('builds a search url with the g rating always on', () => {
    const url = new URL(giphySearchUrl('key-123', 'deal with it', 24));
    assert.equal(url.origin + url.pathname, 'https://api.giphy.com/v1/gifs/search');
    assert.equal(url.searchParams.get('api_key'), 'key-123');
    assert.equal(url.searchParams.get('q'), 'deal with it');
    assert.equal(url.searchParams.get('rating'), 'g');
    assert.equal(url.searchParams.get('offset'), '24');
});

await test('builds a trending url with the g rating always on', () => {
    const url = new URL(giphyTrendingUrl('key-123'));
    assert.equal(url.origin + url.pathname, 'https://api.giphy.com/v1/gifs/trending');
    assert.equal(url.searchParams.get('rating'), 'g');
    assert.equal(url.searchParams.get('offset'), '0');
});

await test('picks the downsized_medium gif rendition verbatim', () => {
    const gif = attachmentFromResult(result);
    assert.deepEqual(gif, {
        id: 'xT9IgzoKnwFNmISR8I',
        url: 'https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy-downsized-medium.gif?cid=abc',
        page_url: 'https://giphy.com/gifs/deal-with-it-xT9IgzoKnwFNmISR8I',
        title: 'Deal With It GIF',
        username: 'giphy',
        width: 480,
        height: 270,
    });
});

await test('falls back through downsized to original and bails without any', () => {
    const { downsized_medium: _dropped, ...rest } = result.images;
    const fallback = attachmentFromResult({ ...result, images: rest });
    assert.equal(
        fallback?.url,
        'https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy-downsized.gif?cid=abc',
    );
    assert.equal(attachmentFromResult({ ...result, images: {} }), null);
});

await test('turns empty title and username into null', () => {
    const gif = attachmentFromResult({ ...result, title: '', username: '' });
    assert.equal(gif?.title, null);
    assert.equal(gif?.username, null);
});

await test('uses the small fixed-height rendition for previews', () => {
    assert.equal(
        previewUrlFor(result),
        'https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/100.gif?cid=abc',
    );
    assert.equal(
        previewUrlFor({ ...result, images: { downsized: result.images.downsized } }),
        'https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy-downsized.gif?cid=abc',
    );
    assert.equal(previewUrlFor({ ...result, images: {} }), null);
});

await test('shapes the form fields the server expects', () => {
    const gif = attachmentFromResult(result);
    assert.ok(gif);
    assert.deepEqual(giphyFormFields(gif), {
        giphy_id: 'xT9IgzoKnwFNmISR8I',
        giphy_url: 'https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy-downsized-medium.gif?cid=abc',
        giphy_page_url: 'https://giphy.com/gifs/deal-with-it-xT9IgzoKnwFNmISR8I',
        giphy_title: 'Deal With It GIF',
        giphy_username: 'giphy',
        giphy_width: 480,
        giphy_height: 270,
    });
});
```

`git add` the file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types --test tests/Unit/Giphy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`resources/js/lib/giphy.ts`:

```ts
export type GiphyAttachment = {
    id: string;
    url: string;
    page_url: string;
    title: string | null;
    username: string | null;
    width: number;
    height: number;
};

type GiphyRendition = { url: string; width: string; height: string };

export type GiphyResult = {
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

export class GiphyRateLimited extends Error {
    constructor() {
        super('GIPHY is rate limiting searches.');
    }
}

export const pageSize = 24;

const baseUrl = 'https://api.giphy.com/v1/gifs';

const params = (key: string, offset: number): URLSearchParams =>
    new URLSearchParams({
        api_key: key,
        limit: String(pageSize),
        offset: String(offset),
        rating: 'g',
    });

export function giphySearchUrl(key: string, query: string, offset = 0): string {
    const search = params(key, offset);
    search.set('q', query);

    return `${baseUrl}/search?${search}`;
}

export function giphyTrendingUrl(key: string, offset = 0): string {
    return `${baseUrl}/trending?${params(key, offset)}`;
}

/**
 * GIPHY requires client-side API calls, so this runs in the browser with the shared key.
 */
export async function fetchGifs(
    url: string,
    signal?: AbortSignal,
): Promise<GiphyResult[]> {
    const response = await fetch(url, { signal });

    if (response.status === 429) {
        throw new GiphyRateLimited();
    }

    if (!response.ok) {
        throw new Error(`GIPHY request failed: ${response.status}`);
    }

    const data = (await response.json()) as { data: GiphyResult[] };

    return data.data;
}

/**
 * The small fixed-height rendition keeps the picker grid light; bigger renditions stand in when it is missing.
 */
export function previewUrlFor(result: GiphyResult): string | null {
    const rendition =
        result.images.fixed_height_small ??
        result.images.downsized ??
        result.images.downsized_medium ??
        result.images.original;

    return rendition?.url ?? null;
}

/**
 * The stored rendition is always a .gif around feed size, and its URL is kept verbatim as GIPHY's terms require.
 */
export function attachmentFromResult(
    result: GiphyResult,
): GiphyAttachment | null {
    const rendition =
        result.images.downsized_medium ??
        result.images.downsized ??
        result.images.original;

    if (rendition === undefined) {
        return null;
    }

    return {
        id: result.id,
        url: rendition.url,
        page_url: result.url,
        title: result.title === '' ? null : result.title,
        username: result.username === '' ? null : result.username,
        width: Number.parseInt(rendition.width, 10),
        height: Number.parseInt(rendition.height, 10),
    };
}

/**
 * The hidden fields every composer submits for an attached GIF, named exactly as the server validates them.
 */
export function giphyFormFields(
    gif: GiphyAttachment,
): Record<string, string | number> {
    return {
        giphy_id: gif.id,
        giphy_url: gif.url,
        giphy_page_url: gif.page_url,
        giphy_title: gif.title ?? '',
        giphy_username: gif.username ?? '',
        giphy_width: gif.width,
        giphy_height: gif.height,
    };
}
```

`git add` the file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-strip-types --test tests/Unit/Giphy.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add resources/js/lib/giphy.ts tests/Unit/Giphy.test.ts
git commit -m "feat: add the client-side giphy api module"
```

---

### Task 10: Commit rendering

**Files:**
- Modify: `resources/js/types/commit.ts` (add `CommitGif`, `gif` on `Commit`)
- Create: `resources/js/components/commit-giphy.tsx`
- Modify: `resources/js/components/commit-card.tsx` (one line, next to `CommitImages`)
- Test: Create `tests/Unit/CommitGiphy.test.tsx` (node:test style like `tests/Unit/CommitImages.test.tsx` — read that file first to copy its element-walking helpers)

**Interfaces:**
- Consumes: the server `gif` payload shape (Task 1).
- Produces: `CommitGif` type; `CommitGiphy({ gif })` component used by Task 13's preview-mode rendering.

- [ ] **Step 1: Add the type**

In `resources/js/types/commit.ts`, after the `CommitImage` type:

```ts
export type CommitGif = {
    id: string;
    url: string;
    page_url: string;
    title: string | null;
    username: string | null;
    width: number | null;
    height: number | null;
};
```

and on the `Commit` type, after `images?: CommitImage[];`:

```ts
    gif?: CommitGif | null;
```

Check whether `commit.ts` types are re-exported from `resources/js/types/index.ts` (`rg -n "CommitImage" resources/js/types/index.ts`) and mirror the export for `CommitGif` if so.

- [ ] **Step 2: Write the failing component test**

Read `tests/Unit/CommitImages.test.tsx` first and reuse its approach (components invoked as plain functions, assertions on the returned element tree). Create `tests/Unit/CommitGiphy.test.tsx` covering, with that file's helpers:

```tsx
// Using the same imports/helpers as tests/Unit/CommitImages.test.tsx, assert that CommitGiphy:
// 1. renders an <img> with src equal to the gif url verbatim (query string intact),
//    alt from the title, loading="lazy", and referrerPolicy="no-referrer";
// 2. falls back to alt 'Attached GIF' when title is null;
// 3. renders an <a> to gif.page_url reading 'GIF by @giphy on GIPHY' when username is set,
//    and 'via GIPHY' when username is null.

const gif = {
    id: 'xT9IgzoKnwFNmISR8I',
    url: 'https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy-downsized-medium.gif?cid=abc123',
    page_url: 'https://giphy.com/gifs/deal-with-it-xT9IgzoKnwFNmISR8I',
    title: 'Deal With It GIF',
    username: 'giphy',
    width: 480,
    height: 270,
};
```

Run: `node --experimental-strip-types --test tests/Unit/CommitGiphy.test.tsx`
Expected: FAIL — module not found. (If `.tsx` cannot run under `--experimental-strip-types` in this repo — check how `CommitImages.test.tsx` is executed by `rg -n "CommitImages" package.json tests/Unit/SeriesStash.test.ts tests/draft-images.config.ts` — register the new test exactly the way `CommitImages.test.tsx` is registered.)

- [ ] **Step 3: Implement the component**

`resources/js/components/commit-giphy.tsx`:

```tsx
import { cn } from '@/lib/utils';
import type { CommitGif } from '@/types/commit';

/**
 * An attached GIPHY GIF, hotlinked exactly as GIPHY's API returned it, with the attribution its terms require.
 */
export function CommitGiphy({
    gif,
    className,
}: {
    gif: CommitGif;
    className?: string;
}) {
    return (
        <figure
            className={cn(
                'relative mt-3 overflow-hidden rounded-lg border',
                className,
            )}
            data-test="commit-giphy"
        >
            <img
                src={gif.url}
                alt={gif.title ?? 'Attached GIF'}
                width={gif.width ?? undefined}
                height={gif.height ?? undefined}
                loading="lazy"
                referrerPolicy="no-referrer"
                onError={(event) => {
                    const image = event.currentTarget;
                    if (image.getAttribute('src') !== '/favicon.svg') {
                        image.src = '/favicon.svg';
                        image.classList.replace(
                            'object-cover',
                            'object-contain',
                        );
                    }
                }}
                className="max-h-[32rem] w-full bg-muted object-cover"
            />
            <a
                href={gif.page_url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => event.stopPropagation()}
                className="absolute right-1.5 bottom-1.5 rounded bg-background/80 px-1.5 py-0.5 text-[11px] font-medium text-foreground backdrop-blur transition hover:bg-background"
            >
                {gif.username ? `GIF by @${gif.username} on GIPHY` : 'via GIPHY'}
            </a>
        </figure>
    );
}
```

`git add` the new files.

- [ ] **Step 4: Wire the commit card**

In `resources/js/components/commit-card.tsx`, import `CommitGiphy` next to the `CommitImages` import, and after the line `{showImages && <CommitImages commit={commit} />}` add:

```tsx
                            {showImages && commit.gif && (
                                <CommitGiphy gif={commit.gif} />
                            )}
```

- [ ] **Step 5: Run tests and the type check**

Run: `node --experimental-strip-types --test tests/Unit/CommitGiphy.test.tsx` → PASS.
Run: `composer test:types` → PASS (PHPStan + tsc).

- [ ] **Step 6: Commit**

```bash
git add resources/js/types/commit.ts resources/js/components/commit-giphy.tsx resources/js/components/commit-card.tsx tests/Unit/CommitGiphy.test.tsx
git commit -m "feat: render attached gifs on commit cards"
```

---

### Task 11: Draft stash remembers the GIF

**Files:**
- Create: `resources/js/lib/gif-storage.ts`
- Modify: `resources/js/hooks/use-stash.ts`
- Test: Create `tests/Unit/GifStorage.test.ts` (node:test)

**Interfaces:**
- Consumes: `GiphyAttachment` (Task 9); `readStorage`/`writeStorage` from `resources/js/lib/storage.ts` (existing).
- Produces: `readStoredGif(key): GiphyAttachment | null`, `writeStoredGif(key, gif | null)`; `UseStashReturn` gains `gif: GiphyAttachment | null` and `updateGif(gif: GiphyAttachment | null): void`; `drop()` clears the GIF; `isRestored`/`useHasStash` account for it.

- [ ] **Step 1: Read the storage helper**

Run: `cat resources/js/lib/storage.ts` — confirm `readStorage(key): string` and `writeStorage(key, value)` wrap `localStorage` with graceful failure, and see whether tests stub `localStorage` globally (check `rg -n "localStorage" tests/Unit/*.test.ts` for the established stub pattern).

- [ ] **Step 2: Write the failing tests**

`tests/Unit/GifStorage.test.ts` (adapt the `localStorage` stub to the pattern found in Step 1; the fallback below works when none exists):

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
};

const { readStoredGif, writeStoredGif } = await import(
    '../../resources/js/lib/gif-storage.ts'
);

const gif = {
    id: 'xT9IgzoKnwFNmISR8I',
    url: 'https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy-downsized-medium.gif?cid=abc123',
    page_url: 'https://giphy.com/gifs/deal-with-it-xT9IgzoKnwFNmISR8I',
    title: 'Deal With It GIF',
    username: 'giphy',
    width: 480,
    height: 270,
};

await test('round-trips a stashed gif', () => {
    writeStoredGif('stash:u1:commit', gif);
    assert.deepEqual(readStoredGif('stash:u1:commit'), gif);
});

await test('clears a stashed gif', () => {
    writeStoredGif('stash:u1:commit', gif);
    writeStoredGif('stash:u1:commit', null);
    assert.equal(readStoredGif('stash:u1:commit'), null);
});

await test('ignores unreadable stashed values', () => {
    store.set('stash:u1:reply-1:gif', 'not json');
    assert.equal(readStoredGif('stash:u1:reply-1'), null);
    store.set('stash:u1:reply-2:gif', JSON.stringify({ nope: true }));
    assert.equal(readStoredGif('stash:u1:reply-2'), null);
});
```

Run: `node --experimental-strip-types --test tests/Unit/GifStorage.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement the storage module**

`resources/js/lib/gif-storage.ts`:

```ts
import type { GiphyAttachment } from '@/lib/giphy';
import { readStorage, writeStorage } from '@/lib/storage';

const gifKey = (key: string): string => `${key}:gif`;

/**
 * A stashed GIF is tiny JSON in localStorage, unlike stashed images, which are Files in IndexedDB.
 */
export function readStoredGif(key: string): GiphyAttachment | null {
    const raw = readStorage(gifKey(key));

    if (raw === '') {
        return null;
    }

    try {
        const parsed = JSON.parse(raw) as Partial<GiphyAttachment>;

        return typeof parsed.id === 'string' &&
            typeof parsed.url === 'string' &&
            typeof parsed.page_url === 'string'
            ? (parsed as GiphyAttachment)
            : null;
    } catch {
        return null;
    }
}

export function writeStoredGif(key: string, gif: GiphyAttachment | null): void {
    writeStorage(gifKey(key), gif === null ? '' : JSON.stringify(gif));
}
```

Note: the tests import with a relative path while the module imports with `@/` aliases — if node cannot resolve `@/lib/storage` when stripping types, check how existing node tests handle alias imports (`rg -n "@/" tests/Unit/SensitiveText.test.ts resources/js/lib/sensitive-text.ts`); if source modules under test only ever use relative imports, use `./giphy` and `./storage` here instead of the alias.

Run the tests again → PASS. `git add` the new files.

- [ ] **Step 4: Extend use-stash**

In `resources/js/hooks/use-stash.ts`:

a) Imports:

```ts
import { readStoredGif, writeStoredGif } from '@/lib/gif-storage';
import type { GiphyAttachment } from '@/lib/giphy';
```

b) `UseStashReturn` gains:

```ts
    readonly gif: GiphyAttachment | null;
    readonly updateGif: (gif: GiphyAttachment | null) => void;
```

c) Module level, next to the `images` map:

```ts
const gifs = new Map<string, GiphyAttachment | null>();

const gifFor = (key: string): GiphyAttachment | null => {
    if (!gifs.has(key)) {
        gifs.set(key, readStoredGif(key));
    }

    return gifs.get(key) ?? null;
};

const storeGif = (key: string, gif: GiphyAttachment | null): void => {
    gifs.set(key, gif);
    writeStoredGif(key, gif);
    notify();
};
```

d) In `useStash()`:

```ts
    const gif = useSyncExternalStore(
        subscribe,
        () => gifFor(key),
        () => null,
    );
```

initial restored state becomes:

```ts
    const [isDraftRestored, setIsDraftRestored] = useState(
        () => body !== '' || draftImages.length > 0 || gifFor(key) !== null,
    );
```

add the updater:

```ts
    const updateGif = (next: GiphyAttachment | null): void => {
        if (next === null && body === '' && draftImages.length === 0) {
            setIsDraftRestored(false);
        }

        storeGif(key, next);
    };
```

`drop()` additionally calls `storeGif(key, null);`, and the returned object adds `gif, updateGif` and widens `isRestored` to:

```ts
        isRestored:
            (isDraftRestored || isImagesRestored) &&
            (body !== '' || draftImages.length > 0 || gif !== null),
```

e) `useHasStash()`'s snapshot adds `|| gifFor(key) !== null`, and `clearStashes()` adds, after the images cleanup loop:

```ts
    [...gifs.keys()]
        .filter((key) => key.startsWith(prefix))
        .forEach((key) => gifs.delete(key));
```

(The persisted `:gif` localStorage entries already start with the prefix, so the existing `storedKeys()` loop clears them.)

- [ ] **Step 5: Verify types and existing suites**

Run: `composer test:types` → PASS.
Run: `bun run test:unit` → PASS (existing stash/draft suites unaffected).

- [ ] **Step 6: Commit**

```bash
git add resources/js/lib/gif-storage.ts resources/js/hooks/use-stash.ts tests/Unit/GifStorage.test.ts
git commit -m "feat: stash a drafted gif across reloads"
```

---

### Task 12: Picker UI components

**Files:**
- Create: `resources/js/components/giphy-picker-button.tsx`, `resources/js/components/giphy-picker-dialog.tsx`, `resources/js/components/giphy-attachment-preview.tsx`
- Create: `public/images/powered-by-giphy.png` (official mark)

**Interfaces:**
- Consumes: `lib/giphy.ts` (Task 9), shared `giphy` prop (Task 4), `ui/dialog.tsx`, `ui/button.tsx`, `ui/input.tsx` (existing).
- Produces (used by Task 13): `GiphyPickerButton({ disabled, hasGif, onPick, className })` — renders nothing without a configured key; `GiphyAttachmentPreview({ gif, onRemove })`.

- [ ] **Step 1: Fetch the official attribution mark**

```bash
mkdir -p public/images
curl -fL -o /tmp/giphy-marks.zip https://giphymedia.s3.amazonaws.com/giphy-attribution-marks.zip && unzip -o /tmp/giphy-marks.zip -d /tmp/giphy-marks && find /tmp/giphy-marks -iname "*horizontal*light*badge*.png" -o -iname "*PoweredBy*200px*.png" | head -5
```

Copy the smallest horizontal "Powered By GIPHY" PNG found to `public/images/powered-by-giphy.png` and `git add` it. **If the download fails** (URL retired), render the attribution as styled text instead — in the dialog footer below, replace the `<img>` with `<span className="font-mono text-[11px] font-bold tracking-wide text-muted-foreground">Powered By GIPHY</span>` — and state in the PR description that the official mark still needs to be dropped in before applying for a production key.

- [ ] **Step 2: Implement the dialog**

`resources/js/components/giphy-picker-dialog.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { GiphyResult } from '@/lib/giphy';
import {
    attachmentFromResult,
    fetchGifs,
    giphySearchUrl,
    giphyTrendingUrl,
    GiphyRateLimited,
    pageSize,
    previewUrlFor,
} from '@/lib/giphy';
import type { GiphyAttachment } from '@/lib/giphy';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

type Status = 'loading' | 'ready' | 'error' | 'rate-limited';

export function GiphyPickerDialog({
    apiKey,
    open,
    onOpenChange,
    onPick,
}: {
    apiKey: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onPick: (gif: GiphyAttachment) => void;
}) {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<GiphyResult[]>([]);
    const [status, setStatus] = useState<Status>('loading');
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [reloads, setReloads] = useState(0);

    const urlFor = (offset: number) =>
        query.trim() === ''
            ? giphyTrendingUrl(apiKey, offset)
            : giphySearchUrl(apiKey, query.trim(), offset);

    useEffect(() => {
        if (!open) {
            return;
        }

        const controller = new AbortController();
        const timeout = setTimeout(
            () => {
                setStatus('loading');
                fetchGifs(urlFor(0), controller.signal)
                    .then((gifs) => {
                        setResults(gifs);
                        setStatus('ready');
                    })
                    .catch((error: unknown) => {
                        if (controller.signal.aborted) {
                            return;
                        }

                        setStatus(
                            error instanceof GiphyRateLimited
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
        // eslint-disable-next-line react-hooks/exhaustive-deps -- urlFor derives from query/apiKey
    }, [open, query, apiKey, reloads]);

    const loadMore = () => {
        setIsLoadingMore(true);
        fetchGifs(urlFor(results.length))
            .then((gifs) => setResults((current) => [...current, ...gifs]))
            .catch(() => undefined)
            .finally(() => setIsLoadingMore(false));
    };

    const pick = (result: GiphyResult) => {
        const gif = attachmentFromResult(result);

        if (gif !== null) {
            onPick(gif);
            onOpenChange(false);
            setQuery('');
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>Attach a GIF</DialogTitle>
                    <DialogDescription className="sr-only">
                        Search GIPHY and pick a GIF to attach.
                    </DialogDescription>
                </DialogHeader>
                <Input
                    autoFocus
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="grep giphy…"
                    aria-label="Search GIPHY"
                    data-test="giphy-search-input"
                />
                {status === 'loading' && (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                        Loading…
                    </p>
                )}
                {status === 'rate-limited' && (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                        GIPHY is rate limiting searches. Try again shortly.
                    </p>
                )}
                {status === 'error' && (
                    <div className="py-8 text-center">
                        <p className="text-sm text-muted-foreground">
                            GIPHY did not answer.
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
                        <ul
                            className="grid grid-cols-3 gap-1"
                            data-test="giphy-results"
                        >
                            {results.map((result) => {
                                const preview = previewUrlFor(result);

                                return preview === null ? null : (
                                    <li key={result.id}>
                                        <button
                                            type="button"
                                            onClick={() => pick(result)}
                                            className="block w-full overflow-hidden rounded-md border focus-visible:ring-2 focus-visible:ring-ring"
                                            aria-label={
                                                result.title === ''
                                                    ? 'Attach GIF'
                                                    : `Attach: ${result.title}`
                                            }
                                        >
                                            <img
                                                src={preview}
                                                alt={result.title}
                                                loading="lazy"
                                                referrerPolicy="no-referrer"
                                                className="h-24 w-full bg-muted object-cover"
                                            />
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                        {results.length % pageSize === 0 && (
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
                        href="https://giphy.com"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        <img
                            src="/images/powered-by-giphy.png"
                            alt="Powered By GIPHY"
                            className="h-4"
                        />
                    </a>
                </div>
            </DialogContent>
        </Dialog>
    );
}
```

- [ ] **Step 3: Implement the button**

`resources/js/components/giphy-picker-button.tsx`:

```tsx
import { usePage } from '@inertiajs/react';
import { ImagePlay } from 'lucide-react';
import { useState } from 'react';
import { GiphyPickerDialog } from '@/components/giphy-picker-dialog';
import { Button } from '@/components/ui/button';
import type { GiphyAttachment } from '@/lib/giphy';
import { cn } from '@/lib/utils';

/**
 * Invisible without a configured GIPHY key, so self-hosters without one never see the feature.
 */
export function GiphyPickerButton({
    disabled,
    hasGif,
    onPick,
    className,
}: {
    disabled?: boolean;
    hasGif: boolean;
    onPick: (gif: GiphyAttachment) => void;
    className?: string;
}) {
    const { giphy } = usePage().props;
    const [open, setOpen] = useState(false);

    if (giphy === null) {
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
            <GiphyPickerDialog
                apiKey={giphy.key}
                open={open}
                onOpenChange={setOpen}
                onPick={onPick}
            />
        </>
    );
}
```

(If `ImagePlay` is missing from the installed lucide-react, use `Clapperboard` — verify with `rg -n "ImagePlay|Clapperboard" node_modules/lucide-react/dist/lucide-react.d.ts | head -2`.)

- [ ] **Step 4: Implement the composer preview thumb**

`resources/js/components/giphy-attachment-preview.tsx`:

```tsx
import { X } from 'lucide-react';
import type { GiphyAttachment } from '@/lib/giphy';

export function GiphyAttachmentPreview({
    gif,
    onRemove,
}: {
    gif: GiphyAttachment | null;
    onRemove: () => void;
}) {
    if (gif === null) {
        return null;
    }

    return (
        <div className="mt-2">
            <div
                className="relative inline-block"
                data-test="giphy-attachment-preview"
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

- [ ] **Step 5: Verify types and commit**

Run: `composer test:types` → PASS.

```bash
git add resources/js/components/giphy-picker-button.tsx resources/js/components/giphy-picker-dialog.tsx resources/js/components/giphy-attachment-preview.tsx public/images/powered-by-giphy.png
git commit -m "feat: add the giphy picker dialog and button"
```

---

### Task 13: Wire the three composers

**Files:**
- Modify: `resources/js/components/commit-composer.tsx`, `resources/js/components/commit-thread.tsx` (ReplyComposer), `resources/js/components/commit-quote-button.tsx` (QuoteComposer)

**Interfaces:**
- Consumes: `GiphyPickerButton`, `GiphyAttachmentPreview` (Task 12), `giphyFormFields` (Task 9), `useStash().gif/updateGif` (Task 11), `CommitGiphy` (Task 10).
- Produces: all three composers submit the `giphy_*` fields; exclusivity per spec — picking a GIF clears uploads and poll; attaching images or starting a poll clears the GIF.

- [ ] **Step 1: Wire the main composer**

In `resources/js/components/commit-composer.tsx`:

a) Imports: `GiphyPickerButton`, `GiphyAttachmentPreview`, `giphyFormFields` and `type GiphyAttachment`.

b) In `CommitComposer`, destructure nothing new (keep using `stash.gif`); extend the `transform` chain — the current ternary becomes:

```tsx
            transform={(data) =>
                isScheduling
                    ? {
                          ...data,
                          scheduled_at: new Date(scheduledAt)
                              .toISOString()
                              .replace(/\.\d{3}Z$/, '+00:00'),
                      }
                    : stash.gif !== null
                      ? { ...data, ...giphyFormFields(stash.gif) }
                      : hasImages
                        ? {
                              ...data,
                              images: attachments.images,
                              image_descriptions: attachments.descriptions,
                          }
                        : data
            }
```

(`drop()` inside `onSuccess` already clears the stashed GIF after Task 11.)

c) In `CommitComposerBody` (which receives `stash` and `attachments` as props), define the handlers near the top:

```tsx
    const pickGif = (gif: GiphyAttachment) => {
        attachments.clear();
        setPoll(null);
        stash.updateGif(gif);
    };
```

d) Toolbar: change the `ImagePickerButton`'s `onPick` from `attachments.attach` to:

```tsx
                                    onPick={(files) => {
                                        stash.updateGif(null);
                                        attachments.attach(files);
                                    }}
```

add, right after the `ImagePickerButton` block:

```tsx
                            {!isScheduling && (
                                <GiphyPickerButton
                                    disabled={processing || poll !== null}
                                    hasGif={stash.gif !== null}
                                    onPick={pickGif}
                                    className="-ml-3"
                                />
                            )}
```

and extend the poll button's `onClick` with `stash.updateGif(null);` as its first statement, plus its `disabled` with `|| stash.gif !== null` and a matching `title` branch (`'A commit can have a GIF or a poll, not both'`).

e) Render the preview thumb next to `ImagePickerPreviews` (same conditional context):

```tsx
                    <GiphyAttachmentPreview
                        gif={stash.gif}
                        onRemove={() => stash.updateGif(null)}
                    />
```

f) Preview mode: find where the composer's preview branch renders draft images (`rg -n "CommitImages|ImagePickerPreviews" resources/js/components/composer-preview.tsx resources/js/components/commit-composer.tsx`). If the preview branch renders a draft `<CommitImages images={…} />`, render next to it:

```tsx
                    {stash.gif !== null && (
                        <CommitGiphy
                            gif={stash.gif}
                        />
                    )}
```

(`GiphyAttachment` is structurally assignable to `CommitGif`.) If drafts only show `ImagePickerPreviews` outside the preview, skip this — the thumb from (e) already covers it.

g) Server error surfacing: in the spot where `imageErrorFrom(errors)` feeds `InputError`, also surface GIF errors — extend `imageErrorFrom` in `resources/js/components/commit-image-picker.tsx` so its key scan adds `|| name.startsWith('giphy_')`.

- [ ] **Step 2: Wire the reply composer**

In `resources/js/components/commit-thread.tsx` (`ReplyComposer`):

a) Destructure `gif, updateGif` from the `useStash(...)` call. Extend the `useHttp` data generic with the optional fields:

```tsx
            giphy_id?: string;
            giphy_url?: string;
            giphy_page_url?: string;
            giphy_title?: string;
            giphy_username?: string;
            giphy_width?: number;
            giphy_height?: number;
```

b) In `submit()`, extend the `request.setData(() => ({ ... }))` object:

```tsx
            ...(gif !== null ? giphyFormFields(gif) : {}),
```

(and drop `images`/`image_descriptions` from the payload when `gif !== null`: `images: gif === null ? images : [],` and `image_descriptions: gif === null ? descriptions : [],`).

c) Toolbar: after the `ImagePickerButton` (whose `onPick` becomes the clear-gif wrapper as in Step 1d):

```tsx
                    <GiphyPickerButton
                        disabled={processing}
                        hasGif={gif !== null}
                        onPick={(picked) => {
                            attachments.clear();
                            updateGif(picked);
                        }}
                        className="-ml-2 size-8"
                    />
```

d) Render `<GiphyAttachmentPreview gif={gif} onRemove={() => updateGif(null)} />` next to the reply's `ImagePickerPreviews`, and add `drop()`-adjacent cleanup: the existing `onSuccess` already calls `drop()`, which clears the GIF.

- [ ] **Step 3: Wire the quote composer**

In `resources/js/components/commit-quote-button.tsx` (`QuoteComposer`): same pattern — destructure `gif, updateGif` from `useStash`, extend the `<Form transform={...}>`:

```tsx
                transform={(data) =>
                    gif !== null
                        ? { ...data, ...giphyFormFields(gif) }
                        : images.length > 0
                          ? {
                                ...data,
                                images,
                                image_descriptions: descriptions,
                            }
                          : data
                }
```

add the `GiphyPickerButton` after the `ImagePickerButton` (wrapping `onPick` to clear the GIF, as in Step 1d), and render the `GiphyAttachmentPreview` next to the quote's image previews.

- [ ] **Step 4: Verify**

Run: `composer test:types` → PASS.
Run: `bun run test:unit` → PASS (existing composer suites must not break; if `ComposerDraft.test.tsx` or `QuoteDraft.test.tsx` fail because `useStash` now returns extra keys or `usePage().props.giphy` is read, extend their mocks minimally — add `giphy: null` to the mocked page props and `gif: null, updateGif: () => {}` to any stubbed stash objects).
Manual QA (run `composer dev` with `GIPHY_KEY` set and `AUTO_LOGIN=true`): pick a GIF in each composer; confirm picking a GIF removes attached images and vice versa; post and confirm the card renders the GIF with attribution; reload mid-draft and confirm the GIF is restored; confirm the button is absent with `GIPHY_KEY` empty.

- [ ] **Step 5: Commit**

```bash
git add resources/js/components/commit-composer.tsx resources/js/components/commit-thread.tsx resources/js/components/commit-quote-button.tsx resources/js/components/commit-image-picker.tsx
git commit -m "feat: attach giphy gifs from every composer"
```

---

### Task 14: Docs and full verification

**Files:**
- Modify: `README.md`, `PRODUCT.md`

- [ ] **Step 1: README**

After the Embeds section, add:

```markdown
### GIFs

With a [GIPHY API key](https://developers.giphy.com) in `GIPHY_KEY`, every composer gains a GIF picker: search GIPHY and attach one GIF to a commit, reply, or quote — never alongside uploaded images or a poll. The browser talks to GIPHY directly (its terms require client-side calls, so the key ships to the client) and commits store only the GIF's URLs; nothing is downloaded or rehosted. Without a key the picker is hidden. Beta keys allow about 42 searches an hour; production use needs an approved key, which requires the "Powered By GIPHY" mark the picker already shows.
```

- [ ] **Step 2: PRODUCT.md**

a) In "Capabilities and Constraints", add a bullet after the link-cards bullet:

```markdown
- GIFs: with a GIPHY key configured, a commit, reply, or quote can carry one GIF from GIPHY's catalog — never alongside uploaded images or a poll, and never on a scheduled commit. The GIF is hotlinked from GIPHY with creator attribution; /dev/null stores only its URLs, as GIPHY's API terms require.
```

b) In the "Deliberately excluded for now" bullet, remove `images/media,` (stale — commits already carry images, and now GIFs).

- [ ] **Step 3: Full verification**

Run: `composer test`
Expected: PASS — lint (Rector/Pint/Oxfmt dry-run), PHPStan + tsc, 100% type coverage, Pest at exactly 100.0% coverage, then `bun run test:unit`. If Pint/oxfmt flag formatting, run `composer lint` and re-run `composer test`.

- [ ] **Step 4: Commit**

```bash
git add README.md PRODUCT.md
git commit -m "docs: document the giphy gif picker"
```

---

## Self-Review Notes

- Spec coverage: data model + validation (Tasks 1–3), key delivery (4), moderation (5), public API (6), OG (7), Atom (8), client library + `rating=g` + renditions (9), rendering + attribution + fallback (10), stash (11), picker + Powered By GIPHY (12), composer wiring + exclusivity + error surfacing (13), docs incl. PRODUCT.md (14). Quote embeds and the photo viewer intentionally untouched (spec: out of scope).
- Type consistency: `Giphy` DTO fields ↔ `giphy()` helper ↔ `toColumns()` ↔ migration columns ↔ `gif()` array ↔ `CommitGif` TS type ↔ `giphyFormFields` keys all use the same seven names.
- Known locate-steps (API/OG/feed test files, reply controller test name, ComposerDraft mocks) exist because those files were not read during planning; each has an exact `rg` command and the content to produce.

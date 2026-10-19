# Client-Only GIF Provider Keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move GIF provider keys out of the database into the user's browser (`localStorage`, namespaced per user), delete all server-side key storage/plumbing, and keep the server storing only public GIF attachment metadata.

**Architecture:** A small storage module (`resources/js/lib/gif-provider-key.ts`) owns the namespaced localStorage entry plus a same-tab emitter and cross-tab `storage` listener; a `useGifProviderKey` hook exposes it through `useSyncExternalStore` with a deterministic `null` server snapshot. Settings and the picker button consume the hook. The users table loses its provider/key columns and the controller/request/routes/Inertia prop are deleted. Commit metadata (`gif_provider` + `gif_*`) is unchanged.

**Tech Stack:** Laravel 13 (PHP 8.5, strict types), Inertia 3 + React 19 + TypeScript, Pest 5, node:test for lib tests, Vite+ for component tests.

**Spec:** `docs/superpowers/specs/2026-10-19-gif-provider-key-client-storage-design.md`

## Global Constraints

- **No secrets server-side.** Provider keys live only in `localStorage`; they are never sent to the server, never stored in the DB, never in page props, never logged, never in cookies.
- Storage entry: `gif-provider:{userId}` → JSON `{provider, key}`. The provider must be an **own** property of `gifProviders` (`Object.hasOwn`); key: non-empty (trimmed) string, length ≤ 255. Malformed values read as absent.
- Per-user namespacing: two accounts on one browser never share a key. Signing out does not clear it; clearing site data does. Each device needs its own key (documented).
- SSR-safe: `useSyncExternalStore` with `getServerSnapshot` returning `null`; no hydration mismatches.
- The unreleased feature has no back-compat: delete the users columns/migration and all server key plumbing outright.
- Commit metadata (`gif_provider`, `gif_*`) and all read surfaces stay unchanged.
- PHP: `declare(strict_types=1);`; validation only in Form Requests; no protected methods. Pest 100% line coverage; every new PHP branch tested; PHPStan max. No real HTTP in tests.
- Wayfinder: regenerate after route changes (`php artisan wayfinder:generate --with-form`); generated files are gitignored and never committed.
- House rule: `git add` new files immediately after creating them.
- Gates: PHP `composer test:lint`, `composer test:types`, `composer test:type-coverage`, full `php -d memory_limit=-1 vendor/bin/pest --fresh` (CI runs the `--exactly=100.0` coverage leg with pcov). JS: `bun run test:unit`, `bun run test:types`, `bun run test:lint`.

---

### Task 1: Client key storage module and hook

**Files:**
- Create: `resources/js/lib/gif-provider-key.ts`
- Create: `resources/js/hooks/use-gif-provider-key.ts`
- Test: `tests/Unit/GifProviderKey.test.ts` (create)

**Interfaces:**
- Produces: `GifProviderKey = { provider: GifProviderId; key: string }`; `readGifProviderKey(userId): GifProviderKey | null` (stable reference while the raw value is unchanged); `writeGifProviderKey(userId, value): void`; `clearGifProviderKey(userId): void`; `subscribeGifProviderKey(userId, listener): () => void`.
- Produces: `useGifProviderKey(userId: string | null): GifProviderKey | null`.

- [ ] **Step 1: Write the failing storage tests**

Create `tests/Unit/GifProviderKey.test.ts`:

```ts
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import {
    clearGifProviderKey,
    readGifProviderKey,
    subscribeGifProviderKey,
    writeGifProviderKey,
} from '../../resources/js/lib/gif-provider-key.ts';

let store: Map<string, string>;
let storageHandlers: Array<(event: StorageEvent) => void>;
const originalWindow = globalThis.window;

function installWindow(): void {
    store = new Map();
    storageHandlers = [];

    globalThis.window = {
        localStorage: {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => store.set(key, value),
            removeItem: (key: string) => store.delete(key),
            key: (index: number) => [...store.keys()][index] ?? null,
            get length() {
                return store.size;
            },
        },
        addEventListener: (_type: string, handler: (event: StorageEvent) => void) => {
            storageHandlers.push(handler);
        },
        removeEventListener: (_type: string, handler: (event: StorageEvent) => void) => {
            storageHandlers = storageHandlers.filter((candidate) => candidate !== handler);
        },
    } as unknown as Window & typeof globalThis;
}

beforeEach(installWindow);

afterEach(() => {
    globalThis.window = originalWindow;
});

test('round-trips a key and keeps a stable reference while unchanged', () => {
    writeGifProviderKey('user-1', { provider: 'klipy', key: 'k-123' });

    const first = readGifProviderKey('user-1');
    const second = readGifProviderKey('user-1');

    assert.deepEqual(first, { provider: 'klipy', key: 'k-123' });
    assert.equal(first, second);
});

test('namespaces keys per user', () => {
    writeGifProviderKey('user-1', { provider: 'giphy', key: 'one' });
    writeGifProviderKey('user-2', { provider: 'klipy', key: 'two' });

    assert.deepEqual(readGifProviderKey('user-1'), { provider: 'giphy', key: 'one' });
    assert.deepEqual(readGifProviderKey('user-2'), { provider: 'klipy', key: 'two' });
    assert.equal(readGifProviderKey('user-3'), null);
});

test('treats malformed values as absent', () => {
    store.set('gif-provider:user-1', '{not json');
    assert.equal(readGifProviderKey('user-1'), null);

    store.set('gif-provider:user-1', JSON.stringify({ provider: 'unknown', key: 'x' }));
    assert.equal(readGifProviderKey('user-1'), null);

    store.set('gif-provider:user-1', JSON.stringify({ provider: 'toString', key: 'x' }));
    assert.equal(readGifProviderKey('user-1'), null);

    store.set('gif-provider:user-1', JSON.stringify({ provider: '__proto__', key: 'x' }));
    assert.equal(readGifProviderKey('user-1'), null);

    store.set('gif-provider:user-1', JSON.stringify({ provider: 'giphy', key: '   ' }));
    assert.equal(readGifProviderKey('user-1'), null);

    store.set('gif-provider:user-1', JSON.stringify({ provider: 'giphy', key: 'a'.repeat(256) }));
    assert.equal(readGifProviderKey('user-1'), null);

    store.set('gif-provider:user-1', JSON.stringify({ provider: 'giphy', key: 42 }));
    assert.equal(readGifProviderKey('user-1'), null);
});

test('writes the trimmed key and notifies same-tab subscribers', () => {
    const calls: string[] = [];
    const unsubscribe = subscribeGifProviderKey('user-1', () => calls.push('hit'));

    writeGifProviderKey('user-1', { provider: 'giphy', key: '  k-123  ' });

    assert.equal(store.get('gif-provider:user-1'), JSON.stringify({ provider: 'giphy', key: 'k-123' }));
    assert.deepEqual(calls, ['hit']);

    unsubscribe();
    writeGifProviderKey('user-1', { provider: 'giphy', key: 'k-456' });
    assert.deepEqual(calls, ['hit']);
});

test('clears the entry and notifies', () => {
    writeGifProviderKey('user-1', { provider: 'giphy', key: 'k-123' });

    const calls: string[] = [];
    subscribeGifProviderKey('user-1', () => calls.push('hit'));

    clearGifProviderKey('user-1');

    assert.equal(store.has('gif-provider:user-1'), false);
    assert.deepEqual(calls, ['hit']);
    assert.equal(readGifProviderKey('user-1'), null);
});

test('reacts to storage events for its own key only', () => {
    const calls: string[] = [];
    const unsubscribe = subscribeGifProviderKey('user-1', () => calls.push('hit'));

    assert.equal(storageHandlers.length, 1);

    storageHandlers[0]!({ key: 'gif-provider:user-2' } as StorageEvent);
    assert.deepEqual(calls, []);

    store.set('gif-provider:user-1', JSON.stringify({ provider: 'giphy', key: 'other-tab' }));
    storageHandlers[0]!({ key: 'gif-provider:user-1' } as StorageEvent);

    assert.deepEqual(calls, ['hit']);
    assert.deepEqual(readGifProviderKey('user-1'), { provider: 'giphy', key: 'other-tab' });

    unsubscribe();
    assert.equal(storageHandlers.length, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test tests/Unit/GifProviderKey.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the storage module**

Create `resources/js/lib/gif-provider-key.ts`:

```ts
import { gifProviders } from './gif-providers/index.ts';
import type { GifProviderId } from './gif-providers/types.ts';
import { readStorage, writeStorage } from './storage.ts';

export type GifProviderKey = {
    provider: GifProviderId;
    key: string;
};

type Cached = { raw: string; value: GifProviderKey | null };

const cache = new Map<string, Cached>();
const listeners = new Map<string, Set<() => void>>();

const storageKey = (userId: string): string => `gif-provider:${userId}`;

function parse(raw: string): GifProviderKey | null {
    if (raw === '') {
        return null;
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }

    if (typeof parsed !== 'object' || parsed === null) {
        return null;
    }

    const candidate = parsed as { provider?: unknown; key?: unknown };

    if (
        typeof candidate.provider !== 'string' ||
        !Object.hasOwn(gifProviders, candidate.provider) ||
        typeof candidate.key !== 'string' ||
        candidate.key.trim() === '' ||
        candidate.key.length > 255
    ) {
        return null;
    }

    return {
        provider: candidate.provider as GifProviderId,
        key: candidate.key.trim(),
    };
}

export function readGifProviderKey(userId: string): GifProviderKey | null {
    const raw = readStorage(storageKey(userId));
    const cached = cache.get(userId);

    if (cached !== undefined && cached.raw === raw) {
        return cached.value;
    }

    const value = parse(raw);
    cache.set(userId, { raw, value });

    return value;
}

function notify(userId: string): void {
    listeners.get(userId)?.forEach((listener) => listener());
}

export function writeGifProviderKey(
    userId: string,
    value: GifProviderKey,
): void {
    writeStorage(
        storageKey(userId),
        JSON.stringify({ provider: value.provider, key: value.key.trim() }),
    );
    cache.delete(userId);
    notify(userId);
}

export function clearGifProviderKey(userId: string): void {
    writeStorage(storageKey(userId), '');
    cache.delete(userId);
    notify(userId);
}

export function subscribeGifProviderKey(
    userId: string,
    listener: () => void,
): () => void {
    const key = storageKey(userId);
    const subscribed = listeners.get(userId) ?? new Set<() => void>();

    subscribed.add(listener);
    listeners.set(userId, subscribed);

    const onStorage = (event: StorageEvent): void => {
        if (event.key !== key) {
            return;
        }

        cache.delete(userId);
        listener();
    };

    if (typeof window !== 'undefined') {
        window.addEventListener('storage', onStorage);
    }

    return () => {
        subscribed.delete(listener);

        if (subscribed.size === 0) {
            listeners.delete(userId);
        }

        if (typeof window !== 'undefined') {
            window.removeEventListener('storage', onStorage);
        }
    };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --test tests/Unit/GifProviderKey.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement the hook**

Create `resources/js/hooks/use-gif-provider-key.ts`:

```ts
import { useSyncExternalStore } from 'react';
import {
    readGifProviderKey,
    subscribeGifProviderKey,
} from '@/lib/gif-provider-key';
import type { GifProviderKey } from '@/lib/gif-provider-key';

export function useGifProviderKey(
    userId: string | null,
): GifProviderKey | null {
    return useSyncExternalStore(
        (listener) =>
            userId === null
                ? () => undefined
                : subscribeGifProviderKey(userId, listener),
        () => (userId === null ? null : readGifProviderKey(userId)),
        () => null,
    );
}
```

- [ ] **Step 6: Run the JS gates**

Run: `bun run test:unit && bun run test:types && bun run test:lint`
Expected: PASS (the new node test runs under `test:unit`; nothing else consumes the hook yet).

- [ ] **Step 7: Commit**

```bash
git add resources/js/lib/gif-provider-key.ts resources/js/hooks/use-gif-provider-key.ts tests/Unit/GifProviderKey.test.ts
git commit -m "feat: store the gif provider key in the browser"
```

---

### Task 2: Client-side settings section

**Files:**
- Modify: `resources/js/components/gif-key-setting.tsx` (rewrite; no server calls)
- Modify: `resources/js/pages/user-profile/edit.tsx` (no props)
- Modify: `README.md` (browser-only note)
- Test: `tests/Unit/GifKeySetting.test.tsx` (rewrite)

**Interfaces:**
- Consumes: `useGifProviderKey`, `writeGifProviderKey`, `clearGifProviderKey` (Task 1); `gifProviders`/`gifProviderFor`; `useUser()` for `user.id`.
- Produces: `GifKeySetting()` — no props; renders "GIFs" with the browser-only notice, provider selector, write-only key, Connect/Update, Change provider, Remove; persists to `localStorage` only.

- [ ] **Step 1: Rewrite the failing settings tests**

Replace `tests/Unit/GifKeySetting.test.tsx` with:

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

vi.doMock('../../resources/js/hooks/use-user', () => ({
    useUser: () => ({ user: { id: 'user-1' } }),
}));

const { GifKeySetting } = await import(
    '../../resources/js/components/gif-key-setting'
);
const { readGifProviderKey, writeGifProviderKey } = await import(
    '../../resources/js/lib/gif-provider-key'
);

type Element = ReactElement<Record<string, unknown>>;

let store: Map<string, string>;
const originalWindow = globalThis.window;

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

function render(): Element[] {
    cursor = 0;

    return elements(GifKeySetting());
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
    (field(fields, 'gif-key-input').props.onChange as (event: {
        target: { value: string };
    }) => void)({ target: { value } });

    return render();
}

function selectProvider(fields: Element[], id: 'klipy'): Element[] {
    (field(fields, `provider-${id}`).props.onClick as () => void)();

    return render();
}

beforeEach(() => {
    state = [];
    cursor = 0;
    store = new Map();
    vi.clearAllMocks();
    vi.unstubAllGlobals();

    globalThis.window = {
        localStorage: {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => store.set(key, value),
            removeItem: (key: string) => store.delete(key),
            key: (index: number) => [...store.keys()][index] ?? null,
            get length() {
                return store.size;
            },
        },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    } as unknown as Window & typeof globalThis;
});

test('shows the browser-only notice', () => {
    const fields = render();

    assert.ok(
        fields.some(
            (element) =>
                typeof element.props.children === 'string' &&
                element.props.children.includes('Stored in this browser only'),
        ),
    );
});

test('saves a valid key to local storage after giphy accepts it', async () => {
    stubFetch(200);

    let fields = typeKey(render(), '  key-123  ');
    await (field(fields, 'gif-connect-button').props.onClick as () => Promise<void>)();

    assert.deepEqual(store.get('gif-provider:user-1'), JSON.stringify({ provider: 'giphy', key: 'key-123' }));
    assert.deepEqual(readGifProviderKey('user-1'), { provider: 'giphy', key: 'key-123' });

    fields = render();
    assert.equal(
        React.Children.toArray(
            field(fields, 'gif-connected').props.children as ReactNode,
        )
            .map((child) => (typeof child === 'string' ? child : ''))
            .join(''),
        'Connected to GIPHY.',
    );
});

test('saves the key against the selected provider', async () => {
    stubFetch(200);

    let fields = selectProvider(render(), 'klipy');
    fields = typeKey(fields, 'key-123');
    await (field(fields, 'gif-connect-button').props.onClick as () => Promise<void>)();

    assert.deepEqual(readGifProviderKey('user-1'), { provider: 'klipy', key: 'key-123' });
});

test('saves a rate-limited key because the key itself is real', async () => {
    stubFetch(429);

    const fields = typeKey(render(), 'key-123');
    await (field(fields, 'gif-connect-button').props.onClick as () => Promise<void>)();

    assert.deepEqual(readGifProviderKey('user-1'), { provider: 'giphy', key: 'key-123' });
});

test('rejects a refused key without saving', async () => {
    stubFetch(401);

    const fields = typeKey(render(), 'key-123');
    await (field(fields, 'gif-connect-button').props.onClick as () => Promise<void>)();

    assert.equal(readGifProviderKey('user-1'), null);
    assert.equal(
        field(render(), 'gif-key-error').props.children,
        'That key was rejected by GIPHY.',
    );
});

test('names klipy when it refuses the key', async () => {
    stubFetch(401);

    let fields = selectProvider(render(), 'klipy');
    fields = typeKey(fields, 'key-123');
    await (field(fields, 'gif-connect-button').props.onClick as () => Promise<void>)();

    assert.equal(readGifProviderKey('user-1'), null);
    assert.equal(
        field(render(), 'gif-key-error').props.children,
        'That key was rejected by KLIPY.',
    );
});

test('clears the error when another provider is selected', async () => {
    stubFetch(401);

    const fields = typeKey(render(), 'key-123');
    await (field(fields, 'gif-connect-button').props.onClick as () => Promise<void>)();

    assert.ok(field(render(), 'gif-key-error'));

    (field(render(), 'provider-klipy').props.onClick as () => void)();

    assert.equal(
        render().some(
            (element) => element.props['data-test'] === 'gif-key-error',
        ),
        false,
    );
});

test('does not save when the provider cannot be reached', async () => {
    stubFetch('network');

    const fields = typeKey(render(), 'key-123');
    await (field(fields, 'gif-connect-button').props.onClick as () => Promise<void>)();

    assert.equal(readGifProviderKey('user-1'), null);
    assert.equal(
        field(render(), 'gif-key-error').props.children,
        "Couldn't reach GIPHY to verify the key.",
    );
});

test('disables connect until a key is typed', () => {
    assert.equal(field(render(), 'gif-connect-button').props.disabled, true);
});

test('does not save a whitespace-only key', async () => {
    stubFetch(200);

    const fields = typeKey(render(), '   ');
    await (field(fields, 'gif-connect-button').props.onClick as () => Promise<void>)();

    assert.equal(readGifProviderKey('user-1'), null);
});

test('shows the connected provider from local storage', () => {
    writeGifProviderKey('user-1', { provider: 'klipy', key: 'k' });

    const fields = render();

    assert.equal(
        React.Children.toArray(
            field(fields, 'gif-connected').props.children as ReactNode,
        )
            .map((child) => (typeof child === 'string' ? child : ''))
            .join(''),
        'Connected to KLIPY.',
    );
});

test('removes the stored key', () => {
    writeGifProviderKey('user-1', { provider: 'giphy', key: 'k' });

    const fields = render();
    (field(fields, 'gif-remove-button').props.onClick as () => void)();

    assert.equal(readGifProviderKey('user-1'), null);
    assert.ok(field(render(), 'gif-key-input'));
});

test('replaces the connected provider when another is chosen', async () => {
    stubFetch(200);

    writeGifProviderKey('user-1', { provider: 'giphy', key: 'old' });

    let fields = render();
    (field(fields, 'change-provider-button').props.onClick as () => void)();

    fields = render();
    (field(fields, 'provider-klipy').props.onClick as () => void)();

    fields = render();
    (field(fields, 'gif-key-input').props.onChange as (event: {
        target: { value: string };
    }) => void)({ target: { value: 'klipy-key' } });

    fields = render();
    await (field(fields, 'gif-connect-button').props.onClick as () => Promise<void>)();

    assert.deepEqual(readGifProviderKey('user-1'), { provider: 'klipy', key: 'klipy-key' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test:unit`
Expected: FAIL — the component still requires `gifConnected`/`gifProvider` props and uses Inertia `router`.

- [ ] **Step 3: Rewrite the component**

Replace `resources/js/components/gif-key-setting.tsx` with:

```tsx
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { useGifProviderKey } from '@/hooks/use-gif-provider-key';
import { useUser } from '@/hooks/use-user';
import {
    clearGifProviderKey,
    writeGifProviderKey,
} from '@/lib/gif-provider-key';
import { gifProviderFor, gifProviders } from '@/lib/gif-providers';
import type { GifProviderId } from '@/lib/gif-providers';

const helpHref: Record<GifProviderId, string> = {
    giphy: 'https://developers.giphy.com',
    klipy: 'https://partner.klipy.com',
};

export function GifKeySetting() {
    const { user } = useUser();
    const entry = useGifProviderKey(user.id);
    const [providerId, setProviderId] = useState<GifProviderId>(
        entry?.provider ?? 'giphy',
    );
    const [key, setKey] = useState('');
    const [editing, setEditing] = useState(false);
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

        writeGifProviderKey(user.id, {
            provider: providerId,
            key: candidate,
        });
        setKey('');
        setError(null);
        setEditing(false);
        setProcessing(false);
    };

    const remove = () => {
        clearGifProviderKey(user.id);
        setError(null);
        setEditing(false);
    };

    return (
        <section
            aria-labelledby="gif-key-label"
            aria-describedby="gif-key-description"
            className="px-4 py-6 sm:px-6"
        >
            <h2 id="gif-key-label" className="text-base font-semibold">
                GIFs
            </h2>
            <p
                id="gif-key-description"
                className="mt-2 text-sm text-muted-foreground"
            >
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
                , save it here, and every composer gains a GIF picker. One
                provider at a time; without a key the picker stays hidden.
            </p>
            <p className="mt-2 text-sm text-muted-foreground" data-test="gif-storage-note">
                Stored in this browser only — never sent to the server. Each
                device needs its own key.
            </p>
            {entry !== null && !editing ? (
                <div className="mt-4 flex flex-wrap items-center gap-3">
                    <p className="text-sm" data-test="gif-connected">
                        Connected to{' '}
                        {gifProviderFor(entry.provider).label}.
                    </p>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                            setProviderId(entry.provider);
                            setEditing(true);
                        }}
                        data-test="change-provider-button"
                    >
                        Change provider
                    </Button>
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={remove}
                        data-test="gif-remove-button"
                    >
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
                                aria-pressed={candidate.id === providerId}
                                disabled={processing}
                                onClick={() => {
                                    setProviderId(candidate.id);
                                    setError(null);
                                }}
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
                            disabled={processing}
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
                            {entry !== null || editing ? 'Update' : 'Connect'}
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

- [ ] **Step 4: Stop passing server props on the profile page**

In `resources/js/pages/user-profile/edit.tsx`: remove `gifConnected` and `gifProvider` from the destructured props and the inline prop type, and render `<GifKeySetting />` (no props). The server may keep sending the page props until Task 4; they are simply unused.

- [ ] **Step 5: Update the README**

Replace the README "GIFs" paragraph with:

```markdown
GIF search is bring-your-own-key and stays in your browser: connect one provider — [GIPHY](https://developers.giphy.com) or [KLIPY](https://klipy.com) — under Settings → Profile → GIFs and paste its API key. The key is stored only in this browser (`localStorage`), never sent to the server or saved in the database; each device needs its own, and clearing site data removes it. Searches run on your key and quota, so no paid key is shared by the instance; without one the picker is hidden. The browser talks to the provider directly and commits store only the GIF's URLs and metadata — nothing is downloaded or rehosted. Connect one provider at a time; choosing another replaces it.
```

- [ ] **Step 6: Run the JS gates**

Run: `bun run test:unit && bun run test:types && bun run test:lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add resources/js/components/gif-key-setting.tsx resources/js/pages/user-profile/edit.tsx README.md tests/Unit/GifKeySetting.test.tsx
git commit -m "feat: manage the gif provider key in the browser"
```

---

### Task 3: Read the stored key in the picker button

**Files:**
- Modify: `resources/js/components/gif-picker-button.tsx`
- Test: `tests/Unit/GifPickerDialog.test.tsx` (extend; the button shares this config)

**Interfaces:**
- Consumes: `useGifProviderKey` (Task 1), `usePage().props.auth` (`Profile` has `id`).
- Produces: the button renders only when a valid stored entry exists and passes `gifProviderFor(entry.provider)` + `entry.key` to `GifPickerDialog`.

- [ ] **Step 1: Update the picker test mocks and write the failing button tests**

In `tests/Unit/GifPickerDialog.test.tsx`:

1. Replace the `@inertiajs/react` mock with:

```ts
vi.doMock('@inertiajs/react', async () => ({
    ...(await vi.importActual('@inertiajs/react')),
    usePage: () => ({ props: { auth: { user: { id: 'user-1' } } } }),
}));
```

2. Add a localStorage/window stub in `beforeEach` (and import the storage module after the mocks):

```ts
const { writeGifProviderKey } = await import(
    '../../resources/js/lib/gif-provider-key'
);

let store: Map<string, string>;
```

Inside `beforeEach`:

```ts
    store = new Map();
    globalThis.window = {
        localStorage: {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => store.set(key, value),
            removeItem: (key: string) => store.delete(key),
            key: (index: number) => [...store.keys()][index] ?? null,
            get length() {
                return store.size;
            },
        },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    } as unknown as Window & typeof globalThis;
```

3. Replace the existing final test (`renders nothing when no gif provider is connected`) with:

```tsx
test('renders nothing when no gif provider key is stored', () => {
    assert.equal(GifPickerButton({ hasGif: false, onPick: vi.fn() }), null);
});

test('opens the picker with the stored provider and key', () => {
    writeGifProviderKey('user-1', { provider: 'klipy', key: 'stored-key' });

    const fields = elements(
        GifPickerButton({ hasGif: false, onPick: vi.fn() }) as ReactElement,
    );
    const dialog = fields.find(
        (element) => element.props.apiKey === 'stored-key',
    );

    assert.ok(dialog);
    assert.equal(dialog.props.provider?.id, 'klipy');
    assert.equal(dialog.props.open, false);
});
```

(Note: the `provider` fixture at the top of the file is a FAUX adapter with `id: 'klipy'`, but the button resolves the real KLIPY adapter from the registry; assert via the dialog's `apiKey` and `provider.id` as shown.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test:unit`
Expected: FAIL — the button still reads `usePage().props.gif`.

- [ ] **Step 3: Rewrite the button**

Replace `resources/js/components/gif-picker-button.tsx` with:

```tsx
import { usePage } from '@inertiajs/react';
import { ImagePlay } from 'lucide-react';
import { useState } from 'react';
import { GifPickerDialog } from '@/components/gif-picker-dialog';
import { Button } from '@/components/ui/button';
import { useGifProviderKey } from '@/hooks/use-gif-provider-key';
import { gifProviderFor } from '@/lib/gif-providers';
import type { GifAttachment } from '@/lib/gif-providers';
import { cn } from '@/lib/utils';

/** Invisible until the signed-in user stores a GIF provider key in settings. */
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
    const { auth } = usePage().props;
    const entry = useGifProviderKey(auth.user?.id ?? null);
    const [open, setOpen] = useState(false);

    if (entry === null) {
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
                provider={gifProviderFor(entry.provider)}
                apiKey={entry.key}
                open={open}
                onOpenChange={setOpen}
                onPick={onPick}
            />
        </>
    );
}
```

- [ ] **Step 4: Run the JS gates**

Run: `bun run test:unit && bun run test:types && bun run test:lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add resources/js/components/gif-picker-button.tsx tests/Unit/GifPickerDialog.test.tsx
git commit -m "feat: read the gif provider key from the browser"
```

---

### Task 4: Remove server-side key storage and plumbing

**Files:**
- Delete: `database/migrations/2026_10_17_133426_add_gif_key_to_users_table.php`
- Delete: `app/Http/Controllers/GifKeyController.php`, `app/Http/Requests/UpdateGifKeyRequest.php`
- Delete: `tests/Feature/Controllers/GifKeyControllerTest.php`, `tests/Feature/Middleware/GifPropTest.php`
- Modify: `app/Models/User.php`, `database/factories/UserFactory.php`, `app/Http/Middleware/HandleInertiaRequests.php`, `app/Http/Controllers/UserProfileController.php`, `routes/web.php`, `resources/js/types/global.d.ts`
- Modify: `tests/Feature/Controllers/UserProfileControllerTest.php`, `tests/Feature/Controllers/ExportControllerTest.php`, `tests/Unit/Models/UserTest.php`

**Interfaces:**
- Consumes: nothing from earlier tasks (this is pure removal).
- Produces: no users key/provider columns, no `settings/gif` routes, no `gif` Inertia prop, no profile-page gif props; commit metadata untouched.

- [ ] **Step 1: Delete the files**

```bash
git rm database/migrations/2026_10_17_133426_add_gif_key_to_users_table.php
git rm app/Http/Controllers/GifKeyController.php app/Http/Requests/UpdateGifKeyRequest.php
git rm tests/Feature/Controllers/GifKeyControllerTest.php tests/Feature/Middleware/GifPropTest.php
```

Then `php artisan migrate:fresh` (the users columns disappear; the feature is unreleased).

- [ ] **Step 2: Remove the model and page plumbing**

1. `app/Models/User.php`: remove `use App\Enums\GifProvider;` (if it has no other use), the two docblock lines `@property-read GifProvider|null $gif_provider` / `@property-read string|null $gif_key`, the `'gif_provider'`/`'gif_key'` entries from `#[Hidden([...])]`, the two `$attributes` defaults, and the `'gif_provider' => GifProvider::class,` / `'gif_key' => 'encrypted',` casts.
2. `database/factories/UserFactory.php`: remove the whole `withGifKey(...)` method and the `use App\Enums\GifProvider;` import (it has no other use).
3. `app/Http/Middleware/HandleInertiaRequests.php`: delete the whole `'gif' => fn (): ?array => (function () use ($request): ?array { ... })(),` entry.
4. `app/Http/Controllers/UserProfileController.php`: delete the `'gifConnected' => ...` and `'gifProvider' => ...` lines.
5. `routes/web.php`: delete the controller import `use App\Http\Controllers\GifKeyController;`, the `// GIF provider...` comment, and the two `settings/gif` route lines.
6. `resources/js/types/global.d.ts`: delete the `import type { GifProviderId } ...` line and the `gif: { provider: GifProviderId; key: string } | null;` prop.

Regenerate routes: `php artisan wayfinder:generate --with-form` (generated files are gitignored).

- [ ] **Step 3: Remove the now-invalid tests**

1. `tests/Feature/Controllers/UserProfileControllerTest.php`: delete the whole `it('renders the connected gif provider', ...)` test (the one with `->with([null, 'giphy', 'klipy'])`). Remove the now-unused `GifProvider` import if present.
2. `tests/Feature/Controllers/ExportControllerTest.php`: delete the whole `it('never exports the gif key', ...)` test.
3. `tests/Unit/Models/UserTest.php`: delete the tests that exercise the removed columns — the encrypted `gif_key` round-trip test, the `gif_provider`/`gif_key` null-default test, and the `gif_key`/`gif_provider` serialization test (search for `gif_key`/`gif_provider` and remove those tests entirely). Keep the pre-existing `to array` and all other tests untouched.

- [ ] **Step 4: Run the focused servers tests**

Run: `php artisan test tests/Feature/Controllers/UserProfileControllerTest.php tests/Feature/Controllers/ExportControllerTest.php tests/Unit/Models/UserTest.php`
Expected: PASS.

Run: `rg -n "gif_key|gif_provider|withGifKey" app database tests resources` and confirm only commit-side `gif_provider` references remain (enum, commit model, requests, factories, serialization, tests) — no users key/provider or `withGifKey` references.

- [ ] **Step 5: Run the JS gates**

Run: `bun run test:unit && bun run test:types && bun run test:lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A app database routes resources tests
git commit -m "refactor: drop server-side gif key storage"
```

---

### Task 5: Sweep and full gates

**Files:**
- Modify: any leftovers
- Test: full suites

- [ ] **Step 1: Sweep for server key leftovers**

Run:

```bash
rg -n "gif_key|withGifKey|GifKeyController|UpdateGifKeyRequest|gif-key |'gif' =>|gifConnected|gifProvider" app resources tests routes database .env.example README.md
```

Expected: no hits except `gif_provider` (commit metadata) and provider-adapter names. Fix anything else.

- [ ] **Step 2: Rebuild and regenerate**

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

Expected: all PASS. Note in the PR that CI runs the PHP coverage leg (`--coverage --exactly=100.0`), which needs a local driver.

- [ ] **Step 4: Commit residual fixes (only if any)**

```bash
git add -A
git commit -m "chore: satisfy the gates for client-only gif keys"
```

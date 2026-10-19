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

const { GifKeySetting } = await import(
    '../../resources/js/components/gif-key-setting'
);

type Element = ReactElement<Record<string, unknown>>;
type Props = {
    gifConnected: boolean;
    gifProvider: 'giphy' | 'klipy' | null;
};

const disconnected: Props = { gifConnected: false, gifProvider: null };
const connected: Props = { gifConnected: true, gifProvider: 'giphy' };

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

function render(props: Props): Element[] {
    cursor = 0;

    return elements(GifKeySetting(props));
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

function typeKey(fields: Element[], value: string, props: Props): Element[] {
    (field(fields, 'gif-key-input').props.onChange as (event: {
        target: { value: string };
    }) => void)({
        target: { value },
    });

    return render(props);
}

function selectProvider(fields: Element[], id: 'klipy'): Element[] {
    (field(fields, `provider-${id}`).props.onClick as () => void)();

    return render(disconnected);
}

beforeEach(() => {
    state = [];
    cursor = 0;
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

test('saves a valid key after giphy accepts it', async () => {
    stubFetch(200);

    let fields = typeKey(render(disconnected), '  key-123  ', disconnected);
    await (field(fields, 'gif-connect-button').props.onClick as () => Promise<void>)();

    assert.equal(put.mock.calls.length, 1);
    assert.equal(put.mock.calls[0]?.[0], '/settings/gif');
    assert.deepEqual(put.mock.calls[0]?.[1], {
        provider: 'giphy',
        key: 'key-123',
    });

    const options = put.mock.calls[0]?.[2] as { onSuccess: () => void };
    options.onSuccess();

    fields = render(connected);
    assert.ok(field(fields, 'gif-connected'));
});

test('saves the key against the selected provider', async () => {
    stubFetch(200);

    let fields = selectProvider(render(disconnected), 'klipy');
    fields = typeKey(fields, 'key-123', disconnected);
    await (field(fields, 'gif-connect-button').props.onClick as () => Promise<void>)();

    assert.equal(put.mock.calls.length, 1);
    assert.deepEqual(put.mock.calls[0]?.[1], {
        provider: 'klipy',
        key: 'key-123',
    });
});

test('saves a rate-limited key because the key itself is real', async () => {
    stubFetch(429);

    const fields = typeKey(render(disconnected), 'key-123', disconnected);
    await (field(fields, 'gif-connect-button').props.onClick as () => Promise<void>)();

    assert.equal(put.mock.calls.length, 1);
});

test('rejects a refused key without saving', async () => {
    stubFetch(401);

    const fields = typeKey(render(disconnected), 'key-123', disconnected);
    await (field(fields, 'gif-connect-button').props.onClick as () => Promise<void>)();

    assert.equal(put.mock.calls.length, 0);
    assert.equal(
        field(render(disconnected), 'gif-key-error').props.children,
        'That key was rejected by GIPHY.',
    );
});

test('names klipy when it refuses the key', async () => {
    stubFetch(401);

    let fields = selectProvider(render(disconnected), 'klipy');
    fields = typeKey(fields, 'key-123', disconnected);
    await (field(fields, 'gif-connect-button').props.onClick as () => Promise<void>)();

    assert.equal(put.mock.calls.length, 0);
    assert.equal(
        field(render(disconnected), 'gif-key-error').props.children,
        'That key was rejected by KLIPY.',
    );
});

test('does not save when the provider cannot be reached', async () => {
    stubFetch('network');

    const fields = typeKey(render(disconnected), 'key-123', disconnected);
    await (field(fields, 'gif-connect-button').props.onClick as () => Promise<void>)();

    assert.equal(put.mock.calls.length, 0);
    assert.equal(
        field(render(disconnected), 'gif-key-error').props.children,
        "Couldn't reach GIPHY to verify the key.",
    );
});

test('names klipy when it cannot be reached', async () => {
    stubFetch('network');

    let fields = selectProvider(render(disconnected), 'klipy');
    fields = typeKey(fields, 'key-123', disconnected);
    await (field(fields, 'gif-connect-button').props.onClick as () => Promise<void>)();

    assert.equal(put.mock.calls.length, 0);
    assert.equal(
        field(render(disconnected), 'gif-key-error').props.children,
        "Couldn't reach KLIPY to verify the key.",
    );
});

test('disables connect until a key is typed', () => {
    const fields = render(disconnected);

    assert.equal(field(fields, 'gif-connect-button').props.disabled, true);
});

test('surfaces server validation errors', async () => {
    stubFetch(200);

    const fields = typeKey(render(disconnected), 'key-123', disconnected);
    await (field(fields, 'gif-connect-button').props.onClick as () => Promise<void>)();

    const options = put.mock.calls[0]?.[2] as {
        onError: (errors: Record<string, string>) => void;
    };
    options.onError({ key: 'The key field is required.' });

    assert.equal(
        field(render(disconnected), 'gif-key-error').props.children,
        'The key field is required.',
    );
});

test('removes a connected key', () => {
    const fields = render(connected);

    (field(fields, 'gif-remove-button').props.onClick as () => void)();

    assert.equal(destroy.mock.calls.length, 1);
    assert.equal(destroy.mock.calls[0]?.[0], '/settings/gif');
});

test('replaces the connected provider when another is chosen', async () => {
    stubFetch(200);

    let fields = render(connected);
    (field(fields, 'change-provider-button').props.onClick as () => void)();

    fields = render(connected);
    (field(fields, 'provider-klipy').props.onClick as () => void)();

    fields = render(connected);
    (field(fields, 'gif-key-input').props.onChange as (event: {
        target: { value: string };
    }) => void)({ target: { value: 'klipy-key' } });

    fields = render(connected);
    await (field(fields, 'gif-connect-button').props.onClick as () => Promise<void>)();

    assert.deepEqual(put.mock.calls[0]?.[1], {
        provider: 'klipy',
        key: 'klipy-key',
    });
});

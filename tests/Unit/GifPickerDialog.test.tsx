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
    const fields = render(false);

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
    assert.equal(
        (provider.search as ReturnType<typeof vi.fn>).mock.calls.length,
        0,
    );
});

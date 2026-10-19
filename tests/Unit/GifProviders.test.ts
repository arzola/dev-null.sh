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

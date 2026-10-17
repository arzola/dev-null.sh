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
            | 'downsized_medium'
            | 'downsized'
            | 'original'
            | 'fixed_height_small',
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

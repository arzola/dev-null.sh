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
    klipy,
    giphy,
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

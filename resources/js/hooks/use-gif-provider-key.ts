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

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
                , connect it here, and every composer gains a GIF picker. One
                provider at a time; without a key the picker stays hidden.
            </p>
            {gifConnected && !editing ? (
                <div className="mt-4 flex flex-wrap items-center gap-3">
                    <p className="text-sm" data-test="gif-connected">
                        Connected to{' '}
                        {gifProviderFor(gifProvider ?? 'giphy').label}.
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
                                aria-pressed={candidate.id === providerId}
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

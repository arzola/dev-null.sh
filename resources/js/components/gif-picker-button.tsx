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

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

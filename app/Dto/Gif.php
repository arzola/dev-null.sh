<?php

declare(strict_types=1);

namespace App\Dto;

use App\Enums\GifProvider;

/** A GIF picked from a provider; URLs kept exactly as its API returned them. */
final readonly class Gif
{
    public function __construct(
        public GifProvider $provider,
        public string $id,
        public string $url,
        public string $pageUrl,
        public ?string $title,
        public ?string $username,
        public int $width,
        public int $height,
    ) {
        //
    }

    /**
     * @return array<string, string|int|null>
     */
    public function toColumns(): array
    {
        return [
            'gif_provider' => $this->provider->value,
            'gif_id' => $this->id,
            'gif_url' => $this->url,
            'gif_page_url' => $this->pageUrl,
            'gif_title' => $this->title,
            'gif_username' => $this->username,
            'gif_width' => $this->width,
            'gif_height' => $this->height,
        ];
    }
}

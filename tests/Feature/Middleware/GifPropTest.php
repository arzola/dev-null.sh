<?php

declare(strict_types=1);

use App\Enums\GifProvider;
use App\Enums\Log;
use App\Models\User;
use Inertia\Testing\AssertableInertia as Assert;

it('shares the connected provider and key with its owner', function (): void {
    $user = User::factory()->withGifKey(GifProvider::Klipy, 'klipy-key')->create();

    $this->actingAs($user)
        ->get(route('log.show', Log::Following))
        ->assertInertia(fn (Assert $page): Assert => $page
            ->where('gif.provider', 'klipy')
            ->where('gif.key', 'klipy-key'));
});

it('shares no gif config without a connected provider', function (): void {
    $this->actingAs(User::factory()->create())
        ->get(route('log.show', Log::Following))
        ->assertInertia(fn (Assert $page): Assert => $page->where('gif', null));
});

it('shares no gif config for guests', function (): void {
    $this->get(route('log.show', Log::Trending))
        ->assertInertia(fn (Assert $page): Assert => $page->where('gif', null));
});

it('shares no gif config when a provider has no key', function (?string $key): void {
    $user = User::factory()->create([
        'gif_provider' => GifProvider::Klipy,
        'gif_key' => $key,
    ]);

    $this->actingAs($user)
        ->get(route('log.show', Log::Following))
        ->assertInertia(fn (Assert $page): Assert => $page->where('gif', null));
})->with([null, '']);

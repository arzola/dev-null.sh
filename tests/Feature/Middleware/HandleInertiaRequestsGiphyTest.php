<?php

declare(strict_types=1);

use App\Enums\Log;
use App\Models\User;
use Inertia\Testing\AssertableInertia as Assert;

it('shares the giphy key when configured', function (): void {
    config(['services.giphy.key' => 'giphy-test']);

    $this->actingAs(User::factory()->create())
        ->get(route('log.show', Log::Following))
        ->assertInertia(fn (Assert $page): Assert => $page->where('giphy.key', 'giphy-test'));
});

it('shares no giphy config without a key', function (): void {
    config(['services.giphy.key' => null]);

    $this->actingAs(User::factory()->create())
        ->get(route('log.show', Log::Following))
        ->assertInertia(fn (Assert $page): Assert => $page->where('giphy', null));
});

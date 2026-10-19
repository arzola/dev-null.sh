<?php

declare(strict_types=1);

use App\Enums\GifProvider;
use App\Models\User;
use Illuminate\Support\Facades\DB;

it('stores a trimmed giphy key encrypted at rest', function (): void {
    $user = User::factory()->create();

    $this->actingAs($user)->fromRoute('user-profile.edit')
        ->put(route('gif-key.update'), ['provider' => 'giphy', 'key' => '  giphy-test-key  '])
        ->assertRedirectToRoute('user-profile.edit')
        ->assertInertiaFlash('toast', [
            'type' => 'success',
            'message' => 'GIPHY key connected.',
        ]);

    expect($user->refresh()->gif_key)->toBe('giphy-test-key')
        ->and(DB::table('users')->where('id', $user->id)->value('gif_key'))
        ->not->toContain('giphy-test-key');
});

it('replaces one provider with another atomically', function (): void {
    $user = User::factory()->withGifKey(GifProvider::Giphy, 'giphy-key')->create();

    $this->actingAs($user)->fromRoute('user-profile.edit')
        ->put(route('gif-key.update'), ['provider' => 'klipy', 'key' => 'klipy-key'])
        ->assertRedirectToRoute('user-profile.edit')
        ->assertInertiaFlash('toast', ['type' => 'success', 'message' => 'KLIPY key connected.']);

    expect($user->refresh())
        ->gif_provider->toBe(GifProvider::Klipy)
        ->gif_key->toBe('klipy-key');
});

it('removes the key', function (): void {
    $user = User::factory()->withGifKey()->create();

    $this->actingAs($user)->fromRoute('user-profile.edit')
        ->delete(route('gif-key.destroy'))
        ->assertRedirectToRoute('user-profile.edit')
        ->assertInertiaFlash('toast', [
            'type' => 'success',
            'message' => 'GIF provider removed.',
        ]);

    expect($user->refresh())
        ->gif_key->toBeNull()
        ->gif_provider->toBeNull();
});

it('rejects invalid providers without touching the stored one', function (array $payload): void {
    $user = User::factory()->withGifKey()->create();
    $field = in_array($payload['provider'] ?? null, ['giphy', 'klipy'], true) ? 'key' : 'provider';

    $this->actingAs($user)->putJson(route('gif-key.update'), $payload)
        ->assertUnprocessable()->assertJsonValidationErrors($field);

    expect($user->refresh()->gif_provider)->toBe(GifProvider::Giphy);
})->with([
    'missing provider' => [fn (): array => ['key' => 'x']],
    'unknown provider' => [fn (): array => ['provider' => 'tenor', 'key' => 'x']],
    'missing key' => [fn (): array => ['provider' => 'giphy']],
    'blank key' => [fn (): array => ['provider' => 'giphy', 'key' => '   ']],
    'non-string key' => [fn (): array => ['provider' => 'giphy', 'key' => ['x']]],
    'too long' => [fn (): array => ['provider' => 'giphy', 'key' => str_repeat('a', 256)]],
]);

it('requires authentication to connect a key', function (): void {
    $this->putJson(route('gif-key.update'), ['provider' => 'giphy', 'key' => 'giphy-test-key'])->assertUnauthorized();
});

it('requires authentication to remove a key', function (): void {
    $this->deleteJson(route('gif-key.destroy'))->assertUnauthorized();
});

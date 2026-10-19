<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Http\Requests\UpdateGifKeyRequest;
use App\Models\User;
use Illuminate\Container\Attributes\CurrentUser;
use Illuminate\Http\RedirectResponse;
use Inertia\Inertia;

final readonly class GifKeyController
{
    public function update(UpdateGifKeyRequest $request, #[CurrentUser] User $user): RedirectResponse
    {
        $provider = $request->provider();

        $user->update([
            'gif_provider' => $provider,
            'gif_key' => $request->string('key')->toString(),
        ]);

        Inertia::flash('toast', [
            'type' => 'success',
            'message' => $provider->label().' key connected.',
        ]);

        return back();
    }

    public function destroy(#[CurrentUser] User $user): RedirectResponse
    {
        $user->update(['gif_provider' => null, 'gif_key' => null]);

        Inertia::flash('toast', [
            'type' => 'success',
            'message' => 'GIF provider removed.',
        ]);

        return back();
    }
}

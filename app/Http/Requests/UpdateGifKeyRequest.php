<?php

declare(strict_types=1);

namespace App\Http\Requests;

use App\Enums\GifProvider;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Rules\Enum;

final class UpdateGifKeyRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function prepareForValidation(): void
    {
        $key = $this->input('key');

        if (is_string($key)) {
            $this->merge(['key' => mb_trim($key)]);
        }
    }

    /**
     * @return array<string, list<string|Enum>>
     */
    public function rules(): array
    {
        return [
            'provider' => ['required', 'string', Rule::enum(GifProvider::class)],
            'key' => ['required', 'string', 'max:255'],
        ];
    }

    public function provider(): GifProvider
    {
        return GifProvider::from($this->string('provider')->value());
    }
}

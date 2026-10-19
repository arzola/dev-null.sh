<?php

declare(strict_types=1);

namespace App\Http\Requests;

use App\Actions\CreateCommitImages;
use App\Dto\Gif;
use App\Enums\GifProvider;
use App\Models\Commit;
use App\Models\User;
use App\Rules\GifMediaUrl;
use App\Rules\GifPageUrl;
use App\Services\Urls;
use Illuminate\Auth\Access\Response;
use Illuminate\Contracts\Validation\ValidationRule;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Http\UploadedFile;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Rules\Dimensions;
use Illuminate\Validation\Rules\Enum;
use Illuminate\Validation\Rules\File;
use Illuminate\Validation\Rules\In;

final class CreateCommitReplyRequest extends FormRequest
{
    public function authorize(): Response
    {
        $user = $this->user();
        assert($user instanceof User);

        $commit = $this->route('commit');
        assert($commit instanceof Commit);

        return $commit->isVisibleTo($user) ? Response::allow() : Response::denyAsNotFound();
    }

    public function prepareForValidation(): void
    {
        CreateCommitRequest::normalizeBody($this);
    }

    /**
     * Images are checked by their contents, not their extension, and SVG is never accepted since it can carry scripts.
     *
     * @return array<string, array<int, string|ValidationRule|File|Dimensions|Enum|In>>
     */
    public function rules(): array
    {
        $body = $this->input('body');
        $provider = GifProvider::tryFrom($this->string('gif_provider')->value()) ?? GifProvider::Giphy;

        return [
            'body' => $this->hasFile('images') ? CreateCommitRequest::BODY_WITH_IMAGES_RULES : CreateCommitRequest::BODY_RULES,
            'link_preview_url' => ['nullable', 'string', Rule::in(is_string($body) ? resolve(Urls::class)->all($body) : [])],
            'images' => ['nullable', 'list', 'max:'.CreateCommitImages::MAX_IMAGES],
            'images.*' => [
                'required',
                'image',
                File::types(['image/jpeg', 'image/png', 'image/webp'])->max(CreateCommitImages::MAX_UPLOAD_SIZE),
                Rule::dimensions()
                    ->maxWidth(CreateCommitImages::MAX_SOURCE_DIMENSION)
                    ->maxHeight(CreateCommitImages::MAX_SOURCE_DIMENSION),
            ],
            'image_descriptions' => ['nullable', 'list', 'max:'.CreateCommitImages::MAX_IMAGES],
            'image_descriptions.*' => ['nullable', 'string', 'max:'.CreateCommitImages::MAX_DESCRIPTION_LENGTH],
            'gif_provider' => ['nullable', 'string', Rule::enum(GifProvider::class), 'required_with:gif_id'],
            'gif_id' => ['nullable', 'string', 'max:64', 'regex:/^[A-Za-z0-9-]+$/', 'prohibits:images,poll', 'required_with:gif_url'],
            'gif_url' => ['nullable', 'string', 'max:2048', 'required_with:gif_id', new GifMediaUrl($provider)],
            'gif_page_url' => ['nullable', 'string', 'max:2048', 'required_with:gif_id', new GifPageUrl($provider)],
            'gif_title' => ['nullable', 'string', 'max:300'],
            'gif_username' => ['nullable', 'string', 'max:100'],
            'gif_width' => ['nullable', 'integer', 'min:1', 'max:10000', 'required_with:gif_id'],
            'gif_height' => ['nullable', 'integer', 'min:1', 'max:10000', 'required_with:gif_id'],
        ];
    }

    /**
     * @return array<string, string>
     */
    public function attributes(): array
    {
        return [
            'image_descriptions.*' => 'image description',
        ];
    }

    /**
     * @return array<string, string>
     */
    public function messages(): array
    {
        return [
            'link_preview_url.in' => 'The link card must be one of the links in the body.',
        ];
    }

    /**
     * The first link in the body gets the link preview, unless the author chose another link or none at all.
     */
    public function linkPreview(): bool|string
    {
        if (! $this->has('link_preview_url')) {
            return true;
        }

        return $this->filled('link_preview_url') ? $this->string('link_preview_url')->value() : false;
    }

    /**
     * @return list<UploadedFile>
     */
    public function images(): array
    {
        $images = $this->file('images');

        return is_array($images) ? array_values($images) : [];
    }

    /**
     * @return list<string|null>
     */
    public function imageDescriptions(): array
    {
        /** @var list<string|null> $descriptions */
        $descriptions = $this->array('image_descriptions');

        return $descriptions;
    }

    public function gif(): ?Gif
    {
        if (! $this->filled('gif_id')) {
            return null;
        }

        return new Gif(
            GifProvider::from($this->string('gif_provider')->value()),
            $this->string('gif_id')->value(),
            $this->string('gif_url')->value(),
            $this->string('gif_page_url')->value(),
            $this->filled('gif_title') ? $this->string('gif_title')->value() : null,
            $this->filled('gif_username') ? $this->string('gif_username')->value() : null,
            $this->integer('gif_width'),
            $this->integer('gif_height'),
        );
    }
}

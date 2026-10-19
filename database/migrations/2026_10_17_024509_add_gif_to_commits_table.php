<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('commits', function (Blueprint $table): void {
            $table->string('gif_provider', 16)->nullable();
            $table->string('gif_id', 64)->nullable();
            $table->text('gif_url')->nullable();
            $table->text('gif_page_url')->nullable();
            $table->string('gif_title', 300)->nullable();
            $table->string('gif_username', 100)->nullable();
            $table->unsignedSmallInteger('gif_width')->nullable();
            $table->unsignedSmallInteger('gif_height')->nullable();
        });
    }
};

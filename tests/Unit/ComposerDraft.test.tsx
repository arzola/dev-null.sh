/// <reference types="node" />
import assert from 'node:assert/strict';
import * as React from 'react';
import type { ReactElement, ReactNode } from 'react';
import { beforeEach, test, vi } from 'vite-plus/test';
import type { GiphyAttachment } from '../../resources/js/lib/giphy';

const image = new File(['restored'], 'draft.png', { type: 'image/png' });
const gif: GiphyAttachment = {
    id: 'xT9IgzoKnwFNmISR8I',
    url: 'https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy-downsized-medium.gif?cid=abc',
    page_url: 'https://giphy.com/gifs/deal-with-it-xT9IgzoKnwFNmISR8I',
    title: 'Deal With It GIF',
    username: 'giphy',
    width: 480,
    height: 270,
};
let state: unknown[] = [];
let cursor = 0;
const draft = {
    body: 'A restored draft https://example.com',
    images: [] as File[],
    descriptions: [] as string[],
    gif: null as GiphyAttachment | null,
    isRestored: true,
    updateBody: vi.fn(),
    updateImages: vi.fn((images: File[], descriptions: string[]) => {
        draft.images = images;
        draft.descriptions = descriptions;
    }),
    updateGif: vi.fn((picked: GiphyAttachment | null) => {
        draft.gif = picked;
    }),
    drop: vi.fn(),
};
const user = { id: 'viewer', username: 'viewer', lane: 1 };

vi.doMock('react', () => ({
    ...React,
    useEffect: (effect: () => void) => effect(),
    useMemo: (factory: () => unknown) => factory(),
    useId: () => `preview-${cursor++}`,
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
        snapshot(),
    useRef: (initial: unknown) => {
        const index = cursor++;
        if (!(index in state)) {
            state[index] = { current: initial };
        }
        return state[index];
    },
    useState: (initial: unknown) => {
        const index = cursor++;
        if (!(index in state)) {
            state[index] = typeof initial === 'function' ? initial() : initial;
        }
        return [
            state[index],
            (value: unknown) => {
                state[index] =
                    typeof value === 'function' ? value(state[index]) : value;
            },
        ];
    },
}));
vi.doMock('@inertiajs/react', async () => ({
    ...(await vi.importActual('@inertiajs/react')),
    usePage: () => ({
        props: {
            auth: { user, isAdmin: false },
            giphy: { key: 'test' },
        },
    }),
    useHttp: () => ({ processing: false, transform: vi.fn(), submit: vi.fn() }),
}));
vi.doMock('../../resources/js/hooks/use-user', () => ({
    useUser: () => ({ user }),
}));
vi.doMock('../../resources/js/hooks/use-stash', () => ({
    useStash: () => draft,
    moveCaretToEnd: vi.fn(),
    discardSeriesStash: vi.fn(),
}));

const { CommitComposer } =
    await import('../../resources/js/components/commit-composer');
const { ImagePickerButton, ImagePickerPreviews } =
    await import('../../resources/js/components/commit-image-picker');
const { GiphyPickerButton } =
    await import('../../resources/js/components/giphy-picker-button');
const { ComposerPreviewBody, PreviewToggle } =
    await import('../../resources/js/components/composer-preview');
const { MentionTextarea } =
    await import('../../resources/js/components/mention-textarea');
const { LinkCardPicker } =
    await import('../../resources/js/components/link-card-picker');
const { PollEditor } =
    await import('../../resources/js/components/poll-editor');

type Element = ReactElement<Record<string, unknown>>;

function elements(node: ReactNode): Element[] {
    if (!React.isValidElement(node)) {
        return [];
    }
    const element = node as Element;
    if (typeof element.type === 'function' && element.props.stash === draft) {
        const renderPart = element.type as (
            props: typeof element.props,
        ) => ReactNode;
        return elements(renderPart(element.props));
    }
    return [
        element,
        ...React.Children.toArray(element.props.children as ReactNode).flatMap(
            elements,
        ),
    ];
}

function render() {
    cursor = 0;
    const form = CommitComposer();
    const fields = elements(
        form.props.children({ processing: false, errors: {} }),
    );
    return { form, fields };
}

beforeEach(() => {
    vi.clearAllMocks();
    state = [];
    draft.body = 'A restored draft https://example.com';
    draft.images = [];
    draft.descriptions = [];
    draft.gif = null;
});

test('preserves restored images and link cards while preventing scheduling', () => {
        draft.images = [image];
        draft.descriptions = ['A restored screenshot'];
        const { form, fields } = render();
        const data = {
            body: draft.body,
            link_preview_url: 'https://example.com',
        };
        assert.deepEqual(form.props.transform(data), {
            ...data,
            images: [image],
            image_descriptions: ['A restored screenshot'],
        });
        const preview = fields.find(
            (element) => element.type === ImagePickerPreviews,
        )!;
        assert.deepEqual(preview.props.images, [image]);
        const picker = fields.find(
            (element) => element.type === ImagePickerButton,
        )!;
        assert.equal(picker.props.count, 1);
        const schedule = fields.find(
            (element) => element.props['aria-controls'] === 'commit-schedule',
        )!;
        assert.equal(schedule.props.disabled, true);
        assert.equal(
            fields.find(
                (element) => element.props['data-test'] === 'add-poll-button',
            )!.props.disabled,
            true,
        );
        assert.equal(
            fields.filter((element) => element.type === LinkCardPicker).length,
            1,
        );

        form.props.onSuccess({ flash: {} });
        assert.equal(draft.drop.mock.calls.length, 0);
        assert.deepEqual(draft.images, [image]);
        vi.stubGlobal('requestAnimationFrame', vi.fn());
        try {
            form.props.onSuccess({ flash: { committed: { id: 'created' } } });
            assert.deepEqual(draft.images, []);
            assert.equal(draft.drop.mock.calls.length, 1);
        } finally {
            vi.unstubAllGlobals();
        }
});

test('removing restored images enables polls and successful posting resets the poll', () => {
    draft.images = [image];
    draft.descriptions = ['A restored screenshot'];
    let view = render();
    const preview = view.fields.find(
        (element) => element.type === ImagePickerPreviews,
    )!;
    (preview.props.onRemove as (index: number) => void)(0);
    view = render();
    const pollButton = view.fields.find(
        (element) => element.props['data-test'] === 'add-poll-button',
    )!;
    assert.equal(pollButton.props.disabled, false);

    vi.stubGlobal('requestAnimationFrame', vi.fn());
    try {
        (pollButton.props.onClick as () => void)();
        view = render();
        const editor = view.fields.find(
            (element) => element.type === PollEditor,
        )!;
        const submit = () =>
            view.fields.find(
                (element) =>
                    element.props['data-test'] === 'create-commit-button',
            )!;
        assert.equal(submit().props.disabled, true);
        assert.equal(
            view.fields.find((element) => element.type === ImagePickerButton)!
                .props.disabled,
            true,
        );
        assert.equal(
            view.fields.find(
                (element) =>
                    element.props['aria-controls'] === 'commit-schedule',
            )!.props.disabled,
            true,
        );
        const textarea = view.fields.find(
            (element) => element.type === MentionTextarea,
        )!;
        assert.equal(textarea.props.onPaste, undefined);
        assert.equal(textarea.props.onDrop, undefined);

        (editor.props.onChange as (poll: unknown) => void)({
            options: ['Tabs', 'Spaces'],
            duration: 1440,
        });
        view = render();
        assert.equal(submit().props.disabled, false);
        const data = {
            body: draft.body,
            poll: { options: ['Tabs', 'Spaces'], duration: 1440 },
        };
        assert.deepEqual(view.form.props.transform(data), data);
        view.form.props.onSuccess({ flash: {} });
        assert.equal(draft.drop.mock.calls.length, 0);
        assert.ok(
            render().fields.some((element) => element.type === PollEditor),
        );

        view.form.props.onSuccess({ flash: { committed: { id: 'created' } } });
        assert.equal(draft.drop.mock.calls.length, 1);
        assert.deepEqual(draft.images, []);
        view = render();
        assert.equal(
            view.fields.some((element) => element.type === PollEditor),
            false,
        );
        assert.equal(
            view.fields.find(
                (element) => element.props['data-test'] === 'add-poll-button',
            )!.props.disabled,
            false,
        );
    } finally {
        vi.unstubAllGlobals();
    }
});

test('schedules plain text in UTC and keeps pasted images visible until removed before scheduling', () => {
    let view = render();
    const schedule = view.fields.find(
        (element) => element.props['aria-controls'] === 'commit-schedule',
    )!;
    assert.equal(schedule.props.disabled, false);
    (schedule.props.onClick as () => void)();
    view = render();
    const date = '2026-10-17T10:30';
    const dateInput = view.fields.find(
        (element) => element.props.id === 'scheduled-at',
    )!;
    const setCustomValidity = vi.fn();
    (dateInput.props.onChange as (event: unknown) => void)({
        target: { value: date, setCustomValidity },
    });
    assert.deepEqual(setCustomValidity.mock.lastCall, ['']);
    view = render();
    assert.deepEqual(view.form.props.transform({ body: draft.body }), {
        body: draft.body,
        scheduled_at: new Date(date)
            .toISOString()
            .replace(/\.\d{3}Z$/, '+00:00'),
    });
    assert.equal(
        view.fields.some((element) => element.type === ImagePickerButton),
        false,
    );
    assert.equal(
        view.fields.some((element) => element.type === LinkCardPicker),
        false,
    );
    const textarea = view.fields.find(
        (element) => element.type === MentionTextarea,
    )!;
    const preventDefault = vi.fn();
    (textarea.props.onPaste as (event: unknown) => void)({
        clipboardData: { files: [image] },
        preventDefault,
    });
    assert.equal(preventDefault.mock.calls.length, 1);
    view = render();
    const submit = view.fields.find(
        (element) => element.props['data-test'] === 'create-commit-button',
    )!;
    assert.equal(submit.props.disabled, true);
    const preview = view.fields.find(
        (element) => element.type === ImagePickerPreviews,
    )!;
    assert.deepEqual(preview.props.images, [image]);
    assert.ok(
        view.fields.some(
            (element) =>
                element.props.message ===
                "Images can't be scheduled yet. Remove them to schedule this commit.",
        ),
    );
    (preview.props.onRemove as (index: number) => void)(0);
    view = render();
    assert.equal(
        view.fields.find(
            (element) => element.props['data-test'] === 'create-commit-button',
        )!.props.disabled,
        false,
    );
});

test('retains restored images while sensitive text requires explicit approval', () => {
    const token = 'ghp_' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zABCD';
    draft.body = token;
    draft.images = [image];
    draft.descriptions = ['A restored screenshot'];
    const { form, fields } = render();
    const warning = fields.find(
        (element) => (element.props.findings as unknown[] | undefined)?.length,
    )!;

    assert.equal(form.props.onBefore(), false);
    assert.equal(draft.drop.mock.calls.length, 0);
    assert.deepEqual(draft.images, [image]);
    (warning.props.onApprove as () => void)();
    assert.equal(form.props.onBefore(), true);
    assert.equal(form.props.onBefore(), false);
    assert.deepEqual(form.props.transform({ body: draft.body }), {
        body: draft.body,
        images: [image],
        image_descriptions: ['A restored screenshot'],
    });
});

test('previews restored images and descriptions while keeping them attached when returning to edit', () => {
    draft.images = [image];
    draft.descriptions = ['A restored screenshot'];
    let view = render();
    const toggle = view.fields.find(
        (element) => element.type === PreviewToggle,
    )!;
    (toggle.props.preview as { toggle: () => void }).toggle();
    view = render();
    const preview = view.fields.find(
        (element) => element.type === ComposerPreviewBody,
    )!;
    assert.deepEqual(preview.props.images, [image]);
    assert.deepEqual(preview.props.descriptions, ['A restored screenshot']);
    assert.equal(
        view.fields.some((element) => element.type === ImagePickerPreviews),
        false,
    );
    assert.equal(draft.updateImages.mock.calls.length, 0);
    const edit = view.fields.find((element) => element.type === PreviewToggle)!;
    (edit.props.preview as { toggle: () => void }).toggle();
    view = render();
    assert.deepEqual(
        view.fields.find((element) => element.type === ImagePickerPreviews)!
            .props.images,
        [image],
    );
    assert.deepEqual(view.form.props.transform({ body: draft.body }), {
        body: draft.body,
        images: [image],
        image_descriptions: ['A restored screenshot'],
    });
});

test('picking a gif clears attached images and any poll and submits the giphy fields', () => {
    draft.images = [image];
    draft.descriptions = ['A restored screenshot'];
    let view = render();
    vi.stubGlobal('requestAnimationFrame', vi.fn());
    try {
        (
            view.fields.find(
                (element) =>
                    element.props['data-test'] === 'add-poll-button',
            )!.props.onClick as () => void
        )();
        view = render();
        assert.equal(
            view.fields.some((element) => element.type === PollEditor),
            true,
        );
        const giphyButton = view.fields.find(
            (element) => element.type === GiphyPickerButton,
        )!;
        (giphyButton.props.onPick as (picked: GiphyAttachment) => void)(gif);
        assert.deepEqual(draft.images, []);
        assert.deepEqual(draft.descriptions, []);
        assert.equal(draft.gif, gif);
        view = render();
        assert.equal(
            view.fields.some((element) => element.type === PollEditor),
            false,
        );
        assert.deepEqual(view.form.props.transform({ body: draft.body }), {
            body: draft.body,
            giphy_id: 'xT9IgzoKnwFNmISR8I',
            giphy_url:
                'https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy-downsized-medium.gif?cid=abc',
            giphy_page_url:
                'https://giphy.com/gifs/deal-with-it-xT9IgzoKnwFNmISR8I',
            giphy_title: 'Deal With It GIF',
            giphy_username: 'giphy',
            giphy_width: 480,
            giphy_height: 270,
        });
    } finally {
        vi.unstubAllGlobals();
    }
});

test('attaching images while a gif is stashed clears the gif and submits the images instead', () => {
    draft.updateGif(gif);
    let view = render();
    const schedule = view.fields.find(
        (element) => element.props['aria-controls'] === 'commit-schedule',
    )!;
    assert.equal(schedule.props.disabled, true);
    assert.equal(
        schedule.props.title,
        "A commit with a GIF can't be scheduled yet",
    );
    (
        view.fields.find((element) => element.type === ImagePickerButton)!
            .props.onPick as (files: File[]) => void
    )([image]);
    assert.equal(draft.gif, null);
    view = render();
    assert.deepEqual(view.form.props.transform({ body: draft.body }), {
        body: draft.body,
        images: [image],
        image_descriptions: [''],
    });
});

test('a stashed gif never survives alongside restored images', () => {
    draft.images = [image];
    draft.descriptions = ['A restored screenshot'];
    draft.updateGif(gif);
    const view = render();
    assert.deepEqual(draft.updateGif.mock.lastCall, [null]);
    assert.equal(draft.gif, null);
    assert.deepEqual(view.form.props.transform({ body: draft.body }), {
        body: draft.body,
        images: [image],
        image_descriptions: ['A restored screenshot'],
    });
});

test('a gif stashed while scheduling blocks submit and never reaches the transform', () => {
    let view = render();
    (
        view.fields.find(
            (element) => element.props['aria-controls'] === 'commit-schedule',
        )!.props.onClick as () => void
    )();
    view = render();
    const date = '2026-10-17T10:30';
    const setCustomValidity = vi.fn();
    (
        view.fields.find((element) => element.props.id === 'scheduled-at')!
            .props.onChange as (event: unknown) => void
    )({
        target: { value: date, setCustomValidity },
    });
    view = render();
    draft.updateGif(gif);
    view = render();
    assert.equal(
        view.fields.find(
            (element) => element.props['data-test'] === 'create-commit-button',
        )!.props.disabled,
        true,
    );
    assert.deepEqual(view.form.props.transform({ body: draft.body }), {
        body: draft.body,
        scheduled_at: new Date(date)
            .toISOString()
            .replace(/\.\d{3}Z$/, '+00:00'),
    });
});

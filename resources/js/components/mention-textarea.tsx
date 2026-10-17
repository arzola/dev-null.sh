import type { ComponentProps, KeyboardEvent, Ref, SyntheticEvent } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import MentionSuggestionController from '@/actions/App/Http/Controllers/MentionSuggestionController';
import {
    CaretMenuList,
    CaretMenuPortal,
    handleCaretMenuKeydown,
} from '@/components/caret-menu';
import { Spinner } from '@/components/ui/spinner';
import { UserAvatar } from '@/components/user-avatar';
import { caretMenuPosition } from '@/lib/caret-position';
import type { CaretMenuPosition } from '@/lib/caret-position';
import { caretToken } from '@/lib/caret-token';
import { emojifyInput } from '@/lib/emoji';
import { toastWhenThrottled } from '@/lib/throttle';
import { characterCount, cn, laneColor, limitCharacters } from '@/lib/utils';
import type { User } from '@/types';

type Mention = {
    start: number;
    query: string;
};

type Suggestions = {
    query: string;
    users: User[];
};

const debounce = 120;
const menuWidth = 288;
const mentionMenuHeight = 320;
const mentionMenu = { width: menuWidth, height: mentionMenuHeight };
const cache = new Map<string, User[]>();

async function fetchSuggestions(
    query: string,
    signal: AbortSignal,
): Promise<User[]> {
    const response = await fetch(
        MentionSuggestionController.index({ query: { q: query } }).url,
        {
            headers: {
                Accept: 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
            },
            signal,
        },
    );

    if (!response.ok) {
        toastWhenThrottled(response);

        throw new Error('Unable to load suggestions');
    }

    const data = (await response.json()) as { users: User[] };
    cache.set(query.toLowerCase(), data.users);

    return data.users;
}

function Highlighted({ text, query }: { text: string; query: string }) {
    const index = query === '' ? -1 : text.toLowerCase().indexOf(query);

    if (index === -1) {
        return text;
    }

    return (
        <>
            {text.slice(0, index)}
            <span className="text-foreground">
                {text.slice(index, index + query.length)}
            </span>
            {text.slice(index + query.length)}
        </>
    );
}

/**
 * A textarea that suggests developers to mention as soon as "@" is typed, right under the "@", and turns emoji
 * shortcodes into emoji as they are typed.
 */
export function MentionTextarea({
    ref,
    value,
    onValueChange,
    onKeyDown,
    onSelect,
    onBlur,
    maxLength,
    ...props
}: Omit<ComponentProps<'textarea'>, 'value' | 'onChange'> & {
    ref?: Ref<HTMLTextAreaElement>;
    value: string;
    onValueChange: (value: string) => void;
}) {
    const id = useId();
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [mention, setMention] = useState<Mention | null>(null);
    const [position, setPosition] = useState<CaretMenuPosition | null>(null);
    const [results, setResults] = useState<Suggestions | null>(null);
    const [activeIndex, setActiveIndex] = useState(0);

    const query = mention?.query.toLowerCase() ?? null;

    const setRefs = (element: HTMLTextAreaElement | null) => {
        textareaRef.current = element;

        if (typeof ref === 'function') {
            ref(element);
        } else if (ref) {
            ref.current = element;
        }
    };

    const close = () => {
        setMention(null);
        setPosition(null);
    };

    const track = (textarea: HTMLTextAreaElement) => {
        const token = caretToken(textarea);
        const next =
            token?.kind === 'mention'
                ? { start: token.start, query: token.query }
                : null;

        if (!next) {
            close();

            return;
        }

        if (next.start !== mention?.start || next.query !== mention.query) {
            setActiveIndex(0);
        }

        setMention(next);
        setPosition(caretMenuPosition(textarea, next.start, mentionMenu));
    };

    useEffect(() => {
        if (query === null || cache.has(query)) {
            return;
        }

        const controller = new AbortController();
        const timeout = setTimeout(
            () =>
                fetchSuggestions(query, controller.signal)
                    .then((users) => setResults({ query, users }))
                    .catch(() => undefined),
            query === '' ? 0 : debounce,
        );

        return () => {
            clearTimeout(timeout);
            controller.abort();
        };
    }, [query]);

    useEffect(() => {
        if (!mention) {
            return;
        }

        const reposition = () => {
            if (textareaRef.current) {
                setPosition(
                    caretMenuPosition(
                        textareaRef.current,
                        mention.start,
                        mentionMenu,
                    ),
                );
            }
        };

        window.addEventListener('scroll', reposition, {
            capture: true,
            passive: true,
        });
        window.addEventListener('resize', reposition);

        return () => {
            window.removeEventListener('scroll', reposition, {
                capture: true,
            });
            window.removeEventListener('resize', reposition);
        };
    }, [mention]);

    const cached = query === null ? undefined : cache.get(query);
    const current =
        query !== null && cached ? { query, users: cached } : results;
    const suggestions =
        query !== null && current?.query === query ? current.users : [];
    const isOpen =
        mention !== null &&
        position !== null &&
        (suggestions.length > 0 || query !== '');

    const select = (user: User) => {
        const textarea = textareaRef.current;

        if (!textarea || !mention) {
            return;
        }

        const caret = mention.start + 1 + mention.query.length;
        const after = value.slice(caret);
        const handle = `@${user.username}`;
        const separator = /^\s/u.test(after) ? '' : ' ';
        let next = `${value.slice(0, mention.start)}${handle}${separator}${after}`;

        if (maxLength !== undefined && characterCount(next) > maxLength) {
            next = `${value.slice(0, mention.start)}${handle}${after}`;
        }

        if (maxLength !== undefined && characterCount(next) > maxLength) {
            close();

            return;
        }

        const nextCaret = mention.start + handle.length + 1;

        onValueChange(next);
        close();

        requestAnimationFrame(() => {
            textarea.focus();
            textarea.setSelectionRange(
                Math.min(nextCaret, next.length),
                Math.min(nextCaret, next.length),
            );
        });
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (
            isOpen &&
            handleCaretMenuKeydown(event, {
                count: suggestions.length,
                activeIndex,
                setActiveIndex,
                onSelect: (index) => {
                    const user = suggestions[index];

                    if (user) {
                        select(user);
                    }
                },
                onClose: close,
            })
        ) {
            return;
        }

        onKeyDown?.(event);
    };

    const activeId = isOpen
        ? suggestions[activeIndex] &&
          `${id}-mention-${suggestions[activeIndex].id}`
        : undefined;

    const isSearching = current?.query !== query;

    return (
        <>
            <textarea
                {...props}
                ref={setRefs}
                value={value}
                onChange={(event) => {
                    const target = event.currentTarget;
                    const { text, caret } = emojifyInput(
                        target.value,
                        target.selectionStart ?? target.value.length,
                    );

                    const limited =
                        maxLength === undefined
                            ? text
                            : limitCharacters(text, maxLength);

                    onValueChange(limited);

                    if (limited === target.value) {
                        track(target);

                        return;
                    }

                    close();
                    requestAnimationFrame(() => {
                        const position = Math.min(caret, limited.length);
                        target.setSelectionRange(position, position);
                    });
                }}
                onSelect={(event: SyntheticEvent<HTMLTextAreaElement>) => {
                    track(event.currentTarget);
                    onSelect?.(event);
                }}
                onBlur={(event) => {
                    close();
                    onBlur?.(event);
                }}
                onKeyDown={handleKeyDown}
                aria-autocomplete="list"
                aria-controls={isOpen ? `${id}-mentions` : undefined}
                aria-activedescendant={activeId}
            />

            {isOpen && position && (
                <CaretMenuPortal
                    marker="mention"
                    position={position}
                    testId="mention-suggestions"
                >
                    {suggestions.length > 0 ? (
                        <CaretMenuList
                            id={`${id}-mentions`}
                            label="Mention a developer"
                            activeIndex={activeIndex}
                        >
                            {current?.query === '' && (
                                <li
                                    role="presentation"
                                    className="px-2.5 pt-1 pb-1.5 text-xs text-muted-foreground"
                                >
                                    People you follow
                                </li>
                            )}
                            {suggestions.map((user, index) => (
                                <li
                                    key={user.id}
                                    id={`${id}-mention-${user.id}`}
                                    role="option"
                                    aria-selected={index === activeIndex}
                                    onMouseMove={() => setActiveIndex(index)}
                                    onClick={() => select(user)}
                                    className={cn(
                                        'flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2',
                                        {
                                            'bg-accent': index === activeIndex,
                                        },
                                    )}
                                    data-test="mention-suggestion"
                                >
                                    <UserAvatar
                                        user={user}
                                        className="size-8 shrink-0"
                                    />
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-sm font-semibold">
                                            <Highlighted
                                                text={user.name}
                                                query={query ?? ''}
                                            />
                                        </span>
                                        <span className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
                                            <span
                                                aria-hidden
                                                className="size-1.5 shrink-0 rounded-full"
                                                style={{
                                                    background: laneColor(
                                                        user.lane,
                                                    ),
                                                }}
                                            />
                                            <span className="truncate">
                                                @
                                                <Highlighted
                                                    text={user.username}
                                                    query={query ?? ''}
                                                />
                                            </span>
                                        </span>
                                    </span>
                                    <kbd
                                        aria-hidden
                                        className={cn(
                                            'hidden shrink-0 font-mono text-xs text-muted-foreground opacity-0 sm:block',
                                            {
                                                'opacity-100':
                                                    index === activeIndex,
                                            },
                                        )}
                                    >
                                        ↵
                                    </kbd>
                                </li>
                            ))}
                        </CaretMenuList>
                    ) : (
                        <div
                            role="status"
                            className="px-4 py-3 text-sm text-muted-foreground"
                        >
                            {isSearching ? (
                                <span className="flex items-center gap-2">
                                    <Spinner className="size-3.5" />
                                    Searching…
                                </span>
                            ) : (
                                <span className="font-mono text-[13px]">
                                    fatal: no developers match '{mention?.query}
                                    '
                                </span>
                            )}
                        </div>
                    )}
                </CaretMenuPortal>
            )}
        </>
    );
}

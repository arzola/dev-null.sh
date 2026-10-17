// The "@handle" being typed right before the caret. Keep the rules in sync with app/Services/Mentions.php.
const mentionBeforeCaretPattern =
    /(?:^|[^\p{L}\p{N}_./@-])@([A-Za-z0-9][A-Za-z0-9-]{0,38}|)$/u;

// The "/command" being typed right before the caret, at the start of the body or after whitespace.
const slashBeforeCaretPattern = /(?:^|\s)\/([a-z-]*)$/;

export type CaretToken = {
    kind: 'mention' | 'slash';
    start: number;
    query: string;
};

export type TextareaLike = {
    value: string;
    selectionStart: number;
    selectionEnd: number;
};

/**
 * The token ("@handle" or "/command") being typed right before a collapsed caret, if any.
 */
export function caretToken(textarea: TextareaLike): CaretToken | null {
    if (textarea.selectionStart !== textarea.selectionEnd) {
        return null;
    }

    const before = textarea.value.slice(0, textarea.selectionStart);
    const mention = before.match(mentionBeforeCaretPattern);

    if (mention) {
        return {
            kind: 'mention',
            start: textarea.selectionStart - mention[1].length - 1,
            query: mention[1],
        };
    }

    const slash = before.match(slashBeforeCaretPattern);

    if (slash) {
        return {
            kind: 'slash',
            start: textarea.selectionStart - slash[1].length - 1,
            query: slash[1],
        };
    }

    return null;
}

// Syntax highlighting lexer for the KLATTSCH editor overlay.
//
// Mirrors the token grammar of src/KlattschParser.cpp (ClassifyPart/Tokenize)
// but operates on the raw editor text so spans line up with what the textarea
// displays, and emits every byte of input (tokens, whitespace, comments) as
// DOM nodes for a backdrop element. Adapted from tgies/klattsch (highlight.js)
// for SharpVox: no bank switching, fixed phoneme set, optional slur prefix.
(function () {
    const PAUSE_WORDS = new Set([',', ';', '.']);

    // Compact directive letters and the families they color into:
    // pitch, timing, formant scale, modulation, voice quality.
    const DIRECTIVE_LETTERS = new Set(['b', 'r', 'p', 's', 'v', 'w', 'm', 'n', 'h', 't', 'g']);
    const LETTER_FAMILY = {
        b: 'pitch',
        r: 'time', p: 'time',
        s: 'scale',
        v: 'mod', w: 'mod', m: 'mod', n: 'mod',
        h: 'voice', t: 'voice', g: 'voice',
    };
    const KEY_FAMILY = {
        base: 'pitch',
        rate: 'time', pause: 'time',
        scale: 'scale',
        vibrato: 'mod', vibratoRate: 'mod', tremolo: 'mod', tremoloRate: 'mod',
        aspiration: 'voice', tilt: 'voice', effort: 'voice',
    };

    // Phoneme codes the engine accepts as plain uppercase tokens (see
    // LookupKlattschPhoneme); JP_* and the underscore SIL never appear as
    // bare uppercase runs so they are intentionally excluded here.
    const PHONEME_SET = new Set([
        'IY', 'IH', 'EH', 'AE', 'AA', 'AO', 'AH', 'UH', 'UW', 'ER',
        'AY', 'AW', 'EY', 'OW', 'OY',
        'W', 'Y', 'R', 'L', 'M', 'N', 'NG', 'HH',
        'F', 'TH', 'S', 'SH', 'V', 'DH', 'Z', 'ZH',
        'P', 'B', 'T', 'D', 'K', 'G', 'CH', 'JH',
        'AX', 'IX', 'YU', 'RX', 'LX', 'EL', 'EN', 'DX', 'TX',
        'A', 'I', 'U', 'E', 'O',
    ]);

    function dirCls(family) {
        return family ? `hl-directive hl-d-${family}` : 'hl-directive';
    }
    function valCls(family) {
        return family ? `hl-value hl-v-${family}` : 'hl-value';
    }

    const RE_BRACKET = /^\[(\w+)=(-?\d+(?:\.\d+)?)\]$/;
    const RE_NOTE = /^(b)(=?)([A-G][b#]?-?\d+)$/;
    const RE_COMPACT = /^([a-z])((=)?(([+-])?\d+(?:\.\d+)?))?$/;
    // optional [-^] slur, uppercase code, optional ['!] stress, optional delta.
    const RE_PHONEME = /^([-^]?)([A-Z]+)(['!]?)(\([+-]?\d+(?:\.\d+)?\)|[+-]\d+(?:\.\d+)?)?$/;

    function span(cls, text) {
        const el = document.createElement('span');
        el.className = cls;
        el.textContent = text;
        return el;
    }

    // Classify one whitespace-delimited part into a list of [class, text] pieces.
    function classify(part) {
        if (part === '(' || part === ')') return [['hl-paren', part]];
        if (PAUSE_WORDS.has(part)) return [['hl-pause', part]];
        if (part === '!' || part === "'") return [['hl-stress', part]];

        const bracket = part.match(RE_BRACKET);
        if (bracket) {
            const fam = KEY_FAMILY[bracket[1]];
            return [
                [dirCls(fam), '[' + bracket[1] + '='],
                [valCls(fam), bracket[2]],
                [dirCls(fam), ']'],
            ];
        }

        const note = part.match(RE_NOTE);
        if (note && /^[A-G]/.test(note[3])) {
            return [
                [dirCls('pitch'), note[1] + note[2]],
                [valCls('pitch'), note[3]],
            ];
        }

        const compact = part.match(RE_COMPACT);
        if (compact && DIRECTIVE_LETTERS.has(compact[1])) {
            const [, letter, rest] = compact;
            const fam = LETTER_FAMILY[letter];
            if (rest === undefined) {
                // Bare letter: reset directive (bare `p` is dropped by the engine).
                return [[dirCls(fam), letter]];
            }
            return [
                [dirCls(fam), letter],
                [valCls(fam), rest],
            ];
        }

        const phoneme = part.match(RE_PHONEME);
        if (phoneme) {
            const [, slur, code, stress, delta] = phoneme;
            const known = PHONEME_SET.has(code);
            const pieces = [];
            if (slur) pieces.push(['hl-slur', slur]);
            pieces.push([known ? 'hl-phoneme' : 'hl-badphoneme', code]);
            if (stress) pieces.push(['hl-stress', stress]);
            if (delta) pieces.push([delta.startsWith('(') ? 'hl-transient' : 'hl-pitch', delta]);
            return pieces;
        }

        return [['hl-unknown', part]];
    }

    // Build a DocumentFragment of highlight spans covering every character of
    // `source`.
    function buildHighlight(source) {
        const frag = document.createDocumentFragment();
        const len = source.length;

        let i = 0;
        let plainStart = 0; // start of pending whitespace run

        const flushPlain = (end) => {
            if (end > plainStart) frag.appendChild(document.createTextNode(source.slice(plainStart, end)));
        };

        const blockEnd = (start) => {
            const end = source.indexOf('*/', start + 2);
            return end === -1 ? len : end + 2;
        };

        while (i < len) {
            const c = source[i];
            if (/\s/.test(c)) { i++; continue; }

            // Line comment: # at start of input or after whitespace.
            if (c === '#' && (i === 0 || /\s/.test(source[i - 1]))) {
                flushPlain(i);
                const start = i;
                while (i < len && source[i] !== '\n') i++;
                frag.appendChild(span('hl-comment', source.slice(start, i)));
                plainStart = i;
                continue;
            }

            // Block comment between tokens.
            if (c === '/' && source[i + 1] === '*') {
                flushPlain(i);
                const start = i;
                i = blockEnd(i);
                frag.appendChild(span('hl-comment', source.slice(start, i)));
                plainStart = i;
                continue;
            }

            // Token: runs to next whitespace; an embedded /* ... */ splits it into
            // segments that the engine concatenates back together.
            flushPlain(i);
            const segments = [];
            let segStart = i;
            let part = '';
            while (i < len && !/\s/.test(source[i])) {
                if (source[i] === '/' && source[i + 1] === '*') {
                    if (i > segStart) segments.push({ start: segStart, end: i, comment: false });
                    const ce = blockEnd(i);
                    segments.push({ start: i, end: ce, comment: true });
                    i = ce;
                    segStart = i;
                    continue;
                }
                part += source[i];
                i++;
            }
            if (i > segStart) segments.push({ start: segStart, end: i, comment: false });
            plainStart = i;
            if (!part) {
                for (const seg of segments) {
                    frag.appendChild(span('hl-comment', source.slice(seg.start, seg.end)));
                }
                continue;
            }

            const pieces = classify(part);
            // Distribute classified pieces across non-comment segments in order.
            let pi = 0;          // current piece
            let consumed = 0;    // chars of current piece already emitted
            for (const seg of segments) {
                if (seg.comment) {
                    frag.appendChild(span('hl-comment', source.slice(seg.start, seg.end)));
                    continue;
                }
                let pos = seg.start;
                while (pos < seg.end && pi < pieces.length) {
                    const [cls, text] = pieces[pi];
                    const take = Math.min(seg.end - pos, text.length - consumed);
                    frag.appendChild(span(cls, source.slice(pos, pos + take)));
                    pos += take;
                    consumed += take;
                    if (consumed >= text.length) { pi++; consumed = 0; }
                }
                if (pos < seg.end) frag.appendChild(document.createTextNode(source.slice(pos, seg.end)));
            }
        }
        flushPlain(len);

        // Trailing sentinel so the backdrop keeps height parity with the
        // textarea when the text ends in a newline.
        frag.appendChild(document.createTextNode('\n'));
        return frag;
    }

    window.KlattschHighlight = { build: buildHighlight };
}());

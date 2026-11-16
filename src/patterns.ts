export type CompiledPattern = {
  /** The line exactly as the moderator wrote it. */
  source: string;
  regex: RegExp;
};

export type PatternError = {
  line: number;
  source: string;
  message: string;
};

const SLASH_FORM = /^\/(.+)\/([a-z]*)$/s;
const VALID_FLAGS = /^[dgimsuvy]*$/;

/**
 * Turns one settings line into a RegExp.
 *  - `/pattern/flags` uses the flags given.
 *  - anything else is a bare pattern, matched case-insensitively.
 * `g` and `y` are dropped: they make `.test()` stateful and add nothing here.
 *
 * Throws on anything that must not be used: invalid syntax, and patterns that
 * match empty text (they would match, and so ban, every sender).
 */
export function compileLine(line: string): RegExp {
  let regex: RegExp;
  const slash = SLASH_FORM.exec(line);
  if (slash) {
    const flags = slash[2]!;
    if (!VALID_FLAGS.test(flags)) {
      throw new Error(
        `it looks like /pattern/flags, but "${flags}" are not regex flags. ` +
          'To match text that starts with a slash, begin the line with \\/',
      );
    }
    regex = new RegExp(slash[1]!, flags.replace(/[gy]/g, ''));
  } else {
    regex = new RegExp(line, 'i');
  }
  if (regex.test('')) {
    throw new Error('it matches empty text, so it would match every message');
  }
  return regex;
}

/** Parses the multi-line `patterns` setting. Blank lines and `#` comments are skipped. */
export function parsePatterns(raw: string | undefined): {
  patterns: CompiledPattern[];
  errors: PatternError[];
} {
  const patterns: CompiledPattern[] = [];
  const errors: PatternError[] = [];

  (raw ?? '').split(/\r?\n/).forEach((rawLine, index) => {
    const source = rawLine.trim();
    if (!source || source.startsWith('#')) return;
    try {
      patterns.push({ source, regex: compileLine(source) });
    } catch (err) {
      errors.push({
        line: index + 1,
        source,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return { patterns, errors };
}

/** Returns the first pattern that matches any of the given texts. */
export function findMatch(
  patterns: CompiledPattern[],
  texts: string[],
): { pattern: CompiledPattern; matched: string } | undefined {
  for (const pattern of patterns) {
    for (const text of texts) {
      const hit = pattern.regex.exec(text);
      if (hit) return { pattern, matched: hit[0] };
    }
  }
  return undefined;
}

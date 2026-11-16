import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileLine, findMatch, parsePatterns } from '../src/patterns.ts';

test('bare patterns are case-insensitive', () => {
  assert.ok(compileLine('buy followers').test('BUY FOLLOWERS now'));
});

test('/pattern/flags keeps its own flags and drops g/y', () => {
  const re = compileLine('/Free Karma/g');
  assert.equal(re.flags, '');
  assert.ok(re.test('Free Karma'));
  assert.ok(!re.test('free karma'));
  assert.equal(compileLine(String.raw`/t\.me\/\w+/i`).exec('join T.ME/spam')?.[0], 'T.ME/spam');
});

test('blank lines and # comments are skipped, bad lines reported with line numbers', () => {
  const { patterns, errors } = parsePatterns('# spam\n\nfoo\r\n  (unclosed  \n/bar/i');
  assert.deepEqual(patterns.map((p) => p.source), ['foo', '/bar/i']);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.line, 4);
});

test('findMatch returns the first matching pattern and the matched text', () => {
  const { patterns } = parsePatterns('nope\n' + String.raw`crypto\s+giveaway`);
  const hit = findMatch(patterns, ['subject', 'huge Crypto  Giveaway today']);
  assert.equal(hit?.pattern.source, String.raw`crypto\s+giveaway`);
  assert.equal(hit?.matched, 'Crypto  Giveaway');
  assert.equal(findMatch(patterns, ['hello there']), undefined);
});

test('patterns that match empty text are rejected, since they would ban every sender', () => {
  for (const line of ['spam|scam|', '.*', 'a*', '(spam)?', '/x*/i', '^', '|']) {
    const { patterns, errors } = parsePatterns(line);
    assert.equal(patterns.length, 0, `${line} must not be usable`);
    assert.match(errors[0]?.message ?? '', /empty text/, line);
  }
  assert.equal(parsePatterns('spam|scam').patterns.length, 1);
  assert.equal(parsePatterns('(?=spam)').patterns.length, 1, 'zero-width but not empty-matching');
});

test('a slash-path that is not a regex literal gets a clear error, not a silent change', () => {
  const { patterns, errors } = parsePatterns('/promo/deals');
  assert.equal(patterns.length, 0);
  assert.match(errors[0]?.message ?? '', /not regex flags/);
  assert.ok(compileLine(String.raw`\/promo\/deals`).test('see /PROMO/deals'));
  assert.throws(() => compileLine('/x/ii'), /flags/i, 'duplicate flags still fail');
});

test('empty or missing setting yields no patterns', () => {
  assert.deepEqual(parsePatterns(undefined), { patterns: [], errors: [] });
  assert.deepEqual(parsePatterns('  \n'), { patterns: [], errors: [] });
});

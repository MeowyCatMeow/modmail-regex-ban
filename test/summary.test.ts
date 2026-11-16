// The summary modmail: what is stored, when it is due, and what it says.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { fake } from './fake-devvit.ts';

const { buildSummary, periodEnd, recordAction, runSummary } = await import('../src/summary.ts');
const { DEFAULT_RECURRING_MESSAGE, parseUsernames, readConfig } = await import('../src/config.ts');

const utc = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);
const at = (iso: string, hour = 13): number => utc(iso) + hour * 3_600_000;
const entry = (t: number, u = 'spammer', p = 'buy followers', o = ['Banned (permanently)', 'Muted for 28 days']) => ({
  t,
  u,
  p,
  o,
  c: 'c1',
});
const sent = () => fake.calls.filter((c) => c.method === 'createModNotification').map((c) => c.args as Record<string, string>);

beforeEach(() => fake.reset());

test('settings: defaults, and select values that arrive as arrays', () => {
  const defaults = readConfig({});
  assert.equal(defaults.muteHours, 672);
  assert.equal(defaults.permanent, 'off');
  assert.equal(defaults.archive, true, 'matching modmails are archived unless turned off');
  assert.equal(defaults.summary, 'week');
  assert.equal(defaults.banDays, 0);

  const recurring = readConfig({ muteDuration: ['permanent'] });
  assert.deepEqual([recurring.muteHours, recurring.permanent], [672, 'recurring']);
  const archive = readConfig({ muteDuration: ['permanent-archive'] });
  assert.deepEqual([archive.muteHours, archive.permanent], [672, 'archive']);
  assert.equal(readConfig({ muteDuration: ['permanent'], muteEnabled: false }).permanent, 'off', 'no muting, no list');
  assert.equal(readConfig({ muteDuration: ['72'] }).muteHours, 72);
  assert.equal(readConfig({ muteDuration: '168' }).muteHours, 168);
  assert.equal(readConfig({ muteDuration: ['bogus'] }).muteHours, 672);
  assert.equal(readConfig({ muteDuration: [] }).muteHours, 672);
  assert.equal(readConfig({ muteDuration: ['72'] }).permanent, 'off');
  for (const frequency of ['off', 'week', 'month', 'year'] as const) {
    assert.equal(readConfig({ summaryFrequency: [frequency] }).summary, frequency);
  }
  assert.equal(readConfig({ summaryFrequency: ['bogus'] }).summary, 'week');
  // Ban length is a list of choices; anything else means a permanent ban.
  assert.equal(readConfig({ banLength: ['permanent'] }).banDays, 0);
  for (const days of [1, 3, 7, 14, 30, 60, 90, 180, 365]) {
    assert.equal(readConfig({ banLength: [String(days)] }).banDays, days);
  }
  for (const odd of [['2'], ['0'], ['-7'], ['1000'], ['soon'], [], undefined]) {
    assert.equal(readConfig({ banLength: odd }).banDays, 0, JSON.stringify(odd));
  }

  // The one-time message about renewal notices.
  assert.equal(defaults.recurringMessage, DEFAULT_RECURRING_MESSAGE);
  assert.equal(readConfig({ recurringMuteTip: false }).recurringMessage, '');
  assert.equal(readConfig({ recurringMuteMessage: '  hi  ' }).recurringMessage, 'hi');
  assert.equal(readConfig({ recurringMuteMessage: 'x'.repeat(5000) }).recurringMessage.length, 2000);
});

test('exempt list: accepts name, u/name and /u/name, any separators; reports what is not a username', () => {
  assert.deepEqual(parseUsernames('Alice\nu/Bob, /u/carol_1  dave-2'), {
    names: ['alice', 'bob', 'carol_1', 'dave-2'],
    invalid: [],
  });
  assert.deepEqual(parseUsernames('ok_name\nnot a name!\nab'), {
    names: ['ok_name', 'not'],
    invalid: ['a', 'name!', 'ab'],
  });
  assert.deepEqual(parseUsernames('x!y').invalid, ['x!y']);
  assert.deepEqual(parseUsernames('ab').invalid, ['ab'], 'too short');
  assert.deepEqual(parseUsernames(undefined), { names: [], invalid: [] });
});

test('a period is 7 days, a calendar month or a calendar year', () => {
  assert.equal(periodEnd(utc('2026-11-16'), 'week'), utc('2026-11-23'));
  assert.equal(periodEnd(utc('2026-11-16'), 'month'), utc('2026-12-16'));
  assert.equal(periodEnd(utc('2026-12-16'), 'month'), utc('2027-01-16'));
  assert.equal(periodEnd(utc('2026-01-31'), 'month'), utc('2026-02-28'), 'no 31 February');
  assert.equal(periodEnd(utc('2026-11-16'), 'year'), utc('2027-11-16'));
  assert.equal(periodEnd(utc('2028-02-29'), 'year'), utc('2029-02-28'), 'leap day');
});

test('weekly: nothing on the first run, nothing before the week is up, then one summary', async () => {
  fake.settings = {};
  assert.equal(await runSummary(at('2026-11-16')), 'started');
  await recordAction(entry(at('2026-11-17', 9)));
  await recordAction(entry(at('2026-11-19', 9), 'other_user', '/t\\.me\\/\\w+/i', ['Muted for 28 days']));

  for (const day of ['2026-11-17', '2026-11-20', '2026-11-22']) {
    assert.equal(await runSummary(at(day)), 'not-due', day);
  }
  assert.deepEqual(sent(), []);

  assert.equal(await runSummary(at('2026-11-23')), 'sent');
  assert.equal(sent().length, 1);
  const { subject, bodyMarkdown, subredditId } = sent()[0]!;
  assert.equal(subject, 'Modmail Regex Ban: summary for the past week');
  assert.equal(subredditId, 't5_testsub');
  assert.match(bodyMarkdown!, /Between 2026-11-16 and 2026-11-23, Modmail Regex Ban acted on \*\*2\*\* modmail messages\./);
  assert.match(bodyMarkdown!, /\* 1 × matched `buy followers`/);
  assert.match(
    bodyMarkdown!,
    /\* 2026-11-19 – u\/other_user – matched `\/t\\\.me\\\/\\w\+\/i` – Muted for 28 days – \[open\]\(https:\/\/mod\.reddit\.com\/mail\/perma\/c1\)/,
  );
  assert.ok(bodyMarkdown!.indexOf('u/other_user') < bodyMarkdown!.indexOf('u/spammer'), 'newest first');

  // The slate is clean and the next week starts on the same weekday.
  assert.equal(fake.zsets.get('summary:log'), undefined);
  assert.equal(await runSummary(at('2026-11-29')), 'not-due');
  assert.equal(await runSummary(at('2026-11-30')), 'nothing-happened');
  assert.equal(sent().length, 1, 'no modmail for a quiet week');
});

test('monthly and yearly use the same daily check with a longer period', async () => {
  fake.settings = { summaryFrequency: ['month'] };
  await runSummary(at('2026-11-16'));
  await recordAction(entry(at('2026-11-20')));
  assert.equal(await runSummary(at('2026-11-23')), 'not-due', 'a week is not a month');
  assert.equal(await runSummary(at('2026-12-15')), 'not-due');
  assert.equal(await runSummary(at('2026-12-16')), 'sent');
  assert.equal(sent()[0]!.subject, 'Modmail Regex Ban: summary for the past month');

  fake.reset();
  fake.settings = { summaryFrequency: ['year'] };
  await runSummary(at('2026-11-16'));
  await recordAction(entry(at('2026-12-01')));
  assert.equal(await runSummary(at('2027-06-01')), 'not-due');
  assert.equal(await runSummary(at('2027-11-16')), 'sent');
  assert.equal(sent()[0]!.subject, 'Modmail Regex Ban: summary for the past year');
});

test('a missed day does not lose the summary; it goes out on the next run', async () => {
  fake.settings = {};
  await runSummary(at('2026-11-16'));
  await recordAction(entry(at('2026-11-18')));
  assert.equal(await runSummary(at('2026-11-26')), 'sent', 'three days late');
});

test('if sending fails, nothing is cleared and it is retried', async () => {
  fake.settings = {};
  await runSummary(at('2026-11-16'));
  await recordAction(entry(at('2026-11-18')));
  fake.failures.set('createModNotification', 'modmail is down');
  await assert.rejects(runSummary(at('2026-11-23')), /modmail is down/);
  assert.equal(fake.zsets.get('summary:log')?.length, 1);

  fake.failures.clear();
  assert.equal(await runSummary(at('2026-11-24')), 'sent');
});

test('turning summaries off deletes what was stored', async () => {
  fake.settings = {};
  await runSummary(at('2026-11-16'));
  await recordAction(entry(at('2026-11-18')));
  fake.settings = { summaryFrequency: ['off'] };
  assert.equal(await runSummary(at('2026-11-23')), 'off');
  assert.equal(fake.zsets.get('summary:log'), undefined);
  assert.equal(fake.kv.get('summary:total'), undefined);
  assert.equal(fake.kv.get('summary:start'), undefined);
  assert.deepEqual(sent(), []);
});

test('storage is capped, but the total stays right and the modmail stays short', async () => {
  fake.settings = { summaryFrequency: ['year'] };
  const start = at('2026-01-01');
  await runSummary(start);
  for (let i = 0; i < 520; i += 1) await recordAction(entry(start + i * 60_000, `user_${i}`));
  assert.equal(fake.zsets.get('summary:log')!.length, 500, 'only the newest 500 are kept');
  assert.ok(fake.expirations.get('summary:log')! > 365 * 86_400, 'and they cannot outlive a yearly summary by much');

  assert.equal(await runSummary(at('2027-01-01')), 'sent');
  const body = sent()[0]!.bodyMarkdown!;
  assert.match(body, /acted on \*\*520\*\* modmail messages/);
  assert.match(body, /These counts cover the most recent 500 actions/);
  assert.equal(body.split('\n\n').filter((line) => line.includes(' – u/')).length, 40, '40 listed');
  assert.match(body, /…and 480 more\./);
  assert.match(body, /u\/user_519/, 'newest is listed');
  assert.doesNotMatch(body, /u\/user_479 /, 'older ones are not');
  assert.ok(body.length < 10_000, `fits in one modmail (${body.length} characters)`);
});

test('summary text: renewals are labelled, long patterns shortened, and patterns cannot break the layout', () => {
  const body = buildSummary(
    [
      entry(at('2026-11-17'), 'a_user', 'x'.repeat(200)),
      entry(at('2026-11-18'), 'b_user', '', ['Muted again for 28 days']),
      entry(at('2026-11-19'), 'c_user', 'evil`**bold**`\n[link](http://x)'),
    ],
    3,
    utc('2026-11-16'),
    at('2026-11-23'),
  );
  assert.match(body, /\* 2026-11-18 – u\/b_user – on the permanent-mute list – Muted again for 28 days/);
  assert.match(body, /\* 1 × on the permanent-mute list/);
  assert.ok(body.includes('`' + 'x'.repeat(80) + '`'), 'pattern cut to 80 characters');
  assert.ok(body.includes("`evil'**bold**' [link](http://x)`"), 'backticks and line breaks neutralised');
  assert.doesNotMatch(body, /…and/);
  assert.doesNotMatch(body, /Permanent mutes/, 'no list line when the list is empty');

  const withList = buildSummary([entry(at('2026-11-17'))], 1, utc('2026-11-16'), at('2026-11-23'), { listed: 3, renewed: 1 });
  assert.ok(withList.includes('**Permanent mutes**: 3 users on the list, 1 mute renewed in this period.'));
  const quiet = buildSummary([entry(at('2026-11-17'))], 1, utc('2026-11-16'), at('2026-11-23'), { listed: 1, renewed: 0 });
  assert.ok(quiet.includes('**Permanent mutes**: 1 user on the list.'));
});

test('the summary reports the permanent-mute list, and renewals alone do not trigger one', async () => {
  fake.settings = {};
  await runSummary(at('2026-11-16'));
  fake.hashes.set('keepMuted', new Map([['a_user', '{}'], ['b_user', '{}']]));
  fake.kv.set('summary:renewed', '2');
  assert.equal(await runSummary(at('2026-11-23')), 'nothing-happened', 'maintenance is not news');
  assert.equal(fake.kv.get('summary:renewed'), undefined, 'the count starts again each period');

  fake.kv.set('summary:renewed', '4');
  await recordAction(entry(at('2026-11-25')));
  assert.equal(await runSummary(at('2026-11-30')), 'sent');
  assert.ok(
    sent()[0]!.bodyMarkdown!.includes('**Permanent mutes**: 2 users on the list, 4 mutes renewed in this period.'),
  );
});

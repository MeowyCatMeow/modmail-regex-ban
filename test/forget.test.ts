// Reddit requires apps to drop what they hold about deleted accounts. The app
// looks up every account it holds anything about. An account Reddit does not
// know is asked about again ten days later, and erased only if still unknown,
// because a short site suspension gets the same answer as a deletion.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { fake, modMailEvent as event, person, userConversation, userMessage } from './fake-devvit.ts';

const { CONFIRM_AFTER_MS, forgetDeletedAccounts, LOOKUPS_PER_RUN, RECHECK_MS } = await import('../src/forget.ts');
const { handleModMail } = await import('../src/modmail.ts');
const { runSummary } = await import('../src/summary.ts');
const { runUndo } = await import('../src/undo.ts');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const APP = 'modmail-regex-ban';
const SETTINGS = { patterns: 'buy followers', muteDuration: ['permanent'] };
const NOTHING = { checked: 0, missing: 0, forgotten: 0, failed: 0 };

let offences = 0;
/** Lets the app ban, permanently mute and archive `name` for a matching modmail in conversation `id`. */
async function offence(name: string, id: string): Promise<void> {
  offences += 1;
  const message = userMessage(`m${offences}`, 'buy followers', { author: person(name) });
  fake.settings = SETTINGS;
  fake.mute = { isMuted: false };
  fake.conversation = { ...userConversation(message), id, participant: person(name) };
  await handleModMail(
    event({ conversationId: `ModmailConversation_${id}`, messageId: `ModmailMessage_m${offences}`, messageAuthor: { name } }),
  );
  fake.calls = [];
}

const members = (key: string): string[] => (fake.zsets.get(key) ?? []).map((m) => m.member).sort();
const ledger = (): string[] => members('ledger');
const summaryUsers = (): string[] => members('summary:log').map((m) => (JSON.parse(m) as { u: string }).u);
const marks = (): string[] => [...(fake.hashes.get('accounts:missing')?.keys() ?? [])];
/** Everything in the app's storage, as one string. */
const stored = (): string =>
  JSON.stringify([
    [...fake.kv],
    [...fake.hashes].map(([key, hash]) => [key, [...hash]]),
    [...fake.zsets],
  ]);

beforeEach(() => {
  fake.reset();
  offences = 0;
});

test('an account Reddit no longer knows is erased at the second asking, ten days after the first', async () => {
  await offence('Spammer', 'c1');
  await offence('keeper', 'c2');
  fake.hashes.set('undo:attempts', new Map([['ban|spammer|c1', '1'], ['ban|keeper|c2', '1']]));
  fake.gone.add('spammer');
  const now = Date.now();

  // First "not found": noted, nothing erased.
  assert.deepEqual(await forgetDeletedAccounts(now), { checked: 2, missing: 1, forgotten: 0, failed: 0 });
  assert.equal(ledger().length, 6);
  assert.ok(fake.listed('spammer'));
  assert.deepEqual(summaryUsers().sort(), ['Spammer', 'keeper']);
  assert.deepEqual(marks(), ['spammer']);

  // Not asked about again before the ten days are up.
  fake.lookups = [];
  await forgetDeletedAccounts(now + CONFIRM_AFTER_MS - HOUR);
  assert.ok(!fake.lookups.includes('spammer'));
  assert.ok(fake.listed('spammer'));

  // Still unknown after ten days: everything about them goes, and nobody else is touched.
  const later = now + CONFIRM_AFTER_MS;
  assert.equal((await forgetDeletedAccounts(later)).forgotten, 1);
  assert.doesNotMatch(stored(), /spammer/i, 'the username is nowhere in storage, in any spelling');
  assert.deepEqual(ledger(), ['archive|keeper|c2', 'ban|keeper|c2', 'mute|keeper|c2']);
  assert.ok(fake.listed('keeper'));
  assert.deepEqual(members('keepMuted:ends'), ['keeper']);
  assert.deepEqual(summaryUsers(), ['keeper']);
  assert.deepEqual([...fake.hashes.get('undo:attempts')!.keys()], ['ban|keeper|c2']);
  assert.deepEqual(members('accounts'), ['keeper']);
  assert.deepEqual(marks(), []);
  assert.deepEqual(fake.calls, [], 'nothing is changed on Reddit');
});

test('a suspended account that is back at the second asking keeps everything', async () => {
  await offence('spammer', 'c1');
  const now = Date.now();
  fake.gone.add('spammer'); // a site suspension of a few days
  assert.equal((await forgetDeletedAccounts(now)).missing, 1);

  fake.gone.delete('spammer');
  assert.deepEqual(await forgetDeletedAccounts(now + CONFIRM_AFTER_MS), { checked: 1, missing: 0, forgotten: 0, failed: 0 });
  assert.ok(fake.listed('spammer'), 'still on the permanent-mute list');
  assert.equal(ledger().length, 3);
  assert.deepEqual(marks(), [], 'and the earlier "not found" is void');

  // A later disappearance starts the ten days afresh.
  fake.gone.add('spammer');
  const again = now + CONFIRM_AFTER_MS + RECHECK_MS;
  assert.equal((await forgetDeletedAccounts(again)).missing, 1);
  assert.equal((await forgetDeletedAccounts(again + CONFIRM_AFTER_MS)).forgotten, 1);
  assert.equal(fake.listed('spammer'), undefined);
});

test('an account that still exists keeps its data and is looked up again a week later', async () => {
  await offence('keeper', 'c1');
  const now = Date.now();
  assert.deepEqual(await forgetDeletedAccounts(now), { checked: 1, missing: 0, forgotten: 0, failed: 0 });
  assert.deepEqual(fake.lookups, [APP, 'keeper']);
  assert.equal(ledger().length, 3);
  assert.ok(fake.listed('keeper'));
  assert.deepEqual(fake.zsets.get('accounts'), [{ member: 'keeper', score: now + RECHECK_MS }]);

  fake.lookups = [];
  await forgetDeletedAccounts(now + HOUR);
  await forgetDeletedAccounts(now + RECHECK_MS - HOUR);
  assert.deepEqual(fake.lookups, [], 'not again within the week');
  await forgetDeletedAccounts(now + RECHECK_MS);
  assert.deepEqual(fake.lookups, [APP, 'keeper']);
});

test("nothing is noted or erased while Reddit cannot find even the app's own account", async () => {
  await offence('spammer', 'c1');
  fake.hashes.set('accounts:missing', new Map([['spammer', String(Date.now() - 11 * DAY)]]));
  fake.gone.add('spammer').add(APP);
  assert.deepEqual(await forgetDeletedAccounts(), NOTHING);
  assert.deepEqual(fake.lookups, [APP], 'nobody else is even asked about');
  assert.ok(fake.listed('spammer'));
  assert.equal(ledger().length, 3);

  // Once lookups answer properly again, the account (unknown for over ten days) is forgotten.
  fake.gone.delete(APP);
  assert.equal((await forgetDeletedAccounts()).forgotten, 1);
  assert.doesNotMatch(stored(), /spammer/);
});

test('"not found" is not believed when lookups stop working during the run', async () => {
  await offence('spammer', 'c1');
  await offence('keeper', 'c2');
  fake.hashes.set('accounts:missing', new Map([['spammer', String(Date.now() - 11 * DAY)]]));
  let asked = 0;
  // The first lookup (the app itself) is answered; after that Reddit finds nobody at all.
  fake.knows = () => ++asked === 1;
  assert.deepEqual(await forgetDeletedAccounts(), { checked: 2, missing: 0, forgotten: 0, failed: 0 });
  assert.ok(fake.listed('spammer') && fake.listed('keeper'));
  assert.equal(ledger().length, 6);
  assert.deepEqual(marks(), ['spammer'], 'and nobody new is noted as missing');

  // Both are asked about again on the next run, and now only the deleted one goes.
  fake.knows = undefined;
  fake.gone.add('spammer');
  fake.lookups = [];
  assert.deepEqual(await forgetDeletedAccounts(), { checked: 2, missing: 0, forgotten: 1, failed: 0 });
  assert.deepEqual([...fake.lookups].sort(), [APP, APP, 'keeper', 'spammer'].sort(), 'the app itself before and after');
  assert.ok(fake.listed('keeper'));
  assert.equal(fake.listed('spammer'), undefined);
});

test('a lookup that fails is not an answer: the data stays and the account is asked about again later', async () => {
  await offence('spammer', 'c1');
  fake.failIf = (method, args) =>
    method === 'getUserByUsername' && args === 'spammer' ? '500 error for /user/Spammer/about' : undefined;
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...parts: unknown[]) => void logged.push(parts.join(' '));
  const now = Date.now();
  try {
    assert.deepEqual(await forgetDeletedAccounts(now), { checked: 0, missing: 0, forgotten: 0, failed: 1 });
  } finally {
    console.error = realError;
  }
  assert.ok(fake.listed('spammer'));
  assert.equal(ledger().length, 3);
  assert.deepEqual(marks(), []);
  assert.equal(logged.length, 1);
  assert.doesNotMatch(logged[0]!, /spammer/i, 'the log does not name the account');

  fake.failIf = undefined;
  fake.lookups = [];
  await forgetDeletedAccounts(now + HOUR);
  assert.deepEqual(fake.lookups, [], 'not every hour');
  await forgetDeletedAccounts(now + 6 * HOUR);
  assert.deepEqual(fake.lookups, [APP, 'spammer']);
});

test('a long list is worked through a batch at a time, starting with what was already stored', async () => {
  const now = Date.now();
  const total = 2 * LOOKUPS_PER_RUN + 10;
  // As after an update: plenty on record, and nothing yet listed for checking.
  fake.zsets.set(
    'ledger',
    Array.from({ length: total }, (_, i) => ({ member: `ban|user${i}|c${i}`, score: now - 10_000 + i })),
  );
  assert.equal((await forgetDeletedAccounts(now)).checked, LOOKUPS_PER_RUN);
  assert.equal((await forgetDeletedAccounts(now + HOUR)).checked, LOOKUPS_PER_RUN);
  assert.equal((await forgetDeletedAccounts(now + 2 * HOUR)).checked, 10);
  assert.equal((await forgetDeletedAccounts(now + 3 * HOUR)).checked, 0);
  assert.equal(fake.zsets.get('accounts')!.length, total);
});

test('lists longer than one page of storage are read and erased in full', async () => {
  const now = Date.now();
  // 1,200 users with two records each: 2,400 ledger entries, read 1,000 at a time.
  const entries = Array.from({ length: 1200 }, (_, i) => [
    { member: `ban|user${i}|c${i}`, score: now - 10_000 + i },
    { member: `mute|user${i}|c${i}`, score: now - 10_000 + i },
  ]).flat();
  fake.zsets.set('ledger', entries);
  await forgetDeletedAccounts(now);
  assert.equal(fake.zsets.get('accounts')!.length, 1200, 'every one of them is listed for checking');

  // The very last user, on the third page, has been unknown for ten days.
  fake.zsets.set(
    'accounts',
    fake.zsets.get('accounts')!.map((m) => ({ member: m.member, score: m.member === 'user1199' ? now : now + DAY })),
  );
  fake.hashes.set('accounts:missing', new Map([['user1199', String(now - CONFIRM_AFTER_MS)]]));
  fake.gone.add('user1199');
  assert.equal((await forgetDeletedAccounts(now + HOUR)).forgotten, 1);
  assert.equal(fake.zsets.get('ledger')!.length, 2398);
  assert.doesNotMatch(stored(), /user1199\b/);
});

test('an account the app starts holding something about is checked within a day', async () => {
  const now = Date.now();
  await offence('first', 'c1');
  await forgetDeletedAccounts(now);
  await offence('second', 'c2');

  fake.lookups = [];
  await forgetDeletedAccounts(now + DAY);
  assert.deepEqual(fake.lookups, [APP, 'second']);
});

test('once the app holds nothing about an account, it stops keeping the name', async () => {
  await offence('spammer', 'c1');
  const now = Date.now();
  fake.gone.add('spammer');
  await forgetDeletedAccounts(now);
  assert.deepEqual(members('accounts'), ['spammer']);
  assert.deepEqual(marks(), ['spammer']);

  // A moderator switches on "Undo everything": the app lets go of all it recorded.
  fake.settings = { ...SETTINGS, undoAll: true };
  assert.equal(await runUndo(), 'done');
  assert.deepEqual(ledger(), []);

  fake.lookups = [];
  await forgetDeletedAccounts(now + DAY);
  assert.deepEqual(members('accounts'), []);
  assert.deepEqual(marks(), [], 'nor the note that Reddit did not find them');
  assert.deepEqual(fake.lookups, [], 'and there is nobody left to ask about');
});

test('the next summary no longer names a deleted account', async () => {
  await offence('spammer', 'c1');
  await offence('keeper', 'c2');
  fake.gone.add('spammer');
  const now = Date.now();
  await forgetDeletedAccounts(now);
  await forgetDeletedAccounts(now + CONFIRM_AFTER_MS);

  fake.kv.set('summary:start', String(Date.now() - 8 * DAY));
  assert.equal(await runSummary(), 'sent');
  const body = String(fake.argsOf('createModNotification').bodyMarkdown);
  assert.doesNotMatch(body, /spammer/i);
  assert.match(body, /u\/keeper/);
  assert.match(body, /acted on \*\*2\*\* modmail messages/);
});

test('with nothing stored the job asks Reddit nothing', async () => {
  assert.deepEqual(await forgetDeletedAccounts(), NOTHING);
  assert.deepEqual(fake.lookups, []);
  assert.deepEqual(fake.calls, []);
});

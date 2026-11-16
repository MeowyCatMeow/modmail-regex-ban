// Reddit requires apps to drop what they hold about deleted accounts. The app
// looks up every account it holds anything about, and erases what it kept
// about the ones Reddit no longer knows.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { fake, modMailEvent as event, person, userConversation, userMessage } from './fake-devvit.ts';

const { forgetDeletedAccounts, LOOKUPS_PER_RUN, RECHECK_MS } = await import('../src/forget.ts');
const { handleModMail } = await import('../src/modmail.ts');
const { runSummary } = await import('../src/summary.ts');
const { runUndo } = await import('../src/undo.ts');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const APP = 'modmail-regex-ban';
const SETTINGS = { patterns: 'buy followers', muteDuration: ['permanent'] };

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

test('everything kept about a deleted account is erased, and nobody else is touched', async () => {
  await offence('Spammer', 'c1');
  await offence('keeper', 'c2');
  fake.hashes.set('undo:attempts', new Map([['ban|spammer|c1', '1'], ['ban|keeper|c2', '1']]));
  assert.match(stored(), /spammer/i);
  assert.deepEqual(ledger().length, 6);
  assert.deepEqual(summaryUsers().sort(), ['Spammer', 'keeper']);

  fake.gone.add('spammer');
  const now = Date.now();
  assert.deepEqual(await forgetDeletedAccounts(now), { checked: 2, forgotten: 1, failed: 0 });

  assert.doesNotMatch(stored(), /spammer/i, 'the username is nowhere in storage, in any spelling');
  assert.deepEqual(ledger(), ['archive|keeper|c2', 'ban|keeper|c2', 'mute|keeper|c2']);
  assert.equal(fake.listed('spammer'), undefined);
  assert.ok(fake.listed('keeper'));
  assert.deepEqual(members('keepMuted:ends'), ['keeper']);
  assert.deepEqual(summaryUsers(), ['keeper']);
  assert.deepEqual([...fake.hashes.get('undo:attempts')!.keys()], ['ban|keeper|c2']);
  assert.equal(fake.kv.get('summary:total'), '2', 'how many messages were acted on is not about anyone, and stays');
  assert.deepEqual(fake.zsets.get('accounts'), [{ member: 'keeper', score: now + RECHECK_MS }]);
  assert.deepEqual(fake.calls, [], 'nothing is changed on Reddit');
});

test('an account that still exists keeps its data and is looked up again a week later', async () => {
  await offence('keeper', 'c1');
  const now = Date.now();
  assert.deepEqual(await forgetDeletedAccounts(now), { checked: 1, forgotten: 0, failed: 0 });
  assert.deepEqual(fake.lookups, [APP, 'keeper']);
  assert.equal(ledger().length, 3);
  assert.ok(fake.listed('keeper'));

  fake.lookups = [];
  await forgetDeletedAccounts(now + HOUR);
  await forgetDeletedAccounts(now + RECHECK_MS - HOUR);
  assert.deepEqual(fake.lookups, [], 'not again within the week');
  await forgetDeletedAccounts(now + RECHECK_MS);
  assert.deepEqual(fake.lookups, [APP, 'keeper']);
});

test("nothing is erased while Reddit cannot find even the app's own account", async () => {
  await offence('spammer', 'c1');
  fake.gone.add('spammer').add(APP);
  assert.deepEqual(await forgetDeletedAccounts(), { checked: 0, forgotten: 0, failed: 0 });
  assert.deepEqual(fake.lookups, [APP], 'nobody else is even asked about');
  assert.ok(fake.listed('spammer'));
  assert.equal(ledger().length, 3);
  assert.deepEqual(summaryUsers(), ['spammer']);

  // Once lookups answer properly again, the deleted account is forgotten.
  fake.gone.delete(APP);
  assert.equal((await forgetDeletedAccounts()).forgotten, 1);
  assert.doesNotMatch(stored(), /spammer/);
});

test('"not found" is not believed when lookups stop working during the run', async () => {
  await offence('spammer', 'c1');
  await offence('keeper', 'c2');
  let asked = 0;
  // The first lookup (the app itself) is answered; after that Reddit finds nobody at all.
  fake.knows = () => ++asked === 1;
  assert.deepEqual(await forgetDeletedAccounts(), { checked: 2, forgotten: 0, failed: 0 });
  assert.ok(fake.listed('spammer') && fake.listed('keeper'));
  assert.equal(ledger().length, 6);

  // Both are asked about again on the next run, and now only the deleted one goes.
  fake.knows = undefined;
  fake.gone.add('spammer');
  fake.lookups = [];
  assert.deepEqual(await forgetDeletedAccounts(), { checked: 2, forgotten: 1, failed: 0 });
  assert.deepEqual([...fake.lookups].sort(), [APP, APP, 'keeper', 'spammer'].sort(), 'the app itself before and after');
  assert.ok(fake.listed('keeper'));
  assert.equal(fake.listed('spammer'), undefined);
});

test('a lookup that fails is not an answer: the data stays and the account is asked about again later', async () => {
  await offence('spammer', 'c1');
  fake.failIf = (method, args) =>
    method === 'getUserByUsername' && args === 'spammer' ? '429 Too Many Requests' : undefined;
  const now = Date.now();
  assert.deepEqual(await forgetDeletedAccounts(now), { checked: 0, forgotten: 0, failed: 1 });
  assert.ok(fake.listed('spammer'));
  assert.equal(ledger().length, 3);

  fake.failIf = undefined;
  fake.lookups = [];
  await forgetDeletedAccounts(now + HOUR);
  assert.deepEqual(fake.lookups, [], 'not every hour');
  await forgetDeletedAccounts(now + 6 * HOUR);
  assert.deepEqual(fake.lookups, [APP, 'spammer']);
});

test('a long list is worked through a batch at a time, starting with what was already stored', async () => {
  const now = Date.now();
  // As after an update: plenty on record, and nothing yet listed for checking.
  fake.zsets.set(
    'ledger',
    Array.from({ length: LOOKUPS_PER_RUN + 10 }, (_, i) => ({ member: `ban|user${i}|c${i}`, score: now - 1000 + i })),
  );
  assert.equal((await forgetDeletedAccounts(now)).checked, LOOKUPS_PER_RUN);
  assert.equal((await forgetDeletedAccounts(now + HOUR)).checked, 10);
  assert.equal((await forgetDeletedAccounts(now + 2 * HOUR)).checked, 0);
  assert.equal(fake.zsets.get('accounts')!.length, LOOKUPS_PER_RUN + 10);
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

test('once the app holds nothing about an account, it stops keeping the name to check', async () => {
  await offence('spammer', 'c1');
  const now = Date.now();
  await forgetDeletedAccounts(now);
  assert.deepEqual(members('accounts'), ['spammer']);

  // A moderator switches on "Undo everything": the app lets go of all it recorded.
  fake.settings = { ...SETTINGS, undoAll: true };
  assert.equal(await runUndo(), 'done');
  assert.deepEqual(ledger(), []);

  fake.lookups = [];
  await forgetDeletedAccounts(now + DAY);
  assert.deepEqual(members('accounts'), []);
  assert.deepEqual(fake.lookups, [], 'and there is nobody left to ask about');
});

test('the next summary no longer names a deleted account', async () => {
  await offence('spammer', 'c1');
  await offence('keeper', 'c2');
  fake.gone.add('spammer');
  await forgetDeletedAccounts();

  fake.kv.set('summary:start', String(Date.now() - 8 * DAY));
  assert.equal(await runSummary(), 'sent');
  const body = String(fake.argsOf('createModNotification').bodyMarkdown);
  assert.doesNotMatch(body, /spammer/i);
  assert.match(body, /u\/keeper/);
  assert.match(body, /acted on \*\*2\*\* modmail messages/);
});

test('with nothing stored the job asks Reddit nothing', async () => {
  assert.deepEqual(await forgetDeletedAccounts(), { checked: 0, forgotten: 0, failed: 0 });
  assert.deepEqual(fake.lookups, []);
  assert.deepEqual(fake.calls, []);
});

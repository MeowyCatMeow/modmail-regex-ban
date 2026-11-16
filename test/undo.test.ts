// "Undo everything the app has done": while that setting is on, the app
// reverses its bans, mutes and archiving, and takes no new action.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { fake, modMailEvent as event, person, userConversation, userMessage, type Fields } from './fake-devvit.ts';

const { handleModMail } = await import('../src/modmail.ts');
const { renewMutes } = await import('../src/permamute.ts');
const { runUndo } = await import('../src/undo.ts');

const ON = { patterns: 'buy followers', undoAll: true };
const OFF = { patterns: 'buy followers' };
const MINUTE = 60_000;

const ledger = (): string[] => (fake.zsets.get('ledger') ?? []).map((m) => m.member).sort();
const reports = (): Record<string, string>[] =>
  fake.calls.filter((c) => c.method === 'createModNotification').map((c) => c.args as Record<string, string>);
/** Lets the app act on one matching modmail from "spammer" with the given settings. */
async function offence(settings: Fields = OFF): Promise<void> {
  fake.settings = settings;
  fake.conversation = userConversation(userMessage('m1', 'buy followers'));
  await handleModMail(event());
  fake.calls = [];
}

beforeEach(() => fake.reset());

// ---- Keeping a record --------------------------------------------------------------

test('everything the app does is put on record', async () => {
  await offence();
  assert.deepEqual(ledger(), ['archive|spammer|c1', 'ban|spammer|c1', 'mute|spammer|c1']);
});

test('only what actually happened is recorded', async () => {
  fake.failures.set('banUser', 'USER_DOESNT_EXIST');
  await offence({ patterns: 'buy followers', archive: false });
  assert.deepEqual(ledger(), ['mute|spammer|c1'], 'the ban failed and archiving is off');
});

// ---- Undoing -----------------------------------------------------------------------

test('switching the setting on unbans, unmutes and unarchives what the app did, then reports', async () => {
  await offence();
  assert.deepEqual([fake.ban.isBanned, fake.mute.isMuted, fake.conversation.state], [true, true, 'Archived']);

  fake.settings = ON;
  assert.equal(await runUndo(), 'done');
  assert.deepEqual(fake.methods().sort(), ['createModNotification', 'unarchiveConversation', 'unbanUser', 'unmuteConversation']);
  assert.deepEqual(fake.argsOf('unbanUser'), { username: 'spammer', subredditName: 'testsub' });
  assert.deepEqual([fake.ban.isBanned, fake.mute.isMuted, fake.conversation.state], [false, false, 'InProgress']);
  assert.deepEqual(ledger(), []);

  const [report] = reports();
  assert.equal(report!.subject, 'Modmail Regex Ban: its actions have been undone');
  assert.match(report!.bodyMarkdown!, /\* Users unbanned: 1\n\n\* Users unmuted: 1\n\n\* Conversations moved back to the inbox: 1/);
  assert.match(report!.bodyMarkdown!, /Left alone, because they had already ended or a moderator had changed them: 0/);
  assert.doesNotMatch(report!.bodyMarkdown!, /Could not be undone/);
  assert.match(report!.bodyMarkdown!, /The app is paused and will take no action until you switch that setting off again/);

  // Running again (the hourly job does) changes nothing and does not report twice.
  fake.calls = [];
  assert.equal(await runUndo(), 'done');
  assert.deepEqual(fake.calls, []);
});

test('while the setting is on the app takes no new action', async () => {
  fake.settings = ON;
  fake.conversation = userConversation(userMessage('m1', 'buy followers'));
  await handleModMail(event());
  assert.deepEqual(fake.calls, [], 'a matching modmail is left alone');

  fake.settings = { ...ON, muteDuration: ['permanent'] };
  fake.hashes.set('keepMuted', new Map([['spammer', JSON.stringify({ since: 1, pattern: 'x', conversationId: 'c1', at: 1, until: 2 })]]));
  fake.zsets.set('keepMuted:ends', [{ member: 'spammer', score: 2 }]);
  assert.deepEqual(await renewMutes(), { renewed: 0, lifted: 0, failed: 0 }, 'and no mute is renewed');
});

test('with the setting off nothing is undone, and switching it off resets it for next time', async () => {
  await offence();
  assert.equal(await runUndo(), 'off');
  assert.deepEqual(fake.calls, []);
  assert.equal(ledger().length, 3);

  // On: undone and reported. Off: forgotten. A new offence, then on again: undone and reported again.
  fake.settings = ON;
  await runUndo();
  fake.settings = OFF;
  assert.equal(await runUndo(), 'off');
  assert.equal(fake.kv.get('undo:state'), undefined);
  await offence();
  fake.settings = ON;
  assert.equal(await runUndo(), 'done');
  assert.equal(reports().length, 1);
  assert.equal(fake.ban.isBanned, false);
});

test('what a moderator has changed since, or what has already ended, is left alone', async () => {
  await offence();
  // A moderator re-banned them for something else, and muted them from another conversation.
  fake.ban = { isBanned: true, isPermanent: true, reason: 'Rule 3: harassment' };
  fake.mute = { isMuted: true, reason: 'https://mod.reddit.com/mail/perma/zzz9' };
  fake.conversation.state = 'InProgress'; // and moved the conversation back themselves

  fake.settings = ON;
  assert.equal(await runUndo(), 'done');
  assert.deepEqual(fake.methods(), ['createModNotification'], 'nothing is touched');
  assert.equal(fake.ban.isBanned, true);
  assert.equal(fake.mute.isMuted, true);
  assert.match(reports()[0]!.bodyMarkdown!, /Users unbanned: 0/);
  assert.match(reports()[0]!.bodyMarkdown!, /had changed them: 3/);

  // A temporary ban and a mute that have run out are simply over.
  fake.reset();
  await offence();
  fake.ban = { isBanned: false, isPermanent: false, reason: '' };
  fake.mute = { isMuted: false };
  fake.settings = ON;
  await runUndo();
  assert.deepEqual(fake.methods().sort(), ['createModNotification', 'unarchiveConversation']);
});

test('the permanent-mute list is emptied, and people on it are unmuted', async () => {
  await offence({ patterns: 'buy followers', muteDuration: ['permanent'] });
  assert.ok(fake.listed('spammer'));
  fake.settings = { ...ON, muteDuration: ['permanent'] };
  assert.equal(await runUndo(), 'done');
  assert.equal(fake.listed('spammer'), undefined);
  assert.equal(fake.renewalDue('spammer'), undefined);
  assert.equal(fake.mute.isMuted, false);
});

test('actions from before the app kept a record are found in the summary log and the permanent-mute list', async () => {
  // As an install upgraded from an earlier version would look: no ledger at all.
  fake.conversation = userConversation(userMessage('m1', 'x'));
  fake.conversation.state = 'Archived';
  fake.ban = { isBanned: true, isPermanent: true, reason: 'Modmail matched a banned pattern: Modmail regex: buy followers' };
  fake.mute = { isMuted: true, reason: 'https://mod.reddit.com/mail/perma/c1' };
  const t = Date.now() - 3_600_000;
  fake.zsets.set('summary:log', [
    { member: JSON.stringify({ t, u: 'spammer', p: 'buy followers', o: ['Banned (permanently)', 'Muted for 28 days'], c: 'c1' }), score: t },
  ]);
  fake.hashes.set('keepMuted', new Map([['spammer', JSON.stringify({ since: t, pattern: 'x', conversationId: 'c1', at: t, until: t + 1 })]]));

  fake.settings = ON;
  assert.equal(await runUndo(), 'done');
  assert.deepEqual(fake.methods().sort(), ['createModNotification', 'unarchiveConversation', 'unbanUser', 'unmuteConversation']);
  assert.match(reports()[0]!.bodyMarkdown!, /Users unbanned: 1\n\n\* Users unmuted: 1\n\n\* Conversations moved back to the inbox: 1/);
});

// ---- Large jobs, failures and overlaps ----------------------------------------------

/** Puts `count` banned users on record, each with their own conversation. */
function manyBans(count: number): void {
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const id = `k${i}`;
    entries.push({ member: `ban|user_${i}|${id}`, score: 1000 + i });
    fake.conversations.set(id, {
      conversation: { id, state: 'InProgress', participant: person(`user_${i}`) },
      user: { banStatus: { isBanned: true, reason: 'x: Modmail regex: y' }, muteStatus: { isMuted: false } },
    });
  }
  fake.zsets.set('ledger', entries);
}

test('a long list is worked through 15 at a time, oldest first, and reported once at the end', async () => {
  manyBans(40);
  fake.settings = ON;

  assert.equal(await runUndo(), 'running');
  assert.equal(fake.methods().filter((m) => m === 'unbanUser').length, 15);
  assert.equal(fake.argsOf('unbanUser').username, 'user_0', 'oldest first');
  assert.equal(ledger().length, 25);
  assert.equal(fake.jobs.length, 1, 'the next step is scheduled');
  assert.equal(fake.jobs[0]!.name, 'undo');
  assert.deepEqual(reports(), [], 'no report until it is all done');

  assert.equal(await runUndo(), 'running');
  assert.equal(await runUndo(), 'done');
  assert.equal(fake.methods().filter((m) => m === 'unbanUser').length, 40);
  assert.equal(reports().length, 1);
  assert.match(reports()[0]!.bodyMarkdown!, /Users unbanned: 40/);
  assert.equal(fake.jobs.length, 2, 'and nothing more is scheduled');
});

test('a failed step is tried again later, up to three times, then reported as not undone', async () => {
  manyBans(2);
  fake.settings = ON;
  const now = Date.now();
  let failuresLeft = 2;
  fake.failIf = (method, args) =>
    method === 'unbanUser' && (args as Fields).username === 'user_0' && failuresLeft-- > 0 ? 'Reddit is down' : undefined;

  // First run: user_1 is unbanned, user_0 fails and is put off by a minute.
  assert.equal(await runUndo(now), 'running');
  assert.deepEqual(ledger(), ['ban|user_0|k0']);
  assert.equal(await runUndo(now + 1000), 'running', 'not due yet');
  assert.equal(await runUndo(now + MINUTE + 1000), 'running', 'second failure');
  assert.equal(await runUndo(now + 2 * MINUTE + 2000), 'done', 'third time lucky');
  assert.match(reports()[0]!.bodyMarkdown!, /Users unbanned: 2/);
  assert.doesNotMatch(reports()[0]!.bodyMarkdown!, /Could not be undone/);

  // Something that never works is given up on and said so.
  fake.reset();
  manyBans(1);
  fake.settings = ON;
  fake.failures.set('unbanUser', 'Reddit is down');
  await runUndo(now);
  await runUndo(now + MINUTE + 1000);
  assert.equal(await runUndo(now + 2 * MINUTE + 2000), 'done');
  assert.match(reports()[0]!.bodyMarkdown!, /\* Could not be undone: 1/);
  assert.deepEqual(ledger(), []);
});

test('two runs never overlap', async () => {
  manyBans(5);
  fake.settings = ON;
  const results = await Promise.all([runUndo(), runUndo(), runUndo()]);
  assert.deepEqual(results.sort(), ['busy', 'busy', 'done']);
  assert.equal(fake.methods().filter((m) => m === 'unbanUser').length, 5, 'each user is unbanned once');
  assert.equal(fake.kv.get('undo:lock'), undefined, 'and the lock is released');
});

test('entries the app cannot read are dropped rather than blocking the rest', async () => {
  manyBans(1);
  fake.zsets.get('ledger')!.unshift({ member: 'nonsense', score: 1 }, { member: 'ban||', score: 2 });
  fake.settings = ON;
  assert.equal(await runUndo(), 'done');
  assert.equal(fake.methods().filter((m) => m === 'unbanUser').length, 1);
});

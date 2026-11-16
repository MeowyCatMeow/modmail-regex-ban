// Regression tests for the problems found in the pre-publication review.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeEach, test } from 'node:test';
import { fake, modMailEvent as event, person, userConversation, userMessage, type Fields } from './fake-devvit.ts';

const { handleModMail } = await import('../src/modmail.ts');
const { handleRequest } = await import('../src/http.ts');
const { listedAction, liftOnUnmute } = await import('../src/permamute.ts');
const { runUndo } = await import('../src/undo.ts');

const DAY = 86_400_000;
const HOUR = 3_600_000;
const RECURRING = { patterns: 'buy followers', muteDuration: ['permanent'] };

function list(name: string, at: number, until: number): void {
  if (!fake.hashes.has('keepMuted')) fake.hashes.set('keepMuted', new Map());
  fake.hashes
    .get('keepMuted')!
    .set(name, JSON.stringify({ since: at, pattern: 'buy followers', conversationId: 'c1', at, until }));
  fake.zsets.set('keepMuted:ends', [{ member: name, score: until }]);
}

beforeEach(() => fake.reset());

test('mail from someone Reddit still shows as muted is archived, not read as a moderator having unmuted them', async () => {
  const at = 1_000_000_000_000;
  const entry = { since: at, pattern: 'x', conversationId: 'c1', at, until: at + 28 * DAY };
  assert.equal(listedAction(entry, at + 10 * DAY, 'recurring', true), 'archive');
  assert.equal(listedAction(entry, at + 10 * DAY, 'archive', true), 'archive');
  assert.equal(listedAction(entry, at + 10 * DAY, 'recurring', false), 'lifted', 'really unmuted: lifted');

  // Through the handler: mid-mute message, and Reddit says they are still muted.
  const sent = Date.now() - HOUR;
  list('spammer', sent - 10 * DAY, sent + 18 * DAY);
  fake.settings = RECURRING;
  fake.mute = { isMuted: true, reason: 'https://mod.reddit.com/mail/perma/c1' };
  fake.conversation = userConversation(
    userMessage('m7', 'hello?', { date: new Date(sent).toISOString().replace('Z', '000+0000') }),
  );
  await handleModMail(event({ messageId: 'ModmailMessage_m7' }));
  assert.deepEqual(fake.methods(), ['reply', 'archiveConversation'], 'archived, and not muted a second time');
  assert.ok(fake.listed('spammer'), 'and they stay on the list');
});

test('an unmute reported after the mute had already ended does not take anyone off the list', async () => {
  const now = Date.now();
  const unmute = { type: 'ModAction', action: 'unmuteuser', moderator: { name: 'reddit' }, targetUser: { name: 'spammer' } } as never;

  list('spammer', now - 29 * DAY, now - DAY);
  assert.equal(await liftOnUnmute(unmute), false, 'the mute ran out yesterday');
  list('spammer', now - 28 * DAY, now + 30_000);
  assert.equal(await liftOnUnmute(unmute), false, 'it runs out within the minute');
  assert.ok(fake.listed('spammer'));

  list('spammer', now - 5 * DAY, now + 23 * DAY);
  assert.equal(await liftOnUnmute(unmute), true, 'weeks left: this one is a decision');
});

test('a burst of matching messages sends the one-time notice once', async () => {
  fake.settings = RECURRING;
  fake.conversation = userConversation(userMessage('m1', 'buy followers'), userMessage('m2', 'buy followers now'));
  await Promise.all([
    handleModMail(event({ messageId: 'ModmailMessage_m1' })),
    handleModMail(event({ messageId: 'ModmailMessage_m2' })),
  ]);
  const replies = fake.calls.filter((c) => c.method === 'reply').map((c) => c.args as Fields);
  assert.equal(replies.filter((r) => !r.isInternal).length, 1, 'one notice to the user');
  const notes = replies.filter((r) => r.isInternal).map((r) => r.body as string);
  assert.equal(notes.length, 2, 'each message still gets its private note');
  for (const note of notes) assert.doesNotMatch(note, /Message to the user FAILED/);
  assert.ok(fake.expirations.get('tip:spammer')! <= 3600);
});

test('an action recorded after the undo finished is still undone on the next run', async () => {
  fake.settings = { patterns: 'buy followers', undoAll: true };
  assert.equal(await runUndo(), 'done');
  const reports = () => fake.calls.filter((c) => c.method === 'createModNotification').length;
  assert.equal(reports(), 1);

  // A ban that was already under way when the setting was saved lands now.
  fake.zsets.set('ledger', [{ member: 'ban|latecomer|k9', score: Date.now() - 1000 }]);
  fake.conversations.set('k9', {
    conversation: { id: 'k9', state: 'InProgress', participant: person('latecomer') },
    user: { banStatus: { isBanned: true, reason: 'x: Modmail regex: y' }, muteStatus: { isMuted: false } },
  });
  assert.equal(await runUndo(), 'done');
  assert.equal(fake.argsOf('unbanUser').username, 'latecomer');
  assert.equal(reports(), 2, 'and the moderators are told again');
});

test('a lock left behind by an interrupted run frees itself', async () => {
  fake.settings = { patterns: 'buy followers', undoAll: true };
  fake.kv.set('undo:lock', '1'); // taken, and the run died before giving it an expiry
  assert.equal(await runUndo(), 'busy');
  assert.equal(fake.expirations.get('undo:lock'), 90, 'the next attempt gives it one');
});

test('a second undo does not reverse again what the first already reversed', async () => {
  // First offence, acted on and logged for the summary.
  fake.settings = { patterns: 'buy followers' };
  fake.conversation = userConversation(userMessage('m1', 'buy followers'));
  await handleModMail(event());
  assert.equal(fake.zsets.get('summary:log')!.length, 1);

  fake.settings = { patterns: 'buy followers', undoAll: true };
  await runUndo();
  assert.equal(fake.zsets.get('summary:log'), undefined, 'reversed actions leave the summary log');

  // Undo off; a moderator archives the conversation by hand; undo on again.
  fake.settings = { patterns: 'buy followers' };
  await runUndo();
  fake.conversation.state = 'Archived';
  fake.calls = [];
  fake.settings = { patterns: 'buy followers', undoAll: true };
  await runUndo();
  assert.deepEqual(fake.methods(), ['createModNotification'], 'nothing is touched this time');
  assert.equal(fake.conversation.state, 'Archived');
});

test('the hourly job still renews mutes when the undo step fails', async () => {
  const server = createServer(handleRequest);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const now = Date.now();
    fake.settings = RECURRING;
    fake.conversation = userConversation(userMessage('m1', 'x'));
    fake.mute = { isMuted: true, endDate: new Date(now + HOUR).toISOString() };
    list('spammer', now - 27 * DAY, now + HOUR);
    // Make the first chore of the hour blow up.
    fake.zsets.set('ledger', undefined as never);
    const realCard = fake.zsets.get.bind(fake.zsets);
    fake.zsets.get = ((key: string) => {
      if (key === 'ledger') throw new Error('storage hiccup');
      return realCard(key);
    }) as never;
    try {
      const rsp = await fetch(`${origin}/internal/scheduler/renew-mutes`, { method: 'POST', body: '{}' });
      assert.equal(rsp.status, 200);
      await rsp.text();
    } finally {
      fake.zsets.get = realCard as never;
    }
    assert.deepEqual(fake.methods(), ['unmuteConversation', 'muteConversation'], 'the renewal went ahead');
  } finally {
    server.close();
  }
});

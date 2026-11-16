// A moderator unmuting someone lifts their permanent mute, in both modes:
// no more renewals, and no more auto-archiving.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { fake, modMailEvent, userConversation, userMessage, type Fields } from './fake-devvit.ts';

const { handleModMail } = await import('../src/modmail.ts');
const { liftOnUnmute, renewMutes } = await import('../src/permamute.ts');

const DAY = 86_400_000;
const HOUR = 3_600_000;

function list(name: string, at: number, until: number): void {
  if (!fake.hashes.has('keepMuted')) fake.hashes.set('keepMuted', new Map());
  fake.hashes
    .get('keepMuted')!
    .set(name, JSON.stringify({ since: at, pattern: 'buy followers', conversationId: 'c1', at, until }));
  const ends = fake.zsets.get('keepMuted:ends') ?? [];
  fake.zsets.set('keepMuted:ends', [...ends.filter((m) => m.member !== name), { member: name, score: until }]);
}

/** The ModAction trigger for a moderator action, as Devvit delivers it. */
const modAction = (overrides: Fields = {}): never =>
  ({
    type: 'ModAction',
    action: 'unmuteuser',
    moderator: { name: 'a_moderator' },
    targetUser: { name: 'spammer' },
    ...overrides,
  }) as never;

beforeEach(() => {
  fake.reset();
  fake.settings = { patterns: 'buy followers', muteDuration: ['permanent'] };
});

test('recurring mutes: a moderator unmutes them, and the app stops renewing', async () => {
  const now = Date.now();
  list('spammer', now - 5 * DAY, now + 23 * DAY);
  assert.equal(await liftOnUnmute(modAction()), true);
  assert.equal(fake.listed('spammer'), undefined);
  assert.equal(fake.renewalDue('spammer'), undefined);

  // 26 days on, when the renewal would have been due: nothing happens.
  assert.deepEqual(await renewMutes(now + 22 * DAY), { renewed: 0, lifted: 0, failed: 0 });
  assert.deepEqual(fake.calls, []);
});

test('auto-archive: a moderator unmutes them during the first 28 days, and their later mail is left alone', async () => {
  fake.settings = { patterns: 'buy followers', muteDuration: ['permanent-archive'] };
  const now = Date.now();
  list('spammer', now - 5 * DAY, now + 23 * DAY);
  assert.equal(await liftOnUnmute(modAction()), true);
  assert.equal(fake.listed('spammer'), undefined);

  // Months later they write in. Without the unmute this would have been archived.
  const sent = new Date(now - HOUR).toISOString().replace('Z', '000+0000');
  fake.conversation = userConversation(userMessage('m7', 'hello, can we talk?', { date: sent }));
  await handleModMail(modMailEvent({ messageId: 'ModmailMessage_m7' }));
  assert.deepEqual(fake.actions(), [], 'the message stays in the inbox for the moderators');
});

test("the app's own unmutes are part of a renewal, not a moderator's decision", async () => {
  const now = Date.now();
  list('spammer', now - 26 * DAY, now + 30 * HOUR);
  for (const name of ['modmail-regex-ban', 'Modmail-Regex-Ban']) {
    assert.equal(await liftOnUnmute(modAction({ moderator: { name } })), false);
  }
  assert.ok(fake.listed('spammer'));

  // And a real renewal, which unmutes and mutes again, leaves them on the list.
  fake.mute = { isMuted: true, endDate: new Date(now + 30 * HOUR).toISOString() };
  fake.conversation = userConversation(userMessage('m1', 'buy followers'));
  await renewMutes(now);
  assert.deepEqual(fake.methods(), ['unmuteConversation', 'muteConversation']);
  assert.ok(fake.listed('spammer'));
});

test('every other moderator action, and unmutes of people the app does not know, are ignored', async () => {
  const now = Date.now();
  list('spammer', now - 5 * DAY, now + 23 * DAY);
  const ignored: Fields[] = [
    { action: 'muteuser' },
    { action: 'banuser' },
    { action: 'unbanuser' },
    { action: 'removelink' },
    { action: undefined },
    { targetUser: { name: 'someone_else' } },
    { targetUser: undefined },
    { moderator: undefined },
  ];
  for (const overrides of ignored) {
    assert.equal(await liftOnUnmute(modAction(overrides)), false, JSON.stringify(overrides));
  }
  assert.ok(fake.listed('spammer'));
  assert.deepEqual(fake.calls, [], 'it never calls Reddit');
});

test('names and the action are matched whatever their capitalisation', async () => {
  const now = Date.now();
  list('spammer', now - 5 * DAY, now + 23 * DAY);
  assert.equal(await liftOnUnmute(modAction({ action: 'UnmuteUser', targetUser: { name: 'SPAMMER' } })), true);
  assert.equal(fake.listed('spammer'), undefined);
});

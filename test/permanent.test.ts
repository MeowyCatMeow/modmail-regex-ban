// The two "Permanent" workarounds. Reddit only lets apps mute for 28 days, so:
//  - recurring:    a scheduled job renews the mute shortly before it ends;
//  - auto-archive: after the first mute, whatever the user sends is archived.
// Archiving by username is also the safety net in recurring mode.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { fake, modMailEvent as event, modMessage, person, setMessages, userConversation, userMessage, type Fields } from './fake-devvit.ts';

const { handleModMail } = await import('../src/modmail.ts');
const { listedAction, muteEnd, renewMutes } = await import('../src/permamute.ts');
const { DEFAULT_RECURRING_MESSAGE } = await import('../src/config.ts');

const replies = (): Fields[] => fake.calls.filter((c) => c.method === 'reply').map((c) => c.args as Fields);
/** The private moderator note. */
const note = (): string => replies().find((r) => r.isInternal)!.body as string;
/** The one-time message to the user about renewal notices, if one was sent. */
const tip = (): Fields | undefined => replies().find((r) => !r.isInternal);

const PATTERNS = 'buy followers';
const RECURRING = { patterns: PATTERNS, muteDuration: ['permanent'] };
const AUTO_ARCHIVE = { patterns: PATTERNS, muteDuration: ['permanent-archive'] };
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MUTE = 28 * DAY;

const summaryLog = (): Fields[] => (fake.zsets.get('summary:log') ?? []).map((m) => JSON.parse(m.member) as Fields);
const nextDelivery = (): void => {
  fake.calls = [];
  for (const key of [...fake.kv.keys()]) if (key.startsWith('handled:')) fake.kv.delete(key);
};

/** Puts a user on the list as if their mute had been applied at `at` and ended at `until`. */
function list(name: string, at: number, until: number, extra: Fields = {}): void {
  if (!fake.hashes.has('keepMuted')) fake.hashes.set('keepMuted', new Map());
  const entry = { since: at, pattern: 'buy followers', conversationId: 'c1', at, until, ...extra };
  fake.hashes.get('keepMuted')!.set(name, JSON.stringify(entry));
  const ends = fake.zsets.get('keepMuted:ends') ?? [];
  fake.zsets.set('keepMuted:ends', [...ends.filter((m) => m.member !== name), { member: name, score: until }]);
}

/** A harmless later message from the listed user, in a new conversation, sent at `sentAt`. */
function writesAgain(sentAt: number): never {
  fake.conversation = userConversation(
    userMessage('m7', 'hello, please unban me', { date: new Date(sentAt).toISOString().replace('Z', '000+0000') }),
  );
  fake.conversation.id = 'c2';
  return event({ conversationId: 'ModmailConversation_c2', messageId: 'ModmailMessage_m7' });
}

beforeEach(() => {
  fake.reset();
  fake.settings = RECURRING;
  fake.conversation = userConversation(userMessage('m1', 'Buy Followers now'));
});

// ---- A pattern match under a Permanent setting -----------------------------------

test('recurring: a match mutes for 28 days, lists the user and schedules the renewal for when Reddit says it ends', async () => {
  const before = Date.now();
  await handleModMail(event());
  // ban, the one-time message to the user, mute, the private note, archive
  assert.deepEqual(fake.methods(), ['banUser', 'reply', 'muteConversation', 'reply', 'archiveConversation']);
  assert.deepEqual(fake.argsOf('muteConversation'), { conversationId: 'c1', numHours: 672 });

  const entry = fake.listed('spammer')!;
  assert.equal(entry.pattern, 'buy followers');
  assert.equal(entry.conversationId, 'c1');
  assert.ok((entry.at as number) >= before);
  assert.equal(entry.until, Date.parse(fake.mute.endDate!), 'the end date comes from Reddit, in its own format');
  assert.ok(Math.abs((entry.until as number) - (before + MUTE)) < 5000);
  assert.equal(fake.renewalDue('spammer'), entry.until);

  assert.match(note(), /Permanent mute \(recurring\): the app will renew this 28-day mute shortly before it ends/);
  assert.match(note(), /To lift it, unmute them in Reddit or add them to "Exempt users" in the app settings/);
});

// ---- Reddit's renewal notices cannot be turned off, so the user is told how to mute them ----

test('recurring: when the mute starts, the user is told once how to silence the renewal notices', async () => {
  await handleModMail(event());
  const message = tip()!;
  assert.equal(message.conversationId, 'c1');
  assert.equal(message.isAuthorHidden, true, 'sent as the subreddit, not under a moderator name');
  assert.ok(!message.isInternal, 'visible to the user');
  assert.equal(message.body, DEFAULT_RECURRING_MESSAGE);
  assert.match(message.body as string, /mute notifications for this conversation in your chat window/);

  // Reddit will not deliver a moderator's message to a muted user, so it must go first.
  const order = fake.methods();
  assert.ok(order.indexOf('reply') < order.indexOf('muteConversation'), 'sent before the mute');
});

test('the message uses the moderators\' own wording, and can be switched off', async () => {
  fake.settings = { ...RECURRING, recurringMuteMessage: '  Bitte Benachrichtigungen stummschalten.  ' };
  await handleModMail(event());
  assert.equal(tip()!.body, 'Bitte Benachrichtigungen stummschalten.');

  for (const off of [{ recurringMuteTip: false }, { recurringMuteMessage: '' }, { recurringMuteMessage: '   ' }]) {
    fake.reset();
    fake.settings = { ...RECURRING, ...off };
    fake.conversation = userConversation(userMessage('m1', 'buy followers'));
    await handleModMail(event());
    assert.equal(tip(), undefined, JSON.stringify(off));
    assert.deepEqual(fake.methods(), ['banUser', 'muteConversation', 'reply', 'archiveConversation']);
  }
});

test('the message is only for recurring mutes, and only once', async () => {
  // Auto-archive and timed mutes are never renewed, so there are no notices to warn about.
  for (const settings of [AUTO_ARCHIVE, { patterns: PATTERNS, muteDuration: ['672'] }]) {
    fake.reset();
    fake.settings = settings;
    fake.conversation = userConversation(userMessage('m1', 'buy followers'));
    await handleModMail(event());
    assert.equal(tip(), undefined);
  }

  // Already on the list (a repeat offence): they have been told before.
  fake.reset();
  fake.settings = RECURRING;
  fake.conversation = userConversation(userMessage('m1', 'buy followers'));
  list('spammer', Date.now() - 40 * DAY, Date.now() - 12 * DAY);
  await handleModMail(event());
  assert.equal(tip(), undefined);

  // The safety net and the renewal job never send it either.
  fake.reset();
  fake.settings = RECURRING;
  const sent = Date.now() - HOUR;
  list('spammer', sent - 30 * DAY, sent - 2 * DAY);
  await handleModMail(writesAgain(sent));
  assert.equal(tip(), undefined);
  mutedUntil(Date.now() + 30 * HOUR);
  fake.calls = [];
  await renewMutes(Date.now());
  assert.deepEqual(fake.methods(), ['unmuteConversation', 'muteConversation']);
});

test('if the message cannot be sent, moderators are told and everything else still happens', async () => {
  fake.failIf = (method, args) =>
    method === 'reply' && !(args as Fields).isInternal ? 'user has blocked the subreddit' : undefined;
  await handleModMail(event());
  assert.deepEqual(fake.methods(), ['banUser', 'muteConversation', 'reply', 'archiveConversation']);
  assert.match(note(), /Message to the user FAILED: user has blocked the subreddit/);
  assert.ok(fake.listed('spammer'));
});

test('auto-archive: a match mutes for 28 days, lists the user and says what happens afterwards', async () => {
  fake.settings = AUTO_ARCHIVE;
  await handleModMail(event());
  assert.deepEqual(fake.argsOf('muteConversation'), { conversationId: 'c1', numHours: 672 });
  assert.ok(fake.listed('spammer'));
  const note = fake.argsOf('reply').body as string;
  assert.match(note, /Permanent mute \(auto-archive\): once this 28-day mute has ended, the app will archive anything they send/);
  assert.match(note, /To lift it, unmute them in Reddit before then, or add them to "Exempt users"/);
});

test('if the first mute fails the user is still listed, and the renewal job is due at once', async () => {
  fake.failures.set('muteConversation', 'Reddit is having a moment');
  await handleModMail(event());
  assert.equal(fake.listed('spammer')?.until, 0);
  assert.equal(fake.renewalDue('spammer'), 0);
  assert.match(note(), /\* Mute FAILED: Reddit is having a moment/);
  // The one-time message has to go out before the mute, so it was already sent;
  // the hourly job will apply the mute it announced.
  assert.ok(tip());
});

test('a timed mute (3, 7 or 28 days) lists nobody', async () => {
  for (const muteDuration of [['72'], ['168'], ['672'], undefined]) {
    fake.reset();
    fake.settings = { patterns: PATTERNS, muteDuration };
    fake.conversation = userConversation(userMessage('m1', 'buy followers'));
    await handleModMail(event());
    assert.equal(fake.listed('spammer'), undefined);
    assert.doesNotMatch(fake.argsOf('reply').body as string, /Permanent/);
  }
});

// ---- Later mail from someone on the list ------------------------------------------

test('recurring safety net: if a mute has lapsed and they write in, they are muted again and the message is archived', async () => {
  const sent = Date.now() - HOUR;
  list('spammer', sent - 30 * DAY, sent - 2 * DAY);
  fake.settings = { ...RECURRING, archive: false };
  await handleModMail(writesAgain(sent));

  assert.deepEqual(fake.methods(), ['muteConversation', 'reply', 'archiveConversation'], 'no ban; archived even with archiving off');
  assert.deepEqual(fake.argsOf('muteConversation'), { conversationId: 'c2', numHours: 672 });
  const note = fake.argsOf('reply').body as string;
  assert.match(note, /u\/spammer is on this subreddit's permanent-mute list \(added \d{4}-\d\d-\d\d after matching `buy followers`\) and wrote in after their mute had lapsed/);
  assert.match(note, /This message was archived automatically\./);
  assert.match(note, /\* Muted again for 28 days/);
  assert.match(note, /To stop this, unmute them in Reddit or add them to "Exempt users"/);

  const entry = fake.listed('spammer')!;
  assert.equal(entry.conversationId, 'c2', 'the newest conversation is the one renewed from now on');
  assert.equal(entry.since, sent - 30 * DAY, 'still listed since the original offence');
  assert.ok((entry.until as number) > Date.now() + 27 * DAY);
  assert.deepEqual(summaryLog().map((e) => ({ p: e.p, o: e.o, c: e.c })), [
    { p: '', o: ['Muted again for 28 days'], c: 'c2' },
  ]);
});

test('auto-archive: once the first mute has ended, their mail is archived by username without muting again', async () => {
  const sent = Date.now() - HOUR;
  list('spammer', sent - 30 * DAY, sent - 2 * DAY);
  fake.settings = { ...AUTO_ARCHIVE, archive: false };
  await handleModMail(writesAgain(sent));

  assert.deepEqual(fake.methods(), ['reply', 'archiveConversation'], 'no ban, no mute');
  const note = fake.argsOf('reply').body as string;
  assert.match(note, /is on this subreddit's permanent-mute list \(.*\), so this message was archived automatically\./);
  assert.doesNotMatch(note, /\* /, 'nothing else was done');
  // There is no mute to undo in this mode, so only the exempt list lifts it.
  assert.match(note, /To stop this, add them to "Exempt users"/);
  assert.doesNotMatch(note, /unmute/);
  assert.deepEqual(summaryLog().map((e) => e.o), [['Archived automatically']]);
  assert.ok(fake.listed('spammer'), 'and they stay on the list');

  // With notes off it is completely silent.
  nextDelivery();
  fake.settings = { ...AUTO_ARCHIVE, addModNote: false };
  await handleModMail(writesAgain(sent));
  assert.deepEqual(fake.methods(), ['archiveConversation']);
});

test('if a moderator unmutes someone, the permanent mute is lifted (both modes)', async () => {
  for (const mode of [RECURRING, AUTO_ARCHIVE]) {
    fake.reset();
    fake.settings = mode;
    // Their mute should still have 18 days to run, yet here is a message from them.
    const sent = Date.now() - HOUR;
    list('spammer', sent - 10 * DAY, sent + 18 * DAY);
    await handleModMail(writesAgain(sent));
    assert.deepEqual(fake.actions(), [], 'the message is left for the moderators');
    assert.equal(fake.listed('spammer'), undefined);
    assert.equal(fake.renewalDue('spammer'), undefined);
  }
});

test('a second message sent in the same burst, before the mute took hold, is archived and nothing else', async () => {
  // First message matched and was acted on a moment ago.
  await handleModMail(event());
  const entry = fake.listed('spammer')!;

  nextDelivery();
  await handleModMail(writesAgain((entry.at as number) - 1500));
  assert.deepEqual(fake.methods(), ['reply', 'archiveConversation'], 'not muted twice, and not mistaken for an unmute');
  assert.deepEqual(fake.listed('spammer'), entry, 'the list entry is untouched');
});

test('someone on the list who matches a pattern again gets the full treatment', async () => {
  const sent = Date.now() - HOUR;
  list('spammer', sent - 30 * DAY, sent - 2 * DAY);
  fake.conversation = userConversation(userMessage('m1', 'buy followers again'));
  await handleModMail(event());
  assert.deepEqual(fake.methods(), ['banUser', 'muteConversation', 'reply', 'archiveConversation']);
  assert.ok((fake.listed('spammer')!.since as number) > sent, 'listed afresh');
});

test('"first message only" and an empty pattern list do not stop the list being enforced', async () => {
  const sent = Date.now() - HOUR;
  list('spammer', sent - 30 * DAY, sent - 2 * DAY);
  fake.settings = { patterns: '', muteDuration: ['permanent'], firstMessageOnly: true };
  fake.conversation = userConversation(
    modMessage('m1', 'You were banned.'),
    userMessage('m2', 'why?', { date: new Date(sent).toISOString() }),
  );
  await handleModMail(event({ messageId: 'ModmailMessage_m2' }));
  assert.deepEqual(fake.methods(), ['muteConversation', 'reply', 'archiveConversation']);
});

test('users who were never listed are left alone when they do not match', async () => {
  setMessages(userMessage('m1', 'why was my post removed?'));
  await handleModMail(event());
  assert.deepEqual(fake.actions(), []);
});

test('choosing a timed mute length, or turning muting off, stops the list being enforced', async () => {
  const sent = Date.now() - HOUR;
  list('spammer', sent - 30 * DAY, sent - 2 * DAY);
  for (const settings of [
    { patterns: PATTERNS, muteDuration: ['672'] },
    { patterns: PATTERNS, muteDuration: ['permanent'], muteEnabled: false },
  ]) {
    nextDelivery();
    fake.settings = settings;
    await handleModMail(writesAgain(sent));
    assert.deepEqual(fake.actions(), []);
    assert.ok(fake.listed('spammer'), 'the list itself is kept');
  }
});

test('exempt users are never acted on and are taken off the list', async () => {
  const sent = Date.now() - HOUR;
  for (const exemptUsers of ['Spammer', 'u/spammer', 'someone\n/u/SPAMMER, other_user']) {
    nextDelivery();
    list('spammer', sent - 30 * DAY, sent - 2 * DAY);
    fake.settings = { ...RECURRING, exemptUsers };
    fake.conversation = userConversation(userMessage('m1', 'I will buy followers again'));
    await handleModMail(event());
    assert.deepEqual(fake.actions(), [], `exempt as "${exemptUsers}": even a matching message is ignored`);
    assert.equal(fake.listed('spammer'), undefined, 'and they are off the list');
    assert.equal(fake.renewalDue('spammer'), undefined);
  }
});

// ---- The decisions on their own ---------------------------------------------------

test('what a message from a listed user calls for', () => {
  const at = 1_000_000_000_000;
  const entry = { since: at, pattern: 'x', conversationId: 'c1', at, until: at + MUTE };
  const cases: [string, number, string, string][] = [
    ['sent just before the mute', at - 5000, 'archive', 'archive'],
    ['sent just after the mute (clock slack)', at + 60_000, 'archive', 'archive'],
    ['sent mid-mute', at + 10 * DAY, 'lifted', 'lifted'],
    ['sent a minute before the end (clock slack)', at + MUTE - 60_000, 'remute', 'archive'],
    ['sent after the end', at + MUTE + DAY, 'remute', 'archive'],
  ];
  for (const [label, sentAt, recurring, archive] of cases) {
    assert.equal(listedAction(entry, sentAt, 'recurring'), recurring, `${label} (recurring)`);
    assert.equal(listedAction(entry, sentAt, 'archive'), archive, `${label} (auto-archive)`);
  }
  // Mute state unknown (a renewal is under way or failed): never read as a moderator's unmute.
  assert.equal(listedAction({ ...entry, until: 0 }, at + 10 * DAY, 'recurring'), 'remute');
  assert.equal(listedAction({ ...entry, until: 0 }, at + 10 * DAY, 'archive'), 'archive');
});

test("the end of a mute comes from Reddit's reply, or is 28 days on when Reddit gives none", () => {
  const now = Date.parse('2026-11-16T09:47:18Z');
  const reddit = { user: { muteStatus: { endDate: '2026-12-14T09:47:18.288000+00:00' } } };
  assert.equal(muteEnd(reddit, now), Date.parse('2026-12-14T09:47:18.288Z'));
  assert.equal(muteEnd(undefined, now), now + MUTE);
  assert.equal(muteEnd({ user: { muteStatus: {} } }, now), now + MUTE);
  assert.equal(muteEnd({ user: { muteStatus: { endDate: 'nonsense' } } }, now), now + MUTE);
  assert.equal(muteEnd({ user: { muteStatus: { endDate: '2020-01-01T00:00:00+00:00' } } }, now), now + MUTE, 'a past date is not believed');
});

// ---- The hourly renewal job -------------------------------------------------------

/** One listed user whose mute, on "Reddit", really is in force until `until`. */
function mutedUntil(until: number, at = until - MUTE): void {
  list('spammer', at, until);
  fake.mute = { isMuted: true, endDate: new Date(until).toISOString() };
  fake.conversation = userConversation(userMessage('m1', 'buy followers'));
  fake.conversation.state = 'Archived';
}

test('renewal: a mute ending within two days is replaced by a fresh 28-day one', async () => {
  const now = Date.now();
  mutedUntil(now + 30 * HOUR);
  assert.deepEqual(await renewMutes(now), { renewed: 1, lifted: 0, failed: 0 });

  // Reddit ignores a mute on top of a mute, so it must be: unmute, then mute.
  // Its mute notice leaves the conversation archived, so there is nothing to put back.
  assert.deepEqual(fake.methods(), ['unmuteConversation', 'muteConversation']);
  assert.equal(fake.conversation.state, 'Archived');
  assert.deepEqual(fake.argsOf('muteConversation'), { conversationId: 'c1', numHours: 672 });
  assert.equal(fake.mute.isMuted, true);

  const entry = fake.listed('spammer')!;
  assert.ok((entry.until as number) > now + 27 * DAY, 'muted for another 28 days');
  assert.equal(fake.renewalDue('spammer'), entry.until, 'and next due just before that ends');
  assert.equal(entry.since, now + 30 * HOUR - MUTE, 'listed since the original offence');
  assert.equal(fake.kv.get('summary:renewed'), '1');

  // Nothing more to do for the next 26 days.
  fake.calls = [];
  assert.deepEqual(await renewMutes(now + DAY), { renewed: 0, lifted: 0, failed: 0 });
  assert.deepEqual(fake.calls, []);
});

test('renewal: if the mute notice ever pulled an archived conversation back to the inbox, it is archived again', async () => {
  const now = Date.now();
  mutedUntil(now + 30 * HOUR);
  fake.muteUnarchives = true;
  await renewMutes(now);
  assert.deepEqual(fake.methods(), ['unmuteConversation', 'muteConversation', 'archiveConversation']);

  // A conversation that was in the inbox to begin with is left there.
  fake.calls = [];
  mutedUntil(now + 30 * HOUR);
  fake.conversation.state = 'InProgress';
  await renewMutes(now);
  assert.deepEqual(fake.methods(), ['unmuteConversation', 'muteConversation']);
});

test('renewal: mutes with more than two days left are not touched', async () => {
  const now = Date.now();
  mutedUntil(now + 3 * DAY);
  assert.deepEqual(await renewMutes(now), { renewed: 0, lifted: 0, failed: 0 });
  assert.deepEqual(fake.calls, []);
});

test('renewal: a mute that already ran out (the job was down) is simply applied again', async () => {
  const now = Date.now();
  list('spammer', now - 30 * DAY, now - 2 * DAY);
  fake.conversation = userConversation(userMessage('m1', 'buy followers'));
  assert.deepEqual(await renewMutes(now), { renewed: 1, lifted: 0, failed: 0 });
  assert.deepEqual(fake.methods(), ['muteConversation'], 'nothing to unmute');
  assert.ok((fake.listed('spammer')!.until as number) > now + 27 * DAY);
});

test('renewal: if a moderator has unmuted the user, the app takes them off the list instead', async () => {
  const now = Date.now();
  mutedUntil(now + 30 * HOUR);
  fake.mute = { isMuted: false, endDate: undefined }; // a moderator unmuted them in Reddit
  assert.deepEqual(await renewMutes(now), { renewed: 0, lifted: 1, failed: 0 });
  assert.deepEqual(fake.actions(), [], 'not muted again');
  assert.equal(fake.listed('spammer'), undefined);
  assert.equal(fake.renewalDue('spammer'), undefined);
});

test('renewal: exempt users, deleted accounts and broken entries are dropped', async () => {
  const now = Date.now();
  mutedUntil(now + 30 * HOUR);
  fake.settings = { ...RECURRING, exemptUsers: 'spammer' };
  assert.deepEqual(await renewMutes(now), { renewed: 0, lifted: 1, failed: 0 });
  assert.deepEqual(fake.calls, [], 'exempt: not even looked up');

  fake.settings = RECURRING;
  mutedUntil(now + 30 * HOUR);
  fake.conversation.participant = person('spammer', { isDeleted: true });
  assert.deepEqual(await renewMutes(now), { renewed: 0, lifted: 1, failed: 0 });
  assert.deepEqual(fake.actions(), []);
  assert.equal(fake.listed('spammer'), undefined);

  list('ghost', now - MUTE, now + HOUR, { conversationId: '' });
  assert.deepEqual(await renewMutes(now), { renewed: 0, lifted: 1, failed: 0 });
  assert.equal(fake.listed('ghost'), undefined);
});

test('renewal only runs in recurring mode', async () => {
  const now = Date.now();
  for (const settings of [AUTO_ARCHIVE, { patterns: PATTERNS, muteDuration: ['672'] }, { ...RECURRING, muteEnabled: false }]) {
    mutedUntil(now + 30 * HOUR);
    fake.settings = settings;
    assert.deepEqual(await renewMutes(now), { renewed: 0, lifted: 0, failed: 0 });
    assert.deepEqual(fake.calls, []);
    assert.ok(fake.listed('spammer'));
  }
});

test('renewal: at most 25 users an hour, soonest-ending first', async () => {
  const now = Date.now();
  // The fake conversation belongs to "spammer", so every other name is dropped
  // as a mismatch: that still shows how many entries one run looks at.
  for (let i = 0; i < 40; i += 1) list(`user_${String(i).padStart(2, '0')}`, now - MUTE, now + i * 60_000);
  fake.conversation = userConversation(userMessage('m1', 'x'));
  const result = await renewMutes(now);
  assert.equal(result.lifted, 25);
  assert.equal(fake.listed('user_24'), undefined, 'the 25 soonest were handled');
  assert.ok(fake.listed('user_25'), 'the rest wait for the next run');
});

test('renewal failures: retried later, sooner if the user is left unmuted, and never given up on', async () => {
  const now = Date.now();

  // Could not even read the conversation: still muted, so try again in 6 hours.
  mutedUntil(now + 30 * HOUR);
  fake.failures.set('getConversation', 'timeout');
  assert.deepEqual(await renewMutes(now), { renewed: 0, lifted: 0, failed: 1 });
  assert.equal(fake.listed('spammer')!.failures, 1);
  assert.equal(fake.listed('spammer')!.until, now + 30 * HOUR, 'still known to be muted');
  // The job looks two days ahead, so "due again in 6 hours" is scored 6 hours + 2 days on.
  assert.equal(fake.renewalDue('spammer'), now + 6 * HOUR + 2 * DAY);
  fake.failures.clear();
  assert.deepEqual(await renewMutes(now + 5 * HOUR), { renewed: 0, lifted: 0, failed: 0 }, 'not retried before then');
  assert.deepEqual(fake.actions(), []);

  // Unmuted but the new mute failed: the user is not muted, so try again in an hour,
  // and treat anything they send meanwhile as a lapse rather than a moderator's unmute.
  fake.failures.clear();
  fake.failures.set('muteConversation', 'Reddit is having a moment');
  assert.deepEqual(await renewMutes(now + 7 * HOUR), { renewed: 0, lifted: 0, failed: 1 });
  assert.deepEqual(fake.methods(), ['unmuteConversation']);
  assert.equal(fake.listed('spammer')!.until, 0);
  assert.equal(fake.listed('spammer')!.failures, 2);
  assert.equal(fake.renewalDue('spammer'), now + 8 * HOUR + 2 * DAY, 'due again in an hour');
  assert.equal(listedAction(fake.listed('spammer') as never, now + 7.5 * HOUR, 'recurring'), 'remute');

  // It works on the next try, and the failure count is cleared.
  fake.failures.clear();
  fake.calls = [];
  assert.deepEqual(await renewMutes(now + 8 * HOUR), { renewed: 1, lifted: 0, failed: 0 });
  assert.deepEqual(fake.methods(), ['muteConversation']);
  assert.equal(fake.listed('spammer')!.failures, 0);

  // A long outage must not quietly end anyone's permanent mute: after eight
  // failures in a row the user stays on the list and is retried once a day.
  mutedUntil(now + 30 * HOUR);
  fake.failures.set('getConversation', 'Reddit is down');
  let at = now;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    at += 7 * HOUR;
    assert.deepEqual(await renewMutes(at), { renewed: 0, lifted: 0, failed: 1 }, `attempt ${attempt}`);
  }
  assert.equal(fake.listed('spammer')!.failures, 8);
  assert.equal(fake.renewalDue('spammer'), at + DAY + 2 * DAY, 'next try in a day');
  assert.deepEqual(await renewMutes(at + 7 * HOUR), { renewed: 0, lifted: 0, failed: 0 }, 'not before then');

  // When Reddit is back, the mute is renewed as if nothing had happened.
  fake.failures.clear();
  fake.calls = [];
  fake.mute = { isMuted: false };
  assert.deepEqual(await renewMutes(at + DAY + HOUR), { renewed: 1, lifted: 0, failed: 0 });
  assert.equal(fake.listed('spammer')!.failures, 0);
  assert.equal(fake.mute.isMuted, true);
});

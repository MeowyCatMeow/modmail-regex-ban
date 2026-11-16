// The settings moderators actually see: the ready-made patterns offered as
// switches (title, then the regex itself), the ban length choices, and the
// default wording of the renewal-notice message.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { beforeEach, test } from 'node:test';
import { fake, modMailEvent as event, userConversation, userMessage, type Fields } from './fake-devvit.ts';

const { handleModMail } = await import('../src/modmail.ts');
const { READY_MADE, switchedOn } = await import('../src/builtins.ts');
const { findMatch, parsePatterns } = await import('../src/patterns.ts');
const { BAN_LENGTHS, DEFAULT_RECURRING_MESSAGE } = await import('../src/config.ts');

const config = JSON.parse(await readFile(new URL('../devvit.json', import.meta.url), 'utf8'));
const fields = config.settings.subreddit;
const switches = fields.readyMade.fields as Record<string, { type: string; label: string; helpText: string; defaultValue: boolean }>;

const allOn = Object.fromEntries(Object.keys(switches).map((key) => [key, true]));
/** Which ready-made pattern, by setting name, catches this text when all are on. */
const caughtBy = (text: string): string | undefined => {
  const hit = findMatch(switchedOn(allOn), [text]);
  return hit && READY_MADE.find((p) => p.source === hit.pattern.source)!.key;
};

beforeEach(() => fake.reset());

test('each ready-made pattern is a switch: a title ending in a colon, then the regex itself', () => {
  assert.equal(Object.keys(switches).length, 5);
  for (const [key, field] of Object.entries(switches)) {
    assert.equal(field.type, 'boolean', key);
    assert.equal(field.defaultValue, false, `${key} is off until a moderator switches it on`);
    assert.match(field.label, /\S:$/, `${key}: the title ends with a colon`);
    // The line under the title is a regex and nothing else: it compiles as written.
    assert.deepEqual(parsePatterns(field.helpText).errors, [], key);
    assert.equal(parsePatterns(field.helpText).patterns.length, 1, key);
  }
});

test('the regex shown under a switch is exactly the regex the app runs', async () => {
  assert.deepEqual(
    READY_MADE.map((p) => [p.key, p.source]),
    Object.entries(switches).map(([key, field]) => [key, field.helpText]),
  );
  assert.equal(READY_MADE[2]!.title, '"Unban me for money"');

  // Switch one on and it shows up, verbatim, in the private note and the ban's mod note.
  fake.settings = { builtinUnbanForMoney: true };
  fake.conversation = userConversation(userMessage('m1', 'yo unban me for money'));
  await handleModMail(event());
  assert.deepEqual(fake.methods(), ['banUser', 'muteConversation', 'reply', 'archiveConversation']);
  const shown = switches.builtinUnbanForMoney!.helpText;
  assert.ok((fake.argsOf('reply').body as string).includes('`' + shown + '`'));
  assert.equal(fake.argsOf('banUser').note, `Modmail regex: ${shown}`);
});

test('nothing is switched on to begin with, so a fresh install does nothing', async () => {
  assert.deepEqual(switchedOn({}), []);
  assert.equal(fields.patterns.defaultValue, undefined, 'the box for your own regexes starts empty');

  // Exactly what Devvit hands over for untouched settings.
  fake.settings = Object.fromEntries(Object.keys(switches).map((key) => [key, false]));
  fake.conversation = userConversation(userMessage('m1', 'unban me for money, I will pay you'));
  await handleModMail(event());
  assert.deepEqual(fake.calls, [], 'no patterns in force, so not even a read');
});

test('only the switches that are on are used, alongside the moderators\' own regexes', async () => {
  const deliver = async (settings: Fields, text: string): Promise<string[]> => {
    fake.reset();
    fake.settings = settings;
    fake.conversation = userConversation(userMessage('m1', text));
    await handleModMail(event());
    return fake.methods();
  };
  const acted = ['banUser', 'muteConversation', 'reply', 'archiveConversation'];

  assert.deepEqual(await deliver({ builtinPayYou: true }, "I'll pay you"), acted);
  assert.deepEqual(await deliver({ builtinPayYou: true }, 'unban me for money'), [], 'that switch is off');
  assert.deepEqual(await deliver({ builtinPayYou: false, patterns: 'crypto' }, "I'll pay you"), []);
  assert.deepEqual(await deliver({ builtinPayYou: false, patterns: 'crypto' }, 'free crypto'), acted);
  assert.deepEqual(await deliver({ builtinPayYou: true, patterns: 'crypto' }, 'free crypto'), acted, 'both sources');
  assert.deepEqual(await deliver({ builtinPayYou: 'true' }, "I'll pay you"), [], 'only a real "on" counts');
});

test('the ready-made patterns catch the kinds of message they are meant for', () => {
  const caught: [string, string][] = [
    ['Hi, I would like to monetize the sub with you', 'builtinBuySub'],
    ['Want to MONETIZE YOUR SUBREDDIT?', 'builtinBuySub'],
    ['I want to buy this subreddit, name your price', 'builtinBuySub'],
    ['Are you interested in selling your community?', 'builtinBuySub'],
    ['id selling subs for money', 'builtinTradeSubs'],
    ['I am buying subreddits for cash', 'builtinTradeSubs'],
    ['unban me for money', 'builtinUnbanForMoney'],
    ['please unban my account for $50', 'builtinUnbanForMoney'],
    ['allow this post and ill pay you', 'builtinPayForPost'],
    ['approve my post and I will make it worth your while, $20', 'builtinPayForPost'],
    ['ill pay you', 'builtinPayYou'],
    ['We can pay u weekly', 'builtinPayYou'],
    ["unban me and I'll pay you whatever you want", 'builtinPayYou'],
  ];
  for (const [text, key] of caught) assert.equal(caughtBy(text), key, text);
});

test('the ready-made patterns leave ordinary modmail alone', () => {
  const ordinary = [
    'Why was my post removed?',
    'Please unban me, I was banned for no reason',
    'Can you approve my post? It follows all the rules.',
    'Where can I buy a mechanical keyboard? Is that allowed in this subreddit?',
    'I do not make any money from my blog, please allow the link',
    'Someone is selling fake tickets in the comments',
    'Will you pay attention to the spam in this community?',
    'How do I join the community?',
  ];
  for (const text of ordinary) assert.equal(caughtBy(text), undefined, `should not match: ${text}`);
});

test('the placeholder shown in the empty box is itself valid', () => {
  const { patterns, errors } = parsePatterns(fields.patterns.placeholder);
  assert.deepEqual(errors, []);
  assert.equal(patterns.length, 2);
});

test('the ban length list offers Permanent first and matches what the app understands', async () => {
  const banLength = fields.ban.fields.banLength;
  assert.equal(banLength.type, 'select');
  assert.equal(banLength.defaultValue, 'permanent');
  assert.deepEqual(
    banLength.options.map((o: { value: string }) => o.value),
    ['permanent', ...BAN_LENGTHS.map(String)],
  );

  // Every choice reaches Reddit as the right ban.
  for (const option of banLength.options as { label: string; value: string }[]) {
    fake.reset();
    fake.settings = { patterns: 'buy followers', banLength: [option.value] };
    fake.conversation = userConversation(userMessage('m1', 'buy followers'));
    await handleModMail(event());
    const ban = fake.argsOf('banUser');
    const note = fake.calls.find((c) => c.method === 'reply')!.args as { body: string };
    if (option.value === 'permanent') {
      assert.equal('duration' in ban, false, 'a permanent ban sends no duration');
      assert.match(note.body, /\* Banned \(permanently\)/);
    } else {
      assert.equal(ban.duration, Number(option.value), option.label);
      assert.ok(note.body.includes(`* Banned (${option.label})`), `note says "${option.label}"`);
    }
  }
});

test('the default renewal-notice message in the settings is the one the app falls back to', () => {
  const mute = fields.mute.fields;
  assert.equal(mute.recurringMuteMessage.defaultValue, DEFAULT_RECURRING_MESSAGE);
  assert.equal(mute.recurringMuteTip.defaultValue, true);
  assert.match(mute.muteDuration.helpText, /apps cannot turn off/);
  assert.match(mute.muteDuration.helpText, /mute notifications/);
  assert.match(mute.muteDuration.helpText, /still message moderators directly outside modmail/);
});

// Sends real HTTP requests to the app's request handler and checks each reply
// the way Devvit's own endpoint caller does before it accepts it.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, test } from 'node:test';
import { fake, modMailEvent, userConversation, userMessage } from './fake-devvit.ts';

const { handleRequest } = await import('../src/http.ts');
const { recordAction, runSummary } = await import('../src/summary.ts');

let server: Server;
let origin = '';

before(async () => {
  server = createServer(handleRequest);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => void server.close());

beforeEach(() => fake.reset());

/** Mirrors the acceptance rules in Devvit's fetchWebbit. */
async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const rsp = await fetch(origin + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await rsp.text();
  assert.ok(rsp.ok, `${path} responded ${rsp.status}: ${text}`);
  assert.ok(Number(rsp.headers.get('content-length')) > 0, 'Content-Length must be present and non-zero');
  assert.match(rsp.headers.get('content-type') ?? '', /application\/json/);
  const json: unknown = JSON.parse(text);
  assert.ok(json && typeof json === 'object' && !Array.isArray(json), 'body must be a JSON object');
  return json as Record<string, unknown>;
}

test('pattern validation accepts good patterns and explains bad ones', async () => {
  assert.deepEqual(await post('/internal/settings/validate-patterns', { value: 'spam\n/x+/i', isEditing: true }), {
    success: true,
  });
  assert.deepEqual(await post('/internal/settings/validate-patterns', { isEditing: false }), { success: true });

  const unclosed = await post('/internal/settings/validate-patterns', { value: 'ok\n(unclosed', isEditing: true });
  assert.equal(unclosed.success, false);
  assert.match(String(unclosed.error), /^Line 2 /);

  const empty = await post('/internal/settings/validate-patterns', { value: 'spam|', isEditing: true });
  assert.equal(empty.success, false);
  assert.match(String(empty.error), /every message/);
});

test('ban message validation enforces the 1000 character limit', async () => {
  const ok = await post('/internal/settings/validate-ban-message', { value: 'x'.repeat(1000), isEditing: true });
  assert.deepEqual(ok, { success: true });
  const tooLong = await post('/internal/settings/validate-ban-message', { value: 'x'.repeat(1001), isEditing: true });
  assert.equal(tooLong.success, false);
});

test('exempt users validation accepts usernames and names the first thing that is not one', async () => {
  for (const value of [undefined, '', 'alice', 'u/alice\n/u/Bob_2, carol-3']) {
    assert.deepEqual(await post('/internal/settings/validate-exempt-users', { value, isEditing: true }), {
      success: true,
    });
  }
  const bad = await post('/internal/settings/validate-exempt-users', { value: 'alice\nnot@valid', isEditing: true });
  assert.equal(bad.success, false);
  assert.match(String(bad.error), /"not@valid" is not a Reddit username/);
});

test('the modmail trigger endpoint runs the handler and replies with an object', async () => {
  fake.settings = { patterns: 'buy followers' };
  fake.conversation = userConversation(userMessage('m1', 'buy followers'));
  assert.deepEqual(await post('/internal/triggers/on-mod-mail', modMailEvent()), {});
  assert.equal(fake.argsOf('banUser').username, 'spammer');
});

test('the scheduler endpoint runs the summary job, as Devvit calls it', async () => {
  // First daily run only starts the period.
  assert.deepEqual(await post('/internal/scheduler/summary', { name: 'summary' }), {});
  assert.ok(fake.kv.get('summary:start'));
  assert.deepEqual(fake.methods(), []);

  // Once the week is over and something happened, the same call sends it.
  await recordAction({ t: Date.now(), u: 'spammer', p: 'buy followers', o: ['Banned (permanently)'], c: 'c1' });
  fake.kv.set('summary:start', String(Date.now() - 8 * 86_400_000));
  assert.deepEqual(await post('/internal/scheduler/summary', { name: 'summary' }), {});
  assert.deepEqual(fake.methods(), ['createModNotification']);
  assert.equal(await runSummary(), 'not-due', 'and a new period has begun');
});

test('the scheduler endpoint for renewing mutes runs the job, as Devvit calls it', async () => {
  // Nothing listed, or not in recurring mode: a quiet no-op.
  assert.deepEqual(await post('/internal/scheduler/renew-mutes', { name: 'renew-mutes' }), {});
  assert.deepEqual(fake.calls, []);

  const now = Date.now();
  fake.settings = { muteDuration: ['permanent'] };
  fake.conversation = userConversation(userMessage('m1', 'x'));
  fake.mute = { isMuted: true, endDate: new Date(now + 3_600_000).toISOString() };
  fake.hashes.set(
    'keepMuted',
    new Map([['spammer', JSON.stringify({ since: 1, pattern: 'x', conversationId: 'c1', at: now - 27 * 86_400_000, until: now + 3_600_000 })]]),
  );
  fake.zsets.set('keepMuted:ends', [{ member: 'spammer', score: now + 3_600_000 }]);
  assert.deepEqual(await post('/internal/scheduler/renew-mutes', { name: 'renew-mutes' }), {});
  assert.deepEqual(fake.methods(), ['unmuteConversation', 'muteConversation']);
});

test('the moderator-action endpoint lifts a permanent mute when a moderator unmutes someone', async () => {
  const until = Date.now() + 20 * 86_400_000; // their mute still has weeks to run
  fake.hashes.set('keepMuted', new Map([['spammer', JSON.stringify({ since: 1, pattern: 'x', conversationId: 'c1', at: 1, until })]]));
  fake.zsets.set('keepMuted:ends', [{ member: 'spammer', score: until }]);

  // Any other moderator action is none of the app's business.
  assert.deepEqual(await post('/internal/triggers/on-mod-action', { type: 'ModAction', action: 'removelink', moderator: { name: 'a_moderator' } }), {});
  assert.ok(fake.listed('spammer'));

  const unmute = { type: 'ModAction', action: 'unmuteuser', moderator: { name: 'a_moderator' }, targetUser: { name: 'Spammer' } };
  assert.deepEqual(await post('/internal/triggers/on-mod-action', unmute), {});
  assert.equal(fake.listed('spammer'), undefined);
  assert.deepEqual(fake.calls, [], 'nothing is sent to Reddit');
});

test('saving the undo setting switched on schedules the undo; saving it off does not', async () => {
  assert.deepEqual(await post('/internal/settings/validate-undo', { value: false, isEditing: true }), { success: true });
  assert.deepEqual(await post('/internal/settings/validate-undo', { isEditing: true }), { success: true });
  assert.equal(fake.jobs.length, 0);

  const before = Date.now();
  assert.deepEqual(await post('/internal/settings/validate-undo', { value: true, isEditing: true }), { success: true });
  assert.equal(fake.jobs.length, 1);
  assert.equal(fake.jobs[0]!.name, 'undo');
  const delay = fake.jobs[0]!.runAt.getTime() - before;
  assert.ok(delay >= 14_000 && delay <= 20_000, 'a few seconds later, once the setting has been stored');
});

test('the undo endpoint does nothing while the setting is off', async () => {
  fake.zsets.set('ledger', [{ member: 'ban|spammer|c1', score: 1 }]);
  assert.deepEqual(await post('/internal/scheduler/undo', { name: 'undo' }), {});
  assert.deepEqual(fake.calls, []);
  assert.equal(fake.zsets.get('ledger')!.length, 1);
});

test('unknown paths and non-POST requests get a 404 with a JSON body', async () => {
  for (const [path, method] of [
    ['/internal/nope', 'POST'],
    ['/internal/triggers/on-mod-mail', 'GET'],
    ['/constructor', 'POST'],
  ] as const) {
    const rsp = await fetch(origin + path, { method });
    assert.equal(rsp.status, 404);
    assert.ok(Number(rsp.headers.get('content-length')) > 0);
    await rsp.text();
  }
});

test('every endpoint named in devvit.json is served, and every select default is a real option', async () => {
  const config = JSON.parse(await readFile(new URL('../devvit.json', import.meta.url), 'utf8'));
  const endpoints: string[] = [];
  const collect = (node: unknown): void => {
    if (typeof node === 'string' && node.startsWith('/internal/')) endpoints.push(node);
    else if (node && typeof node === 'object') {
      const select = node as { type?: string; options?: { value: string }[]; defaultValue?: string };
      if (select.type === 'select') {
        assert.ok(select.options!.some((o) => o.value === select.defaultValue), `default "${select.defaultValue}"`);
      }
      Object.values(node).forEach(collect);
    }
  };
  collect(config.triggers);
  collect(config.scheduler);
  collect(config.settings);
  assert.equal(endpoints.length, 9);
  for (const endpoint of endpoints) {
    const rsp = await fetch(origin + endpoint, { method: 'POST', body: '{}' });
    assert.notEqual(rsp.status, 404, `${endpoint} is not handled`);
    await rsp.text();
  }
});

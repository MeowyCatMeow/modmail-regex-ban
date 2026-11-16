// A fake Devvit runtime for the tests: importing this file replaces
// '@devvit/web/server', so no test ever talks to Reddit. Import it before
// (dynamically) importing anything from ../src.
import { mock } from 'node:test';

export type Fields = Record<string, unknown>;
export type Call = { method: string; args: unknown };
type ZMember = { member: string; score: number };

export const fake = {
  /** Every call that would have reached Reddit, in order. */
  calls: [] as Call[],
  /** What settings.getAll() returns. */
  settings: {} as Fields,
  /** What reddit.modMail.getConversation() returns. */
  conversation: {} as Fields,
  /**
   * The participant's mute state on "Reddit". Muting and unmuting change it the
   * way the live platform does: a mute on top of a mute is silently ignored.
   */
  mute: { isMuted: false } as { isMuted: boolean; endDate?: string | undefined; reason?: string | undefined },
  /** The participant's ban state on "Reddit". As live, the reason is the ban reason plus the mod note. */
  ban: { isBanned: false, isPermanent: false, reason: '' },
  /** Whole replies for particular conversation ids, for tests with more than one user. */
  conversations: new Map<string, Fields>(),
  /** One-off jobs the app asked the scheduler to run. */
  jobs: [] as { name: string; runAt: Date }[],
  /** Pretend "now" for the end date Reddit gives a new mute (defaults to the real time). */
  redditNow: undefined as number | undefined,
  /**
   * Seen live, Reddit's mute notice leaves an archived conversation archived.
   * Set this to pretend it brought the conversation back to the inbox instead.
   */
  muteUnarchives: false,
  /** Make a Reddit call fail: method name -> error message. */
  failures: new Map<string, string>(),
  /** Make particular calls fail: return an error message for the ones that should. */
  failIf: undefined as ((method: string, args: unknown) => string | undefined) | undefined,
  /** Accounts Reddit no longer knows (deleted or suspended), lower-cased. Everyone else exists. */
  gone: new Set<string>(),
  /** When set, decides instead of `gone` whether Reddit knows an account at the moment it is asked. */
  knows: undefined as ((name: string) => boolean) | undefined,
  /** Every account lookup that got an answer, in order. Kept apart from `calls`: they change nothing. */
  lookups: [] as string[],
  kv: new Map<string, string>(),
  hashes: new Map<string, Map<string, string>>(),
  zsets: new Map<string, ZMember[]>(),
  expirations: new Map<string, number>(),

  reset(): void {
    this.calls = [];
    this.settings = {};
    this.conversation = {};
    this.mute = { isMuted: false };
    this.ban = { isBanned: false, isPermanent: false, reason: '' };
    this.conversations = new Map();
    this.jobs = [];
    this.redditNow = undefined;
    this.muteUnarchives = false;
    this.failures = new Map();
    this.failIf = undefined;
    this.gone = new Set();
    this.knows = undefined;
    this.lookups = [];
    this.kv = new Map();
    this.hashes = new Map();
    this.zsets = new Map();
    this.expirations = new Map();
  },
  /** Calls that change something on Reddit (everything except reads). */
  actions(): Call[] {
    return this.calls.filter((c) => c.method !== 'getConversation');
  },
  /** The stored permanent-mute entry for a user, if any. */
  listed(name: string): Fields | undefined {
    const raw = this.hashes.get('keepMuted')?.get(name);
    return raw ? (JSON.parse(raw) as Fields) : undefined;
  },
  /** When the renewal job will next look at a user. */
  renewalDue(name: string): number | undefined {
    return this.zsets.get('keepMuted:ends')?.find((m) => m.member === name)?.score;
  },
  methods(): string[] {
    return this.actions().map((c) => c.method);
  },
  argsOf(method: string): Fields {
    const call = this.calls.find((c) => c.method === method);
    if (!call) throw new Error(`${method} was not called`);
    return call.args as Fields;
  },
};

const call = (method: string, result: unknown = {}) =>
  async (args: unknown): Promise<unknown> => {
    const failure = fake.failures.get(method) ?? fake.failIf?.(method, args);
    if (failure) throw new Error(failure);
    fake.calls.push({ method, args });
    return result;
  };

const zset = (key: string): ZMember[] => {
  if (!fake.zsets.has(key)) fake.zsets.set(key, []);
  return fake.zsets.get(key)!;
};

/**
 * As the SDK's getUserByUsername: a user when Reddit knows the account,
 * undefined when it does not (deleted or suspended), an error for anything else.
 */
const lookup = async (name: string): Promise<{ username: string } | undefined> => {
  const failure = fake.failures.get('getUserByUsername') ?? fake.failIf?.('getUserByUsername', name);
  if (failure) throw new Error(failure);
  fake.lookups.push(name);
  const known = fake.knows ? fake.knows(name) : !fake.gone.has(name.toLowerCase());
  return known ? { username: name } : undefined;
};

mock.module('@devvit/web/server', {
  namedExports: {
    context: {
      subredditName: 'testsub',
      subredditId: 't5_testsub',
      appName: 'modmail-regex-ban',
      appSlug: 'modmail-regex-ban',
    },
    settings: { getAll: async () => fake.settings },
    redis: {
      get: async (key: string) => fake.kv.get(key),
      set: async (key: string, value: string) => void fake.kv.set(key, value),
      del: async (...keys: string[]) => {
        for (const key of keys) {
          fake.kv.delete(key);
          fake.hashes.delete(key);
          fake.zsets.delete(key);
        }
      },
      incrBy: async (key: string, by: number) => {
        const next = Number(fake.kv.get(key) ?? 0) + by;
        fake.kv.set(key, String(next));
        return next;
      },
      expire: async (key: string, seconds: number) => void fake.expirations.set(key, seconds),
      hGet: async (key: string, field: string) => fake.hashes.get(key)?.get(field),
      hSet: async (key: string, values: Record<string, string>) => {
        if (!fake.hashes.has(key)) fake.hashes.set(key, new Map());
        for (const [field, value] of Object.entries(values)) fake.hashes.get(key)!.set(field, value);
        return Object.keys(values).length;
      },
      hDel: async (key: string, fields: string[]) => {
        let removed = 0;
        for (const field of fields) if (fake.hashes.get(key)?.delete(field)) removed += 1;
        return removed;
      },
      zAdd: async (key: string, ...members: ZMember[]) => {
        const set = zset(key);
        for (const member of members) {
          const existing = set.findIndex((m) => m.member === member.member);
          if (existing >= 0) set.splice(existing, 1);
          set.push(member);
        }
        set.sort((a, b) => a.score - b.score);
        return members.length;
      },
      zCard: async (key: string) => zset(key).length,
      zRange: async (
        key: string,
        start: number,
        stop: number,
        options?: { by?: string; limit?: { offset: number; count: number } },
      ) => {
        if (options?.by === 'rank') {
          if (start < 0 || stop < 0) throw new Error('the fake does not support negative ranks');
          return zset(key).slice(start, stop + 1);
        }
        if (options?.by !== 'score') throw new Error('the fake only supports zRange by score or by rank');
        const inRange = zset(key).filter((m) => m.score >= start && m.score <= stop);
        const { offset = 0, count = 1000 } = options.limit ?? {};
        return inRange.slice(offset, offset + count);
      },
      zRem: async (key: string, members: string[]) => {
        const set = zset(key);
        let removed = 0;
        for (const member of members) {
          const index = set.findIndex((m) => m.member === member);
          if (index >= 0) {
            set.splice(index, 1);
            removed += 1;
          }
        }
        return removed;
      },
      hLen: async (key: string) => fake.hashes.get(key)?.size ?? 0,
      hKeys: async (key: string) => [...(fake.hashes.get(key)?.keys() ?? [])],
      hGetAll: async (key: string) => Object.fromEntries(fake.hashes.get(key) ?? []),
      hIncrBy: async (key: string, field: string, by: number) => {
        if (!fake.hashes.has(key)) fake.hashes.set(key, new Map());
        const next = Number(fake.hashes.get(key)!.get(field) ?? 0) + by;
        fake.hashes.get(key)!.set(field, String(next));
        return next;
      },
      zScore: async (key: string, member: string) => zset(key).find((m) => m.member === member)?.score,
      zRemRangeByRank: async (key: string, start: number, stop: number) => {
        if (start < 0 || stop < 0) throw new Error('the fake does not support negative ranks');
        return zset(key).splice(start, stop - start + 1).length;
      },
    },
    scheduler: {
      runJob: async (job: { name: string; runAt: Date }) => {
        fake.jobs.push(job);
        return 'job-' + fake.jobs.length;
      },
    },
    reddit: {
      getUserByUsername: lookup,
      // As the SDK: the app's own account is looked up by the app's name.
      getAppUser: () => lookup('modmail-regex-ban'),
      banUser: async (args: { reason?: string; note?: string; duration?: number }) => {
        await call('banUser')(args);
        fake.ban = { isBanned: true, isPermanent: !args.duration, reason: [args.reason, args.note].filter(Boolean).join(': ') };
        return {};
      },
      unbanUser: async (username: string, subredditName: string) => {
        await call('unbanUser')({ username, subredditName });
        fake.ban = { isBanned: false, isPermanent: false, reason: '' };
      },
      modMail: {
        getConversation: async (args: unknown) => {
          const failure = fake.failures.get('getConversation');
          if (failure) throw new Error(failure);
          fake.calls.push({ method: 'getConversation', args });
          const other = fake.conversations.get((args as { conversationId: string }).conversationId);
          if (other) return other;
          return { conversation: fake.conversation, user: { muteStatus: { ...fake.mute }, banStatus: { ...fake.ban } } };
        },
        muteConversation: async (args: { numHours: number; conversationId: string }) => {
          await call('muteConversation')(args);
          if (!fake.mute.isMuted) {
            const end = (fake.redditNow ?? Date.now()) + args.numHours * 3_600_000;
            fake.mute = {
              isMuted: true,
              endDate: new Date(end).toISOString().replace('Z', '000+00:00'),
              // As live: Reddit records the conversation the mute was placed from.
              reason: 'https://mod.reddit.com/mail/perma/' + args.conversationId,
            };
          }
          if (fake.muteUnarchives) fake.conversation.state = 'InProgress';
          return { user: { muteStatus: { ...fake.mute } }, conversation: { state: fake.conversation.state } };
        },
        unmuteConversation: async (args: unknown) => {
          await call('unmuteConversation')(args);
          fake.mute = { isMuted: false };
          return {};
        },
        unarchiveConversation: async (args: unknown) => {
          await call('unarchiveConversation')(args);
          fake.conversation.state = 'InProgress';
          return {};
        },
        reply: async (args: { isInternal?: boolean }) => {
          // Seen live: Reddit will not deliver a moderator's message to a muted user.
          if (!args.isInternal && fake.mute.isMuted) {
            throw new Error('3 INVALID_ARGUMENT: Bad request: Participant has been muted from the subreddit.');
          }
          return call('reply')(args);
        },
        archiveConversation: async (args: unknown) => {
          await call('archiveConversation')(args);
          fake.conversation.state = 'Archived';
          return {};
        },
        createModNotification: call('createModNotification', 'newconv'),
      },
    },
  },
});

// ---- Shapes as the live platform returns them --------------------------------

export const person = (name: string, extra: Fields = {}): Fields => ({
  name,
  isMod: false,
  isAdmin: false,
  isOp: true,
  isParticipant: true,
  isApproved: false,
  isHidden: false,
  isDeleted: false,
  ...extra,
});

/** A message as the conversation API returns it, written by the participant unless overridden. */
export const userMessage = (id: string, bodyMarkdown: string, extra: Fields = {}): Fields => ({
  id,
  date: `2026-01-0${id.slice(1)}T00:00:00.000000+0000`,
  author: person('spammer'),
  participatingAs: 'participant_user',
  isInternal: false,
  bodyMarkdown,
  body: `<p>${bodyMarkdown}</p>`,
  ...extra,
});

export const modMessage = (id: string, bodyMarkdown: string): Fields =>
  userMessage(id, bodyMarkdown, {
    author: person('a_moderator', { isMod: true, isParticipant: false }),
    participatingAs: 'moderator',
  });

/** A conversation between the subreddit and the regular user "spammer". */
export const userConversation = (...messages: Fields[]): Fields => ({
  id: 'c1',
  subject: 'hello',
  conversationType: 'sr_user',
  isAuto: false,
  isInternal: false,
  participant: person('spammer'),
  messages: Object.fromEntries(messages.map((m) => [m.id as string, m])),
});

export const setMessages = (...messages: Fields[]): void => {
  fake.conversation.messages = Object.fromEntries(messages.map((m) => [m.id as string, m]));
};

/** The ModMail trigger as Devvit delivers it: prefixed ids, `ParticipatingAs_*` roles. */
export const modMailEvent = (overrides: Fields = {}): never =>
  ({
    type: 'ModMail',
    messageAuthor: { name: 'spammer' },
    messageAuthorType: 'ParticipatingAs_PARTICIPANT_USER',
    conversationType: 'sr_user',
    conversationState: 'new',
    isAutoGenerated: false,
    conversationId: 'ModmailConversation_c1',
    messageId: 'ModmailMessage_m1',
    ...overrides,
  }) as never;

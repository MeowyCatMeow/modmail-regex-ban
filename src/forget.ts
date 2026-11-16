// Reddit's rule for apps: once an account is deleted, nothing that identifies
// it may stay in the app's storage. Devvit sends no event when an account is
// deleted, so the app has to find out for itself.
//
// The app holds usernames in three places: the permanent-mute list, the record
// that "Undo everything" works from, and the actions waiting for the next
// summary. Every account named there is looked up about once a week.
//
// Reddit answers "not found" for a deleted account, and also for a suspended
// one, and the app cannot tell the two apart. Site suspensions are often only a
// few days long, and someone who is back afterwards must still be on the
// permanent-mute list. So one "not found" erases nothing: the account is asked
// about again ten days later, and only if Reddit still does not know it is
// everything the app kept about it erased.
import { reddit, redis } from '@devvit/web/server';
import { parseLedgerMember } from './ledger.ts';
import { removeKeptMuted } from './permamute.ts';
import { KEYS } from './storage.ts';
import { errorText } from './text.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** How often an account that still exists is looked up again. */
export const RECHECK_MS = 7 * DAY;
/** How long after a first "not found" the account is asked about again before anything is erased. */
export const CONFIRM_AFTER_MS = 10 * DAY;
/** How often the list of accounts to check is rebuilt from what the app holds. */
const SYNC_EVERY_MS = DAY;
/**
 * Per hourly run. 100 an hour is 72,000 in 30 days, more than the app can hold
 * records for, so every stored account is asked about well within a month.
 */
export const LOOKUPS_PER_RUN = 100;
const TIME_BUDGET_MS = 20_000;
/** After a lookup that failed (which is not an answer either way). */
const RETRY_AFTER_MS = 6 * HOUR;
const PAGE = 1000;
const CHUNK = 500;

export type ForgetResult = {
  /** Accounts Reddit gave an answer about. */
  checked: number;
  /** Accounts "not found" for the first time: nothing erased yet, asked about again later. */
  missing: number;
  /** Accounts still "not found" at the second asking, whose data was erased. */
  forgotten: number;
  /** Lookups that failed and will be tried again. */
  failed: number;
};

/** Reads a whole sorted set, a page at a time. */
async function allMembers(key: string): Promise<string[]> {
  const members: string[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await redis.zRange(key, offset, offset + PAGE - 1, { by: 'rank' });
    for (const { member } of page) members.push(member);
    if (page.length < PAGE) return members;
  }
}

async function inChunks(items: string[], run: (chunk: string[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += CHUNK) await run(items.slice(i, i + CHUNK));
}

/**
 * The user an entry in the summary log is about, lower-cased. Deliberately more
 * forgiving than the summary's own reader: an entry it would skip must still be
 * recognised as someone's here.
 */
function summaryUser(member: string): string | undefined {
  try {
    const name = (JSON.parse(member) as { u?: unknown }).u;
    return typeof name === 'string' && name ? name.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

const ledgerUser = (member: string): string | undefined => parseLedgerMember(member)?.name.toLowerCase();

/**
 * Every username the app holds anything about, lower-cased. Whatever is read
 * here must also be erased in forgetAccounts(): a new place that stores
 * usernames has to be added to both.
 */
async function heldNames(): Promise<Set<string>> {
  const names = new Set<string>();
  const add = (name: string | undefined): void => {
    if (name) names.add(name);
  };
  (await redis.hKeys(KEYS.keepMuted)).forEach((name) => add(name.toLowerCase()));
  (await allMembers(KEYS.muteEnds)).forEach((name) => add(name.toLowerCase()));
  (await allMembers(KEYS.summaryLog)).forEach((member) => add(summaryUser(member)));
  (await allMembers(KEYS.ledger)).forEach((member) => add(ledgerUser(member)));
  (await redis.hKeys(KEYS.undoAttempts)).forEach((member) => add(ledgerUser(member)));
  return names;
}

/**
 * Brings the list of accounts to check in line with what the app holds. Names
 * it has started holding something about are added, due at once. Names it no
 * longer holds anything about are dropped, so the list keeps a username at most
 * a day longer than the data it stands for.
 */
async function syncAccounts(now: number): Promise<void> {
  const held = await heldNames();
  const listed = new Set(await allMembers(KEYS.accounts));
  const added = [...held].filter((name) => !listed.has(name));
  const dropped = [...listed].filter((name) => !held.has(name));
  const staleMarks = (await redis.hKeys(KEYS.accountsMissing)).filter((name) => !held.has(name));

  await inChunks(added, (chunk) => redis.zAdd(KEYS.accounts, ...chunk.map((member) => ({ member, score: now }))));
  await inChunks(dropped, (chunk) => redis.zRem(KEYS.accounts, chunk));
  await inChunks(staleMarks, (chunk) => redis.hDel(KEYS.accountsMissing, chunk));
  await redis.set(KEYS.accountsSynced, String(now));
}

/** Erases everything the app holds about these accounts. Changes nothing on Reddit. */
async function forgetAccounts(names: string[]): Promise<void> {
  const gone = new Set(names);
  if (gone.size === 0) return;

  for (const name of gone) {
    await removeKeptMuted(name);
    await redis.del(KEYS.tipSent(name));
  }
  const removeFrom = async (key: string, userOf: (member: string) => string | undefined): Promise<void> => {
    const theirs = (await allMembers(key)).filter((member) => gone.has(userOf(member) ?? ''));
    await inChunks(theirs, (chunk) => redis.zRem(key, chunk));
  };
  await removeFrom(KEYS.summaryLog, summaryUser);
  await removeFrom(KEYS.ledger, ledgerUser);
  const attempts = (await redis.hKeys(KEYS.undoAttempts)).filter((member) => gone.has(ledgerUser(member) ?? ''));
  if (attempts.length > 0) await redis.hDel(KEYS.undoAttempts, attempts);
  await redis.hDel(KEYS.accountsMissing, names);

  // Last, so that a run cut short part-way finds them still listed and finishes the job.
  await redis.zRem(KEYS.accounts, names);
}

/** Whether Reddit finds the app's own account: proof that lookups are answering properly right now. */
async function lookupsWork(): Promise<boolean> {
  try {
    return (await reddit.getAppUser()) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Runs every hour. Looks up the accounts that are due a check, and erases what
 * the app holds about the ones Reddit has not known for ten days.
 */
export async function forgetDeletedAccounts(now: number = Date.now()): Promise<ForgetResult> {
  const result: ForgetResult = { checked: 0, missing: 0, forgotten: 0, failed: 0 };

  const synced = Number(await redis.get(KEYS.accountsSynced)) || 0;
  if (now - synced >= SYNC_EVERY_MS) await syncAccounts(now);

  const due = await redis.zRange(KEYS.accounts, 0, now, {
    by: 'score',
    limit: { offset: 0, count: LOOKUPS_PER_RUN },
  });
  if (due.length === 0) return result;

  // "Not found" is only believed while a lookup that must succeed does: the
  // app's own account, asked about before the batch and again after it. If
  // Reddit is having trouble, nothing is noted and nothing is erased.
  if (!(await lookupsWork())) {
    console.warn("Deleted-account check skipped: Reddit did not find the app's own account");
    return result;
  }

  const started = Date.now();
  const found: string[] = [];
  const notFound: string[] = [];
  let lastError = '';
  for (const { member: name } of due) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    try {
      ((await reddit.getUserByUsername(name)) ? found : notFound).push(name);
      result.checked += 1;
    } catch (err) {
      // Not an answer either way: keep what is held and ask again later.
      result.failed += 1;
      await redis.zAdd(KEYS.accounts, { member: name, score: now + RETRY_AFTER_MS });
      // The log must not end up naming an account this job exists to forget.
      const literal = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      lastError = errorText(err).replace(new RegExp(literal, 'gi'), '(the account)');
    }
  }
  if (lastError) console.error(`Deleted-account check: ${result.failed} lookup(s) failed, last error: ${lastError}`);

  if (found.length > 0) {
    await redis.zAdd(KEYS.accounts, ...found.map((member) => ({ member, score: now + RECHECK_MS })));
    // Back again, or never gone: any earlier "not found" is void.
    await redis.hDel(KEYS.accountsMissing, found);
  }
  if (notFound.length === 0) return result;

  if (!(await lookupsWork())) {
    // They stay due, and are asked about again on the next run.
    console.warn('Deleted-account check: lookups stopped working during the run, so its "not found" answers were ignored');
    return result;
  }
  const confirmed: string[] = [];
  for (const name of notFound) {
    const since = Number(await redis.hGet(KEYS.accountsMissing, name)) || 0;
    if (since && now - since >= CONFIRM_AFTER_MS) {
      confirmed.push(name);
      continue;
    }
    if (!since) {
      await redis.hSet(KEYS.accountsMissing, { [name]: String(now) });
      result.missing += 1;
    }
    await redis.zAdd(KEYS.accounts, { member: name, score: (since || now) + CONFIRM_AFTER_MS });
  }
  await forgetAccounts(confirmed);
  result.forgotten = confirmed.length;
  return result;
}

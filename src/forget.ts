// Reddit's rule for apps: once an account is deleted, nothing that identifies
// it may stay in the app's storage. Devvit sends no event when an account is
// deleted, so the app has to find out for itself.
//
// The app holds usernames in three places: the permanent-mute list, the record
// that "Undo everything" works from, and the actions waiting for the next
// summary. Every account named there is looked up about once a week. When
// Reddit no longer knows an account, everything the app kept about it is
// erased. Reddit answers the same way for a suspended account and the app
// cannot tell the two apart, so a suspended account is forgotten as well.
import { reddit, redis } from '@devvit/web/server';
import { parseLedgerMember } from './ledger.ts';
import { removeKeptMuted } from './permamute.ts';
import { KEYS } from './storage.ts';
import { errorText } from './text.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** How often an account that still exists is looked up again. */
export const RECHECK_MS = 7 * DAY;
/** How often the list of accounts to check is rebuilt from what the app holds. */
const SYNC_EVERY_MS = DAY;
/** Per hourly run. 60 an hour gets through about 10,000 accounts a week. */
export const LOOKUPS_PER_RUN = 60;
const TIME_BUDGET_MS = 20_000;
/** After a lookup that failed (which is not an answer either way). */
const RETRY_AFTER_MS = 6 * HOUR;
const PAGE = 1000;
const CHUNK = 500;

export type ForgetResult = {
  /** Accounts Reddit gave an answer about. */
  checked: number;
  /** Accounts Reddit no longer knows, whose data was erased. */
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

/** The user an entry in the summary log is about. */
function summaryUser(member: string): string | undefined {
  try {
    const name = (JSON.parse(member) as { u?: unknown }).u;
    return typeof name === 'string' && name ? name.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

const ledgerUser = (member: string): string | undefined => parseLedgerMember(member)?.name.toLowerCase();

/** Every username the app holds anything about, lower-cased. */
async function heldNames(): Promise<Set<string>> {
  const names = new Set<string>();
  const add = (name: string | undefined): void => {
    if (name) names.add(name.toLowerCase());
  };
  (await redis.hKeys(KEYS.keepMuted)).forEach(add);
  (await allMembers(KEYS.muteEnds)).forEach(add);
  (await allMembers(KEYS.summaryLog)).forEach((member) => add(summaryUser(member)));
  (await allMembers(KEYS.ledger)).forEach((member) => add(ledgerUser(member)));
  (await redis.hKeys(KEYS.undoAttempts)).forEach((member) => add(ledgerUser(member)));
  return names;
}

/**
 * Brings the list of accounts to check in line with what the app holds. Names
 * it has started holding something about are added, due at once; names it no
 * longer holds anything about are dropped, so that the list itself never keeps
 * a username longer than the data it stands for.
 */
async function syncAccounts(now: number): Promise<void> {
  const held = await heldNames();
  const listed = new Set(await allMembers(KEYS.accounts));
  const added = [...held].filter((name) => !listed.has(name));
  const dropped = [...listed].filter((name) => !held.has(name));
  for (let i = 0; i < added.length; i += CHUNK) {
    await redis.zAdd(KEYS.accounts, ...added.slice(i, i + CHUNK).map((member) => ({ member, score: now })));
  }
  for (let i = 0; i < dropped.length; i += CHUNK) {
    await redis.zRem(KEYS.accounts, dropped.slice(i, i + CHUNK));
  }
  await redis.set(KEYS.accountsSynced, String(now));
}

/** Erases everything the app holds about these accounts. Changes nothing on Reddit. */
export async function forgetAccounts(names: Iterable<string>): Promise<void> {
  const gone = new Set([...names].map((name) => name.toLowerCase()));
  if (gone.size === 0) return;

  for (const name of gone) {
    await removeKeptMuted(name);
    await redis.del(KEYS.tipSent(name));
  }
  const removeFrom = async (key: string, userOf: (member: string) => string | undefined): Promise<void> => {
    const theirs = (await allMembers(key)).filter((member) => gone.has(userOf(member) ?? ''));
    for (let i = 0; i < theirs.length; i += CHUNK) await redis.zRem(key, theirs.slice(i, i + CHUNK));
  };
  await removeFrom(KEYS.summaryLog, summaryUser);
  await removeFrom(KEYS.ledger, ledgerUser);
  const attempts = (await redis.hKeys(KEYS.undoAttempts)).filter((member) => gone.has(ledgerUser(member) ?? ''));
  if (attempts.length > 0) await redis.hDel(KEYS.undoAttempts, attempts);

  // Last, so that a run cut short part-way finds them still listed and finishes the job.
  await redis.zRem(KEYS.accounts, [...gone]);
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
 * Runs every hour. Looks up the accounts that are due a check and erases what
 * the app holds about the ones Reddit no longer knows.
 */
export async function forgetDeletedAccounts(now: number = Date.now()): Promise<ForgetResult> {
  const result: ForgetResult = { checked: 0, forgotten: 0, failed: 0 };

  const synced = Number(await redis.get(KEYS.accountsSynced)) || 0;
  if (now - synced >= SYNC_EVERY_MS) await syncAccounts(now);

  const due = await redis.zRange(KEYS.accounts, 0, now, {
    by: 'score',
    limit: { offset: 0, count: LOOKUPS_PER_RUN },
  });
  if (due.length === 0) return result;

  // Erasing cannot be taken back, so "not found" is only believed while a
  // lookup that must succeed does: the app's own account, asked about before
  // the batch and again after it. If Reddit is having trouble, nothing is erased.
  if (!(await lookupsWork())) {
    console.warn("Deleted-account check skipped: Reddit did not find the app's own account");
    return result;
  }

  const started = Date.now();
  const found: string[] = [];
  const gone: string[] = [];
  let lastError = '';
  for (const { member: name } of due) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    try {
      ((await reddit.getUserByUsername(name)) ? found : gone).push(name);
      result.checked += 1;
    } catch (err) {
      // Not an answer either way: keep what is held and ask again later.
      result.failed += 1;
      lastError = errorText(err);
      await redis.zAdd(KEYS.accounts, { member: name, score: now + RETRY_AFTER_MS });
    }
  }
  if (lastError) console.error(`Deleted-account check: ${result.failed} lookup(s) failed, last error: ${lastError}`);

  if (found.length > 0) {
    await redis.zAdd(KEYS.accounts, ...found.map((member) => ({ member, score: now + RECHECK_MS })));
  }
  if (gone.length > 0) {
    if (!(await lookupsWork())) {
      // They stay due, and are asked about again on the next run.
      console.warn('Deleted-account check: lookups stopped working during the run, so nothing was erased');
      return result;
    }
    await forgetAccounts(gone);
    result.forgotten = gone.length;
  }
  return result;
}

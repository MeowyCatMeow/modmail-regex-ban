// "Undo everything the app has done."
//
// While that setting is on, the app works through its record of bans, mutes
// and archived conversations and reverses each one, a few at a time, then
// tells the moderators what it did. It only reverses what is still the app's
// own doing: a ban a moderator has since changed, or a mute placed from another
// conversation, is left alone. Private notes and messages cannot be unsent.
import { context, reddit, redis, scheduler, settings } from '@devvit/web/server';
import { readConfig, type RawSettings } from './config.ts';
import { ledgerMember, parseLedgerMember, type LedgerEntry } from './ledger.ts';
import { KEYS } from './storage.ts';
import { errorText } from './text.ts';

/** The scheduler task that continues an undo; see devvit.json. */
export const UNDO_TASK = 'undo';

const BATCH = 15;
const TIME_BUDGET_MS = 20_000;
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = 60_000;
const NEXT_BATCH_AFTER_MS = 3_000;
const LOCK_SECONDS = 90;
const DAY = 24 * 60 * 60 * 1000;
/** The app's bans carry this in their mod note, which Reddit shows in the ban's reason. */
const OUR_BAN = 'Modmail regex:';

type Outcome = 'unbanned' | 'unmuted' | 'unarchived' | 'leftAlone';

type UndoState = {
  status: 'running' | 'done';
  startedAt: number;
  unbanned: number;
  unmuted: number;
  unarchived: number;
  /** Already over, or changed by a moderator since. */
  leftAlone: number;
  failed: number;
};

export type UndoResult = 'off' | 'busy' | 'running' | 'done';

/** Asks the scheduler to run (or continue) the undo shortly. */
export async function kickUndo(delayMs: number): Promise<void> {
  try {
    await scheduler.runJob({ name: UNDO_TASK, runAt: new Date(Date.now() + delayMs) });
  } catch (err) {
    // The hourly job also runs the undo, so a failed kick only delays it.
    console.error(`Could not schedule the undo: ${errorText(err)}`);
  }
}

function loadState(raw: string | undefined): UndoState | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as UndoState;
  } catch {
    return undefined;
  }
}

/**
 * Adds what the app is known to have done before it kept a full record: the
 * actions waiting for the next summary, and everyone on the permanent-mute list.
 */
async function seedLedger(now: number): Promise<void> {
  const members = new Set<string>();
  for (const { member } of await redis.zRange(KEYS.summaryLog, 0, now + DAY, { by: 'score' })) {
    try {
      const entry = JSON.parse(member) as { u?: string; c?: string; o?: string[] };
      if (!entry.u || !entry.c) continue;
      const done = (entry.o ?? []).join(' ');
      if (/\bBanned\b/.test(done)) members.add(ledgerMember({ kind: 'ban', name: entry.u, conversationId: entry.c }));
      if (/\bMuted\b/.test(done)) members.add(ledgerMember({ kind: 'mute', name: entry.u, conversationId: entry.c }));
      members.add(ledgerMember({ kind: 'archive', name: entry.u, conversationId: entry.c }));
    } catch {
      // Not an entry this version understands.
    }
  }
  for (const [name, raw] of Object.entries(await redis.hGetAll(KEYS.keepMuted))) {
    try {
      const conversationId = String((JSON.parse(raw) as { conversationId?: string }).conversationId ?? '');
      if (conversationId) members.add(ledgerMember({ kind: 'mute', name, conversationId }));
    } catch {
      // Ignore a damaged entry.
    }
  }
  for (const member of members) {
    // Do not disturb the timing of anything already on record.
    if ((await redis.zScore(KEYS.ledger, member)) === undefined) {
      await redis.zAdd(KEYS.ledger, { member, score: now - 1 });
    }
  }
}

type Fetched = Awaited<ReturnType<typeof reddit.modMail.getConversation>>;

/** Reverses one recorded action, if it is still the app's own doing. */
async function undoOne(entry: LedgerEntry, fetched: Map<string, Fetched>): Promise<Outcome> {
  const { conversationId } = entry;
  let current = fetched.get(conversationId);
  if (!current) {
    current = await reddit.modMail.getConversation({ conversationId });
    fetched.set(conversationId, current);
  }

  if (entry.kind === 'archive') {
    if (current.conversation?.state !== 'Archived') return 'leftAlone';
    await reddit.modMail.unarchiveConversation(conversationId);
    fetched.delete(conversationId);
    return 'unarchived';
  }

  if (entry.kind === 'mute') {
    const mute = current.user?.muteStatus;
    // Reddit records which conversation a mute was placed from. If that is a
    // different one, someone else muted them since: not ours to undo.
    if (!mute?.isMuted || (mute.reason && !mute.reason.includes(conversationId))) return 'leftAlone';
    await reddit.modMail.unmuteConversation(conversationId);
    fetched.delete(conversationId);
    return 'unmuted';
  }

  const ban = current.user?.banStatus;
  if (!ban?.isBanned || !String(ban.reason ?? '').includes(OUR_BAN)) return 'leftAlone';
  await reddit.unbanUser(entry.name, context.subredditName);
  fetched.delete(conversationId);
  return 'unbanned';
}

async function report(state: UndoState): Promise<void> {
  const lines = [
    'You switched on **Undo everything the app has done** in the settings of Modmail Regex Ban. It has finished:',
    `* Users unbanned: ${state.unbanned}`,
    `* Users unmuted: ${state.unmuted}`,
    `* Conversations moved back to the inbox: ${state.unarchived}`,
    `* Left alone, because they had already ended or a moderator had changed them: ${state.leftAlone}`,
    ...(state.failed > 0 ? [`* Could not be undone: ${state.failed}`] : []),
    'Private notes and messages the app sent are still there; those cannot be removed.',
    'The app is paused and will take no action until you switch that setting off again.',
  ];
  await reddit.modMail.createModNotification({
    subject: 'Modmail Regex Ban: its actions have been undone',
    bodyMarkdown: lines.join('\n\n'),
    subredditId: context.subredditId,
  });
}

/**
 * One step of the undo. Runs when the setting is saved, from the scheduler
 * until the record is empty, and from the hourly job as a safety net.
 */
export async function runUndo(now: number = Date.now()): Promise<UndoResult> {
  const config = readConfig(await settings.getAll<RawSettings>());
  if (!config.undoAll) {
    // Switched off again: forget the last run, so the next one starts afresh.
    await redis.del(KEYS.undoState, KEYS.undoAttempts);
    return 'off';
  }

  const holders = await redis.incrBy(KEYS.undoLock, 1);
  // Set the expiry on every attempt, not only the first: if a run was cut off
  // between taking the lock and giving it an expiry, this is what frees it.
  await redis.expire(KEYS.undoLock, LOCK_SECONDS);
  if (holders > 1) return 'busy';
  try {
    let state = loadState(await redis.get(KEYS.undoState));
    if (state?.status === 'done') {
      // Normally there is nothing more to do. But an action that was already
      // under way when the setting was switched on may have been recorded since.
      if ((await redis.zCard(KEYS.ledger)) === 0) return 'done';
      state.status = 'running';
    }
    if (!state) {
      state = { status: 'running', startedAt: now, unbanned: 0, unmuted: 0, unarchived: 0, leftAlone: 0, failed: 0 };
      await seedLedger(now);
      await redis.set(KEYS.undoState, JSON.stringify(state));
    }

    const started = Date.now();
    const fetched = new Map<string, Fetched>();
    const batch = await redis.zRange(KEYS.ledger, 0, now, { by: 'score', limit: { offset: 0, count: BATCH } });
    for (const { member } of batch) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      const entry = parseLedgerMember(member);
      if (!entry) {
        await redis.zRem(KEYS.ledger, [member]);
        continue;
      }
      try {
        state[await undoOne(entry, fetched)] += 1;
        await redis.zRem(KEYS.ledger, [member]);
        await redis.hDel(KEYS.undoAttempts, [member]);
      } catch (err) {
        const attempts = await redis.hIncrBy(KEYS.undoAttempts, member, 1);
        console.error(`Could not undo ${member} (attempt ${attempts}): ${errorText(err)}`);
        if (attempts >= MAX_ATTEMPTS) {
          state.failed += 1;
          await redis.zRem(KEYS.ledger, [member]);
          await redis.hDel(KEYS.undoAttempts, [member]);
        } else {
          await redis.zAdd(KEYS.ledger, { member, score: now + RETRY_AFTER_MS });
        }
      }
    }

    if ((await redis.zCard(KEYS.ledger)) > 0) {
      await redis.set(KEYS.undoState, JSON.stringify(state));
      // Anything left that was not in this batch is either the next batch or a retry.
      await kickUndo(batch.length > 0 ? NEXT_BATCH_AFTER_MS : RETRY_AFTER_MS);
      return 'running';
    }

    // Nothing left: nobody is to be kept muted any more either. The actions
    // waiting for the next summary have been reversed, so they are dropped too;
    // otherwise a later undo would find them there and reverse them again.
    await redis.del(KEYS.keepMuted, KEYS.muteEnds, KEYS.undoAttempts, KEYS.summaryLog, KEYS.summaryTotal);
    state.status = 'done';
    await redis.set(KEYS.undoState, JSON.stringify(state));
    console.log(
      `Undo finished: ${state.unbanned} unbanned, ${state.unmuted} unmuted, ${state.unarchived} unarchived, ` +
        `${state.leftAlone} left alone, ${state.failed} failed`,
    );
    try {
      await report(state);
    } catch (err) {
      console.error(`Undo finished but the report could not be sent: ${errorText(err)}`);
    }
    return 'done';
  } finally {
    await redis.del(KEYS.undoLock);
  }
}

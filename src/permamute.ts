// The permanent-mute list: users muted under one of the "Permanent" settings.
//
// Reddit only lets apps mute for 28 days. In `recurring` mode a scheduled job
// renews each mute shortly before it ends, so nothing from that user reaches
// modmail. In `archive` mode nothing is renewed; whatever the user sends after
// the first mute has ended is archived. Archiving by username is also the
// safety net in `recurring` mode, for a message that slips through a lapse.
import { reddit, redis, settings } from '@devvit/web/server';
import type { OnModActionRequest } from '@devvit/web/shared';
import { LONGEST_MUTE_HOURS, readConfig, type PermanentMode, type RawSettings } from './config.ts';
import { isAppAccount } from './self.ts';
import { KEYS } from './storage.ts';
import { errorText } from './text.ts';

export type KeptMuted = {
  /** When the user was put on the list. */
  since: number;
  /** The pattern that put them there. */
  pattern: string;
  /** The conversation whose mute keeps them muted. */
  conversationId: string;
  /** When the current mute was applied. */
  at: number;
  /** When Reddit says it ends; 0 when the app does not know them to be muted. */
  until: number;
  /** Consecutive failed renewals. */
  failures?: number;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Renew this long before a mute ends, so a missed run or two does no harm. */
const RENEW_AHEAD_MS = 48 * HOUR;
/** Per hourly run. 25 an hour keeps roughly 15,000 users muted. */
const BATCH = 25;
const TIME_BUDGET_MS = 20_000;
const RETRY_AFTER_MS = 6 * HOUR;
/** After this many failures in a row, keep trying but only once a day. */
const MAX_FAILURES = 8;
const DAY = 24 * HOUR;
/** Slack for comparing Reddit's clock and timestamps with ours. */
const SLACK_MS = 2 * MINUTE;

export async function getKeptMuted(name: string): Promise<KeptMuted | undefined> {
  const raw = await redis.hGet(KEYS.keepMuted, name);
  if (!raw) return undefined;
  try {
    const entry = JSON.parse(raw) as Partial<KeptMuted>;
    return {
      since: Number(entry.since) || 0,
      pattern: String(entry.pattern ?? ''),
      conversationId: String(entry.conversationId ?? ''),
      at: Number(entry.at) || 0,
      until: Number(entry.until) || 0,
      failures: Number(entry.failures) || 0,
    };
  } catch {
    return undefined;
  }
}

export async function saveKeptMuted(name: string, entry: KeptMuted, renewAt: number = entry.until): Promise<void> {
  await redis.hSet(KEYS.keepMuted, { [name]: JSON.stringify(entry) });
  await redis.zAdd(KEYS.muteEnds, { member: name, score: renewAt });
}

export async function removeKeptMuted(name: string): Promise<void> {
  await redis.hDel(KEYS.keepMuted, [name]);
  await redis.zRem(KEYS.muteEnds, [name]);
}

type MuteResponse = { user?: { muteStatus?: { endDate?: string | undefined } | undefined } | undefined };

/** When the mute just applied ends: Reddit's own date, or 28 days on if it gave none. */
export function muteEnd(response: MuteResponse | undefined, now: number = Date.now()): number {
  const fromReddit = Date.parse(response?.user?.muteStatus?.endDate ?? '');
  return Number.isFinite(fromReddit) && fromReddit > now ? fromReddit : now + LONGEST_MUTE_HOURS * HOUR;
}

export type ListedAction = 'lifted' | 'archive' | 'remute';

/**
 * What to do with a message, matching no pattern, from someone on the list.
 *  - Written while their mute should have been in force, and Reddit no longer
 *    shows them as muted: a moderator has unmuted them, which lifts the
 *    permanent mute. If Reddit still shows them as muted, the message got
 *    through some other way and is simply archived.
 *  - Written before the mute took hold: a straggler from the same burst.
 *  - Written after the mute ran out: mute again (recurring) or just archive.
 */
export function listedAction(
  entry: KeptMuted,
  sentAt: number,
  mode: PermanentMode,
  mutedNow: boolean = false,
): ListedAction {
  if (sentAt <= entry.at + SLACK_MS) return 'archive';
  if (entry.until && sentAt < entry.until - SLACK_MS) return mutedNow ? 'archive' : 'lifted';
  return mode === 'recurring' ? 'remute' : 'archive';
}

/**
 * A moderator unmuting someone is how a permanent mute is lifted, whichever of
 * the two modes is in use: the app takes them off its list, so their mute is
 * not renewed and their mail is no longer archived.
 *
 * The app's own unmutes are the first half of a renewal, not a moderator's
 * decision, and are ignored. Returns whether someone was taken off the list.
 */
export async function liftOnUnmute(event: OnModActionRequest): Promise<boolean> {
  if ((event.action ?? '').toLowerCase() !== 'unmuteuser') return false;
  const target = event.targetUser?.name?.toLowerCase();
  const moderator = event.moderator?.name?.toLowerCase();
  if (!target || !moderator || isAppAccount(moderator)) return false;
  const entry = await getKeptMuted(target);
  if (!entry) return false;
  // Only an unmute while the mute was still running is someone's decision. If
  // Reddit were ever to report a mute simply running out, that must not count.
  if (entry.until && Date.now() >= entry.until - SLACK_MS) return false;

  await removeKeptMuted(target);
  console.log(`u/${target} was unmuted by u/${moderator}: removed from the permanent-mute list`);
  return true;
}

export type RenewalResult = { renewed: number; lifted: number; failed: number };

/**
 * Runs every hour in `recurring` mode: renews the mutes that end within the
 * next two days. Reddit ignores a mute placed on top of a mute, so a renewal is
 * an unmute followed at once by a fresh 28-day mute.
 */
export async function renewMutes(now: number = Date.now()): Promise<RenewalResult> {
  const result: RenewalResult = { renewed: 0, lifted: 0, failed: 0 };
  const config = readConfig(await settings.getAll<RawSettings>());
  if (config.undoAll || config.permanent !== 'recurring') return result;

  const due = await redis.zRange(KEYS.muteEnds, 0, now + RENEW_AHEAD_MS, {
    by: 'score',
    limit: { offset: 0, count: BATCH },
  });
  const started = Date.now();
  for (const { member: name } of due) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    const entry = await getKeptMuted(name);
    if (!entry || !entry.conversationId || config.exempt.has(name)) {
      await removeKeptMuted(name);
      result.lifted += 1;
      continue;
    }
    try {
      result[(await renewOne(name, entry, now)) ? 'renewed' : 'lifted'] += 1;
    } catch (err) {
      result.failed += 1;
      const failures = (entry.failures ?? 0) + 1;
      console.error(`Could not renew the mute for u/${name} (attempt ${failures}): ${errorText(err)}`);
      // Never drop someone because of failures: a long Reddit outage must not
      // quietly end permanent mutes. Keep whatever renewOne already saved about
      // the mute's state; retry soon if the user is not muted right now, and
      // fall back to once a day if it keeps failing.
      const current = (await getKeptMuted(name)) ?? entry;
      const wait = failures >= MAX_FAILURES ? DAY : current.until ? RETRY_AFTER_MS : HOUR;
      // The job picks up everything scored within the next two days, so the
      // score that makes this due again after `wait` is that much further on.
      await saveKeptMuted(name, { ...current, failures }, now + wait + RENEW_AHEAD_MS);
    }
  }
  if (result.renewed > 0) await redis.incrBy(KEYS.summaryRenewed, result.renewed);
  return result;
}

/** Renews one mute. Returns false when the user turned out to be off the hook. */
async function renewOne(name: string, entry: KeptMuted, now: number): Promise<boolean> {
  const { conversationId } = entry;
  const { conversation, user } = await reddit.modMail.getConversation({ conversationId });
  const participant = conversation?.participant;
  if (!participant?.name || participant.name.toLowerCase() !== name || participant.isDeleted) {
    await removeKeptMuted(name);
    return false;
  }

  const muted = user?.muteStatus?.isMuted === true;
  if (!muted && entry.until && now < entry.until - HOUR) {
    // Not muted although the mute had time left: a moderator unmuted them.
    console.log(`u/${participant.name} was unmuted by a moderator: removed from the permanent-mute list`);
    await removeKeptMuted(name);
    return false;
  }

  const wasArchived = conversation?.state === 'Archived';
  if (muted) {
    // From here until the new mute lands the user is not muted. Record that
    // first, so a message slipping through is seen as a lapse, not as a
    // moderator's unmute.
    await saveKeptMuted(name, { ...entry, until: 0 }, 0);
    await reddit.modMail.unmuteConversation(conversationId);
  }
  const response = await reddit.modMail.muteConversation({ conversationId, numHours: LONGEST_MUTE_HOURS });
  const at = Date.now();
  await saveKeptMuted(name, { ...entry, at, until: muteEnd(response, at), failures: 0 });

  // Reddit posts its mute notice in the conversation. Seen live, that leaves an
  // archived conversation archived; should it ever not, put it back.
  if (wasArchived && response.conversation?.state !== 'Archived') {
    try {
      await reddit.modMail.archiveConversation(conversationId);
    } catch (err) {
      console.error(`Renewed the mute for u/${name} but could not re-archive: ${errorText(err)}`);
    }
  }
  return true;
}

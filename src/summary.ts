import { context, reddit, redis, settings } from '@devvit/web/server';
import { readConfig, type RawSettings, type SummaryFrequency } from './config.ts';
import { KEYS } from './storage.ts';
import { asCode, isoDate } from './text.ts';

const LOG = KEYS.summaryLog;
const TOTAL = KEYS.summaryTotal;
const START = KEYS.summaryStart;
const RENEWED = KEYS.summaryRenewed;

/** Entries kept for one summary; older ones are dropped but still counted. */
const MAX_STORED = 500;
const MAX_LISTED = 40;
const MAX_PATTERNS_LISTED = 10;
/** Safety net so nothing lingers if summaries stop running: a little over a year. */
const RETENTION_SECONDS = 400 * 24 * 60 * 60;
const DAY = 24 * 60 * 60 * 1000;

export type SummaryEntry = {
  /** When it happened (epoch milliseconds). */
  t: number;
  /** Username acted on. */
  u: string;
  /** Pattern that matched, or '' for mail from someone on the permanent-mute list. */
  p: string;
  /** What was done, e.g. "Banned (permanently)". */
  o: string[];
  /** Modmail conversation id. */
  c: string;
};

export type SummaryResult = 'off' | 'started' | 'not-due' | 'nothing-happened' | 'sent';

/** Remembers one action for the next summary. */
export async function recordAction(entry: SummaryEntry): Promise<void> {
  await Promise.all([
    redis.zAdd(LOG, { member: JSON.stringify(entry), score: entry.t }),
    redis.incrBy(TOTAL, 1),
  ]);
  const surplus = (await redis.zCard(LOG)) - MAX_STORED;
  await Promise.all([
    surplus > 0 ? redis.zRemRangeByRank(LOG, 0, surplus - 1) : undefined,
    redis.expire(LOG, RETENTION_SECONDS),
    redis.expire(TOTAL, RETENTION_SECONDS),
  ]);
}

const startOfUtcDay = (ms: number): number => Math.floor(ms / DAY) * DAY;

/** When the period that began at `start` ends. Months and years are calendar ones. */
export function periodEnd(start: number, frequency: Exclude<SummaryFrequency, 'off'>): number {
  if (frequency === 'week') return start + 7 * DAY;
  const from = new Date(start);
  const months = frequency === 'month' ? 1 : 12;
  const target = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months, 1));
  // 31 January + 1 month is 28/29 February, not 3 March.
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(from.getUTCDate(), lastDay));
  return target.getTime();
}

function parseEntry(member: string): SummaryEntry | undefined {
  try {
    const entry = JSON.parse(member) as SummaryEntry;
    return typeof entry.u === 'string' && Array.isArray(entry.o) ? entry : undefined;
  } catch {
    return undefined;
  }
}

/** How the permanent-mute list stood when the summary was written. */
export type ListStatus = { listed: number; renewed: number };

/** The modmail body. `total` can exceed `entries.length` when old entries were dropped. */
export function buildSummary(
  entries: SummaryEntry[],
  total: number,
  start: number,
  now: number,
  list: ListStatus = { listed: 0, renewed: 0 },
): string {
  const newestFirst = [...entries].sort((a, b) => b.t - a.t);

  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.p, (counts.get(entry.p) ?? 0) + 1);
  const byCount = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const what = (pattern: string): string =>
    pattern ? `matched ${asCode(pattern.slice(0, 80))}` : 'on the permanent-mute list';

  const lines = [
    `Between ${isoDate(start)} and ${isoDate(now)}, Modmail Regex Ban acted on **${total}** modmail message${total === 1 ? '' : 's'}.`,
    '**By reason**',
    ...byCount.slice(0, MAX_PATTERNS_LISTED).map(([pattern, count]) => `* ${count} × ${what(pattern)}`),
  ];
  if (byCount.length > MAX_PATTERNS_LISTED) {
    lines.push(`* …and ${byCount.length - MAX_PATTERNS_LISTED} more patterns`);
  }
  if (total > entries.length) {
    lines.push(`(These counts cover the most recent ${entries.length} actions.)`);
  }

  const listed = newestFirst.slice(0, MAX_LISTED);
  lines.push(
    '**Most recent**',
    ...listed.map(
      (entry) =>
        `* ${isoDate(entry.t)} – u/${entry.u} – ${what(entry.p)} – ${entry.o.join('; ') || 'no action'} – ` +
        `[open](https://mod.reddit.com/mail/perma/${entry.c})`,
    ),
  );
  if (total > listed.length) lines.push(`…and ${total - listed.length} more.`);

  if (list.listed > 0 || list.renewed > 0) {
    lines.push(
      `**Permanent mutes**: ${list.listed} user${list.listed === 1 ? '' : 's'} on the list` +
        (list.renewed > 0 ? `, ${list.renewed} mute${list.renewed === 1 ? '' : 's'} renewed in this period.` : '.'),
    );
  }

  lines.push('You can change how often this summary is sent, or turn it off, in the app settings.');
  return lines.join('\n\n');
}

/**
 * Runs once a day. Sends the summary when the chosen period has ended and the
 * app acted at least once in it; otherwise does nothing.
 */
export async function runSummary(now: number = Date.now()): Promise<SummaryResult> {
  const { summary } = readConfig(await settings.getAll<RawSettings>());
  if (summary === 'off') {
    await redis.del(LOG, TOTAL, RENEWED, START);
    return 'off';
  }

  const start = Number(await redis.get(START));
  if (!start) {
    await redis.set(START, String(startOfUtcDay(now)));
    return 'started';
  }
  if (now < periodEnd(start, summary)) return 'not-due';

  const total = Number((await redis.get(TOTAL)) ?? 0);
  if (total > 0) {
    const stored = await redis.zRange(LOG, 0, now + DAY, { by: 'score' });
    const entries = stored.map((item) => parseEntry(item.member)).filter((entry) => entry !== undefined);
    // If this throws, nothing is cleared and the summary is retried tomorrow.
    await reddit.modMail.createModNotification({
      subject: `Modmail Regex Ban: summary for the past ${summary}`,
      bodyMarkdown: buildSummary(entries, total, start, now, {
        listed: await redis.hLen(KEYS.keepMuted),
        renewed: Number((await redis.get(RENEWED)) ?? 0),
      }),
      subredditId: context.subredditId,
    });
  }

  await redis.del(LOG, TOTAL, RENEWED);
  await redis.set(START, String(startOfUtcDay(now)));
  return total > 0 ? 'sent' : 'nothing-happened';
}

// A record of every ban, mute and archive the app makes, kept so that the
// "Undo everything the app has done" setting has something to work from.
import { redis } from '@devvit/web/server';
import { KEYS } from './storage.ts';

export type LedgerKind = 'ban' | 'mute' | 'archive';

export type LedgerEntry = {
  kind: LedgerKind;
  /** Lower-cased username the action was taken against. */
  name: string;
  /** The modmail conversation it happened in. */
  conversationId: string;
};

/** Oldest entries are dropped beyond this, so the record cannot grow without limit. */
const MAX_ENTRIES = 50_000;

// Usernames and conversation ids never contain "|".
export const ledgerMember = (entry: LedgerEntry): string =>
  `${entry.kind}|${entry.name.toLowerCase()}|${entry.conversationId}`;

export function parseLedgerMember(member: string): LedgerEntry | undefined {
  const [kind, name, conversationId, ...extra] = member.split('|');
  if ((kind !== 'ban' && kind !== 'mute' && kind !== 'archive') || !name || !conversationId || extra.length) {
    return undefined;
  }
  return { kind, name, conversationId };
}

/** Notes that the app did something. Recording the same thing twice keeps one entry. */
export async function recordInLedger(
  kind: LedgerKind,
  name: string,
  conversationId: string,
  at: number = Date.now(),
): Promise<void> {
  await redis.zAdd(KEYS.ledger, { member: ledgerMember({ kind, name, conversationId }), score: at });
}

/** Run now and then (the hourly job does) to keep the record within its limit. */
export async function trimLedger(): Promise<void> {
  const surplus = (await redis.zCard(KEYS.ledger)) - MAX_ENTRIES;
  if (surplus > 0) await redis.zRemRangeByRank(KEYS.ledger, 0, surplus - 1);
}

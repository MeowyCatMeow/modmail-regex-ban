/** Every key the app keeps in its per-subreddit storage, in one place. */
export const KEYS = {
  /** Marker for a modmail message already acted on (expires after a day). */
  handled: (messageId: string): string => `handled:${messageId}`,
  /** Set once per user when the one-time renewal-notice message is sent (expires after an hour). */
  tipSent: (name: string): string => `tip:${name}`,
  /** Hash: lower-cased username -> JSON entry, for users muted under "Permanent". */
  keepMuted: 'keepMuted',
  /** Sorted set: lower-cased username -> when their current mute ends. */
  muteEnds: 'keepMuted:ends',
  /** Sorted set of actions since the last summary, scored by time. */
  summaryLog: 'summary:log',
  /** Number of actions since the last summary (the log itself is capped). */
  summaryTotal: 'summary:total',
  /** Number of mutes renewed since the last summary. */
  summaryRenewed: 'summary:renewed',
  /** When the current summary period began. */
  summaryStart: 'summary:start',
  /** Sorted set: every ban, mute and archive the app has made, so that they can be undone. */
  ledger: 'ledger',
  /** Progress of an undo in JSON, while "Undo everything" is switched on. */
  undoState: 'undo:state',
  /** Held while an undo run is in progress, so two never overlap. */
  undoLock: 'undo:lock',
  /** Hash: ledger entry -> failed attempts to undo it. */
  undoAttempts: 'undo:attempts',
  /** Sorted set: every lower-cased username held anywhere above -> when to check next that the account still exists. */
  accounts: 'accounts',
  /** When the set above was last brought in line with what the app actually holds. */
  accountsSynced: 'accounts:synced',
  /** Hash: lower-cased username -> when Reddit first answered "not found" for it, until that is confirmed or disproved. */
  accountsMissing: 'accounts:missing',
} as const;

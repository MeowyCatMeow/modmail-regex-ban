/** The app settings exactly as Devvit returns them (select values arrive as arrays). */
export type RawSettings = {
  /** The ready-made pattern switches arrive under their own names. */
  [setting: string]: unknown;
  patterns?: string;
  matchSubject?: boolean;
  matchBody?: boolean;
  firstMessageOnly?: boolean;
  exemptUsers?: string;
  banEnabled?: boolean;
  banLength?: string | string[];
  banReason?: string;
  banMessage?: string;
  muteEnabled?: boolean;
  muteDuration?: string | string[];
  recurringMuteTip?: boolean;
  recurringMuteMessage?: string;
  addModNote?: boolean;
  archive?: boolean;
  summaryFrequency?: string | string[];
  undoAll?: boolean;
};

/**
 * The only mute lengths Reddit accepts from an app, in hours (3, 7 and 28
 * days). Verified live against 84 candidate values: everything else is refused
 * as "that option is not valid", including every guess at a permanent mute.
 */
export type MuteHours = 72 | 168 | 672;
export const LONGEST_MUTE_HOURS = 672;

/**
 * Reddit's own permanent mute cannot be set by an app, so "Permanent" is one of
 * two workarounds, both of which start with the longest mute and put the user
 * on the app's permanent-mute list:
 *  - `recurring`: the mute is renewed shortly before it ends, again and again;
 *  - `archive`: once the mute has ended, anything the user sends is archived.
 */
export type PermanentMode = 'off' | 'recurring' | 'archive';

export type SummaryFrequency = 'off' | 'week' | 'month' | 'year';

/** The settings with defaults applied and values normalised. */
export type Config = {
  patterns: string;
  matchSubject: boolean;
  matchBody: boolean;
  firstMessageOnly: boolean;
  /** Lower-cased usernames the app must never act on. */
  exempt: Set<string>;
  banEnabled: boolean;
  /** 0 means permanent. */
  banDays: number;
  banReason: string;
  banMessage: string;
  muteEnabled: boolean;
  muteHours: MuteHours;
  /** Always `off` when muting is off. */
  permanent: PermanentMode;
  /**
   * Sent to the user once when a recurring mute starts, or '' for nothing.
   * Reddit sends its mute notice on every renewal and apps cannot stop that,
   * so this tells the user how to silence it.
   */
  recurringMessage: string;
  addModNote: boolean;
  archive: boolean;
  summary: SummaryFrequency;
  /**
   * While on, the app undoes everything it has done and takes no new action.
   * It is a state rather than a button because an app cannot reset a setting.
   */
  undoAll: boolean;
};

/** Reddit rejects a ban whose message to the user is longer than this. */
export const BAN_MESSAGE_MAX_LENGTH = 1000;

/** Ban lengths offered in the settings, in days. */
export const BAN_LENGTHS = [1, 3, 7, 14, 30, 60, 90, 180, 365] as const;

/** Default text of the one-time message about renewal notices (also in devvit.json). */
export const DEFAULT_RECURRING_MESSAGE =
  'You have been muted from contacting the moderators of this community, and the mute renews automatically. ' +
  'Reddit will send you a mute notice each time, about every four weeks. If you would rather not be notified, ' +
  'you can mute notifications for this conversation in your chat window.';
const RECURRING_MESSAGE_MAX_LENGTH = 2000;

const USERNAME = /^[A-Za-z0-9_-]{3,20}$/;

const firstOf = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** Splits the exempt-users setting into names, accepting `name`, `u/name` and `/u/name`. */
export function parseUsernames(raw: string | undefined): { names: string[]; invalid: string[] } {
  const names: string[] = [];
  const invalid: string[] = [];
  for (const token of (raw ?? '').split(/[\s,]+/)) {
    if (!token) continue;
    const name = token.replace(/^\/?u\//i, '');
    if (USERNAME.test(name)) names.push(name.toLowerCase());
    else invalid.push(token);
  }
  return { names, invalid };
}

export function readConfig(raw: RawSettings): Config {
  const muteEnabled = raw.muteEnabled ?? true;
  const muteChoice = firstOf(raw.muteDuration);
  const hours = Number(muteChoice);
  const permanent: PermanentMode =
    muteChoice === 'permanent' ? 'recurring' : muteChoice === 'permanent-archive' ? 'archive' : 'off';
  const summary = firstOf(raw.summaryFrequency);
  const banDays = Number(firstOf(raw.banLength));
  return {
    patterns: raw.patterns ?? '',
    matchSubject: raw.matchSubject ?? true,
    matchBody: raw.matchBody ?? true,
    firstMessageOnly: raw.firstMessageOnly ?? false,
    exempt: new Set(parseUsernames(raw.exemptUsers).names),
    banEnabled: raw.banEnabled ?? true,
    // Anything that is not one of the offered lengths, 'permanent' included, is a permanent ban.
    banDays: (BAN_LENGTHS as readonly number[]).includes(banDays) ? banDays : 0,
    banReason: (raw.banReason || 'Modmail matched a banned pattern').slice(0, 100),
    banMessage: (raw.banMessage ?? '').trim().slice(0, BAN_MESSAGE_MAX_LENGTH),
    muteEnabled,
    muteHours: hours === 72 || hours === 168 ? hours : LONGEST_MUTE_HOURS,
    permanent: muteEnabled ? permanent : 'off',
    recurringMessage:
      (raw.recurringMuteTip ?? true)
        ? (raw.recurringMuteMessage ?? DEFAULT_RECURRING_MESSAGE).trim().slice(0, RECURRING_MESSAGE_MAX_LENGTH)
        : '',
    addModNote: raw.addModNote ?? true,
    archive: raw.archive ?? true,
    summary: summary === 'off' || summary === 'month' || summary === 'year' ? summary : 'week',
    undoAll: raw.undoAll === true,
  };
}

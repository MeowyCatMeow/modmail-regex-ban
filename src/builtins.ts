// The ready-made patterns offered as switches in the settings.
//
// They are read from the settings definition itself: each switch's label is
// the title and its help text is the regex. So the regex a moderator sees
// under a switch is, by construction, exactly the one the app runs.
import devvitConfig from '../devvit.json' with { type: 'json' };
import { compileLine, type CompiledPattern } from './patterns.ts';

type Switch = { label: string; helpText: string };

export type ReadyMade = {
  /** The setting's name. */
  key: string;
  /** What it catches, e.g. `"Unban me for money"`. */
  title: string;
  /** The regex, as shown in the settings. */
  source: string;
};

export const READY_MADE: ReadyMade[] = Object.entries(
  devvitConfig.settings.subreddit.readyMade.fields as Record<string, Switch>,
).map(([key, field]) => ({
  key,
  title: field.label.replace(/:\s*$/, ''),
  source: field.helpText,
}));

/** The ready-made patterns a moderator has switched on, in the order shown in the settings. */
export function switchedOn(settings: Record<string, unknown>): CompiledPattern[] {
  const patterns: CompiledPattern[] = [];
  for (const { key, source } of READY_MADE) {
    if (settings[key] !== true) continue;
    try {
      patterns.push({ source, regex: compileLine(source) });
    } catch (err) {
      console.error(`Ready-made pattern ${key} could not be used: ${err instanceof Error ? err.message : err}`);
    }
  }
  return patterns;
}

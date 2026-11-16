import { context } from '@devvit/web/server';

/**
 * Whether a username is the app's own account. The app must never act on
 * itself, and must not mistake its own moderator actions for a human's.
 */
export function isAppAccount(name: string | undefined): boolean {
  const lower = name?.toLowerCase();
  return !!lower && (lower === context.appName?.toLowerCase() || lower === context.appSlug?.toLowerCase());
}

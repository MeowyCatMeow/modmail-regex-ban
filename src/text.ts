/**
 * The trigger sends ids as `ModmailConversation_abc` / `ModmailMessage_abc`,
 * while the API's own ids are bare (`abc`). Verified live: fetching, replying
 * and archiving accept either form, but muting rejects the prefixed one with
 * "Invalid conversation id", so every API call gets the bare id.
 */
export const bareId = (id: string | undefined): string => (id ?? '').slice((id ?? '').lastIndexOf('_') + 1);

export const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Formats text as inline code for modmail. Text that comes from a sender must
 * never be rendered as Markdown (links, mentions), and a moderator's pattern
 * may contain characters Markdown would otherwise interpret.
 */
export function asCode(text: string): string {
  const flat = text.replace(/\s+/g, ' ').replaceAll('`', "'").trim();
  return flat ? '`' + flat + '`' : '';
}

/** A UTC calendar date such as 2026-11-16. */
export const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

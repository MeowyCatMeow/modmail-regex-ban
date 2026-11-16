import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  OnModActionRequest,
  OnModMailRequest,
  SettingsValidationRequest,
  SettingsValidationResponse,
  TriggerResponse,
} from '@devvit/web/shared';
import { BAN_MESSAGE_MAX_LENGTH, parseUsernames } from './config.ts';
import { trimLedger } from './ledger.ts';
import { handleModMail } from './modmail.ts';
import { parsePatterns } from './patterns.ts';
import { liftOnUnmute, renewMutes } from './permamute.ts';
import { runSummary } from './summary.ts';
import { kickUndo, runUndo } from './undo.ts';

// Devvit POSTs JSON to the endpoints named in devvit.json and expects JSON back.
const routes = new Map<string, (body: never) => Promise<object> | object>([
  [
    '/internal/triggers/on-mod-mail',
    async (event: OnModMailRequest): Promise<TriggerResponse> => {
      await handleModMail(event);
      return {};
    },
  ],
  [
    // Every moderator action in the subreddit. The app only cares about one:
    // a moderator unmuting someone on its permanent-mute list.
    '/internal/triggers/on-mod-action',
    async (event: OnModActionRequest): Promise<TriggerResponse> => {
      await liftOnUnmute(event);
      return {};
    },
  ],
  [
    // Runs once a day; sends the summary when the chosen period has ended.
    '/internal/scheduler/summary',
    async (): Promise<object> => {
      const result = await runSummary();
      if (result === 'sent') console.log('Summary sent to modmail');
      return {};
    },
  ],
  [
    // Runs every hour; renews the 28-day mutes that are about to end.
    '/internal/scheduler/renew-mutes',
    async (): Promise<object> => {
      // Three separate chores. One failing must not stop the others: a mute
      // that is not renewed in time lets the user back in. (runUndo here is
      // the safety net for an undo whose scheduled steps were interrupted.)
      for (const chore of [runUndo, trimLedger]) {
        try {
          await chore();
        } catch (err) {
          console.error(`Hourly ${chore.name} failed:`, err);
        }
      }
      const result = await renewMutes();
      if (result.renewed + result.lifted + result.failed > 0) {
        console.log(`Permanent mutes: ${result.renewed} renewed, ${result.lifted} lifted, ${result.failed} failed`);
      }
      return {};
    },
  ],
  [
    // One step of "Undo everything the app has done"; it reschedules itself until finished.
    '/internal/scheduler/undo',
    async (): Promise<object> => {
      await runUndo();
      return {};
    },
  ],
  [
    // Called when the settings are saved. Switching the undo on starts it a few
    // seconds later, once the new setting has been stored; the run itself checks
    // the stored setting, so this cannot start an undo that was not saved.
    '/internal/settings/validate-undo',
    async (req: SettingsValidationRequest<boolean>): Promise<SettingsValidationResponse> => {
      if (req.value === true) await kickUndo(15_000);
      return { success: true };
    },
  ],
  [
    '/internal/settings/validate-exempt-users',
    (req: SettingsValidationRequest<string>): SettingsValidationResponse => {
      const { invalid } = parseUsernames(req.value);
      return invalid.length === 0
        ? { success: true }
        : { success: false, error: `"${invalid[0]!.slice(0, 40)}" is not a Reddit username.` };
    },
  ],
  [
    '/internal/settings/validate-patterns',
    (req: SettingsValidationRequest<string>): SettingsValidationResponse => {
      const first = parsePatterns(req.value).errors[0];
      return first
        ? { success: false, error: `Line ${first.line} can't be used: ${first.message}` }
        : { success: true };
    },
  ],
  [
    '/internal/settings/validate-ban-message',
    (req: SettingsValidationRequest<string>): SettingsValidationResponse => {
      const length = (req.value ?? '').trim().length;
      return length <= BAN_MESSAGE_MAX_LENGTH
        ? { success: true }
        : {
            success: false,
            error: `Reddit allows at most ${BAN_MESSAGE_MAX_LENGTH} characters here; this is ${length}.`,
          };
    },
  ],
]);

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function sendJson(res: ServerResponse, status: number, payload: object): void {
  const body = JSON.stringify(payload);
  // Devvit rejects a non-empty reply that has no Content-Length, and Node would
  // otherwise send it chunked.
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? '').split('?')[0] ?? '';
  const route = routes.get(path);
  if (!route || req.method !== 'POST') {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  try {
    sendJson(res, 200, await route((await readJson(req)) as never));
  } catch (err) {
    console.error(`${path} failed:`, err);
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

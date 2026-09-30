import { config } from './config.js';
import { logger, type Log } from './observability/logger.js';
import type { Slot } from './types.js';

// Dead-letter alert. Always logs; if ALERT_WEBHOOK_URL is set, also POSTs a small
// JSON payload (Slack/Discord-style {text}). Best-effort — a webhook failure must
// never crash the worker.
export async function notifyDeadLetter(slot: Slot, reason: string, log: Log = logger): Promise<void> {
  const msg = `[DLQ] slot ${slot.id} (variant ${slot.variant_id}, adapter ${slot.adapter}) dead-lettered after ${slot.attempts} attempt(s): ${reason}`;
  log.error(msg);
  const url = config.alertWebhookUrl;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: msg, slot_id: slot.id, variant_id: slot.variant_id, adapter: slot.adapter, reason }),
    });
  } catch (err) {
    log.error(`[DLQ] webhook post failed: ${(err as Error)?.message ?? err}`);
  }
}

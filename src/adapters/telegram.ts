import { SocialPublisher } from './base.js';
import type { PublishContext, PublishResult } from '../types.js';

/**
 * The real, free target. Sends a message via the Telegram Bot API.
 * Idempotency: Telegram's sendMessage has NO idempotency key, so this adapter is
 * `idempotent: false` — the orchestrator guarantees no-duplicate by refusing to
 * re-issue an in-flight send (at-most-once).
 */
export class TelegramPublisher extends SocialPublisher {
  private botToken: string;
  private chatId: string;
  private parseMode?: string;

  constructor(opts: { botToken?: string; chatId?: string; parseMode?: string } = {}) {
    super('telegram', { idempotent: false });
    this.botToken = opts.botToken || '';
    this.chatId = opts.chatId || '';
    this.parseMode = opts.parseMode || undefined;
  }

  async publish({ variant }: PublishContext): Promise<PublishResult> {
    if (!this.botToken || !this.chatId) {
      throw new Error('telegram adapter not configured (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)');
    }
    const res = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.chatId,
        text: variant.content,
        parse_mode: this.parseMode,
        disable_web_page_preview: false,
      }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(`telegram sendMessage failed: ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
    }
    const msg = data.result ?? {};
    const chat = msg.chat ?? {};
    const externalUrl = chat.username ? `https://t.me/${chat.username}/${msg.message_id}` : null;
    return { externalId: String(msg.message_id ?? ''), externalUrl, preview: variant.content };
  }
}

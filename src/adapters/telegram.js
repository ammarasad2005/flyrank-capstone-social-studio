import { SocialPublisher } from './base.js';

/**
 * The REAL, free target. Sends a message via the Telegram Bot API.
 *   POST https://api.telegram.org/bot<token>/sendMessage
 * Docs: https://core.telegram.org/bots/api#sendmessage
 *
 * Idempotency: Telegram's sendMessage has NO idempotency key — re-sending the same
 * request creates a second message. So this adapter is declared `idempotent: false`,
 * and the publish orchestrator (src/publisher.js) guarantees no-duplicate by refusing
 * to re-issue a send that was already in-flight when a worker crashed (at-most-once).
 * The app-layer UNIQUE idempotency_key still prevents any second *successful* attempt.
 */
export class TelegramPublisher extends SocialPublisher {
  constructor({ botToken, chatId, parseMode } = {}) {
    super('telegram', { idempotent: false });
    this.botToken = botToken;
    this.chatId = chatId;
    this.parseMode = parseMode || undefined;
  }

  async publish({ variant }) {
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
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(`telegram sendMessage failed: ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
    }
    const msg = data.result ?? {};
    const chat = msg.chat ?? {};
    // Public channels/groups with a @username get a real permalink.
    const externalUrl = chat.username ? `https://t.me/${chat.username}/${msg.message_id}` : null;
    return {
      externalId: String(msg.message_id ?? ''),
      externalUrl,
      preview: variant.content,
    };
  }
}

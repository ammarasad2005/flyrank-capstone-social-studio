import { SocialPublisher } from './base.js';

/**
 * The one REAL, free target. Posts a status to a Mastodon instance.
 *
 * Idempotency: Mastodon natively honours the `Idempotency-Key` request header — a
 * repeat with the same key returns the SAME status instead of creating a duplicate.
 * We pass our stable `${variantId}:${slotId}` key straight through, so even a retry
 * after a crash mid-send cannot double-post.
 * https://docs.joinmastodon.org/methods/statuses/#create
 */
export class MastodonPublisher extends SocialPublisher {
  constructor({ baseUrl, accessToken, visibility = 'unlisted' } = {}) {
    super('mastodon', { idempotent: true }); // native Idempotency-Key header
    this.baseUrl = (baseUrl || '').replace(/\/+$/, '');
    this.accessToken = accessToken;
    this.visibility = visibility;
  }

  async publish({ idempotencyKey, variant }) {
    if (!this.baseUrl || !this.accessToken) {
      throw new Error('mastodon adapter not configured (set MASTODON_BASE_URL and MASTODON_ACCESS_TOKEN)');
    }
    const res = await fetch(`${this.baseUrl}/api/v1/statuses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({ status: variant.content, visibility: this.visibility }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`mastodon POST /statuses failed: ${res.status} ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    return { externalId: String(data.id), externalUrl: data.url ?? null, preview: variant.content };
  }
}

import { SocialPublisher } from './base.js';
import type { PublishContext, PublishResult } from '../types.js';

/**
 * A real, free target. Posts a status to a Mastodon instance.
 * Idempotency: Mastodon honours the `Idempotency-Key` header natively.
 */
export class MastodonPublisher extends SocialPublisher {
  private baseUrl: string;
  private accessToken: string;
  private visibility: string;

  constructor(opts: { baseUrl?: string; accessToken?: string; visibility?: string } = {}) {
    super('mastodon', { idempotent: true });
    this.baseUrl = (opts.baseUrl || '').replace(/\/+$/, '');
    this.accessToken = opts.accessToken || '';
    this.visibility = opts.visibility || 'unlisted';
  }

  async publish({ idempotencyKey, variant }: PublishContext): Promise<PublishResult> {
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
    const data: any = await res.json();
    return { externalId: String(data.id), externalUrl: data.url ?? null, preview: variant.content };
  }
}

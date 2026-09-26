import { SocialPublisher } from './base.js';
import { upsertMockPost } from '../repo.js';
import type { PublishContext, PublishResult } from '../types.js';

/**
 * A mock target. "Publishes" by recording the post in our own database and returning
 * a preview + mock permalink. Idempotent via UNIQUE mock_posts.idempotency_key.
 */
export class MockPublisher extends SocialPublisher {
  private label: string;

  constructor(id: string, opts: { label?: string } = {}) {
    super(id, { idempotent: true });
    this.label = opts.label ?? id;
  }

  async publish({ idempotencyKey, variant }: PublishContext): Promise<PublishResult> {
    const { row, created } = await upsertMockPost({
      adapter: this.id,
      idempotency_key: idempotencyKey,
      content: variant.content,
    });
    return {
      externalId: `mock-${this.id}-${row.id}`,
      externalUrl: `mock://${this.id}/${row.id}`,
      preview: `[${this.label}] ${variant.content}`,
      reused: !created,
    };
  }
}

export class MockXPublisher extends MockPublisher {
  constructor() { super('mock_x', { label: 'X (mock)' }); }
}
export class MockLinkedInPublisher extends MockPublisher {
  constructor() { super('mock_linkedin', { label: 'LinkedIn (mock)' }); }
}

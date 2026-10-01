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

    // CI-only failpoint: hard-kill the BullMQ worker after the mock target has
    // committed the post but before publishSlot can record success. The test runs
    // against disposable local Postgres/Redis services and proves idempotent recovery.
    if (created && process.env.NODE_ENV === 'test' && process.env.FLYRANK_TEST_CRASH_AFTER_MOCK_PUBLISH === '1') {
      process.kill(process.pid, 'SIGKILL');
      await new Promise<never>(() => {});
    }

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

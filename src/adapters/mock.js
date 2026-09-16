import { SocialPublisher } from './base.js';
import { upsertMockPost } from '../repo.js';

/**
 * A mock target. It "publishes" by recording the post in our own database and
 * returning a preview + a mock permalink — no external network, no credentials.
 *
 * Idempotency: mock_posts.idempotency_key is UNIQUE, so upsertMockPost() returns the
 * existing row on a repeat. Two publish() calls with the same key => one mock post.
 *
 * Two concrete mocks are exported below (MockXPublisher, MockLinkedInPublisher). They
 * behave identically to the real adapter from the system's point of view — that is
 * the whole point of the seam.
 */
export class MockPublisher extends SocialPublisher {
  constructor(id, { label } = {}) {
    super(id);
    this.label = label ?? id;
  }

  async publish({ idempotencyKey, variant }) {
    const { row, created } = upsertMockPost({
      adapter: this.id,
      idempotency_key: idempotencyKey,
      content: variant.content,
    });
    return {
      externalId: `mock-${this.id}-${row.id}`,
      externalUrl: `mock://${this.id}/${row.id}`,
      preview: `[${this.label}] ${variant.content}`,
      reused: !created, // false on first publish, true on an idempotent repeat
    };
  }
}

export class MockXPublisher extends MockPublisher {
  constructor() {
    super('mock_x', { label: 'X (mock)' });
  }
}

export class MockLinkedInPublisher extends MockPublisher {
  constructor() {
    super('mock_linkedin', { label: 'LinkedIn (mock)' });
  }
}

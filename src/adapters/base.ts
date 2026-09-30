import type { PublishContext, PublishResult } from '../types.js';

/**
 * The SocialPublisher interface — the single seam every platform implements.
 * publish() MUST be idempotent on ctx.idempotencyKey: calling it twice with the same
 * key produces exactly one post on the target and returns the same result.
 *
 * `idempotent` declares whether the TARGET itself dedupes on that key (Mastodon header,
 * mocks' UNIQUE key). If false (e.g. Telegram), the orchestrator will not retry an
 * in-flight send, to avoid a duplicate.
 */
export abstract class SocialPublisher {
  readonly id: string;
  readonly idempotent: boolean;

  constructor(id: string, opts: { idempotent?: boolean } = {}) {
    this.id = id;
    this.idempotent = opts.idempotent ?? false;
  }

  abstract publish(ctx: PublishContext): Promise<PublishResult>;
}

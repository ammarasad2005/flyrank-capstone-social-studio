/**
 * The SocialPublisher interface — the single seam every platform implements.
 *
 * The rest of the system only ever knows this shape. Swapping a real target for a
 * mock (or adding a new network) is a config + one-file change with ZERO edits to
 * ingestion, review, scheduling, or the idempotency logic.
 *
 *   interface SocialPublisher {
 *     id: string                                  // adapter id, e.g. "mastodon"
 *     publish(ctx): Promise<PublishResult>
 *   }
 *
 *   ctx = {
 *     idempotencyKey: string,   // stable `${variantId}:${slotId}` — MUST dedupe on this
 *     variant: { id, platform, content, hashtags, ... },
 *     post:    { id, title, url, ... },
 *   }
 *
 *   PublishResult = {
 *     externalId:  string,      // id on the target network
 *     externalUrl: string|null, // permalink to the published post
 *     preview:     string,      // exactly what was sent
 *     reused?:     boolean,     // true if the target returned an existing post (idempotent hit)
 *   }
 *
 * Contract: publish() MUST be idempotent on idempotencyKey. Calling it twice with
 * the same key produces exactly one post on the target and returns the same result.
 */
export class SocialPublisher {
  /**
   * @param {string} id
   * @param {{idempotent?: boolean}} [opts] idempotent=true means the target itself
   *   dedupes on the idempotency key (Mastodon header, mock UNIQUE key), so a crashed
   *   send can be safely re-issued. false (e.g. Telegram) means re-sending could
   *   duplicate, so the orchestrator refuses to retry an in-flight send.
   */
  constructor(id, { idempotent = false } = {}) {
    this.id = id;
    this.idempotent = idempotent;
  }
  // eslint-disable-next-line no-unused-vars
  async publish(ctx) {
    throw new Error(`${this.id}: publish() not implemented`);
  }
}

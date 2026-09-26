// Shared domain types.

export type VariantStatus = 'draft' | 'approved' | 'rejected' | 'published';
export type SlotStatus = 'pending' | 'publishing' | 'published' | 'failed' | 'canceled';
export type AttemptStatus = 'pending' | 'in_flight' | 'succeeded' | 'failed' | 'uncertain';

export interface Post {
  id: number;
  source_type: 'url' | 'markdown';
  source_url: string | null;
  title: string;
  content_md: string;
  created_at: string | Date;
}

export interface Variant {
  id: number;
  post_id: number;
  platform: string;
  content: string;
  hashtags: string[];
  status: VariantStatus;
  rejection_reason: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface Slot {
  id: number;
  variant_id: number;
  adapter: string;
  scheduled_at: string | Date;
  status: SlotStatus;
  claimed_at: string | Date | null;
  created_at: string | Date;
}

export interface Attempt {
  id: number;
  variant_id: number;
  slot_id: number;
  idempotency_key: string;
  adapter: string;
  status: AttemptStatus;
  external_id: string | null;
  external_url: string | null;
  preview: string | null;
  error: string | null;
  attempt_no: number;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface MockPost {
  id: number;
  adapter: string;
  idempotency_key: string;
  content: string;
  created_at: string | Date;
}

/** Every adapter returns this from publish(). */
export interface PublishResult {
  externalId: string;
  externalUrl: string | null;
  preview: string;
  reused?: boolean;
}

export interface PublishContext {
  idempotencyKey: string;
  variant: Variant;
  post?: Post;
}

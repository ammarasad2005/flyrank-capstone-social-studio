// A minimal queue contract. Both drivers pull due slots and run them through the
// same processSlot(), so swapping engines never changes publish semantics.
export interface PublishQueue {
  start(): Promise<void>;
  stop(): Promise<void>;
}

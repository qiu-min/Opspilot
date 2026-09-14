/** Resource kinds that a Session can know about. */
export type SessionResourceKind = 'excel';

/** Lightweight registry reference; it deliberately contains no file state. */
export interface SessionResourceRef {
  readonly id: string;
  readonly kind: SessionResourceKind;
}

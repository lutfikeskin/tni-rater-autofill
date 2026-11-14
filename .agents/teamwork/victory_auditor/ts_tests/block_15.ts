/**
 * Canonical Enterprise Audit Event with cryptographic chaining.
 */
export interface EnterpriseAuditEvent {
  /** Unique UUID v4 record ID */
  readonly eventId: string;
  /** Monotonic 1-indexed sequence counter within sessionId */
  readonly seq: number;
  /** ISO-8601 UTC timestamp with ms precision */
  readonly timestamp: string;
  /** Unique session ID binding the run */
  readonly sessionId: string;
  /** Enterprise tenant ID */
  readonly organizationId: string;
  /** User and runtime environment actor */
  readonly actor: {
    readonly userId: string;
    readonly clientVersion: string;
    readonly environment: 'dev' | 'test' | 'staging' | 'prod';
  };
  /** Categorized event classification */
  readonly eventType:
    | 'workflow_started'
    | 'field_autofilled'
    | 'field_overridden_by_user'
    | 'ai_suggestion_evaluated'
    | 'ai_selection_approved'
    | 'submission_barrier_blocked'
    | 'security_violation_flagged'
    | 'session_rekey'
    | 'workflow_completed';
  /** Target portal FQDN */
  readonly targetDomain: string;
  /** Structured payload (PII redacted) */
  readonly payload: {
    readonly fieldKey?: string;
    readonly provenanceSource?: string;
    readonly appliedValueMasked?: string;
    readonly details: Record<string, unknown>;
  };
  /** SHA-256 hex digest of event seq - 1 (null strictly if seq === 1) */
  readonly previousEventHash: string | null;
  /** SHA-256 hex digest of RFC 8785 canonical JSON representation excluding signature */
  readonly eventHash: string;
  /** Optional cryptographic client signature (Ed25519 / ECDSA P-256) */
  readonly signature?: string;
}
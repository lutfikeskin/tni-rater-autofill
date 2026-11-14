import { createHash } from 'crypto';

export function verifyAuditChain(events: EnterpriseAuditEvent[]): { valid: boolean; error?: string } {
  if (events.length === 0) return { valid: true };

  const sorted = [...events].sort((a, b) => a.seq - b.seq);

  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i];

    // 1. Monotonic sequence check
    if (current.seq !== i + 1) {
      return { valid: false, error: `Sequence discontinuity at index ${i}: expected seq ${i + 1}, found ${current.seq}` };
    }

    // 2. Genesis record pointer check
    if (i === 0) {
      if (current.previousEventHash !== null) {
        return { valid: false, error: `Genesis event (seq=1) must have null previousEventHash` };
      }
    } else {
      const prev = sorted[i - 1];
      if (current.previousEventHash !== prev.eventHash) {
        return {
          valid: false,
          error: `Hash chain broken at seq ${current.seq}: previousEventHash (${current.previousEventHash}) does not match parent eventHash (${prev.eventHash})`
        };
      }
    }

    // 3. Recompute canonical SHA-256 hash
    const { eventHash, signature, ...unhashedPayload } = current;
    const canonicalJson = canonicalizeRFC8785(unhashedPayload);
    const expectedHash = createHash('sha256').update(canonicalJson, 'utf8').digest('hex');

    if (current.eventHash !== expectedHash) {
      return {
        valid: false,
        error: `Tampered eventHash at seq ${current.seq}: claimed ${current.eventHash}, recomputed ${expectedHash}`
      };
    }
  }

  return { valid: true };
}
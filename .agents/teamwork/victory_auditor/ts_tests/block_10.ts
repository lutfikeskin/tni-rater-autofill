export interface TelemetrySpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: "workflow" | "step" | "locator" | "settle" | "network" | "ai";
  readonly startTime: number;
  readonly endTime: number;
  readonly durationMs: number;
  readonly status: {
    readonly code: "OK" | "ERROR" | "TIMEOUT" | "SKIPPED";
    readonly message?: string;
  };
  readonly attributes: {
    readonly "engine.version": string;
    readonly "engine.mode": "extension" | "sdk-node" | "sdk-python" | "headless";
    /** Sanitized URL: Basic auth stripped; sensitive query tokens (auth, ssn, pass) redacted */
    readonly "target.url": string;
    readonly "workflow.id": string;
    readonly "workflow.stepId"?: string;
    readonly "step.locator.strategy"?: string;
    readonly "step.locator.matchedSelector"?: string;
    readonly "settle.quietPeriodMs"?: number;
    readonly "settle.actualWaitMs"?: number;
    readonly "settle.slackMs"?: number;
    readonly "settle.inflightRequests"?: number;
    readonly "action.by": "agent" | "extension" | "page";
  };
  readonly events: Array<{
    readonly name: string;
    readonly timestamp: number;
    readonly attributes?: Record<string, unknown>;
  }>;
}

const SENSITIVE_QUERY_KEY_PATTERN = new RegExp(
  [
    '^token$',
    '^access_token$',
    '^refresh_token$',
    '^auth$',
    '^authorization$',
    '^key$',
    '^api_?key$',
    '^secret$',
    '^client_?secret$',
    '^code$',
    '^password$',
    '^pwd$',
    '^pass$',
    '^ssn$',
    '^ein$',
    '^fein$',
    '^dob$',
    '^birthdate$',
    '^credit_?card$',
    '^cvv$',
    '^pin$',
    '^sig$',
    '^signature$'
  ].join('|'),
  'i'
);

const HIGH_ENTROPY_TOKEN_PATTERN = /^(?:ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[A-Fa-f0-9]{32,}|[A-Za-z0-9+/=]{40,})$/;

/**
 * Sanitizes URLs for telemetry, audit logging, and tracing.
 * Strips basic-auth credentials, sensitive query parameters, and OAuth hash fragments.
 */
export function sanitizeTelemetryUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') return '';

  try {
    const parsed = new URL(rawUrl);

    // 1. Scrub Basic Authentication from Authority
    if (parsed.username || parsed.password) {
      parsed.username = '[REDACTED]';
      parsed.password = '[REDACTED]';
    }

    // 2. Scrub Sensitive Query Parameters
    const params = new URLSearchParams(parsed.search);
    for (const [key, value] of Array.from(params.entries())) {
      if (SENSITIVE_QUERY_KEY_PATTERN.test(key) || HIGH_ENTROPY_TOKEN_PATTERN.test(value)) {
        params.set(key, '[REDACTED]');
      }
    }
    parsed.search = params.toString();

    // 3. Scrub Sensitive Hash / Fragment Parameters (OAuth implicit grant tokens)
    if (parsed.hash && parsed.hash.length > 1) {
      const hashContent = parsed.hash.substring(1);
      if (hashContent.includes('=')) {
        const hashParams = new URLSearchParams(hashContent);
        for (const [key, value] of Array.from(hashParams.entries())) {
          if (SENSITIVE_QUERY_KEY_PATTERN.test(key) || HIGH_ENTROPY_TOKEN_PATTERN.test(value)) {
            hashParams.set(key, '[REDACTED]');
          }
        }
        parsed.hash = '#' + hashParams.toString();
      }
    }

    return parsed.toString();
  } catch {
    return rawUrl.replace(/([?&#])([^=]+)=([^&#]*)/gi, '$1$2=[REDACTED]');
  }
}

const PII_REDACTION_RULES: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[REDACTED_SSN]' },
  { pattern: /\b\d{2}-\d{7}\b/g, replacement: '[REDACTED_EIN]' },
  { pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, replacement: 'Bearer [REDACTED]' },
  { pattern: /Basic\s+[A-Za-z0-9+/=]+/gi, replacement: 'Basic [REDACTED]' },
  { pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g, replacement: '[REDACTED_CARD]' }
];

export function sanitizeTelemetryAttributes(
  attributes: Record<string, unknown>
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === 'string') {
      if (key === 'target.url' || key.endsWith('.url')) {
        sanitized[key] = sanitizeTelemetryUrl(value);
      } else {
        let scrubbed = value;
        for (const rule of PII_REDACTION_RULES) {
          scrubbed = scrubbed.replace(rule.pattern, rule.replacement);
        }
        sanitized[key] = scrubbed;
      }
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      sanitized[key] = sanitizeTelemetryAttributes(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}
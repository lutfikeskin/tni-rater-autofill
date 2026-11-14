export interface HeartbeatConfig {
  minIntervalMs: number;
  jitterRatio: number;
  minJitterMs: number;
  periodToleranceRatio: number;
}

export class AdaptiveHeartbeatTracker {
  private readonly config: HeartbeatConfig = {
    minIntervalMs: 1500,
    jitterRatio: 0.05,
    minJitterMs: 40,
    periodToleranceRatio: 0.20 // ±20%
  };

  private history = new Map<string, number[]>();
  private pollRegistry = new Map<string, { periodMs: number; lastSeen: number }>();

  public normalizeUrlPattern(rawUrl: string): string {
    try {
      const parsed = new URL(rawUrl, 'https://internal.host');
      const volatileParams = ['_', 't', 'timestamp', 'cb', 'nocache', 'v', 'random'];
      volatileParams.forEach((p) => parsed.searchParams.delete(p));
      const normalizedPath = parsed.pathname
        .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:uuid')
        .replace(/\/\d+(?=\/|$)/g, '/:id');
      return `${parsed.origin}${normalizedPath}?${parsed.searchParams.toString()}`;
    } catch {
      return rawUrl.split('?')[0];
    }
  }

  public isBeat(method: string, rawUrl: string, timestamp: number = performance.now()): boolean {
    const upperMethod = method.toUpperCase();
    if (upperMethod !== 'GET' && upperMethod !== 'HEAD') {
      return false;
    }

    const normalizedUrl = this.normalizeUrlPattern(rawUrl);
    const key = `${upperMethod}:${normalizedUrl}`;

    if (!this.history.has(key)) {
      this.history.set(key, [timestamp]);
      return false;
    }

    const timestamps = this.history.get(key)!;
    const lastTimestamp = timestamps[timestamps.length - 1];
    const deltaCurrent = timestamp - lastTimestamp;
    timestamps.push(timestamp);
    if (timestamps.length > 5) timestamps.shift();

    if (this.pollRegistry.has(key)) {
      const record = this.pollRegistry.get(key)!;
      const lowerBound = (1 - this.config.periodToleranceRatio) * record.periodMs;
      const upperBound = (1 + this.config.periodToleranceRatio) * record.periodMs;

      if (deltaCurrent >= lowerBound && deltaCurrent <= upperBound) {
        record.periodMs = 0.8 * record.periodMs + 0.2 * deltaCurrent;
        record.lastSeen = timestamp;
        return true;
      } else {
        this.pollRegistry.delete(key);
        return false;
      }
    }

    if (timestamps.length < 3) {
      return false;
    }

    const n = timestamps.length;
    const delta1 = timestamps[n - 1] - timestamps[n - 2];
    const delta2 = timestamps[n - 2] - timestamps[n - 3];

    if (delta1 >= this.config.minIntervalMs && delta2 >= this.config.minIntervalMs) {
      const estimatedPeriod = (delta1 + delta2) / 2;
      const adaptiveJitter = Math.max(this.config.minJitterMs, this.config.jitterRatio * estimatedPeriod);

      if (Math.abs(delta1 - delta2) <= adaptiveJitter) {
        this.pollRegistry.set(key, { periodMs: estimatedPeriod, lastSeen: timestamp });
        return true;
      }
    }

    return false;
  }
}
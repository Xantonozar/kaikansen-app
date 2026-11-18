import { Injectable, Logger } from '@nestjs/common';

/**
 * Tiny chat metrics: in-process counters with one structured log
 * line per increment (`{"metric":"chat","event":"sends","count":n}`),
 * so production logs can answer the deep analysis's basic
 * questions — is chat used, are requests accepted, is anyone
 * spraying — without a metrics backend. Counts are per-process
 * and reset on restart, like presence; they are a visibility
 * floor, not billing-grade telemetry.
 */
@Injectable()
export class ChatMetrics {
  private readonly logger = new Logger('ChatMetrics');
  private readonly counters = new Map<string, number>();

  inc(event: string, by = 1): void {
    const count = (this.counters.get(event) ?? 0) + by;
    this.counters.set(event, count);
    this.logger.log(JSON.stringify({ metric: 'chat', event, count }));
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }
}

/** Public API of the metrics module: live session totals and speeds, and performance reports. */
export { MetricsReporter, type ReportContext } from './internal/reporter';
export { SessionMetrics } from './internal/session-metrics';
export type { SideTally, TallySnapshot } from './internal/session-tally';

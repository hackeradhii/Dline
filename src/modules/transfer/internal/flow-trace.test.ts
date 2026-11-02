import { describe, expect, it } from 'vitest';
import { FLOW } from '../../../shared/config';
import { FlowTrace, type TraceRecord } from './flow-trace';

const record = (t: number): TraceRecord => ({
  t,
  mode: 'shadow',
  state: 'controlled',
  qd: 12,
  qdAvg: 10,
  rtt: 40,
  delivery: 500_000,
  rate: 450_000,
  legacy: null,
  applied: null,
  call: true,
  media: 2_500_000,
  lanes: 4,
  target: 30,
  noise: 8,
  reserve: 400_000,
});

describe('FlowTrace (PLAN.md §5.7)', () => {
  it('keeps the last two minutes of decisions and drains', () => {
    const trace = new FlowTrace();
    for (let t = 0; t <= 200_000; t += 1_000) trace.add(record(t));
    expect(trace.records[0]!.t).toBe(200_000 - FLOW.traceWindowMs);
    expect(trace.records.at(-1)!.t).toBe(200_000);

    trace.addDrain({ start: 0, end: 1_000, validated: false });
    trace.addDrain({ start: 150_000, end: 151_000, validated: true });
    expect(trace.drains).toEqual([{ start: 150_000, end: 151_000, validated: true }]);
  });

  it('saves as versioned JSON of numbers and flags only', () => {
    const trace = new FlowTrace();
    trace.add(record(5));
    expect(JSON.parse(JSON.stringify(trace))).toEqual({ version: 2, windowMs: FLOW.traceWindowMs, records: [record(5)], drains: [] });
  });
});

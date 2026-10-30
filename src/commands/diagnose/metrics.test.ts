import { describe, it, expect } from 'vitest';
import { formatValue } from './metrics.js';

describe('formatValue', () => {
  it('formats disk byte counters as sizes, not percentages', () => {
    expect(formatValue('disk_total', 8511270912)).toBe('7.9 GB');
    expect(formatValue('disk_used', 1073741824)).toBe('1.0 GB');
    expect(formatValue('disk_database', 5242880)).toBe('5.0 MB');
    expect(formatValue('disk_wal', 2048)).toBe('2.0 KB');
    expect(formatValue('disk_total', 2199023255552)).toBe('2.0 TB');
  });

  it('still formats percentage metrics with a percent sign', () => {
    expect(formatValue('disk_usage', 42.1)).toBe('42.1%');
    expect(formatValue('cpu_usage', 7)).toBe('7.0%');
    expect(formatValue('memory_usage', 63.25)).toBe('63.3%');
  });

  it('formats network metrics as a rate', () => {
    expect(formatValue('network_in', 512)).toBe('512.0 B/s');
    expect(formatValue('network_out', 1536)).toBe('1.5 KB/s');
  });
});

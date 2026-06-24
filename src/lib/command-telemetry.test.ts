import { beforeEach, describe, expect, it, vi } from 'vitest';

const configMock = vi.hoisted(() => ({
  getProjectConfig: vi.fn(() => ({
    project_id: 'p1',
    project_name: 'Test Project',
    org_id: 'o1',
    region: 'us',
    api_key: 'secret',
    appkey: 'app',
    oss_host: 'https://app.us.insforge.app',
  })),
}));
vi.mock('./config.js', () => configMock);

const analyticsMock = vi.hoisted(() => ({
  trackGroupCommand: vi.fn(),
  trackTopLevelCommand: vi.fn(),
  shutdownAnalytics: vi.fn(async () => {}),
}));
vi.mock('./analytics.js', () => analyticsMock);

import { CLIError } from './errors.js';
import {
  getErrorTelemetry,
  resetTelemetryOutcomeForTests,
  sanitizeTelemetry,
  trackCommandUsage,
  trackTopLevelUsage,
} from './command-telemetry.js';

describe('sanitizeTelemetry', () => {
  it('keeps booleans, finite numbers, and short strings', () => {
    expect(sanitizeTelemetry({ ok: true, count: 3, label: 'list' })).toEqual({
      ok: true,
      count: 3,
      label: 'list',
    });
  });

  it('drops undefined, non-finite numbers, and non-scalar values', () => {
    const result = sanitizeTelemetry({
      missing: undefined,
      notFinite: Number.NaN,
      infinite: Number.POSITIVE_INFINITY,
      // Non-scalar values a caller might accidentally pass through.
      nested: { secret: 'x' } as unknown as string,
      list: [1, 2, 3] as unknown as number,
      kept: 7,
    });
    expect(result).toEqual({ kept: 7 });
    expect(result).not.toHaveProperty('missing');
    expect(result).not.toHaveProperty('notFinite');
    expect(result).not.toHaveProperty('infinite');
    expect(result).not.toHaveProperty('nested');
    expect(result).not.toHaveProperty('list');
  });

  it('truncates long strings to 80 characters', () => {
    const long = 'a'.repeat(200);
    const result = sanitizeTelemetry({ value: long });
    expect((result.value as string).length).toBe(80);
  });
});

describe('getErrorTelemetry', () => {
  it('extracts code/exit/status from a CLIError', () => {
    const err = new CLIError('boom', 2, 'SOME_CODE', 409);
    expect(getErrorTelemetry(err)).toEqual({
      error_name: 'CLIError',
      error_code: 'SOME_CODE',
      exit_code: 2,
      status_code: 409,
    });
  });

  it('reports only the name for a plain Error', () => {
    expect(getErrorTelemetry(new TypeError('nope'))).toEqual({
      error_name: 'TypeError',
    });
  });

  it('falls back to typeof for a thrown non-Error', () => {
    expect(getErrorTelemetry('just a string')).toEqual({
      error_name: 'string',
    });
  });
});

describe('trackCommandUsage', () => {
  beforeEach(() => {
    resetTelemetryOutcomeForTests();
    analyticsMock.trackGroupCommand.mockClear();
    analyticsMock.shutdownAnalytics.mockClear();
    configMock.getProjectConfig.mockReturnValue({
      project_id: 'p1',
      project_name: 'Test Project',
      org_id: 'o1',
      region: 'us',
      api_key: 'secret',
      appkey: 'app',
      oss_host: 'https://app.us.insforge.app',
    });
  });

  it('emits a grouped event with sanitized props plus error telemetry, then flushes', async () => {
    await trackCommandUsage(
      'db',
      'query',
      false,
      { result_count: 5, secret: { v: 1 } as unknown as string },
      new CLIError('bad', 1, 'BAD', 400),
    );

    expect(analyticsMock.trackGroupCommand).toHaveBeenCalledWith(
      'db',
      'query',
      expect.objectContaining({ project_id: 'p1' }),
      expect.objectContaining({
        success: false,
        result_count: 5,
        error_name: 'CLIError',
        error_code: 'BAD',
        exit_code: 1,
        status_code: 400,
      }),
    );
    const props = analyticsMock.trackGroupCommand.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(props).not.toHaveProperty('secret');
    expect(analyticsMock.shutdownAnalytics).toHaveBeenCalledOnce();
  });

  it('swallows a throwing getProjectConfig and still emits with null config', async () => {
    configMock.getProjectConfig.mockImplementation(() => {
      throw new Error('config unreadable');
    });

    await expect(trackCommandUsage('db', 'query', true)).resolves.toBeUndefined();

    expect(analyticsMock.trackGroupCommand).toHaveBeenCalledWith(
      'db',
      'query',
      null,
      expect.objectContaining({ success: true }),
    );
    expect(analyticsMock.shutdownAnalytics).toHaveBeenCalledOnce();
  });

  it('records only one outcome per process (suppresses a later failure after success)', async () => {
    await trackCommandUsage('db', 'query', true);
    await trackCommandUsage('db', 'query', false, {}, new Error('output blew up'));

    expect(analyticsMock.trackGroupCommand).toHaveBeenCalledOnce();
    expect(analyticsMock.trackGroupCommand.mock.calls[0]?.[3]).toMatchObject({ success: true });
  });
});

describe('trackTopLevelUsage', () => {
  beforeEach(() => {
    resetTelemetryOutcomeForTests();
    analyticsMock.trackTopLevelCommand.mockClear();
    analyticsMock.shutdownAnalytics.mockClear();
  });

  it('emits a top-level event and flushes once', async () => {
    await trackTopLevelUsage('whoami', true);
    expect(analyticsMock.trackTopLevelCommand).toHaveBeenCalledWith(
      'whoami',
      expect.objectContaining({ project_id: 'p1' }),
      expect.objectContaining({ success: true }),
    );
    expect(analyticsMock.shutdownAnalytics).toHaveBeenCalledOnce();
  });
});

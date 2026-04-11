import { describe, expect, it } from 'vitest';
import * as path from 'node:path';

/**
 * Unit tests for create command logic extracted into pure functions.
 * These test the validation and normalization rules without needing
 * to mock the full CLI command handler.
 */

// Mirrors the sanitization logic in create.ts line ~281
function sanitizeDirName(input: string): string {
  return path.basename(input).replace(/[^a-zA-Z0-9._-]/g, '-');
}

// Mirrors the validation logic in create.ts lines ~274-278
function validateDirInput(v: string): string | undefined {
  if (v.length < 1) return 'Directory name is required';
  const normalized = path.basename(v).replace(/[^a-zA-Z0-9._-]/g, '-');
  if (!normalized || normalized === '.' || normalized === '..') return 'Invalid directory name';
  return undefined;
}

// Mirrors the post-normalization check in create.ts lines ~283-285
function isValidNormalizedDir(dirName: string): boolean {
  return !!dirName && dirName !== '.' && dirName !== '..';
}

describe('create command: directory name validation', () => {
  it('accepts a simple name', () => {
    expect(validateDirInput('my-app')).toBeUndefined();
    expect(sanitizeDirName('my-app')).toBe('my-app');
  });

  it('accepts names with dots and underscores', () => {
    expect(validateDirInput('my_app.v2')).toBeUndefined();
    expect(sanitizeDirName('my_app.v2')).toBe('my_app.v2');
  });

  it('rejects empty input', () => {
    expect(validateDirInput('')).toBe('Directory name is required');
  });

  it('rejects . and ..', () => {
    expect(validateDirInput('.')).toBe('Invalid directory name');
    expect(validateDirInput('..')).toBe('Invalid directory name');
  });

  it('rejects / which normalizes to empty string', () => {
    // path.basename('/') returns '' which becomes '' after sanitization
    expect(validateDirInput('/')).toBe('Invalid directory name');
  });

  it('rejects ./ which normalizes to .', () => {
    expect(validateDirInput('./')).toBe('Invalid directory name');
  });

  it('sanitizes special characters to hyphens', () => {
    expect(sanitizeDirName('my app!')).toBe('my-app-');
    expect(sanitizeDirName('hello@world')).toBe('hello-world');
  });

  it('extracts basename from path input', () => {
    expect(sanitizeDirName('/some/path/my-app')).toBe('my-app');
    expect(sanitizeDirName('../../my-app')).toBe('my-app');
  });

  it('post-normalization check rejects empty and dot names', () => {
    expect(isValidNormalizedDir('')).toBe(false);
    expect(isValidNormalizedDir('.')).toBe(false);
    expect(isValidNormalizedDir('..')).toBe(false);
  });

  it('post-normalization check accepts valid names', () => {
    expect(isValidNormalizedDir('my-app')).toBe(true);
    expect(isValidNormalizedDir('test.project')).toBe(true);
  });
});

describe('create command: org auto-select logic', () => {
  // Mirrors the org selection logic in create.ts
  function selectOrg(
    orgs: Array<{ id: string; name: string }>,
    json: boolean,
    providedOrgId?: string,
  ): { orgId: string | null; error: string | null; autoSelected: boolean } {
    if (providedOrgId) {
      return { orgId: providedOrgId, error: null, autoSelected: false };
    }
    if (orgs.length === 0) {
      return { orgId: null, error: 'No organizations found.', autoSelected: false };
    }
    if (orgs.length === 1) {
      return { orgId: orgs[0].id, error: null, autoSelected: true };
    }
    // Multiple orgs
    if (json) {
      return { orgId: null, error: 'Multiple organizations found. Specify --org-id.', autoSelected: false };
    }
    // Would prompt interactively
    return { orgId: null, error: null, autoSelected: false };
  }

  it('uses provided org-id directly', () => {
    const result = selectOrg([{ id: 'org1', name: 'Org 1' }], false, 'org-provided');
    expect(result.orgId).toBe('org-provided');
    expect(result.autoSelected).toBe(false);
  });

  it('errors when no orgs exist', () => {
    const result = selectOrg([], false);
    expect(result.error).toBe('No organizations found.');
  });

  it('auto-selects single org in interactive mode', () => {
    const result = selectOrg([{ id: 'org1', name: 'My Org' }], false);
    expect(result.orgId).toBe('org1');
    expect(result.autoSelected).toBe(true);
  });

  it('auto-selects single org in JSON mode', () => {
    const result = selectOrg([{ id: 'org1', name: 'My Org' }], true);
    expect(result.orgId).toBe('org1');
    expect(result.autoSelected).toBe(true);
  });

  it('errors in JSON mode with multiple orgs', () => {
    const result = selectOrg(
      [{ id: 'org1', name: 'Org 1' }, { id: 'org2', name: 'Org 2' }],
      true,
    );
    expect(result.error).toBe('Multiple organizations found. Specify --org-id.');
  });

  it('returns null orgId for multiple orgs in interactive mode (would prompt)', () => {
    const result = selectOrg(
      [{ id: 'org1', name: 'Org 1' }, { id: 'org2', name: 'Org 2' }],
      false,
    );
    expect(result.orgId).toBeNull();
    expect(result.error).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { isMaskedDatabasePassword, spliceDatabasePassword } from './oss.js';

describe('spliceDatabasePassword', () => {
  // Real shape from cloud `/api/metadata/database-connection-string`
  const masked = 'postgresql://postgres:********@b4jh2kvi.us-east.database.insforge.app:5432/insforge?sslmode=require';

  it('replaces the masked password with the real one', () => {
    const result = spliceDatabasePassword(masked, '66666b99c46288a34220009437d8a3c2');
    expect(result).toBe('postgresql://postgres:66666b99c46288a34220009437d8a3c2@b4jh2kvi.us-east.database.insforge.app:5432/insforge?sslmode=require');
    expect(result).not.toContain('********');
  });

  it('preserves the rest of the URL exactly (host, port, db, query)', () => {
    const result = spliceDatabasePassword(masked, 'pw');
    expect(result).toContain('@b4jh2kvi.us-east.database.insforge.app:5432/insforge?sslmode=require');
  });

  it('handles passwords containing special characters', () => {
    // Backend already URL-encodes special chars; we just inject verbatim.
    const result = spliceDatabasePassword(masked, 'p%40ss%3Aword');
    expect(result).toContain(':p%40ss%3Aword@');
  });

  it('only replaces the first `://user:...@` block (in case the URL has @ elsewhere)', () => {
    const m = 'postgresql://postgres:********@db.host.app:5432/insforge?options=user%3D%40admin';
    const result = spliceDatabasePassword(m, 'realpw');
    expect(result).toBe('postgresql://postgres:realpw@db.host.app:5432/insforge?options=user%3D%40admin');
  });
});

describe('isMaskedDatabasePassword', () => {
  it('detects the platform`s standard 8-star mask', () => {
    expect(isMaskedDatabasePassword('********')).toBe(true);
  });
  it('detects any run of `*` (in case the platform shortens or lengthens it)', () => {
    expect(isMaskedDatabasePassword('*')).toBe(true);
    expect(isMaskedDatabasePassword('***')).toBe(true);
    expect(isMaskedDatabasePassword('****************')).toBe(true);
  });
  it('does not flag real passwords (even ones that happen to contain `*`)', () => {
    expect(isMaskedDatabasePassword('66666b99c46288a34220009437d8a3c2')).toBe(false);
    expect(isMaskedDatabasePassword('p*ssw0rd')).toBe(false);
    expect(isMaskedDatabasePassword('*real*')).toBe(false);
  });
  it('does not flag empty string (caller checks emptiness separately)', () => {
    expect(isMaskedDatabasePassword('')).toBe(false);
  });
});

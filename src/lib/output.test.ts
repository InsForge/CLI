import { describe, it, expect } from 'vitest';
import { setToonMode, outputTable, outputSuccess, outputInfo, outputJson } from './output.js';

describe('toonEscapeValue (indirectly via outputTable)', () => {
  it('quotes values containing structural chars (comma, colon, bracket, etc.)', () => {
    // outputTable with toon mode writes TOON to stdout
    // We capture console.log to test the output
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      setToonMode(true);
      outputTable(['Name'], [['Smith, John']]);
      expect(logs[0]).toContain('"Smith, John"');
    } finally {
      console.log = origLog;
      setToonMode(false);
    }
  });

  it('outputTable renders colon-containing values quoted', () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      setToonMode(true);
      outputTable(['Key'], [['a:b']]);
      expect(logs[0]).toContain('"a:b"');
    } finally {
      console.log = origLog;
      setToonMode(false);
    }
  });

  it('does not quote simple alphanumeric values', () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      setToonMode(true);
      outputTable(['Name'], [['Alice']]);
      // Tabular TOON: header on first line, values on second line starting with 2 spaces
      expect(logs[0]).toMatch(/\n  Alice\n?$/);
    } finally {
      console.log = origLog;
      setToonMode(false);
    }
  });

  it('quotes empty string values', () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      setToonMode(true);
      outputTable(['Name'], [['']]);
      expect(logs[0]).toContain('""');
    } finally {
      console.log = origLog;
      setToonMode(false);
    }
  });

  it('quotes boolean-looking values', () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      setToonMode(true);
      outputTable(['Val'], [['true'], ['false']]);
      expect(logs[0]).toContain('"true"');
      expect(logs[0]).toContain('"false"');
    } finally {
      console.log = origLog;
      setToonMode(false);
    }
  });
});

describe('outputJson with TOON mode', () => {
  it('single object output is single TOON document', () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      setToonMode(true);
      outputJson({ name: 'Alice', role: 'admin' });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain('name:');
      expect(logs[0]).toContain('Alice');
    } finally {
      console.log = origLog;
      setToonMode(false);
    }
  });

  it('null values are preserved in TOON output', () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      setToonMode(true);
      outputJson({ name: 'Alice', deletedAt: null });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain('null');
    } finally {
      console.log = origLog;
      setToonMode(false);
    }
  });

  it('outputs a single doc (not multiple) in TOON mode', () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      setToonMode(true);
      outputJson({ users: [{ id: 1 }, { id: 2 }] });
      expect(logs).toHaveLength(1);
    } finally {
      console.log = origLog;
      setToonMode(false);
    }
  });
});

describe('outputSuccess/outputInfo in TOON mode', () => {
  it('outputSuccess suppresses in TOON mode', () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      setToonMode(true);
      outputSuccess('done');
      expect(logs).toHaveLength(0);
    } finally {
      console.log = origLog;
      setToonMode(false);
    }
  });

  it('outputInfo suppresses in TOON mode', () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      setToonMode(true);
      outputInfo('some info');
      expect(logs).toHaveLength(0);
    } finally {
      console.log = origLog;
      setToonMode(false);
    }
  });

  it('outputSuccess works normally outside TOON mode', () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      outputSuccess('done');
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain('done');
    } finally {
      console.log = origLog;
    }
  });
});

describe('outputTable renders correct TOON format', () => {
  it('produces tabular TOON with headers and rows', () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      setToonMode(true);
      outputTable(['Slug', 'Status'], [['my-func', 'active'], ['other-func', 'inactive']]);
      expect(logs[0]).toMatch(/^\[2\]\{/);
      expect(logs[0]).toContain('my-func');
      expect(logs[0]).toContain('active');
    } finally {
      console.log = origLog;
      setToonMode(false);
    }
  });

  it('handles empty table showing header-only line', () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      setToonMode(true);
      outputTable(['Name'], []);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toBe('[0]{Name}:');
    } finally {
      console.log = origLog;
      setToonMode(false);
    }
  });
});

import Table from 'cli-table3';

// Module-level state set by preAction hook
let toonMode = false;

export function setToonMode(enabled: boolean): void {
  toonMode = enabled;
}

// ── TOON formatting helpers ──────────────────────────────────────────────

function toonEscapeValue(v: unknown): string {
  if (v === null || v === undefined || (typeof v === 'number' && !isFinite(v))) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  const s = String(v);
  const needsQuoting =
    s === '' ||
    s === 'true' || s === 'false' || s === 'null' ||
    /^[+-]?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(s) ||
    /^[ \t]|[ \t]$/.test(s) ||
    /^[-#]/.test(s) ||
    /[:,"\\{}[\\]]/.test(s) ||
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f]/.test(s);
  if (!needsQuoting) return s;
  return '"' + s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + '"';
}

function toonEscapeKey(k: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(k)) return k;
  return '"' + k
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t') + '"';
}

// ── Public output functions ──────────────────────────────────────────────

export function outputJson(data: unknown): void {
  if (toonMode) {
    outputJsonToon(data);
    return;
  }
  console.log(JSON.stringify(data, null, 2));
}

export function outputTable(headers: string[], rows: string[][]): void {
  if (toonMode) {
    outputToon(headers, rows);
    return;
  }
  const table = new Table({
    head: headers,
    style: { head: ['cyan'] },
  });
  for (const row of rows) {
    table.push(row);
  }
  console.log(table.toString());
}

export function outputSuccess(message: string): void {
  if (toonMode) return; // TOON suppress non-structured output
  console.log(`✓ ${message}`);
}

export function outputInfo(message: string): void {
  if (toonMode) return; // TOON suppress non-structured output
  console.log(message);
}

// ── TOON output implementations ──────────────────────────────────────────

function outputToon(headers: string[], rows: string[][]): void {
  if (headers && rows && rows.length > 0) {
    const keyStr = headers.map(toonEscapeKey).join(',');
    let out = `[${rows.length}]{${keyStr}}:`;
    for (const row of rows) {
      out += '\n  ' + row.map(toonEscapeValue).join(',');
    }
    console.log(out);
  } else if (headers && headers.length > 0) {
    console.log(`[0]{${headers.map(toonEscapeKey).join(',')}}:`);
  }
}

function outputJsonToon(data: unknown): void {
  if (Array.isArray(data)) {
    if (data.length === 0) { console.log('[0]:'); return; }
    const first = data[0];
    if (typeof first === 'object' && first !== null) {
      const keys = Object.keys(first);
      const keyStr = keys.map(toonEscapeKey).join(',');
      let out = `[${data.length}]{${keyStr}}:`;
      for (const item of data) {
        out += '\n  ' + keys.map(k => toonEscapeValue((item as Record<string, unknown>)[k])).join(',');
      }
      console.log(out);
    } else {
      const vals = data.map(v => toonEscapeValue(v)).join(',');
      console.log(`[${data.length}]: ${vals}`);
    }
    return;
  }
  // Single object → TOON key-value
  if (typeof data === 'object' && data !== null) {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      const ek = toonEscapeKey(k);
      if (typeof v === 'object' && !Array.isArray(v)) {
        let nested: string;
        try { nested = JSON.stringify(v); } catch { nested = '[complex value]'; }
        console.log(`${ek}: ${nested}`);
      } else {
        console.log(`${ek}: ${toonEscapeValue(v)}`);
      }
    }
  } else {
    console.log(toonEscapeValue(data));
  }
}

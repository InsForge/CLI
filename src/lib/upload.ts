// Helpers for compute v3 source-deploy: tar a directory, upload via
// presigned PUT URL. The CLI uses these to ship source.tgz directly to
// InsForge's S3 staging bucket — bytes never proxy through OSS or cloud.

import { spawn } from 'node:child_process';

export function getDefaultExcludes(): string[] {
  return [
    '.git',
    'node_modules',
    '.insforge',
    '.next',
    'dist',
    'build',
    '__pycache__',
    '.venv',
    'venv',
    '.DS_Store',
  ];
}

/**
 * Tar+gzip a directory into a Buffer. Skips common big/irrelevant dirs by
 * default (`.git`, `node_modules`, etc.). Uses the system `tar` binary
 * since pure-JS tar is large and fragile across platforms.
 */
export async function tarDir(
  dir: string,
  excludes: string[] = getDefaultExcludes()
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = ['-czf', '-'];
    for (const ex of excludes) args.push('--exclude', ex);
    args.push('-C', dir, '.');
    const p = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderrTail = '';
    p.stdout.on('data', (b) => chunks.push(b as Buffer));
    p.stderr.on('data', (b) => {
      stderrTail = (stderrTail + (b as Buffer).toString()).slice(-1000);
    });
    p.on('exit', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`tar exited ${code}: ${stderrTail.slice(-500)}`));
    });
    p.on('error', reject);
  });
}

/**
 * PUT a Buffer to a presigned S3 URL. Throws on non-2xx.
 */
export async function uploadPresigned(url: string, body: Buffer): Promise<void> {
  const res = await fetch(url, {
    method: 'PUT',
    body: body as unknown as BodyInit,
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Length': String(body.length),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`upload failed (${res.status}): ${text.slice(0, 500)}`);
  }
}

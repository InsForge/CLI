import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface PreviewManifest {
  name: string;
  branchId: string;
  appkey: string;
  createdAt: string;
  wiredEnvFile?: string;
}

function previewDir(baseDir: string): string {
  return path.join(baseDir, '.insforge', 'previews');
}

function manifestPath(baseDir: string, name: string): string {
  return path.join(previewDir(baseDir), `${name}.json`);
}

export async function writePreviewManifest(
  baseDir: string,
  manifest: PreviewManifest,
): Promise<void> {
  await fs.mkdir(previewDir(baseDir), { recursive: true });
  await fs.writeFile(
    manifestPath(baseDir, manifest.name),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );
}

export async function readPreviewManifest(
  baseDir: string,
  name: string,
): Promise<PreviewManifest | null> {
  try {
    const raw = await fs.readFile(manifestPath(baseDir, name), 'utf8');
    return JSON.parse(raw) as PreviewManifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function deletePreviewManifest(baseDir: string, name: string): Promise<void> {
  await fs.rm(manifestPath(baseDir, name), { force: true });
}

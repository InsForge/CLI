// Pack a directory into the tar that POST /api/compute/services/:id/build expects.
//
// Deliberately *not* modelled on the deployments bundler, which strips
// node_modules, dist, build and friends. Those exclusions are right for a static
// site and wrong for a Docker build: a Dockerfile may legitimately COPY any of
// them, and silently dropping one produces a build that fails for a reason nothing
// on screen explains. Docker's own contract is 'everything, minus .dockerignore',
// so that is what this does. When the context is too big the backend answers 413
// and names .dockerignore as the fix.

import archiver from 'archiver';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';

export interface BuildContext {
  tar: Buffer;
  fileCount: number;
}

/** `.dockerignore` matcher, or null when the file is absent. */
async function loadDockerignore(dir: string) {
  try {
    const raw = await fs.readFile(path.join(dir, '.dockerignore'), 'utf8');
    // Docker's .dockerignore is gitignore-ish; `ignore` covers the syntax that
    // matters here. `!` negations and `**` both work.
    return ignore().add(raw);
  } catch {
    return null;
  }
}

/**
 * Tar `dir` for upload.
 *
 * Built in memory because the backend accepts one buffered body anyway, and the
 * ceiling it enforces (64MB by default) is well under what a CLI can hold.
 */
export async function packBuildContext(dir: string): Promise<BuildContext> {
  const matcher = await loadDockerignore(dir);
  const archive = archiver('tar');
  const chunks: Buffer[] = [];
  archive.on('data', (c: Buffer) => chunks.push(c));

  const done = new Promise<void>((resolve, reject) => {
    archive.on('end', resolve);
    archive.on('error', reject);
  });

  let fileCount = 0;
  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(dir, absolute).split(path.sep).join('/');
      if (!relative) {
        continue;
      }
      // `.git` is the one thing excluded unconditionally: it is often the largest
      // thing in the tree, a Dockerfile that needs it is vanishingly rare, and
      // shipping it means shipping every secret ever committed.
      if (relative === '.git' || relative.startsWith('.git/')) {
        continue;
      }
      if (matcher?.ignores(entry.isDirectory() ? `${relative}/` : relative)) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) {
        // Sockets, fifos and dangling symlinks have no meaning in a build context.
        continue;
      }
      archive.file(absolute, { name: relative });
      fileCount++;
    }
  }

  await walk(dir);
  void archive.finalize();
  await done;

  return { tar: Buffer.concat(chunks), fileCount };
}

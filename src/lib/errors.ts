import type { Command } from 'commander';

export class CLIError extends Error {
  constructor(
    message: string,
    public exitCode: number = 1,
    public code?: string,
  ) {
    super(message);
    this.name = 'CLIError';
  }
}

export class AuthError extends CLIError {
  constructor(message: string = 'Not authenticated. Run `insforge login` first.') {
    super(message, 2, 'AUTH_ERROR');
  }
}

export class ProjectNotLinkedError extends CLIError {
  constructor() {
    super('No project linked. Run `insforge projects link` first.', 3, 'PROJECT_NOT_LINKED');
  }
}

export class NotFoundError extends CLIError {
  constructor(resource: string) {
    super(`${resource} not found.`, 4, 'NOT_FOUND');
  }
}

export class PermissionError extends CLIError {
  constructor(message: string = 'Permission denied.') {
    super(message, 5, 'PERMISSION_DENIED');
  }
}

export function handleError(err: unknown, json: boolean): never {
  if (err instanceof CLIError) {
    if (json) {
      console.error(JSON.stringify({ error: err.message, code: err.code }));
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(err.exitCode);
  }

  const message = err instanceof Error ? err.message : String(err);
  if (json) {
    console.error(JSON.stringify({ error: message, code: 'UNKNOWN_ERROR' }));
  } else {
    console.error(`Error: ${message}`);
  }
  process.exit(1);
}

export function getJsonFlag(cmd: Command): boolean {
  let root: Command = cmd;
  while (root.parent) {
    root = root.parent;
  }
  return root.opts().json ?? false;
}

export function getRootOpts(cmd: Command): { json: boolean; apiUrl?: string; yes: boolean } {
  let root: Command = cmd;
  while (root.parent) {
    root = root.parent;
  }
  const opts = root.opts();
  return {
    json: opts.json ?? false,
    apiUrl: opts.apiUrl,
    yes: opts.yes ?? false,
  };
}

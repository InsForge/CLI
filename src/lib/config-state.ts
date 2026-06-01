import { ossFetch } from './api/oss.js';
import { CLIError } from './errors.js';
import type {
  RawConfigState,
  RawEmailTemplateMetadata,
  RawMetadataResponse,
  RawRetentionConfig,
  RawStorageConfig,
} from './config-metadata.js';

interface RawEmailTemplatesResponse {
  data?: unknown;
}

export async function loadConfigState(): Promise<RawConfigState> {
  const metadataRes = await ossFetch('/api/metadata');
  const metadata = (await metadataRes.json()) as RawMetadataResponse;

  const [storageConfig, realtimeConfig, schedulesConfig, emailTemplates] =
    await Promise.all([
      fetchOptionalJson<RawStorageConfig>('/api/storage/config'),
      fetchOptionalJson<RawRetentionConfig>('/api/realtime/config'),
      fetchOptionalJson<RawRetentionConfig>('/api/schedules/config'),
      fetchOptionalEmailTemplates(),
    ]);

  return {
    metadata,
    ...(storageConfig !== undefined ? { storageConfig } : {}),
    ...(realtimeConfig !== undefined ? { realtimeConfig } : {}),
    ...(schedulesConfig !== undefined ? { schedulesConfig } : {}),
    ...(emailTemplates !== undefined ? { emailTemplates } : {}),
  };
}

async function fetchOptionalJson<T>(path: string): Promise<T | undefined> {
  try {
    const res = await ossFetch(path);
    return (await res.json()) as T;
  } catch (err) {
    if (isOptionalEndpointUnsupported(err)) return undefined;
    throw err;
  }
}

async function fetchOptionalEmailTemplates(): Promise<RawEmailTemplateMetadata[] | undefined> {
  const body = await fetchOptionalJson<RawEmailTemplatesResponse>('/api/auth/email-templates');
  if (body === undefined || !Array.isArray(body.data)) return undefined;
  return body.data.filter(isPlainObject) as RawEmailTemplateMetadata[];
}

function isOptionalEndpointUnsupported(err: unknown): boolean {
  if (!(err instanceof CLIError)) return false;
  const message = err.message.toLowerCase();
  return (
    err.code === 'NOT_FOUND' ||
    message.includes('oss request failed: 404') ||
    message.includes('not found') ||
    message.includes('not available') ||
    message.includes('not enabled')
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

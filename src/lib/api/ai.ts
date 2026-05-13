import { CLIError } from '../errors.js';
import { ossFetch } from './oss.js';

export interface OpenRouterKeyResponse {
  apiKey: string;
  maskedKey?: string;
}

export async function getOpenRouterApiKey(): Promise<OpenRouterKeyResponse> {
  const res = await ossFetch('/api/ai/openrouter/api-key');
  const data = await res.json() as Partial<OpenRouterKeyResponse>;

  if (typeof data.apiKey !== 'string' || data.apiKey.length === 0) {
    throw new CLIError(
      'AI gateway returned no OpenRouter API key. Open the InsForge dashboard AI page and verify Model Gateway is configured.',
    );
  }

  return {
    apiKey: data.apiKey,
    maskedKey: typeof data.maskedKey === 'string' ? data.maskedKey : undefined,
  };
}

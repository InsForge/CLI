import { CLIError } from '../errors.js';
import { ossFetch } from './oss.js';

export interface OpenRouterKeyResponse {
  apiKey: string;
  maskedKey?: string;
}

/** Model Gateway key observability; usage/limit figures are USD credits. */
export interface AiOverview {
  key: {
    label?: string;
    limit: number | null;
    limitRemaining: number | null;
    limitReset?: string | null;
    usage: number;
    usageDaily: number;
    usageWeekly: number;
    usageMonthly: number;
    isFreeTier?: boolean;
    observabilityAvailable: boolean;
    observabilityError?: string;
  };
  charts: {
    spend: { label: string; value: number }[];
    requests: { label: string; value: number }[];
    tokens: { label: string; value: number }[];
  };
  modelUsage?: {
    model: string;
    providers: string[];
    requests: number;
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    spend: number;
    byokSpend: number;
  }[];
}

export async function getAiOverview(): Promise<AiOverview> {
  const res = await ossFetch('/api/ai/overview');
  return await res.json() as AiOverview;
}

export async function getOpenRouterApiKey(): Promise<OpenRouterKeyResponse> {
  const res = await ossFetch('/api/ai/openrouter/api-key');
  const data = await res.json() as Partial<OpenRouterKeyResponse>;
  const apiKey = typeof data.apiKey === 'string' ? data.apiKey.trim() : '';
  const maskedKey = typeof data.maskedKey === 'string' ? data.maskedKey.trim() : undefined;

  if (apiKey.length === 0) {
    throw new CLIError(
      'AI gateway returned no OpenRouter API key. Open the InsForge dashboard AI page and verify Model Gateway is configured.',
    );
  }

  return {
    apiKey,
    maskedKey,
  };
}

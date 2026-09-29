import type { ModelProvider } from '@humanize/domain';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { BedrockProvider, OllamaProvider } from '@humanize/providers';

/**
 * Model for the live review lane. Bedrock is used only when its variables are set explicitly;
 * otherwise Ollama, exactly as before. Nothing falls back from one to the other (INV-007).
 */
export function liveProvider(): { provider: ModelProvider; model: string; kind: 'ollama' | 'bedrock'; timeoutMs: number } {
  const bedrockModel = process.env.HUMANIZE_BEDROCK_MODEL;
  if (bedrockModel) {
    const key = process.env.AWS_BEARER_TOKEN_BEDROCK ?? null, region = process.env.HUMANIZE_BEDROCK_REGION;
    if (!region) throw Error('HUMANIZE_BEDROCK_MODEL is set: also set HUMANIZE_BEDROCK_REGION.');
    // A Bedrock API key if one is set, otherwise ordinary AWS credentials signed with SigV4,
    // so an SSO or role session works without minting a long-lived key.
    const provider = new BedrockProvider(key, region, key ? {} : { credentials: fromNodeProviderChain() });
    return { provider, model: bedrockModel, kind: 'bedrock', timeoutMs: 90000 };
  }
  const baseUrl = process.env.HUMANIZE_OLLAMA_BASE_URL, model = process.env.HUMANIZE_OLLAMA_MODEL;
  if (!baseUrl || !model) throw Error('Set HUMANIZE_OLLAMA_BASE_URL and HUMANIZE_OLLAMA_MODEL, or the Bedrock variables; a live test is never silently skipped.');
  return { provider: new OllamaProvider(baseUrl, true), model, kind: 'ollama', timeoutMs: 180000 };
}

import type { ModelProvider } from '@humanize/domain';
import { BedrockProvider, OllamaProvider } from '@humanize/providers';

/**
 * Model for the live review lane. Bedrock is used only when its variables are set explicitly;
 * otherwise Ollama, exactly as before. Nothing falls back from one to the other (INV-007).
 */
export function liveProvider(): { provider: ModelProvider; model: string; kind: 'ollama' | 'bedrock'; timeoutMs: number } {
  const bedrockModel = process.env.HUMANIZE_BEDROCK_MODEL;
  if (bedrockModel) {
    const key = process.env.AWS_BEARER_TOKEN_BEDROCK, region = process.env.HUMANIZE_BEDROCK_REGION;
    if (!key || !region) throw Error('HUMANIZE_BEDROCK_MODEL is set: also set AWS_BEARER_TOKEN_BEDROCK and HUMANIZE_BEDROCK_REGION.');
    return { provider: new BedrockProvider(key, region), model: bedrockModel, kind: 'bedrock', timeoutMs: 90000 };
  }
  const baseUrl = process.env.HUMANIZE_OLLAMA_BASE_URL, model = process.env.HUMANIZE_OLLAMA_MODEL;
  if (!baseUrl || !model) throw Error('Set HUMANIZE_OLLAMA_BASE_URL and HUMANIZE_OLLAMA_MODEL, or the Bedrock variables; a live test is never silently skipped.');
  return { provider: new OllamaProvider(baseUrl, true), model, kind: 'ollama', timeoutMs: 180000 };
}

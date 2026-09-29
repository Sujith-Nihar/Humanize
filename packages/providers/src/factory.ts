import type { ModelProvider } from '@humanize/domain';
import { ProviderId } from '@humanize/domain';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { OpenAIProvider } from './openai.js';
import { GeminiProvider } from './gemini.js';
import { OpenRouterProvider } from './openrouter.js';
import { BedrockProvider } from './bedrock.js';
import { OllamaProvider } from './ollama.js';
import { ProviderError } from './errors.js';

type ProviderName=(typeof ProviderId)['options'][number];

export interface ProviderDeployment {
  /** Required to construct a Bedrock adapter; there is no sensible default region. */
  bedrockRegion?:string|undefined;
  /**
   * A local model the deployment itself operates. Absent by default: a customer-supplied base
   * URL would let repository configuration point the control plane at an arbitrary host, which
   * is the SSRF risk Phase 1 refuses (spec 26.4). Only a whole-product self-hoster sets this.
   */
  ollamaBaseUrl?:string|undefined;
}

/**
 * Builds the adapter for exactly the provider a model profile names.
 *
 * There is deliberately no fallback. If the named provider cannot be constructed — no
 * credential, no region, no local endpoint — this throws, and the caller reports that the
 * review could not run. Substituting a provider the administrator did not choose would send
 * the customer's content somewhere they never approved (INV-007).
 */
export function createProvider(provider:ProviderName,secret:string|null,deployment:ProviderDeployment={}):ModelProvider {
  switch(provider){
    case 'openai':
      if(!secret)throw new ProviderError('AUTH');
      return new OpenAIProvider(secret);
    case 'gemini':
      if(!secret)throw new ProviderError('AUTH');
      return new GeminiProvider(secret);
    case 'openrouter':
      if(!secret)throw new ProviderError('AUTH');
      return new OpenRouterProvider(secret);
    case 'bedrock':
      // Either authentication mode is acceptable: a stored API key, or the deployment's own
      // AWS role signed with SigV4 when no key is configured.
      if(!deployment.bedrockRegion)throw new ProviderError('PERMISSION');
      return new BedrockProvider(secret,deployment.bedrockRegion,secret?{}:{credentials:fromNodeProviderChain()});
    case 'ollama':
      if(!deployment.ollamaBaseUrl)throw new ProviderError('PERMISSION');
      return new OllamaProvider(deployment.ollamaBaseUrl,true);
  }
}

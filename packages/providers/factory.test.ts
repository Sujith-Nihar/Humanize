import { expect,it } from 'vitest';
import { ProviderError,createProvider } from './src/index.js';

it('builds the adapter the profile names', () => {
  expect(createProvider('openai','sk-test')).toBeDefined();
  expect(createProvider('gemini','key')).toBeDefined();
  expect(createProvider('openrouter','key')).toBeDefined();
  expect(createProvider('bedrock','key',{bedrockRegion:'us-east-1'})).toBeDefined();
  // Bedrock signs with the deployment's own AWS role when no stored key exists.
  expect(createProvider('bedrock',null,{bedrockRegion:'us-east-1'})).toBeDefined();
  expect(createProvider('ollama',null,{ollamaBaseUrl:'http://127.0.0.1:11434'})).toBeDefined();
});

it('refuses rather than substituting a provider that cannot be built', () => {
  // A substitution would review the customer's content with a model their administrator
  // never chose, which is the cross-provider fallback INV-007 forbids.
  for(const provider of ['openai','gemini','openrouter'] as const)expect(()=>createProvider(provider,null)).toThrow(ProviderError);
  expect(()=>createProvider('bedrock','key')).toThrow(ProviderError);
  // No customer-configured base URL: without one the deployment operates no local model.
  expect(()=>createProvider('ollama',null)).toThrow(ProviderError);
});

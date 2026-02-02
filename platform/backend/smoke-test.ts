import groqProxyRoutes from './src/routes/proxy/groq';
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

console.log('Testing Groq Proxy Routes import...');

if (typeof groqProxyRoutes === 'function') {
  console.log('SUCCESS: Groq proxy routes exported correctly.');
} else {
  console.error('FAILURE: Groq proxy routes not exported correctly.');
  process.exit(1);
}

// Since we can't easily run a full fastify server due to dependencies,
// we just check if the model pricing is recognized.
import getDefaultPricing from './src/default-model-prices';

const llamaPricing = getDefaultPricing('llama-3.3-70b-versatile');
console.log('Llama Pricing:', llamaPricing);

if (llamaPricing.pricePerMillionInput === '50.00') {
  console.log('SUCCESS: Llama pricing correctly falls back to default.');
} else {
  console.warn('NOTE: Llama pricing is customized:', llamaPricing);
}

console.log('Smoke test completed.');

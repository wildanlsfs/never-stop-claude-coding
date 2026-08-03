import { z } from 'zod';

export const ConfigSchema = z.object({
  cux: z.object({
    enabled: z.boolean().default(true),
    autoRotateOnRateLimit: z.boolean().default(true),
  }).default({
    enabled: true,
    autoRotateOnRateLimit: true,
  }),
  fallback: z.object({
    enabled: z.boolean().default(true),
    forceFallback: z.boolean().default(false), // If true, route directly to fallback even if limit is not reached
    provider: z.string().default('openrouter'), // '9router', 'openrouter', 'deepseek', 'custom'
    baseUrl: z.string().default('https://openrouter.ai/api/v1'),
    apiKey: z.string().default(''),
    model: z.string().default('deepseek/deepseek-chat'),
    maxTokens: z.number().default(4096),
  }).default({
    enabled: true,
    forceFallback: false,
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: '',
    model: 'deepseek/deepseek-chat',
    maxTokens: 4096,
  }),
  proxy: z.object({
    port: z.number().default(3456),
    verbose: z.boolean().default(false),
  }).default({
    port: 3456,
    verbose: false,
  }),
});

export type NsccConfig = z.infer<typeof ConfigSchema>;

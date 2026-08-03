import { describe, it, expect } from 'vitest';
import { ConfigManager, PROVIDER_PRESETS } from '../src/config/manager.js';

describe('ConfigManager & Presets', () => {
  it('has 9router preset configured with default local port', () => {
    const nineRouterPreset = PROVIDER_PRESETS['9router'];
    expect(nineRouterPreset).toBeDefined();
    expect(nineRouterPreset.baseUrl).toBe('http://localhost:20128/v1');
    expect(nineRouterPreset.provider).toBe('9router');
  });

  it('applies 9router preset correctly', () => {
    const config = ConfigManager.applyPreset('9router');
    expect(config.fallback.provider).toBe('9router');
    expect(config.fallback.baseUrl).toBeDefined();
  });
});

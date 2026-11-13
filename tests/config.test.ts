import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager, PROVIDER_PRESETS, normalizeOpenAIBaseUrl } from '../src/config/manager.js';

describe('ConfigManager & Presets', () => {
  let tmpDir: string;
  let originalHomedir: typeof os.homedir;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nscc-test-'));
    originalHomedir = os.homedir;
    os.homedir = () => tmpDir;
  });

  afterAll(() => {
    os.homedir = originalHomedir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('has 9router preset configured with default local port', () => {
    const nineRouterPreset = PROVIDER_PRESETS['9router'];
    expect(nineRouterPreset).toBeDefined();
    expect(nineRouterPreset.baseUrl).toBe('http://localhost:20128/v1');
    expect(nineRouterPreset.provider).toBe('9router');
  });

  it('normalizes OpenAI-compatible base URLs by appending /v1 when path is root', () => {
    expect(normalizeOpenAIBaseUrl('http://localhost:20128')).toBe('http://localhost:20128/v1');
    expect(normalizeOpenAIBaseUrl('http://localhost:20128/')).toBe('http://localhost:20128/v1');
    expect(normalizeOpenAIBaseUrl('http://localhost:20128/v1/')).toBe('http://localhost:20128/v1');
    expect(normalizeOpenAIBaseUrl('http://localhost:20128/v1/chat/completions')).toBe('http://localhost:20128/v1');
    expect(normalizeOpenAIBaseUrl('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api/v1');
  });

  it('applies 9router preset cleanly even when switching from openrouter default', () => {
    ConfigManager.saveConfig({
      fallback: {
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'deepseek/deepseek-chat',
        apiKey: 'sk-or-test',
      },
    });

    const config = ConfigManager.applyPreset('9router');
    expect(config.fallback.provider).toBe('9router');
    expect(config.fallback.baseUrl).toBe('http://localhost:20128/v1');
    expect(config.fallback.model).toBe('claude-3-5-sonnet');
    expect(config.fallback.apiKey).toBe('9router-local');
  });

  it('preserves custom cloud URL and key when re-applying 9router preset', () => {
    ConfigManager.saveConfig({
      fallback: {
        provider: '9router',
        baseUrl: 'https://my-9router.example.com/v1',
        model: 'combo',
        apiKey: 'sk-9router-cloud',
      },
    });

    const config = ConfigManager.applyPreset('9router');
    expect(config.fallback.baseUrl).toBe('https://my-9router.example.com/v1');
    expect(config.fallback.model).toBe('combo');
    expect(config.fallback.apiKey).toBe('sk-9router-cloud');
  });
});

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ConfigSchema, type NsccConfig } from './schema.js';

export function normalizeOpenAIBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  try {
    const parsed = new URL(trimmed);
    if (parsed.pathname === '' || parsed.pathname === '/') {
      return `${trimmed}/v1`;
    }
  } catch {
    // Return trimmed as-is if it's not a valid absolute URL
  }
  return trimmed;
}

export const PROVIDER_PRESETS: Record<string, Partial<NsccConfig['fallback']>> = {
  '9router': {
    provider: '9router',
    baseUrl: 'http://localhost:20128/v1',
    model: 'claude-3-5-sonnet',
    apiKey: '9router-local',
  },
  'openrouter': {
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-chat',
  },
  'deepseek': {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
};

export type ConfigUpdate = {
  cux?: Partial<NsccConfig['cux']>;
  fallback?: Partial<NsccConfig['fallback']>;
  proxy?: Partial<NsccConfig['proxy']>;
};

export class ConfigManager {
  private static getConfigDir(): string {
    return path.join(os.homedir(), '.nscc');
  }

  public static getConfigPath(): string {
    return path.join(this.getConfigDir(), 'config.json');
  }

  public static loadConfig(): NsccConfig {
    const configPath = this.getConfigPath();
    if (!fs.existsSync(configPath)) {
      return this.saveConfig({});
    }

    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      return ConfigSchema.parse(parsed);
    } catch {
      console.warn(`Failed to parse config at ${configPath}, falling back to defaults.`);
      return ConfigSchema.parse({});
    }
  }

  public static saveConfig(config: ConfigUpdate): NsccConfig {
    const configDir = this.getConfigDir();
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    const currentConfig = fs.existsSync(this.getConfigPath())
      ? this.loadConfig()
      : ConfigSchema.parse({});

    const mergedFallback = {
      ...currentConfig.fallback,
      ...(config.fallback || {}),
    };

    const merged = ConfigSchema.parse({
      ...currentConfig,
      ...config,
      cux: { ...currentConfig.cux, ...(config.cux || {}) },
      fallback: mergedFallback,
      proxy: { ...currentConfig.proxy, ...(config.proxy || {}) },
    });

    fs.writeFileSync(this.getConfigPath(), JSON.stringify(merged, null, 2), 'utf-8');
    return merged;
  }

  public static applyPreset(presetName: string): NsccConfig {
    const preset = PROVIDER_PRESETS[presetName.toLowerCase()];
    if (!preset) {
      throw new Error(`Unknown preset: "${presetName}". Available presets: ${Object.keys(PROVIDER_PRESETS).join(', ')}`);
    }

    const current = this.loadConfig();
    const isSameProvider = current.fallback.provider?.toLowerCase() === preset.provider?.toLowerCase();
    const isKnownPresetUrl = Object.values(PROVIDER_PRESETS).some((p) => p.baseUrl === current.fallback.baseUrl);
    const hasCustomUrl = isSameProvider && Boolean(current.fallback.baseUrl) && !isKnownPresetUrl;
    const hasCustomKey = isSameProvider && Boolean(current.fallback.apiKey) && current.fallback.apiKey !== '9router-local';

    // Preserve custom cloud URL/key/model only when re-applying the same provider preset
    const newFallback: Partial<NsccConfig['fallback']> = {
      ...preset,
      baseUrl: hasCustomUrl ? current.fallback.baseUrl : preset.baseUrl,
      apiKey: hasCustomKey ? current.fallback.apiKey : (preset.apiKey ?? ''),
      model: isSameProvider && current.fallback.model ? current.fallback.model : preset.model,
    };

    return this.saveConfig({
      fallback: newFallback,
    });
  }
}

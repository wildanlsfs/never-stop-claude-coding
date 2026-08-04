#!/usr/bin/env node
import { Command } from 'commander';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigManager, PROVIDER_PRESETS } from '../config/manager.js';
import { CuxManager } from '../cux/manager.js';
import { ProxyServer } from '../proxy/server.js';
import { Logger } from '../utils/logger.js';
import { UpdateNotifier } from '../utils/update.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

const program = new Command();

program
  .name('nscc')
  .description('Never Stop Claude Code - Multi-account rotation & OpenAI/9Router fallback CLI')
  .version('1.5.0');

async function isProxyHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(400) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureProxyRunning(port: number): Promise<void> {
  if (await isProxyHealthy(port)) {
    return;
  }

  const cliPath = path.join(projectRoot, 'dist/cli/index.js');
  const child = spawn(process.execPath, [cliPath, 'proxy', '--port', String(port)], {
    cwd: projectRoot,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Wait up to 3 seconds for proxy to start up
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (await isProxyHealthy(port)) {
      return;
    }
  }
}

// Default action / run command
program
  .command('run', { isDefault: true })
  .description('Launch Claude Code with silent background proxy and auto-fallback')
  .allowUnknownOption()
  .option('-f, --fallback', 'Force using 9Router/fallback endpoint directly even if limit is not reached')
  .option('-v, --verbose', 'Show proxy status')
  .option('-c, --auto-continue', 'Automatically re-inject "continue" when Claude Code stops mid-task')
  .argument('[claudeArgs...]', 'Arguments passed directly to claude')
  .action(async (claudeArgs: string[], options: { fallback?: boolean; verbose?: boolean; autoContinue?: boolean }) => {
    // Non-blocking update check
    UpdateNotifier.checkUpdate().catch(() => {});

    // If -f / --fallback is passed, set forceFallback temporarily in config
    if (options.fallback) {
      ConfigManager.saveConfig({ fallback: { forceFallback: true } });
    }

    const config = ConfigManager.loadConfig();
    const proxyPort = config.proxy.port;

    // Ensure background proxy is running silently
    await ensureProxyRunning(proxyPort);

    const commandToRun = 'claude';
    Logger.log(`nscc starting session on port ${proxyPort} (forceFallback: ${config.fallback.forceFallback})`);

    const childEnv = {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://localhost:${proxyPort}`,
    };

    if (!options.autoContinue) {
      // Normal mode: pass TTY directly to Claude Code
      if (process.stdin.isTTY && typeof process.stdin.pause === 'function') {
        process.stdin.pause();
      }
      const result = spawnSync(commandToRun, claudeArgs, {
        stdio: 'inherit',
        env: childEnv,
      });
      process.exit(result.status ?? 0);
      return;
    }

    // --auto-continue mode: re-launch with "continue" when Claude Code stops mid-task
    console.log('🔁 [nscc] Auto-continue mode enabled. Press Ctrl+C to stop.\n');

    let continueCount = 0;
    const MAX_CONTINUES = 50;

    // First run: normal interactive session
    if (process.stdin.isTTY && typeof process.stdin.pause === 'function') {
      process.stdin.pause();
    }
    let result = spawnSync(commandToRun, claudeArgs, {
      stdio: 'inherit',
      env: childEnv,
    });

    // Auto-continue loop: re-run with --print "continue" when Claude Code exits
    while (continueCount < MAX_CONTINUES) {
      // Small delay to avoid hammering the API
      await new Promise((resolve) => setTimeout(resolve, 2000));

      continueCount++;
      Logger.log(`🔁 [auto-continue] Re-launching (attempt ${continueCount}/${MAX_CONTINUES})`);
      console.log(`\n🔁 [nscc] Auto-continuing (${continueCount}/${MAX_CONTINUES})...\n`);

      // Re-launch with --print "continue" in non-interactive mode, then resume interactive
      // First inject "continue" silently
      const continueResult = spawnSync(commandToRun, ['--print', 'continue', '--output-format', 'text', ...claudeArgs.filter(a => !a.startsWith('-p') && a !== '--print')], {
        stdio: 'inherit',
        env: childEnv,
      });

      if (continueResult.status !== 0) {
        console.log('\n⚠️ [nscc] Auto-continue exited with error. Stopping.');
        break;
      }

      result = continueResult;
    }

    process.exit(result?.status ?? 0);
  });

// Status command
program
  .command('status')
  .description('Check nscc status, cux installation, and fallback endpoint configuration')
  .action(async () => {
    await UpdateNotifier.checkUpdate().catch(() => {});

    const config = ConfigManager.loadConfig();
    const cuxInstalled = CuxManager.isInstalled();
    const proxyRunning = await isProxyHealthy(config.proxy.port);

    console.log('\n📊 Never Stop Claude Code (nscc) Status');
    console.log('====================================');
    console.log(`Version:              v${UpdateNotifier.getLocalVersion()}`);
    console.log(`Proxy Server Running: ${proxyRunning ? '✅ Active (Port ' + config.proxy.port + ')' : '⏹️ Stopped (Auto-starts on nscc)'}`);
    console.log(`cux Tool Installed:   ${cuxInstalled ? '✅ Yes' : '❌ No (Install with: npm i -g @inulute/cux)'}`);
    console.log(`cux Auto-Rotate:     ${config.cux.autoRotateOnRateLimit ? '✅ Enabled' : '❌ Disabled'}`);
    console.log(`Force Fallback Mode:  ${config.fallback.forceFallback ? '🚨 Enabled (Direct Fallback)' : '⚡ Disabled (Auto on 429)'}`);
    console.log(`Fallback Provider:    ${config.fallback.provider.toUpperCase()}`);
    console.log(`Fallback Enabled:     ${config.fallback.enabled ? '✅ Yes' : '❌ No'}`);
    console.log(`Fallback Base URL:    ${config.fallback.baseUrl}`);
    console.log(`Fallback Model:       ${config.fallback.model}`);
    console.log(`Fallback API Key:     ${config.fallback.apiKey ? '******' + config.fallback.apiKey.slice(-4) : '❌ Not Set'}`);
    console.log(`Config File Path:     ${ConfigManager.getConfigPath()}`);
    console.log(`Proxy Log Path:       ${Logger.getLogPath()}\n`);
  });

// Config command
program
  .command('config')
  .description('Set fallback configuration options or apply provider presets')
  .option('-p, --preset <preset>', `Apply provider preset (${Object.keys(PROVIDER_PRESETS).join(', ')})`)
  .option('-f, --force-fallback <boolean>', 'Force direct fallback mode even if limit is not reached (true/false)')
  .option('-k, --api-key <key>', 'Set fallback API Key')
  .option('-u, --url <url>', 'Set fallback Base URL (e.g. http://localhost:20128/v1 for 9Router)')
  .option('-m, --model <model>', 'Set fallback model name (e.g. claude-3-5-sonnet or deepseek/deepseek-chat)')
  .option('--port <port>', 'Set local proxy port (default: 3456)')
  .option('-v, --verbose <boolean>', 'Enable or disable verbose inline logs (true/false)')
  .action((options) => {
    if (options.preset) {
      try {
        ConfigManager.applyPreset(options.preset);
        console.log(`✅ Applied preset '${options.preset}' successfully!`);
      } catch (err: any) {
        console.error(`❌ ${err.message}`);
        return;
      }
    }

    const updates: any = {};
    if (options.forceFallback !== undefined) {
      const isForce = options.forceFallback === 'true' || options.forceFallback === true;
      updates.fallback = { ...updates.fallback, forceFallback: isForce };
    }
    if (options.apiKey !== undefined) updates.fallback = { ...updates.fallback, apiKey: options.apiKey };
    if (options.url !== undefined) updates.fallback = { ...updates.fallback, baseUrl: options.url };
    if (options.model !== undefined) updates.fallback = { ...updates.fallback, model: options.model };
    if (options.port !== undefined) updates.proxy = { ...updates.proxy, port: parseInt(options.port, 10) };
    if (options.verbose !== undefined) updates.proxy = { ...updates.proxy, verbose: options.verbose === 'true' };

    if (Object.keys(updates).length > 0) {
      ConfigManager.saveConfig(updates);
    }

    const currentConfig = ConfigManager.loadConfig();
    console.log('✅ Configuration saved successfully to', ConfigManager.getConfigPath());
    console.log(JSON.stringify(currentConfig, null, 2));
  });

// Logs command
program
  .command('logs')
  .description('View live proxy logs')
  .option('-f, --follow', 'Follow log output in real-time')
  .action((options) => {
    const logPath = Logger.getLogPath();
    if (!fs.existsSync(logPath)) {
      console.log('📄 Log file does not exist yet. Run `nscc` first to generate logs.');
      return;
    }

    if (options.follow) {
      console.log(`📜 Following live logs from ${logPath} (Press Ctrl+C to exit):\n`);
      const child = spawn('tail', ['-f', logPath], { stdio: 'inherit' });
      process.on('SIGINT', () => {
        child.kill();
        process.exit(0);
      });
    } else {
      const content = fs.readFileSync(logPath, 'utf-8');
      console.log(content || '(Log file is empty)');
    }
  });

// Models command
program
  .command('models')
  .description('List available models from the configured fallback provider (e.g. 9Router / OpenRouter)')
  .option('-s, --set <model>', 'Set and save selected model')
  .action(async (options) => {
    const config = ConfigManager.loadConfig();
    const baseUrl = config.fallback.baseUrl.replace(/\/+$/, '');
    const apiKey = config.fallback.apiKey;

    if (options.set) {
      ConfigManager.saveConfig({ fallback: { ...config.fallback, model: options.set } });
      console.log(`\n✅ Fallback model set to: '${options.set}'`);
      console.log(`Saved to ${ConfigManager.getConfigPath()}\n`);
      return;
    }

    console.log(`\n🔍 Fetching available models from ${baseUrl}/models...\n`);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      const res = await fetch(`${baseUrl}/models`, { headers });
      if (!res.ok) {
        const text = await res.text();
        console.error(`❌ Failed to fetch models (HTTP ${res.status}): ${text}`);
        return;
      }

      const data: any = await res.json();
      const modelsList: any[] = data.data || data.models || (Array.isArray(data) ? data : []);

      if (modelsList.length === 0) {
        console.log('⚠️ No models returned by the provider.');
        return;
      }

      console.log(`📋 Available Models on ${config.fallback.provider.toUpperCase()} (${modelsList.length} total):\n`);
      console.log(`Current Active Model: 🌟 ${config.fallback.model}\n`);
      console.log('--------------------------------------------------------------------------------');
      
      modelsList.forEach((m: any) => {
        const id = m.id || m.name || m;
        const ownedBy = m.owned_by ? ` (by ${m.owned_by})` : '';
        const isCurrent = id === config.fallback.model ? '  👈 [ACTIVE]' : '';
        console.log(`  • ${id}${ownedBy}${isCurrent}`);
      });

      console.log('--------------------------------------------------------------------------------');
      console.log('\n💡 To select a model, run:');
      console.log(`   nscc config -m "<model_id>"   OR   nscc models --set "<model_id>"\n`);
    } catch (err: any) {
      console.error(`❌ Error querying ${baseUrl}/models: ${err.message}`);
    }
  });


// Proxy command (Standalone proxy server)
program
  .command('proxy')
  .description('Run proxy server standalone in background')
  .option('--port <port>', 'Port number')
  .action(async (options) => {
    const config = ConfigManager.loadConfig();
    const port = options.port ? parseInt(options.port, 10) : config.proxy.port;

    const server = new ProxyServer();
    await server.listen(port);
  });

program.parse(process.argv);

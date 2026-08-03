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
  .argument('[claudeArgs...]', 'Arguments passed directly to claude')
  .action(async (claudeArgs: string[], options: { fallback?: boolean; verbose?: boolean }) => {
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

    // Pause parent Node stdin to give child process 100% uninhibited TTY control
    if (process.stdin.isTTY && typeof process.stdin.pause === 'function') {
      process.stdin.pause();
    }

    const result = spawnSync(commandToRun, claudeArgs, {
      stdio: 'inherit',
      env: childEnv,
    });

    process.exit(result.status ?? 0);
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

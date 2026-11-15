#!/usr/bin/env node
import { Command } from 'commander';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { AccountManager } from '../accounts/manager.js';
import { ConfigManager, PROVIDER_PRESETS, normalizeOpenAIBaseUrl } from '../config/manager.js';
import { ProxyServer } from '../proxy/server.js';
import { Logger } from '../utils/logger.js';
import { UpdateNotifier } from '../utils/update.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

const program = new Command();

program
  .name('nscc')
  .description('Never Stop Claude Code - Auto-fallback proxy CLI for 9Router/OpenRouter/DeepSeek')
  .version('1.5.0');

function getExpectedProxyBuildMtime(): number {
  try {
    const serverJs = path.join(projectRoot, 'dist/proxy/server.js');
    return Math.floor(fs.statSync(serverJs).mtimeMs);
  } catch {
    return 0;
  }
}

async function isProxyHealthy(port: number, requireCurrentBuild = false): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(400) });
    if (!res.ok) return false;
    if (!requireCurrentBuild) return true;
    const data: any = await res.json().catch(() => null);
    const expected = getExpectedProxyBuildMtime();
    if (!expected) return true;
    return data?.buildMtime === expected;
  } catch {
    return false;
  }
}

async function ensureProxyRunning(port: number): Promise<void> {
  if (await isProxyHealthy(port, true)) {
    return;
  }

  const cliPath = path.join(projectRoot, 'dist/cli/index.js');
  const child = spawn(process.execPath, [cliPath, 'proxy', '--port', String(port)], {
    cwd: projectRoot,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Wait up to 3 seconds for proxy to start up (ProxyServer.listen kills stale EADDRINUSE listeners)
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (await isProxyHealthy(port, true)) {
      return;
    }
  }
}

export function ensureClaudeSlashCommands(): void {
  try {
    // 1. Remove legacy markdown prompt commands in ~/.claude/commands/ so they do not shadow
    //    our native type:"local" plugin commands (Claude Code refuses $.command.register if a
    //    user markdown command with the same name exists in ~/.claude/commands/).
    const commandsDir = path.join(os.homedir(), '.claude', 'commands');
    for (const legacyFile of ['proxy-model.md', 'proxy-account.md']) {
      const p = path.join(commandsDir, legacyFile);
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p);
        } catch {}
      }
    }

    // 2. Install/update the native Claude Code plugin at ~/.claude/skills/nscc/
    //    which registers /proxy-model and /proxy-account as true type:"local" commands
    //    (rendered in <local-command-stdout> with shouldQuery:false, never entering chat context).
    const skillPluginDir = path.join(os.homedir(), '.claude', 'skills', 'nscc');
    const manifestDir = path.join(skillPluginDir, '.claude-plugin');
    const hooksDir = path.join(skillPluginDir, 'hooks');

    fs.mkdirSync(manifestDir, { recursive: true });
    fs.mkdirSync(hooksDir, { recursive: true });

    const filesToWrite: Array<{ filePath: string; content: string }> = [
      {
        filePath: path.join(manifestDir, 'plugin.json'),
        content: JSON.stringify(
          {
            name: 'nscc',
            version: '1.5.0',
            description: 'Never Stop Claude Code local commands (/proxy-model, /proxy-account)',
            author: { name: 'nscc' },
            license: 'MIT',
          },
          null,
          2
        ) + '\n',
      },
      {
        filePath: path.join(hooksDir, 'hooks.json'),
        content: JSON.stringify({ modules: ['./register.js'] }, null, 2) + '\n',
      },
      {
        filePath: path.join(hooksDir, 'register.js'),
        content: [
          'export function register(on) {',
          '  on("session.start", async ($, e, next) => {',
          '    await $.command.register({',
          '      name: "proxy-model",',
          '      description: "List or switch the active nscc proxy fallback model for this session",',
          '      argumentHint: "[model_id_or_number]",',
          '      immediate: true,',
          '    });',
          '    await $.command.register({',
          '      name: "proxy-account",',
          '      description: "List or switch the active Claude account in nscc without exiting",',
          '      argumentHint: "[account_name_or_number]",',
          '      immediate: true,',
          '    });',
          '    return next(e);',
          '  });',
          '',
          '  on("command.run", { command: "proxy-model" }, async ($, e) => {',
          '    try {',
          '      const baseUrl = ((await $.env.get("ANTHROPIC_BASE_URL")) || "http://localhost:3456").replace(/\\/+$/, "");',
          '      const res = await $.http.fetch(baseUrl + "/nscc/command", {',
          '        method: "POST",',
          '        headers: { "Content-Type": "application/json" },',
          '        body: JSON.stringify({ command: "proxy-model", args: e.args }),',
          '      });',
          '      const data = JSON.parse(res.text);',
          '      return { text: data.text || data.error || "No response from nscc proxy." };',
          '    } catch (err) {',
          '      return { text: "Failed to contact nscc proxy: " + (err && err.message ? err.message : String(err)) };',
          '    }',
          '  });',
          '',
          '  on("command.run", { command: "proxy-account" }, async ($, e) => {',
          '    try {',
          '      const baseUrl = ((await $.env.get("ANTHROPIC_BASE_URL")) || "http://localhost:3456").replace(/\\/+$/, "");',
          '      const res = await $.http.fetch(baseUrl + "/nscc/command", {',
          '        method: "POST",',
          '        headers: { "Content-Type": "application/json" },',
          '        body: JSON.stringify({ command: "proxy-account", args: e.args }),',
          '      });',
          '      const data = JSON.parse(res.text);',
          '      return { text: data.text || data.error || "No response from nscc proxy." };',
          '    } catch (err) {',
          '      return { text: "Failed to contact nscc proxy: " + (err && err.message ? err.message : String(err)) };',
          '    }',
          '  });',
          '}',
          '',
        ].join('\n'),
      },
    ];

    for (const { filePath, content } of filesToWrite) {
      if (fs.existsSync(filePath)) {
        try {
          if (fs.readFileSync(filePath, 'utf-8') === content) continue;
        } catch {}
      }
      fs.writeFileSync(filePath, content, 'utf-8');
    }
  } catch {
    // Non-fatal if ~/.claude is not writable
  }
}

function resolveSessionModel(cliModel?: string): string | undefined {
  if (cliModel?.trim()) return cliModel.trim();
  if (process.env.NSCC_MODEL?.trim()) return process.env.NSCC_MODEL.trim();

  const localConfigPath = path.join(process.cwd(), '.nscc.json');
  if (fs.existsSync(localConfigPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(localConfigPath, 'utf-8'));
      const localModel = parsed?.model || parsed?.fallback?.model;
      if (typeof localModel === 'string' && localModel.trim()) {
        return localModel.trim();
      }
    } catch {
      // Ignore malformed project .nscc.json
    }
  }
  return undefined;
}

// Default action / run command
program
  .command('run', { isDefault: true })
  .description('Launch Claude Code with silent background proxy and auto-fallback')
  .allowUnknownOption()
  .option('-f, --fallback', 'Force using 9Router/fallback endpoint directly even if limit is not reached')
  .option('-v, --verbose', 'Show proxy status')
  .option('-c, --auto-continue', 'Automatically re-inject "continue" when Claude Code stops mid-task')
  .option('-m, --model <model>', 'Override fallback model for this session only (does not modify global config)')
  .argument('[claudeArgs...]', 'Arguments passed directly to claude')
  .action(async (claudeArgs: string[], options: { fallback?: boolean; verbose?: boolean; autoContinue?: boolean; model?: string }) => {
    // Non-blocking update check
    UpdateNotifier.checkUpdate().catch(() => {});

    const config = ConfigManager.loadConfig();
    const proxyPort = config.proxy.port;

    // Ensure background proxy is running silently
    await ensureProxyRunning(proxyPort);

    const commandToRun = 'claude';
    const sessionId = randomUUID().slice(0, 8);
    const sessionModel = resolveSessionModel(options.model);
    const isSessionForceFallback = Boolean(options.fallback || config.fallback.forceFallback);
    const forcePrefix = options.fallback ? '/f' : '';
    const modelPrefix = sessionModel ? `/m/${encodeURIComponent(sessionModel)}` : '';
    const proxyBaseUrl = `http://localhost:${proxyPort}/s/${sessionId}${forcePrefix}${modelPrefix}`;
    ensureClaudeSlashCommands();
    Logger.log(`nscc starting session ${sessionId} on port ${proxyPort} (forceFallback: ${isSessionForceFallback}, launcher: ${commandToRun}, sessionModel: ${sessionModel ?? 'default'})`);

    const childEnv = {
      ...process.env,
      ANTHROPIC_BASE_URL: proxyBaseUrl,
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
  .description('Check nscc status and fallback endpoint configuration')
  .action(async () => {
    await UpdateNotifier.checkUpdate().catch(() => {});

    const config = ConfigManager.loadConfig();
    const proxyRunning = await isProxyHealthy(config.proxy.port);

    console.log('\n📊 Never Stop Claude Code (nscc) Status');
    console.log('====================================');
    console.log(`Version:              v${UpdateNotifier.getLocalVersion()}`);
    console.log(`Proxy Server Running: ${proxyRunning ? '✅ Active (Port ' + config.proxy.port + ')' : '⏹️ Stopped (Auto-starts on nscc)'}`);
    const accountStore = AccountManager.loadStore();
    console.log(`Claude Account Pool:  ${accountStore.accounts.length > 0 ? `✅ ${accountStore.accounts.length} account(s) (active: ${accountStore.activeAccount ?? 'none'})` : 'ℹ️ None (using default Claude CLI login)'}`);
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
    const baseUrl = normalizeOpenAIBaseUrl(config.fallback.baseUrl);
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


// Account pool management command
const accountCmd = program
  .command('account')
  .description('Manage Claude account tokens for seamless mid-session auto-switching');

accountCmd
  .command('add <name>')
  .description('Add or update a Claude account token (via --token or interactive claude setup-token)')
  .option('-t, --token <token>', 'OAuth token (from `claude setup-token`) or Anthropic API key')
  .action(async (name: string, options: { token?: string }) => {
    let token = options.token?.trim() || '';
    if (!token) {
      console.log(`\n🔑 Generating long-lived token for "${name}" via \`claude setup-token\`...`);
      console.log('   Complete the browser login if prompted, then paste the generated token below.\n');
      spawnSync('claude', ['setup-token'], { stdio: 'inherit' });

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        token = (await rl.question(`Paste token for "${name}": `)).trim();
      } finally {
        rl.close();
      }
    }

    if (!token) {
      console.error('❌ No token provided. Aborted.');
      process.exitCode = 1;
      return;
    }

    const store = AccountManager.addAccount(name, token);
    console.log(`✅ Saved Claude account "${name}" (total: ${store.accounts.length}, active: ${store.activeAccount}).`);
    console.log(`   Stored securely (0600) at ${AccountManager.getStorePath()}`);
  });

accountCmd
  .command('list')
  .description('List registered Claude accounts in the auto-switch pool')
  .action(() => {
    const store = AccountManager.loadStore();
    if (store.accounts.length === 0) {
      console.log('\nℹ️ No Claude accounts registered yet.');
      console.log('   Add one with: nscc account add <name>\n');
      return;
    }

    const now = Date.now();
    console.log(`\n👤 Claude Account Pool (${store.accounts.length} total):\n`);
    for (const acc of store.accounts) {
      const masked = acc.token.length > 8 ? `...${acc.token.slice(-6)}` : '******';
      const active = acc.name === store.activeAccount ? ' 👈 [ACTIVE]' : '';
      const cooldown = acc.cooldownUntil && acc.cooldownUntil > now
        ? ` (cooldown ${Math.ceil((acc.cooldownUntil - now) / 1000)}s)`
        : '';
      console.log(`  • ${acc.name} (${masked})${active}${cooldown}`);
    }
    console.log('');
  });

accountCmd
  .command('use <name>')
  .description('Manually switch the active Claude account')
  .action((name: string) => {
    try {
      const acc = AccountManager.useAccount(name);
      console.log(`✅ Switched active Claude account to "${acc.name}".`);
    } catch (err: any) {
      console.error(`❌ ${err.message}`);
      process.exitCode = 1;
    }
  });

accountCmd
  .command('remove <name>')
  .description('Remove a Claude account from the pool')
  .action((name: string) => {
    const store = AccountManager.removeAccount(name);
    console.log(`✅ Removed "${name}" (remaining: ${store.accounts.length}, active: ${store.activeAccount ?? 'none'}).`);
  });

// Proxy command (Standalone proxy server)
program
  .command('proxy')
  .description('Run proxy server standalone in background')
  .option('--port <port>', 'Port number')
  .action(async (options) => {
    ensureClaudeSlashCommands();
    const config = ConfigManager.loadConfig();
    const port = options.port ? parseInt(options.port, 10) : config.proxy.port;

    const server = new ProxyServer();
    await server.listen(port);
  });

program.parse(process.argv);

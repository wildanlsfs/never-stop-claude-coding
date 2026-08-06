import { exec, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import { Logger } from '../utils/logger.js';

const execAsync = promisify(exec);

export class CuxManager {
  public static isInstalled(): boolean {
    try {
      execSync('which cux', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Ask cux to swap to the next available account in its pool.
   *
   * `cux next` is NOT a real cux subcommand (verified against `cux --help`).
   * cux's wrapper silently reinterprets any unrecognized subcommand as
   * arguments to pass straight through to the real `claude` binary — so the
   * previous `execSync('cux next', ...)` call was actually launching a stray,
   * full nested Claude Code process with "next" as its prompt on every single
   * rate limit, doing nothing to rotate accounts. Worse, because it ran via
   * execSync, it froze this entire proxy's event loop — no other request
   * could be served at all — for however long that stray process took to
   * exit (observed: 10-48+ seconds, presumably stuck without a usable TTY
   * since the proxy runs detached).
   *
   * The real command is `cux force-switch [slot|email|alias]` — "emergency
   * swap for an active cux session when Claude will not run /switch" — which
   * is exactly this automated use case. Run it asynchronously (never
   * execSync) so it can't block the event loop, with a hard timeout so a
   * misbehaving cux invocation can't hang other requests indefinitely.
   *
   * Note: rotation can only ever help if more than one account is actually
   * registered with cux (`cux add` from each account). With a single-account
   * pool this will correctly report success/no-op but the retry will hit the
   * same rate limit again — that's expected, not a bug.
   */
  public static async rotate(): Promise<boolean> {
    if (!this.isInstalled()) {
      return false;
    }

    try {
      const { stdout, stderr } = await execAsync('cux force-switch', { timeout: 15000 });
      if (stdout?.trim()) Logger.log(`[cux force-switch] ${stdout.trim()}`);
      if (stderr?.trim()) Logger.log(`[cux force-switch:stderr] ${stderr.trim()}`);
      return true;
    } catch (err: any) {
      Logger.log(`⚠️ [cux force-switch] failed: ${err.message}`);
      return false;
    }
  }

  public static getCommand(): string {
    return this.isInstalled() ? 'cux' : 'claude';
  }
}

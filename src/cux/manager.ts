import { execSync } from 'node:child_process';

export class CuxManager {
  public static isInstalled(): boolean {
    try {
      execSync('which cux', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  public static rotate(): boolean {
    if (!this.isInstalled()) {
      return false;
    }

    try {
      console.log('🔄 [nscc] Rate limit detected! Triggering cux account rotation...');
      execSync('cux next', { stdio: 'inherit' });
      return true;
    } catch (err) {
      try {
        execSync('cux switch', { stdio: 'inherit' });
        return true;
      } catch {
        console.warn('⚠️ [nscc] cux rotation failed or no remaining accounts in pool.');
        return false;
      }
    }
  }

  public static getCommand(): string {
    return this.isInstalled() ? 'cux' : 'claude';
  }
}

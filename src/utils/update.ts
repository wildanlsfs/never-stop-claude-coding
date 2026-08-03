import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface UpdateCache {
  lastChecked: number;
  latestVersion: string;
}

export class UpdateNotifier {
  private static getCachePath(): string {
    return path.join(os.homedir(), '.nscc', 'update_cache.json');
  }

  public static getLocalVersion(): string {
    try {
      const pkgPath = path.resolve(__dirname, '../../package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        return pkg.version || '1.0.0';
      }
    } catch {}
    return '1.0.0';
  }

  public static async checkUpdate(): Promise<void> {
    const localVersion = this.getLocalVersion();
    const cachePath = this.getCachePath();
    const now = Date.now();
    const TWELVE_HOURS = 12 * 60 * 60 * 1000;

    let latestVersion = localVersion;

    try {
      if (fs.existsSync(cachePath)) {
        const cache: UpdateCache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
        if (now - cache.lastChecked < TWELVE_HOURS) {
          latestVersion = cache.latestVersion;
        } else {
          latestVersion = await this.fetchLatestVersion();
          this.saveCache({ lastChecked: now, latestVersion });
        }
      } else {
        latestVersion = await this.fetchLatestVersion();
        this.saveCache({ lastChecked: now, latestVersion });
      }
    } catch {
      latestVersion = localVersion;
    }

    if (this.isNewer(latestVersion, localVersion)) {
      this.printUpdateBanner(localVersion, latestVersion);
    }
  }

  private static async fetchLatestVersion(): Promise<string> {
    try {
      const res = await fetch('https://raw.githubusercontent.com/wildanlsfs/never-stop-claude-coding/main/package.json', {
        headers: { 'User-Agent': 'nscc-cli' },
      });
      if (res.ok) {
        const data: any = await res.json();
        return data.version || '1.0.0';
      }
    } catch {}
    return '1.0.0';
  }

  private static isNewer(latest: string, current: string): boolean {
    const lParts = latest.split('.').map(Number);
    const cParts = current.split('.').map(Number);

    for (let i = 0; i < Math.max(lParts.length, cParts.length); i++) {
      const l = lParts[i] || 0;
      const c = cParts[i] || 0;
      if (l > c) return true;
      if (l < c) return false;
    }
    return false;
  }

  private static saveCache(cache: UpdateCache): void {
    try {
      const dir = path.dirname(this.getCachePath());
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.getCachePath(), JSON.stringify(cache, null, 2), 'utf-8');
    } catch {}
  }

  private static printUpdateBanner(current: string, latest: string): void {
    console.log('\n┌─────────────────────────────────────────────────────────────┐');
    console.log(`│   🔔 Update available for nscc: v${current} ➔ v${latest}               │`);
    console.log('│   Run: git pull && npm run build && npm link                │');
    console.log('│   or:  npm install -g nscc                                   │');
    console.log('└─────────────────────────────────────────────────────────────┘\n');
  }
}

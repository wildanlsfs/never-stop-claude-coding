import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';

export class Logger {
  private static getLogDir(): string {
    return path.join(os.homedir(), '.nscc');
  }

  public static getLogPath(): string {
    return path.join(this.getLogDir(), 'proxy.log');
  }

  public static log(message: string, isVerbose: boolean = false) {
    const logDir = this.getLogDir();
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const timestamp = new Date().toISOString();
    const formatted = `[${timestamp}] ${message}\n`;

    fs.appendFileSync(this.getLogPath(), formatted, 'utf-8');

    if (isVerbose) {
      process.stderr.write(`[nscc] ${message}\n`);
    }
  }

  public static notify(title: string, message: string) {
    // Native macOS Notification via osascript
    if (process.platform === 'darwin') {
      const sanitizedTitle = title.replace(/"/g, '\\"');
      const sanitizedMsg = message.replace(/"/g, '\\"');
      const script = `display notification "${sanitizedMsg}" with title "${sanitizedTitle}" sound name "Glass"`;
      exec(`osascript -e '${script}'`, () => {});
    }
  }
}

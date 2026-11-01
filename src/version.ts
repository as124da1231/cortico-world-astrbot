/** 扩展版本：直接读包根的 package.json，避免在代码里再手写一份。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function readVersion(): string {
  try {
    const path = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '';
  } catch {
    return '';
  }
}

export const EXTENSION_VERSION = readVersion();

import * as fs from 'fs';
import * as path from 'path';

let fileEnvCache: Record<string, string> | null = null;

export function getEnv(name: string): string | undefined {
  const processValue = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  const metaValue = (import.meta as any).env?.[name];
  const fileValue = getFileEnv()[name];
  const value = processValue || metaValue || fileValue;

  return typeof value === 'string' && value.trim() ? value : undefined;
}

function getFileEnv(): Record<string, string> {
  if (fileEnvCache) {
    return fileEnvCache;
  }

  fileEnvCache = {};

  try {
    const envPath = path.join(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) {
      return fileEnvCache;
    }

    const envFile = fs.readFileSync(envPath, 'utf8');
    for (const line of envFile.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      let value = trimmed.slice(separatorIndex + 1).trim();

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      fileEnvCache[key] = value;
    }
  } catch (err) {
    console.warn('[Env] Failed to read .env file:', err);
  }

  return fileEnvCache;
}

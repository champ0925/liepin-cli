/**
 * 将百度 OCR 凭证写入用户级 ~/.liepin-cli/.env。
 * 使用 LIEPIN_BAIDU_*，避免与项目内通用 API_KEY 混淆。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_DATA_DIR } from '../config.js';

export const BAIDU_ENV_KEYS = {
  apiKey: 'LIEPIN_BAIDU_API_KEY',
  secretKey: 'LIEPIN_BAIDU_SECRET_KEY',
} as const;

const USER_ENV_PATH = join(APP_DATA_DIR, '.env');

function formatEnvLine(key: string, value: string): string {
  if (/^[A-Za-z0-9_.\-]+$/.test(value)) {
    return `${key}=${value}`;
  }
  return `${key}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

function mergeUserEnv(updates: Record<string, string>): void {
  if (!existsSync(APP_DATA_DIR)) {
    mkdirSync(APP_DATA_DIR, { recursive: true });
  }
  const dropKeys = new Set(Object.keys(updates));
  let lines: string[] = [];
  if (existsSync(USER_ENV_PATH)) {
    lines = readFileSync(USER_ENV_PATH, 'utf8').split(/\r?\n/);
  }
  const kept = lines.filter((line) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    return !(m && dropKeys.has(m[1]!));
  });
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
  const out = kept.length > 0 ? [...kept, ''] : [];
  for (const [k, v] of Object.entries(updates)) {
    out.push(formatEnvLine(k, v));
  }
  out.push('');
  writeFileSync(USER_ENV_PATH, out.join('\n'), 'utf8');
}

export function getUserEnvPathForBaidu(): string {
  return USER_ENV_PATH;
}

export function writeBaiduCredentialsToUserEnv(apiKey: string, secretKey: string): void {
  mergeUserEnv({
    [BAIDU_ENV_KEYS.apiKey]: apiKey,
    [BAIDU_ENV_KEYS.secretKey]: secretKey,
  });
}

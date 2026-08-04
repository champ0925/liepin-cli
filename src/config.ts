/**
 * 猎聘 CLI 配置管理
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function resolveChromePath(): string {
  if (process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || '';
  }

  const programFiles = process.env['PROGRAMFILES'] || 'C:\\Program Files';
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env['LOCALAPPDATA'] || join(homedir(), 'AppData', 'Local');

  const candidates = process.platform === 'win32'
    ? [
        join(programFiles, 'Google\\Chrome\\Application\\chrome.exe'),
        join(programFilesX86, 'Google\\Chrome\\Application\\chrome.exe'),
        join(localAppData, 'Google\\Chrome\\Application\\chrome.exe'),
        join(programFiles, 'Microsoft\\Edge\\Application\\msedge.exe'),
        join(programFilesX86, 'Microsoft\\Edge\\Application\\msedge.exe'),
      ]
    : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/usr/bin/microsoft-edge',
        ];

  return candidates.find(path => existsSync(path)) || '';
}

/** 默认配置 */
export const DEFAULT_CONFIG = {
  /** Chrome/Edge 可执行文件路径 */
  chromePath: resolveChromePath(),
  
  /** 用户数据目录 */
  userDataDir: process.env.LIEPIN_USER_DATA_DIR || join(homedir(), '.liepin-cli', 'user-data'),

  /** 截图目录 */
  screenshotDir: process.env.LIEPIN_SCREENSHOT_DIR || join(homedir(), '.liepin-cli', 'screenshots'),

  /** 配置文件路径 */
  configDir: process.env.LIEPIN_CONFIG_DIR || join(homedir(), '.liepin-cli'),
  
  /** 浏览器视口 */
  viewport: {
    width: 1280,
    height: 800,
  },
  
  /** 是否无头模式 */
  headless: process.env.LIEPIN_HEADLESS === 'true',
  
  /** 是否使用代理 */
  proxy: process.env.LIEPIN_PROXY || '',
  
  /** 调试模式 */
  debug: process.env.LIEPIN_DEBUG === 'true',
};

/** 加载配置文件 */
function loadConfigFile(): Record<string, any> {
  const configPath = join(DEFAULT_CONFIG.configDir, 'config.json');
  if (existsSync(configPath)) {
    try {
      return JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      return {};
    }
  }
  return {};
}

/** 合并配置 */
export function getConfig() {
  const fileConfig = loadConfigFile();
  return { ...DEFAULT_CONFIG, ...fileConfig };
}

/** 配置实例 */
export const config = getConfig();

/** 应用数据根目录（登录态、锁、缓存统一放这里） */
export const APP_DATA_DIR = config.configDir;

/** 缓存目录（session.lock 等运行时状态） */
export const CACHE_DIR = join(APP_DATA_DIR, '.cache');

/** 浏览器用户数据目录（登录态由 Chrome Profile 持久化） */
export const BROWSER_USER_DATA_DIR = config.userDataDir;

/** 确保应用数据目录结构存在 */
export function ensureAppDataLayout(): void {
  for (const dir of [APP_DATA_DIR, CACHE_DIR, BROWSER_USER_DATA_DIR]) {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    } catch {
      /* 目录创建失败不致命，后续用到时再报错 */
    }
  }
}

/** 当天日期目录名，如 2026-08-04；可用 LIEPIN_RESUME_DATE_DIR 覆盖（测试用） */
function resumeDateDir(): string {
  return process.env.LIEPIN_RESUME_DATE_DIR?.trim() || new Date().toISOString().slice(0, 10);
}

/**
 * 简历输出根目录（resumes/）的父目录。
 * 从 CLI 安装位置反推工作区根：dist/config.js → 上两级是 liepin-cli/ → 再上一级是 AI-Hiring/。
 * 这样无论在哪跑命令，文件都统一落到 AI-Hiring/resumes/（跟 boss-cli 输出同级）。
 * 反推失败（目录结构不符）时回退 process.cwd()。
 */
function workspaceRoot(): string {
  try {
    // dist/config.js → liepin-cli/ → AI-Hiring/
    const pkgRoot = join(__dirname, '..');
    const parent = dirname(pkgRoot);
    // 校验：pkgRoot 应该是 liepin-cli/（含 package.json）
    if (existsSync(join(pkgRoot, 'package.json'))) {
      return parent;
    }
  } catch { /* ignore */ }
  return process.cwd();
}

const RESUME_ROOT = join(workspaceRoot(), 'resumes', resumeDateDir());

/**
 * `preview` 抓取在线简历截图保存目录。
 * 优先环境变量 `LIEPIN_RESUME_SCREENSHOTS_DIR`（绝对路径，不再追加日期），
 * 默认存工作区根 `resumes/<日期>/screenshots/`。
 */
export const RESUME_SCREENSHOTS_DIR =
  process.env.LIEPIN_RESUME_SCREENSHOTS_DIR?.trim() ||
  join(RESUME_ROOT, 'screenshots');

/**
 * 简历截图 OCR 文本保存目录（与截图同名 .txt）。
 * 优先 `LIEPIN_RESUME_OCR_DIR`，默认 `resumes/<日期>/ocr/`。
 */
export const RESUME_OCR_DIR =
  process.env.LIEPIN_RESUME_OCR_DIR?.trim() ||
  join(RESUME_ROOT, 'ocr');

/**
 * 附件简历下载保存目录（候选人上传的 PDF/DOCX）。
 * 优先 `LIEPIN_RESUME_ATTACHMENTS_DIR`，默认 `resumes/<日期>/attachments/`。
 */
export const RESUME_ATTACHMENTS_DIR =
  process.env.LIEPIN_RESUME_ATTACHMENTS_DIR?.trim() ||
  join(RESUME_ROOT, 'attachments');

/**
 * 简历结构化 JSON 保存目录（resume 命令返回的完整数据）。
 * 优先 `LIEPIN_RESUME_JSON_DIR`，默认 `resumes/<日期>/json/`。
 */
export const RESUME_JSON_DIR =
  process.env.LIEPIN_RESUME_JSON_DIR?.trim() ||
  join(RESUME_ROOT, 'json');

/** 确保简历输出目录存在 */
export function ensureResumeDirs(): void {
  for (const dir of [RESUME_SCREENSHOTS_DIR, RESUME_OCR_DIR, RESUME_ATTACHMENTS_DIR, RESUME_JSON_DIR]) {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
  }
}

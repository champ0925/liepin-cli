/**
 * CDP 浏览器实现
 * 基于 Puppeteer-core 和 Chrome DevTools Protocol
 *
 * 与旧版差异：不使用 puppeteer.launch()（Node 退出时会杀掉 Chrome），
 * 改为固定调试端口 + spawn + connect，实现跨命令复用同一只浏览器。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import readline from 'node:readline';
import puppeteer, { type Browser, type CDPSession, type Page } from 'puppeteer-core';
import { config } from '../config.js';

const CDP_WEBSOCKET_ENDPOINT_REGEX = /^DevTools listening on (ws:\/\/.*)$/;
const LAUNCH_READY_MS = 30_000;

/**
 * 固定的远程调试端口：liepin-cli 使用独立的 user-data-dir，可稳定占用一个端口，
 * 让多条命令通过 http://127.0.0.1:<port>/json/version 复用同一只浏览器。
 * 可用 LIEPIN_BROWSER_REMOTE_DEBUGGING_PORT 覆盖。默认 53471（避开 boss-cli 的 53470）。
 */
export const REMOTE_DEBUGGING_PORT: number = (() => {
  const raw = process.env.LIEPIN_BROWSER_REMOTE_DEBUGGING_PORT?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0 && n <= 65535) return n;
  }
  return 53471;
})();

let spawnedChromeChild: ChildProcess | null = null;

export function clearSpawnedChromeProcessRef(): void {
  spawnedChromeChild = null;
}

/** 探测固定调试端口上是否已有在跑的 Chrome，命中即可复用。 */
async function probeRemoteDebuggingWsEndpoint(
  port: number,
  timeoutMs: number,
): Promise<string | undefined> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: ctrl.signal,
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { webSocketDebuggerUrl?: string };
    const ws = data.webSocketDebuggerUrl;
    return typeof ws === 'string' && ws.length > 0 ? ws : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function waitForDevToolsWebSocketUrl(
  proc: ChildProcess,
  userDataDir: string,
  timeoutMs: number,
): Promise<string> {
  const streams = [proc.stdout, proc.stderr].filter((s): s is NonNullable<typeof s> => s != null);
  if (streams.length === 0) {
    return Promise.reject(new Error('浏览器子进程无 stdout/stderr，无法获取 CDP 地址'));
  }

  return new Promise((resolve, reject) => {
    const rls: readline.Interface[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      for (const rl of rls) {
        try {
          rl.close();
        } catch {
          /* ignore */
        }
      }
      rls.length = 0;
    };

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      proc.off('exit', onExit);
      proc.off('error', onProcError);
      cleanup();
      fn();
    };

    timer = setTimeout(() => {
      finish(() => {
        reject(new Error(`等待 Chrome 输出 DevTools 地址超时（${timeoutMs}ms）`));
      });
    }, timeoutMs);

    const onExit = (code: number | null) => {
      finish(() => {
        reject(
          new Error(
            code === 0
              ? `浏览器进程立即以代码 0 退出：user-data-dir「${userDataDir}」可能正被另一只「无远程调试端口」的 Chrome 持有。请关闭占用该目录的 Chrome 窗口后重试。`
              : `浏览器进程在就绪前退出（代码 ${code ?? 'unknown'}）`,
          ),
        );
      });
    };

    const onProcError = (err: Error) => {
      finish(() => {
        reject(err);
      });
    };

    const onLine = (line: string) => {
      const m = line.trim().match(CDP_WEBSOCKET_ENDPOINT_REGEX);
      if (m?.[1]) {
        finish(() => {
          resolve(m[1]);
        });
      }
    };

    proc.once('exit', onExit);
    proc.once('error', onProcError);

    for (const s of streams) {
      const rl = readline.createInterface(s);
      rls.push(rl);
      rl.on('line', onLine);
    }
  });
}

/** 减轻「正受到自动测试软件的控制」提示与常见自动化特征。 */
export const LAUNCH_ARGS_LESS_AUTOMATION = ['--disable-infobars'] as const;

export type ConnectBrowserOptions = {
  headless?: boolean;
  proxy?: string;
  userDataDir?: string;
  chromePath?: string;
};

/**
 * 启动本机浏览器（puppeteer-core 底层为 CDP）。
 * 优先直连固定调试端口上的已有实例，未命中再 spawn 新 Chrome。
 * 不使用 puppeteer.launch()：其底层会在 Node 进程 exit 时 kill 浏览器，
 * 导致 CLI 退出时窗口被关掉。改为 spawn + connect，退出时只断 CDP，浏览器保留。
 */
export async function connectBrowser(options: ConnectBrowserOptions = {}): Promise<Browser> {
  const executablePath =
    options.chromePath?.trim() ||
    process.env.CHROME_PATH?.trim() ||
    process.env.PUPPETEER_EXECUTABLE_PATH?.trim() ||
    config.chromePath;

  if (!executablePath) {
    throw new Error(
      '未找到本机 Chrome/Edge：请设置 CHROME_PATH / PUPPETEER_EXECUTABLE_PATH（可执行文件路径）。',
    );
  }

  const userDataDir = options.userDataDir?.trim() || config.userDataDir;
  const headless = options.headless ?? config.headless;
  const proxy = options.proxy ?? config.proxy;

  clearSpawnedChromeProcessRef();

  // 优先复用固定调试端口上的已有实例
  const existingWsUrl = await probeRemoteDebuggingWsEndpoint(REMOTE_DEBUGGING_PORT, 800);
  if (existingWsUrl) {
    return await puppeteer.connect({
      browserWSEndpoint: existingWsUrl,
      defaultViewport: null,
    });
  }

  const userArgs = [
    ...LAUNCH_ARGS_LESS_AUTOMATION,
    `--window-size=${config.viewport.width},${config.viewport.height}`,
    ...(proxy ? [`--proxy-server=${proxy}`] : []),
  ];

  let chromeArgs = puppeteer
    .defaultArgs({
      browser: 'chrome',
      userDataDir,
      headless,
      args: userArgs,
    })
    .filter((a) => a !== '--enable-automation' && a !== 'about:blank' && a !== 'data:,');

  if (!chromeArgs.some((a) => a.startsWith('--remote-debugging-'))) {
    chromeArgs.push(`--remote-debugging-port=${REMOTE_DEBUGGING_PORT}`);
  }

  const proc = spawn(executablePath, chromeArgs, {
    detached: true,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  spawnedChromeChild = proc;

  let wsUrl: string;
  try {
    wsUrl = await waitForDevToolsWebSocketUrl(proc, userDataDir, LAUNCH_READY_MS);
  } catch (e) {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    clearSpawnedChromeProcessRef();
    throw e;
  }

  try {
    proc.stdout?.resume();
    proc.stderr?.resume();
  } catch {
    /* ignore */
  }
  if (proc.exitCode === null && proc.signalCode === null) {
    try {
      proc.unref();
    } catch {
      /* ignore */
    }
  } else {
    clearSpawnedChromeProcessRef();
  }

  try {
    return await puppeteer.connect({
      browserWSEndpoint: wsUrl,
      defaultViewport: null,
    });
  } catch (e) {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    clearSpawnedChromeProcessRef();
    throw e;
  }
}

/** 对某一页创建原生 CDP Session（需要低层域如 Network.* / Fetch.* 时使用）。 */
export async function createPageCDPSession(page: Page): Promise<CDPSession> {
  return page.createCDPSession();
}

/** 保留旧类名兼容，但内部改走 connectBrowser 复用模式。 */
export class CdpBrowser {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private options: ConnectBrowserOptions;

  constructor(options: ConnectBrowserOptions = {}) {
    this.options = options;
  }

  async launch(): Promise<Page> {
    if (this.browser?.connected && this.page && !this.page.isClosed()) {
      return this.page;
    }
    this.browser = await connectBrowser(this.options);
    const pages = (await this.browser.pages()).filter((p) => !p.isClosed());
    this.page = pages.length > 0 ? pages[0]! : await this.browser.newPage();
    return this.page;
  }

  async getPage(): Promise<Page> {
    if (!this.page || this.page.isClosed()) {
      return this.launch();
    }
    return this.page;
  }

  async navigate(
    url: string,
    options?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2' },
  ): Promise<void> {
    const page = await this.getPage();
    await page.goto(url, { waitUntil: options?.waitUntil || 'networkidle2' });
  }

  /** 仅断开 CDP，不关浏览器窗口（跨命令复用的关键）。 */
  async close(): Promise<void> {
    if (this.browser) {
      try {
        this.browser.disconnect();
      } catch {
        /* ignore */
      }
      this.browser = null;
      this.page = null;
    }
  }

  isConnected(): boolean {
    return this.browser?.connected ?? false;
  }

  getBrowser(): Browser | null {
    return this.browser?.connected ? this.browser : null;
  }
}

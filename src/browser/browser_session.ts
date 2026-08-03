import type { ChildProcess } from 'node:child_process';
import type { Browser, Page } from 'puppeteer-core';
import { clearSpawnedChromeProcessRef, connectBrowser } from './cdp_browser.js';
import {
  installLiepinBrowserPageGuards,
  installLiepinPageGuards,
} from '../common/liepin_page_guards.js';

let browserRef: Browser | null = null;
let pageRef: Page | null = null;
let connectPromise: Promise<void> | null = null;

function attachDisconnectedHandler(b: Browser): void {
  b.once('disconnected', () => {
    if (browserRef === b) {
      browserRef = null;
      pageRef = null;
      console.error(
        '[liepin-cli] 与浏览器断开连接（窗口关闭或进程退出）；下次使用工具时会自动重连。',
      );
    }
  });
}

/** 选一个「主」标签：优先 liepin.com 页，其次非空白页，避免把 about:blank 当主页。 */
async function pickOrCreatePage(b: Browser): Promise<Page> {
  const pages = (await b.pages()).filter((p) => !p.isClosed());
  if (pages.length === 0) {
    return b.newPage();
  }

  const urls = await Promise.all(
    pages.map((p) => {
      try {
        return p.url();
      } catch {
        return '';
      }
    }),
  );

  const liepin = pages.find((p, i) => {
    const u = urls[i] ?? '';
    return u.length > 0 && u !== 'about:blank' && u.includes('liepin.com');
  });
  if (liepin) return liepin;

  const nonBlank = pages.find((p, i) => {
    const u = urls[i] ?? '';
    return u.length > 0 && u !== 'about:blank';
  });
  if (nonBlank) return nonBlank;

  return pages[0]!;
}

async function closeRedundantBlankPages(b: Browser, keep: Page | null): Promise<void> {
  const pages = (await b.pages()).filter((p) => !p.isClosed());
  if (pages.length <= 1) return;

  const urls = await Promise.all(
    pages.map((p) => {
      try {
        return p.url();
      } catch {
        return '';
      }
    }),
  );

  const blankPages = pages.filter((_, i) => {
    const u = urls[i] ?? '';
    return u === '' || u === 'about:blank';
  });
  if (blankPages.length === 0) return;

  const hasNonBlank = pages.some((_, i) => {
    const u = urls[i] ?? '';
    return u !== '' && u !== 'about:blank';
  });

  for (const p of blankPages) {
    if (p === keep) continue;
    if (!hasNonBlank && p === blankPages[0]) continue;
    try {
      await p.close({ runBeforeUnload: false });
    } catch {
      /* ignore */
    }
  }
}

function isSessionHealthy(): boolean {
  return !!(browserRef?.connected && pageRef && !pageRef.isClosed());
}

async function establishSession(): Promise<void> {
  const prev = browserRef;
  if (prev) {
    try {
      prev.removeAllListeners('disconnected');
      await prev.close();
    } catch {
      /* 已断开时忽略 */
    }
    browserRef = null;
    pageRef = null;
  }

  const b = await connectBrowser();
  browserRef = b;
  attachDisconnectedHandler(b);
  await installLiepinBrowserPageGuards(b);
  pageRef = await pickOrCreatePage(b);
  await installLiepinPageGuards(pageRef);
  await closeRedundantBlankPages(b, pageRef);
}

export async function ensureAndGetBrowser(): Promise<Browser | null> {
  await ensureBrowserSession();
  return getBrowserRef();
}

export async function ensureBrowserSession(): Promise<void> {
  if (browserRef?.connected) {
    await installLiepinBrowserPageGuards(browserRef);
    if (pageRef && !pageRef.isClosed()) {
      try {
        const u = pageRef.url();
        if (u === 'about:blank' || u === '') {
          const preferred = await pickOrCreatePage(browserRef);
          if (preferred !== pageRef && !(preferred.url() === 'about:blank')) {
            pageRef = preferred;
          }
        }
        await closeRedundantBlankPages(browserRef, pageRef);
      } catch {
        /* ignore */
      }
      await installLiepinPageGuards(pageRef);
      return;
    }
    pageRef = await pickOrCreatePage(browserRef);
    await installLiepinPageGuards(pageRef);
    await closeRedundantBlankPages(browserRef, pageRef);
    return;
  }

  if (connectPromise) {
    await connectPromise;
    return;
  }

  connectPromise = (async () => {
    if (isSessionHealthy()) return;
    await establishSession();
  })();

  try {
    await connectPromise;
  } finally {
    connectPromise = null;
  }
}

export function getBrowserRef(): Browser | null {
  return browserRef?.connected ? browserRef : null;
}

export function getPageRef(): Page | null {
  if (!pageRef || pageRef.isClosed()) return null;
  if (!browserRef?.connected) return null;
  return pageRef;
}

/** 将当前会话主操作页设为 page，供其它工具复用。 */
export function setSessionPage(page: Page): void {
  if (!browserRef?.connected) return;
  try {
    if (page.browser() !== browserRef) return;
  } catch {
    return;
  }
  if (page.isClosed()) return;
  pageRef = page;
}

function unrefBrowserChildProcess(proc: ChildProcess | null | undefined): void {
  if (!proc) return;
  try {
    proc.unref();
  } catch {
    /* ignore */
  }
}

/**
 * 仅断开 CDP 连接，不关闭浏览器进程。
 * 用于命令结束后保留浏览器窗口供下一条命令复用，以及 login 后留给用户继续操作。
 * 绝不调用 browser.close()。
 */
export async function detachBrowserSession(): Promise<void> {
  const b = browserRef;
  if (!b) return;
  let proc: ChildProcess | null | undefined;
  try {
    proc = typeof b.process === 'function' ? b.process() : undefined;
  } catch {
    proc = undefined;
  }
  try {
    b.removeAllListeners('disconnected');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyB = b as any;
    if (typeof anyB.disconnect === 'function') {
      await Promise.resolve(anyB.disconnect());
    }
  } catch {
    /* 仅断开失败时依赖 unref 与进程退出行为 */
  }
  unrefBrowserChildProcess(proc ?? null);
  clearSpawnedChromeProcessRef();
  browserRef = null;
  pageRef = null;
}

/** 进程退出时断开 CDP（同 detach，语义上用于 cleanup）。 */
export async function disconnectBrowserSession(): Promise<void> {
  await detachBrowserSession();
}

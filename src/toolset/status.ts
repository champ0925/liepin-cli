/**
 * 主动检查猎聘登录态，输出结构化结果（供 Agent 健康检查）。
 * 与其它命令不同：登录失效时不抛错，而是返回 { ok:false, needLogin:true }。
 */
import { existsSync, statSync } from 'node:fs';
import { BROWSER_USER_DATA_DIR } from '../config.js';
import { probeLoggedInFromPage, LIEPIN_LPT_HOME, isLiepinSiteUrl } from '../common/auth.js';
import {
  ensureBrowserSession,
  getPageRef,
  detachBrowserSession,
} from '../browser/browser_session.js';

export type LiepinLoginStatus = {
  ok: boolean;           // CLI 调用本身是否成功（不代表已登录）
  needLogin: boolean;    // 是否需要人工重新登录
  loggedIn: boolean;     // 当前登录态是否有效
  account: string;       // 检测到的账号昵称（未登录为空）
  userDataDir: string;   // 登录态存储目录
  userDataDirExists: boolean;
  lastLoginAt: string;   // 用户数据目录最后修改时间（近似最后登录时间）
  currentUrl: string;    // 当前页面 URL
  checkedAt: string;     // 检查时间 ISO
  error?: string;        // 检查过程中的异常（如浏览器未启动）
};

export async function runCheckLoginStatus(): Promise<LiepinLoginStatus> {
  const checkedAt = new Date().toISOString();
  const dirExists = existsSync(BROWSER_USER_DATA_DIR);
  const lastLoginAt = dirExists ? statSync(BROWSER_USER_DATA_DIR).mtime.toISOString() : '';

  const base: LiepinLoginStatus = {
    ok: true,
    needLogin: false,
    loggedIn: false,
    account: '',
    userDataDir: BROWSER_USER_DATA_DIR,
    userDataDirExists: dirExists,
    lastLoginAt,
    currentUrl: '',
    checkedAt,
  };

  try {
    await ensureBrowserSession();
    const page = getPageRef();
    if (!page) {
      return { ...base, ok: false, needLogin: true, error: '无法获取浏览器页面' };
    }

    // 登录态要在猎聘页面上才能通过 DOM 探测到；当前若是新标签页/非猎聘页，先导航过去
    if (!isLiepinSiteUrl(page.url())) {
      await page.goto(LIEPIN_LPT_HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    }

    const url = page.url();
    const { loggedIn } = await probeLoggedInFromPage(page);
    const account = loggedIn
      ? ((await page
          .evaluate(`(() => {
            // 优先用稳定 id：#bpc-layout-nav-user-info 内 strong 的 title/textContent 即昵称
            const navUser = document.querySelector("#bpc-layout-nav-user-info strong");
            const navText = (navUser && (navUser.getAttribute("title") || navUser.textContent) || "").trim();
            if (navText && navText.length >= 2 && navText.length <= 64 && !/登录|注册/.test(navText)) return navText;
            // 兜底：常见昵称选择器
            const sels = [".user-name", ".recruiter-name", "[class*='userName']", "[class*='baseInfo'] strong"];
            for (const s of sels) {
              const el = document.querySelector(s);
              const t = (el && el.textContent ? el.textContent : "").trim();
              if (t && t.length >= 2 && t.length <= 64 && !/登录|注册/.test(t)) return t;
            }
            return "";
          })()`)
          .catch(() => '')) as string)
      : '';

    return {
      ...base,
      loggedIn,
      needLogin: !loggedIn,
      account,
      currentUrl: url,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ...base,
      ok: false,
      needLogin: true,
      error: msg,
    };
  } finally {
    // status 内部自管理会话：检查完断开 CDP，但保留浏览器窗口
    await detachBrowserSession();
  }
}

/** status 命令定义（不需要 page 参数，内部自行管理会话） */
export const statusCommand = {
  name: 'status',
  description: '检查猎聘登录态，输出结构化 JSON',
  args: [] as any[],
  columns: [
    { header: '字段', key: 'key', width: 20 },
    { header: '值', key: 'value', width: 60 },
  ],
  requiresPage: false, // 不走 CLI 默认的浏览器启动，status 内部自管理
  func: async () => {
    const status = await runCheckLoginStatus();
    // 表格模式下转为 kv 列表；--json 时上层直接 stringify 整个对象
    return status;
  },
};

/**
 * 猎聘 URL 约定与登录态只读探测（不启动浏览器、不导航）。
 * 选择器与 toolset/login.ts 的登录成功判定保持一致。
 */
import type { Page } from 'puppeteer-core';
import { sleepRandom } from './utils.js';

/** 猎聘招聘者端首页 */
export const LIEPIN_LPT_HOME = 'https://lpt.liepin.com/';

/** 当前 URL 是否属于猎聘站点 */
export function isLiepinSiteUrl(url: string): boolean {
  if (!url || url === 'about:blank') return false;
  try {
    return new URL(url).hostname.includes('liepin.com');
  } catch {
    return false;
  }
}

/** 当前 URL 是否为猎聘登录流页面 */
export function isLiepinLoginUrl(url: string): boolean {
  if (!url) return false;
  return url.includes('/login') || url.includes('/signin') || url.includes('/passport');
}

/**
 * 登录态探测脚本（纯字符串，避免 tsx/esbuild 转译注入 __name）。
 * 选择器与 login.ts 一致：用户头像 / 用户名 / 退出按钮 / 招聘者内容。
 */
const PROBE_LOGGED_IN_SCRIPT = `(() => {
  var url = window.location.href;
  var isOnLogin = url.indexOf('/login') !== -1 || url.indexOf('/signin') !== -1 || url.indexOf('/passport') !== -1;

  var hasUser = !!(
    document.querySelector('.user-info') ||
    document.querySelector('.user-name') ||
    document.querySelector('[class*="avatar"]') ||
    document.querySelector('[class*="userName"]') ||
    document.querySelector('.recruiter-name') ||
    document.querySelector('a[href*="logout"]') ||
    document.querySelector('button[class*="logout"]')
  );

  var pageTitle = document.title || '';
  var hasRecruiterContent = pageTitle.indexOf('招聘') !== -1 ||
    !!document.querySelector('[class*="recruiter"]') ||
    !!document.querySelector('[class*="hr-"]');

  return { url: url, isOnLogin: isOnLogin, hasUser: hasUser, hasRecruiterContent: hasRecruiterContent };
})()`;

export type ProbeResult = { loggedIn: boolean; url: string };

/**
 * 根据当前页判断是否已登录（不导航）。
 * 已登录：非登录流 URL 且检测到用户信息或招聘者内容。
 * 短轮询等待 SPA 渲染，避免 goto 后立即读静态 HTML 误判。
 */
export async function probeLoggedInFromPage(page: Page): Promise<ProbeResult> {
  const url = page.url();
  if (!url || url === 'about:blank') {
    return { loggedIn: false, url: url || '' };
  }
  if (isLiepinLoginUrl(url)) {
    return { loggedIn: false, url };
  }

  const maxAttempts = 15;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const s = (await page
      .evaluate(PROBE_LOGGED_IN_SCRIPT)
      .catch(() => ({ url: '', isOnLogin: true, hasUser: false, hasRecruiterContent: false }))) as {
      url: string;
      isOnLogin: boolean;
      hasUser: boolean;
      hasRecruiterContent: boolean;
    };

    if (!s.isOnLogin && (s.hasUser || s.hasRecruiterContent)) {
      return { loggedIn: true, url };
    }
    if (s.isOnLogin) {
      return { loggedIn: false, url };
    }
    if (attempt < maxAttempts - 1) {
      await sleepRandom(300, 600);
    }
  }

  return { loggedIn: false, url };
}

/**
 * 猎聘页面注入守卫（精简版）
 *
 * 只保留通用反检测注入：navigator.webdriver 改写 + Function.prototype.toString 伪装。
 * 不包含 CDP Fetch 拦截——Boss 那套是针对 zhipin 特定风控脚本（risk-detection/verify-sdk）
 * 的 URL 写死拦截，猎聘风控路径不同，盲目搬会误伤正常请求。等实际遇到猎聘风控再抓包补。
 */
import type { Browser, Page, Target } from 'puppeteer-core';

const LIEPIN_PAGE_GUARD_SCRIPT = `(function() {
  'use strict';

  var _Object = Object;
  var _defineProperty = _Object.defineProperty;
  var _getOwnPropertyDescriptor = _Object.getOwnPropertyDescriptor;
  var _Function = Function;
  var _origFunctionToString = _Function.prototype.toString;
  var _Map = Map;

  /** 让包装的函数对 fn.toString() 返回 "function NAME() { [native code] }"。 */
  var nativeSourceMap = new _Map();
  var fakeToString = function toString() {
    if (this != null) {
      var mapped = nativeSourceMap.get(this);
      if (typeof mapped === 'string') return mapped;
    }
    return _origFunctionToString.call(this);
  };
  nativeSourceMap.set(fakeToString, 'function toString() { [native code] }');
  try {
    _defineProperty(_Function.prototype, 'toString', {
      value: fakeToString,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  } catch (e) {}

  var asNative = function(replacement, nativeName) {
    var src = 'function ' + nativeName + '() { [native code] }';
    nativeSourceMap.set(replacement, src);
    try {
      _defineProperty(replacement, 'name', {
        value: nativeName,
        writable: false,
        configurable: true,
        enumerable: false,
      });
    } catch (e) {}
    return replacement;
  };

  var replaceProtoAccessor = function(proto, key, options) {
    try {
      var desc = _getOwnPropertyDescriptor(proto, key);
      if (!desc || !desc.configurable) return null;
      var nextDesc = {
        configurable: true,
        enumerable: !!desc.enumerable,
      };
      if (options.get || desc.get) nextDesc.get = options.get || desc.get;
      if (options.set || desc.set) nextDesc.set = options.set || desc.set;
      _defineProperty(proto, key, nextDesc);
      return desc;
    } catch (e) {
      return null;
    }
  };

  // navigator.webdriver：在 Navigator.prototype 上覆盖 getter，返回 false
  try {
    var navProto = Object.getPrototypeOf(navigator);
    if (navProto) {
      replaceProtoAccessor(navProto, 'webdriver', {
        get: asNative(function() { return false; }, 'get webdriver'),
      });
    }
  } catch (e) {}

  // navigator.languages：为空时回填，避免 headless 特征
  try {
    if (!navigator.languages || navigator.languages.length === 0) {
      var navProto2 = Object.getPrototypeOf(navigator);
      if (navProto2) {
        var langs = ['zh-CN', 'zh', 'en'];
        replaceProtoAccessor(navProto2, 'languages', {
          get: asNative(function() { return langs; }, 'get languages'),
        });
      }
    }
  } catch (e) {}
})();`;

const pagesWithGuard = new WeakSet<Page>();
const browsersWithTargetGuard = new WeakSet<Browser>();

async function installPageGuard(page: Page): Promise<void> {
  if (page.isClosed() || pagesWithGuard.has(page)) return;
  await page.evaluateOnNewDocument(LIEPIN_PAGE_GUARD_SCRIPT);
  // 当前文档已加载时 evaluateOnNewDocument 不回溯，直接注入一次
  await page.evaluate(LIEPIN_PAGE_GUARD_SCRIPT).catch(() => {});
  pagesWithGuard.add(page);
}

async function installTargetPageGuard(target: Target): Promise<void> {
  if (target.type() !== 'page') return;
  const page = await target.page();
  if (!page || page.isClosed()) return;
  await installPageGuard(page);
}

/** 给单个页面装守卫（对外暴露，供 browser_session 调用）。 */
export async function installLiepinPageGuards(page: Page): Promise<void> {
  await installPageGuard(page);
}

/** 给整个浏览器装守卫：现有所有页 + 后续新建页（targetcreated）。 */
export async function installLiepinBrowserPageGuards(browser: Browser): Promise<void> {
  if (!browsersWithTargetGuard.has(browser)) {
    browser.on('targetcreated', (target) => {
      void installTargetPageGuard(target).catch(() => {});
    });
    browsersWithTargetGuard.add(browser);
  }
  const pages = (await browser.pages()).filter((p) => !p.isClosed());
  for (const page of pages) {
    await installPageGuard(page);
  }
}

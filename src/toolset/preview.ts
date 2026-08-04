/**
 * 猎聘在线简历预览截图命令
 *
 * 流程：导航到简历详情页（/resume/detail?resIdEncode=...）→ 等正文渲染稳定
 * → 撑开视口装下整页 → 对 #resume_detail_page_wrap 整框截图 → 校验非空白
 * → （配置百度凭证时）自动 OCR 存 txt。
 *
 * 猎聘简历正文直接在主文档（无 iframe），比 boss 的 c-resume iframe 简单。
 */

import { Page } from 'puppeteer-core';
import { stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureResumeDirs, RESUME_SCREENSHOTS_DIR } from '../config.js';
import { sleepRandom } from '../common/utils.js';
import { isResumeOcrEnabled, ocrResumePngToTextFile } from '../ocr/resume_ocr.js';
import { isBaiduOcrConfigured } from '../ocr/baidu_ocr.js';
import { resume } from './resume.js';

/** 简历主容器（探查确认的稳定 id，无 iframe，含 printable-cont 打印样式） */
const RESUME_CONTAINER_SELECTOR = '#resume_detail_page_wrap';

/** 判定为空白截图的文件大小阈值（字节）。正常简历截图 >100KB，空白图 <25KB。 */
const BLANK_SCREENSHOT_MAX_BYTES = 25 * 1024;

export interface PreviewOptions {
  talentId: string;   // resume_id（resIdEncode）
  ocr?: boolean;      // 是否 OCR（默认遵循 LIEPIN_RESUME_OCR，配置凭证时默认开）
}

/** 截图文件名安全段 */
function safeFileBase(name: string): string {
  const t = name.replace(/[/\\?%*:|"<>]/g, '_').trim().slice(0, 64);
  return t.length > 0 ? t : 'candidate';
}

/** 文件名时间戳：2026-08-04 17-45-56（与 boss-cli 统一） */
function formatFileTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** 简历文件名片段：岗位-姓名（岗位缺省时只姓名） */
function buildResumeNamePart(name: string, job: string): string {
  const n = safeFileBase(name);
  const j = job.trim() ? `${safeFileBase(job)}-` : '';
  return `${j}${n}`;
}

/** 等简历正文渲染稳定：容器可见且文本量/高度连续两次采样一致。 */
async function waitResumeReady(page: Page, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let last: { textLen: number; height: number } | null = null;
  while (Date.now() < deadline) {
    const fp = (await page
      .evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const text = (el.innerText || el.textContent || '').replace(/\s+/g, '');
        return { width: r.width, height: r.height, textLen: text.length };
      }, RESUME_CONTAINER_SELECTOR)
      .catch(() => null)) as { width: number; height: number; textLen: number } | null;

    if (fp && fp.width > 100 && fp.height > 300 && fp.textLen > 100) {
      if (last && last.textLen === fp.textLen && last.height === fp.height) {
        return true; // 连续两次稳定
      }
      last = { textLen: fp.textLen, height: fp.height };
    } else {
      last = null;
    }
    await sleepRandom(250, 400);
  }
  return false;
}

export async function preview(page: Page, options: PreviewOptions): Promise<any> {
  const { talentId } = options;
  if (!talentId) {
    throw new Error('简历 ID（resIdEncode）不能为空');
  }

  ensureResumeDirs();

  // 取姓名+岗位用于文件名（复用现有 resume()，不重复解析）
  let name = '';
  let job = '';
  try {
    const r = await resume(page, { talentId });
    name = r.name || '';
    job = r.job || '';
  } catch {
    /* 取不到就用 id，不影响截图 */
  }

  // 导航到简历详情页
  const url = `https://lpt.liepin.com/resume/detail?resIdEncode=${encodeURIComponent(talentId)}&sfrom=R_SEARCH_CONDITION`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  // 等正文渲染稳定
  const ready = await waitResumeReady(page, 15_000);
  if (!ready) {
    throw new Error('简历正文加载超时或无效（可能简历 ID 无效 / 无查看权限 / 触发风控）');
  }

  // 把容器滚回顶部，取容器完整高度
  const box = await page.evaluate((sel: string) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return null;
    window.scrollTo(0, 0);
    const r = el.getBoundingClientRect();
    return {
      x: r.x + window.scrollX,
      y: r.y + window.scrollY,
      width: r.width,
      height: r.height,
    };
  }, RESUME_CONTAINER_SELECTOR);
  if (!box || box.width < 50 || box.height < 50) {
    throw new Error('未找到简历容器，无法截图');
  }

  // 撑开视口装下整个容器（captureBeyondViewport 兜底），再截容器区域
  const curVp = page.viewport();
  const wanted = Math.min(Math.ceil(box.y + box.height + 40), 16_384);
  await page.setViewport({
    width: curVp?.width ?? 1280,
    height: Math.max(wanted, 900),
    deviceScaleFactor: curVp?.deviceScaleFactor ?? 1,
  });
  // 视口变化触发重排，等一次稳定
  await waitResumeReady(page, 8_000);
  await sleepRandom(400, 700);

  const timeStr = formatFileTimestamp(new Date());
  const fileName = `猎聘-在线简历-${buildResumeNamePart(name || talentId, job)}-${timeStr}.png`;
  const absPath = join(RESUME_SCREENSHOTS_DIR, fileName);

  await page.screenshot({
    path: absPath,
    type: 'png',
    captureBeyondViewport: true,
    clip: {
      x: Math.max(0, box.x),
      y: Math.max(0, box.y),
      width: Math.ceil(box.width),
      height: Math.ceil(box.height),
    },
  });

  // 校验非空白
  const st = await stat(absPath);
  if (st.size < BLANK_SCREENSHOT_MAX_BYTES) {
    await unlink(absPath).catch(() => {});
    throw new Error('截图为空白（内容未渲染或被清空），已删除');
  }

  // 恢复视口
  if (curVp) {
    await page.setViewport(curVp).catch(() => {});
  }

  const result: any = {
    name: name || '(未知)',
    resume_id: talentId,
    screenshot: absPath,
    size_kb: Math.round(st.size / 1024),
    ocr_text: '',
    ocr_file: '',
  };

  // 可选 OCR：配置凭证且未显式关闭时执行
  const wantOcr = options.ocr ?? (isResumeOcrEnabled() && isBaiduOcrConfigured());
  if (wantOcr) {
    try {
      const o = await ocrResumePngToTextFile(absPath);
      result.ocr_text = o.text;
      result.ocr_file = o.textPath;
    } catch (e) {
      result.ocr_error = e instanceof Error ? e.message : String(e);
    }
  }

  return result;
}

/** 预览截图命令定义 */
export const previewCommand = {
  name: 'preview',
  description: '在线简历预览截图（存 resumes/<日期>/screenshots/，配置百度凭证时自动 OCR）',
  args: [
    { name: 'talentId', type: 'string', required: true, positional: true, help: '简历 ID（resIdEncode，来自 search 结果）' },
    { name: 'ocr', type: 'bool', required: false, help: '是否 OCR（默认配置百度凭证时自动开）' },
  ],
  columns: [
    { header: '字段', key: 'field', width: 15 },
    { header: '内容', key: 'value', width: 80 },
  ],
  func: preview,
};

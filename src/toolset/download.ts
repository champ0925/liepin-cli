/**
 * 猎聘附件简历下载命令
 *
 * 流程：
 *   1. 复用 resume() 拿附件元数据（姓名 / 原始文件名 / status）
 *   2. 导航到简历详情页，开 CDP Page.setDownloadBehavior 指向输出目录
 *   3. 点击页面「下载」按钮（<a class*="download--">），浏览器捕获真实文件落盘
 *   4. 重命名为 猎聘-附件简历-姓名-时间.<ext>
 *
 * 为什么不直接 HTTP 下载 downloadUrl：
 *   接口返回的 downloadUrl 是相对路径，直接 fetch/goto 命中不了服务端路由（回首页 HTML），
 *   真实下载是前端 JS 绑在「下载」按钮上的二次请求，只有点击才会触发正确链路。
 */

import { Page } from 'puppeteer-core';
import { writeFile, stat, rename, readdir, copyFile, unlink } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';
import { ensureResumeDirs, RESUME_ATTACHMENTS_DIR } from '../config.js';
import { sleepRandom } from '../common/utils.js';
import { resume } from './resume.js';

export interface DownloadOptions {
  talentId: string;   // resume_id（resIdEncode）
  out?: string;       // 输出目录（默认 resumes/<日期>/attachments/）
}

/** 文件名安全段 */
function safeFileBase(name: string): string {
  const t = name.replace(/[/\\?%*:|"<>]/g, '_').trim().slice(0, 64);
  return t.length > 0 ? t : 'candidate';
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export async function download(page: Page, options: DownloadOptions): Promise<any> {
  const { talentId } = options;
  if (!talentId) {
    throw new Error('简历 ID（resIdEncode）不能为空');
  }

  ensureResumeDirs();
  const outDir = options.out?.trim() || RESUME_ATTACHMENTS_DIR;

  // 第 1 步：复用 resume() 拿附件元数据
  const r = await resume(page, { talentId });
  const att = r.attachment;
  if (!att) {
    throw new Error('该候选人没有附件简历（可能只开放了在线简历）');
  }
  if (att.status !== 1) {
    throw new Error(
      `附件简历当前不可直接下载（status=${att.status ?? '空'}, ask4_status=${att.ask4_status ?? '空'}），可能需要先「向TA索要」并等对方同意`,
    );
  }

  const name = r.name || talentId;
  const origName = att.name || '';
  const ext = (att.type || extname(origName).replace(/^\./, '') || 'pdf').toLowerCase();

  // 第 2 步：记录 Chrome 默认下载目录现有文件（点按钮后对比找新文件）
  // CDP Page/Browser.setDownloadBehavior 在新版 Chrome 上不生效（文件仍下默认目录），
  // 所以直接监听默认目录：快照 → 点击 → 轮询新出现的文件。
  const chromeDlDir = join(homedir(), 'Downloads');
  const before = new Set(await readdir(chromeDlDir).catch(() => [] as string[]));

  // 第 3 步：导航到简历详情页，等下载按钮渲染
  const url = `https://lpt.liepin.com/resume/detail?resIdEncode=${encodeURIComponent(talentId)}&sfrom=R_SEARCH_CONDITION`;
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 });
  await sleepRandom(1500, 2500);
  await page.waitForSelector('a[class*="download--"]', { timeout: 10_000 }).catch(() => {});

  // 第 4 步：点「下载」按钮（先滚动到可见区域，合成点击对视口外元素可能不响应）
  const clicked = await page.evaluate(() => {
    const a = document.querySelector('a[class*="download--"]') as HTMLElement | null;
    if (!a) return false;
    a.scrollIntoView({ block: 'center', inline: 'nearest' });
    return true;
  });
  if (!clicked) {
    throw new Error('简历详情页未找到「下载」按钮（可能页面结构变更或该简历无附件）');
  }
  await sleepRandom(500, 900);
  // 用 Puppeteer 原生 click（派发完整鼠标事件，比 JS click 更像真人）
  await page.click('a[class*="download--"]').catch(() => {
    // 兜底：原生 click 失败再用 JS click
    return page.evaluate(() => {
      (document.querySelector('a[class*="download--"]') as HTMLElement | null)?.click();
    });
  });

  // 等默认下载目录出现新文件（最多 30s；.crdownload 表示还在下，继续等）
  let srcPath = '';
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const now = await readdir(chromeDlDir).catch(() => [] as string[]);
    const fresh = now.filter(f => !before.has(f) && !f.endsWith('.crdownload'));
    if (fresh.length > 0) {
      // 取最新的那个
      const withTime = await Promise.all(fresh.map(async f => ({ f, t: (await stat(join(chromeDlDir, f))).mtimeMs })));
      withTime.sort((a, b) => b.t - a.t);
      srcPath = join(chromeDlDir, withTime[0].f);
      break;
    }
    await sleepRandom(400, 700);
  }
  if (!srcPath) {
    throw new Error('附件下载超时（30s 内默认下载目录未出现新文件），可能未登录或触发风控');
  }

  // 第 5 步：从默认下载目录 move 到目标目录并重命名（跨盘符用 copy+unlink）
  const ts = new Date();
  const timeStr = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
  const finalName = `猎聘-附件简历-${safeFileBase(name)}-${timeStr}.${ext}`;
  const absPath = join(outDir, finalName);
  try {
    await rename(srcPath, absPath);
  } catch {
    await copyFile(srcPath, absPath);
    await unlink(srcPath).catch(() => {});
  }

  const st = await stat(absPath);
  return {
    name,
    resume_id: talentId,
    attachment_name: origName,
    file: absPath,
    size_kb: Math.round(st.size / 1024),
  };
}

/** 附件下载命令定义 */
export const downloadCommand = {
  name: 'download',
  description: '下载候选人附件简历（PDF/DOCX，存 resumes/<日期>/attachments/）',
  args: [
    { name: 'talentId', type: 'string', required: true, positional: true, help: '简历 ID（resIdEncode，来自 search 结果）' },
    { name: 'out', type: 'string', required: false, help: '输出目录（默认 resumes/<日期>/attachments/）' },
  ],
  columns: [
    { header: '字段', key: 'field', width: 18 },
    { header: '内容', key: 'value', width: 80 },
  ],
  func: download,
};

/**
 * 猎聘附件简历下载命令
 *
 * 流程：
 *   1. 导航到简历详情页（/resume/detail?resIdEncode=...）
 *   2. 在简历页上下文调 resume-view 接口拿附件元数据（姓名 / status）
 *   3. 点击页面「下载」按钮，监听 Chrome 默认下载目录捕获文件
 *   4. move 到 resumes/<日期>/attachments/ 并重命名
 *
 * 为什么不复用 resume()：
 *   resume() 内部 navigateToLpt('/search') 会先导航到搜索页再调接口，
 *   download 又要 goto 回简历页，两次导航在新会话里容易卡死。
 *   直接在简历页调接口（同域，cookie/referer 都对），省一次导航。
 *
 * 为什么不直接 HTTP 下载 downloadUrl：
 *   接口返回的 downloadUrl 是虚拟路径，直接 fetch/goto 命中不了服务端路由（回首页 HTML），
 *   真实下载是前端 JS 绑在「下载」按钮上的二次请求，只有点击才会触发正确链路。
 */

import { Page } from 'puppeteer-core';
import { stat, rename, readdir, copyFile, unlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';
import { ensureResumeDirs, RESUME_ATTACHMENTS_DIR, BROWSER_USER_DATA_DIR } from '../config.js';
import { sleepRandom } from '../common/utils.js';
import { LIEPIN_LPT_API, lptFetch } from '../common/lpt-utils.js';

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

  // 第 1 步：导航到简历详情页
  const detailUrl = `https://lpt.liepin.com/resume/detail?resIdEncode=${encodeURIComponent(talentId)}&sfrom=R_SEARCH_CONDITION`;
  await page.goto(detailUrl, { waitUntil: 'networkidle2', timeout: 30_000 });
  await sleepRandom(1500, 2500);

  // 第 2 步：在简历页上下文调 resume-view 接口拿附件元数据（同域，无需再导航）
  const form = new URLSearchParams();
  form.set('pageParamVo', JSON.stringify({ resIdEncode: talentId, sfrom: 'R_SEARCH_CONDITION' }));
  const data = await lptFetch(page, `${LIEPIN_LPT_API}/api/com.liepin.rresume.usere.pc.resume-view`, { body: form.toString() });
  if (data.flag !== 1) {
    throw new Error(`获取简历失败: ${data.msg || data.message || '未知错误'}`);
  }
  const vo = data.data?.resumeDetailVo;
  const att = vo?.attachmentVo?.attachmentResume;
  const ask4Status = vo?.attachmentVo?.ask4AttachmentStatus;
  const name = vo?.baseInfo?.name || talentId;

  if (!att) {
    throw new Error('该候选人没有附件简历（可能只开放了在线简历）');
  }
  if (att.status !== 1) {
    throw new Error(
      `附件简历当前不可直接下载（status=${att.status ?? '空'}, ask4_status=${ask4Status ?? '空'}），可能需要先「向TA索要」并等对方同意`,
    );
  }

  const origName = att.name || '';
  const ext = (att.type || extname(origName).replace(/^\./, '') || 'pdf').toLowerCase();

  // 第 3 步：读 Chrome Preferences 拿真实下载目录（用户可能自定义过）
  const prefsPath = join(BROWSER_USER_DATA_DIR, 'Default', 'Preferences');
  let chromeDlDir = join(homedir(), 'Downloads'); // 默认
  try {
    const prefs = JSON.parse(readFileSync(prefsPath, 'utf-8'));
    chromeDlDir = prefs.download?.default_directory || prefs.savefile?.default_directory || chromeDlDir;
  } catch { /* 读不到就用默认 */ }

  // 快照下载目录现有文件
  const before = new Set(await readdir(chromeDlDir).catch(() => [] as string[]));

  // 第 4 步：等下载按钮渲染，直接 JS click（探针验证过的方式）
  await page.waitForSelector('a[class*="download--"]', { timeout: 10_000 }).catch(() => {});
  const clicked = await page.evaluate(() => {
    const a = document.querySelector('a[class*="download--"]') as HTMLElement | null;
    if (!a) return false;
    a.click();
    return true;
  });
  if (!clicked) {
    throw new Error('简历详情页未找到「下载」按钮（可能页面结构变更或该简历无附件）');
  }

  // 等下载目录出现新文件（最多 30s；.crdownload 表示还在下，继续等）
  let srcPath = '';
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const now = await readdir(chromeDlDir).catch(() => [] as string[]);
    const fresh = now.filter(f => !before.has(f) && !f.endsWith('.crdownload'));
    if (fresh.length > 0) {
      const withTime = await Promise.all(fresh.map(async f => ({ f, t: (await stat(join(chromeDlDir, f))).mtimeMs })));
      withTime.sort((a, b) => b.t - a.t);
      srcPath = join(chromeDlDir, withTime[0].f);
      break;
    }
    await sleepRandom(400, 700);
  }
  if (!srcPath) {
    throw new Error(`附件下载超时（30s 内 ${chromeDlDir} 未出现新文件），可能未登录或触发风控`);
  }

  // 第 5 步：move 到目标目录并重命名（跨盘符用 copy+unlink）
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

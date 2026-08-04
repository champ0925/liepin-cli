/**
 * 猎聘「求附件简历 / 同意对方请求」命令 - 招聘者端
 *
 * 走 LPT IM 接口（探针抓包确认）：
 *   top-buttons:      com.liepin.im.b.askfor.top-buttons
 *                       -> data.topBtnList[] { bizType, status, msg }
 *                       bizType: 1=换微信 2=换电话 3=求简历（附件）
 *   send-askfor-request: com.liepin.im.b.askfor.send-askfor-request
 *                       body: bizType + oppositeImId
 *   accept-refuse:    com.liepin.im.b.askfor.accept-refuse
 *                       body: bizType + status + oppositeImId（对方发来请求时用）
 *
 * 请求上下文：必须先导航到 lpt.liepin.com 任意页面（带 cookie/XSRF），
 * 然后 lptFetch 即可。oppositeImId 从 resume-view 接口的 vo.imId 拿。
 */

import { Page } from 'puppeteer-core';
import { LIEPIN_LPT_API, lptFetch, navigateToLpt, readLptImId } from '../common/lpt-utils.js';

export interface AttachmentActionOptions {
  talentId: string;   // resume_id（resIdEncode）
}

interface TopBtn {
  status: number;
  bizType: number;
  msg: string;
}

/** 求简历 bizType（IM 操作条「看简历」对应的索求类型） */
const BIZ_TYPE_RESUME = 3;

async function getCandidateContext(page: Page, talentId: string): Promise<{ name: string; oppositeImId: string }> {
  const form = new URLSearchParams();
  form.set('pageParamVo', JSON.stringify({ resIdEncode: talentId, sfrom: 'R_SEARCH_CONDITION', applyId: '' }));
  const data = await lptFetch(page, `${LIEPIN_LPT_API}/api/com.liepin.rresume.usere.pc.resume-view`, { body: form.toString() });
  if (data.flag !== 1) {
    throw new Error(`获取简历失败: ${data.msg || data.message || JSON.stringify(data).slice(0, 200)}`);
  }
  const vo = data.data?.resumeDetailVo;
  // 探针确认：候选人 IM id 在 data.imInfoVo.usercImId（不是 vo.imId）
  const oppositeImId = String(data.data?.imInfoVo?.usercImId || '');
  if (!oppositeImId) {
    throw new Error('响应缺少候选人 imId（imInfoVo.usercImId），无法发起 IM 动作');
  }
  return { name: vo?.baseInfo?.name || talentId, oppositeImId };
}

async function getTopButtons(page: Page, imId: string, oppositeImId: string): Promise<TopBtn[]> {
  const body = `imUserType=2&imId=${encodeURIComponent(imId)}&imApp=1&oppositeImId=${encodeURIComponent(oppositeImId)}`;
  const data = await lptFetch(page, `${LIEPIN_LPT_API}/api/com.liepin.im.b.askfor.top-buttons`, { body, clientId: '40342' });
  if (data.flag !== 1) {
    throw new Error(`获取操作状态失败: ${data.msg || data.message || JSON.stringify(data).slice(0, 200)}`);
  }
  return (data.data?.topBtnList || []) as TopBtn[];
}

/**
 * 求附件简历：向对方发送「求简历」请求。
 * 前置：双方已建立沟通（greet 或对方投递）。按钮状态由 top-buttons 决定。
 */
export async function requestAttachmentResume(page: Page, options: AttachmentActionOptions): Promise<any> {
  const { talentId } = options;
  if (!talentId) throw new Error('简历 ID（resIdEncode）不能为空');

  await navigateToLpt(page, '/search', 2);
  const imId = await readLptImId(page);
  if (!imId) throw new Error('无法读取自己的 imId，请确保已登录招聘者端');

  const { name, oppositeImId } = await getCandidateContext(page, talentId);
  const buttons = await getTopButtons(page, imId, oppositeImId);
  const resumeBtn = buttons.find(b => b.bizType === BIZ_TYPE_RESUME);

  if (!resumeBtn) {
    throw new Error(`当前会话没有「求简历」操作入口（top-buttons 未返回 bizType=${BIZ_TYPE_RESUME}），可能尚未建立沟通`);
  }
  // status=35 表示"已有对方简历"（无需再求）；其他可诉求的状态直接发请求
  if (resumeBtn.status === 35) {
    return { success: true, skipped: true, name, message: `已有 ${name} 的简历，无需再索要（${resumeBtn.msg}）`, status: resumeBtn.status };
  }

  const body = `imUserType=2&imId=${encodeURIComponent(imId)}&imApp=1&oppositeImId=${encodeURIComponent(oppositeImId)}&bizType=${BIZ_TYPE_RESUME}`;
  const res = await lptFetch(page, `${LIEPIN_LPT_API}/api/com.liepin.im.b.askfor.send-askfor-request`, { body, clientId: '40342' });
  if (res.flag !== 1) {
    throw new Error(`求附件简历失败: ${res.msg || res.message || JSON.stringify(res).slice(0, 200)}`);
  }

  return { success: true, skipped: false, name, message: `已向 ${name} 发送求附件简历请求`, status: resumeBtn.status };
}

/**
 * 同意简历：对方发来「求简历/换联系方式」等请求时，我方点同意。
 * 注意：这是处理"对方发起的请求"，与我方主动"求简历"相反。
 */
export async function agreeResume(page: Page, options: AttachmentActionOptions): Promise<any> {
  const { talentId } = options;
  if (!talentId) throw new Error('简历 ID（resIdEncode）不能为空');

  await navigateToLpt(page, '/search', 2);
  const imId = await readLptImId(page);
  if (!imId) throw new Error('无法读取自己的 imId，请确保已登录招聘者端');

  const { name, oppositeImId } = await getCandidateContext(page, talentId);
  const buttons = await getTopButtons(page, imId, oppositeImId);
  const resumeBtn = buttons.find(b => b.bizType === BIZ_TYPE_RESUME);

  if (!resumeBtn) {
    throw new Error('当前会话没有待处理的简历相关请求');
  }
  // status=25 表示"对方同意"（对方已同意我方请求，无需再操作）
  if (resumeBtn.status === 25) {
    return { success: true, skipped: true, name, message: `${name} 的请求已是同意状态，无需重复操作`, status: resumeBtn.status };
  }

  // 同意对方请求：accept-refuse，status=1 同意 / 2 拒绝（按 boss-cli 惯例）
  const body = `imUserType=2&imId=${encodeURIComponent(imId)}&imApp=1&oppositeImId=${encodeURIComponent(oppositeImId)}&bizType=${BIZ_TYPE_RESUME}&status=1`;
  const res = await lptFetch(page, `${LIEPIN_LPT_API}/api/com.liepin.im.b.askfor.accept-refuse`, { body, clientId: '40342' });
  if (res.flag !== 1) {
    const raw = String(res.msg || res.message || JSON.stringify(res).slice(0, 200));
    // 「参数异常」基本是"当前没有对方发起的待处理请求"（按钮 msg 通常是"看简历"而非"同意"）
    const hint = /参数异常/.test(raw) ? `（当前可能没有 ${name} 发来的待处理请求，仅当对方主动求简历/换联系方式时才需要同意）` : '';
    throw new Error(`同意简历失败: ${raw}${hint}`);
  }

  return { success: true, skipped: false, name, message: `已同意 ${name} 的简历相关请求`, status: resumeBtn.status };
}

/** 求附件简历命令定义 */
export const requestAttachmentResumeCommand = {
  name: 'request-attachment-resume',
  description: '向候选人索要附件简历（招聘端，传 resume_id）',
  args: [
    { name: 'talentId', type: 'string', required: true, positional: true, help: '简历 ID（resIdEncode，来自 search 结果）' },
  ],
  columns: [
    { header: '结果', key: 'message', width: 60 },
  ],
  func: requestAttachmentResume,
};

/** 同意简历命令定义 */
export const agreeResumeCommand = {
  name: 'agree-resume',
  description: '同意对方发来的简历相关请求（招聘端，传 resume_id）',
  args: [
    { name: 'talentId', type: 'string', required: true, positional: true, help: '简历 ID（resIdEncode，来自 search 结果）' },
  ],
  columns: [
    { header: '结果', key: 'message', width: 60 },
  ],
  func: agreeResume,
};

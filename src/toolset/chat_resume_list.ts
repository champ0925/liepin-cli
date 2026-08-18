/**
 * 猎聘「有简历」分类候选人列表命令
 *
 * 从沟通页「有简历」分类获取候选人，输出 name/title/encodeResId。
 * 用于批量下载附件简历时替代 search，避免搜索接口的随机性和覆盖率问题。
 */

import { Page } from 'puppeteer-core';
import { navigateToLpt, readLptImId } from '../common/lpt-utils.js';
import { getContactsWithResume } from '../common/im-contact-utils.js';

export interface ChatResumeListOptions {
  jobFilter?: string;   // 按职位过滤（如 "法务"）
  deep?: boolean;       // 是否深度查询（对 lastPayload 不带简历的会话补查 chat-list）
}

export async function chatResumeList(page: Page, options: ChatResumeListOptions): Promise<any> {
  await navigateToLpt(page, '/chat/im', 3);
  const imId = await readLptImId(page);
  if (!imId) {
    throw new Error('无法读取自己的 imId，请确保已登录招聘者端');
  }

  const contacts = await getContactsWithResume(page, imId, {
    deep: options.deep === true,
    jobFilter: options.jobFilter,
  });

  return contacts.map(c => ({
    name: c.name,
    title: c.title,
    resume_id: c.encodeResId,
    has_resume: c.hasResume,
  }));
}

/** 命令定义 */
export const chatResumeListCommand = {
  name: 'chat-resume-list',
  description: '从沟通页「有简历」分类获取候选人列表（含 resume_id）',
  args: [
    { name: 'jobFilter', type: 'string', required: false, help: '按职位过滤（如 "法务"）' },
    { name: 'deep', type: 'boolean', required: false, default: false, help: '深度查询：对 lastPayload 不带简历的会话补查消息历史' },
  ],
  columns: [
    { header: '姓名', key: 'name', width: 12 },
    { header: '职位', key: 'title', width: 20 },
    { header: '简历ID', key: 'resume_id', width: 30 },
    { header: '有简历', key: 'has_resume', width: 8 },
  ],
  func: chatResumeList,
};

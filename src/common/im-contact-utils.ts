/**
 * 猎聘 IM 沟通页工具函数
 *
 * 从沟通页「有简历」分类获取候选人列表，提取 resIdEncode。
 *
 * 数据源：
 *   filter-contacts-v1 (hasResume=true): 「有简历」分类的真实数据源
 *   chat-list: 单会话消息历史，用于 lastPayload 不带简历时补查
 */

import { Page } from 'puppeteer-core';
import { LIEPIN_LPT_API, lptFetch } from './lpt-utils.js';

export interface ImContact {
  name: string;
  title: string;           // 职位
  oppositeImId: string;    // 候选人 IM id
  encodeResId?: string;    // 简历 ID（resIdEncode）
  hasResume: boolean;      // 是否有简历（在线或附件）
}

/** 从 lastPayload 提取 encodeResId */
function extractEncodeResIdFromPayload(payloadStr: string): string | undefined {
  try {
    const payload = JSON.parse(payloadStr);
    const paramStr = payload?.ext?.extBody?.bizData?.onlineResume?.param;
    if (!paramStr) return undefined;
    const param = JSON.parse(paramStr);
    return param.encodeResId || undefined;
  } catch {
    return undefined;
  }
}

/** 从消息 payload 提取 encodeResId（支持在线简历和附件简历两种格式） */
function extractEncodeResIdFromMessage(msg: any): string | undefined {
  try {
    const payload = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;
    // 在线简历
    const onlineParam = payload?.ext?.extBody?.bizData?.onlineResume?.param;
    if (onlineParam) {
      const p = JSON.parse(onlineParam);
      if (p.encodeResId) return p.encodeResId;
    }
    // 附件简历（求职投递卡片）
    const cardParam = payload?.ext?.extBody?.bizData?.attachmentResume?.param;
    if (cardParam) {
      const p = JSON.parse(cardParam);
      if (p.encodeResId) return p.encodeResId;
    }
    // 直接搜 resIdEncode 字段
    const raw = JSON.stringify(payload);
    const m = raw.match(/"encodeResId"\s*:\s*"([^"]+)"/);
    if (m) return m[1];
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * 获取「有简历」分类会话列表（filter-contacts-v1，分页拉取）
 *
 * 探针确认：hasResume=true 是「有简历」分类的过滤条件。
 * 分页终止：连续两页首条 id 相同或返回空列表。
 */
export async function getContactsWithResumeList(page: Page, imId: string): Promise<ImContact[]> {
  const all: ImContact[] = [];
  let curPage = 0;
  const pageSize = 30;
  const MAX_PAGES = 20;
  let lastFirstId = '';

  while (curPage < MAX_PAGES) {
    const body = `imUserType=2&imId=${encodeURIComponent(imId)}&imApp=1&pageSize=${pageSize}&curPage=${curPage}&hasResume=true&msgSourceKey=`;
    const data = await lptFetch(page, `${LIEPIN_LPT_API}/api/com.liepin.im.b.contact.filter-contacts-v1`, { body, clientId: '40156' });
    if (data.flag !== 1) {
      throw new Error(`获取有简历会话列表失败: ${data.msg || data.message || '未知错误'}`);
    }
    const list = data.data?.list || [];
    if (list.length === 0) break;
    // 连续两页首条相同说明到底了
    const firstId = list[0]?.id || '';
    if (firstId && firstId === lastFirstId) break;
    lastFirstId = firstId;

    for (const item of list) {
      const encodeResId = extractEncodeResIdFromPayload(item.lastPayload || '');
      all.push({
        name: item.name || '',
        title: item.title || '',
        oppositeImId: item.oppositeImId || '',
        encodeResId,
        hasResume: true, // filter-contacts-v1 已保证有简历
      });
    }
    curPage++;
  }

  return all;
}

/**
 * 拉取单会话消息历史，查找简历消息提取 encodeResId
 */
export async function getChatListResumeId(page: Page, imId: string, oppositeImId: string): Promise<string | undefined> {
  const body = `imUserType=2&imId=${encodeURIComponent(imId)}&imApp=1&oppositeImId=${encodeURIComponent(oppositeImId)}&maxMessageId=&pageSize=20`;
  const data = await lptFetch(page, `${LIEPIN_LPT_API}/api/com.liepin.im.b.chat.chat-list`, { body, clientId: '40156' });
  if (data.flag !== 1) {
    return undefined;
  }
  const msgs = data.data?.list || data.data?.msgList || [];
  for (const msg of msgs) {
    const resId = extractEncodeResIdFromMessage(msg);
    if (resId) return resId;
  }
  return undefined;
}

/**
 * 获取「有简历」分类候选人列表（含 resume_id）
 *
 * 流程：
 *   1. 调 filter-contacts-v1 (hasResume=true) 拿「有简历」分类全量
 *   2. 对 lastPayload 已带简历的，直接提取 encodeResId
 *   3. 对未带的，调 chat-list 补查（可选，deep 模式）
 *   4. 按职位过滤（可选）
 */
export async function getContactsWithResume(
  page: Page,
  imId: string,
  options: { deep?: boolean; jobFilter?: string } = {}
): Promise<ImContact[]> {
  const { deep = false, jobFilter } = options;
  const contacts = await getContactsWithResumeList(page, imId);

  // 按职位过滤
  let filtered = contacts;
  if (jobFilter) {
    filtered = contacts.filter(c => c.title.includes(jobFilter));
  }

  // 非 deep 模式：只返回 lastPayload 已确认有 encodeResId 的
  if (!deep) {
    return filtered.filter(c => !!c.encodeResId);
  }

  // deep 模式：对未确认的逐个查 chat-list
  const result: ImContact[] = [];
  for (const c of filtered) {
    if (c.encodeResId) {
      result.push(c);
      continue;
    }
    const resId = await getChatListResumeId(page, imId, c.oppositeImId);
    if (resId) {
      result.push({ ...c, encodeResId: resId });
    }
  }
  return result;
}

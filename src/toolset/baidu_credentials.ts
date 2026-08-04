import { getUserEnvPathForBaidu, writeBaiduCredentialsToUserEnv } from '../common/baidu_user_env.js';
import { clearBaiduTokenCache } from '../ocr/baidu_ocr.js';

/**
 * 隐藏命令：将百度 OCR 的 API Key / Secret 写入 ~/.liepin-cli/.env，并更新当前进程环境变量。
 * 用法：liepin _baidu-keys --api-key <KEY> --secret-key <SECRET>
 */
export function setBaiduCredentials(apiKey: string, secretKey: string): any {
  const ak = (apiKey || '').trim();
  const sk = (secretKey || '').trim();
  if (!ak || !sk) {
    throw new Error('API Key 与 Secret Key 均不能为空。用法：liepin _baidu-keys --api-key <KEY> --secret-key <SECRET>');
  }
  writeBaiduCredentialsToUserEnv(ak, sk);
  process.env.LIEPIN_BAIDU_API_KEY = ak;
  process.env.LIEPIN_BAIDU_SECRET_KEY = sk;
  clearBaiduTokenCache();
  return {
    result: '已保存百度 OCR 凭证',
    file: getUserEnvPathForBaidu(),
    note: '当前进程已生效；新开终端自动读取。之后 preview 截图会自动 OCR。',
  };
}

export const baiduKeysCommand = {
  name: '_baidu-keys',
  description: '配置百度 OCR 凭证（写入 ~/.liepin-cli/.env）',
  args: [
    { name: 'apiKey', type: 'string', required: true, help: '百度 OCR API Key（--api-key）' },
    { name: 'secretKey', type: 'string', required: true, help: '百度 OCR Secret Key（--secret-key）' },
  ],
  columns: [
    { header: '字段', key: 'field', width: 15 },
    { header: '内容', key: 'value', width: 80 },
  ],
  requiresPage: false,
  func: async (_page: any, opts: any) => setBaiduCredentials(opts.apiKey, opts.secretKey),
};

import { basename, join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { ensureResumeDirs, RESUME_OCR_DIR } from '../config.js';
import { baiduOcrImageBase64, isBaiduOcrConfigured } from './baidu_ocr.js';

/**
 * 是否对在线简历截图做 OCR。关闭：`LIEPIN_RESUME_OCR=0`。
 * 开启时需配置百度 `API_KEY` + `SECRET_KEY`。
 */
export function isResumeOcrEnabled(): boolean {
  const v = process.env.LIEPIN_RESUME_OCR?.trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'no';
}

let ocrChain: Promise<unknown> = Promise.resolve();

/** 对简历 PNG 调百度 OCR，结果写入 `resumes/<日期>/ocr/同名.txt`。 */
export async function ocrResumePngToTextFile(
  pngAbsPath: string,
): Promise<{ textPath: string; text: string }> {
  ensureResumeDirs();
  if (!isBaiduOcrConfigured()) {
    throw new Error(
      '已开启简历 OCR，但未配置百度密钥：请设置 API_KEY 与 SECRET_KEY（或 LIEPIN_BAIDU_API_KEY / LIEPIN_BAIDU_SECRET_KEY）。',
    );
  }

  const base = basename(pngAbsPath).replace(/\.png$/i, '.txt');
  const textPath = join(RESUME_OCR_DIR, base);

  const run = async (): Promise<{ textPath: string; text: string }> => {
    const buf = await readFile(pngAbsPath);
    const text = await baiduOcrImageBase64(buf.toString('base64'));
    await writeFile(textPath, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
    return { textPath, text };
  };

  const p = ocrChain.then(run);
  ocrChain = p.catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[liepin-cli] resume OCR chain reset after failure:', msg);
  });
  return p;
}

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/** 把 .env 里的 API_TOKEN 填进题库配置的 Authorization 头，避免手抄时漏掉 Bearer 后面的空格 */
export function applyToken(banks, token) {
  const value = typeof token === 'string' ? token.trim() : '';
  if (!value) throw new Error('API_TOKEN 为空');
  return banks.map(bank => ({ ...bank, headers: { ...bank.headers, Authorization: `Bearer ${value}` } }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.API_TOKEN) {
    console.error('缺少 API_TOKEN：请用 npm run ocs:config 运行，它会读取同一目录的 .env。');
    process.exitCode = 1;
  } else {
    const banks = JSON.parse(await readFile(new URL('./ocs-config.json', import.meta.url), 'utf8'));
    console.error('# 已用 .env 的 API_TOKEN 替换 Authorization，把下面整段复制到 OCS「题库配置」。');
    console.log(JSON.stringify(applyToken(banks, process.env.API_TOKEN), null, 2));
  }
}

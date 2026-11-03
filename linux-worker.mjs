import { readFile, mkdir, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createInterface } from 'node:readline/promises';

const bridgeSource = () => readFile(new URL('./deepseek-bridge.user.js', import.meta.url), 'utf8');

export function bridgeConfig(env = process.env) {
  const url = new URL(env.BRIDGE_URL || `http://127.0.0.1:${env.PORT || 3000}`);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('BRIDGE_URL 必须是 http://127.0.0.1:端口 或 http://localhost:端口');
  }
  const token = env.API_TOKEN;
  if (typeof token !== 'string' || !token || token.trim() !== token || /[\r\n]/.test(token)) throw new Error('请设置与本地服务相同的 API_TOKEN');
  if ((env.BACKEND || 'web-bridge') !== 'web-bridge') throw new Error('Linux 网页 worker 需要 BACKEND=web-bridge，不使用 API 模式');
  return { address: url.origin, token };
}

export async function installPageBridge(page) {
  await page.evaluate(source => {
    const module = { exports: {} };
    // Load only the shared DOM adapter and runner; the Tampermonkey UI is not installed.
    new Function('module', source)(module);
    window.__ocsLinuxBridge = module.exports;
    window.__ocsLinuxRunning = true;
  }, await bridgeSource());
}

export async function checkPageReady(page) {
  await page.evaluate(() => {
    const ui = window.__ocsLinuxBridge.createDomAdapter(document);
    ui.check();
    if (ui.draft().trim()) throw new Error('输入框有草稿，请使用 linux:login 清空后重启');
    if (!ui.isIdle()) throw new Error('网页未就绪，请完成登录/验证并等待当前生成结束');
  });
}

function abortable(promise, signal) {
  if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(signal.reason); }
  let onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, cancelled]).finally(() => signal.removeEventListener('abort', onAbort));
}

export async function runBridgeWorker({ page, address, token, signal = new AbortController().signal,
  log = console.log, pollMs = 200, heartbeatMs = 5000, fetchImpl = fetch } = {}) {
  const clientId = randomUUID();
  const monitor = new AbortController();
  const runningSignal = AbortSignal.any([signal, monitor.signal]);
  let connectAttempted = false, heartbeatBusy = false, heartbeat;
  const request = async (path, data = {}, cancellation = runningSignal) => {
    const requestSignal = cancellation
      ? AbortSignal.any([cancellation, AbortSignal.timeout(8000)]) : AbortSignal.timeout(3000);
    const response = await fetchImpl(address + path, {
      method: 'POST', signal: requestSignal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ clientId, ...data })
    });
    const body = await response.json();
    if (!response.ok || body.code !== 0) throw new Error(body.message || `本地桥接接口 HTTP ${response.status}`);
    return body;
  };
  const stopPage = () => { void page.evaluate(() => { window.__ocsLinuxRunning = false; }).catch(() => {}); };
  runningSignal.addEventListener('abort', stopPage, { once: true });
  try {
    runningSignal.throwIfAborted();
    await installPageBridge(page);
    await checkPageReady(page);
    connectAttempted = true;
    await request('/bridge/connect');
    log('Linux 网页桥接已连接，等待 OCS 题目。');
    heartbeat = setInterval(async () => {
      if (heartbeatBusy || runningSignal.aborted) return;
      heartbeatBusy = true;
      try { await request('/bridge/heartbeat'); }
      catch (error) { monitor.abort(error); }
      finally { heartbeatBusy = false; }
    }, heartbeatMs);

    while (!runningSignal.aborted) {
      await abortable(checkPageReady(page), runningSignal);
      const { job } = await request('/bridge/poll');
      if (job) {
        log('正在解题。');
        const answer = await abortable(page.evaluate(({ job, blobBase }) => {
          const { runJob, createDomAdapter } = window.__ocsLinuxBridge;
          return runJob(job, createDomAdapter(document), { running: () => window.__ocsLinuxRunning, blobBase });
        }, { job, blobBase: address }), runningSignal);
        await request('/bridge/result', { id: job.id, answer });
        log('答案已返回 OCS，等待下一题。');
      }
      await sleep(pollMs, undefined, { signal: runningSignal });
    }
    runningSignal.throwIfAborted();
  } catch (error) {
    if (!signal.aborted) throw monitor.signal.aborted ? monitor.signal.reason : error;
  } finally {
    clearInterval(heartbeat);
    runningSignal.removeEventListener('abort', stopPage);
    stopPage();
    // Also release an uncertain registration; clientId prevents cancelling a different worker.
    if (connectAttempted) await request('/bridge/pause', {}, null).catch(() => {});
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node --env-file=.env linux-worker.mjs [--login]\n--login: 人工登录/验证，需要可显示的浏览器窗口。默认：使用专用持久会话运行无头 Chromium。');
    return;
  }
  if (args.some(arg => arg !== '--login')) throw new Error('未知参数，请使用 --help 查看用法');
  const login = args.includes('--login');
  const config = login ? null : bridgeConfig();
  const profile = resolve(process.env.DEEPSEEK_PROFILE_DIR || '.deepseek-profile');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(profile, 0o700);
  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch { throw new Error('请先 npm ci，再执行 npx playwright install --with-deps chromium'); }
  // A dedicated profile stores the user's session. Do not reuse a personal Chrome profile.
  const context = await chromium.launchPersistentContext(profile, {
    headless: !login, channel: 'chromium', chromiumSandbox: true,
    viewport: { width: 1280, height: 900 }
  });
  const page = context.pages()[0] || await context.newPage();
  const controller = new AbortController();
  const stop = () => { controller.abort(); void context.close().catch(() => {}); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (login) {
      if (!process.stdin.isTTY) throw new Error('登录模式需要交互式终端；SSH 请使用 -t，并配置 X11 转发或远程桌面');
      console.log('请在打开的 Chromium 中人工登录/完成验证，关闭深度思考和联网搜索，并新建空白对话。');
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      try { await terminal.question('完成后在本终端按 Enter 保存会话：', { signal: controller.signal }); }
      finally { terminal.close(); }
      await installPageBridge(page);
      await checkPageReady(page);
      console.log('会话已保存。关闭这个登录进程后，可运行 npm run linux:start。');
    } else {
      await page.locator('textarea[placeholder*="DeepSeek"]').waitFor({ state: 'visible', timeout: 30000 });
      await runBridgeWorker({ page, ...config, signal: controller.signal });
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      await mkdir('.local-test', { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') await chmod('.local-test', 0o700);
      await page.screenshot({ path: '.local-test/linux-worker-error.png' }).catch(() => {});
      throw new Error(`${error.message}\n桥接已停止。请查看 .local-test/linux-worker-error.png，并用 npm run linux:login 处理登录/验证码/草稿后手动重启。不自动重发题目。`);
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await context.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

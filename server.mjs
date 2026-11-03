import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

class BridgeError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const failure = (status, message) => new BridgeError(status, message);

function buildPrompt(input) {
  // 用自然语言提问：正常对话里没人会贴 JSON 和任务编号，那种格式本身就是一个明显的机器特征
  const hint = {
    single: '单选题，只选一个。',
    multiple: '多选题，有几个选几个，用顿号隔开。',
    judgement: '判断题，写「对」或「错」。',
    completion: '填空题，按顺序写要填的内容。',
    fill: '填空题，按顺序写要填的内容。'
  }[input.type] || '';
  const options = input.options.length
    ? `\n\n选项：\n${input.options.map((option, index) => `${String.fromCharCode(65 + index)}. ${option}`).join('\n')}`
    : '';
  return '帮我看看这道题，先简单说下理由，最后一行写「答案：X」就行，答案后面别加括号说明。' + hint +
    '如果这道题没有唯一答案（主观题、要结合个人情况写），直接写「无法作答」并说明原因，不要编一个答案。' +
    `\n\n题目：${input.question}${options}`;
}

class BridgeQueue {
  constructor({ jobTimeoutMs = 150000, maxQueue = 3, heartbeatTimeoutMs = 180000, logger = () => {} } = {}) {
    this.jobTimeoutMs = jobTimeoutMs;
    this.maxQueue = maxQueue;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.logger = logger;
    this.worker = null;
    this.jobs = [];
    this.lastError = null;
  }
  /** 记录最近一次失败，成功后清空；/health 与请求日志靠它说明“为什么没反应” */
  note(status, message) { this.lastError = { status, message, at: new Date().toISOString() }; }
  check() {
    if (this.worker && Date.now() - this.worker.seen > this.heartbeatTimeoutMs) {
      this.pause(failure(503, 'DeepSeek 网页连接已中断，请在网页重新启动桥接'));
    }
  }
  status() {
    this.check();
    return { connected: !!this.worker, queued: this.jobs.length, lastError: this.lastError,
      lastSeenAgoMs: this.worker ? Date.now() - this.worker.seen : null };
  }
  connect(clientId) {
    this.check();
    if (this.worker && this.worker.id !== clientId) throw failure(409, '另一个 DeepSeek 标签页已连接，请先暂停该页面');
    // 调用方已放弃的任务只是等网页答完丢弃结果，不应阻止新面板重新连接
    for (const job of this.jobs.filter(item => item.abandoned)) this.settle(job);
    if (this.jobs.length) throw failure(409, '仍有任务运行，请先暂停桥接');
    this.worker = { id: clientId, seen: Date.now() };
    this.lastError = null;
  }
  touch(clientId) {
    this.check();
    if (!this.worker || this.worker.id !== clientId) throw failure(409, '桥接已暂停或由其他页面持有，请手动重新启动');
    const gap = Date.now() - this.worker.seen;
    // 心跳 5 秒一次、轮询 200ms 一次；超过 6 秒没有任何请求，说明页面在这段时间里没跑 JS
    if (gap > 6000) {
      const now = new Date();
      const stamp = [now.getHours(), now.getMinutes(), now.getSeconds()].map(value => String(value).padStart(2, '0')).join(':');
      this.logger(`${stamp} ⚠ 桥接静默 ${(gap / 1000).toFixed(1)}s 后恢复：这段时间页面没有发出任何请求`);
    }
    this.worker.seen = Date.now();
  }
  /** 结束调用方等待，但不一定把任务移出队列：题目可能已经在网页上生成 */
  finish(job, error, value) {
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.abort);
    if (job.done) return;
    job.done = true;
    if (error) job.reject(error); else job.resolve(value);
  }
  settle(job, error, value) {
    const index = this.jobs.indexOf(job);
    if (index < 0) return;
    this.jobs.splice(index, 1);
    this.finish(job, error, value);
  }
  pause(error = failure(503, '网页桥接已暂停')) {
    this.worker = null;
    this.note(error.status, error.message);
    for (const job of [...this.jobs]) this.settle(job, error);
  }
  enqueue(input, signal, images = []) {
    this.check();
    if (!this.worker) throw failure(503, '请先在已登录的 DeepSeek 网页启动桥接脚本');
    if (this.jobs.length >= this.maxQueue) throw failure(429, '队列已满，请将 OCS 查询线程数设为 1');
    if (signal?.aborted) throw failure(499, '查询已取消');
    return new Promise((resolve, reject) => {
      const job = { id: randomUUID(), input, images, resolve, reject, claimed: false, abandoned: false, done: false,
        enqueuedAt: Date.now(), deadline: Date.now() + this.jobTimeoutMs, signal };
      job.abort = () => {
        // 调用方（OCS）断开时不暂停桥接：题目可能已经发到网页，等它答完后丢掉结果即可，
        // 否则一次取消会让后续所有搜题都变成 503。
        if (job.claimed) {
          job.abandoned = true;
          this.finish(job, failure(499, 'OCS 已取消本题，网页答完后结果将被丢弃'));
        } else this.settle(job, failure(499, 'OCS 查询已取消，请检查网页后重新启动桥接'));
      };
      job.timer = setTimeout(() => {
        const error = failure(504, '网页解题或排队超时，请检查网页并重新启动桥接');
        if (job.claimed) this.pause(error); else this.settle(job, error);
      }, this.jobTimeoutMs);
      signal?.addEventListener('abort', job.abort, { once: true });
      this.jobs.push(job);
    });
  }
  poll(clientId) {
    this.touch(clientId);
    const job = this.jobs[0];
    if (!job || job.claimed) return null;
    job.claimed = true;
    return { id: job.id, input: job.input, prompt: buildPrompt(job.input), images: job.images, deadline: job.deadline, enqueuedAt: job.enqueuedAt };
  }
  complete(clientId, id, answer) {
    this.touch(clientId);
    const job = this.jobs[0];
    if (!job || !job.claimed || job.id !== id) throw failure(409, '任务已过期或任务编号不匹配');
    // 调用方已经放弃这道题：收下结果并丢弃，桥接不必知道，也不会因此暂停
    if (job.abandoned) { this.settle(job); return; }
    if (Date.now() >= job.deadline) {
      const error = failure(504, '任务已超时，请重新启动桥接');
      this.pause(error);
      throw error;
    }
    if (!answer || answer.bridge_id !== id || !Array.isArray(answer.answers) || answer.answers.length > 100 ||
        answer.answers.some(s => typeof s !== 'string' || !s.trim() || s.length > 12000) ||
        typeof answer.explanation !== 'string' || answer.explanation.length > 12000 ||
        (['single', 'judgement'].includes(job.input.type) && answer.answers.length > 1)) {
      const error = failure(502, '网页回答格式无效，桥接已暂停，请检查回答后重试');
      this.pause(error);
      throw error;
    }
    this.lastError = null;
    this.settle(job, null, { code: 0, message: answer.answers.length ? 'success' : '未得到可靠答案',
      data: answer.answers.length ? [{ question: job.input.question, answer: answer.answers.map(s => s.trim()).join('#'), explanation: answer.explanation }] : [],
      explanation: answer.explanation });
  }
}

async function readJson(req) {
  // text/plain 也接受：页面用 fetch 直连时靠它把请求降级成“简单请求”，从而跳过 CORS 预检
  const type = req.headers['content-type']?.toLowerCase() || '';
  if (!type.startsWith('application/json') && !type.startsWith('text/plain')) throw failure(415, '请使用 application/json 或 text/plain');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) throw failure(413, '请求数据超过 32 KB');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
    return body;
  } catch { throw failure(400, '请求不是有效 JSON 对象'); }
}
// OCS 的图片题常常把 <img src> 或图片地址塞在题干里。这里把图片下载到本地，页面再当成
// “用户选的文件”上传，比把链接当文字发过去更接近真人操作，DeepSeek 也才真的能看见图。
const BLOBS = new Map();
const IMAGE_LIMIT = 3, IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_PATTERN = /<img[^>]+src=["']([^"']+)["']|https?:\/\/[^\s"'<>]+?\.(?:png|jpe?g|gif|webp|bmp)(?:\?[^\s"'<>]*)?/gi;
function findImageUrls(text) {
  const urls = [];
  for (const match of String(text).matchAll(IMAGE_PATTERN)) {
    const url = match[1] || match[0];
    if (url && !urls.includes(url) && urls.length < IMAGE_LIMIT) urls.push(url);
  }
  return urls;
}
function stripImageUrls(text) {
  if (!text) return text;
  return String(text).replace(/<img[^>]*>/gi, ' ').replace(IMAGE_PATTERN, ' ').replace(/\s{2,}/g, ' ').trim();
}
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
function refererFor(url) {
  try {
    const { hostname, origin } = new URL(url);
    // 超星图床有防盗链，只放行自家站点的 Referer
    return /(^|\.)chaoxing\.com$/.test(hostname) ? 'https://mooc1.chaoxing.com/' : origin + '/';
  } catch { return ''; }
}
function sniffImageType(buffer) {
  if (buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (buffer.length > 3 && buffer.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'image/jpeg';
  const head = buffer.subarray(0, 6).toString('ascii');
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  if (buffer.length > 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.subarray(0, 2).toString('ascii') === 'BM') return 'image/bmp';
  return '';
}
async function downloadImage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      signal: controller.signal, redirect: 'follow',
      headers: { 'User-Agent': BROWSER_UA, Referer: refererFor(url), Accept: 'image/avif,image/webp,image/png,image/*;q=0.8' }
    });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > IMAGE_BYTES) return null;
    let type = (response.headers.get('content-type') || '').split(';')[0].trim();
    if (!/^image\//.test(type)) type = sniffImageType(buffer);
    if (!type) return null;
    return { type, buffer };
  } catch { return null; } finally { clearTimeout(timer); }
}
async function prepareImages(text) {
  const images = [], failed = [];
  for (const url of findImageUrls(text)) {
    const file = await downloadImage(url);
    if (!file) { failed.push(url); continue; }
    const id = randomUUID();
    BLOBS.set(id, file);
    while (BLOBS.size > 20) BLOBS.delete(BLOBS.keys().next().value);
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' }[file.type] || 'png';
    images.push({ id, type: file.type, name: `题目图片-${images.length + 1}.${ext}` });
  }
  return { images, failed };
}

function normalize(input) {
  if (typeof input.question !== 'string' || !input.question.trim() || input.question.length > 12000) throw failure(400, 'question 必须为 1–12000 字符的非空字符串');
  let options = input.options ?? [];
  if (typeof options === 'string') options = options.split('\n').filter(s => s.trim());
  if (!Array.isArray(options) || options.length > 100 || options.some(s => typeof s !== 'string')) throw failure(400, 'options 必须是字符串数组或换行分隔的字符串');
  if (input.type !== undefined && (typeof input.type !== 'string' || input.type.length > 40)) throw failure(400, 'type 必须是题型字符串');
  return { question: input.question.trim(), options, type: input.type || 'unknown' };
}

export function createServer({ token, monitorIntervalMs = 250, apiSolver = null, jobTimeoutMs = 150000,
  logger = line => console.log(line), ...settings } = {}) {
  if (!token || token.trim() !== token || /[\r\n]/.test(token)) throw new Error('请设置有效的 API_TOKEN');
  const queue = new BridgeQueue({ ...settings, jobTimeoutMs, logger });
  const monitor = setInterval(() => queue.check(), monitorIntervalMs);
  monitor.unref();
  const routes = new Set(['/search', '/bridge/connect', '/bridge/poll', '/bridge/heartbeat', '/bridge/result', '/bridge/pause']);
  const clock = date => [date.getHours(), date.getMinutes(), date.getSeconds()].map(value => String(value).padStart(2, '0')).join(':');
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let requestPath = req.url;
    let status = 0;
    let note = '';
    const reply = (code, body) => {
      status = code;
      const message = typeof body?.message === 'string' ? body.message : '';
      note = message === 'success' ? '' : message;
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        // 题库配置的 type 被写成 fetch（OCS 默认值）时，浏览器会先发 OPTIONS 预检。
        // 允许任意来源只为了让本机页面能调通，/search 仍然必须带正确的 API_TOKEN。
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
        // 公网 https 页面（如 chat.deepseek.com）直接 fetch 127.0.0.1 时，Chrome 的
        // Local Network Access 预检会要求这个响应头，否则请求被浏览器拦掉。
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '600'
      });
      res.end(code === 204 ? undefined : JSON.stringify(body));
    };
    try {
      requestPath = new URL(req.url, 'http://127.0.0.1').pathname;
      if (req.method === 'OPTIONS') return reply(204, {});
      // OCS 4.15.3 probes the origin root; OCS 5.x probes the configured URL with ?t=<timestamp>.
      // Neither probe should authenticate, inspect a question, or enqueue work.
      if (req.method === 'HEAD' && (requestPath === '/' || requestPath === '/search')) {
        return reply(200, {});
      }
      // 桥接脚本把图片取回本地，做成 File 塞进网页的上传控件；id 是随机 UUID，只监听本机
      if (req.method === 'GET' && requestPath.startsWith('/blob/')) {
        const file = BLOBS.get(requestPath.slice(6));
        if (!file) throw failure(404, '图片不存在或已过期');
        status = 200;
        if (!res.destroyed && !res.writableEnded) {
          res.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
          res.end(file.buffer);
        }
        return;
      }
      if (requestPath === '/health' && req.method === 'GET') {
        return reply(200, apiSolver
          ? { status: 'ok', mode: 'deepseek-api', connected: true, queued: 0 }
          : { status: 'ok', mode: 'web-bridge', ...queue.status() });
      }
      if (!routes.has(requestPath)) throw failure(404, '接口不存在');
      if (apiSolver && requestPath !== '/search') throw failure(404, '当前 API 模式不启用网页桥接接口');
      if (req.method !== 'POST') throw failure(405, '请使用 POST');
      const body = await readJson(req);
      // 口令可放 Authorization 头（OCS / 油猴），也可放 body.token：
      // 页面 fetch 用它换掉自定义头，请求就是“简单请求”，不会触发 CORS 预检
      if (req.headers.authorization !== `Bearer ${token}` && body.token !== token) throw failure(401, 'API_TOKEN 不正确');
      if (requestPath === '/search') {
        const input = normalize(body);
        const raw = [input.question, ...input.options].join('\n');
        const { images, failed } = await prepareImages(raw);
        if (images.length || failed.length) {
          // 抓到图就把链接从题干里删掉（页面会把图当文件上传）；没抓到也不留裸链接
          input.question = stripImageUrls(input.question) || '（本题含图片，未能自动获取）';
          input.options = input.options.map(stripImageUrls);
          if (failed.length) logger(`${clock(new Date())} ⚠ ${failed.length} 张图片下载失败：${failed[0].slice(0, 120)}`);
        }
        const abort = new AbortController();
        const onClose = () => { if (!res.writableEnded) abort.abort(); };
        res.on('close', onClose);
        try {
          if (apiSolver) {
            const answer = await apiSolver(input, abort.signal);
            if (!answer || !Array.isArray(answer.answers) || answer.answers.length > 100 ||
                answer.answers.some(value => typeof value !== 'string' || !value.trim() || value.length > 12000) ||
                typeof answer.explanation !== 'string' || answer.explanation.length > 12000 ||
                (['single', 'judgement'].includes(input.type) && answer.answers.length > 1)) {
              throw failure(502, 'DeepSeek API 返回的答案格式无效');
            }
            reply(200, { code: 0, message: answer.answers.length ? 'success' : '未得到可靠答案',
              data: answer.answers.length ? [{ question: input.question, answer: answer.answers.map(value => value.trim()).join('#'), explanation: answer.explanation }] : [],
              explanation: answer.explanation });
          } else {
            reply(200, await queue.enqueue(input, abort.signal, images));
          }
        }
        finally { res.off('close', onClose); }
        return;
      }
      const { clientId } = body;
      if (typeof clientId !== 'string' || !/^[\w-]{1,100}$/.test(clientId)) throw failure(400, 'clientId 无效');
      if (requestPath === '/bridge/connect') {
        queue.connect(clientId);
        const version = typeof body.version === 'string' ? body.version.slice(0, 20) : '';
        return reply(200, { code: 0, message: version ? `桥接脚本 v${version}` : '' });
      }
      if (requestPath === '/bridge/heartbeat') queue.touch(clientId);
      if (requestPath === '/bridge/poll') {
        const job = queue.poll(clientId);
        // 空轮询不打印；只有真正领取到题目时才留一行，便于区分“排队中”和“网页在生成”
        return reply(200, { code: 0, job, message: job ? `领取题目（排队 ${Date.now() - job.enqueuedAt}ms）` : '' });
      }
      if (requestPath === '/bridge/result') queue.complete(clientId, body.id, body.answer);
      if (requestPath === '/bridge/pause') { queue.touch(clientId); queue.pause(); }
      reply(200, { code: 0 });
    } catch (error) {
      const known = error instanceof BridgeError || Number.isInteger(error?.status);
      const code = known ? error.status : 500;
      const message = known ? error.message : '本地桥接服务错误';
      // 404 只是有东西访问了不存在的路径（例如 favicon），不写进 lastError 覆盖真正的原因
      if (code !== 404) queue.note(code, message);
      reply(code, { code, message, data: [] });
    } finally {
      // 桥接每 200ms 轮询一次：空的成功轮询和心跳不打印，其余一律打印（含 OCS 打过来的请求）。
      const elapsed = Date.now() - started;
      const silent = status === 204 || (status === 200 && (requestPath === '/bridge/heartbeat' || (requestPath === '/bridge/poll' && !note)));
      if (!silent) {
        const slow = requestPath === '/search' && status === 200 && elapsed > 45000
          ? '（生成很慢：可在 DeepSeek 页面关闭深度思考/联网搜索，或新开一个对话）' : '';
        // 长请求打印“完成时间 + 耗时 + 开始时间”，否则日志顺序看起来会错乱
        const began = elapsed > 1000 ? `（${clock(new Date(started))} 开始）` : '';
        logger(`${clock(new Date())} ${req.method} ${requestPath} → ${status} ${elapsed}ms${began}${note ? ` · ${note}` : ''}${slow}`);
      }
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.on('close', () => { clearInterval(monitor); queue.pause(); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const backend = process.env.BACKEND || 'web-bridge';
    if (!['web-bridge', 'deepseek-api'].includes(backend)) throw new Error('BACKEND 只能是 web-bridge 或 deepseek-api');
    const port = Number(process.env.PORT || 3000);
    const seconds = Number(process.env.JOB_TIMEOUT_SECONDS || 150);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须在 1–65535 之间');
    if (!Number.isFinite(seconds) || seconds < 10 || seconds > 170) throw new Error('JOB_TIMEOUT_SECONDS 必须在 10–170 之间');
    let apiSolver = null;
    if (backend === 'deepseek-api') {
      const { createDeepSeekApiSolver } = await import('./deepseek-api.mjs');
      apiSolver = createDeepSeekApiSolver({ apiKey: process.env.DEEPSEEK_API_KEY, model: process.env.DEEPSEEK_MODEL || 'deepseek-flash', timeoutMs: seconds * 1000 });
    }
    const server = createServer({ token: process.env.API_TOKEN, jobTimeoutMs: seconds * 1000, apiSolver });
    server.on('error', error => { console.error(`启动失败：${error.code}`); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log(backend === 'deepseek-api'
      ? `OCS DeepSeek API 后端：http://127.0.0.1:${port}\n此模式会按 DeepSeek API 实时价格计费。`
      : `OCS 网页桥接：http://127.0.0.1:${port}（单题超时 ${seconds} 秒）\n请在 DeepSeek 网页桥接面板点击“启动”。不需要 DeepSeek API 密钥。\n这里会打印每条请求：OCS 搜题时应当出现 POST /search 一行。`));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

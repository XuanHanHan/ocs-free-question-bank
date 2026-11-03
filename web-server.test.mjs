import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from './server.mjs';
import { createDeepSeekApiSolver } from './deepseek-api.mjs';
const question = { question: '哪些是质数？', options: '2\n3\n4', type: 'multiple' };
const answer = id => ({ bridge_id: id, answers: ['2', '3'], explanation: '质数只有两个正因数。' });
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
test('OCS 4.15 and 5.1 unauthenticated HEAD probes return 200 without queuing a question', async t => {
  const { base } = await fixture(t);
  for (const path of ['/', '/?t=1790049000000', '/search?t=1791532800000']) {
    const response = await fetch(base + path, { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '');
  }
  const health = await (await fetch(base + '/health')).json();
  assert.equal(health.connected, false);
  assert.equal(health.queued, 0);
  const search = await fetch(base + '/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(question) });
  assert.equal(search.status, 401);
});
async function fixture(t, settings = {}) {
  const server = createServer({ token: 'test-token', logger: () => {}, ...settings });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, token = 'test-token', signal) => fetch(base + path, { method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const call = async (path, body = {}) => (await post(path, { clientId: 'browser-1', ...body })).json();
  return { base, post, call };
}
async function claim(call) {
  for (let i = 0; i < 50; i++) {
    const result = await call('/bridge/poll');
    if (result.job) return result.job;
    await tick();
  }
  assert.fail('Job was not queued');
}
test('no DeepSeek key needed; authentication and validation', async t => {
  const { base, post } = await fixture(t);
  assert.equal((await (await fetch(base + '/health')).json()).mode, 'web-bridge');
  assert.equal((await post('/search', question, 'wrong')).status, 401);
  assert.equal((await post('/search', { question: '' })).status, 400);
  assert.equal((await post('/search', { ...question, options: [1] })).status, 400);
  assert.equal((await post('/search', question)).status, 503);
  assert.equal((await post('/bridge/connect', {})).status, 400);
  assert.equal((await post('/search', { ...question, question: 'x'.repeat(40000) })).status, 413);
  // 页面 fetch 走“简单请求”：不给 Authorization 头，口令放 body.token
  const plain = body => fetch(base + '/search', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) });
  assert.equal((await plain({ ...question, token: 'test-token' })).status, 503);
  assert.equal((await plain({ ...question, token: 'wrong' })).status, 401);
  assert.equal((await plain(question)).status, 401);
});
test('browser returns answer through actual HTTP and OCS handler', async t => {
  const { post, call } = await fixture(t);
  await call('/bridge/connect');
  const waiting = post('/search', question);
  const job = await claim(call);
  assert.deepEqual(job.input.options, ['2', '3', '4']);
  assert.ok(job.prompt.includes(job.input.question));
  assert.equal((await call('/bridge/poll')).job, null);
  await call('/bridge/result', { id: job.id, answer: answer(job.id) });
  const result = await (await waiting).json();
  assert.deepEqual(result.data, [{ question: question.question, answer: '2#3', explanation: '质数只有两个正因数。' }]);
  const [wrapper] = JSON.parse(await readFile(new URL('./ocs-config.json', import.meta.url), 'utf8'));
  assert.deepEqual(Function(wrapper.handler)()(result), [[question.question, '2#3']]);
});
test('DeepSeek API backend answers OCS search without a browser bridge', async t => {
  let request;
  const apiSolver = createDeepSeekApiSolver({ apiKey: 'test-api-key', fetchImpl: async (url, options) => {
    request = { url, ...options, body: JSON.parse(options.body) };
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"answers":["2","3"],"explanation":"2和3是质数。"}' } }] });
  } });
  const { base, post } = await fixture(t, { apiSolver });
  const health = await (await fetch(base + '/health')).json();
  assert.deepEqual(health, { status: 'ok', mode: 'deepseek-api', connected: true, queued: 0 });
  assert.equal((await post('/bridge/connect', { clientId: 'unused' })).status, 404);
  const response = await post('/search', question);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, [{ question: question.question, answer: '2#3', explanation: '2和3是质数。' }]);
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(request.headers.Authorization, 'Bearer test-api-key');
  assert.equal(request.body.model, 'deepseek-flash');
  assert.deepEqual(request.body.response_format, { type: 'json_object' });
  assert.equal(request.body.messages[1].content, JSON.stringify({ question: question.question, options: ['2', '3', '4'], type: 'multiple' }));
});
test('DeepSeek API backend reports provider errors without exposing credentials', async t => {
  const apiSolver = createDeepSeekApiSolver({ apiKey: 'secret-key', fetchImpl: async () => new Response('', { status: 429 }) });
  const { post } = await fixture(t, { apiSolver });
  const response = await post('/search', question);
  assert.equal(response.status, 429);
  const body = await response.json();
  assert.match(body.message, /余额不足或请求频率受限/);
  assert.doesNotMatch(JSON.stringify(body), /secret-key/);
});
test('serial queue, capacity, exclusive browser and stale replies', async t => {
  const { post, call } = await fixture(t, { maxQueue: 2 });
  await call('/bridge/connect');
  assert.equal((await post('/bridge/connect', { clientId: 'browser-2' })).status, 409);
  const first = post('/search', question);
  const a = await claim(call);
  const second = post('/search', { ...question, question: '第二题' });
  await tick();
  assert.equal((await call('/bridge/poll')).job, null);
  assert.equal((await post('/search', question)).status, 429);
  assert.equal((await call('/bridge/result', { id: 'wrong', answer: answer('wrong') })).code, 409);
  assert.equal((await post('/bridge/result', { clientId: 'browser-2', id: a.id, answer: answer(a.id) })).status, 409);
  await call('/bridge/result', { id: a.id, answer: answer(a.id) });
  assert.equal((await first).status, 200);
  const b = await claim(call);
  assert.equal(b.input.question, '第二题');
  assert.equal((await call('/bridge/result', { id: a.id, answer: answer(a.id) })).code, 409);
  await call('/bridge/result', { id: b.id, answer: { ...answer(b.id), answers: [] } });
  assert.deepEqual((await (await second).json()).data, []);
});
test('invalid answers fail search and pause bridge', async t => {
  const { post, call } = await fixture(t);
  await call('/bridge/connect');
  const waiting = post('/search', { ...question, type: 'single' });
  const job = await claim(call);
  assert.equal((await call('/bridge/result', { id: job.id, answer: answer(job.id) })).code, 502);
  assert.equal((await waiting).status, 502);
  assert.equal((await post('/search', question)).status, 503);
});
test('timeout pauses bridge and rejects late replies', async t => {
  const { post, call } = await fixture(t, { jobTimeoutMs: 80 });
  await call('/bridge/connect');
  const waiting = post('/search', question);
  const job = await claim(call);
  assert.equal((await waiting).status, 504);
  assert.equal((await call('/bridge/result', { id: job.id, answer: answer(job.id) })).code, 409);
  assert.equal((await post('/search', question)).status, 503);
});
test('manual pause cancels active and queued requests', async t => {
  const { post, call } = await fixture(t);
  await call('/bridge/connect');
  const waiting = post('/search', question);
  await claim(call);
  const pending = post('/search', question);
  await tick();
  await call('/bridge/pause', { message: '请处理验证码' });
  assert.equal((await waiting).status, 503);
  assert.equal((await pending).status, 503);
  assert.equal((await call('/bridge/poll')).code, 409);
  assert.equal((await call('/bridge/connect')).code, 0);
});
test('lost heartbeat cancels work', async t => {
  const { post, call } = await fixture(t, { heartbeatTimeoutMs: 35, monitorIntervalMs: 10 });
  await call('/bridge/connect');
  const waiting = post('/search', question);
  await claim(call);
  assert.equal((await waiting).status, 503);
  assert.equal((await call('/bridge/heartbeat')).code, 409);
});
test('OCS disconnection discards the job without pausing the bridge', async t => {
  const { base, post, call } = await fixture(t);
  await call('/bridge/connect');
  const controller = new AbortController();
  const waiting = post('/search', question, 'test-token', controller.signal);
  const rejected = assert.rejects(waiting, { name: 'AbortError' });
  const job = await claim(call);
  controller.abort();
  await rejected;
  const health = await (await fetch(base + '/health')).json();
  assert.equal(health.connected, true);
  assert.equal(health.queued, 1);
  assert.ok(health.lastSeenAgoMs >= 0, 'health 应暴露桥接最后一次联系距今的毫秒数');
  // 迟到的结果被安静收下，桥接不会因此停止，下一题照常
  assert.equal((await call('/bridge/result', { id: job.id, answer: answer(job.id) })).code, 0);
  assert.equal((await (await fetch(base + '/health')).json()).queued, 0);
  const next = post('/search', { ...question, question: '下一题' });
  const second = await claim(call);
  await call('/bridge/result', { id: second.id, answer: answer(second.id) });
  assert.equal((await next).status, 200);
});
test('routes tolerate query strings so OCS cache-busting URLs keep working', async t => {
  const { base } = await fixture(t);
  const stamp = Date.now();
  assert.equal((await fetch(`${base}/health?t=${stamp}`)).status, 200);
  assert.equal((await fetch(`${base}/search?t=${stamp}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify(question) })).status, 503);
});
test('OPTIONS preflight is answered so a fetch-type bank config still works', async t => {
  const { base } = await fixture(t);
  const response = await fetch(base + '/search', { method: 'OPTIONS', headers: {
    Origin: 'https://chaoxing.com', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.match(response.headers.get('access-control-allow-headers'), /Authorization/i);
  assert.equal(response.headers.get('access-control-allow-private-network'), 'true');
});
test('ocs:config output keeps the real token and other headers', async () => {
  const { applyToken } = await import('./print-ocs-config.mjs');
  const [bank] = applyToken([{ name: 'x', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer 替换为你自己的随机口令' } }], ' OCS-1234 ');
  assert.equal(bank.headers.Authorization, 'Bearer OCS-1234');
  assert.equal(bank.headers['Content-Type'], 'application/json');
  assert.throws(() => applyToken([], '   '), /API_TOKEN/);
});
test('each OCS request is logged with status and duration; health keeps the last error', async t => {
  const lines = [];
  const { base, post, call } = await fixture(t, { logger: line => lines.push(line) });
  assert.equal((await post('/search', question, 'wrong')).status, 401);
  assert.equal((await (await fetch(base + '/health')).json()).lastError.status, 401);
  assert.equal((await post('/search', question)).status, 503);
  const log = lines.join('\n');
  assert.match(log, /POST \/search → 401 \d+ms · API_TOKEN 不正确/);
  assert.match(log, /POST \/search → 503 \d+ms/);
  const health = await (await fetch(base + '/health')).json();
  assert.equal(health.lastError.status, 503);
  assert.match(health.lastError.message, /启动桥接/);
  // 领取题目时留一行，便于区分“排队中”和“网页在生成”
  await call('/bridge/connect', { version: '9.9.9' });
  const waiting = post('/search', question);
  const job = await claim(call);
  await call('/bridge/result', { id: job.id, answer: answer(job.id) });
  assert.equal((await waiting).status, 200);
  assert.match(lines.join('\n'), /POST \/bridge\/poll → 200 \d+ms · 领取题目（排队 \d+ms）/);
  assert.match(lines.join('\n'), /POST \/bridge\/connect → 200 \d+ms · 桥接脚本 v9\.9\.9/);
});
test('downloads images embedded in the question and serves them back as blobs', async t => {
  const { createServer: createHttpServer } = await import('node:http');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex');
  const imageServer = createHttpServer((req, res) => { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png); });
  await new Promise(resolve => imageServer.listen(0, '127.0.0.1', resolve));
  t.after(() => imageServer.close());
  const url = `http://127.0.0.1:${imageServer.address().port}/pic.png`;

  const { base, post, call } = await fixture(t);
  await call('/bridge/connect');
  const waiting = post('/search', { question: `看图作答 <img src="${url}">`, options: ['A. 对'], type: 'multiple' });
  const job = await claim(call);
  assert.equal(job.images.length, 1);
  assert.equal(job.images[0].type, 'image/png');
  assert.equal(job.input.question.includes('pic.png'), false, '题干里的图片地址应被移除');
  const blob = await fetch(`${base}/blob/${job.images[0].id}`);
  assert.equal(blob.status, 200);
  assert.equal(blob.headers.get('content-type'), 'image/png');
  assert.equal((await blob.arrayBuffer()).byteLength, png.length);
  await call('/bridge/result', { id: job.id, answer: answer(job.id) });
  assert.equal((await waiting).status, 200);
});

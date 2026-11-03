import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from './server.mjs';
import { bridgeConfig, runBridgeWorker } from './linux-worker.mjs';

let browser;
before(async () => { browser = await chromium.launch({ headless: true, channel: process.env.TEST_BROWSER_CHANNEL || 'chromium', chromiumSandbox: true }); });
after(async () => { await browser?.close(); });

async function fixture(t, { draft = '', generate = true } = {}) {
  const server = createServer({ token: 'test-token', heartbeatTimeoutMs: 2000, monitorIntervalMs: 20, logger: () => {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${server.address().port}`;
  const page = await browser.newPage();
  // No DeepSeek account or API request is used. Exercise the real browser DOM and local HTTP bridge.
  await page.route('**/*', route => route.abort());
  await page.setContent(`<textarea placeholder="DeepSeek"></textarea>
    <div role="button" class="ds-button--primary ds-button--circle" aria-disabled="true">发送</div>
    <script>
      window.sent = 0;
      const input = document.querySelector('textarea'), button = document.querySelector('[role=button]');
      input.addEventListener('input', () => button.setAttribute('aria-disabled', input.value ? 'false' : 'true'));
      button.addEventListener('click', () => {
        window.sent++;
        input.value = '';
        button.setAttribute('aria-disabled', 'true');
        button.innerHTML = '<span class="ds-loading">生成中</span>';
        if (${generate}) setTimeout(() => {
          const reply = document.createElement('div');
          reply.className = 'ds-assistant-message-main-content';
          reply.textContent = '2和3是质数。\\n答案：2、3';
          document.body.append(reply);
          button.innerHTML = '发送';
        }, 250);
      });
    </script>`);
  await page.locator('textarea').fill(draft);
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' };
  const post = (path, body, signal) => fetch(address + path, { method: 'POST', headers, body: JSON.stringify(body), signal });
  const health = async () => (await fetch(address + '/health')).json();
  const controller = new AbortController();
  let done;
  const start = () => {
    done = runBridgeWorker({ page, address, token: 'test-token', signal: controller.signal, log: () => {}, pollMs: 20, heartbeatMs: 30 })
      .then(() => ({ error: null }), error => ({ error }));
    return done;
  };
  t.after(async () => {
    controller.abort();
    if (done) await done;
    await page.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { page, post, health, controller, start };
}

async function until(check) {
  // 分片输入把单题耗时拉到数秒，轮询上限相应放宽到 20 秒
  for (let i = 0; i < 1000; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Expected worker state was not reached');
}

test('headless configuration accepts only the local bridge and never the paid API mode', () => {
  assert.deepEqual(bridgeConfig({ API_TOKEN: 'simple', PORT: '3456' }), { address: 'http://127.0.0.1:3456', token: 'simple' });
  assert.throws(() => bridgeConfig({ API_TOKEN: 'x', BRIDGE_URL: 'https://example.com' }), /BRIDGE_URL/);
  assert.throws(() => bridgeConfig({ API_TOKEN: 'x', BACKEND: 'deepseek-api' }), /web-bridge/);
});

test('real headless Chromium sends two questions serially and returns OCS answers', { timeout: 45000 }, async t => {
  const f = await fixture(t);
  const done = f.start();
  await until(async () => (await f.health()).connected);
  for (const question of ['哪些是质数？', '再次判断哪些是质数？']) {
    const response = await f.post('/search', { question, options: ['2', '3', '4'], type: 'multiple' });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, [{ question, answer: '2#3', explanation: '2和3是质数。' }]);
  }
  assert.equal(await f.page.evaluate(() => window.sent), 2);
  f.controller.abort();
  assert.equal((await done).error, null);
  assert.equal((await f.health()).connected, false);
});

test('drafts and another registered browser stop the worker without sending or stealing ownership', { timeout: 10000 }, async t => {
  const signedOut = await fixture(t);
  await signedOut.page.setContent('<p>请登录 DeepSeek</p>');
  assert.match((await signedOut.start()).error.message, /控件|登录/);
  assert.equal((await signedOut.health()).connected, false);
  const draft = await fixture(t, { draft: '不要覆盖' });
  assert.match((await draft.start()).error.message, /草稿/);
  assert.equal((await draft.health()).connected, false);
  assert.equal(await draft.page.evaluate(() => window.sent), 0);
  const occupied = await fixture(t);
  await occupied.post('/bridge/connect', { clientId: 'windows-browser' });
  assert.match((await occupied.start()).error.message, /另一个/);
  assert.equal((await occupied.health()).connected, true);
  assert.equal(await occupied.page.evaluate(() => window.sent), 0);
});

test('OCS cancellation keeps the worker alive and never repeats a send', { timeout: 30000 }, async t => {
  const f = await fixture(t, { generate: false });
  const done = f.start();
  await until(async () => (await f.health()).connected);
  const request = new AbortController();
  const waiting = f.post('/search', { question: '取消此题', options: [], type: 'unknown' }, request.signal);
  const rejected = assert.rejects(waiting, { name: 'AbortError' });
  await until(async () => await f.page.evaluate(() => window.sent) === 1);
  request.abort();
  await rejected;
  // 调用方取消只丢弃本题：worker 继续持有注册，题目也只发送一次
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await f.health()).connected, true);
  assert.equal(await f.page.evaluate(() => window.sent), 1);
  f.controller.abort();
  assert.equal((await done).error, null);
  assert.equal((await f.health()).connected, false);
});

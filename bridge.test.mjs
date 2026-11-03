import test from 'node:test';
import assert from 'node:assert/strict';
const bridge = await import('./deepseek-bridge.user.js').then(m => m.default).catch(() => ({}));
test('bridge protocol and runner are implemented', () => assert.equal(typeof bridge.runJob, 'function'));
test('parses natural 「答案：X」 replies and still tolerates JSON', { skip: !bridge.parseAnswer }, () => {
  const cases = [
    ['答案：A、C', ['A', 'C']],
    ['答案：A', ['A']],
    ['**答案：对**', ['对']],
    ['答案是 A 和 C', ['A', 'C']],
    ['答案：A B C', ['A', 'B', 'C']],
    ['A、C', ['A', 'C']],
    ['答案：x = 2', ['x = 2']]
  ];
  for (const [text, answers] of cases) assert.deepEqual(bridge.parseAnswer(text)?.answers, answers, text);
  // 认不出来的短句不能当成答案塞给 OCS
  assert.equal(bridge.parseAnswer('这道题我不确定'), null);
  assert.equal(bridge.parseAnswer(''), null);
  const json = '{"answers":["2"],"explanation":"解析"}';
  assert.deepEqual(bridge.parseAnswer(json), { answers: ['2'], explanation: '解析' });
  assert.deepEqual(bridge.parseAnswer('说明\n```json\n' + json + '\n```'), { answers: ['2'], explanation: '解析' });
});
test('explanation comes from the text before the answer line', { skip: !bridge.parseAnswer }, () => {
  assert.deepEqual(bridge.parseAnswer('2 和 3 是质数。\n答案：2、3'),
    { answers: ['2', '3'], explanation: '2 和 3 是质数。' });
});
function harness({ draft = '', answerText = '2 和 3 是质数。\n答案：2、3', existing = 0, frozen = false,
  streaming = false, busyMs = 0, cancel = false } = {}) {
  let now = 0, clicks = 0, sentAt = null, text = draft;
  const expected = { bridge_id: 'job-1', answers: ['2', '3'], explanation: '2 和 3 是质数。' };
  const ui = {
    draft: () => text,
    isIdle: () => sentAt === null ? now >= busyMs : now >= sentAt + 1000,
    fill: value => { text = value; },
    canSend: () => text.trim().length > 0,
    clickSend: () => { clicks++; text = ''; sentAt = now; },
    count: () => frozen ? existing : existing + (sentAt === null ? 0 : 1),
    replies: () => {
      if (sentAt === null) return existing ? ['旧题目\n答案：A'] : [];
      return [streaming ? answerText.slice(0, 6 + ((now - sentAt) % 4)) : answerText];
    },
    url: () => 'https://chat.deepseek.com/a/chat/s/test',
    check: () => {}
  };
  const options = { now: () => now, sleep: async ms => { now += ms; }, running: () => !cancel, typing: false };
  return { ui, options, expected, clicks: () => clicks, sentAt: () => sentAt };
}
const job = { id: 'job-1', prompt: '测试题', deadline: 10000 };
test('send exactly once and return as soon as the reply stops changing', { skip: !bridge.runJob }, async () => {
  const h = harness();
  assert.deepEqual(await bridge.runJob(job, h.ui, h.options), h.expected);
  assert.equal(h.clicks(), 1);
  // 只等回复稳定 600ms，不等网页的“生成中”状态结束（实测可晚 90 秒）
  assert.ok(h.options.now() >= 600, `waited ${h.options.now()}ms`);
  assert.ok(h.options.now() < 2000, `waited ${h.options.now()}ms for an already complete answer`);
});
test('types the prompt in chunks with jitter instead of pasting it in one shot', { skip: !bridge.runJob }, async () => {
  const h = harness();
  let fills = 0;
  const fill = h.ui.fill;
  h.ui.fill = value => { fills++; fill(value); };
  const longJob = { ...job, prompt: '题干'.repeat(80) };
  assert.deepEqual(await bridge.runJob(longJob, h.ui, { ...h.options, typing: true, random: () => 0.5 }), h.expected);
  assert.ok(fills >= 10, `分片写入次数 ${fills}`);
  assert.equal(h.clicks(), 1);
});
test('do not overwrite a draft or send cancelled tasks', { skip: !bridge.runJob }, async () => {
  for (const settings of [{ draft: '用户草稿' }, { cancel: true }]) {
    const h = harness(settings);
    await assert.rejects(bridge.runJob(job, h.ui, h.options));
    assert.equal(h.clicks(), 0);
  }
});
test('answers that existed before sending and unfinished replies are not accepted', { skip: !bridge.runJob }, async () => {
  // frozen: 发送后没有新增回复，即使页面上有一条可解析的旧答案也不能用
  for (const settings of [{ frozen: true, existing: 1 }, { streaming: true }]) {
    const h = harness(settings);
    await assert.rejects(bridge.runJob(job, h.ui, h.options));
    assert.equal(h.clicks(), 1);
  }
});
test('wait for the page to go idle before sending instead of failing', { skip: !bridge.runJob }, async () => {
  const h = harness({ busyMs: 900 });
  assert.deepEqual(await bridge.runJob(job, h.ui, h.options), h.expected);
  assert.ok(h.sentAt() >= 900);
});
test('give up when the page never becomes idle', { skip: !bridge.runJob }, async () => {
  const h = harness({ busyMs: 60000 });
  await assert.rejects(bridge.runJob(job, h.ui, h.options), /超时|仍在生成/);
  assert.equal(h.clicks(), 0);
});

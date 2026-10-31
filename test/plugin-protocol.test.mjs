// 真协议集成测试：把 plugin/sing/index.mjs 当子进程跑起来，这个文件扮演宿主 ——
// 走的正是宿主 docs/PLUGINS.md 里那条 NDJSON 协议，连"能力调用被拒"都按同样形状回应。
// 覆盖：init → callTool(sing_song) → 网关 POST /sing → 轮询 /jobs → cap.media.download → cap.send.file。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

const ENTRY = path.join(import.meta.dirname, '..', 'plugin', 'sing', 'index.mjs');

/** 起一个"假宿主"：收插件的 cap 调用，按剧本回包；同时把 callTool 的最终结果收下来。 */
function createHarness({ settings, secrets = { apiToken: 'tok' }, gateway }) {
  const child = spawn(process.execPath, [ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] });
  const calls = [];
  const inflight = [];
  let finalResult = null;
  let buffer = '';

  const reply = (id, payload) => child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (!line) continue;
      const message = JSON.parse(line);
      // 插件发来的能力调用（带 method）
      if (typeof message.method === 'string') {
        calls.push({ method: message.method, params: message.params });
        try {
          const result = gateway({ method: message.method, params: message.params, calls });
          reply(message.id, { result });
        } catch (error) {
          reply(message.id, { error: { code: error.code || 'E_HOST', message: String(error.message) } });
        }
        continue;
      }
      // callTool 的最终回包
      if (message.id === 'call') {
        finalResult = message;
        inflight.push(message);
      }
    }
  });

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  return {
    child, calls, send,
    init: () => send({ id: 'init', method: 'init', params: { settings } }),
    callTool: (name, args, context) => {
      finalResult = null;   // 每次调用都要重新等回包，否则第二次会拿到上一次的结果
      send({ id: 'call', method: 'callTool', params: { name, args, context } });
    },
    waitResult: async (timeoutMs = 15000) => {
      const startedAt = Date.now();
      while (!finalResult && Date.now() - startedAt < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const captured = finalResult;
      finalResult = null;
      return captured;
    },
    stop: () => child.kill('SIGKILL')
  };
}

const SETTINGS = {
  gatewayUrl: 'https://gw.example.com',
  allowFileOutput: true,   // 本文件测的是「发群文件」那条路
  maxSeconds: 30,
  pollIntervalMs: 1000,
  defaultVoice: 'me'
};

/** 网关剧本：第一次问 /jobs 还在跑，第二次就完成。 */
function gatewayScript() {
  let jobPolls = 0;
  return ({ method, params }) => {
    if (method === 'cap.config.get') return { settings: SETTINGS };
    if (method === 'cap.secrets.get') return { values: { apiToken: 'tok' }, configured: ['apiToken'] };
    if (method === 'cap.log.write') return { ok: true };
    if (method === 'cap.send.file') return { ok: true };
    if (method === 'cap.media.download') return { file: params.name, bytes: 123456, contentType: 'audio/mpeg' };
    if (method === 'cap.http.request') {
      const url = new URL(params.url);
      if (url.pathname === '/sing') return { status: 202, body: JSON.stringify({ ok: true, jobId: 'abc123def456', state: 'queued' }) };
      if (url.pathname.startsWith('/jobs/')) {
        jobPolls += 1;
        if (jobPolls === 1) return { status: 200, body: JSON.stringify({ ok: true, state: 'running', progress: 0.4 }) };
        return {
          status: 200,
          body: JSON.stringify({
            ok: true, state: 'done', progress: 1, title: '测试曲', artist: '测试歌手',
            engine: 'command', audioUrl: '/files/out-abc123def456.mp3', bytes: 123456, seconds: 42
          })
        };
      }
      if (url.pathname === '/say/status') {
        return {
          status: 200,
          body: JSON.stringify({ ok: true, engine: 'breeze', online: true, hasKey: true, hasVoice: true,
            voiceId: 'voc_test', model: 'breeze-tts-2', balance: 1362.4, note: '' })
        };
      }
      if (url.pathname === '/say/voices') {
        return {
          status: 200,
          body: JSON.stringify({ ok: true, items: [
            { id: 'voc_a', name: '大肥鱼（迷糊版）' },
            { id: 'voc_b', name: '大肥鱼（机灵版）' },
            { id: 'voc_c', name: '哈基米娘' }
          ] })
        };
      }
      if (url.pathname === '/say/config') {
        return { status: 200, body: JSON.stringify({ ok: true, hasKey: true, voiceId: 'voc_a' }) };
      }
      if (url.pathname === '/health') {
        return { status: 200, body: JSON.stringify({ ok: true, engine: 'command', voices: ['me'], version: '0.1.0' }) };
      }
      if (url.pathname === '/search') {
        return { status: 200, body: JSON.stringify({ ok: true, items: [{ id: '1', title: '测试曲', artist: '测试歌手', durationSec: 200, source: 'itunes' }] }) };
      }
      throw Object.assign(new Error(`剧本里没有这个地址：${url.pathname}`), { code: 'E_SCRIPT' });
    }
    throw Object.assign(new Error(`剧本里没有这个能力：${method}`), { code: 'E_SCRIPT' });
  };
}

test('sing_song：点歌全链路（POST /sing → 轮询 → 下载 → 发群文件）', async () => {
  const harness = createHarness({ settings: SETTINGS, gateway: gatewayScript() });
  try {
    harness.init();
    await new Promise((resolve) => setTimeout(resolve, 50));
    harness.callTool('sing_song', { song: '测试曲', maxSeconds: 30 }, { chatKey: 'group:123456' });
    const message = await harness.waitResult();
    assert.ok(message, '插件没有回包');
    assert.equal(message.error, undefined, `插件报错：${message.error?.message}`);
    assert.equal(message.result.ok, true);
    assert.equal(message.result.sent, true);
    assert.equal(message.result.title, '测试曲');
    assert.equal(message.result.engine, 'command');
    assert.equal(message.result.duration, '42 秒');

    // 发文件的参数：群号来自 context.chatKey，文件名带 .mp3 且满足宿主白名单正则
    const sent = harness.calls.find((call) => call.method === 'cap.send.file');
    assert.equal(sent.params.chatKey, 'group:123456');
    assert.match(sent.params.file, /^sing-[0-9a-f]+\.mp3$/);
    assert.match(sent.params.name, /测试曲 - 测试歌手\.mp3$/);

    // 下载走的是 cap.media.download，且带上 Bearer token
    const download = harness.calls.find((call) => call.method === 'cap.media.download');
    assert.equal(download.params.url, 'https://gw.example.com/files/out-abc123def456.mp3');
    assert.deepEqual(download.params.headers, { authorization: 'Bearer tok' });
  } finally {
    harness.stop();
  }
});

test('私聊点歌直接拒绝（host 的 send.file 只支持群聊）', async () => {
  const harness = createHarness({ settings: SETTINGS, gateway: gatewayScript() });
  try {
    harness.init();
    await new Promise((resolve) => setTimeout(resolve, 50));
    harness.callTool('sing_song', { song: '测试曲' }, { chatKey: 'private:10001' });
    const message = await harness.waitResult();
    assert.equal(message.result.ok, false);
    assert.match(message.result.error, /只能在群里点歌/);
    assert.equal(harness.calls.some((call) => call.method === 'cap.http.request'), false);
  } finally {
    harness.stop();
  }
});

test('网关 401 → 报"令牌不对"，不重试也不假装成功', async () => {
  const harness = createHarness({
    settings: SETTINGS,
    gateway: ({ method, params }) => {
      if (method === 'cap.config.get') return { settings: SETTINGS };
      if (method === 'cap.secrets.get') return { values: { apiToken: 'bad' }, configured: ['apiToken'] };
      if (method === 'cap.log.write') return { ok: true };
      if (method === 'cap.http.request') return { status: 401, body: '{"ok":false,"message":"nope"}' };
      throw new Error(`不该走到 ${method}`);
    }
  });
  try {
    harness.init();
    await new Promise((resolve) => setTimeout(resolve, 50));
    harness.callTool('sing_song', { song: '测试曲' }, { chatKey: 'group:1' });
    const message = await harness.waitResult();
    assert.equal(message.error.code, 'E_GATEWAY_AUTH');
    assert.match(message.error.message, /令牌不对/);
  } finally {
    harness.stop();
  }
});

test('sing_status / sing_search 的正常返回', async () => {
  const harness = createHarness({ settings: SETTINGS, gateway: gatewayScript() });
  try {
    harness.init();
    await new Promise((resolve) => setTimeout(resolve, 50));

    harness.callTool('sing_status', {}, { chatKey: 'group:1' });
    const status = await harness.waitResult();
    assert.equal(status.result.ok, true);
    assert.equal(status.result.engine, 'command');
    assert.deepEqual(status.result.voices, ['me']);

    harness.callTool('sing_search', { keyword: '测试' }, { chatKey: 'group:1' });
    const search = await harness.waitResult();
    assert.equal(search.result.count, 1);
    assert.equal(search.result.items[0].title, '测试曲');
    assert.equal(search.result.items[0].duration, '3 分 20 秒');
  } finally {
    harness.stop();
  }
});

test('群文件开关默认关：sing_song 直接拒绝并指路语音条', async () => {
  const settings = { ...SETTINGS, allowFileOutput: false };
  // 脚手架默认把全局 SETTINGS 当配置回给插件，这里必须让它回本次的 settings，
  // 否则"开关关着"这件事根本没传给插件。
  const script = gatewayScript();
  const harness = createHarness({
    settings,
    gateway: ({ method, params }) => (method === 'cap.config.get' ? { settings } : script({ method, params }))
  });
  try {
    harness.init();
    await new Promise((resolve) => setTimeout(resolve, 50));
    harness.callTool('sing_song', { song: '测试曲' }, { chatKey: 'group:1' });
    const message = await harness.waitResult();
    assert.equal(message.result.ok, false);
    assert.match(message.result.error, /群文件输出未开启/);
    assert.match(message.result.error, /send_voice/);
    // 关着的时候不该调任何网关接口，也不该发文件
    assert.equal(harness.calls.some((c) => c.method === 'cap.http.request'), false);
    assert.equal(harness.calls.some((c) => c.method === 'cap.send.file'), false);
  } finally {
    harness.stop();
  }
});

test('say_status：把网关的在线状态与额度原样报出来', async () => {
  const harness = createHarness({ settings: SETTINGS, gateway: gatewayScript() });
  try {
    harness.init();
    await new Promise((resolve) => setTimeout(resolve, 50));
    harness.callTool('say_status', {}, { chatKey: 'group:1' });
    const message = await harness.waitResult();
    assert.equal(message.result.ok, true);
    assert.equal(message.result.online, true);
    assert.equal(message.result.voiceId, 'voc_test');
    assert.equal(message.result.balance, 1362.4);
    assert.equal(message.result.model, 'breeze-tts-2');
  } finally {
    harness.stop();
  }
});

test('say_voices：按关键词过滤音色', async () => {
  const harness = createHarness({ settings: SETTINGS, gateway: gatewayScript() });
  try {
    harness.init();
    await new Promise((resolve) => setTimeout(resolve, 50));
    harness.callTool('say_voices', { keyword: '大肥鱼' }, { chatKey: 'group:1' });
    const message = await harness.waitResult();
    assert.equal(message.result.ok, true);
    assert.equal(message.result.total, 3);
    assert.deepEqual(message.result.items.map((v) => v.id), ['voc_a', 'voc_b']);
  } finally {
    harness.stop();
  }
});

test('插件填了 Breeze Key/音色会推给网关（POST /say/config）', async () => {
  const settings = { ...SETTINGS, breezeVoiceId: 'voc_a' };
  const script = gatewayScript();
  const harness = createHarness({
    settings,
    gateway: ({ method, params }) => {
      if (method === 'cap.config.get') return { settings };
      if (method === 'cap.secrets.get') {
        return { values: { apiToken: 'tok', breezeKey: 'brz_test' }, configured: ['apiToken', 'breezeKey'] };
      }
      return script({ method, params });
    }
  });
  try {
    harness.init();
    await new Promise((resolve) => setTimeout(resolve, 50));
    harness.callTool('say_status', {}, { chatKey: 'group:1' });
    await harness.waitResult();
    const push = harness.calls.find((c) => c.method === 'cap.http.request'
      && String(c.params?.url || '').endsWith('/say/config'));
    assert.ok(push, '应该向网关推 /say/config');
    const body = JSON.parse(String(push.params.body || '{}'));
    assert.equal(body.apiKey, 'brz_test');
    assert.equal(body.voiceId, 'voc_a');
  } finally {
    harness.stop();
  }
});

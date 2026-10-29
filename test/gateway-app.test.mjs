import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { normalizeConfig } from '../gateway/lib/config.mjs';
import { createApp } from '../gateway/lib/app.mjs';

const TOKEN = 'test-token-123';
const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

/** 假音源 + 假换声：把整条 HTTP 流水线跑通，不联网、不吃显存。 */
function fakeDeps() {
  const source = {
    type: 'fake',
    async search(keyword) {
      if (String(keyword).includes('搜不到')) return [];
      return [{ id: '1', title: '测试歌', artist: '测试歌手', durationSec: 30, source: 'fake' }];
    },
    async prepare(item, { tmpDir }) {
      const file = path.join(tmpDir, `src-${Date.now()}.wav`);
      fs.writeFileSync(file, Buffer.alloc(2048, 7));
      return { file, ext: 'wav', bytes: 2048, kind: 'preview' };
    }
  };
  const voice = {
    name: 'fake',
    voices: ['me'],
    async convert({ input, output }) {
      fs.copyFileSync(input, output);
      return { engine: 'fake', bytes: fs.statSync(output).size };
    }
  };
  return { source, voice };
}

async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'singgw-'));
  const config = normalizeConfig({
    token: TOKEN,
    transcode: 'never',
    maxSeconds: 30,
    filesTtlHours: 1,
    dataDir
  });
  const deps = fakeDeps();
  const app = createApp({ config, ...deps });
  const server = http.createServer((req, res) => { void app.handler(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { base, close, app };
}

const call = (base, pathname, { token = TOKEN, method = 'GET', body = null } = {}) =>
  fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });

test('/health 免鉴权，只暴露在不在、什么引擎', async () => {
  const { base, close } = await boot();
  try {
    const response = await call(base, '/health', { token: '' });
    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(json.ok, true);
    assert.equal(json.engine, 'fake');
    assert.deepEqual(json.voices, ['me']);
  } finally { await close(); }
});

test('没有 token 的请求一律 401（除了 /health）', async () => {
  const { base, close } = await boot();
  try {
    assert.equal((await call(base, '/search?q=x', { token: '' })).status, 401);
    assert.equal((await call(base, '/jobs/abc', { token: '' })).status, 401);
    assert.equal((await call(base, '/search?q=x', { token: 'wrong-token' })).status, 401);
  } finally { await close(); }
});

test('搜歌：正常返回候选，搜不到就是空列表（不编造）', async () => {
  const { base, close } = await boot();
  try {
    const ok = await (await call(base, '/search?q=' + encodeURIComponent('测试'))).json();
    assert.equal(ok.ok, true);
    assert.equal(ok.items.length, 1);
    assert.equal(ok.items[0].title, '测试歌');

    const empty = await (await call(base, '/search?q=' + encodeURIComponent('搜不到'))).json();
    assert.equal(empty.ok, true);
    assert.equal(empty.items.length, 0);
  } finally { await close(); }
});

test('点歌全链路：POST /sing → 轮询 /jobs → 下载 /files', async () => {
  const { base, close } = await boot();
  try {
    const started = await call(base, '/sing', { method: 'POST', body: { song: '测试', maxSeconds: 20 } });
    assert.equal(started.status, 202);
    const { jobId } = await started.json();
    assert.match(jobId, /^[0-9a-f]{16}$/);

    let job = null;
    for (let i = 0; i < 100; i += 1) {
      job = await (await call(base, `/jobs/${jobId}`)).json();
      if (job.state === 'done' || job.state === 'failed') break;
      await tick(20);
    }
    assert.equal(job.state, 'done');
    assert.equal(job.title, '测试歌');
    assert.equal(job.engine, 'fake');
    assert.match(job.audioUrl, /^\/files\/out-[0-9a-f]+\.wav$/);

    const audio = await call(base, job.audioUrl);
    assert.equal(audio.status, 200);
    assert.equal(audio.headers.get('content-type'), 'audio/wav');
    const buffer = Buffer.from(await audio.arrayBuffer());
    assert.equal(buffer.length, 2048);
  } finally { await close(); }
});

test('参数错误给出 4xx 而不是 500；未知接口 404；任务不存在 404', async () => {
  const { base, close } = await boot();
  try {
    assert.equal((await call(base, '/sing', { method: 'POST', body: {} })).status, 400);
    assert.equal((await call(base, '/sing', { method: 'POST', body: { song: '歌'.repeat(61) } })).status, 400);
    assert.equal((await call(base, '/orders')).status, 404);
    assert.equal((await call(base, '/jobs/ffffffffffffffff')).status, 404);
    assert.equal((await call(base, '/files/..%2Fconfig.json')).status, 400);
  } finally { await close(); }
});

test('换声失败时任务落 failed 且带原因（不产出文件）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'singgw-bad-'));
  const config = normalizeConfig({ token: TOKEN, transcode: 'never', dataDir });
  const deps = fakeDeps();
  deps.voice = { name: 'bad', voices: [], async convert() { throw new Error('显存不够'); } };
  const app = createApp({ config, ...deps });
  const server = http.createServer((req, res) => { void app.handler(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { jobId } = await (await call(base, '/sing', { method: 'POST', body: { song: '测试' } })).json();
    let job = null;
    for (let i = 0; i < 100; i += 1) {
      job = await (await call(base, `/jobs/${jobId}`)).json();
      if (job.state === 'failed' || job.state === 'done') break;
      await tick(20);
    }
    assert.equal(job.state, 'failed');
    assert.match(job.error, /显存不够/);
    assert.equal(job.audioUrl, '');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('engine=none 时成品扩展名跟着音源走（不给 m4a 字节套 .wav 后缀）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'singgw-ext-'));
  const config = normalizeConfig({ token: TOKEN, transcode: 'never', dataDir });
  const deps = fakeDeps();
  // 音源给 m4a（iTunes 试听段就是 m4a）
  deps.source.prepare = async (item, { tmpDir }) => {
    const file = path.join(tmpDir, `src-${Date.now()}.m4a`);
    fs.writeFileSync(file, Buffer.alloc(1024, 3));
    return { file, ext: 'm4a', bytes: 1024, kind: 'preview' };
  };
  deps.voice = { name: 'none', voices: ['me'], async convert({ input, output }) { fs.copyFileSync(input, output); return { engine: 'none' }; } };
  const app = createApp({ config, ...deps });
  const server = http.createServer((req, res) => { void app.handler(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { jobId } = await (await call(base, '/sing', { method: 'POST', body: { song: '测试' } })).json();
    let job = null;
    for (let i = 0; i < 100; i += 1) {
      job = await (await call(base, `/jobs/${jobId}`)).json();
      if (job.state === 'done' || job.state === 'failed') break;
      await tick(20);
    }
    assert.equal(job.state, 'done');
    assert.match(job.audioUrl, /\.m4a$/);
    const audio = await call(base, job.audioUrl);
    assert.equal(audio.headers.get('content-type'), 'audio/mp4');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('没接换声模型时不能报"可用音色"，也不能说成能唱', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'singgw-none-'));
  const config = normalizeConfig({ token: TOKEN, transcode: 'never', dataDir });
  // 真实 engine=none 的 voice 实现：voices 必须是空的
  const { createVoiceEngine } = await import('../gateway/lib/voice.mjs');
  const noneVoice = createVoiceEngine({ voice: { engine: 'none', defaultVoice: 'me', command: '', pitch: 0, outputExt: 'wav', timeoutMs: 1000 } });
  assert.deepEqual(noneVoice.voices, []);
  const deps = fakeDeps();
  const app = createApp({ config, source: deps.source, voice: noneVoice });
  const server = http.createServer((req, res) => { void app.handler(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await (await call(base, '/health', { token: '' })).json();
    assert.equal(health.engine, 'none');
    assert.equal(health.voiceConfigured, false);
    assert.deepEqual(health.voices, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('搜索排序：标题命中的排在前面（避免点《孤勇者》唱《孤獨患者》）', async () => {
  const { scoreCandidate } = await import('../gateway/lib/sources.mjs');
  const hit = { title: '孤勇者', artist: 'Eason Chan' };
  const miss = { title: '孤獨患者', artist: 'Eason Chan' };
  assert.ok(scoreCandidate(hit, '孤勇者 陈奕迅') > scoreCandidate(miss, '孤勇者 陈奕迅'));
  // 歌手名命中也能加分，但不该压过标题命中
  assert.ok(scoreCandidate({ title: '别的歌', artist: '孤勇者乐队' }, '孤勇者') < scoreCandidate(hit, '孤勇者'));
});

test('原唱取不到音频时自动降到可播放版本，并带回 note 说明', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'singgw-alt-'));
  const config = normalizeConfig({ token: TOKEN, transcode: 'never', dataDir, source: { type: 'netease', limit: 5 } });
  const deps = fakeDeps();
  // 第一条（原唱）取音频失败，第二条（翻唱）成功
  deps.source.search = async () => ([
    { id: 'vip', title: '孤勇者', artist: '陈奕迅', source: 'netease', vip: true },
    { id: 'free', title: '孤勇者', artist: '田一名', source: 'netease', vip: false }
  ]);
  const inner = deps.source.prepare.bind(deps.source);
  deps.source.prepare = async (item, ctx) => {
    if (item.id === 'vip') throw new Error('网易云没有给可播地址');
    return inner(item, ctx);
  };
  const app = createApp({ config, ...deps });
  const server = http.createServer((req, res) => { void app.handler(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { jobId } = await (await call(base, '/sing', { method: 'POST', body: { song: '孤勇者' } })).json();
    let job = null;
    for (let i = 0; i < 100; i += 1) {
      job = await (await call(base, `/jobs/${jobId}`)).json();
      if (job.state === 'done' || job.state === 'failed') break;
      await tick(20);
    }
    assert.equal(job.state, 'done');
    assert.equal(job.sourceArtist, '田一名');
    assert.equal(job.artist, '小鲸鱼');   // 群里看到的演唱者是机器人自己
    assert.match(job.note, /原唱源受限/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('从输入里认出唱歌请求（宿主 send_voice 传的是自由文字）', async () => {
  const { extractSongRequest } = await import('../gateway/lib/app.mjs');
  assert.equal(extractSongRequest('唱：孤勇者'), '孤勇者');
  assert.equal(extractSongRequest('唱一首《起风了》'), '起风了');
  assert.equal(extractSongRequest('点歌 晴天'), '晴天');
  assert.equal(extractSongRequest('sing: yesterday'), 'yesterday');
  assert.equal(extractSongRequest('来一首 夜曲'), '夜曲');
  // 带句子成分的不当点歌（这张口子只唱歌，不做 TTS）
  assert.equal(extractSongRequest('今天天气不错，我们出去玩吧'), '');
  assert.equal(extractSongRequest('唱'), '');
  assert.equal(extractSongRequest(''), '');
  // 兜底：短、无标点、无空格的，直接当歌名（模型常只丢一个歌名过来）
  assert.equal(extractSongRequest('雨爱'), '雨爱');
});

test('/v1/audio/speech：唱歌请求直接返回音频字节（给宿主的语音条通道）', async () => {
  const { base, close } = await boot();
  try {
    const response = await call(base, '/v1/audio/speech', {
      method: 'POST',
      body: { model: 'x', input: '唱：测试', voice: 'me', response_format: 'wav' }
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /^audio\//);
    const buffer = Buffer.from(await response.arrayBuffer());
    assert.equal(buffer.length, 2048);
  } finally { await close(); }
});

test('/v1/audio/speech：句子明确拒绝（这个端点只唱歌，不做 TTS）', async () => {
  const { base, close } = await boot();
  try {
    const response = await call(base, '/v1/audio/speech', {
      method: 'POST',
      body: { input: '今天天气不错，我们出去玩吧' }
    });
    assert.equal(response.status, 400);
    const json = await response.json();
    assert.match(json.message, /只会唱歌/);
  } finally { await close(); }
});

test('句中触发的点歌也能认出来（模型常写"好的，我来唱：起风了"）', async () => {
  const { extractSongRequest } = await import('../gateway/lib/app.mjs');
  assert.equal(extractSongRequest('好的，我来唱：起风了'), '起风了');
  assert.equal(extractSongRequest('那就给你点歌 夜曲'), '夜曲');
  // 一整段聊天不该被误判成点歌
  assert.equal(extractSongRequest('我昨天在群里唱了一下午的歌，嗓子都哑了，真的很难受'), '');
});

test('歌名里的噪声会被剥掉（模型常写「雨爱（原唱：杨丞琳）」）', async () => {
  const { simplifySong } = await import('../gateway/lib/app.mjs');
  assert.equal(simplifySong('雨爱（原唱：杨丞琳）'), '雨爱');
  assert.equal(simplifySong('《起风了》'), '起风了');
  assert.equal(simplifySong('孤勇者 - 陈奕迅'), '孤勇者');
  assert.equal(simplifySong('原唱：夜曲'), '夜曲');
  assert.equal(simplifySong('雨爱'), '雨爱');
});

test('第一条候选取不到音频时，继续试后面的版本', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'singgw-full-'));
  const config = normalizeConfig({ token: TOKEN, transcode: 'never', dataDir, source: { type: 'netease', limit: 5 } });
  const deps = fakeDeps();
  deps.source.search = async () => ([
    { id: 'vip', title: '雨爱', artist: '杨丞琳', source: 'netease', vip: true },
    { id: 'cover', title: '雨爱', artist: '翻唱版', source: 'netease', vip: false }
  ]);
  const seen = [];
  deps.source.prepare = async (item, ctx) => {
    seen.push({ id: item.id });
    if (item.id === 'vip') throw new Error('网易云没有给可播地址');
    const file = path.join(ctx.tmpDir, 'src.wav');
    fs.writeFileSync(file, Buffer.alloc(2048, 1));
    return { file, ext: 'wav', bytes: 2048, kind: 'netease' };
  };
  const app = createApp({ config, ...deps });
  const server = http.createServer((req, res) => { void app.handler(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { jobId } = await (await call(base, '/sing', { method: 'POST', body: { song: '雨爱' } })).json();
    let job = null;
    for (let i = 0; i < 100; i += 1) {
      job = await (await call(base, `/jobs/${jobId}`)).json();
      if (job.state === 'done' || job.state === 'failed') break;
      await tick(20);
    }
    assert.equal(job.state, 'done');
    assert.equal(job.sourceArtist, '翻唱版');
    // 第一个候选（VIP 原唱）拿不到音频时不许降级成试听；最后一个候选才允许
    assert.deepEqual(seen.map((s) => s.id), ['vip', 'cover']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// 网关主体：路由 + 「搜歌 → 下载音源 → 换声 → 转码」流水线。
// 不含 listen、不含定时器 —— 这两件事在 server.mjs 里，测试直接拿 createApp().handler。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createJobQueue } from './jobs.mjs';
import { createSource } from './sources.mjs';
import { createVoiceEngine } from './voice.mjs';
import { transcodeTo, probeSeconds } from './audio.mjs';

export const VERSION = '1.0.0';
const WEB_DIR = path.join(import.meta.dirname, '..', 'web');
const NETEASE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_BODY_BYTES = 8 * 1024;
const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const CONTENT_TYPES = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg'
};

/**
 * 从"要说的话"里认出"唱歌请求"。
 * 宿主 send_voice 传给 /audio/speech 的 input 是模型自由写的文字，
 * 所以只认明确的开头（唱/点歌/sing…），认不出就当普通说话处理（本网关不支持）。
 */
/** 把歌名里的噪声去掉：括号说明、《》、" - 歌手"、"原唱：…" 这类。
 *  模型常写成「雨爱（原唱：杨丞琳）」，直接拿去搜网易云会搜不到。 */
export function simplifySong(song) {
  return String(song ?? '')
    .replace(/[（(][^）)]*[）)]/g, ' ')
    .replace(/[《》〈〉]/g, ' ')
    .replace(/\s*[-–—~]\s*[^-–—~]{1,20}$/, ' ')
    .replace(/^(?:原唱|翻唱|cover|演唱)\s*[:：]\s*/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractSongRequest(input) {
  const text = String(input ?? '').trim();
  const clean = (raw) => String(raw ?? '')
    .replace(/[《》"“”'‘’]/g, '')
    .replace(/^(?:一首|首)\s*/, '')
    .replace(/[。！？!?,，\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // ① 开头就是指令：唱：X / 唱一首X / 点歌 X / sing: X
  const head = /^(?:sing|点歌|唱一首|来一首|来首|唱)\s*[:：]?\s*(.+)$/i.exec(text);
  if (head) {
    const song = clean(head[1]);
    if (song && song.length <= 60) return song;
  }

  // ② 指令夹在句中（模型常写"好的，我来唱：起风了"）：取触发词之后的短尾巴
  const tail = /(?:唱一首|唱|点歌)\s*[:：]?\s*([^，。！？!?\n]{1,30})$/.exec(text);
  if (tail) {
    const song = clean(tail[1]);
    if (song && song.length <= 30) return song;
  }

  // ③ 兜底：这个端点本来就是"唱歌专用"。模型有时会直接把歌名丢进来（"雨爱"），
  //    只要短、不带句子成分、不带空格，就当点歌。
  // 纯触发词（"唱""点歌"）不算歌名
  const bareTrigger = /^(?:sing|点歌|唱一首|来一首|来首|唱)$/i;
  if (text.length <= 20 && !bareTrigger.test(text) && !/[，。！？!?,;；\n]/.test(text) && !/\s/.test(text)) return text;

  return '';
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('请求体太大'), { code: 'E_TOO_BIG' });
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { code: 'E_ARGS' });
  }
}

export function createApp({
  config,
  source = createSource(config),
  voice = createVoiceEngine(config),
  persistCookie = null,
  now = () => Date.now()
}) {
  const filesDir = path.join(config.dataDir, 'files');
  const tmpDir = path.join(config.dataDir, 'tmp');
  fs.mkdirSync(filesDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  /** 一条点歌任务的完整流水线。任何一步失败都抛错，任务状态落 failed（绝不给出半成品）。 */
  async function runSingJob(job, { progress }) {
    const payload = job.payload || {};
    const song = String(payload.song ?? '').trim();
    // payload.maxSeconds === 0 表示「唱完整首」：不裁剪，只受 config.maxSeconds 兜底保护。
    const requested = Number(payload.maxSeconds);
    const maxSeconds = requested === 0
      ? Number(config.maxSeconds) || 0
      : Math.min(config.maxSeconds, Math.max(5, requested || config.maxSeconds));
    const wantedVoice = String(payload.voice ?? '').trim() || config.voice.defaultVoice;

    progress(0.05, '搜歌');
    // 原样搜不到就换简化后的歌名再搜一次（"雨爱（原唱：杨丞琳）" → "雨爱"）
    const queries = [...new Set([song, simplifySong(song)].filter(Boolean))];
    let items = [];
    for (const query of queries) {
      items = await source.search(query, { limit: config.source.limit });
      if (items.length) break;
    }
    if (!items.length) throw new Error(`没搜到「${song}」，换个关键词或者把歌手一起写上`);
    // 原唱常常受版权限制（网易云 VIP 曲拿不到直链），但同一首歌通常有免费翻唱版。
    // 所以按相关度依次尝试，直到有一个能取到音频 —— 取到的不是第一条时如实说明。
    const wanted = (payload.itemId && items.find((entry) => String(entry.id) === String(payload.itemId))) || null;
    const candidates = wanted ? [wanted, ...items.filter((entry) => entry !== wanted)] : items;
    let item = null;
    let prepared = null;
    let lastError = null;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      progress(0.1, `取音源：${candidate.title}`);
      try {
        // 依次试候选：第一条常是 VIP 原唱（没登录态取不到），后面往往有完整翻唱版。
        prepared = await source.prepare(candidate, { tmpDir });
        item = candidate;
        break;
      } catch (error) {
        lastError = error;
        progress(0.1, `这条取不到（${String(error?.message ?? error).slice(0, 40)}），换下一条`);
      }
    }
    if (!prepared || !item) throw lastError || new Error('所有搜索结果都取不到音频');
    job.title = String(item.title ?? song);
    // 群里看到的「演唱者」是机器人自己（config.outputArtist，默认「小鲸鱼」），
    // 不是原唱；原唱信息留给 note / sourceArtist，用于"原唱受限，改用翻唱版"这类说明。
    job.sourceArtist = String(item.artist ?? '');
    job.artist = String(config.outputArtist || item.artist || '');
    let note = '';
    if (candidates[0] && item !== candidates[0]) {
      note = `原唱源受限，改用可播放版本：${job.title} - ${job.sourceArtist || job.artist}`;
      console.log(`[sing] ${note}`);
    }

    progress(0.35, '换声');
    // engine=none 时输出就是输入本身：扩展名必须跟着音源走（网易云可能给 m4a/mp3），
    // 否则会造出"m4a 字节 + .wav 后缀"的文件，播放器与 QQ 都会不认。
    const voiceExt = config.voice.engine === 'none'
      ? (prepared.ext || config.voice.outputExt)
      : config.voice.outputExt;
    const rawOut = path.join(tmpDir, `voice-${job.jobId}.${voiceExt}`);
    await voice.convert({ input: prepared.file, output: rawOut, voice: wantedVoice, maxSeconds });

    progress(0.8, '转码');
    const targetExt = config.transcode === 'auto' ? 'mp3' : (prepared.ext || voiceExt);
    const finalName = `out-${job.jobId}.${targetExt}`;
    const finalPath = path.join(filesDir, finalName);
    let usedTarget = targetExt;
    if (config.transcode === 'auto') {
      const ok = await transcodeTo(rawOut, finalPath, { maxSeconds, ext: 'mp3' });
      if (!ok) {
        // 没装 ffmpeg：如实发原文件，而不是假装转码成功
        usedTarget = voiceExt;
        fs.copyFileSync(rawOut, path.join(filesDir, `out-${job.jobId}.${voiceExt}`));
      }
    } else {
      fs.copyFileSync(rawOut, path.join(filesDir, `out-${job.jobId}.${voiceExt}`));
      usedTarget = voiceExt;
    }

    const outPath = path.join(filesDir, `out-${job.jobId}.${usedTarget}`);
    const probedSec = Math.round(await probeSeconds(outPath)) || 0;
    // 探不到时长时用请求时长兜底：报 0 会让宿主退回"按字数估"，又说成 1 秒
    const seconds = probedSec > 0 ? Math.min(maxSeconds, probedSec) : maxSeconds;
    const bytes = fs.statSync(outPath).size;

    // 中间文件用完就删；成品留在 files/ 给插件下载（TTL 清理见 pruneFiles）
    for (const temp of [prepared.file, rawOut]) {
      try { fs.rmSync(temp, { force: true }); } catch { /* 清理失败不影响结果 */ }
    }

    progress(0.95, '收尾');
    return {
      audioUrl: `/files/out-${job.jobId}.${usedTarget}`,
      bytes,
      seconds,
      engine: voice.name,
      title: job.title,
      artist: job.artist,
      note
    };
  }

  // 插件设置里改的「语音条秒数」会通过 /admin/voice-seconds 推上来（插件不参与语音条那条链路，
  // 只能这样把值交给网关）。它落在 state 文件里，网关重启后依然生效 ——
  // 否则重启一次就退回 config 默认值，表现是"插件设了 240 却只唱 90"。
  const runtimeStateFile = path.join(config.dataDir ? path.resolve(config.dataDir) : filesDir, 'runtime.json');
  let runtimeVoiceSeconds = null;   // null = 没设过（用 config 默认）；0 = 整首
  try {
    if (fs.existsSync(runtimeStateFile)) {
      const saved = JSON.parse(fs.readFileSync(runtimeStateFile, 'utf8'));
      const savedSeconds = Number(saved?.voiceSeconds);
      if (Number.isFinite(savedSeconds) && savedSeconds >= 0) {
        runtimeVoiceSeconds = savedSeconds;
        console.log(`  语音条时长（来自上次设置）：${savedSeconds === 0 ? '整首' : `${savedSeconds} 秒`}`);
      }
    }
  } catch { /* 状态文件坏了就当没有 */ }

  const queue = createJobQueue({ runner: runSingJob, ttlMs: config.filesTtlHours * 3600 * 1000, now });

  const tokenOk = (req) => {
    if (!config.token) return true;
    const header = String(req.headers.authorization || '');
    const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!given) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(config.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  /** 等一个任务跑完（给 /audio/speech 用：宿主那条路是同步要音频的）。 */
  const waitForJob = async (jobId, timeoutMs) => {
    const deadline = now() + Math.max(5000, Number(timeoutMs) || 120000);
    for (;;) {
      const job = queue.get(jobId);
      if (!job) return { state: 'failed', error: '任务不存在（可能已被清理）' };
      if (job.state === 'done' || job.state === 'failed') {
        return { state: job.state, error: job.error, audioUrl: job.audioUrl };
      }
      if (now() >= deadline) return { state: 'failed', error: '等太久：换声没在预期时间内完成' };
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  };

  /** 清掉过期的成品文件：磁盘是使用者自己的，不能靠人记得删。 */
  const pruneFiles = () => {
    const cutoff = now() - config.filesTtlHours * 3600 * 1000;
    let removed = 0;
    for (const name of fs.readdirSync(filesDir)) {
      const file = path.join(filesDir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) { fs.rmSync(file, { force: true }); removed += 1; }
      } catch { /* 并发删除/权限问题跳过 */ }
    }
    return removed;
  };

  /**
   * 清掉「今天以前」的成品（每天 0 点由 server.mjs 的定时器调用，插件也能触发）。
   * 按本地零点算：群里昨天的点歌不该留到明天。
   */
  // ── 网易云扫码登录 ────────────────────────────────────────────────
  // 用网易云自己的二维码登录接口（unikey + 轮询），不经过任何第三方；
  // 二维码在 /login 页面本地渲染，登录 key 不会离开本机。
  const loginSessions = new Map();

  async function startNeteaseLogin() {
    const response = await fetch('https://music.163.com/api/login/qrcode/unikey?type=1', {
      headers: { 'user-agent': NETEASE_UA, referer: 'https://music.163.com/' }
    });
    const data = await response.json().catch(() => ({}));
    if (Number(data.code) !== 200 || !data.unikey) throw new Error(`申请二维码失败（code=${data.code}）`);
    loginSessions.set(String(data.unikey), { createdAt: now() });
    console.log('[login] 已生成网易云登录二维码');
    return {
      key: String(data.unikey),
      loginUrl: `https://music.163.com/login?codekey=${encodeURIComponent(String(data.unikey))}`
    };
  }

  async function pollNeteaseLogin(key) {
    const response = await fetch(
      `https://music.163.com/api/login/qrcode/client/login?key=${encodeURIComponent(key)}&type=1`,
      { headers: { 'user-agent': NETEASE_UA, referer: 'https://music.163.com/' } }
    );
    const data = await response.json().catch(() => ({}));
    const code = Number(data.code);
    if (code === 800) return { state: 'expired' };
    if (code === 801) return { state: 'waiting' };
    if (code === 802) return { state: 'scanned' };
    if (code === 803) {
      const raw = (typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [])
        .map((line) => String(line).split(';')[0].trim())
        .filter(Boolean);
      const cookie = raw.join('; ');
      if (!/MUSIC_U=/.test(cookie)) return { state: 'failed', message: '登录成功但没拿到 MUSIC_U，请重试' };
      if (typeof source.setCookie === 'function') source.setCookie(cookie);
      if (typeof persistCookie === 'function') persistCookie(cookie);
      loginSessions.delete(key);
      console.log('[login] 网易云登录成功，Cookie 已写入配置');
      return { state: 'ok', cookieKeys: raw.map((kv) => kv.split('=')[0]) };
    }
    return { state: 'failed', message: `未预期的状态码 ${code}` };
  }

  const pruneBeforeToday = () => {
    const start = new Date(now());
    start.setHours(0, 0, 0, 0);
    const cutoff = start.getTime();
    let removed = 0;
    let bytes = 0;
    for (const name of fs.readdirSync(filesDir)) {
      const file = path.join(filesDir, name);
      try {
        const stat = fs.statSync(file);
        if (stat.mtimeMs < cutoff) {
          fs.rmSync(file, { force: true });
          removed += 1;
          bytes += stat.size;
        }
      } catch { /* 并发删除/权限问题跳过 */ }
    }
    return { removed, bytes };
  };

  const handler = async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      sendJson(res, 400, { ok: false, message: '请求地址不合法' });
      return;
    }
    const { pathname } = url;

    // 访问日志：只记"谁打了哪个口、什么结果、多快"。
    // 没有这条，宿主那边报"语音合成失败"时根本看不出是我们拒了、超时了还是压根没收到。
    const startedAt = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - startedAt;
      const status = res.statusCode;
      const flag = status >= 400 ? '✗' : '·';
      console.log(`[req] ${flag} ${req.method} ${pathname} → ${status} (${ms}ms)`);
    });

    // /health 免鉴权：只暴露"在不在、什么引擎"，方便排查隧道通不通
    if (pathname === '/health') {
      const voiceConfigured = voice.name !== 'none';
      sendJson(res, 200, {
        ok: true,
        version: VERSION,
        engine: voice.name,
        voiceConfigured,
        // 没接换声模型就报空列表：不把"根本不存在的音色"说成可用
        voices: voiceConfigured ? voice.voices : [],
        source: source.type,
        neteaseCookie: typeof source.hasCookie === 'function' ? source.hasCookie() : Boolean(config.source.neteaseCookie),
        voiceSeconds: runtimeVoiceSeconds ?? (config.voiceMessageDefaultSeconds ?? 90),
        voiceFullSong: runtimeVoiceSeconds === 0,
        // 三个上限都报出来：设置被夹回去时能一眼看出是哪一道闸
        voiceMaxSeconds: Math.max(5, Number(config.voiceMessageMaxSeconds) || 300),
        jobMaxSeconds: Number(config.maxSeconds) || 300,
        transcode: config.transcode,
        jobs: queue.size(),
        now: now()
      });
      return;
    }

    // ── 网易云扫码登录（拿 Cookie，只存本机）──────────────────────────
    // 页面是静态的，不需要鉴权；它调的 /login/* 需要令牌（?token= 或 x-gateway-token）。
    if (pathname === '/login' && req.method === 'GET') {
      const file = path.join(WEB_DIR, 'login.html');
      if (!fs.existsSync(file)) { sendJson(res, 500, { ok: false, message: '缺少 login.html' }); return; }
      const html = fs.readFileSync(file);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': html.length });
      res.end(html);
      return;
    }
    if (pathname === '/login/qrcode.js' && req.method === 'GET') {
      const file = path.join(WEB_DIR, 'qrcode.js');
      if (!fs.existsSync(file)) { sendJson(res, 404, { ok: false, message: '缺少 qrcode.js' }); return; }
      const js = fs.readFileSync(file);
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'content-length': js.length });
      res.end(js);
      return;
    }
    if (pathname.startsWith('/login/')) {
      // 三种来源都认：?token=（浏览器页面）、x-gateway-token（页面 JS）、Authorization: Bearer（插件调用）
      const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      const given = String(url.searchParams.get('token') || req.headers['x-gateway-token'] || bearer || '').trim();
      const expected = String(config.token || '').trim();
      if (expected && given !== expected) {
        sendJson(res, 401, { ok: false, message: '令牌不对：请用 /login?token=<网关令牌> 打开' });
        return;
      }
      // ⚠️ 这段在全局 try 之外（令牌校验之前）：必须自己接住异常。
      // 否则一次网易云接口抖动就是未捕获的 Promise 拒绝，整个网关进程会直接退出（实测崩过）。
      try {
        if (pathname === '/login/start' && req.method === 'POST') {
          const started = await startNeteaseLogin();
          sendJson(res, 200, { ok: true, ...started });
          return;
        }
        if (pathname === '/login/status' && req.method === 'GET') {
          const key = String(url.searchParams.get('key') || '').trim();
          if (!key) { sendJson(res, 400, { ok: false, message: '缺少 key' }); return; }
          sendJson(res, 200, await pollNeteaseLogin(key));
          return;
        }
        if (pathname === '/login/logout' && req.method === 'POST') {
          if (typeof source.setCookie === 'function') source.setCookie('');
          if (typeof persistCookie === 'function') persistCookie('');
          loginSessions.clear();
          console.log('[login] 已清除网易云登录态');
          sendJson(res, 200, { ok: true });
          return;
        }
      } catch (error) {
        console.error(`[login] 失败：${error?.message ?? error}`);
        sendJson(res, 502, { ok: false, message: `网易云接口失败：${String(error?.message ?? error).slice(0, 120)}` });
        return;
      }
      sendJson(res, 404, { ok: false, message: `没有这个接口：${req.method} ${pathname}` });
      return;
    }

    if (!tokenOk(req)) {
      sendJson(res, 401, { ok: false, message: '令牌不对：请求头要带 Authorization: Bearer <token>' });
      return;
    }

    try {
      if (pathname === '/search' && req.method === 'GET') {
        const keyword = String(url.searchParams.get('q') || '').trim();
        if (!keyword) throw Object.assign(new Error('缺少 q 参数（搜什么）'), { code: 'E_ARGS' });
        const items = await source.search(keyword, { limit: config.source.limit });
        sendJson(res, 200, { ok: true, items });
        return;
      }

      /**
       * OpenAI 兼容的 /v1/audio/speech —— 给宿主自带的「发语音(send_voice)」用。
       *
       * 宿主那条路是：文字 → POST /audio/speech → 音频字节 → record 段（QQ 语音条）。
       * 所以我们在这里接住"唱歌"意图：识别到就现唱现返回，宿主会把歌声当成语音条发出去。
       * 这条路的好处是**不用给宿主加能力**，也不用发群文件。
       */
      if ((pathname === '/v1/audio/speech' || pathname === '/audio/speech') && req.method === 'POST') {
        const body = await readJsonBody(req);
        const input = String(body.input ?? body.text ?? '').trim();
        if (!input) throw Object.assign(new Error('缺少 input（要唱的歌名或要说的话）'), { code: 'E_ARGS' });
        const song = extractSongRequest(input);
        if (!song) {
          throw Object.assign(new Error(
            '这个网关只会唱歌，不做文字转语音。想让机器人说话，请把 TTS 指向别处；'
            + '想让它唱，就让模型用「唱：歌名」的格式调用。'
          ), { code: 'E_NOT_TTS' });
        }
        // 语音条能有多长，取决于协议端与服务端策略，不是固定 60 秒：
        // 用 config.voiceMessageMaxSeconds 自己试（默认 120）。被拒就调小。
        const cap = Math.max(5, Number(config.voiceMessageMaxSeconds) || 300);
        // 0 有特殊含义：唱完整首（不裁剪）。其余按秒数夹紧。
        const asked = body.maxSeconds === undefined ? null : Number(body.maxSeconds);
        const wanted = asked ?? (runtimeVoiceSeconds ?? config.voiceMessageDefaultSeconds ?? 90);
        const maxSeconds = wanted === 0 ? 0 : Math.min(cap, Math.max(5, wanted));
        const job = queue.create({
          song,
          voice: String(body.voice ?? '').trim(),
          maxSeconds,
          itemId: ''
        });
        // 截止时间 = 演唱时长（秒→毫秒）+ 5 分钟余量（分离/加载/转码都算进去）
        // maxSeconds === 0 表示整首：这时预算要用 config.maxSeconds，否则 Math.min(…,0) 会把
        // 等待时间压成 0 + 5 分钟，4 分钟的歌必然超时（2026-10-29 实测 301 秒被掐）。
        const budgetSeconds = maxSeconds > 0
          ? Math.min(config.maxSeconds, maxSeconds)
          : Math.max(60, Number(config.maxSeconds) || 300);
        const finished = await waitForJob(job.jobId, budgetSeconds * 1000 + 300000);
        if (finished.state !== 'done') {
          sendJson(res, 500, { ok: false, message: finished.error || '唱失败了' });
          return;
        }
        let name = path.basename(finished.audioUrl);
        let file = path.join(filesDir, name);
        let buffer = fs.readFileSync(file);
        // 语音条通道有两条硬约束：宿主只收 ≤4MB，而且它按 response_format 当压缩音频用。
        // 所以这里不直接把成品甩出去 —— 不是 mp3 或超过 3.5MB，就现转一份（96k，仍大就 64k）。
        if (!/\.mp3$/i.test(name) || buffer.length > 3.5 * 1024 * 1024) {
          const converted = path.join(tmpDir, `voice-send-${job.jobId}.mp3`);
          // transcodeTo 在 ffmpeg 失败时是抛异常（不是返回 false），必须自己接住
          const tryTranscode = async (opts) => {
            try {
              return await transcodeTo(file, converted, opts);
            } catch (error) {
              console.warn(`[voice] 转码失败：${String(error?.message ?? error).slice(0, 120)}`);
              return false;
            }
          };
          let ok = await tryTranscode({ ext: 'mp3' });
          if (ok && fs.existsSync(converted) && fs.statSync(converted).size > 3.5 * 1024 * 1024) {
            ok = await tryTranscode({ ext: 'mp3', bitrate: '64k' });
          }
          if (ok && fs.existsSync(converted)) {
            name = path.basename(converted);
            file = converted;
            buffer = fs.readFileSync(file);
            console.log(`[voice] 已转码为 mp3（${Math.round(buffer.length / 1024)} KB）供语音条发送`);
          } else if (buffer.length > 3.5 * 1024 * 1024) {
            // 真的超限又转不了：如实失败，不要把注定被宿主拒收的东西发出去
            throw Object.assign(
              new Error(`成品 ${Math.round(buffer.length / 1024 / 1024 * 10) / 10}MB 超过宿主 4MB 上限，且没有可用的 ffmpeg 转码`),
              { code: 'E_TOO_LARGE' });
          } else {
            // 没超限：原样发送（格式不是 mp3 但宿主能收），不因为转码失败就整单失败
            console.log(`[voice] 转码不可用，按原格式发送（${Math.round(buffer.length / 1024)} KB）`);
          }
        }
        // 真实时长放在响应头里：宿主默认是"按字数估"（唱：夜曲 = 4 字 → 1 秒），
        // 会把 90 秒的语音说成 1 秒。宿主愿意读这个头就能显示对（见 docs/PATCHES.md）。
        const finishedJob = queue.get(job.jobId);
        const audioSeconds = Math.max(0, Math.round(Number(finishedJob?.seconds) || 0));
        res.writeHead(200, {
          'content-type': CONTENT_TYPES[path.extname(name).toLowerCase()] || 'audio/mpeg',
          'content-length': buffer.length,
          'x-audio-seconds': String(audioSeconds)
        });
        res.end(buffer);
        return;
      }

      // 定时清理入口（插件 schedule / 手动 curl 都能调）：删掉"今天以前"的成品
      if (pathname === '/admin/prune' && req.method === 'POST') {
        const result = pruneBeforeToday();
        console.log(`[prune] 清理 ${result.removed} 个昨日成品（${Math.round(result.bytes / 1024)} KB）`);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      // 插件把设置里的「语音条秒数」推上来（幂等，随便多调几次没关系）
      if (pathname === '/admin/voice-seconds' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const cap = Math.max(5, Number(config.voiceMessageMaxSeconds) || 300);
        const raw = Math.floor(Number(body.seconds) || 0);
        // 0 = 整首；其余夹在 5..cap
        const seconds = raw === 0 ? 0 : Math.min(cap, Math.max(5, raw));
        runtimeVoiceSeconds = seconds;
        try {
          fs.mkdirSync(path.dirname(runtimeStateFile), { recursive: true });
          fs.writeFileSync(runtimeStateFile, JSON.stringify({ voiceSeconds: seconds }, null, 2));
        } catch (error) {
          console.warn(`[admin] 保存语音条时长失败：${String(error?.message ?? error)}`);
        }
        console.log(`[admin] 语音条默认时长设为 ${seconds === 0 ? '整首（不裁剪）' : `${seconds} 秒`}`);
        sendJson(res, 200, { ok: true, seconds, cap });
        return;
      }

      if (pathname === '/sing' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const song = String(body.song ?? '').trim();
        if (!song) throw Object.assign(new Error('缺少 song 参数（歌名）'), { code: 'E_ARGS' });
        if (song.length > 60) throw Object.assign(new Error('歌名过长（≤60 字）'), { code: 'E_ARGS' });
        const job = queue.create({
          song,
          voice: String(body.voice ?? '').trim(),
          maxSeconds: Number(body.maxSeconds) || config.maxSeconds,
          itemId: body.id === undefined ? '' : String(body.id)
        });
        sendJson(res, 202, { ok: true, jobId: job.jobId, state: job.state, engine: voice.name });
        return;
      }

      const jobMatch = /^\/jobs\/([A-Za-z0-9]{1,64})$/.exec(pathname);
      if (jobMatch && req.method === 'GET') {
        const job = queue.get(jobMatch[1]);
        if (!job) { sendJson(res, 404, { ok: false, message: '没有这个任务（可能已过期）' }); return; }
        sendJson(res, 200, queue.view(job));
        return;
      }

      const fileMatch = /^\/files\/([^/]+)$/.exec(pathname);
      if (fileMatch && (req.method === 'GET' || req.method === 'HEAD')) {
        const name = decodeURIComponent(fileMatch[1]);
        if (!FILE_NAME_RE.test(name)) { sendJson(res, 400, { ok: false, message: '文件名不合法' }); return; }
        const file = path.join(filesDir, name);
        if (!fs.existsSync(file)) { sendJson(res, 404, { ok: false, message: '文件不在了（可能已被清理）' }); return; }
        const stat = fs.statSync(file);
        res.writeHead(200, {
          'content-type': CONTENT_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream',
          'content-length': stat.size,
          'cache-control': 'no-store'
        });
        if (req.method === 'HEAD') { res.end(); return; }
        fs.createReadStream(file).pipe(res);
        return;
      }

      sendJson(res, 404, { ok: false, message: `没有这个接口：${req.method} ${pathname}` });
    } catch (error) {
      const code = String(error?.code ?? '');
      const status = (code === 'E_ARGS' || code === 'E_NOT_TTS') ? 400 : code === 'E_TOO_BIG' ? 413 : 500;
      sendJson(res, status, { ok: false, message: String(error?.message ?? error) });
    }
  };

  return { handler, queue, filesDir, tmpDir, pruneFiles, pruneBeforeToday };
}

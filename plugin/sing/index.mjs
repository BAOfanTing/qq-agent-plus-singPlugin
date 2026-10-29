// 点歌唱歌：qq-agent 插件入口（apiVersion 2）。
//
// 这里只做两件事：把 stdin/stdout 上的 NDJSON 协议接起来，以及把"点歌 → 等换声 → 下载 → 发群文件"
// 串成一条流程。真正的搜歌/换声在你自己的电脑上（gateway/ 目录），插件这边永远只是个薄客户端。
//
// 三条硬约束（来自宿主 docs/PLUGINS.md）：
//   1. 联网只能走 cap.http.request / cap.media.download，且**强制 allowPrivate:false** ——
//      网关不能被 127.0.0.1 直连，必须是有公网域名的 https（见 docs/TUNNEL.md）。
//   2. cap.send.file 只支持群聊，且只发 plugin-data/sing/media/ 里的文件。
//   3. 插件进程没有写权限、没有子进程：落盘与转码都在网关侧完成。
import {
  TOOL_TIMEOUT_MS,
  POLL_RESERVE_MS,
  normalizeSettings,
  normalizeGatewayUrl,
  normalizeSongName,
  normalizeVoice,
  authHeaders,
  mediaFileName,
  parseJob,
  formatDuration,
  resolveAudioUrl,
  describeError
} from './lib.mjs';

import { createRequire } from 'node:module';

// 内置的二维码库是 UMD/CommonJS：仓库根 package.json 是 type=module，.js 会被当成 ESM，
// 于是没有 default 导出（实测报 "does not provide an export named 'default'"）。
// 用 .cjs + createRequire 两边都不会错。
const require = createRequire(import.meta.url);
const qrcode = require('./vendor/qrcode.cjs');

const send = (message) => { process.stdout.write(`${JSON.stringify(message)}\n`); };

/** 二维码 → data URL（SVG）。内置 qrcode-generator，不依赖任何外部服务。 */
function qrDataUrl(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const scale = 6;
  const size = (n + 4) * scale;
  const rects = [];
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      if (qr.isDark(r, c)) {
        rects.push(`<rect x="${(c + 2) * scale}" y="${(r + 2) * scale}" width="${scale}" height="${scale}"/>`);
      }
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><g fill="#111">${rects.join('')}</g></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

// 扫码会话：控制台的 poll 不带参数，所以 key 存在进程内
let pendingLogin = null;

let requestSeq = 0;
const pending = new Map();

/** 调宿主能力：带自增 id，应答按 id 回来。 */
const callHost = (method, params) => new Promise((resolve, reject) => {
  const id = ++requestSeq;
  pending.set(id, { resolve, reject });
  send({ id, method, params });
});

const log = (message, level = 'info') =>
  callHost('cap.log.write', { level, message }).catch(() => {});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 设置 + 凭据一次取齐（控制台改完立刻生效，不做进程内缓存）。 */
async function loadConfig() {
  const [{ settings }] = await Promise.all([
    callHost('cap.config.get', {}).catch(() => ({ settings: {} }))
  ]);
  const conf = normalizeSettings(settings);
  let token = '';
  try {
    const secrets = await callHost('cap.secrets.get', {});
    token = String(secrets?.values?.apiToken ?? '');
  } catch { token = ''; }
  return { ...conf, token, gatewayUrlFallback: String(settings?.gatewayUrlFallback ?? "").trim() };
}

/** GET/POST 网关，返回解析后的 JSON。状态码非 2xx 时把网关的 message 原样带出来。 */
/**
 * 主地址连不上就自动换备用地址（例如隧道抽风时退回服务器专线）。
 * 记住"上次哪个能用" 2 分钟，避免每次请求都先撞一遍死的那个。
 */
const gatewayPreference = { url: '', until: 0 };

function isNetworkError(error) {
  const text = `${error?.message ?? error} ${error?.code ?? ''}`.toLowerCase();
  return /fetch failed|econnrefused|econnreset|etimedout|eai_again|enotfound|network|socket|timeout|超时/.test(text);
}

function gatewayCandidates(conf) {
  const list = [conf.gatewayUrl, conf.gatewayUrlFallback].map((v) => String(v || '').trim()).filter(Boolean);
  if (Date.now() < gatewayPreference.until && gatewayPreference.url) {
    const preferred = list.find((u) => u === gatewayPreference.url);
    if (preferred) return [preferred, ...list.filter((u) => u !== preferred)];
  }
  return list;
}

async function callGateway(conf, pathname, { method = 'GET', body = null, query = null } = {}) {
  const candidates = gatewayCandidates(conf);
  if (!candidates.length) throw new Error('没有配置网关地址：控制台 → 插件 → 点歌唱歌 → 「网关地址」');
  let lastNetworkError = null;
  for (const candidate of candidates) {
    try {
      const json = await callGatewayOnce(conf, candidate, pathname, { method, body, query });
      if (candidates.length > 1) gatewayPreference.url = candidate;
      gatewayPreference.until = Date.now() + 2 * 60 * 1000;
      return json;
    } catch (error) {
      if (!isNetworkError(error)) throw error;   // 4xx/5xx 不是"连不上"，不用换地址
      lastNetworkError = error;
      await log(`网关地址 ${candidate} 连不上（${describeError(error)}），换下一个`, 'warn');
    }
  }
  throw lastNetworkError;
}

async function callGatewayOnce(conf, baseUrl, pathname, { method = 'GET', body = null, query = null } = {}) {
  const base = normalizeGatewayUrl(baseUrl, { allowInsecureHttp: conf.allowInsecureHttp });
  const url = new URL(pathname, `${base}/`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const response = await callHost('cap.http.request', {
    url: url.toString(),
    method,
    headers: { accept: 'application/json', ...authHeaders(conf.token) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const status = Number(response?.status) || 0;
  const text = String(response?.body ?? '');
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  if (status === 401 || status === 403) {
    throw Object.assign(new Error('网关拒绝了请求：令牌不对（插件设置里的「网关令牌」要和网关 config.json 的 token 一致）'), { code: 'E_GATEWAY_AUTH' });
  }
  if (status < 200 || status >= 300 || !json || json.ok === false) {
    const why = json?.message || json?.error || text.slice(0, 200) || `HTTP ${status}`;
    throw Object.assign(new Error(`网关返回失败：${why}`), { code: 'E_GATEWAY' });
  }
  return json;
}

/** 轮询任务直到完成或临近工具超时。 */
async function waitForJob(conf, jobId, { onTick } = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + TOOL_TIMEOUT_MS - POLL_RESERVE_MS;
  let last = null;
  while (Date.now() < deadline) {
    const job = parseJob(await callGateway(conf, `/jobs/${encodeURIComponent(jobId)}`));
    if (job.state === 'failed') {
      throw Object.assign(new Error(job.message || '换声失败'), { code: 'E_JOB_FAILED' });
    }
    if (job.state === 'done') return job;
    if (job !== last) {
      last = job;
      if (onTick) await onTick(job);
    }
    await sleep(conf.pollIntervalMs);
  }
  throw Object.assign(
    new Error(`等换声超时（${Math.round((TOOL_TIMEOUT_MS - POLL_RESERVE_MS) / 1000)} 秒）：歌太长或电脑在忙，把 maxSeconds 调小再试`),
    { code: 'E_JOB_TIMEOUT' }
  );
}

const tools = {

  /**
   * 网易云扫码登录。控制台「扫码登录」按钮会以 {action:'start'|'poll'|'status'|'logout', channel:'console'} 调这个工具。
   * 二维码在插件进程里用内置库生成（data URL），登录 key 只经网关、不出本机。
   */
  login: async (args) => {
    const action = String(args?.action ?? '').trim();
    const channel = String(args?.channel ?? 'console').trim() === 'chat' ? 'chat' : 'console';
    const conf = await loadConfig();

    if (action === 'start') {
      const started = await callGateway(conf, '/login/start', { method: 'POST', body: {} });
      const key = String(started.key || '');
      const loginUrl = String(started.loginUrl || '');
      if (!key || !loginUrl) throw new Error('网关没有返回登录二维码');
      pendingLogin = { key, loginUrl, at: Date.now(), channel };
      const dataUrl = qrDataUrl(loginUrl);
      if (channel === 'chat') {
        return {
          ok: true,
          channel,
          loginUrl,
          note: '二维码链接：' + loginUrl + '（在手机网易云 App 里扫码，或让管理员用控制台「扫码登录」按钮）'
        };
      }
      return {
        ok: true,
        channel,
        key,
        qrcodeDataUrl: dataUrl,
        note: '用手机网易云 App 扫这个码，手机上点「确认登录」后再点「查扫码结果」（约 4 分钟内有效）。'
      };
    }

    if (action === 'poll') {
      if (!pendingLogin?.key) return { ok: false, state: 'expired', note: '没有进行中的扫码，请重新点「扫码登录」' };
      const status = await callGateway(conf, `/login/status?key=${encodeURIComponent(pendingLogin.key)}`);
      const state = String(status.state || '');
      if (state === 'ok') {
        pendingLogin = null;
        return { ok: true, state: 'done', account: '网易云', note: '登录成功，Cookie 已由网关保存并立即生效' };
      }
      if (state === 'scanned') return { ok: true, state: 'scanned', note: '已扫码，请在手机上点「确认登录」' };
      if (state === 'expired') { pendingLogin = null; return { ok: true, state: 'expired', note: '二维码过期了，请重新点「扫码登录」' }; }
      if (state === 'failed') { pendingLogin = null; return { ok: false, state: 'failed', note: String(status.message || '登录失败') }; }
      return { ok: true, state: 'waiting', note: '等待扫码中…' };
    }

    if (action === 'status') {
      const health = await callGateway(conf, '/health').catch(() => null);
      return {
        ok: true,
        login: Boolean(health?.neteaseCookie),
        uname: '网易云',
        note: health?.neteaseCookie ? '已登录（能取 VIP 曲原唱）' : '未登录（只能唱免费曲）'
      };
    }

    if (action === 'logout') {
      await callGateway(conf, '/login/logout', { method: 'POST', body: {} }).catch(() => null);
      pendingLogin = null;
      return { ok: true, login: false, note: '已清除网关里的网易云登录态' };
    }

    throw new Error(`不认识的 action：${action}（只支持 start / poll / status / logout）`);
  },

  /** 给出网易云扫码登录链接（登录态由网关保存，插件只负责把链接递出去）。 */

  netease_login: async () => {
    const conf = await loadConfig();
    const base = normalizeGatewayUrl(conf.gatewayUrl, { allowInsecureHttp: conf.allowInsecureHttp });
    const token = String(conf.token || '');
    const health = await callGateway(conf, '/health').catch(() => null);
    return {
      ok: true,
      alreadyLoggedIn: Boolean(health?.neteaseCookie),
      url: `${base}/login${token ? `?token=${encodeURIComponent(token)}` : ''}`,
      steps: [
        '在电脑或手机上打开上面的链接（和网关同一台机器的话直接点开即可）',
        '用手机网易云 App 扫页面上的二维码',
        '手机上点「确认登录」，页面显示成功后就可以关掉',
        '之后点 VIP 曲会自动用原唱（不用再改配置）'
      ],
      note: health?.neteaseCookie
        ? '现在已经有登录态了；如果原唱还是取不到，可能是这首歌压根不在曲库'
        : '没登录时只能唱免费曲；VIP 曲会提示"需要 VIP"'
    };
  },

  /** 只读：查后端在不在、能不能唱、有哪些音色。 */
  sing_status: async () => {
    const conf = await loadConfig();
    const health = await callGateway(conf, '/health');
    const engine = String(health.engine ?? '');
    // 只有网关明确说"接了换声模型"才算能唱；engine=none 只是搬运音源，不能对用户说成翻唱
    const canSing = health.voiceConfigured !== false && engine !== 'none';
    const voices = canSing && Array.isArray(health.voices) ? health.voices.map((v) => String(v)) : [];
    return {
      ok: true,
      engine,
      canSing,
      voices,
      version: String(health.version ?? ''),
      note: canSing
        ? ''
        : '还没接换声模型（engine=none）：现在只能搜歌；点了也是发音源原声片段，不是翻唱'
    };
  },

  /** 只读：搜候选歌，让模型挑一条再点。 */
  sing_search: async (args) => {
    const conf = await loadConfig();
    const keyword = normalizeSongName(args?.keyword ?? args?.song);
    const json = await callGateway(conf, '/search', { query: { q: keyword, limit: 5 } });
    const items = Array.isArray(json.items) ? json.items.slice(0, 5) : [];
    return {
      ok: true,
      keyword,
      count: items.length,
      items: items.map((item) => ({
        title: String(item.title ?? ''),
        artist: String(item.artist ?? ''),
        duration: formatDuration(item.durationSec),
        source: String(item.source ?? '')
      })),
      note: items.length ? '' : '没搜到：换个关键词，或把歌手一起写上'
    };
  },

  /** 点歌：搜 → 起任务 → 等换声 → 下载 → 发到当前群。 */
  sing_song: async (args, context) => {
    const chatKey = String(context?.chatKey ?? '');
    if (!chatKey.startsWith('group:')) {
      return {
        ok: false,
        error: '只能在群里点歌：宿主目前只允许插件把文件发到群聊（私聊会被拒绝）'
      };
    }
    const conf = await loadConfig();
    // 群文件输出默认关：关着就不碰 cap.send.file，直接让模型改用语音条那条路。
    if (conf.allowFileOutput !== true) {
      return {
        ok: false,
        error: '群文件输出未开启（插件设置里的「允许发群文件」是关的）。'
          + '要发语音条请改调 send_voice，并把输入写成「唱：歌名」；确实需要文件请去设置里打开这个开关。'
      };
    }
    const song = normalizeSongName(args?.song ?? args?.keyword);
    const voice = normalizeVoice(args?.voice) || conf.defaultVoice;
    const maxSeconds = Math.min(180, Math.max(5, Number(args?.maxSeconds) || conf.maxSeconds));

    await log(`点歌：${song}${voice ? `（音色 ${voice}）` : ''}，上限 ${maxSeconds} 秒`);

    const started = await callGateway(conf, '/sing', {
      method: 'POST',
      body: { song, voice, maxSeconds }
    });
    const jobId = String(started.jobId ?? '');
    if (!jobId) throw Object.assign(new Error('网关没有返回 jobId'), { code: 'E_GATEWAY' });

    const job = await waitForJob(conf, jobId, {
      onTick: (current) => log(`换声进行中：${Math.round(current.progress * 100)}%`)
    });

    const audioUrl = resolveAudioUrl(conf.gatewayUrl, job.audioUrl);
    if (!audioUrl) throw Object.assign(new Error('网关任务完成但没有给 audioUrl'), { code: 'E_GATEWAY' });

    const ext = /\.(mp3|m4a|wav|ogg)$/i.exec(audioUrl)?.[1]?.toLowerCase() || 'mp3';
    const fileName = mediaFileName(jobId, ext);
    const downloaded = await callHost('cap.media.download', {
      url: audioUrl,
      name: fileName,
      maxBytes: 64 * 1024 * 1024,
      headers: authHeaders(conf.token)
    });

    const label = [job.title || song, job.artist].filter(Boolean).join(' - ');
    await callHost('cap.send.file', {
      chatKey,
      file: downloaded?.file || fileName,
      name: `${label || '点歌'}.${ext}`.replace(/[\\/:*?"<>|]/g, '_')
    });
    await log(`已发到 ${chatKey}：${label}（${Math.round((downloaded?.bytes || 0) / 1024)}KB）`);

    return {
      ok: true,
      sent: true,
      title: job.title || song,
      artist: job.artist,
      engine: job.engine,
      voice: voice || '(网关默认)',
      duration: formatDuration(job.seconds),
      bytes: downloaded?.bytes || job.bytes || 0,
      // 网关可能在原唱取不到音频时降级到翻唱版，或当前没接换声模型 —— 都要如实说
      ...(job.note ? { note: job.note } : {}),
      // engine=none 时发出去的是音源原声，必须说清，别让群里以为这是"她的翻唱"
      ...(job.engine === 'none'
        ? { note: '当前后端没接换声模型，发的是音源原声片段（不是翻唱）' }
        : {})
    };
  }
};


// 控制台「检测登录」/ 插件页徽标走这条（可选协议方法）
async function handleProbe(message) {
  try {
    const conf = await loadConfig();
    const health = await callGateway(conf, '/health').catch(() => null);
    const login = Boolean(health?.neteaseCookie);
    send({
      id: message.id,
      result: {
        ok: true,
        info: { login, uname: '网易云', note: login ? '已登录' : '未登录（只能唱免费曲）' },
        loginInfo: { login, uname: '网易云', measuredAt: Date.now(), note: login ? '已登录' : '未登录' }
      }
    });
  } catch (error) {
    send({ id: message.id, result: { ok: false, error: String(error?.message ?? error) } });
  }
}

async function handleRequest(message) {
  const reply = (payload) => send({ id: message.id, ...payload });
  switch (message.method) {
    case 'init':
      reply({ result: { ok: true } });
      return;
    case 'ping':
      reply({ result: {} });
      return;
    case 'probe':
      await handleProbe(message);
      return;
    case 'schedule': {
      // 宿主只支持 everyMs（没有 cron），所以每小时醒一次，只在本地 0 点拨一下网关清理：
      // 群里昨天点的歌不该留到明天。真正的删除只能由网关做（插件没有删文件的能力）。
      const name = String(message.params?.name ?? '');
      const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: 'numeric', hour12: false }).format(new Date()));
      if (name === 'daily_prune' && hour === 0) {
        try {
          const conf = await loadConfig();
          const result = await callGateway(conf, '/admin/prune', { method: 'POST', body: {} });
          await log(`零点清理：删了 ${Number(result?.removed) || 0} 个昨日成品`);
        } catch (error) {
          await log(`零点清理失败：${describeError(error)}`, 'warn');
        }
      }
      reply({ result: { ok: true, skipped: hour !== 0 } });
      return;
    }
    case 'callTool': {
      const name = String(message.params?.name ?? '');
      const fn = tools[name];
      if (!fn) return reply({ error: { code: 'E_NO_TOOL', message: `没有这个工具：${name}` } });
      try {
        reply({ result: await fn(message.params?.args ?? {}, message.params?.context ?? {}) });
      } catch (error) {
        reply({ error: { code: error?.code || 'E_TOOL', message: describeError(error) } });
      }
      return;
    }
    case 'shutdown':
      reply({ result: {} });
      setTimeout(() => process.exit(0), 10);
      return;
    default:
      reply({ error: { code: 'E_NO_METHOD', message: `未知方法：${message.method}` } });
  }
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      let message = null;
      try { message = JSON.parse(line); } catch { message = null; }
      if (message && typeof message.method === 'string' && message.id !== undefined) handleRequest(message);
      else if (message && message.id !== undefined) {
        const entry = pending.get(message.id);
        if (entry) {
          pending.delete(message.id);
          if (message.error) {
            entry.reject(Object.assign(new Error(message.error.message || '能力调用失败'), { code: message.error.code }));
          } else entry.resolve(message.result ?? null);
        }
      }
    }
    index = buffer.indexOf('\n');
  }
});

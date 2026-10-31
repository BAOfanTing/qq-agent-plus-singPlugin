// 说话（TTS）：只走 Breeze 云端（https://api.breeze.blue）。
//
// 为什么只留这一个：本机 SAPI 的机械感没法听，Edge 那条路又依赖 edge-tts 环境；
// 而 Breeze TTS 2 是现在开源权重里质量最好的，云端调用不占显存、音色可在插件里选、
// 还能用自然语言指令控制语气。
//
// 接口形状来自官方 openapi.json（ElevenLabs 风格）：
//   POST {baseUrl}/v1/text-to-speech/{voiceId}?output_format=mp3_24000_128&delivery=sync
//   header: xi-api-key
//   body:  { text, model_id, language_code?, instructions?, voice_settings: { guidance_scale } }
//   → 200 audio/*
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_BASE = 'https://api.breeze.blue';

/** Breeze 的一次请求。网络层错误统一翻译成人话。 */
async function breezeFetch(url, { apiKey, method = 'GET', body = null, timeoutMs = 30000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method,
      headers: {
        'xi-api-key': apiKey,
        accept: 'application/json, audio/*',
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal
    });
  } catch (error) {
    const reason = error?.name === 'AbortError'
      ? `超时（${Math.round(timeoutMs / 1000)} 秒）`
      : String(error?.message ?? error);
    throw Object.assign(new Error(`连不上 Breeze：${reason}`), { code: 'E_SAY_NET' });
  } finally {
    clearTimeout(timer);
  }
}

function hintForStatus(status) {
  if (status === 401) return '（API Key 不对或未激活）';
  if (status === 403) return '（这个 Key 没权限用该音色/模型）';
  if (status === 402 || status === 429) return '（额度不足或触到频率限制）';
  if (status === 404) return '（音色 id 不存在）';
  if (status === 503 || status === 504) return '（Breeze 服务端忙/超时）';
  return '';
}

export function createSayEngine(config) {
  const say = config.say || {};
  const enabled = String(say.engine || 'breeze') === 'breeze';

  // 运行期可被插件覆盖：插件设置里填 Key / 选音色后推到网关，立即生效并落盘
  const runtime = { apiKey: String(say.breezeKey || ''), voiceId: String(say.voiceId || '') };
  const baseUrl = String(say.breezeUrl || DEFAULT_BASE).replace(/\/+$/, '');
  const modelId = String(say.breezeModel || 'breeze-tts-2');
  const languageCode = String(say.languageCode || '');
  const instructions = String(say.instructions || '');
  const guidanceScale = Number.isFinite(Number(say.guidanceScale)) ? Number(say.guidanceScale) : 0;
  const outputFormat = String(say.outputFormat || 'mp3_24000_128');
  const maxChars = Math.max(20, Number(say.maxChars) || 800);
  const timeoutMs = Math.max(5000, Number(say.timeoutMs) || 120000);

  let balanceCache = { at: 0, value: null };

  const engine = {
    name: enabled ? 'breeze' : 'none',

    /** 插件推上来的 Key / 音色，立即生效。 */
    setCredentials({ apiKey, voiceId } = {}) {
      if (typeof apiKey === 'string' && apiKey.trim()) runtime.apiKey = apiKey.trim();
      if (typeof voiceId === 'string' && voiceId.trim()) runtime.voiceId = voiceId.trim();
    },
    credentials: () => ({ ...runtime }),

    /** 把文字读成音频，写进 output（扩展名按 content-type 决定）。 */
    async convert({ text, output }) {
      if (!enabled) throw Object.assign(new Error('说话功能没开（网关 config.say.engine 不是 breeze）'), { code: 'E_SAY_OFF' });
      if (!runtime.apiKey) throw Object.assign(new Error('还没配 Breeze API Key'), { code: 'E_SAY_NO_KEY' });
      if (!runtime.voiceId) throw Object.assign(new Error('还没选 Breeze 音色'), { code: 'E_SAY_NO_VOICE' });

      const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
      if (!clean) throw Object.assign(new Error('要读的文字是空的'), { code: 'E_SAY_EMPTY' });

      const url = `${baseUrl}/v1/text-to-speech/${encodeURIComponent(runtime.voiceId)}`
        + `?output_format=${encodeURIComponent(outputFormat)}&delivery=sync`;
      const payload = { text: clean, model_id: modelId };
      if (languageCode) payload.language_code = languageCode;
      if (instructions) payload.instructions = instructions;
      if (guidanceScale > 0) payload.voice_settings = { guidance_scale: guidanceScale };

      const response = await breezeFetch(url, { apiKey: runtime.apiKey, method: 'POST', body: payload, timeoutMs });
      const type = String(response.headers.get('content-type') || '');
      if (!response.ok) {
        let detail = '';
        try { detail = (await response.text()).slice(0, 240); } catch { /* 忽略 */ }
        throw Object.assign(
          new Error(`Breeze 返回 ${response.status}${hintForStatus(response.status)}：${detail}`),
          { code: 'E_SAY_HTTP', status: response.status }
        );
      }
      if (!/^audio\//i.test(type)) {
        const body = await response.text().catch(() => '');
        throw Object.assign(new Error(`Breeze 没返回音频（content-type=${type || '空'}）：${body.slice(0, 160)}`), { code: 'E_SAY_NOT_AUDIO' });
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 1000) throw Object.assign(new Error('Breeze 返回的音频太小'), { code: 'E_SAY_EMPTY_OUTPUT' });
      const ext = type.includes('wav') ? '.wav'
        : type.includes('mpeg') || type.includes('mp3') ? '.mp3'
          : type.includes('ogg') || type.includes('opus') ? '.opus' : '.bin';
      const target = String(output).replace(/\.[^./\\]+$/, '') + ext;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buffer);
      return { file: target, bytes: buffer.length, chars: clean.length, format: ext.slice(1) };
    },

    /** 拉音色列表（插件选音色用）。 */
    async listVoices() {
      if (!runtime.apiKey) throw Object.assign(new Error('还没配 Breeze API Key'), { code: 'E_SAY_NO_KEY' });
      const response = await breezeFetch(`${baseUrl}/v1/voices`, { apiKey: runtime.apiKey, timeoutMs: 30000 });
      if (!response.ok) {
        let detail = '';
        try { detail = (await response.text()).slice(0, 200); } catch { /* 忽略 */ }
        throw Object.assign(new Error(`拉音色失败 ${response.status}${hintForStatus(response.status)}：${detail}`), { code: 'E_SAY_HTTP' });
      }
      const data = await response.json().catch(() => ({}));
      const list = Array.isArray(data?.voices) ? data.voices : Array.isArray(data) ? data : [];
      return list
        .map((v) => ({
          id: String(v?.voice_id ?? ''),
          name: String(v?.name ?? ''),
          category: v?.category ? String(v.category) : '',
          labels: v?.labels && typeof v.labels === 'object' ? v.labels : {}
        }))
        .filter((v) => v.id);
    },

    /** 余额（60 秒缓存：状态刷新很频繁，别每次都打 Breeze）。 */
    async balance({ fresh = false } = {}) {
      if (!runtime.apiKey) return null;
      if (!fresh && balanceCache.value !== null && Date.now() - balanceCache.at < 60000) return balanceCache.value;
      try {
        const response = await breezeFetch(`${baseUrl}/v1/balance`, { apiKey: runtime.apiKey, timeoutMs: 20000 });
        if (!response.ok) return null;
        const data = await response.json().catch(() => null);
        const value = Number(data?.balance);
        balanceCache = { at: Date.now(), value: Number.isFinite(value) ? value : null };
        return balanceCache.value;
      } catch {
        return null;
      }
    },

    /** 在线状态：插件页「后端在线」用的就是它。 */
    async status({ fresh = false } = {}) {
      const hasKey = Boolean(runtime.apiKey);
      const hasVoice = Boolean(runtime.voiceId);
      const base = { engine: enabled ? 'breeze' : 'none', hasKey, hasVoice, voiceId: runtime.voiceId, model: modelId };
      if (!enabled) return { ...base, online: false, note: '网关没开说话功能（say.engine ≠ breeze）' };
      if (!hasKey) return { ...base, online: false, note: '还没填 Breeze API Key' };
      try {
        const response = await breezeFetch(`${baseUrl}/v1/models`, { apiKey: runtime.apiKey, timeoutMs: 15000 });
        if (!response.ok) {
          return { ...base, online: false, balance: null, note: `Breeze 返回 ${response.status}${hintForStatus(response.status)}` };
        }
        const balance = await engine.balance({ fresh });
        return { ...base, online: true, balance, note: hasVoice ? '' : '还没选音色' };
      } catch (error) {
        return { ...base, online: false, balance: null, note: String(error?.message ?? error).slice(0, 160) };
      }
    }
  };

  return engine;
}

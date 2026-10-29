// 网关配置：读 config.json，给默认值，把"配错了"变成启动时的一句人话。
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CONFIG = Object.freeze({
  port: 8899,
  host: '127.0.0.1',
  token: '',
  // 音源：netease（网易云，默认）| local（你自己的音频目录）
  source: { type: 'netease', localDir: '', neteaseCookie: '', limit: 5 },
  // 换声：none（直出原音，用于先跑通链路）| command（调你自己的 RVC/SVC 命令行）
  voice: { engine: 'none', command: '', timeoutMs: 600000, pitch: 0, outputExt: 'wav', defaultVoice: 'me' },
  // 输出：auto = 有 ffmpeg 就转 mp3 并裁剪到 maxSeconds；never = 原样发
  transcode: 'auto',
  maxSeconds: 90,
  // 成品里显示的「演唱者」——这是机器人自己的名字，不是原唱
  outputArtist: '小鲸鱼',
  // 语音条（/audio/speech）能有多长：实测边界，被协议端拒绝就调小
  voiceMessageMaxSeconds: 120,
  // 语音条默认唱多久（宿主不指定时用它）；受 voiceMessageMaxSeconds 夹紧
  voiceMessageDefaultSeconds: 90,
  filesTtlHours: 24,
  dataDir: 'gateway-run'
});

const asInt = (value, fallback, min, max) => {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const asString = (value, fallback = '') => (typeof value === 'string' ? value : fallback).trim();

/** 合并 + 校验。返回 { config } 或抛出带人话的错误。 */
export function normalizeConfig(raw, { rootDir = process.cwd() } = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const source = input.source && typeof input.source === 'object' ? input.source : {};
  const voice = input.voice && typeof input.voice === 'object' ? input.voice : {};

  const config = {
    port: asInt(input.port, DEFAULT_CONFIG.port, 1, 65535),
    host: asString(input.host, DEFAULT_CONFIG.host) || DEFAULT_CONFIG.host,
    token: asString(input.token),
    source: {
      type: ['netease', 'local'].includes(asString(source.type)) ? asString(source.type) : DEFAULT_CONFIG.source.type,
      localDir: asString(source.localDir),
      // 网易云登录后的 MUSIC_U Cookie：填了才能取 VIP 曲的原唱；不填只能唱免费曲
      neteaseCookie: asString(source.neteaseCookie),
      limit: asInt(source.limit, DEFAULT_CONFIG.source.limit, 1, 20)
    },
    voice: {
      engine: ['none', 'command'].includes(asString(voice.engine)) ? asString(voice.engine) : DEFAULT_CONFIG.voice.engine,
      command: asString(voice.command),
      timeoutMs: asInt(voice.timeoutMs, DEFAULT_CONFIG.voice.timeoutMs, 10000, 1800000),
      pitch: asInt(voice.pitch, DEFAULT_CONFIG.voice.pitch, -24, 24),
      outputExt: ['wav', 'mp3', 'flac', 'm4a'].includes(asString(voice.outputExt))
        ? asString(voice.outputExt) : DEFAULT_CONFIG.voice.outputExt,
      defaultVoice: asString(voice.defaultVoice) || DEFAULT_CONFIG.voice.defaultVoice
    },
    transcode: ['auto', 'never'].includes(asString(input.transcode)) ? asString(input.transcode) : DEFAULT_CONFIG.transcode,
    maxSeconds: asInt(input.maxSeconds, DEFAULT_CONFIG.maxSeconds, 5, 600),
    outputArtist: asString(input.outputArtist, DEFAULT_CONFIG.outputArtist) || DEFAULT_CONFIG.outputArtist,
    voiceMessageMaxSeconds: asInt(input.voiceMessageMaxSeconds, DEFAULT_CONFIG.voiceMessageMaxSeconds, 5, 600),
    voiceMessageDefaultSeconds: asInt(input.voiceMessageDefaultSeconds, DEFAULT_CONFIG.voiceMessageDefaultSeconds, 5, 600),
    filesTtlHours: asInt(input.filesTtlHours, DEFAULT_CONFIG.filesTtlHours, 1, 24 * 30),
    dataDir: asString(input.dataDir, DEFAULT_CONFIG.dataDir) || DEFAULT_CONFIG.dataDir
  };

  if (config.source.type === 'local' && !config.source.localDir) {
    throw new Error('source.type = local 时必须给 source.localDir（放音频的目录）');
  }
  if (config.voice.engine === 'command' && !config.voice.command) {
    throw new Error('voice.engine = command 时必须给 voice.command（你的换声命令行）');
  }
  // 相对路径按配置文件所在目录解析，避免"换个工作目录启动就找不到文件"
  if (config.source.localDir && !path.isAbsolute(config.source.localDir)) {
    config.source.localDir = path.resolve(rootDir, config.source.localDir);
  }
  if (!path.isAbsolute(config.dataDir)) config.dataDir = path.resolve(rootDir, config.dataDir);
  return config;
}

export function loadConfig(filePath) {
  const abs = path.resolve(filePath);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (error) {
    throw new Error(`读不到配置文件 ${abs}：${error?.message ?? error}（可以先复制 config.example.json）`);
  }
  return normalizeConfig(raw, { rootDir: path.dirname(abs) });
}

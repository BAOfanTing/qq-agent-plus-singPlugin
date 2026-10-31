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
  // 说话（TTS）：非点歌的文本走这里，只走 Breeze 云端
  say: {
    engine: 'breeze',
    voice: '',
    rate: 0,
    volume: 100,
    maxChars: 800,
    timeoutMs: 60000,
    // 说话也用她的音色：TTS 之后再过一遍换声（多 10-20 秒）
    breezeUrl: 'https://api.breeze.blue',
    breezeKey: '',
    voiceId: '',
    breezeModel: 'breeze-tts-2',
    languageCode: '',
    instructions: '',
    guidanceScale: 0,
    outputFormat: 'mp3_24000_128'
  },
  voice: { engine: 'none', command: '', timeoutMs: 600000, pitch: 0, outputExt: 'wav', defaultVoice: 'me',
           serveCommand: '', serveIdleMs: 600000, segmentSeconds: 30, gpuFraction: 0.9 },
  // 输出：auto = 有 ffmpeg 就转 mp3 并裁剪到 maxSeconds；never = 原样发
  transcode: 'auto',
  maxSeconds: 600,
  // 成品里显示的「演唱者」——这是机器人自己的名字，不是原唱
  outputArtist: '小鲸鱼',
  // 语音条（/audio/speech）能有多长：实测边界，被协议端拒绝就调小
  voiceMessageMaxSeconds: 600,
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
  const sayInput = input.say && typeof input.say === 'object' ? input.say : {};

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
      defaultVoice: asString(voice.defaultVoice) || DEFAULT_CONFIG.voice.defaultVoice,
      // 常驻换声（模型只加载一次）：留空 = 关掉，退回每次起进程
      serveCommand: asString(voice.serveCommand),
      serveIdleMs: asInt(voice.serveIdleMs, 600000, 60000, 24 * 3600 * 1000),
      segmentSeconds: asInt(voice.segmentSeconds, 30, 0, 600),
      gpuFraction: Number(voice.gpuFraction) >= 0 ? Number(voice.gpuFraction) : 0.9
    },
    // 说话：breeze=云端 / breeze-local=本机权重（带云端兜底）/ none=关掉
    say: {
      engine: ['none', 'breeze', 'breeze-local'].includes(asString(sayInput.engine)) ? asString(sayInput.engine) : DEFAULT_CONFIG.say.engine,
      voice: asString(sayInput.voice),
      rate: asInt(sayInput.rate, DEFAULT_CONFIG.say.rate, -10, 10),
      volume: asInt(sayInput.volume, DEFAULT_CONFIG.say.volume, 0, 100),
      maxChars: asInt(sayInput.maxChars, DEFAULT_CONFIG.say.maxChars, 20, 5000),
      // Breeze 云端 TTS（api.breeze.blue）
      breezeUrl: asString(sayInput.breezeUrl) || 'https://api.breeze.blue',
      breezeKey: asString(sayInput.breezeKey),
      voiceId: asString(sayInput.voiceId),
      breezeModel: asString(sayInput.breezeModel) || 'breeze-tts-2',
      languageCode: asString(sayInput.languageCode),
      instructions: asString(sayInput.instructions),
      guidanceScale: Number(sayInput.guidanceScale) >= 0 ? Number(sayInput.guidanceScale) : 0,
      outputFormat: asString(sayInput.outputFormat) || 'mp3_24000_128',
      timeoutMs: asInt(sayInput.timeoutMs, DEFAULT_CONFIG.say.timeoutMs, 5000, 300000),
      // 本地 Breeze（breeze_infer.api）：走 multipart + 裸 PCM，用参考音频克隆或纯语气设计
      localUrl: asString(sayInput.localUrl) || 'http://127.0.0.1:7860',
      refAudio: asString(sayInput.refAudio),
      refText: asString(sayInput.refText),
      cfgScale: Number(sayInput.cfgScale) >= 0 ? Number(sayInput.cfgScale) : 0,
      localSampleRate: asInt(sayInput.localSampleRate, 24000, 8000, 48000),
      localTimeoutMs: asInt(sayInput.localTimeoutMs, 180000, 10000, 900000),
      // 本地模型闲置多久自动退出（0 = 常驻不退）
      localIdleMs: asInt(sayInput.localIdleMs, 60000, 0, 3600000),
      // 唱歌前停掉本地 TTS / 说话前拉起来（命令留空 = 不调度）
      localPython: asString(sayInput.localPython),
      localModelDir: asString(sayInput.localModelDir),
      localAppDir: asString(sayInput.localAppDir),
      localStopCmd: asString(sayInput.localStopCmd),
      localStartCmd: asString(sayInput.localStartCmd)
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

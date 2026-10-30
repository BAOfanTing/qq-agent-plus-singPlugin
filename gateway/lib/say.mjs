// 说话：把一段文字变成音频。默认用 Windows 自带的 SAPI 语音（离线、零依赖）。
//
// 为什么要这个：宿主的 send_voice 指向本网关后，机器人"想说句话"也会走
// /v1/audio/speech。以前这里只认「唱：歌名」，其余一律回"只会唱歌"，宿主只好退回文字。
// 现在非点歌的文本改走 TTS —— 机器人就能正常发语音了。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PS_SCRIPT = [
  'Add-Type -AssemblyName System.Speech',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  'if ($env:SING_SAY_VOICE) { try { $s.SelectVoice($env:SING_SAY_VOICE) } catch { } }',
  '$s.Rate = [int]$env:SING_SAY_RATE',
  '$s.Volume = [int]$env:SING_SAY_VOLUME',
  '$s.SetOutputToWaveFile($env:SING_SAY_OUT)',
  '$s.Speak($env:SING_SAY_TEXT)',
  '$s.Dispose()'
].join('; ');

function encodedCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function runPowershell(script, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand(script)], {
      windowsHide: true,
      env: { ...process.env, ...env }
    });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Object.assign(new Error(`TTS 超时（${Math.round(timeoutMs / 1000)} 秒）`), { code: 'E_TTS_TIMEOUT' }));
    }, timeoutMs);
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8').slice(-4000); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(`无法启动 powershell：${error.message}`), { code: 'E_TTS_SPAWN' }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ code });
      else reject(Object.assign(new Error(`TTS 失败（退出码 ${code}）：${stderr.split('\n').slice(-2).join(' ').slice(0, 300)}`), { code: 'E_TTS' }));
    });
  });
}

/** 列出可用的系统语音（给 /health 和排错用）。 */
export async function listVoices() {
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }',
    '$s.Dispose()'
  ].join('; ');
  return new Promise((resolve) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand(script)], { windowsHide: true });
    let out = '';
    child.stdout?.on('data', (chunk) => { out += chunk.toString('utf8'); });
    child.on('close', () => resolve(out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)));
    child.on('error', () => resolve([]));
  });
}

/** Edge 神经语音（在线、免费、拟人度最高）。需要本机 python + edge-tts。 */
function makeEdgeEngine(say) {
  const python = String(say.python || 'python');
  const voice = String(say.voice || 'zh-CN-XiaoxiaoNeural');
  // SAPI 的 rate 是 -10..10 的档位，这里映射成百分比（1 档 ≈ 10%）
  const ratePercent = Math.round(Number(say.rate) || 0) * 10;
  const pitchHz = Math.round(Number(say.pitch) || 0);
  const volumePercent = Math.round(Number(say.volume) ?? 100) - 100;
  const maxChars = Math.max(20, Number(say.maxChars) || 800);
  const timeoutMs = Math.max(5000, Number(say.timeoutMs) || 60000);

  return {
    name: 'edge',
    voice,
    async convert({ text, output }) {
      const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
      if (!clean) throw Object.assign(new Error('要读的文字是空的'), { code: 'E_TTS_EMPTY' });
      const target = output.replace(/\.wav$/i, '') + '.mp3';
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const args = ['-m', 'edge_tts', '--voice', voice, '--text', clean, '--write-media', target];
      if (ratePercent !== 0) args.push(`--rate=${ratePercent > 0 ? '+' : ''}${ratePercent}%`);
      if (pitchHz !== 0) args.push(`--pitch=${pitchHz > 0 ? '+' : ''}${pitchHz}Hz`);
      if (volumePercent !== 0) args.push(`--volume=${volumePercent > 0 ? '+' : ''}${volumePercent}%`);
      await new Promise((resolve, reject) => {
        const child = spawn(python, args, { windowsHide: true });
        let stderr = '';
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(Object.assign(new Error(`Edge TTS 超时（${Math.round(timeoutMs / 1000)} 秒）`), { code: 'E_TTS_TIMEOUT' }));
        }, timeoutMs);
        child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8').slice(-2000); });
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(Object.assign(new Error(`启动 edge-tts 失败（python=${python}）：${error.message}`), { code: 'E_TTS_SPAWN' }));
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(Object.assign(new Error(`Edge TTS 失败（退出码 ${code}）：${stderr.split('\n').slice(-2).join(' ').slice(0, 240)}`), { code: 'E_TTS' }));
        });
      });
      if (!fs.existsSync(target) || fs.statSync(target).size < 1000) {
        throw Object.assign(new Error('Edge TTS 没有产出音频'), { code: 'E_TTS_EMPTY_OUTPUT' });
      }
      return { file: target, bytes: fs.statSync(target).size, chars: clean.length, format: 'mp3' };
    }
  };
}

export function createSayEngine(config) {
  const say = config.say || {};
  const engineName = String(say.engine || 'windows');
  if (engineName === 'none' || process.platform !== 'win32') {
    return { name: 'none', async convert() { throw Object.assign(new Error('这台机器没有可用的 TTS 引擎'), { code: 'E_TTS_UNAVAILABLE' }); } };
  }

  const maxChars = Math.max(20, Number(say.maxChars) || 800);
  const timeoutMs = Math.max(5000, Number(say.timeoutMs) || 60000);

  const windows = {
    name: 'windows',
    voice: String(say.voice || ''),
    /** 把文字说成 wav。超出 maxChars 会截断（宿主那边本身只给 300 字左右）。 */
    async convert({ text, output }) {
      const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
      if (!clean) throw Object.assign(new Error('要读的文字是空的'), { code: 'E_TTS_EMPTY' });
      fs.mkdirSync(path.dirname(output), { recursive: true });
      try { fs.rmSync(output, { force: true }); } catch { /* 忽略 */ }
      await runPowershell(PS_SCRIPT, {
        SING_SAY_TEXT: clean,
        SING_SAY_OUT: output,
        SING_SAY_VOICE: String(say.voice || ''),
        SING_SAY_RATE: String(Math.max(-10, Math.min(10, Number(say.rate) || 0))),
        SING_SAY_VOLUME: String(Math.max(0, Math.min(100, Number(say.volume) ?? 100)))
      }, timeoutMs);
      if (!fs.existsSync(output) || fs.statSync(output).size < 1000) {
        throw Object.assign(new Error('TTS 没有产出音频'), { code: 'E_TTS_EMPTY_OUTPUT' });
      }
      return { file: output, bytes: fs.statSync(output).size, chars: clean.length };
    }
  };

  if (engineName !== 'edge') return windows;

  // edge 失败（断网 / 没装 edge-tts）不能让"说话"整单失败 —— 退回系统语音
  const edge = makeEdgeEngine(say);
  return {
    name: 'edge',
    voice: edge.voice,
    async convert(args) {
      try {
        return await edge.convert(args);
      } catch (error) {
        console.warn(`[say] Edge 合成失败，退回系统语音：${String(error?.message ?? error).slice(0, 160)}`);
        return await windows.convert(args);
      }
    }
  };
}

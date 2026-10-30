// 换声：把"一段普通音频"变成"目标音色的歌声"。
//
// 这里刻意不做成"内置 RVC" —— 换声要用哪个模型、要不要先做人声分离（UVR）、用什么音高，
// 每个人都不一样，而且都是 GB 级依赖。所以只留一个**命令行接口**：
//
//   voice.command = "python infer_cli.py --in {input} --out {output} --pitch {pitch}"
//
// 支持两种传参方式，任选：
//   1) 花括号占位符：{input} {output} {pitch} {voice}（路径会被加引号，含空格也安全）
//   2) 环境变量：SING_INPUT / SING_OUTPUT / SING_PITCH / SING_VOICE
//
// 约定：跑完 output 必须存在且非空，否则算失败（不假装成功）。
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const quote = (value) => `"${String(value).replace(/"/g, '\\"')}"`;

function fillCommand(template, values) {
  // {maxSeconds} 是数字（不加引号），其余是路径/名字（加引号）
  return String(template)
    .replace(/\{maxSeconds\}/g, () => String(values.maxSeconds ?? 0))
    .replace(/\{segmentSeconds\}/g, () => String(values.segmentSeconds ?? 0))
    .replace(/\{(input|output|pitch|voice)\}/g, (_, key) => quote(values[key] ?? ''));
}

export function createVoiceEngine(config) {
  const engine = config.voice.engine;

  /** 不需要换声：直接把音源当成品（用于先跑通"点歌→发群"整条链路）。 */
  if (engine === 'none') {
    return {
      name: 'none',
      // 没有接换声模型，就不该报出任何"可用音色" —— 报一个假的比空列表更糟：
      // 使用者和模型都会以为能唱某个音色。
      voices: [],
      async convert({ input, output }) {
        fs.copyFileSync(input, output);
        return { engine: 'none', bytes: fs.statSync(output).size };
      }
    };
  }

  return {
    name: 'command',
    voices: [config.voice.defaultVoice].filter(Boolean),
    convert({ input, output, voice, maxSeconds = 0, onProgress = null }) {
      const values = {
        input,
        output,
        pitch: String(config.voice.pitch),
        voice: voice || config.voice.defaultVoice,
        maxSeconds: String(Math.max(0, Math.floor(Number(maxSeconds) || 0))),
        segmentSeconds: String(Math.max(0, Math.floor(Number(config.voice.segmentSeconds ?? 75) || 0)))
      };
      const command = fillCommand(config.voice.command, values);
      const timeoutMs = config.voice.timeoutMs;
      return new Promise((resolve, reject) => {
        const child = spawn(command, {
          shell: true,
          windowsHide: true,
          env: {
            ...process.env,
            SING_INPUT: values.input,
            SING_OUTPUT: values.output,
            SING_PITCH: values.pitch,
            SING_VOICE: values.voice,
            SING_MAX_SECONDS: values.maxSeconds
          }
        });
        let stderr = '';
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(Object.assign(new Error(`换声命令超时（${Math.round(timeoutMs / 1000)} 秒）`), { code: 'E_TIMEOUT' }));
        }, timeoutMs);
        child.stderr?.on('data', (chunk) => {
          const text = chunk.toString('utf8');
          stderr += text.slice(-6000);
          // run.py 分段换声时会打印 [seg] 2/4 完成 —— 顺手转成进度，
          // 这样群里/控制台能看到正在唱第 2 段，而不是干等几分钟。
          if (typeof onProgress === 'function') {
            for (const line of text.split(/\r?\n/)) {
              const m = /\[seg\]\s*(\d+)\/(\d+)(.*)$/.exec(line.trim());
              if (m) {
                try { onProgress({ done: Number(m[1]), total: Number(m[2]), note: String(m[3] || '').trim() }); }
                catch { /* 进度回调出错不能影响换声 */ }
              }
            }
          }
        });
        child.stdout?.on('data', () => {});
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(Object.assign(new Error(`换声命令启动失败：${error.message}`), { code: 'E_SPAWN' }));
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code !== 0) {
            reject(Object.assign(new Error(`换声命令退出码 ${code}：${stderr.split('\n').slice(-3).join(' ').slice(0, 400)}`), { code: 'E_PROCESS' }));
            return;
          }
          try {
            const stat = fs.statSync(output);
            if (!stat.size) throw new Error('换声命令没有产出文件（output 是空的）');
            resolve({ engine: 'command', bytes: stat.size });
          } catch (error) {
            reject(Object.assign(new Error(`换声命令跑完了但没有产物：${error?.message ?? error}`), { code: 'E_NO_OUTPUT' }));
          }
        });
      });
    }
  };
}

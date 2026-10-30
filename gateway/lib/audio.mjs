// ffmpeg / ffprobe 包装：没有 ffmpeg 就如实降级（不假装成功）。
// 全部走 spawn + 参数数组，不经 shell —— 文件名里有空格或引号也不会被解释成命令。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let ffmpegPath = null;
let probed = false;

export function runProcess(command, args, { timeoutMs = 300000, env = null } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { env: { ...process.env, ...(env || {}) }, windowsHide: true });
    } catch (error) {
      reject(Object.assign(new Error(`无法启动 ${command}：${error.message}`), { code: 'E_SPAWN' }));
      return;
    }
    let stderr = '';
    const timer = setTimeout(() => {
      // Windows 上 child.kill 只杀直接子进程；run.py 的孙进程会活下来霸占 GPU。
      // 这里用 taskkill /T 把整棵树收掉（2026-10-29 踩过：孤儿进程空转 9 小时）。
      if (process.platform === 'win32' && child.pid) {
        try { spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }); } catch { /* 忽略 */ }
      }
      child.kill('SIGKILL');
      reject(Object.assign(new Error(`${command} 超时（${Math.round(timeoutMs / 1000)} 秒）`), { code: 'E_TIMEOUT' }));
    }, timeoutMs);
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8').slice(-8000); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(`无法启动 ${command}：${error.message}`), { code: 'E_SPAWN' }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ code, stderr });
      else reject(Object.assign(new Error(`${command} 退出码 ${code}：${stderr.split('\n').slice(-3).join(' ').slice(0, 400)}`), { code: 'E_PROCESS' }));
    });
  });
}

/** ffmpeg 的候选位置：环境变量 → 仓库自带的 sing-model/bin → PATH。
 *
 * 为什么不能只试 'ffmpeg'：手动起网关时 PATH 里通常没有 ffmpeg，
 * 结果转码静默跳过、把 6.87MB 的 wav 直接发给宿主，被 4MB 上限拒收（2026-10-29 实际踩过）。
 */
function ffmpegCandidates() {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const list = [];
  if (process.env.FFMPEG_PATH) list.push(process.env.FFMPEG_PATH);
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));   // gateway/lib
    const repo = path.resolve(here, '..', '..');
    list.push(path.join(repo, 'sing-model', 'bin', `ffmpeg${exe}`));
  } catch { /* 拿不到路径就跳过 */ }
  list.push('ffmpeg');
  return list;
}

/** 同一个目录里找 ffprobe（换名字即可）。 */
function siblingProbe(ffmpegBin) {
  if (!ffmpegBin || ffmpegBin === 'ffmpeg') return 'ffprobe';
  return ffmpegBin.replace(/ffmpeg(\.exe)?$/i, (m, ext) => `ffprobe${ext || ''}`);
}

/** 只探测一次：ffmpeg 在不在。 */
export async function detectFfmpeg() {
  if (probed) return ffmpegPath;
  probed = true;
  for (const candidate of ffmpegCandidates()) {
    try {
      await runProcess(candidate, ['-version'], { timeoutMs: 8000 });
      ffmpegPath = candidate;
      return ffmpegPath;
    } catch { /* 换下一个 */ }
  }
  ffmpegPath = '';
  return ffmpegPath;
}

/** 时长（秒）；没 ffprobe 或解析失败返回 0（调用方按"不知道"处理，不编造数字）。 */
export async function probeSeconds(file) {
  try {
    const bin = (await detectFfmpeg()) || 'ffmpeg';
    const { stderr } = await runProcess(siblingProbe(bin), [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file
    ], { timeoutMs: 20000 });
    const seconds = Number.parseFloat(String(stderr).trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  } catch {
    return 0;
  }
}

/**
 * 裁到 maxSeconds 并转成目标格式。ffmpeg 不可用时原样返回 false，
 * 让上层决定"发原文件"还是"报错"，而不是偷偷给出一个坏文件。
 */
export async function transcodeTo(input, output, { maxSeconds = 0, ext = 'mp3', bitrate = '96k' } = {}) {
  const bin = await detectFfmpeg();
  if (!bin) return false;
  const args = ['-y', '-i', input];
  if (maxSeconds > 0) args.push('-t', String(Math.floor(maxSeconds)));
  if (ext === 'mp3') args.push('-vn', '-ac', '1', '-ar', '32000', '-b:a', bitrate);
  args.push(output);
  await runProcess(bin, args, { timeoutMs: 120000 });
  return true;
}

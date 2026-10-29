// 任务队列：串行执行、内存态、带 TTL 清理。
//
// 为什么串行：换声是吃显存的活，两个任务并发只会互相拖慢、更可能 OOM。宿主那边一个工具调用
// 默认 3 分钟就超时，靠"排队 + 进度"让调用方知道还在动，比并发更有用。
import crypto from 'node:crypto';

export const JOB_STATES = Object.freeze(['queued', 'running', 'done', 'failed']);

export function createJobQueue({ ttlMs = 24 * 60 * 60 * 1000, runner, now = () => Date.now() } = {}) {
  if (typeof runner !== 'function') throw new Error('createJobQueue 需要 runner 函数');
  const jobs = new Map();
  let chain = Promise.resolve();

  const create = (payload = {}) => {
    const jobId = crypto.randomBytes(8).toString('hex');
    jobs.set(jobId, {
      jobId,
      // payload 原样留给 runner（歌名、上限、指定的条目 id 都在这里），不对外输出
      payload: { ...payload },
      state: 'queued',
      progress: 0,
      createdAt: now(),
      updatedAt: now(),
      title: String(payload.title ?? ''),
      artist: String(payload.artist ?? ''),
      sourceArtist: '',
      engine: String(payload.engine ?? ''),
      voice: String(payload.voice ?? ''),
      audioUrl: '',
      bytes: 0,
      seconds: 0,
      message: '',
      note: '',
      error: ''
    });
    const job = jobs.get(jobId);
    chain = chain.then(async () => {
      if (job.state !== 'queued') return;
      job.state = 'running';
      job.updatedAt = now();
      try {
        const result = await runner(job, {
          progress: (value, note = '') => {
            job.progress = Math.min(0.99, Math.max(0, Number(value) || 0));
            if (note) job.message = String(note);
            job.updatedAt = now();
          }
        });
        Object.assign(job, {
          state: 'done',
          progress: 1,
          audioUrl: String(result?.audioUrl ?? ''),
          bytes: Math.max(0, Number(result?.bytes) || 0),
          seconds: Math.max(0, Number(result?.seconds) || 0),
          engine: String(result?.engine ?? job.engine),
          title: String(result?.title ?? job.title),
          artist: String(result?.artist ?? job.artist),
          message: '',
          note: String(result?.note ?? ''),
          updatedAt: now()
        });
      } catch (error) {
        job.state = 'failed';
        job.error = String(error?.message ?? error);
        job.message = job.error;
        job.updatedAt = now();
      }
    });
    return job;
  };

  const get = (jobId) => jobs.get(String(jobId ?? '').trim()) || null;

  /** 序列化给 HTTP：不把内部字段（比如 pending 的临时路径）漏出去。 */
  const view = (job) => ({
    ok: job.state !== 'failed',
    jobId: job.jobId,
    state: job.state,
    progress: job.progress,
    title: job.title,
    artist: job.artist,
    sourceArtist: job.sourceArtist || '',
    engine: job.engine,
    voice: job.voice,
    audioUrl: job.audioUrl,
    bytes: job.bytes,
    seconds: job.seconds,
    message: job.message,
    note: job.note || '',
    ...(job.error ? { error: job.error } : {})
  });

  const prune = () => {
    const cutoff = now() - ttlMs;
    let removed = 0;
    for (const [jobId, job] of jobs) {
      if (job.updatedAt >= cutoff) continue;
      if (job.state === 'running' || job.state === 'queued') continue;
      jobs.delete(jobId);
      removed += 1;
    }
    return removed;
  };

  /** 测试用：等当前队列静下来（不改变语义，只是把 chain 暴露出来）。 */
  const idle = () => chain;

  return { create, get, view, prune, idle, size: () => jobs.size };
}

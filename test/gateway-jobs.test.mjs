import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobQueue } from '../gateway/lib/jobs.mjs';

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

test('任务串行执行：第二个要等第一个跑完', async () => {
  const order = [];
  const queue = createJobQueue({
    runner: async (job) => {
      order.push(`start:${job.payload.tag}`);
      await tick(10);
      order.push(`end:${job.payload.tag}`);
      return { audioUrl: `/files/${job.jobId}.mp3`, bytes: 1, seconds: 5 };
    }
  });
  const a = queue.create({ tag: 'a' });
  const b = queue.create({ tag: 'b' });
  await queue.idle();
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b']);
  assert.equal(queue.get(a.jobId).state, 'done');
  assert.equal(queue.get(b.jobId).state, 'done');
  assert.equal(queue.get(a.jobId).progress, 1);
});

test('runner 抛错 → 任务落 failed，错误信息保留', async () => {
  const queue = createJobQueue({ runner: async () => { throw new Error('模型没加载'); } });
  const job = queue.create({ tag: 'x' });
  await queue.idle();
  const done = queue.get(job.jobId);
  assert.equal(done.state, 'failed');
  assert.equal(done.error, '模型没加载');
  // failed 的任务对外是 ok:false
  assert.equal(queue.view(done).ok, false);
});

test('进度回调被记录，但不会超过 0.99（只有 done 才是 1）', async () => {
  let seen = 0;
  const queue = createJobQueue({
    runner: async (job, { progress }) => {
      progress(0.5, '换声中');
      seen = queue.get(job.jobId).progress;
      progress(2, '收尾');
      return { audioUrl: '/files/x.mp3', bytes: 1, seconds: 1 };
    }
  });
  const job = queue.create({ tag: 'p' });
  await queue.idle();
  assert.equal(seen, 0.5);
  assert.equal(queue.get(job.jobId).progress, 1);
});

test('prune 只清理过期的结束态任务，running/queued 不动', async () => {
  let clock = 1_800_000_000_000;
  const queue = createJobQueue({
    now: () => clock,
    ttlMs: 1000,
    runner: async (job) => {
      if (job.payload.hang) await new Promise(() => {}); // 永远不结束
      return { audioUrl: '/files/x.mp3', bytes: 1, seconds: 1 };
    }
  });
  const done = queue.create({ tag: 'done' });
  await queue.idle();
  const hanging = queue.create({ tag: 'hanging', hang: true });
  await tick(5);

  clock += 5000;
  const removed = queue.prune();
  assert.equal(removed, 1);
  assert.equal(queue.get(done.jobId), null);
  assert.equal(queue.get(hanging.jobId).state, 'running');
});

test('view 不泄漏内部字段（payload/createdAt 这类）', async () => {
  const queue = createJobQueue({ runner: async () => ({ audioUrl: '/files/a.mp3', bytes: 2, seconds: 3 }) });
  const job = queue.create({ tag: 'secret-internal', song: '某歌' });
  await queue.idle();
  const view = queue.view(queue.get(job.jobId));
  assert.equal(view.song, undefined);
  assert.equal(view.payload, undefined);
  assert.equal(view.audioUrl, '/files/a.mp3');
});

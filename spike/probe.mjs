/**
 * P1 spike：不进 DSH，直接验证 BreezeTTS 适配器。
 * 跑法：node spike/probe.mjs
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stat } from 'node:fs/promises';
import { cleanForSpeech, capText, createTts } from '../lib/tts.mjs';

const cfg = {
  baseUrl: process.env.VB_BASE_URL || 'http://127.0.0.1:8080',
  voice: '',
  instructions: '一位声音自然的年轻女性，语速适中。',
  cfgScale: 2.5,
  seed: 42,
  timeoutMs: 120000,
  cacheMaxMb: 64,
  autoStartServer: false,
  startScript: '',
};

const cacheDir = join(tmpdir(), 'voice-breeze-probe-cache');
const tts = createTts({ cfg, cacheDir, logger: console });

const ms = async (label, fn) => {
  const t0 = Date.now();
  const value = await fn();
  console.log(`${label}: ${Date.now() - t0} ms`);
  return value;
};

console.log('health:', await tts.healthy());

const first = await ms('首次合成', () => tts.enqueue(() => tts.synthesize('第一句：接口连通测试。', {}, undefined)));
const info = await stat(first.file);
console.log('  文件:', first.file);
console.log('  字节:', info.size, '| 缓存命中:', first.cached);

// WAV 头校验
const head = (await import('node:fs')).readFileSync(first.file).subarray(0, 12);
console.log('  RIFF/WAVE:', head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WAVE');

const second = await ms('同句再来一次（应命中缓存）', () => tts.enqueue(() => tts.synthesize('第一句：接口连通测试。', {}, undefined)));
console.log('  缓存命中:', second.cached, '| 耗时:', second.ms, 'ms');

const t0 = Date.now();
const [a, b] = await Promise.all([
  tts.enqueue(() => tts.synthesize('并发第一句，串行队列测试。', {}, undefined)),
  tts.enqueue(() => tts.synthesize('并发第二句，串行队列测试。', {}, undefined)),
]);
console.log(`并发两句（应被串行化）: 总 ${Date.now() - t0} ms | 单句 ${a.ms} / ${b.ms} ms`);

console.log('清洗:', cleanForSpeech('**结论** 跑通了 `npm test`，详见 https://example.com/x [链接](http://a.b)'));
console.log('截断:', capText('第一句话说完了。第二句也说完，第三句会被砍掉因为超过字数上限了。', 18));

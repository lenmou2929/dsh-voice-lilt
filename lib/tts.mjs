/**
 * BreezeTTS 适配器（纯 Node，不依赖 DSH）。
 *
 * 单独抽出来的原因：
 *  1. 可以被 spike/probe.mjs 直接跑，不用把 DSH 拉起来就能验证串行、409 重试、缓存；
 *  2. 换引擎（edge-tts / 别家 OpenAI 兼容端点）只改这一层。
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 去掉不该念的东西：代码块、行内代码、Markdown 标记、URL。 */
/**
 * 清洗一段文本，只留下念得出来的东西。
 *
 * 选项：
 *  - `stripMarkers: false` —— **不剥行首的 `名字：`**。给「全文」模式用：那里的冒号绝大多数是
 *    正常句子的冒号（「声音侧有一件事必须先知道：…」），一律当说话人剥掉会把整句前半截吞掉
 *    。全文模式改成按 `readCast()`
 *    里的真名字精确剥，见 `host.mjs` 的 `stripCastMarker()`。
 */
export function cleanForSpeech(raw, opts = {}) {
  const stripMarkers = opts.stripMarkers !== false;
  const out = String(raw ?? '')
    // 复述层被截断时会漏出 JSON 残骸（"segments":[{"text":"…），先把键名与花括号清掉，
    // 但**保留方括号**——[叹气] 这类拟声标签要原样留给 TTS。
    .replace(/"(segments|speaker|voice|tone|text)"\s*:\s*/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/[{}]/g, ' ')
    .replace(/\[\s*"/g, ' ')
    .replace(/"\s*\]/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    // 行内代码**保留文字、只去符号**（以前整段吞成空格，听起来会少一块）
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_#>|]+/g, '');
  // 行首说话人标记（旁白：／角色甲（心声）：）—— 默认行为，角色扮演与复述都靠它
  const cleaned = stripMarkers
    ? out.replace(/^\s*[^\s：:]{1,14}(?:[（(][^）)]{1,12}[）)])?\s*[：:]\s*/gm, '')
    : out;
  return cleaned.replace(/\s+/g, ' ').trim();
}

/** 在标点处截断，别把半句话掐死。 */
export function capText(text, maxChars) {
  if (!maxChars || text.length <= maxChars) return text;
  const head = text.slice(0, maxChars);
  const cut = Math.max(
    head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'),
    head.lastIndexOf('；'), head.lastIndexOf('，'), head.lastIndexOf('.'),
  );
  if (cut >= maxChars * 0.4) return head.slice(0, cut + 1);
  return `${head}…`;
}

/** 句末标点与分段符；抽取兜底句时按这些切。 */
const SENTENCE_BREAK = /[。！？!?；;\n]+/;

/** 兜底句专用清洗：剥掉代码/表格/链接，但**保留换行**，否则列表会粘成一句。 */
function stripForSpeaking(raw) {
  return String(raw ?? '')
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_#>|]+/g, '')
    .replace(/^[-—•\s]+/gm, '');
}

/**
 * 从一段回复里取出「最适合念出来的第一句」。
 *
 * 规则（都是踩过的坑）：
 *  - 先剥掉代码块、行内代码、表格、标题符号、URL、列表符号，但保留换行；
 *  - 按句/行切开，优先取长度 ≥ 6 且不以冒号结尾的句子（跳过「主要延迟来自三部分：」这类导语）；
 *  - 全都不合格时退而取第一段文字（去掉尾部冒号），总比不念强；
 *  - 仍然没有就返回空串，交给调用方决定不念。
 */
export function firstSpeakableSentence(raw) {
  const cleaned = stripForSpeaking(raw);
  if (!cleaned.trim()) return '';
  const pieces = cleaned.split(SENTENCE_BREAK).map((part) => part.trim()).filter(Boolean);

  const withStop = (text) => (/[。！？!?；;，,.]$/.test(text) ? text : `${text}。`);

  for (const piece of pieces) {
    if (piece.length < 6) continue;
    if (/[:：]$/.test(piece)) continue;
    if (!/[\u4e00-\u9fa5a-zA-Z0-9]/.test(piece)) continue;
    return withStop(piece);
  }

  const firstText = pieces.find((piece) => /[\u4e00-\u9fa5a-zA-Z0-9]/.test(piece));
  if (!firstText) return '';
  const trimmed = firstText.replace(/[:：]+$/, '').trim();
  return trimmed ? withStop(trimmed) : '';
}

/** 摘要兜底：本轮走了几步 + 最后一句，不需要额外调用模型。 */
export function buildSummaryLine({ steps = 0, sentence = '' }) {
  const tail = sentence || '';
  const head = steps >= 2 ? `本轮 ${steps} 步` : '本轮完成';
  return tail ? `${head}，${tail}` : head;
}

export function createTts({ cfg, cacheDir, logger }) {
  let lastError = '';
  let chain = Promise.resolve();

  function note(message) {
    lastError = message;
    logger?.warn?.(`[voice-breeze] ${message}`);
  }

  async function healthy() {
    try {
      const res = await fetch(new URL('/health', cfg.baseUrl), { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return false;
      const body = await res.json().catch(() => ({}));
      return body?.status === 'ok';
    } catch {
      return false;
    }
  }

  let lastSpawnAt = 0;
  /**
   * 只负责把服务拉起来（立刻返回，不等待）。
   * 3 分钟内不重复拉起：BreezeTTS 冷启动要一分多钟，脚本又带 pause，
   * 反复 spawn 会堆出好几个控制台；超过 3 分钟认为上次没成，允许再试一次。
   */
  function startServer() {
    const now = Date.now();
    if (lastSpawnAt && now - lastSpawnAt < 180000) return false;
    lastSpawnAt = now;
    try {
      spawn('cmd', ['/c', cfg.startScript], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return true;
    } catch (error) {
      note(`启动 BreezeTTS 失败: ${error && error.message}`);
      return false;
    }
  }

  /** 探活；不通且允许自启就拉起，然后最多等 waitMs。 */
  async function ensureServer(waitMs) {
    if (await healthy()) return true;
    if (!cfg.autoStartServer) return false;
    startServer();
    const deadline = Date.now() + Number(waitMs ?? cfg.startWaitMs ?? 20000);
    while (Date.now() < deadline) {
      await sleep(1000);
      if (await healthy()) return true;
    }
    return false;
  }

  /**
   * 解析一次合成实际要用的参数（voice / instructions / cfg_scale）。
   * 分成两种模式，别混用（BreezeTTS 官方手册 §4）：
   *  - 指挥模式（有 voice）：instructions 只写语气/情绪/语速，重复音色描述会互相打架；cfg 2~3 最稳，>3 刺耳。
   *  - 设计模式（无 voice）：instructions 是音色描述，官方推荐 cfg 4 加强指令跟随。
   */
  function resolveParams(overrides = {}) {
    const voice = overrides.voice ?? cfg.voice ?? '';
    const instructions = overrides.instructions
      ?? (voice ? (cfg.toneInstructions || cfg.instructions) : cfg.instructions)
      ?? '';
    const rawScale = overrides.cfg_scale ?? cfg.cfgScale;
    const cfgScale = (rawScale === null || rawScale === undefined || rawScale === '')
      ? (voice ? 2.5 : 4)
      : Number(rawScale);
    const seed = overrides.seed ?? cfg.seed ?? null;
    return { voice, instructions, cfgScale, seed };
  }

  async function requestSpeech(text, overrides, signal) {
    const params = resolveParams(overrides);
    const body = { model: 'tts-1', input: text, response_format: 'wav' };
    if (params.voice) body.voice = params.voice;
    if (params.instructions) body.instructions = params.instructions;
    if (Number.isFinite(params.cfgScale)) body.cfg_scale = params.cfgScale;
    if (params.seed !== null && params.seed !== undefined) body.seed = Number(params.seed);

    let lastFailure = '';
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (signal?.aborted) throw new Error('cancelled');
      try {
        const res = await fetch(new URL('/v1/audio/speech', cfg.baseUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(cfg.timeoutMs)]),
        });
        if (res.status === 409) {
          lastFailure = 'BreezeTTS 忙（409）';
          await sleep(400 * (attempt + 1));
          continue;
        }
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          lastFailure = `HTTP ${res.status} ${detail.slice(0, 200)}`;
          if (res.status >= 500) {
            await sleep(400 * (attempt + 1));
            continue;
          }
          throw new Error(lastFailure);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 1024) throw new Error(`音频过短（${buf.length} 字节）`);
        return buf;
      } catch (error) {
        if (error?.name === 'AbortError' || /cancelled/.test(String(error?.message))) throw error;
        lastFailure = String((error && error.message) || error);
        await sleep(400 * (attempt + 1));
      }
    }
    throw new Error(lastFailure || '未知错误');
  }

  /**
   * 流式请求：拿到响应头后立刻开始读 body，每块音频回调一次 onChunk。
   * BreezeTTS 的 wav 头长度字段是占位值，正好适合边生成边播。
   */
  async function requestSpeechStream(text, overrides, onChunk, signal) {
    const params = resolveParams(overrides);
    const body = { model: 'tts-1', input: text, response_format: 'wav' };
    if (params.voice) body.voice = params.voice;
    if (params.instructions) body.instructions = params.instructions;
    if (Number.isFinite(params.cfgScale)) body.cfg_scale = params.cfgScale;
    if (params.seed !== null && params.seed !== undefined) body.seed = Number(params.seed);

    let lastFailure = '';
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (signal?.aborted) throw new Error('cancelled');
      let res;
      try {
        res = await fetch(new URL('/v1/audio/speech', cfg.baseUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(cfg.timeoutMs)]),
        });
      } catch (error) {
        lastFailure = String((error && error.message) || error);
        await sleep(400 * (attempt + 1));
        continue;
      }
      if (res.status === 409) {
        lastFailure = 'BreezeTTS 忙（409）';
        await sleep(400 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        lastFailure = `HTTP ${res.status} ${detail.slice(0, 200)}`;
        if (res.status >= 500) {
          await sleep(400 * (attempt + 1));
          continue;
        }
        throw new Error(lastFailure);
      }

      const parts = [];
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || !value.byteLength) continue;
          const chunk = Buffer.from(value);
          parts.push(chunk);
          onChunk?.(chunk);
        }
      } else {
        const whole = Buffer.from(await res.arrayBuffer());
        parts.push(whole);
        onChunk?.(whole);
      }
      const buf = Buffer.concat(parts);
      if (buf.length < 1024) throw new Error(`音频过短（${buf.length} 字节）`);
      return buf;
    }
    throw new Error(lastFailure || '未知错误');
  }

  function cacheKey(text, overrides) {
    const h = createHash('sha1');
    const params = resolveParams(overrides);
    h.update(JSON.stringify({
      base: cfg.baseUrl,
      text,
      voice: params.voice,
      instructions: params.instructions,
      cfgScale: params.cfgScale,
      seed: params.seed,
    }));
    return h.digest('hex');
  }

  async function trimCache() {
    try {
      const names = await readdir(cacheDir);
      const files = [];
      for (const name of names) {
        if (!name.endsWith('.wav')) continue;
        const full = join(cacheDir, name);
        const info = await stat(full).catch(() => null);
        if (info) files.push({ full, size: info.size, mtime: info.mtimeMs });
      }
      const limit = (cfg.cacheMaxMb || 64) * 1024 * 1024;
      let total = files.reduce((sum, f) => sum + f.size, 0);
      if (total <= limit) return;
      files.sort((a, b) => a.mtime - b.mtime);
      for (const f of files) {
        if (total <= limit) break;
        await unlink(f.full).catch(() => {});
        total -= f.size;
      }
    } catch { /* 缓存目录还不存在 */ }
  }

  async function synthesize(text, overrides, signal) {
    await mkdir(cacheDir, { recursive: true });
    const key = cacheKey(text, overrides);
    const file = join(cacheDir, `${key}.wav`);
    const cached = await stat(file).catch(() => null);
    if (cached) return { file, ms: 0, cached: true };

    const started = Date.now();
    const buf = await requestSpeech(text, overrides, signal);
    await writeFile(file, buf);
    void trimCache();
    return { file, ms: Date.now() - started, cached: false };
  }

  /**
   * 流式合成：边收边吐。onChunk(Buffer) 每收到一块音频就回调一次，
   * 调用方可以把字节直接转给浏览器，实现"边生成边播放"。
   * 缓存命中时不会有网络往返，一次性把整个文件当一块吐出来（仍是同一个回调接口）。
   */
  async function synthesizeStream(text, overrides, onChunk, signal) {
    await mkdir(cacheDir, { recursive: true });
    const key = cacheKey(text, overrides);
    const file = join(cacheDir, `${key}.wav`);
    const cached = await stat(file).catch(() => null);
    if (cached) {
      const buf = await readFile(file);
      onChunk?.(buf);
      return { file, ms: 0, cached: true, bytes: buf.length };
    }

    const started = Date.now();
    const parts = [];
    const buf = await requestSpeechStream(text, overrides, (chunk) => {
      parts.push(chunk);
      onChunk?.(chunk);
    }, signal);
    await writeFile(file, buf);
    void trimCache();
    return { file, ms: Date.now() - started, cached: false, bytes: buf.length };
  }

  /** 串行：BreezeTTS 一次只吃一个请求，并发会 409。 */
  function enqueue(task) {
    const run = chain.then(task, task);
    chain = run.catch(() => {});
    return run;
  }

  return {
    healthy,
    ensureServer,
    startServer,
    synthesize,
    synthesizeStream,
    enqueue,
    trimCache,
    get lastError() { return lastError; },
    set lastError(value) { lastError = value; },
  };
}

/**
 * 生成页的落盘层（G1 / 0.96.0）。
 *
 * 职责只有一件：**把一段合成好的音频安全地放进用户选定的目录，并记账**。
 * 它不合成、不碰引擎、不认识 DSH —— 宿主与自测脚本都直接用它。
 *
 * 四条规矩：
 *  1. **只出 wav**；但重名检查**同时认 .wav 与 .mp3**（同一个名字后缀不该被另一种格式占着）；
 *  2. 重名 `xxx` → `xxx-1` → `xxx-2`…；写盘用 `wx`（不覆盖），撞了就换下一个 —— 并发也不会写坏；
 *  3. 所有读写都限制在配置目录内（拒绝 `..`、拒绝绝对路径逃逸）；
 *  4. 落盘前先 `normalizeWav()`（坑 25：MiniMax 的 `AIGC` 块会让浏览器把尾巴当 PCM 解出刺拉声）。
 */

import { mkdir, readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { normalizeWav } from './tts.mjs';

/** 只出这一种容器（用户拍板）。 */
export const GEN_EXT = '.wav';
/** 重名检查要认的扩展名（以后支持 mp3 时不用再改这套逻辑）。 */
export const GEN_KNOWN_EXT = ['.wav', '.mp3'];
/** 文件名主体最长多少字（含中文按字算，不是字节）。 */
export const GEN_NAME_MAX = 60;

const ILLEGAL_CHARS = /[\\/:*?"<>|]/g;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
/** Windows 的保留设备名：叫 `con.wav` 的文件建不出来。 */
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/**
 * 把用户/模型给的名字洗成能落盘的样子：去非法字符、去手写扩展名、
 * 去结尾的 `.` 与空格（Windows 不接受）、限长、绕开保留名；空了就用兜底名。
 */
export function sanitizeGenName(raw, fallback = '语音') {
  let name = String(raw ?? '').replace(CONTROL_CHARS, ' ').replace(ILLEGAL_CHARS, '').trim();
  const ext = extname(name).toLowerCase();
  if (GEN_KNOWN_EXT.includes(ext)) name = name.slice(0, -ext.length);
  // 结尾的句读也去掉：默认名取"文本前 12 字"时很容易停在逗号上（`这是 G3 的落盘验收，.wav` 就是这么来的）
  name = name.replace(/[.．，,、;；:：!！?？\s]+$/g, '').trim();
  if (name.length > GEN_NAME_MAX) {
    name = name.slice(0, GEN_NAME_MAX).replace(/[.．，,、;；:：!！?？\s]+$/g, '').trim();
  }
  if (!name) name = String(fallback || '语音');
  if (RESERVED_NAMES.has(name.toLowerCase())) name = `_${name}`;
  return name;
}

/** `xxx-1.wav` → `xxx-1`；不认识的扩展名原样返回（大小写不敏感）。 */
export function baseNameOf(file) {
  const name = String(file || '');
  const ext = extname(name).toLowerCase();
  return GEN_KNOWN_EXT.includes(ext) ? name.slice(0, -ext.length) : name;
}

/** 目录里现成的文件名 → 已占用的名字集合（小写、去扩展名；`.mp3` 也算占用）。 */
export function takenFromFiles(files) {
  const taken = new Set();
  for (const one of files || []) {
    const name = String(one || '');
    const ext = extname(name).toLowerCase();
    if (!GEN_KNOWN_EXT.includes(ext)) continue;
    const base = name.slice(0, -ext.length).trim().toLowerCase();
    if (base) taken.add(base);
  }
  return taken;
}

/** 按 `xxx` → `xxx-1` → `xxx-2`… 找第一个没被占用的名字。 */
export function nextFreeName(base, taken, limit = 999) {
  const want = String(base || '').trim() || '语音';
  const used = taken instanceof Set ? taken : takenFromFiles(taken);
  if (!used.has(want.toLowerCase())) return want;
  for (let i = 1; i <= limit; i += 1) {
    const candidate = `${want}-${i}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error(`同名文件太多（${want}-1 ~ -${limit}）`);
}

/** `target` 是否还在 `dir` 之内（防 `..` 与绝对路径逃逸）。 */
export function withinDir(dir, target) {
  const root = resolve(String(dir || ''));
  const abs = resolve(String(target || ''));
  if (!root || !abs) return false;
  if (abs === root) return true;
  const rel = relative(root, abs);
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..');
}

/**
 * G5：垃圾桶的容量上限，默认 128 MB。
 *
 * 参考量级：一段 5 秒 24 kHz 单声道 16 bit ≈ 240 KB，128 MB ≈ 500 段；
 * 合成缓存 `cache/` 的上限是 512 MB —— 垃圾桶比它小一号是故意的：**它是后悔药，不是仓库**。
 * 配成 `0` = 不设上限（只留手动清空）。
 */
export const TRASH_DEFAULT_MAX_BYTES = 128 * 1024 * 1024;

/**
 * 从垃圾桶里的文件名取"**什么时候被丢进来**"。
 *
 * 为什么不能直接用 mtime：进垃圾桶走的是 `rename`，而 **`rename` 保留内容 mtime** ——
 * 于是垃圾桶里的 mtime 其实是"这条音频什么时候**生成**的"。实测证据：
 * `验收样品-2026-11-17T17-08-58-210Z.wav` 文件名里是 11-17 17:08（删的那一刻），
 * mtime 却是 11-16 16:40（生成的那一刻）。按 mtime 淘汰会先删"生成得早但昨天才删"的，
 * 留下"生成得晚但上周就删了"的 —— **淘汰序与人的直觉正好错开**。
 *
 * 所以两条一起用：**新文件靠 mtime**（1.0.9 起进桶时 `utimes` 成删除时刻），
 * 老文件靠**文件名里的时间戳**兜底（`-2026-11-18T12-45-39-710Z.wav` 就是它）。
 * 都取不到才退回 mtime。名字里有时间戳时**以它为准** —— 它记的一定是删除时刻。
 */
export function trashEntryTimeMs(name, mtimeMs) {
  const ms = Number(mtimeMs);
  const fallback = Number.isFinite(ms) ? ms : 0;
  const raw = String(name || '');
  const m = raw.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
  if (!m) return fallback;
  const parsed = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * 垃圾桶的淘汰计划（**纯函数**，宿主与自测共用）。
 *
 * 规则只有一条：**总量超过上限时，从"最先进桶的"开始删，删到不超为止。**
 * 于是"刚删错想找回"天然被保护 —— 最新进桶的永远最后才轮到（不需要再加"宽限期"旋钮）。
 *
 * @param items [{ name, size, atMs }]  —— `atMs` 由 `trashEntryTimeMs()` 给
 * @param opts  { maxBytes }             —— `<= 0` 表示不设上限（全留）
 * @returns { keep, drop, totalBytes, dropBytes, keepBytes }
 */
export function planTrashPrune(items, opts = {}) {
  const list = (Array.isArray(items) ? items : [])
    .filter((one) => one && typeof one === 'object')
    .map((one) => ({
      name: String(one.name || ''),
      size: Number(one.size) || 0,
      atMs: Number(one.atMs) || 0,
    }))
    .filter((one) => one.name);
  const totalBytes = list.reduce((n, one) => n + one.size, 0);
  const maxBytes = Number(opts.maxBytes);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || totalBytes <= maxBytes) {
    return { keep: list, drop: [], totalBytes, dropBytes: 0, keepBytes: totalBytes };
  }
  // 旧的在前；同一毫秒按名字定序 —— 同一份输入永远算出同一个答案（可测）
  const ordered = list.slice().sort((a, b) => (a.atMs - b.atMs) || a.name.localeCompare(b.name));
  let remain = totalBytes;
  const drop = [];
  for (const one of ordered) {
    if (remain <= maxBytes) break;
    drop.push(one);
    remain -= one.size;
  }
  const dropped = new Set(drop.map((one) => one.name));
  return {
    keep: list.filter((one) => !dropped.has(one.name)),
    drop,
    totalBytes,
    dropBytes: totalBytes - remain,
    keepBytes: remain,
  };
}

export function indexFilePath(dir) {
  return join(resolve(String(dir || '')), 'index.json');
}

/** 宽容读：文件没有、坏了、形状不对，一律当空表（绝不因为一条烂记录让人看不到列表）。 */
export function parseGeneratedIndex(text) {
  try {
    const value = JSON.parse(String(text ?? ''));
    const list = Array.isArray(value) ? value : (Array.isArray(value?.items) ? value.items : []);
    return list.filter((one) => one && typeof one === 'object');
  } catch {
    return [];
  }
}

export async function readGeneratedIndex(dir) {
  try {
    return parseGeneratedIndex(await readFile(indexFilePath(dir), 'utf8'));
  } catch {
    return [];
  }
}

/** 原子写（先写 `.tmp` 再 rename）：半截 JSON 会让整个列表消失。 */
export async function writeGeneratedIndex(dir, entries) {
  const root = resolve(String(dir || ''));
  const file = indexFilePath(root);
  await mkdir(root, { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
  return file;
}

/** 只追加：同一个文件名只留最新一条（重命名/重存不会长出两条同名记录）。 */
export async function appendGeneratedEntry(dir, entry) {
  const list = await readGeneratedIndex(dir);
  const next = list.filter((one) => one && one.file !== entry.file);
  next.push(entry);
  await writeGeneratedIndex(dir, next);
  return next;
}

/**
 * G4（1.0.8）：按给定的文件名顺序重排账目（`06` §6 的"结果列表拖拽排序"）。
 *
 * 三条规矩，写成纯函数是为了能被 `spike/g0-g1-check.mjs` 直接测：
 *  1. **只认列表里真实存在的 `file`** 用户/客户端给的名字先过一遍现有记录，不存在的直接丢
 *     （别让一次手滑把整张表洗没）；
 *  2. 没在 `order` 里出现的记录**保持原相对顺序接在末尾** —— 拖一个不该让其余的排队乱掉；
 *  3. 结果长度必须等于原长度（去重 + 补齐都在这里做完），否则调用方拿到的就是"少了几条"。
 */
export function reorderEntries(entries, order) {
  const list = (Array.isArray(entries) ? entries : []).filter((one) => one && typeof one === 'object');
  const byFile = new Map();
  for (const one of list) {
    const key = String(one.file || '');
    if (key && !byFile.has(key)) byFile.set(key, one);
  }
  const out = [];
  const used = new Set();
  for (const raw of (Array.isArray(order) ? order : [])) {
    const key = String(raw || '').trim();
    if (!key || used.has(key) || !byFile.has(key)) continue;
    used.add(key);
    out.push(byFile.get(key));
  }
  for (const one of list) {
    const key = String(one.file || '');
    if (key && used.has(key)) continue;
    if (key) used.add(key);
    out.push(one);
  }
  return out;
}

/** 统一的记录形状。 */
/**
 * 2026-11-18：数值字段的归一化。
 *
 * **`Number(null) === 0`** —— 直接写 `Number.isFinite(Number(one.seed))` 会把"没给 seed"
 * 记成 `seed: 0`，于是面板回填出一个 0、下次生成就真的带 `seed:0`（引擎把 0 当合法种子，
 * 不是"默认"）。"没给"必须记成 `null`，才能和"给了 0"区分开。
 */
const numOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export function generatedEntry(input) {
  const one = input && typeof input === 'object' ? input : {};
  return {
    name: String(one.name || ''),
    file: String(one.file || ''),
    engineId: String(one.engineId || ''),
    engineKind: String(one.engineKind || ''),
    voice: String(one.voice || ''),
    style: one.style && typeof one.style === 'object' ? one.style : {},
    // G3：**把这次用的整套参数记下来** —— 面板打开「生成」页时要拿它回填表单
    // （用户在模型给的基础上微调再生成，这就是用户要的闭环）。
    text: String(one.text || ''),
    instructions: String(one.instructions || ''),
    // B1（0.98.0）：这次用的是哪种生成模式（design/clone/direction/auto）。
    // 回填表单和"按这条参数再生成"都要它；**加字段记得同步这个白名单**
    // （此函数第二次漏字段了，见 `06` 坑 40）。
    genMode: String(one.genMode || ''),
    seed: numOrNull(one.seed),
    cfgScale: numOrNull(one.cfgScale),
    /*
     * G4：**采样六项进账**。
     *
     * B2 当时明说"采样写进 index 留给 G4"（`10` §12 的 G1~G4 条目），这就是那一刻。
     * 少了它们，「按这条参数再生成」会静默丢参数：用户看到温度那一格是空的，
     * 而两条音频听着不一样 —— 同一个病在 0.98.0 已经犯过两次（`06` 坑 40，**这是第三次**）。
     * 规则照旧：`numOrNull`（"没给"是 `null`，不是 `0`，坑 42）。
     */
    temperature: numOrNull(one.temperature),
    top_k: numOrNull(one.top_k),
    top_p: numOrNull(one.top_p),
    repetition_penalty: numOrNull(one.repetition_penalty),
    max_new_tokens: numOrNull(one.max_new_tokens),
    split_chars: numOrNull(one.split_chars),
    // 变声档：源文件名（"再生成"要能指回同一段源）+ KEEP MELODY。
    // `fromFile` 与下面的 `source`（user/model）是两件事，别混。
    fromFile: String(one.fromFile || ''),
    keepAcoustic: numOrNull(one.keepAcoustic),
    chars: Number(one.chars) || 0,
    ms: Number(one.ms) || 0,
    // 音频本身有多长（毫秒）。`ms` 是**合成花了多久**，两件事不要混：
    // 生成页的结果列表要显示"这段多长"，排查合成快慢才看 `ms`。
    durationMs: Number(one.durationMs) || 0,
    at: String(one.at || new Date().toISOString()),
    source: one.source === 'model' ? 'model' : 'user',
    bytes: Number(one.bytes) || 0,
  };
}

/**
 * 落盘一次合成结果。
 *
 * - `buffer` 会**无条件**过 `normalizeWav()`（坑 25 的老规矩）；
 * - 目录里现成的文件 + `index.json` 里的名字一起算"已占用"（文件被手工删掉也不会复用旧名）；
 * - `wx` 写盘：并发撞名就换后缀，绝不覆盖已有音频。
 */
export async function saveGeneratedWav({ dir, base, buffer, meta, limit = 999 }) {
  const root = resolve(String(dir || ''));
  if (!root) throw new Error('没有输出目录');
  await mkdir(root, { recursive: true });
  const taken = takenFromFiles(await readdir(root).catch(() => []));
  for (const one of await readGeneratedIndex(root).catch(() => [])) {
    for (const name of takenFromFiles([one && one.file])) taken.add(name);
  }

  const clean = normalizeWav(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []));
  if (!clean || clean.length < 1024) throw new Error(`音频过短（${clean ? clean.length : 0} 字节）`);

  const wanted = String(base || '').trim() || '语音';
  let name = nextFreeName(wanted, taken, limit);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const file = join(root, `${name}${GEN_EXT}`);
    if (!withinDir(root, file)) throw new Error('输出路径越界');
    try {
      await writeFile(file, clean, { flag: 'wx' });
      const entry = generatedEntry({
        ...(meta || {}),
        name,
        file: `${name}${GEN_EXT}`,
        bytes: clean.length,
      });
      await appendGeneratedEntry(root, entry);
      return { ...entry, path: file };
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        taken.add(name.toLowerCase());
        name = nextFreeName(wanted, taken, limit);
        continue;
      }
      throw error;
    }
  }
  throw new Error('写盘失败：名字一直撞');
}

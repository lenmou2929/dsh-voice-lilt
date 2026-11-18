/**
 * dsh-voice-lilt — Host half (entry: host.mjs / 0.96.0)
 *
 * G0（0.96.0）：`speak` 多了一次性风格参数（`emotion / speed / vol / pitch / voiceModify`）——
 *                只作用于这一次合成，不写盘、不要开关；底层 `resolveParams()` 早就按
 *                `overrides > style > cfg` 支持了，缺的只是 schema 与透传。
 * G1（0.96.0）：生成页的后端——`generated/index.json` + `GET /gen/<name>.wav` + `POST /gen`，
 *                重名 `-1/-2`、路径限制在配置目录内、**只出 wav**（`lib/generated.mjs`）。
 * B3（1.0.0）：**VOICE CHANGER**。`POST /voice-breeze/convert` 三个入口（生成列表里的文件名 /
 * 工具给的本机路径 / 浏览器直接上传 wav 字节）最后都归到「宿主手里有一个 WAV Buffer」→
 * `tts.convert()`（`lib/tts.mjs`，multipart 打 `/v1/audio/convert`，裸 PCM 用 `pcmToWav()` 包成 WAV）
 * → 落盘/试听/入列表，`genMode:'changer'`。**只收 wav**（mp3 等以后再说）。变声期间 `/state.converting`
 * 为真，面板据此标"忙"。抽卡/落盘的全部老规矩照旧（默认只试听，`save:true` 才写盘）。
 *
 * B2（0.99.0）：**采样参数 + seed 抽卡**。`temperature / top_k / top_p / repetition_penalty /
 * max_new_tokens / split_chars` 由 `lib/tts.mjs` 的纯函数 `pickSampling()` 白名单+夹值（0/空 = 没给，
 * 因为引擎的约定就是"0 用模型默认"），进 `cacheKey` 保证改参数不会听到旧缓存（坑 31）；
 * `seeds:[…]`（2~4 个）一次抽 N 粒候选、**逐落盘不自动播**，面板列表里点哪条播哪条 ——
 * 这就是 BreezeTTS 设计模式的"抽卡"玩法。抽卡必须落盘（不落盘就没有可挑的东西）。
 *
 * B1（0.98.0）：**生成模式显式化**。BreezeTTS 的 `/v1/audio/speech` 一个端点就能表达三种模式
 * （design / clone / direction），`runGenerate()` 原来靠"有没有音色"隐式决定，而且空音色会被
 * `voiceForSession()` 兜成会话音色 —— 于是**设计模式在生成页根本不可达**。
 * 现在 `mode` 是一等参数，解析逻辑是 `lib/tts.mjs` 的纯函数 `resolveGenMode()`（可单测）；
 * 不传 `mode` = `auto` = 0.97.0 的老行为，既有调用方不受影响。面板按 `/engine.caps.modes`
 * 渲染切换器，**不按域名猜**。契约在 `03` §2.9.8。
 *
 * G2/G3（0.97.0）：面板第 5 个页签「生成」+ 工具 `tts_generate`。两者共用一条 `runGenerate()`：
 *                合成 → （要落盘才）洗名字写盘 + 记账 → 入账目表播放；`/engine` 快照补 `caps`，
 *                面板按 `engineCaps()` 现渲染可调项（**与引擎页同源，不按域名猜**）。
 *
 * 给模型一个 speak(text) 工具：模型自己决定要念哪一句，
 * Host 侧调用本机 BreezeTTS2（OpenAI 兼容 /v1/audio/speech）合成 WAV，
 * 通过同源路由交给浏览器，由 Client 半自动播放。
 * （0.63.0）：设计音色试听——`speak` 的 `segments[]` 支持 `seed`，且 `voice:""` 即设计模式（按 tone 现造嗓子），
 *                 一次可听多个候选；同一个 tool 调用里还能逐段指定 `voice`（显式给了就盖过 cast）。
 * （0.62.0）：全文模式「念一遍、不多不少」落到实处——这一档的 `speak` 直接被忽略（返回 `skipped`），
 *                 `scheduleSpeech` 的 `spoke` 闸门对全文放行，正文一律由插件从头念一遍。
 * （0.61.0）：新增播报音量 `volume`（0~1，只作用于浏览器 <audio>，不改合成结果），面板里常驻一个滑块。
 * （0.57.0）：模式四档改为 摘要(auto) / AI 说 / 全文(full) / 角色扮演；删掉旧的「摘要」档；照本念改称「全文念」。
 * （0.60.0）：默认模式改成「AI 说」；模式在界面上改成下拉（AI 说 / 摘要 / 全文 / 角色扮演）。
 * （0.59.0）：摘要档隐藏强度、首句上限固定 240 字（裁决）。
 * （0.58.0）：全文模式修订——段首普通冒号句不再被当说话人剥掉；代码块/表格改念一句提示语；行内代码保留文字。
 *
 * 设计约束（见开发记录）：
 *  - 浏览器不能直连 127.0.0.1:8080（对方默认无 CORS），所以音频一律由 Host 中转；
 *  - BreezeTTS 同一时间只处理一个请求（并发 409），所以这里做串行队列 + 重试；
 *  - 音频绝不进 tool result（会撑爆上下文），只回小 JSON；
 *  - 播放端按 seq 增量拉取，刷新页面不会重播历史。
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, appendFile, stat, rename, rm, readdir, unlink, utimes } from 'node:fs/promises';
import { readFileSync, writeFileSync, readdirSync, createWriteStream, existsSync, statfsSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { join, dirname, basename, isAbsolute, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { homedir } from 'node:os';
import { cleanForSpeech, capText, createTts, ENGINE_KINDS, normalizeWav, pickCallStyle, resolveGenMode, GEN_MODES, mergeSegmentsDown, splitForChunking, voiceCatalogue, pickEngineVoice } from './lib/tts.mjs';
import { firstSpeakableSentence, buildSummaryLine } from './lib/tts.mjs';
// G1（0.96.0）：生成页的落盘层。命名/去重/路径限制/原子记账都在这里，
// 宿主只负责"合成 → 交给它"，自测脚本也能直接跑同一套。
import { saveGeneratedWav, sanitizeGenName, withinDir, readGeneratedIndex, writeGeneratedIndex, reorderEntries, planTrashPrune, trashEntryTimeMs, TRASH_DEFAULT_MAX_BYTES, GEN_EXT } from './lib/generated.mjs';

/**
 * 安装引导的锁定清单（，M1）。
 * 程序锁定 v0.1.3；权重按显存推荐，数字来自官方 docs/models.md。
 * 说明：`sha256` 留空时只记录不校验——等真实下载一次、把哈希填进来再启用强校验。
 */
const TTS_LOCK = {
  version: 'v0.1.3',
  asset: 'breeze-tts-2-v0.1.3-windows-x64-vulkan.zip',
  programUrl: 'https://github.com/HoppouAI/Breeze-TTS-2.cpp/releases/download/v0.1.3/breeze-tts-2-v0.1.3-windows-x64-vulkan.zip',
  programSha256: '',
  weightsBase: 'https://huggingface.co/HoppouAI/Breeze-TTS-2.cpp/resolve/main/',
};
const TTS_TIERS = {
  f16: { label: 'F16 原版', file: 'breeze-tts-2-f16.gguf', sizeGb: 5.9, vramGb: 7, note: '质量最高、未压缩；显存要 8 GB 以上' },
  q8_0: { label: 'Q8_0', file: 'breeze-tts-2-q8_0.gguf', sizeGb: 3.3, vramGb: 4, note: '几乎听不出与原版的差别，6~8 GB 显存的首选' },
  q6_k: { label: 'Q6_K', file: 'breeze-tts-2-q6_k.gguf', sizeGb: 2.9, vramGb: 3.5, note: '很接近 Q8_0，4~6 GB 显存' },
  q4_k: { label: 'Q4_K', file: 'breeze-tts-2-q4_k.gguf', sizeGb: 2.4, vramGb: 3, note: '明显压缩，长句可能发闷；4 GB 左右或核显用' },
};

const TAG = '[voice-breeze]';
const ROUTE_PREFIX = '/voice-breeze/';

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:8080',
  voice: '',
  // 设计模式（voice 为空）用的**音色描述**
  instructions: '一位声音自然的年轻女性，语速适中，像在跟熟人说话。',
  // 指挥模式（有 voice）用的**语气指令** 只写情绪/语速/性格，不重复音色，否则会和克隆音色打架
  toneInstructions: '语气自然、口语化，句尾略收，不夸张。',
  cfgScale: null, // null = 自动：有 voice 用 2.5，设计模式用 4
  seed: 42,
  strength: 'medium',
  maxChars: 240, // 绝对安全阀；实际长度由 strength 决定（取二者较小值）
  multiVoice: false, // 多音色扮演（= 角色扮演 + 照本念 + 当前场景的音色表）
  narrationMode: 'script', // 角色扮演时的朗读方式：script=照本念（不调模型）/ adapted=AI 复述
  segmentGapMs: 500, // 多段播报之间的换气停顿（用户实测 400 ms 太赶）
  sessions: {}, // 每个会话各自记一份音色：{[sessionId]: {voice}}
  bufferSeconds: 2, // 流式播放前先攒够多少秒音频（用户机器上 2 s 最舒服）
  timeoutMs: 120000,
  cacheMaxMb: 512, // 64 MB 一满就淘汰，历史回播几乎存不下；512 MB ≈ 8 小时语音
  // 1.0.9：生成的音频被**删掉**时先进 gen-trash（后悔药），这里管它最多占多大。
  // 超了就从"最先进桶的"开始删；0 = 不设上限（只留手动清空）。拍 128 MB。
  trashMaxBytes: TRASH_DEFAULT_MAX_BYTES,
  // T5：长播报**切片**的片长（字）。0 = 不切（整段合成完再播）。
  // 切 40~70 字一片：B 片合成时 A 片已经在播，引擎串行的"整段等完"就没了（`10` §12 T5）。
  // 代价：跨片韵律会被打断（每片重新起头）。
  //
  // 1.2.5用户改主意：**默认关掉（0）** —— 切片牺牲跨句连贯，不该替用户默认决定；
  // 面板那句提示写「推荐 90」（够抗卡顿、又不至于一句一顿）。想开就填 90。
  chunkChars: 0,
  autoStartServer: true,
  startScript: '', // 首次安装由安装引导（tts_install）写入，不在代码里写死路径
  installDir: '', // 用户选定的安装目录（空 = 还没装；安装引导会写这里）
  installWeights: '', // 权重文件名（如 breeze-tts-2-q8_0.gguf）
  speakOnQuestion: true, // DSH 弹选项让你选时，先念一句提醒
  speakOnApproval: true, // 权限审批弹窗时，先念一句提醒
  // 播报音量 0~1。只作用于浏览器这一侧的 <audio>.volume——
  // 合成、缓存、账目都不受影响（0 = 听着静音，不是关掉播报；关播报用 enabled）。
  volume: 1,
  // 出厂音色预设名（'girl' / 'boy'）；空串 = 用户自己选的音色或没定过。
  // 定了之后 `voice` 会指向同名的库内音色，界面下拉里就是它。
  voicePreset: '',
  //  操作面板
  // false = 选项留在输入框下方（默认，行为与  完全一致）
  // true  = 除「语音播报 开/关」以外的选项全部搬进浮层面板
  controlsInPanel: false,
  panel: { x: 0, y: 0 }, // 浮层面板上次拖到的位置；0,0 = 还没拖过，客户端用默认位置
  mirrorBase: '', // 可选镜像前缀，下载失败时按它重试
  startWaitMs: 90000,
  enabled: true,
  // 新装插件的默认模式 = 「AI 说」。
  // 注意：state.json 里已有 fallback 的旧安装不受影响——盘上的值覆盖代码默认值。
  fallback: 'authored',
  maxPending: 80,
  fixedText: '这轮跑完了，细节在正文。',
  // 全文念（script）下，**没有标记的叙述行也当旁白念**。默认开——模型偶尔忘写 `旁白：` 时，
  // 用户听到的是「旁白还在」而不是「旁白凭空消失」；状态栏/表格/代码这类有明显特征的照样跳过。
  lenientScript: true,
  // 角色扮演每回合末尾给 4 个选项（回复数字继续）。只影响提示词，不改变播放行为。
  turnChoices: true,
  // （A2）：引擎（本机 BreezeTTS2 / 任意 OpenAI 兼容云端）。
  // `active='breeze'` 时行为与 0.76.0 完全一致；`providers` 里放用户自己加的云端记录。
  // **key 不写在这里** 先落 `~/.dsh/voice-breeze/keys/<id>.txt`，A3 再迁进 DSH 凭据库。
  engine: { active: 'breeze', fallbackEngine: '', providers: [] },
  // 酒馆角色卡里的 {{user}} / {{char}} 换成什么名字。{{user}} 是「用户」自己，
  // 所以默认写「用户」（写「你」会和系统提示词里的「你 = 模型」打架）；卡里若有固定称呼
  // （例如「主人」），把 userName 改成它就行。charName 留空 = 自动取 cast.json 里第一个角色。
  userName: '用户',
  charName: '',
  // G1（0.96.0）：生成页的输出目录。空串 = 用 `<dataDir>/generated`。
  // 用户填了别处就全部读写都在那个目录里（拒绝 `..` 与绝对路径逃逸，`lib/generated.mjs`）。
  generated: { dir: '' },
};

function dataDir() {
  return join(homedir(), '.dsh', 'voice-breeze');
}

/**
 * 播报模式白名单。语义：模型这轮自己说了就永远优先用它；
 * 模式只决定「模型没说时说什么」，每档都必须能出声。
 * 旧的 'off' 迁移成 'auto'（真正的静音交给总开关 enabled）。
 * 'firstSentence' 并入 'summary'（两档只差一句「本轮 N 步」，不值得占两个入口）。
 */
// 四档改为 摘要(auto) / AI 说(authored) / 全文(full) / 角色扮演(roleplay)。
// 旧的 'summary'（永远「本轮 N 步」那档）删除，存量值迁移到 'auto'；'full' 是新增的逐字通读档。
const FALLBACKS = new Set(['authored', 'auto', 'full', 'roleplay']);

/** q4：用户明确要求「念完整正文」时的一次性预算，不受强度档限制。 */
const FULL_READ_BUDGET = {
  label: '全文',
  maxTokens: 4096,
  target: '分段念完全部正文，每段 100~240 字',
  cap: 12000,
  hint: '按原文顺序念完，不省略、不总结、不挑重点；代码块换成「这段代码在正文里」这类句子。',
  strength: 'full',
};
const FULL_READ_MAX_SEGMENTS = 24;
/** 全文模式碰到念不出来的块时，用一句提示语代替 */
const CODE_CUE = '整段代码在正文中。';
const TABLE_CUE = '详细表格在正文中。';
const FULL_READ_MAX_INPUT = 12000;

/**
 * 播报强度：一个旋钮同时管「念多长」和「想多细」，避免长/短两个维度的规则互相打架。
 * - maxChars 是这一档的**目标字数**；配置里的 `maxChars` 是绝对安全阀（取二者较小值）。
 * - 240 字 ≈ 40~50 秒音频：BreezeTTS 单段上限 60 秒（750 帧 ÷ 12.5 fps），
 *   手册里的 600 是「自动切分阈值」而不是「该念多长」，超过 240 就会被切成两段播报。
 */
const STRENGTHS = {
  weak: {
    label: '弱',
    maxChars: 60,
    maxTokens: 192,
    target: '20~40 字',
    cap: 140,
    hint: '只念一句结论或一句进度，不展开、不补原因。',
  },
  medium: {
    label: '中',
    maxChars: 120,
    maxTokens: 384,
    target: '40~120 字',
    cap: 320,
    hint: '先给结论或决定，再补一句下一步或原因。',
  },
  strong: {
    label: '强',
    maxChars: 240,
    maxTokens: 768,
    target: '120~240 字',
    cap: 700,
    hint: '先给结论，再给 2~3 个要点（为什么 / 做了什么 / 还差什么），最后一句下一步；可以两三句，但保持口语，不要念列表符号。',
  },
};

/**
 * 角色扮演模式的固定预算：不看强度档。
 * 角色对话要的是"像人、有情绪、能说完整几句"，所以预算和长度都放宽（实测 768 已饱和，1536 是余量）。
 */
/**
 * 角色扮演 + **AI 即兴**下强度重新生效，但只调"旁白能省多少"，
 * 不碰"角色台词是否完整"这条硬约束（只有弱档允许精简台词）。三档都**不限段数**。
 *  - 强：正文剧情全部演完，台词一字不差，旁白也照念（= 以前的行为）
 *  - 中：台词一字不差，旁白可精简（去重复、去纯动作描写）
 *  - 弱：旁白与台词都可精简，但关键意思 / 情绪 / 态度要留住
 */
const ROLEPLAY_STRENGTHS = {
  // 强度在这一档**真的管长度**——给出目标段数与目标字数，产出不够就在宿主侧按句补切（确定性，不改写内容）。
  // **这一版只规范、不压缩**——
  //   · 超上限先不干预（多了就多了，先看实际听感），`maxChars` 只作标准表里的数字，`limit` 只回给模型看；
  //   · **弱档不再有扩写门槛**（不给 `expandBelow`），说短了也不改写；
  //   · 段数上限由宿主**确定性合并**执行（`maxSegments`：弱 1 / 中 3 / 强不限），合并只改"谁单独成段"，不丢一个字；
  //   · **中、强不设字数上限**（`maxChars: 0` = 显式声明无上限，不是漏项）。
  strong: { target: '完整演绎，至少两段，篇幅更长', hint: '把正文里的剧情、对话、旁白按顺序全部说完，一句都不省略；再多说一点情绪与下一步，别压成一句', keepLines: true, trimNarration: false, minSegments: 2, maxSegments: 0, minChars: 640, targetChars: 700, maxChars: 0, expandBelow: 420 },
  medium: { target: '完整演绎，一到三段，正常篇幅', hint: '角色台词一句都不能少、不能改写；旁白可以精简', keepLines: true, trimNarration: true, minSegments: 1, maxSegments: 3, minChars: 320, targetChars: 420, maxChars: 0, expandBelow: 252 },
  weak: { target: '一句结论 + 半句补充，明显更短', hint: '旁白和台词都可以精简，但关键意思、情绪、态度要留住', keepLines: false, trimNarration: true, minSegments: 1, maxSegments: 1, minChars: 80, targetChars: 120, maxChars: 160 },
};

const ROLEPLAY_BUDGET = {
  maxTokens: 2048, // 现在正常路径**不传** maxTokens（交给 provider 默认），这个值只在需要兜底时用
  target: '完整复述正文，每段 40~240 字，段数不限',
  hint: '把这一轮该说的完整说出来：剧情、对话、结论都别省；状态栏、进度、好感度、表格、代码、路径这类只给眼睛看的东西不念。',
  cap: 12000,
  maxChars: 300,
};

/** Host 侧只碰这三个稳定面；缺任何一个就整个插件不激活，而不是抛错。 */
export const inject = ['tools', 'webServer', 'systemPrompt'];

/**
 * 工具返回值必须是 lossless JSON：对象里带 `undefined` 会被宿主判成
 * `invalid output: value is not lossless JSON`（这个 P0，报错但音频已经播了）。
 * 统一在返回前过一遍，只留有定义、可序列化的键。
 */
function stripUndefined(value) {
  const out = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (item === undefined || item === null) continue;
    if (typeof item === 'number' && !Number.isFinite(item)) continue;
    out[key] = item;
  }
  return out;
}

/**
 * （P0）：角色卡 / 设定里的酒馆变量（`{{user}}`、`{{char}}`）**不能**原样进入
 * DSH 的系统提示词。宿主把 `{{名字}}` 当提示词变量做**严格插值** 没注册就直接抛
 * `unknown prompt variable "{{user}}" in section "voice-breeze"; registered variables: provider, model`，
 * 而且是在装配阶段抛的——插件自己的 try/catch 拦不到，整轮模型调用 step 一个都没跑就"本轮运行失败"。
 * 网上随手下的 chara_card_v2 几乎都带这两个占位符，所以这里是硬坑。
 *
 * 两道防线：
 *  ① 段声明 `interpolate: false`（见 systemPrompt.section 的注册处）——宿主不再扫这段文本；
 *  ② 这里把占位符换成中文实词，剩下的 `{{…}}` 一律拆开，避免以后有人改回插值又炸。
 * @param {string} text 原始设定文本
 * @param {{userName?: string, charName?: string}} names 替换用的名字
 * @returns {string} 可以安全进系统提示词的文本
 */
export function resolveCardLiterals(text, names = {}) {
  const source = String(text == null ? '' : text);
  if (!source.includes('{{')) return source;
  const userName = String(names.userName || '').trim() || '用户';
  const charName = String(names.charName || '').trim() || '角色';
  return source
    .replace(/\{\{\s*char\s*\}\}/gi, charName)
    .replace(/\{\{\s*user\s*\}\}/gi, userName)
    // 其余变量（{{time}} / {{random}} / 自定义人格名……）没有语义可换，拆成 { {…} } 当普通文字
    .replace(/\{\{/g, '{ {')
    .replace(/\}\}/g, '} }');
}

/** 文档规定的第一种导出形态：具名 apply + 具名 inject。 */
export function apply(ctx, config = {}) {
    const cfg = { ...DEFAULTS, ...(config || {}) };
    const cacheDir = join(dataDir(), 'cache');
    const statePath = join(dataDir(), 'state.json');
    /* ───────── （A2）：引擎 = 本机 BreezeTTS2 或任意 OpenAI 兼容云端 ───────── */

    /**
     * 云端 provider 的 key 落点（凭据库不可用时的兜底）。
     *
     * 文件名也走同一套 slug——`id` 来自用户输入，
     * 含 `/` 或 `..` 时直接拼进路径能逃出 `keys/` 目录。旧文件名仍在读时兜一次。
     */
    function keyFileFor(id) {
      return join(dataDir(), 'keys', `${credIdFor(id)}.txt`);
    }

    /** 旧版文件名（`keys/<原始 id>.txt`）。**只用于读兼容**，新写入一律走 `keyFileFor`。 */
    function legacyKeyFileFor(id) {
      const base = String(id ?? '').replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '_');
      return join(dataDir(), 'keys', `${base || 'default'}.txt`);
    }

    /* ───────── （A3）：key 进 DSH 凭据库 + 音色清单/指北 ───────── */

    /**
     * 凭据库的键空间是**严格**的 `<scope>/<id>`：正好两段，每段
     * `^[a-z][a-z0-9-]*$`（`@deepseek-ai/dsh-credentials` 的 `parseCredentialKey`）。
     * scope 用本插件注册名 `voice-breeze`；id 由 provider id 规范化成 `engine-<slug>`。
     *
     *  一开始写成 `voice-breeze/engine/<id>`（三段），`modifyRecord()` 不校验键名，
     * 落盘成功；下次启动 `parseRecords()` 读到这个键直接抛 TypeError，整个
     * `credentials-local` 服务激活失败，所有依赖它的插件全部卡住，DSH 起不来。
     * 所以这里**不能**把用户可编辑的 provider id 原样拼进键：必须 slug 化，并在
     * 拼接后再验一遍；不合法就返回 null，退回 `keys/<id>.txt`，绝不写坏键。
     */
    const CRED_SCOPE = 'voice-breeze';
    /** 与 dsh-credentials 的 KEY_SEGMENT_PATTERN 同规则：两段，各段小写字母开头。 */
    const CRED_KEY_PATTERN = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

    /** provider id → 合法且稳定的 id 段。改过名的 id 带 6 位哈希，避免 a.b / a-b 撞键。 */
    function credIdFor(id) {
      const raw = String(id ?? '').trim().toLowerCase();
      let slug = raw.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      if (!slug) slug = 'default';
      if (!/^[a-z]/.test(slug)) slug = `p-${slug}`;
      if (slug !== raw) slug = `${slug}-${createHash('sha1').update(raw).digest('hex').slice(0, 6)}`;
      return `engine-${slug}`;
    }

    /** 合法键；不合法返回 null（调用方必须处理 null）。 */    function credKeyFor(id) {
      const key = `${CRED_SCOPE}/${credIdFor(id)}`;
      if (!CRED_KEY_PATTERN.test(key)) {
        note('engine:key-invalid', `${id} → ${key} 不是 <scope>/<id>，改用 keys/${id}.txt`);
        return null;
      }
      return key;
    }

    /**
     * 凭据键自检。事故 `logs/132` 的教训 —— 凭据库**写入时不校验键名**，
     * 一个坏键要等到下次启动才炸，而且会把整个 DSH 起不来。
     * 所以每次启动都跑一遍：拿一批最脏的 provider id 走 `credKeyFor()`，全部必须合法。
     */
    function credentialKeySelfTest() {
      const probes = ['sf', 'SF', 'my.engine', 'a_b', '../evil', '', '1abc', '  sf  '];
      const bad = [];
      for (const id of probes) {
        const key = credKeyFor(id);
        if (!key || !CRED_KEY_PATTERN.test(key)) bad.push(`${JSON.stringify(id)}→${key}`);
      }
      note('engine:cred-selftest', bad.length ? `FAIL ${bad.join(' ')}` : `ok ${probes.length} 个 id 全部合法`);
    }

    /** `credentials` 是**可选**服务：拿不到就返回 null，绝不让一次 get 把整条播报链拖垮。 */
    function credentialsService() {
      try {
        return (typeof ctx.get === 'function' ? ctx.get('credentials') : null) || null;
      } catch {
        return null;
      }
    }

    /** 读 key：凭据库优先，其次旧的 `keys/<id>.txt`（老安装迁移用）。 */
    async function readEngineKey(id) {
      const creds = credentialsService();
      const credKey = credKeyFor(id);
      if (creds && credKey) {
        try {
          const record = await creds.readRecord(credKey);
          if (record && record.kind === 'api-key' && typeof record.key === 'string' && record.key.trim()) {
            return record.key.trim();
          }
        } catch (error) {
          note('engine:key-read-fail', `${id} ${(error && error.message) || error}`);
        }
      }
      // 文件兜底：新文件名优先，读不到再试旧版（`<原始 id>.txt`）——老安装不用手动搬文件
      for (const file of [keyFileFor(id), legacyKeyFileFor(id)]) {
        try {
          const value = String(await readFile(file, 'utf8')).trim();
          if (value) return value;
        } catch { /* 换下一个 */ }
      }
      return '';
    }

    /**
     * 写 key：进凭据库，**不写 `state.json`**；
     * 凭据库不可用才落到 `keys/<id>.txt`，并在日志里留痕。写成功后删掉旧的明文文件。
     */
    async function writeEngineKey(id, value) {
      const key = String(value || '').trim();
      if (!key) return false;
      const creds = credentialsService();
      const credKey = credKeyFor(id);
      if (creds && credKey) {
        try {
          await creds.modifyRecord(credKey, async () => ({ kind: 'api-key', key }));
          await rm(keyFileFor(id), { force: true }).catch(() => {});
          return true;
        } catch (error) {
          note('engine:key-write-fail', `${id} ${(error && error.message) || error}`);
        }
      }
      try {
        await mkdir(join(dataDir(), 'keys'), { recursive: true });
        await writeFile(keyFileFor(id), key, 'utf8');
        note('engine:key-file', `${id} 凭据库不可用，暂存 keys/${id}.txt`);
        return true;
      } catch (error) {
        note('engine:key-write-fail', `${id} ${(error && error.message) || error}`);
        return false;
      }
    }

    async function deleteEngineKey(id) {
      const creds = credentialsService();
      const credKey = credKeyFor(id);
      if (creds && credKey) await creds.deleteRecord(credKey).catch(() => {});
      await rm(keyFileFor(id), { force: true }).catch(() => {});
    }

    async function engineKeyPresent(id) {
      if (await readEngineKey(id)) return true;
      return existsSync(keyFileFor(id));
    }

    /**
     * 厂商识别 + 音色指北（`15` §4.9）。认不出就走通用兜底；
     * 文案必须回答三件事：**现在用谁 / 为什么藏了音色 / 想换音色怎么办**。
     */
    const VENDOR_NOTES = {
      openai: {
        vendor: 'openai',
        presets: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse'],
        how: 'OpenAI 官方没有「列出音色」的接口，可用名就是上面这一串；在音色框里改成其中一个，点试听确认即可。',
      },
      siliconflow: {
        vendor: 'siliconflow',
        // 官方文档 §2.1 的 8 个系统预置音色（男 alex/benjamin/charles/david，女 anna/bella/claire/diana）。
        // 它家的 `voice` 要带模型前缀，形如 `FunAudioLLM/CosyVoice2-0.5B:alex`，前缀在 voiceProfile() 里拼。
        presets: ['alex', 'benjamin', 'charles', 'david', 'anna', 'bella', 'claire', 'diana'],
        voicePrefix: true,
        how: '硅基流动的 voice 要写成「模型名:音色名」，例如 FunAudioLLM/CosyVoice2-0.5B:alex；官方有 8 个系统音色，也能用 /v1/uploads/audio/voice 上传参考音频建自己的音色，拿到的 uri 直接当 voice 填。',
      },
      groq: { vendor: 'groq', presets: [], how: 'Groq 的音色随所选 TTS 模型而定，换 model 或 voice 后点试听确认。' },
      minimax: {
        vendor: 'minimax',
        // 官方文档给的系统音色示例（`voice_setting.voice_id`）；完整清单走 Get Voice 接口或控制台。
        presets: [
          'Chinese (Mandarin)_Lyrical_Voice',
          'Chinese (Mandarin)_HK_Flight_Attendant',
          'English_Graceful_Lady',
          'English_radiant_girl',
        ],
        how: 'MiniMax 的音色叫 voice_id，必须填（不填直接 400）。先用上面这几个系统音色试，完整清单在控制台或 Get Voice 接口里；自己克隆的音色也会给一个 voice_id，填进来即可。',
      },
      elevenlabs: { vendor: 'elevenlabs', presets: [], how: 'ElevenLabs 有 `GET /voices`，专用适配会直接列出来（A4）；眼下先把 voice_id 手填进来。' },
      volc: { vendor: 'volc', presets: [], how: '火山/豆包的音色是 `voice_type` 且要 appid/cluster，不是纯 OpenAI 兼容端点，需专用适配（A4）。' },
      generic: {
        vendor: 'generic',
        presets: [],
        how: '去该服务商的文档找 `voice` 参数的可选值填进来，点试听验证（能出声就是对的）；若它支持上传参考音频做音色克隆，先在那边建好音色再填名字/ID；有些引擎自带默认音色，留空也能出声。',
      },
    };

    /**
     * （A4b）：**识别厂商专用的 kind**。
     *
     * 起因：面板表单原先写死 `kind:'openai-compat'`，于是 MiniMax 被存成兼容端点，
     * 请求打到 `/v1/audio/speech` 拿 404。
     * 现在两层兜：客户端按域名猜 + 宿主在这里再纠正一次（老数据、手改 state.json 都能自愈）。
     */
    function coerceKind(kind, baseUrl) {
      const wanted = ENGINE_KINDS.includes(kind) && kind !== 'breeze' ? kind : '';
      if (wanted === 'minimax') return 'minimax';
      let host = '';
      try {
        host = new URL(String(baseUrl || '')).hostname.toLowerCase();
      } catch { /* 地址不合法就只看 kind */ }
      if (host.includes('minimax') || host.includes('minimaxi')) return 'minimax';
      return wanted || 'openai-compat';
    }

    /**
     * P2：把面板/不信任来源递来的 `style` 洗成能用的一小块。
     *
     * 只留白名单字段、数值夹到合法区间、空字段直接不写 —— 因为这一段会被原样交给
     * `lib/tts.mjs` 塞进请求体，脏值最容易的表现是"整条合成 400"或"音色被悄悄改掉"。
     * **这里不做"这家支不支持"的判断** 那是 `engineCaps()` / `sanitizeForEngine()` 的活。
     */
    function coerceStyle(raw) {
      // G0（0.96.0）：白名单/夹值这件事收进 `lib/tts.mjs` 的 `pickCallStyle()` ——
      // 面板上的全局风格与 `speak` 的一次性参数必须用同一套规则，否则"同样是 speed"两处会夹到不同的区间。
      const src = raw && typeof raw === 'object' ? raw : {};
      const out = pickCallStyle(src);
      // （P4a）：多音色混音。官方限制「最多 4 个、权重 1~100」——这里就按这个洗。
      // 少于 2 条不写（一条不叫混音，留空让 voice_id 走正常路径）。
      if (Array.isArray(src.timbreWeights)) {
        const mixes = src.timbreWeights
          .map((one) => ({
            voice_id: String(one && one.voice_id ? one.voice_id : '').trim(),
            weight: Math.min(100, Math.max(1, Math.round(Number(one && one.weight) || 0))),
          }))
          .filter((one) => one.voice_id && one.weight > 0)
          .slice(0, 4);
        if (mixes.length >= 2) out.timbreWeights = mixes;
      }
      // P4a：两个可选项也走白名单（不洗的话面板传过来会被静默丢掉）
      if (src.outputMode === 'url') out.outputMode = 'url';
      if (src.subtitles === true) out.subtitles = true;
      return out;
    }

    function vendorOf(baseUrl) {
      let host = '';
      try {
        host = new URL(String(baseUrl || '')).hostname.toLowerCase();
      } catch {
        return VENDOR_NOTES.generic;
      }
      if (host === 'api.openai.com') return VENDOR_NOTES.openai;
      if (host.includes('siliconflow')) return VENDOR_NOTES.siliconflow;
      if (host.includes('groq')) return VENDOR_NOTES.groq;
      if (host.includes('minimax') || host.includes('minimaxi')) return VENDOR_NOTES.minimax;
      if (host.includes('elevenlabs')) return VENDOR_NOTES.elevenlabs;
      if (host.includes('bytedance') || host.includes('volces')) return VENDOR_NOTES.volc;
      return VENDOR_NOTES.generic;
    }

    /** 一个 provider 的音色现状：能不能列清单 / 清单是什么 / 该怎么跟用户说。 */
    function voiceProfile(provider) {
      const info = vendorOf(provider.baseUrl);
      const model = String(provider.model || 'tts-1').trim();
      // 有的家（硅基流动）voice 必须带模型前缀，这里统一拼好，用户看到的就是能直接用的名字
      const presets = (Array.isArray(info.presets) ? info.presets : [])
        .map((name) => (info.voicePrefix ? `${model}:${name}` : name));
      const known = Array.isArray(provider.knownVoices) ? provider.knownVoices : [];
      // 1.2.1：把"拉取清单"存下的整份目录也并进来 —— 生成页的音色下拉读的就是 `items`。
      const catalogue = Array.isArray(provider.voiceCatalogue) ? provider.voiceCatalogue : [];
      const items = voiceCatalogue(known, catalogue, presets);
      const mode = items.length ? 'list' : 'manual';
      const label = provider.label || provider.id || '云端引擎';
      return {
        voiceMode: mode,
        vendor: info.vendor,
        presetVoices: presets,
        knownVoices: known,
        items,
        guidance: mode === 'list'
          ? ''
          : `当前用的是「${label}」（${info.vendor}）。这个端点没有提供音色清单，所以音色选项被隐藏了。想换音色：${info.how}`,
      };
    }

    /** 当前引擎的音色现状（`breeze` 的音色来自它自己的声音库，永远算"能列"）。 */
    function activeVoiceProfile() {
      const rec = tts ? tts.engine : activeRecord();
      if (rec.kind === 'breeze') return { voiceMode: 'list', vendor: 'breeze', presetVoices: [], knownVoices: [], items: [], guidance: '' };
      const found = engineConfig().providers.find((one) => one && String(one.id) === rec.id) || {};
      return voiceProfile({ ...found, id: rec.id, baseUrl: rec.baseUrl, label: rec.label });
    }

    /**
     * 1.2.1：**把"拉取清单"的结果记进 provider**。
     *
     * 以前「拉取清单」只 `setVoiceList()` 到引擎页的局部 state —— 于是生成页永远看不到（它读 `/engine.items`）。
     * 现在整份目录存 `voiceCatalogue`（最多 400 条：MiniMax 官方库 300+），
     * 与 `knownVoices`（用过的那 24 个）分开存：后者会被 `rememberVoice()` 的"只留最近 24"反复截断，
     * 混在一起会让刚拉到的目录被下一句合成洗掉。
     */
    async function rememberVoiceCatalogue(engineId, ids) {
      const list = (Array.isArray(ids) ? ids : [])
        .map((one) => String(one || '').trim())
        .filter(Boolean);
      if (!list.length) return 0;
      const conf = engineConfig();
      const target = conf.providers.find((one) => one && String(one.id) === engineId);
      if (!target) return 0;
      const uniq = [...new Set(list)].slice(0, 400);
      const before = Array.isArray(target.voiceCatalogue) ? target.voiceCatalogue.length : 0;
      target.voiceCatalogue = uniq;
      cfg.engine = { ...conf, providers: conf.providers };
      await persist();
      note('engine:voice-catalogue', `id=${engineId} n=${uniq.length} was=${before}`);
      return uniq.length;
    }

    /** A3：成功合成过的音色名记进 provider 的 `knownVoices`（按 provider 分桶、去重、只留最近 24 个）。 */
    function rememberVoice(engineId, voice) {
      const name = String(voice || '').trim();
      if (!name) return;
      const conf = engineConfig();
      const target = conf.providers.find((one) => one && String(one.id) === engineId);
      if (!target) return;
      const known = Array.isArray(target.knownVoices) ? target.knownVoices : [];
      if (known.includes(name)) return;
      target.knownVoices = [...known, name].slice(-24);
      cfg.engine = { ...conf, providers: conf.providers };
      void persist();
      note('engine:voice-known', `${engineId} +${name}`);
    }

    /** 本机引擎的天然记录：字段全来自 cfg —— 等价于 0.76.0 的行为。 */
    function breezeRecord() {
      return {
        id: 'breeze',
        kind: 'breeze',
        label: '本机 BreezeTTS2',
        baseUrl: cfg.baseUrl,
        model: 'tts-1',
        audioFormat: 'wav',
        timeoutMs: Number(cfg.timeoutMs) || 120000,
      };
    }

    function engineConfig() {
      const raw = cfg.engine && typeof cfg.engine === 'object' ? cfg.engine : {};
      return {
        active: String(raw.active || 'breeze'),
        fallbackEngine: String(raw.fallbackEngine || ''),
        providers: Array.isArray(raw.providers) ? raw.providers : [],
      };
    }

    /** 把一条 provider 记录变成 `createTts` 认得的形状（补 key 解析器）。 */
    function recordFor(provider) {
      const id = String(provider.id);
      return {
        ...provider,
        id,
        kind: ENGINE_KINDS.includes(provider.kind) && provider.kind !== 'breeze' ? provider.kind : 'openai-compat',
        timeoutMs: Number(provider.timeoutMs) || Number(cfg.timeoutMs) || 120000,
        // key 每次用时现读（凭据库优先）—— 换了 key 不用重启、也不用重建适配器。
        apiKeyResolver: () => readEngineKey(id),
        apiKeyFile: '',
      };
    }

    /** 当前生效的记录。找不到就回本机，并留一条日志（不静默换引擎）。 */
    function activeRecord() {
      const conf = engineConfig();
      if (conf.active === 'breeze') return breezeRecord();
      const found = conf.providers.find((one) => one && String(one.id) === conf.active);
      if (!found) {
        note('engine:missing', `${conf.active} 不在 providers 里，先按本机引擎播`);
        return breezeRecord();
      }
      return recordFor(found);
    }

    function recordById(id) {
      if (id === 'breeze') return breezeRecord();
      const found = engineConfig().providers.find((one) => one && String(one.id) === id);
      return found ? recordFor(found) : null;
    }

    /**
     * 重建适配器。切引擎 = 换一条 provider 记录 + `createTts` 重建一次，
     * 播报链、账目、路由、客户端全都不动。
     */
    function rebuildTts() {
      const record = activeRecord();
      tts = createTts({ cfg, cacheDir, logger: ctx.logger, provider: record });
      // 这一行是"宿主真的加载了引擎记录"的硬证据（坑 1：只重启窗口/会话不一定重启宿主）。
      note('engine:init', `id=${tts.engine.id} kind=${tts.engine.kind} base=${tts.engine.baseUrl}`);
      return tts;
    }

    let localTts = null;
    /**
     * 本机引擎的固定实例。安装引导、设计音色（`tts_save_voice`）、出厂预设自举、`tts_probe`
     * 这些**BreezeTTS 专属**的活用它 —— 它们不受"当前引擎"影响（`15` §8 第 4 条）。
     */
    function breezeTts() {
      if (!localTts) localTts = createTts({ cfg, cacheDir, logger: ctx.logger, provider: breezeRecord() });
      return localTts;
    }

    /**
     * A2：把「要用的嗓子」换成**当前引擎认得**的名字。
     *
     * 本机音色名（`你的音色id` 之类）在云端根本不存在 —— 原样发过去轻则 400，重则云端
     * 静默换成别的嗓子念（那比报错更难查）。规则（`15` §5 第 4 条）：
     * 当前引擎不是 breeze 时 → 用它的 `defaultVoice`；**没配就整个 voice 字段不发**
     * （先出声优先：宁可让引擎用它自己的默认嗓子，也不能因为音色对不上就不出声）。
     */
    /**
     * 1.2.3：**云端音色映射不能"一律换成默认"**。
     *
     * 以前这里是：`不是 defaultVoice 就返回 defaultVoice` —— 那是为**播报**写的（会话里记的是本机音色 id，
     * 云端没有那把嗓子，不换就 404）。但它同样作用在**生成页**上：用户从那家的清单里挑了一把男声，
     * 照样被换回默认女声 —— 表现就是"音色选得中，但不参与生成"。
     * 现在判据只有一条：**这个 id 是不是当前引擎自己的**（在它的清单里）。是就放行，不是才回退。
     * 判断本身抽到 `lib/tts.mjs` 的 `pickEngineVoice()`（纯函数，有自测）。
     */
    const voiceMapSeen = new Set();
    function voiceForEngine(voice) {
      const rec = tts.engine;
      const known = rec.kind === 'breeze' ? [] : (activeVoiceProfile().items || []);
      const sent = pickEngineVoice({
        kind: rec.kind,
        wanted: voice,
        defaultVoice: rec.defaultVoice,
        known,
      });
      // 只在**真的换掉了**的时候记一行（同一对只记一次）：这正是"我选的男声去哪了"的答案
      const wanted = String(voice || '').trim();
      if (wanted && sent !== wanted) {
        const key = `${rec.kind}:${wanted}->${sent}`;
        if (!voiceMapSeen.has(key)) {
          voiceMapSeen.add(key);
          note('voice:mapped', `kind=${rec.kind} ${wanted} → ${sent || '(不发)'}（这个 id 不在 ${rec.id} 的清单里）`);
        }
      }
      return sent;
    }

    /**
     * P1：把「当前引擎认识哪些记号」翻成人话交给模型。
     *
     * **为什么不是"切引擎就换提示词"** 系统提示词在会话内不刷新（`06` 坑 18，三次实测），
     * 换一套写死的能力表，切引擎后模型拿到的还是旧的那套 —— 它会继续对 breeze 写 `(laughs)`，
     * 而 breeze 会把"括号 laughs 括号"照字念出来。所以：
     *   提示词只写一句恒定的话「能写哪些以 `engineHints` 为准」，
     *   具体能力由这里读 `tts.caps` 现算（`lib/tts.mjs` 的 `engineCaps()` 是唯一真相）。
     */
    function engineHints() {
      const cap = (tts && tts.caps) || {};
      const hints = [];
      if (cap.pauseTag) {
        hints.push(`可以写 <#0.5#> 做停顿（${cap.pauseTag.min}~${cap.pauseTag.max} 秒，两个停顿之间必须有可念的字，不能连着写）`);
      }
      if (Array.isArray(cap.interjections) && cap.interjections.length) {
        hints.push(`可以写括号语气词，只能用这几个：${cap.interjections.join(' / ')}`);
      }
      if (Array.isArray(cap.emotions) && cap.emotions.length) {
        hints.push(`可以指定情绪：${cap.emotions.join(' / ')}`);
      }
      // G0（0.96.0）：这三项是"参数级"能力（走 `voice_setting`），与记号不同 ——
      // 只在这家认识时出现，免得模型对 breeze 传 speed 然后以为生效了。
      if (cap.voiceSetting) {
        hints.push('可以一次性改 `speed`（0.5~2，1=原速）/ `vol`（0.01~10）/ `pitch`（-12~12）：用 `speak` 的同名参数给，只影响这一次');
      }
      if (cap.voiceModify) {
        hints.push('可以一次性给 `voiceModify`（音色微调 `{pitch,intensity,timbre,soundEffects}`，例如 `lofi_telephone`）');
      }
      if (!hints.length) {
        hints.push('当前引擎不认识任何记号：不要写 <#x#> 停顿，不要写括号语气词，不要指定情绪（照字念出来会变成噪音）');
      }
      return hints;
    }

    /**
     * P3：当前引擎的**写法手册**（官方文档里"怎么喂文本它才念得好"的那部分）。
     *
     * 手册本体在 `lib/tts.mjs` 的 `playbookFor()`，按 kind + caps 生成；这里只是转发。
     * **为什么手册不进系统提示词** 理由与能力表完全相同（`06` 坑 27）——提示词会话内不刷新，
     * 切引擎后写死的那套会变成谎话。走 `tts_state` 返回，切一次引擎就换一份。
     */
    function enginePlaybookLines() {
      try {
        const lines = tts && tts.playbook;
        return Array.isArray(lines) && lines.length
          ? lines
          : ['按普通口语写：短句、标点断句、不写引擎记号'];
      } catch {
        return ['按普通口语写：短句、标点断句、不写引擎记号'];
      }
    }

    /**
     * P1：能力摘要，一行中文，给卡片看 —— 让「这台引擎支持什么」对**用户**也可见。
     * 与 `engineHints()` 同源（都读 `tts.caps`）：一个给模型，一个给人。
     */
    function engineSupportLine() {
      const cap = (tts && tts.caps) || {};
      const bits = [];
      if (cap.pauseTag) bits.push('停顿');
      if (Array.isArray(cap.interjections) && cap.interjections.length) bits.push(`语气词${cap.interjections.length}`);
      if (Array.isArray(cap.emotions) && cap.emotions.length) bits.push(`情绪${cap.emotions.length}档`);
      if (cap.voiceModify) bits.push('调音台');
      if (cap.voiceSetting) bits.push('语速音量音调');
      if (cap.timbreMix) bits.push('混音');
      if (cap.wordTimestamps) bits.push('词级字幕');
      return bits.length ? bits.join('·') : '无记号';
    }

    /**
     * 当前引擎合成失败 → 按 `engine.fallbackEngine` 回退一次（默认空 = 不回退）。
     * 回退也失败就把**原来的**错误抛出去，交给现有兜底链（`10` §6，永不静音）。
     */
    async function withEngineFallback(run) {
      const primary = tts;
      try {
        return await run(primary);
      } catch (error) {
        const conf = engineConfig();
        if (!conf.fallbackEngine || primary.engine.id === conf.fallbackEngine) throw error;
        const record = recordById(conf.fallbackEngine);
        if (!record) throw error;
        const backup = createTts({ cfg, cacheDir, logger: ctx.logger, provider: record });
        if (!(await backup.healthy().catch(() => false))) throw error;
        note('engine:fallback', `${primary.engine.id}→${backup.engine.id} ${(error && error.message) || error}`);
        const result = await run(backup);
        if (result && typeof result === 'object') result.engineFallback = true;
        return result;
      }
    }

    /** 面板/路由看的引擎快照（**不含 key**，只报 keyPresent；A3 起带音色现状与指北）。 */
    async function engineSnapshot() {
      const conf = engineConfig();
      const live = tts ? tts.engine : activeRecord();
      const providers = [];
      for (const one of conf.providers) {
        const profile = voiceProfile(one);
        providers.push({
          id: one.id,
          kind: one.kind,
          label: one.label,
          baseUrl: one.baseUrl,
          model: one.model,
          defaultVoice: one.defaultVoice || '',
          supportsInstructions: Boolean(one.supportsInstructions),
          // P2：这一家的风格（情绪 / 语速 / 音量 / 音调 / 调音台），面板据此回填
          style: one.style && typeof one.style === 'object' ? one.style : {},
          keyPresent: await engineKeyPresent(one.id),
          voiceMode: profile.voiceMode,
          vendor: profile.vendor,
          items: profile.items,
          guidance: profile.guidance,
        });
      }
      const activeProfile = tts ? activeVoiceProfile() : { voiceMode: 'list', vendor: 'breeze', items: [], guidance: '' };
      return {
        active: conf.active,
        fallbackEngine: conf.fallbackEngine,
        effective: {
          id: live.id,
          kind: live.kind,
          label: live.label,
          baseUrl: live.baseUrl,
          model: live.model,
        },
        kinds: ENGINE_KINDS,
        // （P4a）：当前引擎的写法手册 —— 面板「当前引擎」卡里摊开给用户看，
        // 与模型拿到的 `tts_state.enginePlaybook` 是同一份（同一个 `tts.playbook`）。
        playbook: enginePlaybookLines(),
        /*
         * G2：**把能力表交给面板**。生成页要"按这家认识什么现渲染控件"，
         * 而能力表的唯一真相在 `lib/tts.mjs` 的 `engineCaps()`（宿主与模型读的是同一份）。
         * 面板**不许按域名猜**（引擎页当初就是这么猜 minimax 的，域名一改就瞎）；
         * 这里把可序列化的那几项原样给出去，面板只管照着画。
         */
        caps: (() => {
          const cap = (tts && tts.caps) || {};
          return {
            kind: String(cap.kind || 'breeze'),
            pauseTag: cap.pauseTag ? { min: Number(cap.pauseTag.min), max: Number(cap.pauseTag.max) } : null,
            interjections: Array.isArray(cap.interjections) ? cap.interjections.slice(0, 40) : [],
            emotions: Array.isArray(cap.emotions) ? cap.emotions.slice(0, 20) : [],
            voiceModify: Boolean(cap.voiceModify),
            voiceSetting: Boolean(cap.voiceSetting),
            timbreMix: Boolean(cap.timbreMix),
            wordTimestamps: Boolean(cap.wordTimestamps),
            urlOutput: Boolean(cap.urlOutput),
            maxChars: Number(cap.maxChars) || 2000,
            // B1（0.98.0）：这家能打哪几种生成模式 + 有没有独立的变声入口。
            // 面板的「生成」页按它渲染模式切换器 —— 能力表的真相只在 `engineCaps()` 一份。
            /*
             * `changer` 不在 `GEN_MODES` 里（那是 `runGenerate` 的 mode 集合，变声走另一条链路），
             * 所以过滤时**要单独放它一个** —— 否则能力表把"变声"这档自己滤掉了，
             * 面板永远看不到第四个模式（B3 第一次跑自测就撞上）。
             */
            modes: Array.isArray(cap.modes)
              ? cap.modes.filter((one) => one === 'changer' || GEN_MODES.includes(one)).slice(0, 6)
              : ['clone'],
            convert: Boolean(cap.convert),
            // B2：这家认哪些采样参数（面板「高级」区照它渲染，键名与工具参数一致）
            sampling: Array.isArray(cap.sampling) ? cap.sampling.slice(0, 12) : [],
          };
        })(),
        voiceMode: activeProfile.voiceMode,
        items: activeProfile.items,
        guidance: activeProfile.guidance,
        keyBackend: credentialsService() ? 'credentials' : 'file',
        providers,
      };
    }

    let tts = null;
    rebuildTts();
    credentialKeySelfTest();

    /** @type {Map<string, {id:string,seq:number,file:string,text:string,chars:number,ms:number,session:string}>} */
    const ledger = new Map();
    let seq = 0;
    // T5：切片分组号（同一个 `pieceGroup` = 同一段的续片）。放闭包级，跨调用也不会撞号。
    let pieceGroupSeq = 0;
    const nextPieceGroup = () => { pieceGroupSeq += 1; return `${Date.now().toString(36)}-${pieceGroupSeq}`; };
    /**
     * 助手消息 id → 回合号。消息动作行上的 🔊 按钮（客户端）只拿得到 messageId，
     * 要重播就得先换算成 turn。内存表，滚动保留最近 500 条；重启后清空（跨重启历史见待办 F0b）。
     */
    const messageTurn = new Map();
    const MESSAGE_TURN_MAX = 500;
    function rememberMessageTurn(messageId, turn, session) {
      const id = String(messageId || '');
      if (!id) return;
      // 连 session 一起记。用户换过窗口/会话后，消息 id 属于旧会话，
      // 只按"当前会话"去过滤账目会一条都查不到（这就是重播按钮报"这一轮没有语音"的真因）。
      messageTurn.set(id, { turn: Number(turn) || 0, session: String(session || '') });
      scheduleHistorySave();
      if (messageTurn.size > MESSAGE_TURN_MAX) {
        const oldest = messageTurn.keys().next().value;
        if (oldest !== undefined) messageTurn.delete(oldest);
      }
    }
    let lastProblems = [];
    /** sessionId -> 本轮状态：模型有没有自己说过、最后一次正文、走了几步、回合是否已结束 */
    const turnState = new Map();

    const persist = async () => {
      try {
        await mkdir(dataDir(), { recursive: true });
        await writeFile(
          statePath,
          JSON.stringify({
            enabled: cfg.enabled,
            fallback: cfg.fallback,
            voice: cfg.voice,
            strength: cfg.strength,
            multiVoice: Boolean(cfg.multiVoice),
            narrationMode: cfg.narrationMode,
            segmentGapMs: Number(cfg.segmentGapMs) >= 0 ? Number(cfg.segmentGapMs) : 500,
            // T5：长播报切片片长（0 = 不切）。面板「选项」页那一格读它。
            chunkChars: Number(cfg.chunkChars) || 0,
            bufferSeconds: Number(cfg.bufferSeconds) >= 0 ? Number(cfg.bufferSeconds) : 2,
            toneInstructions: cfg.toneInstructions,
            installDir: cfg.installDir || '',
            installWeights: cfg.installWeights || '',
            speakOnQuestion: Boolean(cfg.speakOnQuestion),
            speakOnApproval: Boolean(cfg.speakOnApproval),
            volume: clampVolume(cfg.volume),
            voicePreset: String(cfg.voicePreset || ''),
            controlsInPanel: Boolean(cfg.controlsInPanel),
            panel: {
              x: Number.isFinite(cfg.panel && cfg.panel.x) ? Number(cfg.panel.x) : 0,
              y: Number.isFinite(cfg.panel && cfg.panel.y) ? Number(cfg.panel.y) : 0,
            },
            startScript: cfg.startScript || '',
            engine: {
              active: String((cfg.engine && cfg.engine.active) || 'breeze'),
              fallbackEngine: String((cfg.engine && cfg.engine.fallbackEngine) || ''),
              providers: Array.isArray(cfg.engine && cfg.engine.providers) ? cfg.engine.providers : [],
            },
            sessions: cfg.sessions,
          }, null, 2),
          'utf8',
        );
      } catch (error) {
        ctx.logger?.warn?.(`${TAG} 状态写入失败: ${error && error.message}`);
      }
    };

    const restore = async () => {
      try {
        const parsed = JSON.parse(await readFile(statePath, 'utf8'));
        if (typeof parsed?.enabled === 'boolean') cfg.enabled = parsed.enabled;
        if (FALLBACKS.has(parsed?.fallback)) cfg.fallback = parsed.fallback;
        else if (parsed?.fallback === 'off') cfg.fallback = 'auto';
        // 「首句」并入「摘要」；：旧的「摘要」(summary) 也并进「自动/摘要」(auto)
        else if (parsed?.fallback === 'firstSentence' || parsed?.fallback === 'summary') cfg.fallback = 'auto';
        // 音色可在界面上换：state.json 里的值覆盖配置默认值（空串 = 回到“声音设计”模式）
        if (typeof parsed?.voice === 'string') cfg.voice = parsed.voice.trim();
        // 播报强度同样可在界面上切
        if (parsed?.strength && STRENGTHS[parsed.strength]) cfg.strength = parsed.strength;
                if (typeof parsed?.toneInstructions === 'string' && parsed.toneInstructions.trim()) {
          cfg.toneInstructions = parsed.toneInstructions;
        }
        if (parsed?.narrationMode === 'script' || parsed?.narrationMode === 'adapted') cfg.narrationMode = parsed.narrationMode;
        if (typeof parsed?.multiVoice === 'boolean') cfg.multiVoice = parsed.multiVoice;
        if (typeof parsed?.installDir === 'string') cfg.installDir = parsed.installDir;
        if (typeof parsed?.speakOnQuestion === 'boolean') cfg.speakOnQuestion = parsed.speakOnQuestion;
        if (typeof parsed?.speakOnApproval === 'boolean') cfg.speakOnApproval = parsed.speakOnApproval;
        // 播报音量
        if (Number.isFinite(parsed?.volume)) cfg.volume = clampVolume(parsed.volume);
        // 出厂音色预设名
        if (typeof parsed?.voicePreset === 'string') cfg.voicePreset = parsed.voicePreset.trim();
        // 盘上如果「预设名」与「当前音色」对不上（旧版本手选音色会留下这种组合），以音色为准自愈：
        // 音色本身是预设名就认它，否则清掉预设记账——避免下次启动把用户手选的嗓子顶回去。
        if (cfg.voicePreset && cfg.voicePreset !== cfg.voice) {
          cfg.voicePreset = Object.prototype.hasOwnProperty.call(PRESET_VOICES, cfg.voice) ? cfg.voice : '';
        }
        if (typeof parsed?.controlsInPanel === 'boolean') cfg.controlsInPanel = parsed.controlsInPanel;
        if (parsed?.panel && Number.isFinite(parsed.panel.x) && Number.isFinite(parsed.panel.y)) {
          cfg.panel = { x: Number(parsed.panel.x), y: Number(parsed.panel.y) };
        }
        if (typeof parsed?.installWeights === 'string') cfg.installWeights = parsed.installWeights;
        if (typeof parsed?.startScript === 'string' && parsed.startScript.trim()) cfg.startScript = parsed.startScript.trim();
        if (Number.isFinite(parsed?.segmentGapMs)) cfg.segmentGapMs = Number(parsed.segmentGapMs);
        if (Number.isFinite(parsed?.bufferSeconds)) cfg.bufferSeconds = Number(parsed.bufferSeconds);
        if (parsed?.sessions && typeof parsed.sessions === 'object') {
          cfg.sessions = {};
          for (const [key, value] of Object.entries(parsed.sessions)) {
            if (value && typeof value.voice === 'string') cfg.sessions[key] = { voice: value.voice };
          }
        }
        // （A2）：引擎配置。坏的记录直接丢掉（宁可回本机出声，也不能因为一条脏数据整条链不响）。
        if (parsed?.engine && typeof parsed.engine === 'object') {
          const providers = Array.isArray(parsed.engine.providers)
            ? parsed.engine.providers
              .filter((one) => one && typeof one.id === 'string' && one.id.trim() && one.id !== 'breeze')
              .map((one) => ({
                id: String(one.id).trim(),
                kind: coerceKind(one.kind, one.baseUrl),
                label: String(one.label || one.id).trim(),
                baseUrl: String(one.baseUrl || '').trim(),
                model: String(one.model || 'tts-1').trim(),
                defaultVoice: String(one.defaultVoice || '').trim(),
                audioFormat: 'wav',
                supportsInstructions: Boolean(one.supportsInstructions),
                // A3：成功用过的音色（去重、最多 24 个）
                knownVoices: Array.isArray(one.knownVoices)
                  ? one.knownVoices.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim()).slice(-24)
                  : [],
              }))
            : [];
          cfg.engine = {
            active: typeof parsed.engine.active === 'string' && parsed.engine.active.trim() ? parsed.engine.active.trim() : 'breeze',
            fallbackEngine: typeof parsed.engine.fallbackEngine === 'string' ? parsed.engine.fallbackEngine.trim() : '',
            providers,
          };
          if (cfg.engine.active !== 'breeze' && !providers.some((one) => one.id === cfg.engine.active)) {
            cfg.engine.active = 'breeze';
          }
        }
      } catch { /* 首次运行没有状态文件 */ }
    };

    /**
     * （F0b）：账目与 messageId→turn 落到 `history.json`，重启 DSH 后还能重播——
     * 前提是音频缓存文件还在（缓存 LRU 会淘汰，淘汰了就只能提示"不可回放"）。
     */
    const historyPath = join(dataDir(), 'history.json');
    const MAX_HISTORY_ENTRIES = 400;
    let historyTimer = null;

    function loadHistory() {
      try {
        const raw = JSON.parse(readFileSync(historyPath, 'utf8'));
        const entries = Array.isArray(raw?.entries) ? raw.entries : [];
        let maxSeq = seq;
        for (const item of entries) {
          if (!item || !item.id) continue;
          const isPause = Number(item.pauseMs) > 0;
          if (!isPause && (!item.file || !existsSync(item.file))) continue; // 缓存已被清掉，丢弃
          ledger.set(String(item.id), {
            id: String(item.id),
            seq: Number(item.seq) || 0,
            turn: Number(item.turn) || 0,
            session: String(item.session || ''),
            file: String(item.file || ''),
            text: String(item.text || ''),
            chars: Number(item.chars) || 0,
            ms: Number(item.ms) || 0,
            cached: true,
            chunks: [],
            done: true,
            error: '',
            wake: null,
            pauseMs: isPause ? Number(item.pauseMs) : 0,
          });
          maxSeq = Math.max(maxSeq, Number(item.seq) || 0);
        }
        seq = maxSeq;
        const messages = raw && typeof raw.messages === 'object' && raw.messages ? raw.messages : {};
        for (const [key, value] of Object.entries(messages)) {
          if (value && Number.isFinite(Number(value.turn))) {
            messageTurn.set(key, { turn: Number(value.turn), session: String(value.session || '') });
          }
        }
        if (ledger.size) note('history:load', `entries=${ledger.size} messages=${messageTurn.size} seq=${seq}`);
        const repaired = repairTurnGaps();
        if (repaired) {
          note('history:repair', `turn0-entries=${repaired}（以前的兜底账目补回正确轮次）`);
          scheduleHistorySave();
        }
      } catch { /* 首次运行没有历史文件 */ }
    }

    /**
     *  一次性迁移：以前，**兜底播报**是在 turn/end 之后异步建账目的，那时 turnState 已删，
     * 于是 entry.turn = 0；`/turn` 按轮次查不到 → 消息上的 🔊 报「这一轮没有语音」。
     *
     * 规则刻意保守，只处理"能确定"的情况：
     *  - 只看同一会话；
     *  - 只看 turn=0 的**连续块**；
     *  - 块前面最近的已知轮次是 T、后面最近的已知轮次正好是 T+2，且该会话的 messageTurn 里确实有 T+1
     *    → 整块补成 T+1；
     *  - 其它一律不动（例如旧会话里最早一轮之前的块，无从推断）。
     * 修完再跑一遍是幂等的。
     */
    function repairTurnGaps() {
      let fixed = 0;
      const bySession = new Map();
      for (const entry of ledger.values()) {
        const key = entry.session || '';
        if (!bySession.has(key)) bySession.set(key, []);
        bySession.get(key).push(entry);
      }
      for (const [sessionKey, list] of bySession) {
        list.sort((a, b) => a.seq - b.seq);
        const knownTurns = new Set();
        for (const [id, value] of messageTurn) {
          if (value && value.session === sessionKey && Number(value.turn) > 0) knownTurns.add(Number(value.turn));
        }
        let i = 0;
        while (i < list.length) {
          if (Number(list[i].turn) !== 0) { i += 1; continue; }
          let end = i;
          while (end + 1 < list.length && Number(list[end + 1].turn) === 0) end += 1;
          const before = list.slice(0, i).filter((e) => Number(e.turn) > 0).map((e) => Number(e.turn));
          const after = list.slice(end + 1).filter((e) => Number(e.turn) > 0).map((e) => Number(e.turn));
          const lo = before.length ? before.sort((a, b) => a - b)[before.length - 1] : NaN;
          const hi = after.length ? after.sort((a, b) => a - b)[0] : NaN;
          let guess = NaN;
          if (Number.isFinite(lo) && Number.isFinite(hi) && hi === lo + 2 && knownTurns.has(lo + 1)) {
            guess = lo + 1;
          } else if (Number.isFinite(lo) && !Number.isFinite(hi)) {
            // 收尾块：这一轮之后还没有任何账目（最后一轮漏记）。
            // 用「该会话 messageTurn 里确实出现过、但一条账目都没有」的最小轮次来对，
            // 且必须正好是 lo+1——宁可不动，也不猜远的。
            const used = new Set(list.filter((e) => Number(e.turn) > 0).map((e) => Number(e.turn)));
            const candidates = [...knownTurns].filter((t) => t > lo && !used.has(t)).sort((a, b) => a - b);
            if (candidates.length && candidates[0] === lo + 1) guess = candidates[0];
          }
          if (Number.isFinite(guess)) {
            for (let k = i; k <= end; k += 1) {
              list[k].turn = guess;
              fixed += 1;
            }
          }
          i = end + 1;
        }
      }
      return fixed;
    }

    function scheduleHistorySave() {
      if (historyTimer) return;
      historyTimer = setTimeout(() => {
        historyTimer = null;
        void saveHistory();
      }, 800);
      if (typeof historyTimer?.unref === 'function') historyTimer.unref();
    }

    async function saveHistory() {
      try {
        const entries = [...ledger.values()]
          .filter((e) => Number(e.pauseMs) > 0 || (e.done && e.file && existsSync(e.file)))
          .sort((a, b) => a.seq - b.seq)
          .slice(-MAX_HISTORY_ENTRIES)
          .map((e) => ({
            id: e.id,
            seq: e.seq,
            turn: e.turn || 0,
            session: e.session || '',
            file: e.file || '',
            text: e.text || '',
            chars: e.chars || 0,
            ms: e.ms || 0,
            pauseMs: e.pauseMs || 0,
          }));
        const messages = {};
        for (const [key, value] of messageTurn) messages[key] = value;
        await mkdir(dataDir(), { recursive: true });
        await writeFile(historyPath, JSON.stringify({ version: 1, entries, messages }), 'utf8');
      } catch (error) {
        note('history:save-error', String((error && error.message) || error));
      }
    }

    function remember(entry) {
      ledger.set(entry.id, entry);
      /*
       * 1.2.4：**淘汰要分先后 —— 播报先留住**。
       *
       * 以前一律"踢最旧的那条"。而面板生成的音频（`kind:'gen'`）一次能进好几条，
       * 把播报条目挤出去之后，点「重播最新一轮」拿到的 id 就已经 404（表现为红字报错）。
       * 现在：先淘汰 gen，再淘汰 pause，最后才动 speech；speech 另有 600 条的硬上限兜底。
       */
      const pickVictim = () => {
        const done = [...ledger.values()].filter((item) => item.done);
        if (!done.length) return null;
        const order = { gen: 0, pause: 1, speech: 2 };
        const rank = (item) => (order[item.kind] === undefined ? 1 : order[item.kind]);
        return done.sort((a, b) => (rank(a) - rank(b)) || (a.seq - b.seq))[0];
      };
      let guard = 0;
      while (ledger.size > cfg.maxPending && guard < 200) {
        const victim = pickVictim();
        if (!victim) break;
        ledger.delete(victim.id);
        guard += 1;
      }
      // 播报条目再多也给个绝对上限（防止长会话把内存吃掉）
      const speeches = [...ledger.values()].filter((item) => item.kind === 'speech');
      if (speeches.length > 600) {
        speeches.sort((a, b) => a.seq - b.seq);
        for (const one of speeches.slice(0, speeches.length - 600)) ledger.delete(one.id);
      }
      scheduleHistorySave();
    }

    /**
     *  气口标记：正文里写 `[停顿3秒]` / `[停顿1.5秒]` / `[停顿800ms]`，
     * 宿主把它切成一条**没有音频的账目**（pauseMs），客户端按毫秒静音等待。
     * 只对用户明确要求"旁白改气口"时才需要模型写它；默认念旁白。
     */
    const PAUSE_RE = /[\[【]\s*停顿\s*(\d+(?:\.\d+)?)\s*(秒|s|ms|毫秒)?\s*[\]】]/gi;
    const PAUSE_MAX_MS = 30000;

    function splitPause(text) {
      const src = String(text || '');
      const parts = [];
      let last = 0;
      PAUSE_RE.lastIndex = 0;
      let match;
      while ((match = PAUSE_RE.exec(src)) !== null) {
        if (match.index > last) parts.push({ type: 'text', text: src.slice(last, match.index) });
        const value = Number(match[1]);
        const unit = String(match[2] || '秒').toLowerCase();
        const ms = unit === 'ms' || unit === '毫秒' ? value : value * 1000;
        parts.push({ type: 'pause', ms: Math.max(200, Math.min(PAUSE_MAX_MS, Math.round(ms))) });
        last = match.index + match[0].length;
      }
      if (last < src.length) parts.push({ type: 'text', text: src.slice(last) });
      return parts.filter((part) => (part.type === 'text' ? part.text.trim() : true));
    }

    /** 把一段"气口"塞进账目表：客户端拿到 pauseMs 就静音等待，不会去请求音频。 */
    function pushPause(ms, sessionId, turnHint) {
      seq += 1;
      const entry = {
        id: `${seq}-pause`,
        seq,
        // 气口号也可能在 turn/end 之后才入账（兜底播报），必须由调用方把轮次带下来
        turn: Number(turnHint ?? turnState.get(sessionId)?.turn ?? 0),
        file: '',
        text: '',
        chars: 0,
        ms: 0,
        cached: true,
        session: sessionId || '',
        chunks: [],
        done: true,
        error: '',
        wake: null,
        kind: 'pause',
        pauseMs: Math.max(200, Math.min(PAUSE_MAX_MS, Math.round(Number(ms) || 0))),
      };
      remember(entry);
      note('segment:pause', `ms=${entry.pauseMs}`);
      return entry;
    }

    /**
     * 端点没开时的等待队列：先排进来，后台把 BreezeTTS 拉起来，就绪后补念。
     * 这样 speak 工具不会卡住回合（冷启动要 30~60 秒），也不会丢掉这一句。
     */
    const pendingLines = [];
    let serverStarting = false;
    /**
     * **最近一次"该念却没念成"的记录**。
     * 以前这些失败只进 `events.log`，界面上永远是"已念"——用户以为模型没说话。
     * 现在由 `/state.voiceFailure` 交给界面（`{at, reason, count, sample}`），念成功一次就清空。
     */
    let lastVoiceFailure = null;
    /** 客户端时间线的限速窗口（`/client-log` 用）。 */
    let clientLogWindow = { at: 0, count: 0 };

    /** 后台拉起 BreezeTTS 并盯着探活；起来就 flush，超时就丢掉队列（记日志，不静音假象）。 */

    /* ───────────────── 安装引导（· M1） ───────────────── */

    /** 安装任务进度（单例：同一时间只允许一个安装）。 */
    const installJob = {
      state: 'idle', // idle | running | done | error
      phase: '',
      percent: 0,
      received: 0,
      total: 0,
      dir: '',
      tier: '',
      message: '',
      error: '',
      startedAt: 0,
      finishedAt: 0,
    };
    let installing = false;

    /** ready（装了且在跑）/ stopped（装了没启动）/ missing（没装）。 */
    async function installState() {
      if (await breezeTts().healthy()) return { state: 'ready', dir: cfg.installDir || '', script: cfg.startScript || '' };
      const script = String(cfg.startScript || '');
      const scriptExists = script ? existsSync(script) : false;
      return { state: scriptExists ? 'stopped' : 'missing', dir: cfg.installDir || '', script };
    }

    function runExe(file, args, timeout) {
      return new Promise((resolve) => {
        execFile(file, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
          resolve(error ? '' : String(stdout || ''));
        });
      });
    }
    const runPwsh = (script, timeout) => runExe('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], timeout || 15000);

    /** 硬件探测：显卡/显存、内存、Vulkan、CPU、各盘剩余空间。 */
    async function probeHardware() {
      const out = { gpu: [], vramGb: 0, ramGb: 0, cpu: '', vulkan: false, disks: [], notes: [] };
      const smi = await runExe('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'], 8000);
      for (const line of smi.split(/\r?\n/)) {
        const [name, mem, driver] = line.split(',').map((x) => String(x || '').trim());
        if (!name) continue;
        const gb = Math.round((Number(mem) / 1024) * 10) / 10;
        out.gpu.push({ name, vramGb: gb, driver });
        out.vramGb = Math.max(out.vramGb, gb || 0);
      }
      if (!out.gpu.length) {
        const json = await runPwsh('Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json -Compress');
        try {
          const parsed = JSON.parse(json || '[]');
          const list = Array.isArray(parsed) ? parsed : [parsed];
          for (const item of list) {
            if (!item || !item.Name) continue;
            // AdapterRAM 在 32 位字段里会溢出，只当"有没有独显"用，不当显存读数
            out.gpu.push({ name: String(item.Name), vramGb: null, driver: String(item.DriverVersion || '') });
          }
          out.notes.push('读不到精确显存（非 NVIDIA 或无驱动），显存按保守值估算');
        } catch { /* ignore */ }
      }
      const sys = await runPwsh('$c=Get-CimInstance Win32_ComputerSystem; $p=Get-CimInstance Win32_Processor; [pscustomobject]@{ram=[math]::Round($c.TotalPhysicalMemory/1GB,1); cpu=($p.Name)} | ConvertTo-Json -Compress');
      try {
        const info = JSON.parse(sys || '{}');
        out.ramGb = Number(info.ram) || 0;
        out.cpu = String(info.cpu || '').trim();
      } catch { /* ignore */ }
      out.vulkan = existsSync('C:\\Windows\\System32\\vulkan-1.dll');
      const disks = await runPwsh('Get-PSDrive -PSProvider FileSystem | Select-Object Name,Free | ConvertTo-Json -Compress');
      try {
        const parsed = JSON.parse(disks || '[]');
        for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
          if (!item || !item.Name) continue;
          out.disks.push({ drive: `${item.Name}:`, freeGb: Math.round((Number(item.Free) / 1073741824) * 10) / 10 });
        }
      } catch { /* ignore */ }
      return out;
    }

    /** 按显存给推荐档位（规则见开发记录 §4）。 */
    function recommendTiers(vramGb) {
      const v = Number(vramGb) || 0;
      if (v >= 8) return { primary: 'q8_0', alternatives: ['f16', 'q6_k'] };
      if (v >= 6) return { primary: 'q8_0', alternatives: ['q6_k'] };
      if (v >= 4) return { primary: 'q6_k', alternatives: ['q4_k'] };
      if (v > 0) return { primary: 'q4_k', alternatives: ['q6_k'] };
      return { primary: 'q4_k', alternatives: [] };
    }

    /** 安装目录校验：绝对路径、非中文、别带空格；父目录能建、空间够。 */
    function validateInstallDir(dir, tierKey) {
      const problems = [];
      const warnings = [];
      const value = String(dir || '').trim();
      if (!value) problems.push('没有给安装路径');
      else if (!isAbsolute(value)) problems.push('必须是绝对路径，例如 D:\\tts');
      else if (!/^[A-Za-z]:[\\/]/.test(value)) problems.push('必须是盘符开头的 Windows 路径');
      else {
        if (/[^\x00-\x7F]/.test(value)) problems.push('路径里有中文或其它非 ASCII 字符，.bat 容易出错，请换纯英文路径');
        if (/\s/.test(value)) warnings.push('路径里有空格，.bat 可能出错，建议换掉');
        const spec = TTS_TIERS[tierKey] || null;
        if (spec) {
          try {
            const parent = dirname(value);
            const st = statfsSync(existsSync(parent) ? parent : dirname(parent));
            const freeGb = (Number(st.bavail) * Number(st.bsize)) / 1073741824;
            const needGb = spec.sizeGb + 4;
            if (freeGb < needGb) problems.push(`目标盘只剩 ${Math.round(freeGb * 10) / 10} GB，至少要 ${Math.round(needGb * 10) / 10} GB`);
          } catch { warnings.push('读不到磁盘剩余空间，自己确认一下'); }
        }
      }
      return { ok: problems.length === 0, problems, warnings };
    }

    async function sha256Of(file) {
      const { createReadStream } = await import('node:fs');
      return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        createReadStream(file)
          .on('data', (chunk) => hash.update(chunk))
          .on('error', reject)
          .on('end', () => resolve(hash.digest('hex')));
      });
    }

    async function downloadTo(url, dest, label) {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`${label} 下载失败：HTTP ${res.status}`);
      installJob.phase = label;
      installJob.total = Number(res.headers.get('content-length') || 0);
      installJob.received = 0;
      installJob.percent = 0;
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          installJob.received += chunk.length;
          if (installJob.total) installJob.percent = Math.min(99, Math.round((installJob.received / installJob.total) * 100));
          cb(null, chunk);
        },
      });
      await mkdir(dirname(dest), { recursive: true });
      await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(dest));
      installJob.percent = 100;
      return { bytes: installJob.received };
    }

    function unzipTo(zipFile, target) {
      return new Promise((resolve, reject) => {
        const child = spawn('tar', ['-xf', zipFile, '-C', target], { windowsHide: true });
        child.on('error', reject);
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`解压失败（tar exit=${code}）`))));
      });
    }

    /** 解压后找到真正的 app 目录（zip 里带一层版本号文件夹）。 */
    function findAppDir(root) {
      const candidates = [];
      const walk = (dir, depth) => {
        if (depth > 3) return;
        try {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const full = join(dir, entry.name);
            if (existsSync(join(full, 'breeze-server.exe'))) candidates.push(full);
            walk(full, depth + 1);
          }
        } catch { /* ignore */ }
      };
      walk(root, 0);
      return candidates[0] || '';
    }

    function writeStartScript(installDir, appDir, weightsPath, port) {
      const bat = [
        '@echo off',
        'set GGML_VULKAN_DEVICE=1',
        `cd /d "${appDir}"`,
        'echo ============================================',
        'echo  Breeze TTS 2 server starting...',
        `echo  Web UI: http://127.0.0.1:${port || 8080}`,
        'echo  Keep this window open while using it.',
        'echo ============================================',
        `"${join(appDir, 'breeze-server.exe')}" "${weightsPath}" --webui --chunk-max 40`,
        'pause',
        '',
      ].join('\r\n');
      const path = join(installDir, 'start-server.bat');
      writeFileSync(path, bat, 'utf8');
      return path;
    }

    /** 后台执行安装：下载 → 校验 → 解压 → 生成启动脚本 → 写配置。 */
    async function runInstall(opts) {
      const dir = String(opts.dir || '').trim();
      const tierKey = String(opts.tier || 'q8_0');
      const spec = TTS_TIERS[tierKey];
      try {
        installJob.state = 'running';
        installJob.phase = '准备目录';
        installJob.dir = dir;
        installJob.tier = tierKey;
        installJob.startedAt = Date.now();
        await mkdir(dir, { recursive: true });
        const tmp = join(dir, '_download');
        await mkdir(tmp, { recursive: true });

        // ① 程序包
        const zipPath = opts.localProgram ? String(opts.localProgram) : join(tmp, TTS_LOCK.asset);
        if (!opts.localProgram) {
          const url = String(opts.programUrl || TTS_LOCK.programUrl);
          await downloadTo(url, zipPath, '程序包');
        }
        if (TTS_LOCK.programSha256) {
          installJob.phase = '校验程序包';
          const got = await sha256Of(zipPath);
          if (got !== TTS_LOCK.programSha256) throw new Error(`程序包校验失败（sha256=${got.slice(0, 12)}…）`);
        }
        installJob.phase = '解压程序包';
        await mkdir(join(dir, 'app'), { recursive: true });
        await unzipTo(zipPath, join(dir, 'app'));

        // ② 权重
        const modelsDir = join(dir, 'models');
        await mkdir(modelsDir, { recursive: true });
        const weightsPath = opts.localWeights ? String(opts.localWeights) : join(modelsDir, spec.file);
        if (!opts.localWeights) {
          const url = String(opts.weightsUrl || `${TTS_LOCK.weightsBase}${spec.file}`);
          await downloadTo(url, weightsPath, `权重 ${spec.label}`);
        }

        // ③ 启动脚本
        installJob.phase = '生成启动脚本';
        const appDir = findAppDir(join(dir, 'app')) || join(dir, 'app');
        if (!existsSync(join(appDir, 'breeze-server.exe'))) throw new Error('解压后没找到 breeze-server.exe');
        const batPath = writeStartScript(dir, appDir, weightsPath, 8080);

        // ④ 写配置
        installJob.phase = '写入配置';
        cfg.installDir = dir;
        cfg.installWeights = spec.file;
        cfg.startScript = batPath;
        await persist();

        installJob.state = 'done';
        installJob.phase = '安装完成';
        installJob.percent = 100;
        installJob.message = `已装到 ${dir}（${spec.label}）`;
        installJob.finishedAt = Date.now();
        note('install:done', `dir=${dir} tier=${tierKey} bat=${batPath}`);
        // 装完顺手把出厂音色装进去（用户装的时候选过性别才有）
        if (installJob.voicePreset) {
          try {
            installJob.phase = '装出厂音色';
            const got = await ensurePresetVoice(installJob.voicePreset);
            cfg.voice = got.voice;
            cfg.voicePreset = got.preset;
            await persist();
            installJob.message = `已装到 ${dir}（${spec.label}）· 默认音色 ${got.label}`;
            note('install:preset', `preset=${got.preset} imported=${got.imported}`);
          } catch (error) {
            note('install:preset-error', String((error && error.message) || error));
          }
        }
      } catch (error) {
        installJob.state = 'error';
        installJob.error = String((error && error.message) || error);
        installJob.phase = '失败';
        installJob.finishedAt = Date.now();
        note('install:error', installJob.error);
      } finally {
        installing = false;
      }
    }


    /* ───────── ：DSH 要用户做选择时，先念一句提醒 ───────── */

    const remindSeen = new Map(); // hash → 时间戳，防重复投递念两遍
    function shouldRemind(key) {
      const now = Date.now();
      const last = remindSeen.get(key) || 0;
      if (now - last < 5000) return false;
      remindSeen.set(key, now);
      if (remindSeen.size > 50) {
        for (const [k, t] of remindSeen) if (now - t > 60000) remindSeen.delete(k);
      }
      return true;
    }

    /** 选项提问：把问题原文拼成一句短提示（不念选项正文，眼睛看更快）。 */
    async function remindQuestion(request, via) {
      if (!cfg.enabled || cfg.speakOnQuestion === false) return;
      const list = Array.isArray(request?.questions) ? request.questions : [];
      if (!list.length) return;
      const first = list[0] || {};
      const title = String(first.question || first.header || '').trim();
      if (!title) return;
      const prefix = list.length > 1
        ? `要你在 ${list.length} 个问题里先选一个，第一个是：`
        : (first.multiSelect ? '要你选几个：' : '要你选一下：');
      const text = capText(`${prefix}${title}`, 90);
      if (!shouldRemind(hashText(text))) return;
      const sessionId = request?.agent?.id ? String(request.agent.id) : '';
      note('question:speak', `${text.slice(0, 40)} via=${via || '-'} session=${sessionId || '广播'}`);
      await speakOnce({ text }, sessionId);
    }

    /** 权限审批：念"有件事要你确认"+ 工具名/原因。 */
    async function remindApproval(req, via) {
      if (!cfg.enabled || cfg.speakOnApproval === false) return;
      const tool = String(req?.toolName || req?.tool || '').trim();
      const reason = String(req?.reason || '').slice(0, 40).trim();
      const what = reason || tool || '';
      const text = capText(what ? `有件事要你确认：${what}` : '有件事要你点一下同意。', 90);
      if (!shouldRemind(hashText(text))) return;
      const sessionId = req?.agent?.id ? String(req.agent.id) : '';
      note('approval:speak', `${text.slice(0, 40)} via=${via || '-'} session=${sessionId || '广播'}`);
      await speakOnce({ text }, sessionId);
    }

    /** 事件包装器——**进来就记账**。以前这条链路静默失败时，日志里连"被调用过"都没有，
     *  只能靠猜。现在每次进入 handler 都会留一行 `remind:enter`。 */
    function questionHandler(via) {
      return (request, next) => {
        try {
          note('remind:enter', `kind=question via=${via} keys=${Object.keys(request || {}).join(',') || '-'} n=${Array.isArray(request?.questions) ? request.questions.length : '-'}`);
        } catch { /* 记账失败不影响提问 */ }
        try { void remindQuestion(request, via); } catch { /* 播报失败不该影响提问 */ }
        return typeof next === 'function' ? next() : undefined;
      };
    }

    function approvalHandler(via) {
      return (request, next) => {
        try {
          note('remind:enter', `kind=approval via=${via} keys=${Object.keys(request || {}).join(',') || '-'} tool=${request?.toolName || request?.tool || '-'}`);
        } catch { /* 同上 */ }
        try { void remindApproval(request, via); } catch { /* 同上 */ }
        return typeof next === 'function' ? next() : undefined;
      };
    }

    /**
     * 从会话事件 `tool/call` 里认出 `ask_user_question`，把第一个问题念出来。
     * 事件形状：`{ turn, step, callId, name, arguments }`（arguments 是 JSON 字符串）。
     * 这是**可靠入口** waterfall 那条会被排在前面的 answerer 截断。
     */
    function maybeRemindToolCall(sessionId, data) {
      try {
        if (!cfg.enabled || cfg.speakOnQuestion === false) return;
        const name = String(data?.name || '');
        if (name !== 'ask_user_question' && name !== 'request_user_input') return;
        let args = data?.arguments;
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { args = null; }
        }
        const list = Array.isArray(args?.questions) ? args.questions : [];
        const first = list[0] || {};
        const title = String(first.question || first.header || '').trim();
        if (!title) {
          note('remind:empty', `tool=${name} args=${String(data?.arguments || '').slice(0, 80)}`);
          return;
        }
        const multi = first.multi_select === true || first.multiSelect === true;
        const prefix = list.length > 1
          ? `要你在 ${list.length} 个问题里先选一个，第一个是：`
          : (multi ? '要你选几个：' : '要你选一下：');
        const text = capText(`${prefix}${title}`, 90);
        if (!shouldRemind(hashText(text))) return;
        note('question:speak', `${text.slice(0, 40)} via=tool/call session=${String(sessionId).slice(0, 8)}`);
        void speakOnce({ text }, sessionId);
      } catch (error) {
        note('remind:error', String((error && error.message) || error));
      }
    }

    /** `approval/asked` 会话事件（比 `approval/request` 稳）。`{ id, toolName, callId, reason }` */
    function maybeRemindApprovalEvent(sessionId, data) {
      try {
        if (!cfg.enabled || cfg.speakOnApproval === false) return;
        const reason = String(data?.reason || '').slice(0, 40).trim();
        const tool = String(data?.toolName || '').trim();
        const what = reason || tool;
        const text = capText(what ? `有件事要你确认：${what}` : '有件事要你点一下同意。', 90);
        if (!shouldRemind(hashText(text))) return;
        note('approval:speak', `${text.slice(0, 40)} via=approval/asked session=${String(sessionId).slice(0, 8)}`);
        void speakOnce({ text }, sessionId);
      } catch (error) {
        note('remind:error', String((error && error.message) || error));
      }
    }

    /**
     * **引擎起不来这件事必须有人知道，而且必须能自愈。**
     *
     * 以前的三处毛病（朋友现场日志里逐条对上）：
     *  ① `startServer()` 一律 3 分钟节流、失败也不清 → 第一次没拉起来，后面三分钟全 `spawn=false`；
     *  ② `spawn=false` 之后照样 `while` 空等 90 秒 —— 等一个根本没被启动的服务；
     *  ③ 超时后把整批台词 `shift()` 丢掉，**只写一行日志**，界面还写着"起来后自动补念"。
     *
     * 现在：`spawn=false` 时不再干等，改为**在等待窗口内到点补拉一次**（`force`）；
     * 就绪回报 `markServerReady()`（节流恢复 3 分钟）、超时回报 `markServerFailed()`（退避缩到 15 秒）；
     * 丢掉的每一句都记进 `lastVoiceFailure`，由 `/state` 交给界面显示。
     */
    function kickServer() {
      if (serverStarting) return;
      serverStarting = true;
      const startedAt = Date.now();
      const waitMs = Number(cfg.startWaitMs || 90000);
      const spawned = breezeTts().startServer();
      note('server:start', `spawn=${spawned} waitMs=${waitMs}`);
      void (async () => {
        const deadline = startedAt + waitMs;
        let forced = false;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1500));
          if (await breezeTts().healthy()) {
            serverStarting = false;
            breezeTts().markServerReady();
            note('server:ready', `${Date.now() - startedAt}ms`);
            await flushPending();
            return;
          }
          // 节流到点还没起来 → 补拉一次（只补一次，免得刷出一堆控制台窗口）
          if (!forced) {
            const info = breezeTts().spawnInfo();
            if (info.retryInMs <= 0) {
              forced = true;
              const again = breezeTts().startServer(true);
              note('server:retry-spawn', `spawn=${again} after=${Date.now() - startedAt}ms failedWindow=${info.failed}`);
            }
          }
        }
        serverStarting = false;
        breezeTts().markServerFailed();
        const bootFailure = `BreezeTTS 没能在 ${Math.round(waitMs / 1000)} 秒内起来（${cfg.startScript || '未配置 startScript'}）`;
        breezeTts().lastError = bootFailure;
        note('server:timeout', bootFailure);
        dropPending(`engine-timeout: ${bootFailure}`);
      })();
    }

    /**
     * **丢弃要留证**。以前只写一行 `server:drop`，
     * 界面却挂着"起来后自动补念"——用户以为模型没说话。
     * 现在把"什么时候、为什么、丢了几句、第一句是什么"记进 `lastVoiceFailure`，`/state` 交给界面显示。
     */
    function dropPending(reason) {
      const count = pendingLines.length;
      if (!count) return 0;
      const sample = String(pendingLines[0]?.cleaned || '').slice(0, 40);
      while (pendingLines.length) {
        const dropped = pendingLines.shift();
        note('server:drop', dropped.cleaned.slice(0, 60));
      }
      lastVoiceFailure = { at: new Date().toISOString(), reason, count, sample };
      note('voice:dropped', `count=${count} reason=${reason}`);
      return count;
    }

    /** 端点就绪后把攒着的话一句句念出来（走同一条串行队列）。 */
    async function flushPending() {
      while (pendingLines.length) {
        const item = pendingLines.shift();
        try {
          startStreaming(item.cleaned, item.overrides, item.sessionId, item.turnHint);
          note('server:flushed', item.cleaned.slice(0, 60));
        } catch (error) {
          note('server:flush-error', String((error && error.message) || error));
        }
      }
    }

    /**
     * 流式播报：先入账（客户端马上能拿到 URL），后台合成时把音频块追加入账条目，
     * `/audio/<id>` 边到边写 → 浏览器边下边播。首音延迟从"整段合成完"降到"第一块音频"。
     */
    /**
     * 一段"文本 + 气口"混合内容 → 逐块入队：文本走 speakOnce，气口走 pushPause。
     * 没有气口标记时就等价于一次 speakOnce（不额外开销）。
     */
    async function enqueueLine(text, sessionId, spec, extra) {
      const parts = splitPause(text);
      /*
       * T5：**长文本切片**，让合成与播放并行。
       *
       * 本机引擎串行，一整段 40 秒的播报要等整段合成完才开口；机器一忙（开着游戏）合成掉到 1× 以下，
       * 句中就垫底。切成 40~70 字一片之后，B 片在合成时 A 片已经在播 —— 只要单片合成快于单片播放，就永不垫底。
       *
       * 片与片之间**不留气口** 同一个 `pieceGroup` 的片由客户端背靠背播（`segmentGapMs` 只在不同段之间用），
       * 否则每片之间插 500 ms 会把"抗卡顿"换成"一句一顿"，更难受。
       *
       * ⚠ 这里**不能**再对"只有一块文本"提前 return —— 第一版就写了那个早退，于是最常见的情况
       * （一句话、没有 `[停顿N秒]`）根本不走切片，自测直接抓到。
       */
      const chunkMax = Number(cfg.chunkChars) || 0;
      const results = [];
      for (const part of parts) {
        if (part.type === 'pause') {
          pushPause(part.ms, sessionId, turnHint);
          results.push({ status: 'queued', chars: 0, pauseMs: part.ms });
          continue;
        }
        let pieces = [part.text];
        if (chunkMax >= 20) {
          const split = splitForChunking(part.text, chunkMax);
          if (split.length) pieces = split;
        }
        if (pieces.length > 1) {
          note('chunk:split', `chars=${String(part.text).length} pieces=${pieces.length} max=${chunkMax} sizes=${pieces.map((one) => one.length).join(',')}`);
        }
        const group = pieces.length > 1 ? nextPieceGroup() : '';
        for (let i = 0; i < pieces.length; i += 1) {
          const meta = group ? { pieceGroup: group, pieceIndex: i + 1, pieceCount: pieces.length } : null;
          // G0（0.96.0）：一次性风格参数跟着这一行往下走（同一句话被切开时，每一块都带同一套）
          results.push(await speakOnce({
            text: pieces[i],
            instructions: extra?.instructions,
            cfg_scale: extra?.cfg_scale,
            style: extra?.style,
          }, sessionId, spec, extra?.turn, meta));
        }
      }
      return results;
    }

    function startStreaming(cleaned, overrides, sessionId, turnHint, pieceMeta) {
      // A2：云端引擎不认本机音色名，进合成前先换成它认得的（或干脆不发）。
      if (overrides) overrides.voice = voiceForEngine(overrides.voice);
      seq += 1;
      const id = `${seq}-${createHash('sha1').update(`${cleaned}|${Date.now()}`).digest('hex').slice(0, 8)}`;
      const entry = {
        id,
        seq,
        kind: 'speech',
        // 兜底播报是在 turn/end 之后异步跑的，那时 turnState 已经删掉，
        // 以前这里会落到 turn=0 —— 于是 /turn 按轮次查不到，按钮就报"这一轮没有语音"。
        turn: Number(turnHint ?? turnState.get(sessionId)?.turn ?? 0),
        file: '',
        text: cleaned,
        chars: cleaned.length,
        ms: 0,
        cached: false,
        session: sessionId || '',
        // T5：这一条是某一段的第几片（多片时才非空）—— 客户端据此"背靠背播、不插气口"
        pieceGroup: pieceMeta?.pieceGroup || '',
        pieceIndex: Number(pieceMeta?.pieceIndex) || 0,
        pieceCount: Number(pieceMeta?.pieceCount) || 0,
        chunks: [],
        done: false,
        error: '',
        wake: null,
      };
      remember(entry);
      const push = (buf) => {
        entry.chunks.push(buf);
        const wake = entry.wake;
        entry.wake = null;
        if (wake) wake();
      };
      void (async () => {
        try {
          // **音色先对齐，再开口**。
          // 以前：`state.json` / `cast.json` 里留着一个引擎声音库里没有的 id（朋友现场是 `wenrou3`）→
          // 每句都先 404 一次，再走"设计模式"重念；而重念那次会把已经吐出去的 chunk 清空
          // （下面是 `entry.chunks.length = 0`），客户端手里就是一段坏流 → 很可能整体重拉。
          // 现在开口前用 60 秒缓存的音色清单校验一次：不在库里就直接走设计模式，并记一行 `voice:not-live`。
          if (tts.engine.kind === 'breeze' && overrides && overrides.voice) {
            const items = await listVoices().catch(() => []);
            const ids = (Array.isArray(items) ? items : []).map((v) => v && v.id).filter(Boolean);
            if (ids.length && !ids.includes(overrides.voice)) {
              const preset = String(cfg.voicePreset || '');
              const next = preset && ids.includes(preset) ? preset : '';
              note('voice:not-live', `${overrides.voice} 不在引擎声音库（${ids.length} 个）→ ${next || '(设计模式)'}`);
              overrides.voice = next;
            }
          }
          let result;
          try {
            result = await withEngineFallback((inst) => inst.enqueue(() => inst.synthesizeStream(cleaned, overrides, push)));
          } catch (error) {
            const message = String((error && error.message) || error);
            const effectiveVoice = overrides.voice === undefined ? cfg.voice : overrides.voice;
            // 音色名失效：退回声音设计模式重念一次（已经吐出去的字块作废，客户端会重新拉）
            if (effectiveVoice && /voice|音色/i.test(message)) {
              note('voice:fallback', `${effectiveVoice} → ${message}`);
              overrides.voice = '';
              entry.chunks.length = 0;
              result = await tts.enqueue(() => tts.synthesizeStream(cleaned, overrides, push));
            } else {
              throw error;
            }
          }
          entry.file = result.file;
          entry.ms = result.ms;
          entry.cached = Boolean(result.cached);
          // P1：这句话在发出去之前被擦掉了什么（模型在用别家引擎的记号时，这里是唯一线索）
          {
            const droppedList = (result && result.sanitize && result.sanitize.dropped) || [];
            if (droppedList.length) {
              note('speak:sanitize', `engine=${tts.engine.id} kind=${tts.engine.kind} dropped=${droppedList.length} [${droppedList.slice(0, 6).join(', ')}]`);
            }
          }
          // A3：云端这次真的用某个音色念出来了 → 记进该 provider 的「用过的音色」，
          // 面板的音色下拉就会带上它（下次不用凭记忆手打）。
          if (tts.engine.kind !== 'breeze' && overrides.voice) rememberVoice(tts.engine.id, overrides.voice);
          scheduleHistorySave();
          tts.lastError = '';
          // 这一句真的念成了 → 清掉"上次没念成"的告警
          if (lastVoiceFailure) lastVoiceFailure = null;
        } catch (error) {
          entry.error = String((error && error.message) || error);
          // 失败的这一段**要能被看到**，不能只躺在 events.log 里
          lastVoiceFailure = { at: new Date().toISOString(), reason: entry.error, count: 1, sample: cleaned.slice(0, 40) };
          tts.lastError = entry.error;
          note('stream:error', entry.error);
        } finally {
          entry.done = true;
          const wake = entry.wake;
          entry.wake = null;
          if (wake) wake();
          // done 之后再落一次盘。以前的落盘只挂在"入账"和"messageId 登记"上，
          // 最后一段合成完时可能刚好没人再触发保存 → 重启后这段就没了。
          scheduleHistorySave();
        }
      })();
      return {
        status: 'queued',
        chars: cleaned.length,
        ms: 0,
        cached: false,
        streaming: true,
        id,
        url: `${ROUTE_PREFIX}audio/${id}.wav`,
      };
    }

    /**
     * 场景（一局剧本）。`~/.dsh/voice-breeze/scenes/<场景>/{persona.md,cast.json,config.json}`
     * `index.json` 只记"当前是哪一局"。**scenes/ 不存在时，继续读根目录**，行为与旧版完全一致。
     */
    const scenesDir = join(dataDir(), 'scenes');
    function readJsonFile(path) {
      try { return JSON.parse(String(readFileSync(path, 'utf8') || '')); } catch { return null; }
    }
    function listScenes() {
      const indexPath = join(scenesDir, 'index.json');
      const index = readJsonFile(indexPath);
      const fromDisk = [];
      try {
        for (const entry of readdirSync(scenesDir, { withFileTypes: true })) {
          if (entry.isDirectory()) fromDisk.push(entry.name);
        }
      } catch { /* 没有 scenes 目录 */ }
      const listed = Array.isArray(index?.scenes) ? index.scenes.map((item) => String(item.id || item)).filter(Boolean) : [];
      // 修：**只认磁盘上真的存在的目录**。
      // 以前是 `[...listed, ...fromDisk]` 取并集，于是 index.json 里的旧条目会被并回来：
      // 删掉的场景一直留在列表里（点删除像没反应），而它的目录已经没了，
      // 读卡一律拿到空文本，面板还会误报「不是 {"characters": [...]} 的形状」。
      const onDisk = new Set(fromDisk);
      const ids = fromDisk.length
        ? [...new Set([...listed.filter((id) => onDisk.has(id)), ...fromDisk])]
        : [];
      return { active: index?.active || '_default', ids };
    }
    function activeSceneId() {
      const { active, ids } = listScenes();
      if (ids.length && ids.includes(active)) return active;
      return ids.length ? ids[0] : '';
    }
    /**
     * 场景里的某个文件；场景目录缺这个文件就退回根目录那份（向后兼容）。
     *
     * **单音色完全不看 `scenes/`**——单音色用的是「全局角色卡」
     * `~/.dsh/voice-breeze/persona.md`，场景（场景卡 + 音色表）只属于多音色扮演。
     * 这样切回单音色时不会莫名其妙被上一个场景的角色卡接管。
     */
    function sceneFile(name) {
      if (!cfg.multiVoice) return join(dataDir(), name);
      const scene = activeSceneId();
      if (scene) {
        const path = join(scenesDir, scene, name);
        try { readFileSync(path); return path; } catch { /* 没有就用根目录 */ }
      }
      return join(dataDir(), name);
    }
    function setActiveScene(id) {
      const { ids } = listScenes();
      if (id && !ids.includes(id)) return false;
      const indexPath = join(scenesDir, 'index.json');
      const index = readJsonFile(indexPath) || {};
      const scenes = ids.map((entry) => ({ id: entry, label: entry }));
      index.active = id || '_default';
      index.scenes = scenes;
      try {
        writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');
        return true;
      } catch {
        return false;
      }
    }

    /** 启动时清一次 `scenes/index.json`：指向不存在目录的条目一条都不留。
     *  （修：以前删场景只搬目录、index 里的旧条目会被 `listScenes()` 并回来，
     *   于是删掉的场景永远留在界面上、读卡全是空。） */
    function pruneSceneIndex() {
      try {
        const indexPath = join(scenesDir, 'index.json');
        const index = readJsonFile(indexPath);
        if (!index) return;
        const { ids } = listScenes();
        const listed = Array.isArray(index.scenes)
          ? index.scenes.map((item) => String(item.id || item)).filter(Boolean)
          : [];
        const stale = listed.filter((id) => !ids.includes(id));
        if (!stale.length) return;
        setActiveScene(ids.includes(index.active) ? index.active : '');
        note('scene:prune', stale.join(','));
      } catch { /* 启动清理失败不影响主流程 */ }
    }

    // ─────────────────────────  期 2：角色卡 / 场景管理 ─────────────────────────
    // 面板里的读写全走这里。安全口径：场景 id 白名单、写盘只落在 dataDir 之内、
    // 原子写（tmp → rename）、覆盖前把旧内容留一份 .bak、删除只搬到 _trash/。
    const trashDir = join(dataDir(), '_trash');
    const SCENE_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
    /** 面板写入的上限（注入时仍然按 PERSONA_MAX_CHARS=6000 截断，这里只是防手滑贴进巨型文件） */
    const CARD_WRITE_MAX = 200000;

    function isSafeSceneId(id) {
      const value = String(id || '');
      return SCENE_ID_RE.test(value) && value !== '_trash' && value !== '.' && value !== '..';
    }
    function sceneDirOf(id) {
      return join(scenesDir, String(id));
    }
    /** 先写临时文件再 rename：中途断电/崩也不会留下半份角色卡 */
    async function atomicWriteText(target, text) {
      await mkdir(dirname(target), { recursive: true });
      const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmp, text, 'utf8');
      await rename(tmp, target);
    }
    /** 覆盖前留一份 .bak（只留最近一次，够手工回滚） */
    async function backupOnce(target) {
      try {
        const old = await readFile(target, 'utf8');
        await writeFile(`${target}.bak`, old, 'utf8');
      } catch { /* 之前没有这个文件，不用备份 */ }
    }
    /** cast.json 的形状校验：不合格就不写，把原因回给面板 */
    function castShapeError(text) {
      let parsed;
      try {
        parsed = JSON.parse(String(text || '').trim() || '{}');
      } catch (error) {
        return `不是合法 JSON：${(error && error.message) || ''}`;
      }
      const raw = Array.isArray(parsed) ? parsed : parsed?.characters;
      if (!Array.isArray(raw)) return '要写成 {"characters": [...]}（或直接给一个数组）';
      for (let index = 0; index < raw.length; index += 1) {
        const item = raw[index];
        if (!item || typeof item !== 'object') return `第 ${index + 1} 条不是对象`;
        const name = String(item.name || '').trim();
        if (!name) return `第 ${index + 1} 条没有 name`;
        const hasVoice = typeof item.voice === 'string' && item.voice.trim();
        const hasTone = typeof item.tone === 'string' && item.tone.trim();
        if (!hasVoice && !hasTone) return `「${name}」既没有 voice 也没有 tone（两个都没有会被忽略）`;
        if (item.seed !== undefined && item.seed !== null && !Number.isFinite(Number(item.seed))) {
          return `「${name}」的 seed 不是数字`;
        }
      }
      return '';
    }
    /** 建一个场景骨架：persona.md（空）+ cast.json（空表）+ characters/ */
    async function ensureScene(id) {
      const dir = sceneDirOf(id);
      await mkdir(join(dir, 'characters'), { recursive: true });
      try {
        await stat(join(dir, 'persona.md'));
      } catch {
        await writeFile(join(dir, 'persona.md'), '', 'utf8');
      }
      try {
        await stat(join(dir, 'cast.json'));
      } catch {
        await writeFile(join(dir, 'cast.json'), '{\n  "characters": []\n}\n', 'utf8');
      }
      return dir;
    }
    /** 写完立刻让两个缓存失效，下一轮播报就用新卡 */
    function invalidateCardCaches() {
      personaCache = { at: 0, text: '', scene: '' };
      castCache = { at: 0, list: [], scene: '' };
    }
    // ──────────────────────────────────────────────────────────────────────────────

    /** 角色卡：`~/.dsh/voice-breeze/persona.md`。宿主每次用之前读一遍（2 秒缓存），
     *  所以 AI 直接写文件就能生效，不需要额外路由或重启。 */    const personaPath = () => sceneFile('persona.md');
    let personaCache = { at: 0, text: '', scene: '' };
    /** 角色卡上限：单份 6000 字符（从 1200/1500 放宽，长设定不再被腰斩）。 */
    const PERSONA_MAX_CHARS = 6000;

    /**
     * 多张角色卡：按 cast.json 里的角色名，先找场景内
     * `scenes/<场景>/characters/<角色名>.md`，找不到再找根目录外置的
     * `~/.dsh/voice-breeze/characters/<角色名>.md`。
     * 旁白不参与（它没有"人设"）。只有角色扮演模式会用到。
     */
    // 角色卡同样缓存 2 秒：系统提示词的 text() 一轮里会被读多次，别每次都去敲硬盘
    const cardsCache = { at: 0, key: '', list: [] };
    function characterCards() {
      const cast = readCast();
      const names = cast.map((item) => String(item?.name || '').trim()).filter((name) => name && name !== '旁白');
      if (!names.length) return [];
      const dirs = [];
      // 单音色不看场景目录，角色卡只从根目录 characters/ 读
      const scene = cfg.multiVoice ? activeSceneId() : '';
      if (scene) dirs.push(join(scenesDir, scene, 'characters'));
      dirs.push(join(dataDir(), 'characters'));
      const key = `${activeSceneId()}|${names.join(',')}|${dirs.join(';')}`;
      if (Date.now() - cardsCache.at < 2000 && cardsCache.key === key) return cardsCache.list;
      const out = [];
      for (const name of names) {
        let text = '';
        for (const dir of dirs) {
          try {
            text = String(readFileSync(join(dir, `${name}.md`), 'utf8') || '').trim();
          } catch { text = ''; }
          if (text) break;
        }
        if (text) out.push({ name, text });
      }
      cardsCache.at = Date.now();
      cardsCache.key = key;
      cardsCache.list = out;
      return out;
    }

    /**
     * 拼成注入给模型的整块"角色设定"：
     * 共同设定（persona.md）+ 每个角色一张卡（characters/<名字>.md）。
     * 单音色时通常只有共同设定；多音色时两者都有。
     * 拼之前先过 resolveCardLiterals——网上下载的角色卡带 {{user}} / {{char}}，
     * 原样进系统提示词会让宿主插值抛错，整轮直接失败。
     */
    function personaBlock() {
      const shared = readPersona();
      const cards = characterCards();
      const castNames = readCast().map((item) => String(item?.name || '').trim()).filter((name) => name && name !== '旁白');
      const names = {
        userName: cfg.userName,
        charName: String(cfg.charName || '').trim() || castNames[0] || '角色',
      };
      const parts = [];
      if (shared) parts.push(`场景与共同设定：\n${resolveCardLiterals(shared, names)}`);
      if (cards.length) parts.push(`角色卡（每人一份）：\n${cards.map((c) => `【${c.name}】\n${resolveCardLiterals(c.text, { ...names, charName: c.name || names.charName })}`).join('\n\n')}`);
      const text = parts.join('\n\n').trim();
      return text ? text.slice(0, PERSONA_MAX_CHARS) : '';
    }

    function readPersona() {
      const now = Date.now();
      // 缓存 key 用**实际路径**，而不是场景 id —— 切单/多音色时路径会变，否则会读到旧缓存
      const scene = `${cfg.multiVoice ? 'mv' : 'sv'}|${personaPath()}`;
      if (now - personaCache.at < 2000 && personaCache.scene === scene) return personaCache.text;
      let text = '';
      try {
        text = String(readFileSync(personaPath(), 'utf8') || '').trim();
      } catch { /* 还没有角色卡 */ }
      personaCache = { at: now, text, scene };
      return text;
    }

    /** 说话语气：`~/.dsh/voice-breeze/tone.txt`。用户直接告诉 AI 想要什么性格，AI 写这个文件即可，
     *  宿主每 2 秒最多读一次，改完下一句生效，不用重启、不用界面按钮。 */
    const tonePath = join(dataDir(), 'tone.txt');
    let toneCache = { at: 0, text: '' };
    function syncTone() {
      const now = Date.now();
      if (now - toneCache.at < 2000) {
        if (toneCache.text) cfg.toneInstructions = toneCache.text;
        return;
      }
      let text = '';
      try {
        text = String(readFileSync(tonePath, 'utf8') || '').trim();
      } catch { /* 没有 tone.txt 就用配置里的 */ }
      toneCache = { at: now, text };
      if (text) cfg.toneInstructions = text;
    }

    /**
     * 角色音色表：`~/.dsh/voice-breeze/cast.json`
     * 形如 {"characters":[{"name":"角色甲","voice":"你的音色id","tone":"语气内敛…"},{"name":"旁白","voice":"你的音色id","tone":"平静叙述"}]}
     * 有了它，角色扮演的每一段可以带各自的 voice/speaker，多角色 + 旁白 + 心声才可能只靠听就懂。
     */
    const castPath = () => sceneFile('cast.json');
    let castCache = { at: 0, list: [], scene: '' };
    function readCast() {
      const now = Date.now();
      const scene = `${cfg.multiVoice ? 'mv' : 'sv'}|${castPath()}`;
      if (now - castCache.at < 2000 && castCache.scene === scene) return castCache.list;
      let list = [];
      try {
        const parsed = JSON.parse(String(readFileSync(castPath(), 'utf8') || ''));
        const raw = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.characters) ? parsed.characters : []);
        list = raw
          .filter((item) => item && (typeof item.voice === 'string' || typeof item.tone === 'string' || typeof item.description === 'string'))
          .map((item) => ({
            name: String(item.name || item.voice || item.description || '').trim(),
            // voice 为空 = 设计模式：用 tone/description 现造一个嗓子（seed 保证可复现）
            voice: typeof item.voice === 'string' ? item.voice.trim() : '',
            tone: String(item.tone || item.description || '').trim(),
            seed: Number.isFinite(Number(item.seed)) ? Number(item.seed) : null,
          }))
          .filter((item) => item.name);
      } catch { /* 没有 cast.json 就单音色播 */ }
      castCache = { at: now, list, scene };
      return list;
    }

    /** 播报音量：0~1，非法值回落到 1；只保留两位小数，免得 state.json 里一堆浮点尾巴。 */
    function clampVolume(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return 1;
      return Math.min(1, Math.max(0, Math.round(n * 100) / 100));
    }

    /** 当前强度档（未知值一律回落到中档）。 */
    function strengthPreset() {
      return STRENGTHS[cfg.strength] || STRENGTHS.medium;
    }

    /** 这一档实际能念多少字：档位目标与配置安全阀取较小值。角色扮演不受强度安全阀约束。 */
    function effectiveMaxChars() {
      if (cfg.fallback === 'roleplay') return ROLEPLAY_BUDGET.maxChars;
      // /：全文与摘要都不看强度档，只受配置里的安全阀限制（每段/每句最长多少字）
      // 摘要档界面已隐藏强度（，裁决）：首句一般很短，档位几乎不影响听感，留着只是增加操作负担
      if (cfg.fallback === 'full' || cfg.fallback === 'auto') {
        const guard = Number(cfg.maxChars);
        return Number.isFinite(guard) && guard > 0 ? guard : 240;
      }
      const preset = strengthPreset();
      const guard = Number(cfg.maxChars);
      if (!Number.isFinite(guard) || guard <= 0) return preset.maxChars;
      return Math.min(preset.maxChars, guard);
    }

    /**
     * 某一段该用哪个嗓音（现在：**先看界面选的是单音色还是多音色**）：
     *  - 单音色（`multiVoice=false`）→ cast 完全不参与，只用「会话记忆 > 全局默认」那一把嗓子；
     *    `speaker` 只当"谁在说"的标注，段级语气（正文括号 / `segments[].tone`）照旧生效。
     *  - 多音色（`multiVoice=true`）→ 先按 speaker 名字在 cast.json 里找人，再按 voice id 找人；
     *    voice 非空 → 必须是声音库里真实存在的音色；voice 为空但有 tone → 设计模式现造嗓子。
     * 任何一种对不上，都退回会话音色，绝不让一段哑掉。
     */
    async function resolveSegmentVoice(line, sessionId) {
      // 裁决：声音分配以界面选择为准。多音色关掉后，cast.json 里还有内容也不许顶掉单音色。
      const cast = cfg.multiVoice ? readCast() : [];
      const speaker = String(line && line.speaker ? line.speaker : '').trim();
      const voiceId = String(line && line.voice ? line.voice : '').trim();
      const named = speaker ? cast.find((item) => item.name === speaker) : null;
      const byVoice = !named && voiceId ? cast.find((item) => item.voice && item.voice === voiceId) : null;
      const entry = named || byVoice;
      const fallback = { voice: voiceForSession(sessionId), instructions: (line && line.instructions) || '', seed: null };
      if (!entry) {
        // 多音色下没写 speaker 时落**主角色**（cast 里第一个非「旁白」的条目）。
        // 旁白默认不参与日常汇报，所以 speaker 缺失时不往旁白兜。
        const lead = cfg.multiVoice ? leadSpeaker() : null;
        if (!lead) return fallback;
        note('voice:no-speaker', `未指定 speaker，用主角色 ${lead.name} → ${lead.voice || '设计模式'}`);
        return {
          voice: lead.voice || '',
          instructions: (line && line.instructions) || lead.tone || '',
          seed: Number.isFinite(lead.seed) ? lead.seed : null,
        };
      }
      if (entry.voice) {
        const available = await listVoices().catch(() => []);
        if (available.length && !available.some((item) => item.id === entry.voice)) {
          note('voice:not-in-library', `${entry.name} → ${entry.voice} 不在声音库，退回会话音色`);
          return { ...fallback, instructions: fallback.instructions || entry.tone, seed: entry.seed };
        }
      } else if (!entry.tone) {
        note('voice:cast-empty', `${entry.name} 既没有 voice 也没有 tone，退回会话音色`);
        return fallback;
      }
      // 段级 tone（正文括号 / segments[].tone）优先，cast 里的固定 tone 只做兜底
      return { voice: entry.voice, instructions: (line && line.instructions) || entry.tone || '', seed: entry.seed };
    }

    /** 某个会话实际该用的音色：会话自己记的优先，其次全局默认。 */
    /**
     * 主角色：cast 里第一个「不是旁白」且至少配了 voice / tone 的条目。
     * 多音色下没指定 speaker 时用它，避免技术汇报由旁白或会话音色念出来。
     */
    function leadSpeaker() {
      const cast = readCast();
      return cast.find((item) => item && item.name && item.name !== '旁白' && (item.voice || item.tone)) || null;
    }

    function voiceForSession(sessionId) {
      const remembered = sessionId ? cfg.sessions?.[sessionId]?.voice : undefined;
      return typeof remembered === 'string' ? remembered : (cfg.voice || '');
    }

    /** 只用于日志：这次 speak 实际会用哪个音色。 */
    function overridesForLog(args, sessionId) {
      if (args && typeof args.voice === 'string' && args.voice.trim()) return args.voice.trim();
      return voiceForSession(sessionId) || '-';
    }

    /**
     * 上一次"该念却没念成"，要在下一次 `speak` 的回执里带回去。
     * 不这么做的话，模型永远以为每一句都念了（朋友现场就是这样：多轮无声、模型毫不知情）。
     * 超过 10 分钟的老账不再提，免得每轮都翻旧账。
     */
    function voiceFailureNote() {
      if (!lastVoiceFailure) return '';
      const at = Date.parse(lastVoiceFailure.at || '');
      if (Number.isFinite(at) && Date.now() - at > 10 * 60 * 1000) return '';
      const why = String(lastVoiceFailure.reason || '').replace(/^engine-timeout:\s*/, '');
      return `⚠ 上次有 ${lastVoiceFailure.count} 句没念成：${why}`;
    }

    async function speakOnce(input, sessionId, spec, turnHint, pieceMeta) {
      syncTone();
      const cleaned = capText(cleanForSpeech(input?.text), effectiveMaxChars());
      if (!cleaned) return { status: 'error', reason: '没有可念的文字', chars: 0 };

      const overrides = {};
      // 音色优先级：cast.json 逐段指定（多角色演出）> 会话记忆 > 全局默认。
      // 工具参数依旧不能覆盖（那个 bug 的教训）。
      if (spec && typeof spec === 'object') {
        overrides.voice = typeof spec.voice === 'string' ? spec.voice : voiceForSession(sessionId);
        if (spec.instructions) overrides.instructions = spec.instructions;
        if (Number.isFinite(spec.seed)) overrides.seed = Number(spec.seed);
      } else if (typeof spec === 'string' && spec.trim()) {
        overrides.voice = spec.trim();
      } else {
        // 多音色下没有指定说话人 → 主角色（旁白默认不参与日常汇报）
        const lead = cfg.multiVoice ? leadSpeaker() : null;
        overrides.voice = lead ? (lead.voice || '') : voiceForSession(sessionId);
        if (lead && lead.tone) overrides.instructions = lead.tone;
      }
      if (input?.instructions) overrides.instructions = input.instructions;
      if (input?.cfg_scale !== undefined && input?.cfg_scale !== null) overrides.cfg_scale = input.cfg_scale;
      /*
       * G0（0.96.0）：**一次性**风格参数。
       *
       * 只写进这一次的 `overrides`，绝不碰 `cfg` / `provider.style` / `state.json` ——
       * 下一次不传就回到面板上的全局风格（合并顺序 `overrides > style > cfg` 在 lib 的 `resolveParams()` 里）。
       * 所以没有"清理"这回事，也没有开关：传了就是这一次，不传就是默认。
       * 白名单与夹值走 `pickCallStyle()`（与面板的 `coerceStyle()` 同源）；这家认不认识由 `sanitizeForEngine()` 判。
       */
      const style = input?.style && typeof input.style === 'object' ? pickCallStyle(input.style) : null;
      if (style && Object.keys(style).length) {
        for (const [key, value] of Object.entries(style)) overrides[key] = value;
        note('speak:style', `keys=${Object.keys(style).join('+')} engine=${tts.engine.id} chars=${cleaned.length}`);
      }

      // （A2）：云端引擎不套本机那套探活/自启/安装引导 —— 直接开播，
      // 失败交给 `withEngineFallback` 与兜底链（`10` §6）。
      if (tts.engine.kind !== 'breeze') {
        return startStreaming(cleaned, overrides, sessionId, turnHint, pieceMeta);
      }

      if (await tts.healthy()) {
        return startStreaming(cleaned, overrides, sessionId, turnHint, pieceMeta);
      }

      if (!cfg.autoStartServer) {
        tts.lastError = `连不上 BreezeTTS（${cfg.baseUrl}），先按配置里的 startScript 启动 BreezeTTS（安装引导会写入）`;
        return { status: 'error', reason: tts.lastError, chars: cleaned.length };
      }

      // 本机根本没装（startScript 不存在）→ 不要傻等 90 秒，直接让模型去走安装引导
      const inst = await installState();
      if (inst.state === 'missing') {
        return {
          status: 'error',
          chars: cleaned.length,
          reason: 'engine-missing: 本机没装 BreezeTTS2。先问用户要不要安装，再按 tts_probe → 选档 → 确认用途 → 问路径 → tts_install 的顺序走。',
        };
      }

      // 端点没开：排进队列 + 后台拉起，立刻返回，不卡回合
      if (!pendingLines.some((item) => item.cleaned === cleaned)) {
        pendingLines.push({ cleaned, overrides, sessionId, turnHint });
      }
      kickServer();
      note('speak:waiting', `chars=${cleaned.length} pending=${pendingLines.length}`);
      return {
        status: 'starting',
        chars: cleaned.length,
        reason: 'BreezeTTS 正在启动，起来后会自动补念这一句',
      };
    }

    /** 追加一行诊断日志（best-effort，失败不影响主流程）。 */
    function note(kind, detail) {
      try {
        const line = `${new Date().toISOString()} ${kind} ${detail ?? ''}\n`;
        void appendFile(join(dataDir(), 'events.log'), line, 'utf8').catch(() => {});
      } catch { /* ignore */ }
    }

    /* ───────── ：出厂音色预设 + 自动入库 ───────── */

    /**
     * 两把出厂音色。描述与种子是**用户逐条听过定稿**的，改动等于换嗓子。
     * 它们会由 `ensurePresetVoice()` 就地生成参考音频并存进引擎音色库，名字就是 girl / boy——
     * 这样新装用户第一句话就不是"现场随机合成"的声音，下拉里也有实打实的选项。
     */
    const PRESET_VOICES = {
      girl: {
        label: 'girl · 少女',
        seed: 349,
        tone: '一位十六七岁的少女，声音清亮偏软，音色干净，带一点点害羞和拘谨，语速自然，不冷淡、不撒娇、不要太小声。',
      },
      boy: {
        label: 'boy · 学长',
        seed: 673,
        tone: '一位二十出头到二十五岁的成年男性，声音清朗偏沉，音色干净，语速平稳不紧不慢，语气冷静克制，说话有分寸，像靠得住的学长，尾音收得干净，不热情、不轻浮。',
      },
    };
    /** 存音色时用的参考台词：5~10 秒、单人、逐字稿就是这个字符串本身。 */
    const PRESET_REF_TEXT = '你好，我是这里的语音助手，平时就这样陪你说话。你想让我说得轻一点，或者快一点，都可以直接告诉我。';

    /**
     * 修 WAV 头。引擎的流式输出把 `data` 长度写成 `0xFFFFFFFF`（chunked，长度未知），
     * 原样当参考音频喂回去会让编码器按这个长度读、越界把进程读崩。
     * 这里按真实字节数重写 RIFF 与 data 两处长度，其余字节原样保留。
     */
    function repairWavHeader(buf) {
      if (!Buffer.isBuffer(buf) || buf.length < 44) return buf;
      if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return buf;
      let pos = 12;
      let dataStart = -1;
      let fmt = null;
      while (pos + 8 <= buf.length) {
        const id = buf.toString('ascii', pos, pos + 4);
        const len = buf.readUInt32LE(pos + 4);
        if (id === 'fmt ') {
          // fmt 块体：format(2) channels(2) rate(4) byteRate(4) blockAlign(2) bits(2)
          fmt = { channels: buf.readUInt16LE(pos + 10) || 1, rate: buf.readUInt32LE(pos + 12) || 24000 };
        }
        if (id === 'data') { dataStart = pos + 8; break; }
        pos += 8 + len + (len % 2);
      }
      if (dataStart < 0 || !fmt) return buf;
      const pcm = buf.subarray(dataStart);
      const head = Buffer.alloc(44);
      head.write('RIFF', 0, 'ascii');
      head.writeUInt32LE(36 + pcm.length, 4);
      head.write('WAVE', 8, 'ascii');
      head.write('fmt ', 12, 'ascii');
      head.writeUInt32LE(16, 16);
      head.writeUInt16LE(1, 20);                 // PCM
      head.writeUInt16LE(fmt.channels, 22);
      head.writeUInt32LE(fmt.rate, 24);
      head.writeUInt32LE(fmt.rate * 2 * fmt.channels, 28);
      head.writeUInt16LE(2 * fmt.channels, 32);
      head.writeUInt16LE(16, 34);
      head.write('data', 36, 'ascii');
      head.writeUInt32LE(pcm.length, 40);
      return Buffer.concat([head, pcm]);
    }

    /** 引擎声音库里现有哪些 id（只看已保存的）。 */
    async function savedVoiceIds() {
      try {
        const items = await listVoices();
        return new Set(items.map((item) => String(item && item.id ? item.id : '')));
      } catch { return new Set(); }
    }

    /**
     * 把一个"设计音色"存进引擎音色库：合成参考音频 → 修 WAV 头 → POST /v1/voices → 校验 saved。
     * 这是"设计音色"流程的最后一步，出厂预设与用户自选音色都走它。
     */
    async function saveVoiceToLibrary({ name, tone, seed, text }) {
      const id = String(name || '').trim();
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Error('音色名只能用字母 / 数字 / - / _（1~32 位）');
      const refText = String(text || '').trim() || PRESET_REF_TEXT;
      const art = await breezeTts().enqueue(() => breezeTts().synthesize(refText, {
        voice: '',
        instructions: String(tone || '').trim(),
        seed: Number.isFinite(Number(seed)) ? Number(seed) : null,
        cfg_scale: 4,
      }));
      const raw = await readFile(art.file);
      const fixed = repairWavHeader(raw);
      const form = new FormData();
      form.append('name', id);
      form.append('ref_audio', new Blob([fixed], { type: 'audio/wav' }), `${id}.wav`);
      form.append('ref_text', refText);
      form.append('description', `voice-breeze preset (seed=${Number.isFinite(Number(seed)) ? Number(seed) : '-'})`);
      const res = await fetch(new URL('/v1/voices', cfg.baseUrl), { method: 'POST', body: form });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body || !body.id) throw new Error(`入库失败 HTTP ${res.status} ${(body && body.error) || ''}`.trim());
      note('voice:save', `id=${body.id} seconds=${body.seconds ?? '-'} saved=${body.saved} chars=${refText.length}`);
      return { id: String(body.id), seconds: Number(body.seconds) || 0, saved: body.saved !== false };
    }

    /** 确保某个出厂预设已在库中；已存在就直接用，不重复入库。返回 {preset, voice, imported}。 */
    async function ensurePresetVoice(key) {
      const name = String(key || '').trim().toLowerCase();
      const preset = PRESET_VOICES[name];
      if (!preset) throw new Error(`没有这个出厂预设：${key}（可选 ${Object.keys(PRESET_VOICES).join(' / ')}）`);
      if (!(await breezeTts().healthy())) {
        await breezeTts().ensureServer?.().catch(() => {});
      }
      const have = await savedVoiceIds();
      let imported = false;
      if (!have.has(name)) {
        await saveVoiceToLibrary({ name, tone: preset.tone, seed: preset.seed });
        imported = true;
      }
      return { preset: name, voice: name, imported, label: preset.label };
    }


    /**
     * 按当前「播报强度」给 verbalize 定档（规则驱动，不额外调用模型）。
     * 强度取代了  的"按步数自动分档"：用户一个旋钮决定念多长、想多细，两套规则不再打架。
     */
    /**
     * （方案 A）：AI 即兴下抽查"角色台词有没有被改写"。
     * 提示词已经要求台词一字不差，这里只做**事后校验** 把正文里 `角色名：…` 的台词抽出来，
     * 归一化（去标点空白）后在即兴稿里找；找不到就记一条 `adapted:line-missed`。
     * 只记日志，不改播放、不重试。
     */
    function verifyAdaptedLines(body, segments) {
      try {
        const names = readCast().map((item) => item.name).filter((name) => name && name !== '旁白');
        if (!names.length) return; // 没有音色表就认不出"谁在说话"，跳过
        const squash = (text) => String(text || '').replace(/[\s，。！？；：、,.!?;:"'“”‘’「」『』()…—\-]/g, '');
        const flat = squash(segments.map((seg) => String(seg?.text || '')).join('\n'));
        const missed = [];
        let total = 0;
        for (const raw of String(body || '').split(/\n+/)) {
          const match = raw.trim().match(/^([^\s：:]{1,20}?)((?:[（(][^）)]*[）)])*)\s*[：:]\s*(.+)$/);
          if (!match) continue;
          const name = match[1].trim().replace(/[（(].*$/, '').trim();
          if (!name || name === '旁白' || !names.includes(name)) continue;
          const line = squash(match[3]);
          if (line.length < 4) continue;
          total += 1;
          if (!flat.includes(line)) missed.push(`${name}:${String(match[3]).trim().slice(0, 20)}`);
        }
        if (missed.length) {
          note('adapted:line-missed', `n=${missed.length}/${total} sample=${JSON.stringify(missed.slice(0, 3))}`);
        }
      } catch { /* 校验失败不影响播报 */ }
    }

    function verbalBudget(state) {
      // 角色扮演（AI 即兴）：现在强度重新生效，但只作用于"旁白能省多少 / 台词能否精简"（见 ROLEPLAY_STRENGTHS）
      if (cfg.fallback === 'roleplay') {
        // 预算按正文长度自适应：长正文 2048 会被 reasoning 吃光（实测 reasoningDeltas=842）
        const replyLen = String(state.text || '').length;
        const adaptive = Math.min(8192, Math.max(ROLEPLAY_BUDGET.maxTokens, 1024 + Math.ceil(replyLen / 1.5)));
        const plan = ROLEPLAY_STRENGTHS[cfg.strength] || ROLEPLAY_STRENGTHS.medium;
        return {
          maxTokens: adaptive,
          target: plan.target,
          cap: ROLEPLAY_BUDGET.cap,
          hint: plan.hint,
          strength: cfg.strength,
          keepLines: plan.keepLines,
          trimNarration: plan.trimNarration,
        };
      }
      const preset = strengthPreset();
      return { maxTokens: preset.maxTokens, target: preset.target, cap: preset.cap, hint: preset.hint, strength: cfg.strength };
    }

    /**
     * authored 模式的第 ① 级：让模型把这一轮压成一句口语。
     * 输入是「用户这轮说的 + 我的答复」，不是只有答复（只看答复容易压成提纲）。
     * 失败/超时/空串返回 ''，由上层降级。
     */
    /**
     * authored / roleplay 的第 ① 级：让模型产出「一带情绪的段」（1~3 段）。
     * 短内容 1 段，长内容 2 段（P8 的"两句"），角色扮演最多 3 段（P10.5 的情绪弧线）。
     * 任何解析失败都退回 1 段纯文本，绝不因为格式问题没声音。
     */
    async function verbalize(state, options) {
      const opts = options || {};
      const summary = opts.summary === true; // 角色扮演"兜底总结"模式（按强度，不演剧情）
      const retry = opts.retry === true; // 第一次没产出时再来一次：输入更短、更明确
      const empty = { segments: [], budget: null };
      const llm = ctx.get('llm');
      if (!llm || !state.provider || !state.model) {
        note('verbalize:unavailable', `llm=${Boolean(llm)} provider=${state.provider || '-'} model=${state.model || '-'}`);
        return empty;
      }
      // q4：用户明确要求念全文时，不按强度档压缩，分段念完全部正文
      const fullRead = cfg.fallback !== 'roleplay' && wantsFullRead(state.userText);
      const slice = summary ? (retry ? 900 : 2400) : (cfg.fallback === 'roleplay' ? 6000 : fullRead ? FULL_READ_MAX_INPUT : 3000);
      const reply = String(state.text || '').slice(0, slice);
      if (!reply.trim()) return empty;
      const budget = summary
        ? { ...strengthPreset(), strength: cfg.strength }
        : (fullRead ? FULL_READ_BUDGET : verbalBudget(state));
      const persona = cfg.fallback === 'roleplay' ? personaBlock() : '';
      const cast = cfg.fallback === 'roleplay' ? readCast() : [];
      /*
       * 2026-11-18：**"兜底 / 即兴"这条路上也得执行段数上限**。
       *
       * 原来写的是 `cfg.fallback === 'roleplay' ? (persona ? Number.POSITIVE_INFINITY : 1) : …` ——
       * 那是  时代的老裁决（"角色扮演只要有角色卡就让模型自行分段"），
       * 而 Q21/Q25（/）早已把它改成"**强度决定段数与篇幅**"：弱 1 段 / 中 ≤3 段 / 强不限。
       * 代码没跟上，于是"角色扮演 + 弱强度"能播出整整九段。
       * 现在：**提示词按档位要段数**，事后再在 `decideLines()` 里按同一档位**合并兜底**
       * （合并语义见 `lib/tts.mjs` 的 `mergeSegmentsDown()` —— 两条路共用一个实现）。
       */
      const roleplan = cfg.fallback === 'roleplay' ? (ROLEPLAY_STRENGTHS[cfg.strength] || ROLEPLAY_STRENGTHS.medium) : null;
      const maxSegments = summary
        ? segmentPlan(state).count
        : (cfg.fallback === 'roleplay'
          ? (Number(roleplan?.maxSegments) > 0 ? Number(roleplan.maxSegments) : Number.POSITIVE_INFINITY)
          : (fullRead ? FULL_READ_MAX_SEGMENTS : segmentPlan(state).count));
      // 多音色只看界面开关。关掉时哪怕 cast.json 还有内容，也不许按角色分嗓子
      const multiVoice = Boolean(cfg.multiVoice) && cast.length > 0;
      const jsonRule = maxSegments > 1
        ? [
          '输出形式：**只输出 JSON**，不要代码块、不要解释，形如',
          multiVoice
            ? '{"segments":[{"speaker":"角色甲","voice":"你的音色id","tone":"这一段怎么说（情绪/语速）","text":"这一段要说的话"}]}'
            : '{"segments":[{"text":"第一段要说的话","tone":"这一段怎么说（情绪/语速，可留空）"},{"text":"第二段","tone":""}]}',
          multiVoice
            ? '每段都必须带 `speaker`（谁在说）与 `voice`（用哪个嗓音，只能取下面"角色音色表"里的 voice）；旁白、心声、回忆也各自成段并指定 speaker。'
            : '',
          Number.isFinite(maxSegments)
            ? (fullRead
              ? `最多 ${maxSegments} 段；每段 100~240 字，**按原文顺序把所有内容盖完**，段与段之间要能听出承接关系。`
              : `最多 ${maxSegments} 段；每段 40~120 字，段与段之间要能听出承接关系。`)
            : '段数不限：凡是要换说话人、换情绪、换场景、换节奏就另起一段，每段 40~240 字；不要为凑段而把一句话拆碎。',
        ].filter(Boolean)
        : ['只输出这段话本身，不要引号、不要解释、不要 JSON。'];
      const castLines = multiVoice
        ? ['角色音色表（语音演出必须严格使用这里的 voice）：',
          ...cast.map((item) => `- ${item.name} → voice=\"${item.voice}\"${item.tone ? `（${item.tone}）` : ''}`)].join('\n')
        : '';
      const system = (summary && cfg.fallback === 'roleplay')
        ? [
          '你在为用户做语音汇报，用的是当前角色扮演里的身份与口吻。',
          persona ? `角色设定：\n${persona}` : '还没有角色卡：就用普通口吻说清楚这一轮发生了什么。',
          castLines,
          multiVoice
            ? '音色表里有多个角色时，可以挑 2~3 个轮番把这一轮说清楚（像伙伴抢着汇报），旁白默认不参与；只有一个角色就一个人说完。'
            : '',
          `参考长度：${budget.target}；${budget.hint}`,
          '只讲这一轮：用户说了什么、你做了什么、结论是什么、接下来做什么。**不要重演剧情，也不要逐字复述正文**。',
          '状态栏、进度、好感度、代码、路径、表格一律不念。',
          ...jsonRule,
        ].filter(Boolean).join('\n')
        : cfg.fallback === 'roleplay'
        ? [
          '你在为用户做语音演出：用户只听到声音，看不到文字。',
          '**默认把这一轮的正文完整演出来** 剧情、对话、结论都不许省；状态栏、当前进度、好感度、表格、代码、路径这类只给眼睛看的东西不念。',
          budget.keepLines
            ? '**角色说的话一字不差** 正文里 `角色名：…` 后面的台词必须原样搬过来，不改写、不合并、不跳句；允许调整的只有旁白。'
            : '**角色说的话可以精简** 可以缩短句子、去掉口头重复，但关键意思、情绪、态度和转折必须留住，不许把一段话压成没有情绪的概述。',
          budget.trimNarration
            ? (budget.keepLines
              ? '旁白可以精简：去掉重复，把"她低下头"这类看不见的动作丢掉或换成能听见的声音；顺序不能乱，也不能因为省旁白把台词之间的因果丢掉。'
              : '旁白大幅精简：只留推动情节的那几句，其余压成一句过渡。')
            : '旁白也照念，不要省略（可以轻微口语化）。',
          '**段数不限（三档都一样）** 换说话人、换情绪、换场景就另起一段；不要为凑段把一句话拆碎。',
          persona ? `角色设定：\n${persona}` : '还没有角色卡：先说一句「现在是一个空白场景，开始前我有几个问题想先问你~」，再用一句话问角色信息（名字、性格、说话习惯或口癖、和用户的关系），不要自己编。',
          castLines,
          multiVoice
            ? '剧情里出现几个人就分几段：谁说话就标谁；旁白、环境音、心理活动也单独成段，旁白用音色表里指定的那个嗓音。'
            : '',
          multiVoice
            ? '如果这一轮不是剧情、而是问答或任务汇报，就改用「多角色陪伴」：挑 2~3 个角色轮番或抢着把结论说出来（一个刚说完，另一个像抢话一样补一句），语气按角色卡的性格来；**旁白默认不参与这种汇报**，除非用户要求，或场景里只有旁白 + 一个角色。'
            : '',
          `参考长度：${budget.target}；${budget.hint}`,
          '可以用语气词、省略号（……）表示停顿、破折号（——）表示话被打断。',
          '如果情绪有大转折，就拆成多段、每段在 tone 里写这一刻的情绪（例：平静叙述 / 声音发颤 / 强撑着收住）。',
          '需要时可以用声音标签让语气更真实，例如 [叹气]、(小声)、(哽咽)、(吸鼻子)；一次最多一个，只在情绪真的需要时才用，不要每句都加。',
          '不要写旁白式的动作描写（如"她低下头"），不要引号；代码、路径、表格一律不念。',
          '用户要求静场时，可以单独输出一段 `text` 为 `[停顿3秒]` 的段（会变成纯粹的静音气口）。',
          ...jsonRule,
        ].filter(Boolean).join('\n')
        : [
          fullRead
            ? '你是这台电脑的语音播报员。用户这轮**明确要求把完整正文念出来** 按原文顺序分段念完全部内容，让只听的人也能完整拿到信息。'
            : '你是这台电脑的语音播报员：把一轮对话压成一段能被听懂的播报。',
          `目标长度：${budget.target}；${budget.hint}`,
          fullRead
            ? '不许省略、不许总结、不许挑重点；**连过渡句、连接词（「顺带一提」「另外」「不过」这类）也照原样念出来**，不要跳句。\n唯一要跳过的是代码块、表格、命令、路径、报错堆栈——它们换一句「这段代码在正文里」「这里是一段命令，细节看正文」带过即可。'
            : '若用户这轮要求「念完正文／念全文／全念出来／把正文读完」，就改为分段念完全部正文（代码块换成「这段代码在正文里」），不省略、不总结。',
          '分段建议：结论、要点、下一步各自成段更耐听，段间会留气口；弱档只念一段，中档长汇报可分两段，强档可分三段。',
          '口语化，像跟熟人说话；不念代码、路径、文件名、表格、报错堆栈、链接。',
          // 只念「我的答复」：输入里还有「用户这轮说的是…」，模型以前会把那句也念出来
          '**只念「我的答复」这一段里的内容。** 用户说的话、以及「用户这轮说的是」「目标长度」这类说明行都不要念。',
          fullRead ? '' : '不复述整段，不寒暄，不写「好的」「没问题」这类开场。',
          ...jsonRule,
        ].filter(Boolean).join('\n');
      const userPart = retry ? '' : String(state.userText || '').slice(0, 600);
      const input = [
        userPart ? `用户这轮说的是：\n${userPart}` : '',
        `我的答复：\n${reply}`,
      ].filter(Boolean).join('\n\n');
      try {
        const isRoleplay = cfg.fallback === 'roleplay';
        // （P1）：**所有档位都不再传 maxTokens**。本机 deepseek-flash 的 reasoningEffort=max，
        // 推理块会把 192/384/768 的预算整个吃光（日志 reasoningDeltas=755/768、finish=max-tokens、textDeltas=0），
        // 结果 verbalize 返回空 → 退回首句。省略 maxTokens 交给 provider 默认（远大于推理消耗），
        // 我们只靠 cap 控制"消费多少"，不影响模型说完。
        const caps = await modelCaps(llm, state.provider, state.model);
        const budgetLabel = String(caps.maxTokens);
        const stream = llm.stream({
          provider: state.provider,
          model: state.model,
          system,
          messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
          temperature: 0.3,
          // 预算给模型允许的最大值，推理档固定 low。
          // 不传 maxTokens 虽然能跑通，但会把口子开太大；off 档会让提炼与语气变差。
          maxTokens: caps.maxTokens,
          ...(caps.effort ? { reasoningEffort: caps.effort } : {}),
          signal: AbortSignal.timeout(isRoleplay ? 120000 : fullRead ? 90000 : 60000),
        });
        let out = '';
        let textDeltas = 0;
        let reasoningDeltas = 0;
        let finish = '';
        let outTokens = 0;
        for await (const chunk of stream) {
          if (!chunk || typeof chunk !== 'object') continue;
          if (chunk.type === 'text-delta') {
            textDeltas += 1;
            out += chunk.text || '';
          } else if (chunk.type === 'reasoning-delta') {
            reasoningDeltas += 1;
          } else if (chunk.type === 'usage') {
            outTokens = chunk.usage?.outputTokens ?? chunk.usage?.totalTokens ?? outTokens;
          } else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && !out) {
            out += chunk.block.text || '';
          } else if (chunk.type === 'finish') {
            finish = chunk.reason?.kind || '';
            break;
          }
          // 截断只对"纯文本一段"的档位生效。JSON 多段档一旦在中间 break，
          // 拿到的是半截 JSON，parseSegments 会判成残骸直接丢弃——那才是真正的"没声音"来源。
          if (maxSegments <= 1 && out.length > budget.cap) break;
          if (out.length > 40000) break;
        }
        const segments = parseSegments(out, maxSegments);
        if (!segments.length) {
          note('verbalize:empty', `finish=${finish || '?'} textDeltas=${textDeltas} reasoningDeltas=${reasoningDeltas} budget=${budgetLabel}`);
          return empty;
        }
        note('verbalize:ok', `strength=${budget.strength} budget=${budgetLabel} outTokens=${outTokens} finish=${finish || '?'} segments=${segments.length} ${JSON.stringify(segments.map((s) => s.text)).slice(0, 200)}`);
        return { segments, budget };
      } catch (error) {
        note('verbalize:error', String((error && error.message) || error));
        return empty;
      }
    }

    /**
     * 段数策略（现在按强度分档，裁决）：
     * 弱→只一段；中→长汇报可分两段；强→长汇报可分三段（结论 / 要点 / 下一步）。
     * 段间气口交给客户端，宿主只决定"最多允许几段"。
     */
    function segmentPlan(state) {
      const len = String(state.text || '').length;
      const big = Number(state.steps || 0) >= 4 || len >= 120;
      const strength = cfg.strength;
      if (strength === 'strong') return { count: big ? 3 : 2 };
      if (strength === 'medium') return { count: big ? 2 : 1 };
      return { count: 1 };
    }

    /**
     * 判断用户这一轮是否**明确要求**「把完整正文念出来」（q4 裁决）。
     * 只认显式说法，且先排除否定式（"不用念全文"）；判错也不要紧——最差就是多念一点。
     */
    function wantsFullRead(text) {
      const s = String(text || '');
      if (!s) return false;
      // 否定式先排除："不用念完""别念全文"
      if (/(不要|不用|别|无需|没必要|甭)\s*(去)?\s*(念|读|播报|听)?\s*(完整|全部|全文|整段|整篇|念完)/.test(s)) return false;
      return (
        /(念|读|播报|听)[^。！？\n]{0,10}(完整|全部|全文|整段|整篇|整个正文|到底)/.test(s) ||
        // "念完" / "读完" / "播报完" —— 用户最常这么说， 漏的就是这个
        /(念|读|播报)完/.test(s) ||
        // "把正文念完" / "将全文读一遍"
        /(把|将)[^。！？\n]{0,8}(正文|全文|全部|整段|这篇)[^。！？\n]{0,6}(念|读|播报|听)/.test(s) ||
        /全念|念全文|从头到尾(念|读|播报)|完整的?念/.test(s)
      );
    }

    /**
     * 查这个模型的能力，决定播报用多少预算、多少推理（，裁决）：
     * - `maxTokens` 取模型声明上限（`defaultMaxTokens`），查不到就 8192——"拉高许多"而不是不传；
     * - 推理档**固定 low** max 会把预算烧在思考上（事故），off 又会让提炼和语气变差；
     *   模型没声明 low 时退到 minimal/medium，绝不主动选 off。
     */
    const capsCache = new Map();
    async function modelCaps(llm, provider, model) {
      const key = `${provider}/${model}`;
      if (capsCache.has(key)) return capsCache.get(key);
      // effort 默认留空：查不到声明就不传，避免退到不支持的档位被 provider 拒绝
      const caps = { maxTokens: 8192, effort: '' };
      try {
        const info = await llm.resolveModelInfo(provider, model);
        const declared = Number(info?.defaultMaxTokens);
        if (Number.isFinite(declared) && declared >= 512) caps.maxTokens = Math.min(declared, 16384);
        const efforts = Array.isArray(info?.reasoning?.efforts)
          ? info.reasoning.efforts.map((item) => String(item?.id || '')).filter(Boolean)
          : [];
        const byName = (want) => efforts.find((id) => id.toLowerCase() === want);
        const picked = byName('low') || byName('minimal') || byName('medium') || '';
        caps.effort = picked && !/^(off|none|disabled?)$/i.test(picked) ? picked : '';
      } catch (error) {
        caps.effort = '';
      }
      capsCache.set(key, caps);
      note('verbalize:caps', `${key} maxTokens=${caps.maxTokens} effort=${caps.effort || '-'}`);
      return caps;
    }

    /** 解析模型输出：优先 JSON 数组，失败则整段当一句。 */
    function parseSegments(raw, maxCount) {
      const text = String(raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      const tryJson = (source) => {
        try { return JSON.parse(source); } catch { return null; }
      };
      let parsed = tryJson(text);
      if (!parsed) {
        const start = Math.min(...[text.indexOf('['), text.indexOf('{')].filter((i) => i >= 0));
        const endBracket = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
        if (Number.isFinite(start) && endBracket > start) parsed = tryJson(text.slice(start, endBracket + 1));
      }
      let list = [];
      if (Array.isArray(parsed)) list = parsed;
      else if (parsed && Array.isArray(parsed.segments)) list = parsed.segments;
      const out = [];
      for (const item of list) {
        const line = typeof item === 'string' ? item : (item && (item.text || item.line));
        if (typeof line === 'string' && line.trim()) {
          out.push({
            text: line.trim().replace(/^["'“”「」]+|["'“”「」]+$/g, ''),
            tone: item && typeof item.tone === 'string' ? item.tone.trim() : '',
            voice: item && typeof item.voice === 'string' ? item.voice.trim() : '',
            speaker: item && typeof item.speaker === 'string' ? item.speaker.trim() : '',
          });
        }
        if (out.length >= maxCount) break;
      }
      if (out.length) return out;
      // JSON 残骸（被 max-tokens 截断）绝不能当正文念——那等于插件自己念代码
      if (/"(segments|speaker|voice|tone|text)"\s*:/.test(text) || /\\"/.test(text)) {
        note('verbalize:truncated', `len=${text.length}`);
        return [];
      }
      const plain = text.replace(/^\s*[[{]+|[\s\]}]+$/g, '').trim().replace(/^["'“”「」]+|["'“”「」]+$/g, '');
      return plain ? [{ text: plain, tone: '' }] : [];
    }

    /** 文本指纹：用来判断"这一段是不是已经念过了"。 */
    /**
     * 角色卡 / 音色表的**版本签名**。
     * 提示词在会话内不刷新（`06` 坑 18），所以用户用面板改了角色卡之后，模型手里的那份是旧的。
     * 这里在每轮开始 / 每次工具调用时比一次签名；变了就置 `cardDirty`，
     * 由 `tts_state` / `speak` / `tts_card` 的返回体把「卡改过了，先读一遍」举到模型面前。
     * 一直举到模型真的调了 `tts_card`（读过才清），避免"提示了但没人读"。
     */
    let cardSig = '';
    let cardDirty = false;
    function cardSignature() {
      try {
        const cards = characterCards().map((item) => `${item.name}\u0000${item.text}`).join('\u0001');
        return hashText([String(readPersona() || ''), JSON.stringify(readCast() || []), cards].join('\u0000'));
      } catch { return ''; }
    }
    function refreshCardDirty() {
      const sig = cardSignature();
      if (!sig) return cardDirty;
      if (!cardSig) { cardSig = sig; return cardDirty; }
      if (sig !== cardSig) {
        cardSig = sig;
        cardDirty = true;
        note('card:changed', '角色卡/音色表变了（下一次工具返回会提示模型重读）');
      }
      return cardDirty;
    }

    function hashText(text) {
      return createHash('sha1').update(String(text || '')).digest('hex').slice(0, 12);
    }

    /**
     * 照本念（script）：不调模型，纯正则把正文切成"段"。
     *
     * 规则 A：**只有带标记的行才念**——`旁白：…`、`角色名：…`、`角色名（情绪）：…`
     *         标记名必须是 cast 里登记的名字或"旁白"；
     *         状态栏 / 进度 / 好感度 这类不带标记或以未知名字开头的内容，一律不念。
     * 同 speaker 连续行合并；单段超过 240 字只在句末再切；段数不限。
     */
    function splitScript(text, cast) {
      const names = [...new Set(['旁白', ...cast.map((item) => item.name)])]
        .filter(Boolean)
        .sort((a, b) => b.length - a.length); // 最长优先，"高坂爱莉（心声）" 先于 "高坂爱莉"
      const segments = [];
      const skippedSamples = [];
      let skipped = 0;
      let lenientHits = 0;
      // **宽松模式**。全文念只认标记行，模型一旦裸写叙述，旁白就整段消失。
      // 这里把「明显是正文句子、又不像状态栏/表格/选项」的未标记行按旁白念——默认开（`lenientScript`）。
      const lenient = cfg.lenientScript !== false;
      const proseLike = (line) => {
        if (!lenient) return false;
        if (line.length < 6) return false;
        if (/^[|#>`*+\-]/.test(line)) return false;              // 表格 / 标题 / 引用 / 列表
        if (/^[0-9]+\s*[.)、]/.test(line)) return false;           // 编号行（含每回合那 4 个选项）
        if (/^(状态|当前|进度|好感|时间|地点|轮次|HP|MP)[：:]/i.test(line)) return false;
        return /[。！？…」]/.test(line) || line.length >= 12;       // 像句子才收
      };
      const add = (speakerName, tone, body) => {
        const text = String(body || '').trim();
        if (!text) return;
        const last = segments[segments.length - 1];
        if (last && last.speaker === speakerName) {
          // 合并时把每一行的语气都留着（以前只留最后一行，前面写的语气全丢）
          last.text = `${last.text}\n${text}`.trim();
          if (tone && !last.tones.includes(tone)) last.tones.push(tone);
          last.tone = last.tones.join('；');
        } else {
          segments.push({ speaker: speakerName, tone, tones: tone ? [tone] : [], text });
        }
      };
      for (const rawLine of String(text || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        // ① 先按冒号切：冒号前的内容整体取出，**不限长度**（以前限 14 字，带语气括号的行全被丢掉）
        const match = line.match(/^([^：:\n]{1,80}?)\s*[：:]\s*([\s\S]*)$/);
        if (!match) {
          if (proseLike(line)) {
            lenientHits += 1;
            add('旁白', '', line);
            continue;
          }
          skipped += 1;
          if (skippedSamples.length < 3) skippedSamples.push(line.slice(0, 40));
          continue;
        }
        const head = match[1].trim();
        const body = match[2];
        // ② 用"能对上的最长 cast 名字"当 speaker，剩下的括号内容全是这一段/这一行的语气
        const speakerName = names.find((name) => head === name || head.startsWith(name));
        if (!speakerName) {
          // 有冒号但对不上 cast：宽松模式下整行当旁白（"雨还在下：屋檐在滴水" 这种），否则记跳过
          if (proseLike(line)) {
            lenientHits += 1;
            add('旁白', '', line);
            continue;
          }
          skipped += 1;
          if (skippedSamples.length < 3) skippedSamples.push(line.slice(0, 40));
          continue;
        }
        let rest = head.slice(speakerName.length).trim();
        const tones = [];
        for (;;) {
          const paren = rest.match(/^[（(]([^）)]*)[）)]\s*/);
          if (!paren) break;
          if (paren[1].trim()) tones.push(paren[1].trim());
          rest = rest.slice(paren[0].length);
        }
        add(speakerName, tones.join('；'), body);
      }
      if (lenientHits) note('script:lenient', `作为旁白念的未标记行=${lenientHits}`);
      if (skipped) {
        note('script:skipped', `n=${skipped} sample=${JSON.stringify(skippedSamples)}`);
      }
      const out = [];
      for (const segment of segments) {
        if (segment.text.length <= 240) { out.push(segment); continue; }
        let buffer = '';
        for (const piece of segment.text.split(/(?<=[。！？；!?;])/)) {
          if ((buffer + piece).length > 240 && buffer) {
            out.push({ ...segment, text: buffer.trim() });
            buffer = piece;
          } else {
            buffer += piece;
          }
        }
        if (buffer.trim()) out.push({ ...segment, text: buffer.trim() });
      }
      return out.filter((segment) => segment.text.trim()).map((segment) => ({
        speaker: segment.speaker,
        voice: '',
        instructions: segment.tone || '',
        text: segment.text,
      }));
    }

    /**
     * 全文模式专用的「剥说话人标记」：**只认真名字**（「旁白」或 cast 里的条目），
     * 别像 `cleanForSpeech()` 那样"≤14 字加冒号就当人名"——那样会把
     * 「声音侧有一件事必须先知道：…」这类正常句子连前半截一起吞掉。
     */
    function stripCastMarker(line) {
      // 名字段**不能吃掉括号** `角色乙（心声）：` 要让名字落成「角色乙」、括号落进第二组，
      // 否则名字会变成「角色乙（心声）」而对不上 cast（自检抓到的第一版 bug）
      const m = /^\s*([^\s：:（(]{1,14})([（(][^）)]{1,12}[）)])?\s*[：:]\s*/.exec(line);
      if (!m) return line;
      const name = m[1];
      const full = name + (m[2] || '');
      const rest = line.slice(m[0].length);
      if (name === '旁白' || full === '旁白') return rest;
      const cast = readCast();
      if (cast.some((item) => item && (item.name === full || item.name === name))) return rest;
      return line;
    }

    /**
     * 「全文」模式的分段器（修订）：把正文切成能直接念的段，**一字不改、不调模型**。
     *  - 代码块（``` 围栏）→ 换成一句「整段代码在正文中。」，内容不念；
     *  - 表格（连续以 `|` 开头的行）→ 换成一句「详细表格在正文中。」，内容不念；
     *  - 行首「旁白：」「角色乙（心声）：」→ 只剥**真名字**（见 stripCastMarker），不动普通冒号句；
     *  - 每行按 。！？；!?; 断句，再按 cap（默认 240 字）合并成段；单句超长才在逗号/空格处切；
     *  - **段数不限**、绝不因为"太长"丢内容。
     */
    /**
     * 强度承诺的**段数下限**（角色扮演 + AI 即兴，强档 = 至少两段）。
     * 产出比要求的少、内容又够切，就按句末标点把这段话拆开念——**不改写、不增删一个字**，
     * 只是把同一段拆成两段（听感上多一个气口、更接近"长语音"）。拆不动就原样返回。
     */
    function enforceMinSegments(segments, want, cap) {
      const list = (Array.isArray(segments) ? segments : []).filter((seg) => seg && String(seg.text || '').trim());
      if (!Number.isFinite(want) || want <= 1 || !list.length || list.length >= want) return segments;
      const limit = Math.max(80, Number(cap) || 300);
      const text = list.map((seg) => String(seg.text || '').trim()).join('');
      if (text.length < want * 60) return segments; // 内容太短，硬拆只会碎成口头禅
      // 先按句末标点切；没有标点就按逗号/空格/硬位置切
      const sentences = text.split(/(?<=[。！？；!?;])/).map((s) => s.trim()).filter(Boolean);
      if (!sentences.length) return segments;
      const pieces = [];
      let buf = '';
      const flush = () => { if (buf.trim()) { pieces.push(buf.trim()); buf = ''; } };
      for (const sentence of sentences) {
        if (buf && buf.length + sentence.length > limit) flush();
        buf += sentence;
        if (buf.length >= limit) flush();
      }
      flush();
      if (pieces.length < want) {
        // 句子太少（比如整段只有一句）：在目标段数上均分硬切，仍然不改字
        const target = Math.min(want, Math.max(1, Math.ceil(text.length / limit)));
        const size = Math.ceil(text.length / target);
        pieces.length = 0;
        for (let i = 0; i < text.length; i += size) pieces.push(text.slice(i, i + size));
      }
      if (pieces.length < want) return segments;
      const head = list[0];
      return pieces.map((piece, index) => ({
        ...head,
        // 除首段外不继承 speaker，避免把后半句硬派给某个角色
        speaker: index === 0 ? (head.speaker || '') : '',
        text: piece,
      }));
    }

    function splitPlainText(raw, cap) {
      const limit = Math.max(40, Number(cap) || 240);
      const lines = [];
      let inFence = false;
      let inTable = false;
      for (const line of String(raw || '').split(/\r?\n/)) {
        if (/^\s*(?:```|~~~)/.test(line)) {
          if (!inFence) lines.push(CODE_CUE);   // 只有开场那次补一句提示
          inFence = !inFence;
          inTable = false;
          continue;
        }
        if (inFence) continue;
        if (/^\s*\|/.test(line)) {
          if (!inTable) lines.push(TABLE_CUE);  // 一张表只提示一次
          inTable = true;
          continue;
        }
        inTable = false;
        if (!line.trim()) continue;
        const cleaned = cleanForSpeech(stripCastMarker(line), { stripMarkers: false });
        // 小节标题（`## 结论` 被剥成「结论」）这类行没有句末标点，
        // 直接拼下一行会粘成「结论改好了」——补一个句号，保证每行能独立成句
        if (cleaned) lines.push(/[。！？；…!?;，、：:）)】」"”’]$/.test(cleaned) ? cleaned : `${cleaned}。`);
      }
      const sentences = [];
      for (const line of lines) {
        for (const piece of line.split(/(?<=[。！？；!?;])/)) {
          const seg = piece.trim();
          if (!seg) continue;
          if (seg.length <= limit) { sentences.push(seg); continue; }
          let rest = seg;
          while (rest.length > limit) {
            const head = rest.slice(0, limit);
            const cut = Math.max(
              head.lastIndexOf('，'), head.lastIndexOf('、'), head.lastIndexOf('：'), head.lastIndexOf(' '),
            );
            const at = cut > limit * 0.5 ? cut + 1 : limit;      // 找不到好位置就硬切，保证不丢内容
            sentences.push(rest.slice(0, at).trim());
            rest = rest.slice(at).trim();
          }
          if (rest) sentences.push(rest);
        }
      }
      const out = [];
      let buf = '';
      for (const seg of sentences) {
        if (!buf) { buf = seg; continue; }
        if (buf.length + seg.length <= limit) { buf += seg; continue; }
        out.push(buf);
        buf = seg;
      }
      if (buf) out.push(buf);
      return out;
    }

    /** 按当前播报模式决定这一轮说什么；永远返回非空数组（最后一道是固定短语）。 */
    async function decideLines(state) {
      const sentence = capText(firstSpeakableSentence(state.text), effectiveMaxChars());
      const summary = capText(buildSummaryLine({ steps: state.steps, sentence }), effectiveMaxChars());
      const fixed = cfg.fixedText || '这轮跑完了，细节在正文。';
      const mode = cfg.fallback;

      // 角色扮演 + 照本念：不调模型，直接按标记切正文
      if (mode === 'roleplay' && cfg.narrationMode === 'script') {
        const body = String(state.text || '');
        if (/[：:]/.test(body)) {
          const spoken = state.spokenIds || new Set();
          const lines = splitScript(body, readCast()).filter((line) => !spoken.has(hashText(line.text)));
          if (lines.length) return lines;
          note('script:empty', `textLen=${body.length} 没有可识别的说话人标记`);
        } else {
          note('script:no-marker', `textLen=${body.length} 整轮没有冒号`);
        }
        // C 优先：这一轮模型自己调过 speak（普通问答）→ 不再补念，避免重复
        if (state.spoke) return [];
        // B 兜底：整轮零标记 → 落到下面的 roleplay 分支走 verbalize（即兴），免得"问个普通问题却一点声音都没有"
        note('script:fallback-narration', '正文没有可念的标记行，改用 AI 即兴播一次');
      }

      if (mode === 'authored' || mode === 'roleplay') {
        const toLines = (segments) => segments.map((seg) => ({
          text: capText(cleanForSpeech(seg.text), effectiveMaxChars()) || seg.text,
          instructions: seg.tone || '',
          voice: seg.voice || '',
          speaker: seg.speaker || '',
        }));
        const isRoleplay = mode === 'roleplay';
        // 角色扮演 + 照本念、且正文里没有可念的标记 → 直接走"总结"，不要先演一遍
        const firstPass = isRoleplay && cfg.narrationMode === 'script' ? { summary: true } : {};
        const first = await verbalize(state, firstPass);
        if (first.segments.length) {
          // （方案 A）：即兴稿出来后抽查台词完整性；只记日志，不改变播放
          if (isRoleplay && cfg.narrationMode === 'adapted') {
            verifyAdaptedLines(state.text, first.segments);
            // 强度承诺的**段数下限**（强 = 至少两段）。不够就按句末标点确定性补切，
            // 不改写、不增删内容——只把同一段话拆成两段念。
            const want = ROLEPLAY_STRENGTHS[cfg.strength]?.minSegments || 1;
            const boosted = enforceMinSegments(first.segments, want, effectiveMaxChars());
            if (boosted !== first.segments) {
              note('adapted:min-segments', `strength=${cfg.strength} from=${first.segments.length} to=${boosted.length}`);
            }
            /*
             * 2026-11-18：**段数上限的事后兜底**。
             *
             * 提示词已经按档位要了段数（弱 1 / 中 ≤3 / 强不限），但模型不一定听 ——
             * 实测那一轮它给了 9 段。这里按同一档位合并（合并**不丢字**，只改"谁单独成段"），
             * 与 `speak` 工具那条路用同一个 `mergeSegmentsDown()`。
             * 顺序不能反：先补下限（强档拆成 ≥2 段）再压上限，否则强档会被压回一段。
             */
            const cap = Number(ROLEPLAY_STRENGTHS[cfg.strength]?.maxSegments) || 0;
            const capped = mergeSegmentsDown(boosted, cap);
            if (capped !== boosted) {
              note('adapted:merged-segments', `strength=${cfg.strength} from=${boosted.length} to=${capped.length} max=${cap} chars=${capped.reduce((n, one) => n + String(one.text || '').length, 0)}`);
            }
            return toLines(capped);
          }
          return toLines(first.segments);
        }

        // 角色扮演的所有兜底都改成：按当前强度做一次"本轮总结"，绝不直接念固定短语
        if (isRoleplay) {
          const scripted = splitScript(state.text, readCast());
          if (scripted.length) {
            note('speech:fallback-script', `segments=${scripted.length}`);
            return scripted;
          }
          const second = await verbalize(state, { summary: true, retry: true });
          if (second.segments.length) {
            note('speech:fallback-summary', `segments=${second.segments.length} strength=${cfg.strength}`);
            return toLines(second.segments);
          }
          note('speech:fallback-fixed', '总结也失败，才退回固定短语');
          return [{ text: fixed, instructions: '' }];
        }
        note('speech:fallback-sentence', `复述没产出文字（finish/预算），退回首句 ${sentence.length} 字`);
        return [{ text: sentence || fixed, instructions: '' }];
      }
      // 全文：不调模型、不认标记，把正文按句切段逐字念完（代码块/表格/链接由 cleanForSpeech 剥掉）。
      // 该档**无视** state.spoke：模式优先，模型就算调了 speak 也照样通读。
      if (mode === 'full') {
        const pieces = splitPlainText(state.text, effectiveMaxChars());
        if (pieces.length) {
          note('full:read', `segments=${pieces.length} chars=${pieces.reduce((n, x) => n + x.length, 0)}`);
          return pieces.map((text) => ({ text, instructions: '' }));
        }
        note('full:empty', `textLen=${String(state.text || '').length} 正文没有可念的内容`);
        return [{ text: fixed, instructions: '' }];
      }
      // auto（界面显示「摘要」）：长回合走概览、短回合走首句（现在「首句」不再单独占一档）
      const bigTurn = state.steps >= 4 || String(state.text || '').length >= 400;
      if (!state.text) return [{ text: fixed, instructions: '' }];
      return [{ text: bigTurn ? (summary || fixed) : (sentence || fixed), instructions: '' }];
    }

    /**
     * 模型这一轮没自己开口时，按播报模式补一句。
     * 刻意不阻塞回合：合成与播放全部后台进行，turn/end 立即返回。
     */
    function scheduleSpeech(sessionId, state, from) {
      if (state.scheduled) return;
      if (!cfg.enabled) {
        note('skip:disabled', `from=${from}`);
        return;
      }
      if (state.spoke) {
        // （裁决）：**全文模式不看 spoke**——那一档的契约是"插件把正文从头念一遍"，
        // 只有这一档会走到 decideLines 的 full 分支（其它档的兜底仍然是"模型说过就别补"）。
        // 模型正常不该在这档调 speak；万一调了，speak 那边已经拦下不合成（日志 `speak:skip-full`），
        // 这里的例外只是让契约在代码里真的成立，不再依赖调用顺序。
        if (cfg.fallback !== 'full') {
          note('skip:spoke', `from=${from} session=${sessionId}`);
          return;
        }
      }
      if (state.aborted) {
        note('skip:aborted', `from=${from} session=${sessionId}`);
        return;
      }
      state.scheduled = true;
      void (async () => {
        try {
          const lines = await decideLines(state);
          const who = lines.map((l) => `${l.speaker || '-'}:${l.voice || 'session'}`).join(',');
          note('speech', `from=${from} mode=${cfg.fallback} narration=${cfg.narrationMode} strength=${cfg.strength} steps=${state.steps} textLen=${String(state.text || '').length} segments=${lines.length} who=${who.slice(0, 600)}`);
          // 一次性把所有段都发进合成队列（彼此串行），**不在宿主侧等气口** 
          // 气口交给客户端（segmentGapMs）。这样第二段的合成在上一段播放期间就开始，
          // 不会被"上一段播完 + 气口"再串上"整段合成时间"叠成一大段空白。
          for (const line of lines) {
            if (!line || !line.text) continue;
            if (!state.scheduled) return;
            try {
              const spec = await resolveSegmentVoice(line, sessionId);
              // 记下"这一段最终用了谁的嗓子"：script 段本身不带 voice，解析发生在这一步
              note('segment', `who=${line.speaker || '-'} voice=${spec.voice || '设计模式'} seed=${spec.seed ?? '-'} tone=${JSON.stringify((spec.instructions || '').slice(0, 40))} chars=${line.text.length}`);
              // 兜底（照本念 / AI 即兴 / 摘要）都在 turn/end 之后异步跑，必须显式把本轮 turn 带进账目
              await enqueueLine(line.text, sessionId, spec, { instructions: line.instructions || undefined, turn: state.turn });
              markSpoken(sessionId, line.text);
            } catch (error) {
              note('speech:segment-error', String((error && error.message) || error));
            }
          }
        } catch (error) {
          note('speech:error', String((error && error.message) || error));
          ctx.logger?.warn?.(`${TAG} 兜底播报失败: ${(error && error.message) || error}`);
        }
      })();
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    /** 记下"这一段已经念过了"，供照本念通道去重（这样顺手调一次 speak 不会让整轮静音）。 */
    function markSpoken(sessionId, text) {
      const state = sessionId ? turnState.get(sessionId) : undefined;
      if (!state) return;
      if (!(state.spokenIds instanceof Set)) state.spokenIds = new Set();
      state.spokenIds.add(hashText(text));
    }

    /** 从消息里抠出纯文字（content 数组 / blocks / text 三种形态都兼容）。 */
    function blockText(message) {
      const content = message?.content ?? message?.blocks;
      if (Array.isArray(content)) {
        return content.filter((block) => block?.type === 'text').map((block) => block.text || '').join('\n');
      }
      return String(message?.text ?? '');
    }

    /**
     * 同一事件的**重复投递**去重。
     *
     * 病象：`events.log` 里**每一行都写两遍**（同毫秒、同内容），而 `speech` / `turn-stopping` 那几行是单份。
     * 真因不是写日志的函数被调了两次，而是**同一个 handler 被注册在两个作用域上** 
     * `ctx.on('session/event', …)`（root）+ `agent.ctx.on('session/event', …)`（每个 agent 一条，第三路兜底）——
     * 两路都投递，于是 `onSessionEvent()` 里的每个 `note()` 都写两次。`speech` 只写一份纯属侥幸：
     * `scheduleSpeech()` 自带 `scheduled` 去重，第二次直接 return，没走到 `note()`。
     *
     * 修法**不删任何一路**（第三路是"scoped 派发才可达"的保底，删了可能在别的 DSH 版本上整条哑掉），
     * 而是让 handler 幂等，两个互补判据：
     *  ① **按事件对象身份**（`WeakSet`）—— 两路投递的若是同一个对象，第二次直接返回；
     *  ② **按时间** agent 那一路只在"root 刚刚没处理过"时才干活（50 ms 闸门）。
     *     这一条是为①不成立（两路各自造了新对象）准备的，同时**保住第三路的原意** 
     *     root 整条不投递时 `lastRootEventAt` 一直是 0，agent 那一路照常工作。
     */
    const seenEventObjects = new WeakSet();
    let lastRootEventAt = 0;
    let dupSkipped = 0;
    function alreadyHandled(event, via) {
      const bump = (detail) => {
        dupSkipped += 1;
        if (dupSkipped <= 2 || dupSkipped % 50 === 0) note('session/event:dup', `${detail} skipped=${dupSkipped}`);
      };
      if (event && typeof event === 'object' && seenEventObjects.has(event)) {
        bump(`via=${via}`);
        return true;
      }
      if (via === 'agent' && lastRootEventAt && Date.now() - lastRootEventAt <= 50) {
        bump('via=agent root-won');
        return true;
      }
      if (event && typeof event === 'object') seenEventObjects.add(event);
      if (via === 'root') lastRootEventAt = Date.now();
      return false;
    }

    /** 逐会话跟踪回合状态：谁说过、最后一条正文、走了几步。 */
    function onSessionEvent(session, event, via = 'root') {
      try {
        const sessionId = session?.id ? String(session.id) : '';
        if (!sessionId || !event) return;
        if (alreadyHandled(event, via)) return;
        const type = event.type;
        if (type === 'turn/start') {
          const fresh = {
            turn: event.data?.turn ?? 0,
            spoke: false,
            steps: 0,
            text: '',
            userText: '',
            aborted: false,
            scheduled: false,
            provider: '',
            model: '',
            spokenIds: new Set(),
          };
          // 回合一开始就把 provider/model 记下来：verbalize 走 turn-stopping 时要立刻能用，
          // 不能等到 turn/end 才填（那时话已经说完了）。
          pickModel(session, fresh);
          turnState.set(sessionId, fresh);
          note('turn/start', `session=${sessionId} turn=${event.data?.turn ?? '?'} model=${fresh.model || '-'}`);
          refreshCardDirty();
          return;
        }
        // DSH 弹选项 / 审批时念一句提醒——**改走会话事件流**。
        // 为什么不用 `user-questions/request` / `approval/request`：那是 waterfall，
        // answerer（客户端桥）先拿到请求就不会调 next()，排在它后面的监听者永远不执行
        // （cordis 源码注释："a listener that does not call next() vetoes the rest of the chain"）。
        // 实测两条 remind:attach 都在、remind:enter 一条都没有，就是这个原因。
        // `tool/call` 与 `approval/asked` 是普通会话事件，每轮都会送到。
        if (type === 'tool/call') {
          maybeRemindToolCall(sessionId, event.data);
          return;
        }
        if (type === 'approval/asked') {
          maybeRemindApprovalEvent(sessionId, event.data);
          return;
        }
        // 惰性建状态：即使 turn/start 没送到，只要收到正文也不至于整条链路失效
        let state = turnState.get(sessionId);
        if (!state) {
          if (type !== 'assistant/message') {
            note('skip:no-state', `session=${sessionId} type=${type}`);
            return;
          }
          state = { turn: event.data?.turn ?? 0, spoke: false, steps: 0, text: '', userText: '', aborted: false, scheduled: false, provider: '', model: '', spokenIds: new Set() };
          pickModel(session, state);
          turnState.set(sessionId, state);
          note('state:lazy', `session=${sessionId} type=${type}`);
        }
        if (type === 'user/message') {
          // 注意：session/event 里 'user/message' 的 data **本身就是 UserMessage**（不是 {message}），
          // ~ 按 {message} 取，所以一直是 textLen=0，喂给 verbalize 的用户原话始终为空。
          const userText = (blockText(event.data) || String(event.data?.text || '')).trim();
          // （P3）：只认本回合**第一条**真人消息。宿主会在同一回合里再塞进来若干条
          // user 角色的注入文本（文件变更提醒、技能目录更新等），以前是"后到覆盖先到"，
          // 结果用户真正说的那句（含「念完正文」这类指令）会被顶掉。
          const injected = !userText || /system-reminder|Additional instructions from|The available skill catalog changed/.test(userText.slice(0, 300));
          if (userText && injected) {
            note('user/message:skip', `跳过注入文本 textLen=${userText.length}`);
          } else if (userText && !state.userText) {
            state.userText = userText.slice(0, 800);
          }
          note('user/message', `session=${sessionId} textLen=${userText.length}`);
          return;
        }
        if (type === 'assistant/message') {
          const message = event.data?.message;
          const text = blockText(message);
          if (text.trim()) state.text = text;
          const step = event.data?.step;
          if (typeof step === 'number') state.steps = Math.max(state.steps, step);
          // 记下消息 id → 回合号，供消息尾部的重播按钮使用
          rememberMessageTurn(message?.id || event.data?.messageId, state.turn ?? event.data?.turn, sessionId);
          note('assistant/message', `session=${sessionId} step=${step ?? '?'} textLen=${text.length} msg=${message?.id ? 'yes' : 'no'}`);
          return;
        }
        if (type === 'turn/end') {
          state.aborted = event.data?.reason?.kind === 'aborted';
          pickModel(session, state);
          note('turn/end', `session=${sessionId} reason=${event.data?.reason?.kind ?? '?'} spoke=${state.spoke} steps=${state.steps} textLen=${(state.text || '').length} model=${state.model || '-'}`);
          scheduleSpeech(sessionId, state, 'turn/end');
          turnState.delete(sessionId);
        }
      } catch (error) {
        note('session/event:error', String((error && error.message) || error));
        ctx.logger?.warn?.(`${TAG} session/event 处理失败: ${(error && error.message) || error}`);
      }
    }

    function sendJson(res, code, value) {
      const body = JSON.stringify(value);
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
    }

    /**
     * B3（1.0.0）：**原样读请求体**（不解析）。
     *
     * 为什么浏览器上传不用 multipart：我们要的只是"一个 wav 文件 + 几个数字"，
     * 而 multipart 解析是纯粹的额外风险（边界、编码、内存翻倍）。改成"**body 就是 wav 字节、
     * 参数全在 query 上**"，宿主这边一行解析都不用写，客户端也只需要 `fetch(url, {body: file})`。
     *
     * 与 `readBody()`（JSON 专用）并列；上限自己兜（`MAX_UPLOAD_BYTES`）。
     */
    async function readRawBody(req, limit) {
      const chunks = [];
      let total = 0;
      for await (const chunk of req) {
        total += chunk.length;
        if (limit && total > limit) throw new Error(`上传太大（>${Math.round(limit / 1024 / 1024)} MB）`);
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    }

    async function readBody(req) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      if (!chunks.length) return {};
      try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return {};
      }
    }

    /**
     * 读出 BreezeTTS 声音库里的音色（GET /v1/voices）。
     * 只回已保存的（saved !== false），哈希临时条目重启就没了，列给用户会误导。
     * 60 秒缓存，避免每次开面板都去打一次上游。
     */
    let voicesCache = { at: 0, items: [] };
    async function listVoices() {
      if (voicesCache.items.length && Date.now() - voicesCache.at < 60000) return voicesCache.items;
      try {
        const res = await fetch(new URL('/v1/voices', cfg.baseUrl), { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return voicesCache.items;
        const raw = await res.json();
        const list = Array.isArray(raw) ? raw : (raw?.voices || raw?.items || []);
        const items = list
          .filter((item) => item && typeof item.id === 'string' && item.saved !== false)
          .map((item) => ({ id: item.id, description: item.description || '', seconds: item.seconds ?? null }));
        voicesCache = { at: Date.now(), items };
        return items;
      } catch {
        return voicesCache.items;
      }
    }

    /** 记下本会话用的 provider/model：authored 档的 verbalize 要靠它再调一次模型。 */
    function pickModel(session, state) {
      if (!state) return;
      try {
        const rc = typeof session?.requestContext === 'function' ? session.requestContext() : undefined;
        if (rc?.provider) state.provider = rc.provider;
        if (rc?.model) state.model = rc.model;
      } catch { /* ignore */ }
    }

    /* ─────────────── G1（0.96.0）：生成页的后端 ───────────────
     *
     * 拍板：生成页是**语音素材生产**入口 ——
     * 写一段文本、按当前引擎调一调、落成 wav 文件，模型也能生成（`tts_generate`，G3 再接）。
     * 这一层只做四件事，全在 `lib/generated.mjs` 里可测：
     *   ① 输出目录（面板填，空 = `<dataDir>/generated`），全部读写都锁在这个目录内；
     *   ② 重名 `xxx` → `xxx-1` → `xxx-2`…（`.wav`/`.mp3` 都算占用，`wx` 写盘防并发覆盖）；
     *   ③ `generated/index.json` 只追加记账（原子写）；
     *   ④ 只出 wav，落盘前无条件 `normalizeWav()`（坑 25）。
     */

    /** 输出目录：面板填了就用它，没填用 `<dataDir>/generated`。 */
    function generatedDir() {
      const raw = String((cfg.generated && cfg.generated.dir) || '').trim();
      return raw ? resolve(raw) : join(dataDir(), 'generated');
    }

    /** 设置输出目录：必须能建、能写（写一个探针文件再删掉），不可写就不改配置。 */
    async function setGeneratedDir(raw) {
      const want = String(raw || '').trim();
      if (!want) {
        cfg.generated = { ...(cfg.generated || {}), dir: '' };
        await persist();
        return { ok: true, dir: generatedDir() };
      }
      const abs = resolve(want);
      const probe = join(abs, `.write-probe-${process.pid}`);
      try {
        await mkdir(abs, { recursive: true });
        await writeFile(probe, 'ok', 'utf8');
        await rm(probe, { force: true });
      } catch (error) {
        return { ok: false, error: `目录不可写：${(error && error.message) || error}`, dir: generatedDir() };
      }
      cfg.generated = { ...(cfg.generated || {}), dir: abs };
      await persist();
      note('gen:dir', abs);
      return { ok: true, dir: abs };
    }

    /** 一小段 WAV 有多长（毫秒）：给面板显示用，读 `fmt` 的 byteRate 与 `data` 的长度。 */
    function wavDurationMs(buf) {
      if (!Buffer.isBuffer(buf) || buf.length < 44) return 0;
      if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return 0;
      let pos = 12;
      let byteRate = 0;
      while (pos + 8 <= buf.length) {
        const id = buf.toString('ascii', pos, pos + 4);
        const len = buf.readUInt32LE(pos + 4);
        if (id === 'fmt ' && pos + 20 <= buf.length) byteRate = buf.readUInt32LE(pos + 16) || 0;
        if (id === 'data') {
          const dataLen = Math.min(len, Math.max(0, buf.length - (pos + 8)));
          return byteRate ? Math.round((dataLen / byteRate) * 1000) : 0;
        }
        pos += 8 + len + (len % 2);
      }
      return 0;
    }

    /** 生成列表：**文件还在**的记录才列（手工删了文件就别留下死条目）。 */
    /**
     * 2026-11-18：把"列表/用户给的名字"解析成**真实存在的那个文件**。
     *
     * 删除 / 重命名 / 变声取源这三条路原来各自用 `sanitizeGenName()` 洗一遍再拼路径 ——
     * 而洗名字会**去掉中英文句读** 磁盘上叫 `这是 G3 的落盘验收，.wav`（0.97.0 之前生成的），
     * 洗完变成 `…验收.wav`，于是"明明在列表里"却**删不掉、改不了名、当不了源**。
     * `logs/168` 只修了变声那条出口，另外两条漏了 —— 所以这里收成一个函数，谁也别再各写一遍。
     *
     * 规则：**先按 `generatedList()` 精确匹配**（`file` / `file + .wav` / 记录的 `name` 三种都认），
     * 匹配不到才退回"洗名字"（照顾那些只给了个新名字的调用方）。
     * 返回 `{ file, name }`：`file` 是绝对路径，`name` 是**真实文件名**（记账要用它）。
     */
    async function resolveGeneratedName(wantedRaw) {
      const wanted = String(wantedRaw || '').trim();
      if (!wanted) return { file: '', name: '' };
      const dir = generatedDir();
      const listed = await generatedList().catch(() => ({ items: [] }));
      const hit = (listed.items || []).find((one) => one
        && (one.file === wanted || one.file === `${wanted}${GEN_EXT}` || one.name === wanted));
      if (hit) return { file: join(dir, String(hit.file)), name: String(hit.file) };
      const washed = sanitizeGenName(wanted.replace(/\.(wav|mp3)$/i, ''), '语音');
      return { file: join(dir, `${washed}${GEN_EXT}`), name: `${washed}${GEN_EXT}` };
    }

    async function generatedList() {
      const dir = generatedDir();
      const entries = await readGeneratedIndex(dir).catch(() => []);
      const items = [];
      for (const one of entries) {
        const file = String((one && one.file) || '');
        if (!file) continue;
        const abs = join(dir, file);
        if (!withinDir(dir, abs)) continue;
        let info = null;
        try {
          info = await stat(abs);
        } catch {
          continue;
        }
        items.push({
          ...one,
          bytes: info.size,
          mtime: info.mtimeMs,
          url: `${ROUTE_PREFIX}gen/${encodeURIComponent(file)}`,
        });
      }
      /*
       * G4（1.0.8）：`last` 改成**按 `at` 取最新的那条**，不再是"数组最后一个"。
       *
       * 以前两者等价（追加写总在末尾），但 G4 允许用户拖拽排序 —— 排序一改，"最后一个"就
       * 变成"用户排在最下面的那条"，而 `last` 的语义一直是"最近生成的一条"（面板拿它做
       * 模型生成后的参数回填）。语义绑错了，回填就会填一条几个月前的记录。
       */
      const latest = items.reduce((best, one) => {
        if (!best) return one;
        return String(one.at || '') > String(best.at || '') ? one : best;
      }, null);
      // G5：面板那一行「垃圾桶：N 个 · X MB（上限 …）」直接用这个，不用再发一次请求
      const trash = await trashStats();
      return { ok: true, dir, items, last: latest, trash };
    }

    /**
     * G5（1.0.9）：**垃圾桶**（`<dataDir>/gen-trash/`）的容量管理与清空。
     *
     * 为什么要管：生成页的"删除"是**挪进垃圾桶**而不是抹掉（后悔药），于是它天生只增不减 ——
     * 不管的话跑半年就是几百 MB 到 GB 躺在盘上。
     *
     * 拍板：**自动上限 128 MB 为主 + 手动「清空」为辅**。
     * 淘汰规则只有一条：**超限就从"最先进桶的"开始删，删到不超为止** ——
     * 于是"刚删错想找回"天然被保护（最新的最后才轮到），不需要额外的"宽限期"旋钮。
     *
     * 一个非显然的坑（`06` 坑 54）：进桶走 `rename`，而 **`rename` 保留内容 mtime**，
     * 所以垃圾桶里的 mtime 是"生成时刻"而不是"删除时刻"。这里两条一起用：
     *  · 进桶后 `utimes()` 把 mtime 改写成**现在**（新文件从此语义正确）；
     *  · 老文件靠文件名里的时间戳兜底（`trashEntryTimeMs()`）。
     */
    function trashDirPath() {
      return join(dataDir(), 'gen-trash');
    }

    function trashMaxBytes() {
      const n = Number(cfg.trashMaxBytes);
      return Number.isFinite(n) && n >= 0 ? n : TRASH_DEFAULT_MAX_BYTES;
    }

    /** 垃圾桶现状（面板那一行显示它）：`{dir, count, bytes, maxBytes}`。 */
    async function trashStats() {
      const dir = trashDirPath();
      const names = await readdir(dir).catch(() => []);
      let bytes = 0;
      let count = 0;
      for (const name of names) {
        const info = await stat(join(dir, name)).catch(() => null);
        if (!info || !info.isFile()) continue;
        count += 1;
        bytes += info.size;
      }
      return { dir, count, bytes, maxBytes: trashMaxBytes() };
    }

    /**
     * 按上限淘汰（best-effort：**永远不抛**，淘汰失败不影响这次删除本身）。
     * `maxBytes <= 0` = 不限 → 直接返回。
     */
    async function pruneTrash(reason = 'auto') {
      const maxBytes = trashMaxBytes();
      if (!(maxBytes > 0)) return { ok: true, skipped: 'unlimited' };
      const dir = trashDirPath();
      const names = await readdir(dir).catch(() => []);
      if (!names.length) return { ok: true, dropped: 0, bytes: 0 };
      const items = [];
      for (const name of names) {
        const info = await stat(join(dir, name)).catch(() => null);
        if (!info || !info.isFile()) continue;
        items.push({ name, size: info.size, atMs: trashEntryTimeMs(name, info.mtimeMs) });
      }
      const plan = planTrashPrune(items, { maxBytes });
      if (!plan.drop.length) return { ok: true, dropped: 0, bytes: plan.totalBytes };
      for (const one of plan.drop) {
        await unlink(join(dir, one.name)).catch(() => {});
      }
      note('gen:trash-prune', `reason=${reason} dropped=${plan.drop.length} freed=${plan.dropBytes} left=${plan.keepBytes}/${maxBytes} oldest=${plan.drop[0] ? plan.drop[0].name : '-'}`);
      return { ok: true, dropped: plan.drop.length, bytes: plan.keepBytes, freed: plan.dropBytes };
    }

    /** 手动清空：把垃圾桶里剩下的全删（用户点了两下确认才会走到这里）。 */
    async function emptyTrash() {
      const dir = trashDirPath();
      const names = await readdir(dir).catch(() => []);
      let freed = 0;
      let count = 0;
      for (const name of names) {
        const abs = join(dir, name);
        const info = await stat(abs).catch(() => null);
        if (!info || !info.isFile()) continue;
        const gone = await unlink(abs).then(() => true).catch(() => false);
        if (gone) {
          freed += info.size;
          count += 1;
        }
      }
      note('gen:trash-empty', `count=${count} freed=${freed}`);
      return { ok: true, count, freed };
    }

    /** 把一条记录从 index 里去掉（文件名 → 保留剩下的）。 */
    async function dropGeneratedEntry(dir, file) {
      const entries = await readGeneratedIndex(dir).catch(() => []);
      const next = entries.filter((one) => one && one.file !== file);
      if (next.length !== entries.length) await writeGeneratedIndex(dir, next);
      return next;
    }

    /**
     * G3：把**已经合成好的文件**塞进账目表播一次（不重新合成）。
     *
     * 生成页的"试听/生成后自动播"与工具 `tts_generate` 都走它 —— 客户端那边与普通播报
     * 完全同一条路（`/pending` → `/audio/<id>.wav`），不新增播放逻辑。
     */
    function enqueueFile(file, opts = {}) {
      if (!file) return null;
      seq += 1;
      const entry = {
        id: `${seq}-${createHash('sha1').update(`${file}|${Date.now()}`).digest('hex').slice(0, 8)}`,
        seq,
        // 1.2.4：**账目要能分清"这是哪一种播放"**。
        // `speech` = 播报（重播只认它）；`gen` = 生成页/试听的播放（`turn` 常常是 0，因为它不在任何回合里）；
        // `pause` = 气口（没有音频）。以前没有这个字段，重播只能"拿最后一条的 turn"，
        // 于是点重播会把**所有面板生成的音频**（turn=0）从头放一遍。
        kind: 'gen',
        turn: Number(opts.turnHint ?? turnState.get(opts.sessionId)?.turn ?? 0),
        file,
        text: String(opts.text || ''),
        chars: Number(opts.chars) || 0,
        ms: 0,
        cached: true,
        session: opts.sessionId || '',
        chunks: [],
        done: true,
        error: '',
        wake: null,
      };
      remember(entry);
      return entry;
    }

    /**
     * G2/G3：生成一段音频。面板（`POST /gen`）与工具 `tts_generate` **共用这一条**，
     * 所以"参数怎么洗 / 什么时候落盘 / index 记什么 / 播哪一份"只有一份实现。
     *
     * 用户拍板的落盘许可（`10` §12）：**能力默认允许，但只有 `save === true` 才写文件** ——
     * 面板生成 = 用户在要文件（`save` 默认 true）；模型只在用户明确要求时才传 `save:true`。
     */
    /** B2：采样参数的键名（snake，与工具 schema / 面板表单一致）。 */
    const SAMPLING_KEYS = ['temperature', 'top_k', 'top_p', 'repetition_penalty', 'max_new_tokens', 'split_chars'];

    /**
     * G4（1.0.8）：把这次**实际请求的采样值**摘成 index 字段。
     *
     * 只搬"给了"的（`undefined` 跳过）——"没给"必须保持缺席，让 `generatedEntry()` 的 `numOrNull()`
     * 落成 `null`（坑 42：`Number(null) === 0`，一个假 `0` 会让下次"再生成"带上真的 `temperature:0`）。
     */
    function samplingMeta(overrides) {
      const out = {};
      for (const key of SAMPLING_KEYS) {
        if (overrides && overrides[key] !== undefined) out[key] = overrides[key];
      }
      return out;
    }

    /**
     * B2（0.99.0）：生成**一粒**（合成 → 要存就落盘 → 要不要排队播）。
     *
     * 从 `runGenerate()` 里抽出来的唯一原因就是抽卡：2~4 个 seed 各跑一遍同一条流程，
     * 外层只负责解析参数与汇总。返回里**不含** `genMode` / `engine` / `voice` / `style`
     * （那些是"这一批"的公共信息，由外层补）。
     */
    async function generateOne(text, overrides, opts = {}) {
      const genMode = opts.genMode;
      let made;
      try {
        made = await withEngineFallback((inst) => inst.enqueue(() => inst.synthesize(text, overrides)));
      } catch (error) {
        note('gen:error', `engine=${tts.engine.id} ${(error && error.message) || error}`);
        return { ok: false, code: 502, error: String((error && error.message) || error) };
      }
      const raw = await readFile(made.file).catch(() => null);
      if (!raw) return { ok: false, code: 500, error: '合成完了却读不到缓存文件' };
      const durationMs = wavDurationMs(normalizeWav(raw));
      let saved = null;
      if (opts.save === true) {
        try {
          saved = await saveGeneratedWav({
            dir: generatedDir(),
            base: sanitizeGenName(String(opts.name || text.slice(0, 12)), '语音'),
            buffer: raw,
            meta: {
              engineId: tts.engine.id,
              engineKind: tts.engine.kind,
              genMode,
              voice: overrides.voice || '',
              instructions: overrides.instructions || '',
              seed: overrides.seed ?? null,
              cfgScale: overrides.cfg_scale ?? null,
              // G4：采样六项入账，否则「按这条参数再生成」会静默丢参数（白名单第三次，坑 40）
              ...samplingMeta(overrides),
              style: { ...(opts.globalStyle || {}), ...(opts.style || {}) },
              text,
              chars: text.length,
              ms: Number(made.ms) || 0,
              durationMs,
              source: opts.source === 'model' ? 'model' : 'user',
            },
          });
        } catch (error) {
          note('gen:save-fail', String((error && error.message) || error));
          return { ok: false, code: 500, error: String((error && error.message) || error) };
        }
        note('gen:save', `${saved.file} chars=${text.length} mode=${genMode} engine=${tts.engine.id} source=${saved.source} bytes=${saved.bytes}`);
      }
      // 播放：落盘了就播落盘那份（与列表里点「播放」是同一个文件），试听就播缓存那份。
      // `play:false`（抽卡）时**不排队**，面板里点哪条播哪条。
      const entry = opts.play === false ? null : enqueueFile(saved ? saved.path : made.file, {
        text,
        chars: text.length,
        sessionId: opts.sessionId || '',
        turnHint: opts.turnHint,
      });
      if (opts.play !== false) {
        note('gen:play', `${entry ? entry.id : '-'} ${saved ? 'saved' : 'preview'} chars=${text.length} mode=${genMode} duration=${durationMs}ms engine=${tts.engine.id}`);
      }
      return {
        ok: true,
        // `mode` 是既有契约（preview/saved，能不能落盘看它），`genMode` 才是
        // design/clone/direction/auto —— 两个概念别混，改名会打断 0.97.0 的调用方。
        mode: saved ? 'saved' : 'preview',
        chars: text.length,
        ms: Number(made.ms) || 0,
        durationMs,
        cached: Boolean(made.cached),
        item: saved ? { ...saved, url: `${ROUTE_PREFIX}gen/${encodeURIComponent(saved.file)}` } : null,
        url: entry ? `${ROUTE_PREFIX}audio/${entry.id}.wav` : '',
        id: entry ? entry.id : '',
      };
    }

    /** B3：变声上传的体积上限（一段 5 分钟的 24k 单声道 wav ≈ 14 MB，留一倍余量）。 */
    const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
    /** B3：正在变声的条数（`/state.converting` 用它给面板标"忙"）。 */
    let convertBusy = 0;

    /**
     * B3（1.0.0）：**VOICE CHANGER** 的执行核。三个入口在这里合流 ——
     * 不管源是从生成列表挑的、工具给的本机路径、还是浏览器上传的字节，
     * 到这儿都是「一个 WAV Buffer + 一串参数」。
     *
     * 老规矩一条都不破：默认**只试听**（`save !== true` 不写盘），`save:true` 才落 `generated/`，
     * 落盘记 `genMode:'changer'` + `keepAcoustic`，播放走同一个 `enqueueFile`。
     *
     * `KEEP MELODY`（引擎字段 `keep_acoustic`）：**0 = 说话**（全部声学码本重新生成），
     * **1~2 = 唱歌**（保留低阶码本、把旋律带过来），**>2 不稳**，面板要写清楚。
     */
    async function runConvert(input, opts = {}) {
      const args = input && typeof input === 'object' ? input : {};
      const capKind = String((tts && tts.engine && tts.engine.kind) || '');
      if (capKind !== 'breeze') {
        return { ok: false, code: 400, error: `当前引擎（${capKind || '未知'}）没有变声接口，切回本机 breeze 再试` };
      }
      /*
       * B3 修补：**变声也要走和播报同一条自愈链**。
       *
       * 第一版漏了这一步 —— 引擎崩掉之后变声只会一路 `fetch failed`（连续四次、每次 400/800/1200/1600 ms），
       * 而**谁都不会去把它拉起来** 播报那边有 `kickServer()`，变声这边没有。用户看到的
       * 就是"tts 掉线了"，然后无论怎么点都还在报错。
       */
      const serverReady = await breezeTts().ensureServer(Number(cfg.startWaitMs) || 90000).catch(() => false);
      if (!serverReady) {
        // 后台继续试着拉（与播报共用 `serverStarting` 闸门，不会拉出两个进程）
        kickServer();
        return { ok: false, code: 503, error: 'BreezeTTS 没起来（已尝试拉起，仍在后台重试）—— 看看引擎窗口是不是退出了' };
      }
      // ── 源音频：三入口合流 ──
      let sourceBuf = null;
      let sourceLabel = '';
      if (Buffer.isBuffer(opts.sourceBuffer) && opts.sourceBuffer.length) {
        sourceBuf = opts.sourceBuffer;
        sourceLabel = String(opts.sourceLabel || 'upload.wav');
      } else if (typeof args.sourceName === 'string' && args.sourceName.trim()) {
        /*
         * 2026-11-18：**按"列表里真实存在的文件名"精确匹配**，
         * 不要拿用户给的名字再过一遍 `sanitizeGenName()` 拼路径。
         *
         * 那条路会把文件名里的标点洗掉：磁盘上叫 `这是 G3 的落盘验收，.wav`（带全角逗号，
         * 0.97.0 之前生成的），洗完变成 `这是 G3 的落盘验收.wav` —— **明明在列表里，却 404**。
         * 现在先拿 `generatedList()`（它只列"文件还在"的记录）精确比对，匹配不到才退回洗名字，
         * 这样老文件、怪名字、`name` 与 `file` 混着传都能对。
         */
        const wanted = String(args.sourceName).trim();
        const { file } = await resolveGeneratedName(wanted);
        const dir = generatedDir();
        if (!withinDir(dir, file)) return { ok: false, code: 400, error: '路径越界' };
        sourceBuf = await readFile(file).catch(() => null);
        sourceLabel = basename(file);
        if (!sourceBuf) return { ok: false, code: 404, error: `生成列表里没有 ${wanted}（可能已经被删了）` };
      } else if (typeof args.source === 'string' && args.source.trim()) {
        const path = String(args.source).trim();
        if (!/\.wav$/i.test(path)) return { ok: false, code: 400, error: '只收 wav（mp3 等以后再说）' };
        sourceBuf = await readFile(path).catch(() => null);
        if (!sourceBuf) return { ok: false, code: 404, error: `读不到 ${path}` };
        sourceLabel = basename(path);
      }
      if (!sourceBuf) {
        return { ok: false, code: 400, error: '没有源音频：`source`（本机路径）/ `sourceName`（生成列表）/ 直接上传，三选一' };
      }

      const keepAcoustic = (() => {
        const raw = args.keep_acoustic ?? args.keepAcoustic;
        const n = Number(raw);
        return Number.isFinite(n) ? Math.min(3, Math.max(0, Math.round(n))) : 0;
      })();
      /*
       * 目标音色：**必须显式给**（或退回当前会话音色）。不给的话引擎会以为要设计模式、直接 400 ——
       * 变声的语义是"换成谁的声音"，没有"随便谁"这一档。
       */
      const voice = String(args.voice || '').trim() || String(cfg.voice || '').trim();
      if (!voice) return { ok: false, code: 400, error: '变声要一个目标音色（库里挑一个）' };

      convertBusy += 1;
      let made;
      try {
        made = await tts.convert({
          source: sourceBuf,
          filename: sourceLabel,
          voice,
          // 源稿：唱歌时强烈建议给（不给稿，官方实测会把词听成别的）
          text: typeof args.text === 'string' ? args.text.trim() : '',
          keepAcoustic,
          temperature: args.temperature,
          topK: args.top_k,
          cfgScale: args.cfg_scale,
          seed: args.seed,
        });
      } catch (error) {
        note('convert:error', `engine=${tts.engine.id} ${(error && error.message) || error}`);
        // 失败也踢一次：引擎若是刚崩的，下一次点就自动拉起来了
        kickServer();
        return { ok: false, code: 502, error: String((error && error.message) || error) };
      } finally {
        convertBusy = Math.max(0, convertBusy - 1);
      }

      const raw = await readFile(made.file).catch(() => null);
      if (!raw) return { ok: false, code: 500, error: '转换完了却读不到缓存文件' };
      const durationMs = wavDurationMs(normalizeWav(raw));
      let saved = null;
      if (opts.save === true) {
        try {
          saved = await saveGeneratedWav({
            dir: generatedDir(),
            base: sanitizeGenName(String(args.name || `${sourceLabel.replace(/\.wav$/i, '')}-变声`), '变声'),
            buffer: raw,
            meta: {
              engineId: tts.engine.id,
              engineKind: tts.engine.kind,
              genMode: 'changer',
              voice,
              instructions: '',
              seed: Number.isFinite(Number(made.params && made.params.seed)) ? made.params.seed : null,
              cfgScale: Number.isFinite(Number(made.params && made.params.cfgScale)) ? made.params.cfgScale : null,
              // G4：变声这次用的**转换参数**也是"这条记录的参数"——「再生成」要能原样复现，
              // 包括"源是哪一段"（`fromFile`）与 KEEP MELODY。没有 `fromFile`，回填后源那一格是空的，
              // 用户只能自己去列表里猜刚才用的是哪条。
              fromFile: sourceLabel,
              keepAcoustic,
              temperature: Number.isFinite(Number(made.params && made.params.temperature)) ? made.params.temperature : null,
              top_k: Number.isFinite(Number(made.params && made.params.topK)) ? made.params.topK : null,
              style: {},
              text: typeof args.text === 'string' ? args.text.trim() : '',
              chars: String(args.text || '').length,
              ms: Number(made.ms) || 0,
              durationMs,
              source: opts.source === 'model' ? 'model' : 'user',
            },
          });
        } catch (error) {
          note('convert:save-fail', String((error && error.message) || error));
          return { ok: false, code: 500, error: String((error && error.message) || error) };
        }
        note('convert:save', `${saved.file} keep=${keepAcoustic} voice=${voice} bytes=${saved.bytes} duration=${durationMs}ms engine=${tts.engine.id}`);
      }
      const entry = enqueueFile(saved ? saved.path : made.file, {
        text: `${sourceLabel} → ${voice}`,
        chars: 0,
        sessionId: opts.sessionId || '',
        turnHint: opts.turnHint,
      });
      note('convert:play', `${entry ? entry.id : '-'} ${saved ? 'saved' : 'preview'} keep=${keepAcoustic} duration=${durationMs}ms cached=${Boolean(made.cached)}`);
      return {
        ok: true,
        mode: saved ? 'saved' : 'preview',
        genMode: 'changer',
        engine: tts.engine.id,
        engineKind: tts.engine.kind,
        voice,
        keepAcoustic,
        source: sourceLabel,
        sourceBytes: sourceBuf.length,
        chars: String(args.text || '').length,
        ms: Number(made.ms) || 0,
        durationMs,
        cached: Boolean(made.cached),
        item: saved ? { ...saved, url: `${ROUTE_PREFIX}gen/${encodeURIComponent(saved.file)}` } : null,
        url: entry ? `${ROUTE_PREFIX}audio/${entry.id}.wav` : '',
        id: entry ? entry.id : '',
        dir: generatedDir(),
      };
    }

    async function runGenerate(input, opts = {}) {
      const args = input && typeof input === 'object' ? input : {};
      const text = String(args.text || '').trim();
      if (!text) return { ok: false, code: 400, error: 'text 必填' };
      const cap = (tts && tts.caps) || {};
      const limit = Number(cap.maxChars) || 2000;
      if (text.length > limit) return { ok: false, code: 413, error: `太长（${text.length} 字，这家上限 ${limit}）` };
      /*
       * 风格参数的两种形状都收（面板发嵌套 `style`，工具/speak 习惯平铺）：
       *   嵌套：`{ text, style: { emotion, speed, timbreWeights } }`
       *   平铺：`{ text, emotion, speed }`
       * 平铺的显式值盖住嵌套（`...args` 放后面）。**不在这里判"这家支不支持"** —— 那是 `sanitizeForEngine()` 的活。
       */
      const flat = { ...(args.style && typeof args.style === 'object' ? args.style : {}), ...args };
      const style = coerceStyle(flat);
      const base = activeRecord();
      const globalStyle = (base && base.style && typeof base.style === 'object') ? base.style : {};
      const overrides = { ...style };
      /*
       * B1（0.98.0）：模式解析交给 `lib/tts.mjs` 的纯函数（`spike/g0-g1-check.mjs` 直接测）。
       * 不传 `mode` → `auto` → 与 0.97.0 逐字一致；`design` 不兜会话音色（老 bug 的修法）。
       */
      const picked = resolveGenMode({
        mode: args.mode,
        voice: args.voice,
        fallbackVoice: voiceForSession(opts.sessionId || ''),
        instructions: typeof args.instructions === 'string' ? args.instructions : '',
        cfgScale: args.cfg_scale,
      });
      const genMode = picked.mode;
      if (genMode === 'direction' && !picked.voice) {
        return { ok: false, code: 400, error: '指挥模式需要一个音色：库里挑一个，或改成设计模式' };
      }
      overrides.voice = picked.voice;
      if (picked.instructions) overrides.instructions = picked.instructions;
      else delete overrides.instructions;
      if (Number.isFinite(Number(args.seed))) overrides.seed = Number(args.seed);
      if (Number.isFinite(Number(picked.cfgScale))) overrides.cfg_scale = Number(picked.cfgScale);
      // 云端不认本机音色名 → 合成前换一次（与播报同一条规则）
      overrides.voice = voiceForEngine(overrides.voice);
      /*
       * B2（0.99.0）：采样参数**只搬 snake 键**，转换与夹值统一由 `lib/tts.mjs` 的 `pickSampling()` 做
       * （`resolveParams()` 里调、`cacheKey()` 也从同一个地方取）—— 宿主不另立一套规则。
       */
      for (const key of SAMPLING_KEYS) {
        if (args[key] !== undefined && args[key] !== null && args[key] !== '') overrides[key] = args[key];
      }
      // 抽卡：`seeds` 去重后 1~4 个。**必须落盘** —— 不落盘就没有"挑"的对象。
      const seeds = Array.isArray(args.seeds)
        ? [...new Set(args.seeds.map((one) => Math.round(Number(one))).filter((one) => Number.isFinite(one)))].slice(0, 4)
        : [];
      const ctx = {
        name: args.name,
        save: opts.save === true,
        source: opts.source,
        sessionId: opts.sessionId,
        turnHint: opts.turnHint,
        style,
        globalStyle,
        genMode,
        // G4a：批量生成要"全部落盘但一条都别播"——`undefined` 保持原来"落盘就播"的行为
        play: opts.play === false ? false : undefined,
      };
      if (seeds.length > 1) {
        if (ctx.save !== true) return { ok: false, code: 400, error: '抽卡要落盘：传 `save: true` 或换成单个 seed' };
        const made = [];
        for (const seed of seeds) {
          const one = await generateOne(text, { ...overrides, seed }, {
            ...ctx,
            // 每粒一个文件：`名字-s7` / `名字-s8`…（洗名字由 `saveGeneratedWav` 内部做）
            name: `${String(args.name || text.slice(0, 12))}-s${seed}`,
            // 抽卡**不自动播** 四粒一起进队列会吵成一团，面板里点哪条播哪条
            play: false,
          });
          if (!one.ok) return one;
          made.push({ ...one, seed });
        }
        note('gen:pick', `take=${made.length} seeds=${seeds.join(',')} chars=${text.length} mode=${genMode} engine=${tts.engine.id}`);
        return {
          ok: true,
          genMode,
          take: made.length,
          items: made,
          play: null,
          chars: text.length,
          engine: tts.engine.id,
          engineKind: tts.engine.kind,
          voice: overrides.voice || '',
          style,
          dir: generatedDir(),
        };
      }
      const one = await generateOne(text, overrides, ctx);
      if (!one.ok) return one;
      return {
        ...one,
        genMode,
        engine: tts.engine.id,
        engineKind: tts.engine.kind,
        voice: overrides.voice || '',
        style,
        dir: generatedDir(),
      };
    }

    async function handler(req, res) {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      // 兼容两种形态：完整路径 /voice-breeze/state，或 prefix 路由剥离前缀后的 /state
      let path = url.pathname;
      if (path === '/voice-breeze') path = '/';
      else if (path.startsWith('/voice-breeze/')) path = path.slice('/voice-breeze'.length);

      try {
        /* ───────── （A4b）：列出某个 provider 的音色（MiniMax 有真接口，其余给预置清单） ───────── */
        if (path === '/engine/voices') {
          const wanted = String(url.searchParams.get('id') || '').trim();
          const provider = engineConfig().providers.find((one) => one && String(one.id) === wanted) || null;
          if (!provider) return sendJson(res, 404, { error: '没有这个 provider' });
          const kindName = coerceKind(provider.kind, provider.baseUrl);
          if (kindName === 'minimax') {
            const key = await readEngineKey(wanted);
            if (!key) return sendJson(res, 400, { error: '这条引擎还没有 key' });
            try {
              const base = String(provider.baseUrl || '').trim().replace(/\/+$/, '');
              // P1：MiniMax 的 `/v1/get_voice` **只认 POST**。
              // 以前这里写的是 GET → 真机回 `404 page not found`，于是：
              //   ① 清单永远拉不到（下拉里只剩手填过的那几个音色）；
              //   ② 探活把 404 当成"地址活着"，key 填错也不报警。
              // 现在 POST 为主，404/405 时退一次 GET（兼容只认 GET 的自建网关）。
              const url = `${base}/get_voice`;
              const askPost = () => fetch(url, {
                method: 'POST',
                headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
                body: JSON.stringify({ voice_type: 'all' }),
                signal: AbortSignal.timeout(8000),
              });
              let resp = await askPost();
              if (resp.status === 404 || resp.status === 405) {
                resp = await fetch(`${url}?voice_type=all`, {
                  headers: { authorization: `Bearer ${key}` },
                  signal: AbortSignal.timeout(8000),
                });
              }
              const data = await resp.json().catch(() => ({}));
              const pick = (arr, group) => (Array.isArray(arr) ? arr : [])
                .map((one) => ({
                  id: String(one?.voice_id || '').trim(),
                  name: String(one?.voice_name || one?.voice_id || '').trim(),
                  group,
                }))
                .filter((one) => one.id);
              const items = [
                ...pick(data.system_voice, 'system'),
                ...pick(data.voice_cloning, 'cloning'),
                ...pick(data.voice_generation, 'generation'),
              ];
              note('engine:voice-list', `${wanted} ${items.length} 条 http=${resp.status} code=${data?.base_resp?.status_code ?? '-'}`);
              // 1.2.1：**拉到的清单要落进 provider**，否则生成页的音色下拉永远是空的。
              const remembered = await rememberVoiceCatalogue(wanted, items.map((one) => one.id)).catch(() => 0);
              return sendJson(res, 200, { items, remembered, status: data?.base_resp || null });
            } catch (error) {
              return sendJson(res, 502, { error: String((error && error.message) || error) });
            }
          }
          // 其余厂商没有清单接口：把预置 + 用过的直接给出去
          const profile = voiceProfile(provider);
          return sendJson(res, 200, { items: profile.items.map((v) => ({ id: v, name: v, group: 'preset' })) });
        }

        /* ───────── G1（0.96.0）：生成页。GET 列表 / 目录；POST 生成 · 改目录 · 重命名 · 删除 ───────── */
        /* ───────── 2026-11-18：手动启动引擎 ─────────
         * 用户要一个"自己点一下就能起引擎"的按钮（不必等模型调 speak）。
         * 幂等 + 防多开：`serverStarting` 闸门在 `kickServer()` 里，起过就 return；
         * `startServer()` 自己还有 spawn 节流（成功 3 分钟 / 失败 15 秒）。所以连点不会多开。
         */
        if (path === '/engine/start') {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method' });
          const kindNow = String((tts && tts.engine && tts.engine.kind) || '');
          if (kindNow !== 'breeze') {
            return sendJson(res, 400, { ok: false, error: '当前引擎不是本机 BreezeTTS，没有可启动的进程' });
          }
          if (serverStarting) {
            note('engine:start-manual', 'already-starting');
            return sendJson(res, 200, { ok: true, already: true, starting: true, up: false });
          }
          if (await breezeTts().healthy()) {
            note('engine:start-manual', 'already-up');
            return sendJson(res, 200, { ok: true, already: true, starting: false, up: true });
          }
          kickServer();
          note('engine:start-manual', 'spawn');
          return sendJson(res, 200, { ok: true, starting: true, up: false });
        }

        /* ───────── B3（1.0.0）：VOICE CHANGER ─────────
         * 两种投递方式，**都不用解析 multipart** 
         *  · `application/json`：`{ sourceName? | source?, voice, keep_acoustic, temperature, top_k,
         *    cfg_scale, seed, text?, name?, save? }` —— 面板「选列表里的一条」和工具传路径都走它；
         *  · 其它 content-type：**body 就是 wav 原始字节**，参数全在 query 上
         *    （`?voice=&keep=&temperature=&top_k=&cfg_scale=&seed=&text=&name=&filename=&save=`）
         *    —— 浏览器上传走它。宿主一行解析都不用写，客户端也只要 `fetch(url, { body: file })`。
         */
        if (path === '/convert') {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method' });
          const ctype = String(req.headers['content-type'] || '');
          let payload = {};
          let sourceBuffer = null;
          let sourceLabel = '';
          if (ctype.includes('application/json')) {
            payload = await readBody(req);
          } else {
            try {
              sourceBuffer = await readRawBody(req, MAX_UPLOAD_BYTES);
            } catch (error) {
              return sendJson(res, 413, { ok: false, error: String((error && error.message) || error) });
            }
            const q = url.searchParams;
            const pick = (key) => (q.get(key) === null ? undefined : q.get(key));
            payload = {
              // 上传这条路没有 `sourceName`（源就是 body），也**不接受** `source` 路径 ——
              // 浏览器端不该有能力让宿主去读任意本机文件
              voice: pick('voice'),
              keep_acoustic: pick('keep'),
              temperature: pick('temperature'),
              top_k: pick('top_k'),
              cfg_scale: pick('cfg_scale'),
              seed: pick('seed'),
              text: pick('text'),
              name: pick('name'),
              save: pick('save') !== 'false',
              session: pick('session'),
            };
            sourceLabel = decodeURIComponent(pick('filename') || 'upload.wav').slice(0, 120) || 'upload.wav';
            if (!sourceBuffer || !sourceBuffer.length) {
              return sendJson(res, 400, { ok: false, error: '没有收到音频字节' });
            }
          }
          const out = await runConvert(payload, {
            save: payload.save !== false,
            source: 'user',
            sourceBuffer,
            sourceLabel,
            sessionId: String(payload.session || ''),
          });
          if (!out.ok) return sendJson(res, out.code || 500, { ok: false, error: out.error });
          note('convert:done', `${out.mode} keep=${out.keepAcoustic} voice=${out.voice} src=${out.source} durationMs=${out.durationMs} bytes=${out.sourceBytes}`);
          return sendJson(res, 200, {
            ok: true,
            dir: out.dir,
            item: out.item,
            mode: out.mode,
            genMode: out.genMode,
            voice: out.voice,
            keepAcoustic: out.keepAcoustic,
            source: out.source,
            play: { id: out.id, url: out.url },
            chars: out.chars,
            ms: out.ms,
            durationMs: out.durationMs,
            cached: Boolean(out.cached),
            engine: out.engine,
          });
        }

        if (path === '/gen') {
          if (req.method === 'GET') return sendJson(res, 200, await generatedList());
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method' });
          const body = await readBody(req);
          const action = String((body && body.action) || 'generate');
          const dir = generatedDir();

          if (action === 'dir') {
            const out = await setGeneratedDir(body && body.dir);
            const list = await generatedList();
            // 顺序要紧：`out` 放在后面，否则 `list` 里的 `ok:true` 会把"目录不可写"盖掉（自测抓到的）。
            return sendJson(res, out.ok ? 200 : 400, { ...list, ...out });
          }

          if (action === 'rename') {
            // 先判"有没有给"，再洗 —— `sanitizeGenName('')` 会回兜底名，用它判断"没给"会永远为假。
            const rawFrom = String(body?.from || '').trim();
            const rawTo = String(body?.to || '').trim();
            if (!rawFrom || !rawTo) return sendJson(res, 400, { ok: false, error: 'from / to 必填' });
            // `from` 是**引用已有文件**（不洗，走统一解析）；`to` 是**新建一个名字**（必须洗）
            const { file: src, name: fromName } = await resolveGeneratedName(rawFrom);
            const to = sanitizeGenName(rawTo, '语音');
            const dst = join(dir, `${to}${GEN_EXT}`);
            if (!withinDir(dir, src) || !withinDir(dir, dst)) return sendJson(res, 400, { ok: false, error: '路径越界' });
            if (existsSync(dst)) return sendJson(res, 409, { ok: false, error: `已经有 ${to}${GEN_EXT}（不覆盖，换个名字）` });
            try {
              await rename(src, dst);
            } catch (error) {
              return sendJson(res, 404, { ok: false, error: `改不了名 ${fromName}：${(error && error.message) || error}` });
            }
            const entries = await readGeneratedIndex(dir).catch(() => []);
            const next = entries.map((one) => (one && one.file === fromName
              ? { ...one, name: to, file: `${to}${GEN_EXT}` }
              : one));
            await writeGeneratedIndex(dir, next);
            note('gen:rename', `${fromName} → ${to}${GEN_EXT}`);
            return sendJson(res, 200, await generatedList());
          }

          if (action === 'delete') {
            const rawName = String(body?.name || '').trim();
            if (!rawName) return sendJson(res, 400, { ok: false, error: 'name 必填' });
            // **不洗名字** 走统一解析，名字里带句读的老文件才删得掉
            const { file, name } = await resolveGeneratedName(rawName);
            if (!withinDir(dir, file)) return sendJson(res, 400, { ok: false, error: '路径越界' });
            // **不直接删干净** 挪到 `<dataDir>/gen-trash/`，用户后悔还找得回来（同场景删除的做法）。
            const trash = join(dataDir(), 'gen-trash');
            await mkdir(trash, { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const stamped = `${name.replace(/\.wav$/i, '')}-${stamp}${GEN_EXT}`;
            try {
              await rename(file, join(trash, stamped));
            } catch (error) {
              return sendJson(res, 404, { ok: false, error: `删不掉 ${name}：${(error && error.message) || error}` });
            }
            /*
             * G5（1.0.9）：**把 mtime 改写成"现在"**。
             * `rename` 保留内容 mtime，于是垃圾桶里的 mtime 一直是"生成时刻" ——
             * 按它淘汰会先删"生成得早、昨天才删"的那些（`06` 坑 54）。
             * 顺手（异步）跑一次容量淘汰：不用 await —— "删除成功"不该被淘汰的 IO 拖慢或拖挂。
             */
            const now = new Date();
            await utimes(join(trash, stamped), now, now).catch(() => {});
            void pruneTrash('delete').catch(() => {});
            await dropGeneratedEntry(dir, name);
            note('gen:delete', `${name} → gen-trash/${stamped}`);
            return sendJson(res, 200, await generatedList());
          }

          /*
           * G5（1.0.9）：垃圾桶的两个动作。
           *  · `trash-empty`：**手动清空**（面板两下确认之后才发）—— 用户要的"我现在就要它空"；
           *  · `trash-prune`：手动跑一次容量淘汰（一般用不到：每次删除后自动淘汰已经跑过；
           *    留给"我刚把上限改小了，想立刻生效"）。
           */
          if (action === 'trash-empty') {
            const out = await emptyTrash();
            const list = await generatedList();
            // 结论字段放最后展开（`06` 坑 37：`{...list, ...out}` 会把 ok 盖掉）
            return sendJson(res, 200, { ...list, ...out });
          }
          if (action === 'trash-prune') {
            const out = await pruneTrash('manual');
            const list = await generatedList();
            return sendJson(res, 200, { ...list, ...out });
          }

          /*
           * G4a（1.0.8）：**批量生成** —— 一批文本逐条合成、逐条落盘，**一条都不自动播**。
           *
           * 为什么不自动播：N 条一起进队列会吵成一团（与抽卡同一条理由，B2 已定）。
           * 为什么不并发：引擎是单并发的（`10` §8 第 2 条），并发只会撞 409 然后串行，
           * 徒增重试与日志噪音 —— 这里就是老实排队。
           * 一条失败不打断后面（用户填了 10 行，第 3 行太长不该把 7 行一起废掉），
           * 失败明细逐条回给面板。
           */
          if (action === 'batch') {
            const raw = Array.isArray(body?.texts) ? body.texts : [body?.text ?? ''];
            const lines = raw
              .map((one) => String(one ?? '').trim())
              .filter(Boolean)
              .slice(0, 20);
            if (!lines.length) return sendJson(res, 400, { ok: false, error: '批量至少要一行文本' });
            const prefix = String(body?.namePrefix || body?.name || '').trim();
            const made = [];
            const failed = [];
            for (let i = 0; i < lines.length; i += 1) {
              // 每行都以"这条记录自己的 text"为准；`namePrefix` 给了就按序号命名，没给就取各自前 12 字
              const out = await runGenerate({
                ...body,
                text: lines[i],
                seeds: undefined,
                name: prefix ? `${prefix}-${i + 1}` : undefined,
              }, {
                sessionId: String(body?.session || ''),
                save: true,
                source: 'user',
                play: false,
              });
              if (!out.ok) {
                failed.push({ index: i, text: lines[i].slice(0, 40), error: out.error || `HTTP ${out.code || 500}` });
                continue;
              }
              made.push(out.item || null);
            }
            note('gen:batch', `take=${made.length} fail=${failed.length} chars=${lines.reduce((n, one) => n + one.length, 0)} engine=${tts.engine.id}`);
            if (!made.length) {
              return sendJson(res, 502, { ok: false, error: `批量全部失败：${failed[0]?.error || '未知原因'}`, failed });
            }
            return sendJson(res, 200, {
              ok: true,
              dir: generatedDir(),
              take: made.length,
              items: made.filter(Boolean),
              failed,
              mode: 'saved',
              genMode: 'auto',
              play: null,
            });
          }

          /*
           * G4c（1.0.8）：**结果列表拖拽排序** —— 只改 `index.json` 的顺序，不动任何文件。
           *
           * 排序为什么落在宿主：列表顺序就是 index 的数组顺序（`generatedList()` 原样吐），
           * 客户端若能直接改那张表，就等于绕过 `lib/generated.mjs` 的落盘层（`10` §8 第 14 条）。
           * 这里只接受"文件名数组"，`reorderEntries()` 负责去重/丢弃不存在的/补齐剩下的。
           */
          if (action === 'reorder') {
            const order = Array.isArray(body?.order) ? body.order : null;
            if (!order) return sendJson(res, 400, { ok: false, error: 'order 必填（文件名数组）' });
            const entries = await readGeneratedIndex(dir).catch(() => []);
            const next = reorderEntries(entries, order);
            await writeGeneratedIndex(dir, next);
            note('gen:reorder', `${entries.length} 条 · 前三个=${next.slice(0, 3).map((one) => one && one.file).join(',')}`);
            return sendJson(res, 200, await generatedList());
          }

          /* 生成：走与工具 `tts_generate` 同一条 `runGenerate()`。
           * 面板这一侧 `save` 默认 true（用户点「生成」就是在要文件）；`save:false` 时只试听不写盘。 */
          const out = await runGenerate(body, {
            sessionId: String((body && body.session) || ''),
            save: !(body && body.save === false),
            source: (body && body.source === 'model') ? 'model' : 'user',
          });
          if (!out.ok) return sendJson(res, out.code || 500, { ok: false, error: out.error });
          // B2：抽卡（`seeds` 2~4 个）—— 一批文件、**不自动播**，面板里点哪条播哪条
          if (Array.isArray(out.items)) {
            note('gen:done', `pick=${out.take} mode=${out.genMode || '-'} dir=${out.dir}`);
            return sendJson(res, 200, {
              ok: true,
              dir: out.dir,
              take: out.take,
              items: out.items,
              mode: out.items[0] ? out.items[0].mode : 'preview',
              genMode: out.genMode,
              voice: String(out.voice || ''),
              play: null,
              chars: out.chars,
              engine: out.engine,
            });
          }
          note('gen:done', `mode=${out.genMode || '-'} save=${out.mode} item=${out.item ? out.item.file : '-'} durationMs=${out.durationMs}`);
          return sendJson(res, 200, {
            ok: true,
            dir: out.dir,
            item: out.item,
            // 两个 `mode` 别混：`mode` = preview/saved（落不落盘，老契约）；
            // `genMode` = design/clone/direction/auto（这次用的是哪种生成模式）。
            mode: out.mode,
            genMode: out.genMode,
            voice: String(out.voice || ''),
            play: { id: out.id, url: out.url },
            chars: out.chars,
            ms: out.ms,
            durationMs: out.durationMs,
            // B2：命中缓存与否（验"同参数两次"与"改采样不该命中"都靠它）
            cached: Boolean(out.cached),
            engine: out.engine,
          });
        }

        /* G1：生成出来的音频（**只服务配置目录内的 wav**）。不进缓存、不受 LRU 淘汰。 */
        if (path.startsWith('/gen/')) {
          if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method' });
          let name = '';
          try {
            name = decodeURIComponent(path.slice('/gen/'.length));
          } catch {
            return sendJson(res, 400, { error: 'bad name' });
          }
          if (!/\.wav$/i.test(name)) return sendJson(res, 400, { error: '只出 wav' });
          const base = name.slice(0, -4);
          // 只认"洗干净之后还是自己"的名字：挡掉 `..`、路径分隔符、奇怪字符（`sanitizeGenName` 会删非法字符）
          if (!base || sanitizeGenName(base, '') !== base) return sendJson(res, 400, { error: 'bad name' });
          const dir = generatedDir();
          const file = join(dir, `${base}${GEN_EXT}`);
          if (!withinDir(dir, file)) return sendJson(res, 400, { error: '路径越界' });
          const raw = await readFile(file).catch(() => null);
          if (!raw) return sendJson(res, 404, { error: '没有这个文件' });
          const buf = normalizeWav(raw);
          const trimmed = raw.length - buf.length;
          note('gen:serve', `${base}${GEN_EXT} bytes=${buf.length}${trimmed > 0 ? ` trimmed=${trimmed}` : ''}`);
          return sendWav(req, res, buf, `gen:${base}${GEN_EXT}`);
        }

        /* ───────── （A2）/ （A3）：引擎切换。GET 看快照；POST 改 active / fallbackEngine / providers ───────── */
        if (path === '/engine') {
          if (req.method === 'GET') return sendJson(res, 200, await engineSnapshot());
          if (req.method === 'POST') {
            const body = await readBody(req);
            let changed = false;
            if (Array.isArray(body.providers)) {
              const prev = engineConfig().providers;
              const next = [];
              for (const raw of body.providers) {
                const id = String(raw?.id || '').trim();
                if (!id || id === 'breeze') continue; // breeze 内置，别覆盖
                const baseUrl = String(raw?.baseUrl || '').trim();
                if (!/^https?:\/\//i.test(baseUrl)) continue; // 地址不合法就丢掉这一条
                const before = prev.find((one) => one && String(one.id) === id);
                const entry = {
                  id,
                  kind: coerceKind(raw?.kind, baseUrl),
                  label: String(raw?.label || id).trim(),
                  baseUrl,
                  model: String(raw?.model || 'tts-1').trim(),
                  defaultVoice: String(raw?.defaultVoice || '').trim(),
                  audioFormat: 'wav',
                  supportsInstructions: Boolean(raw?.supportsInstructions),
                  // A3：成功用过的音色要留住，别每次整组替换就把它们洗掉
                  knownVoices: Array.isArray(before?.knownVoices) ? before.knownVoices : [],
                  // 1.2.1：拉下来的整份音色目录同理 —— 它是**服务端拿到的**事实，
                  // 别让一次"保存引擎设置"把它洗掉（白名单漏字段是这个项目的老病，坑 40）。
                  voiceCatalogue: Array.isArray(before?.voiceCatalogue) ? before.voiceCatalogue : [],
                  // P2：这一家的风格参数（洗过白名单；空对象就落空对象，表示"用厂商默认"）
                  style: coerceStyle(raw?.style),
                };
                // 先出声优先：没填音色而这家有预置清单时，自动挑第一个（否则第一次试听就报错）
                if (!entry.defaultVoice) entry.defaultVoice = voiceProfile(entry).items[0] || '';
                next.push(entry);
                // key 进凭据库（拿不到才落 keys/<id>.txt）；**绝不进 state.json、也绝不回显**
                if (typeof raw?.apiKey === 'string' && raw.apiKey.trim()) {
                  await writeEngineKey(id, raw.apiKey);
                }
                if (raw?.removeKey === true) await deleteEngineKey(id);
              }
              // 整组替换时，被删掉的 provider 连 key 一起清掉（避免留下孤儿凭据）
              for (const gone of prev) {
                if (gone && !next.some((one) => one.id === gone.id)) await deleteEngineKey(gone.id);
              }
              cfg.engine = { ...engineConfig(), providers: next };
              changed = true;
            }
            if (typeof body.active === 'string') {
              const wanted = body.active.trim() || 'breeze';
              const known = wanted === 'breeze' || engineConfig().providers.some((one) => one.id === wanted);
              if (known) {
                cfg.engine = { ...engineConfig(), active: wanted };
                changed = true;
              }
            }
            if (typeof body.fallbackEngine === 'string') {
              const fb = body.fallbackEngine.trim();
              const known = !fb || fb === 'breeze' || engineConfig().providers.some((one) => one.id === fb);
              if (known) {
                cfg.engine = { ...engineConfig(), fallbackEngine: fb };
                changed = true;
              }
            }
            if (changed) {
              await persist();
              rebuildTts();
              note('engine:switch', `active=${engineConfig().active} fallback=${engineConfig().fallbackEngine || '-'} keyBackend=${credentialsService() ? 'credentials' : 'file'}`);
            }
            return sendJson(res, 200, await engineSnapshot());
          }
        }

        if (path === '/state') {
          if (req.method === 'POST') {
            const body = await readBody(req);
            let dirty = false;
            if (typeof body.enabled === 'boolean') {
              cfg.enabled = body.enabled;
              dirty = true;
            }
            // /：旧页面可能还发 firstSentence / summary，统一落到「摘要」(auto)
            const wantedFallback = (body.fallback === 'firstSentence' || body.fallback === 'summary')
              ? 'auto'
              : body.fallback;
            if (FALLBACKS.has(wantedFallback)) {
              cfg.fallback = wantedFallback;
              dirty = true;
            }
            if (typeof body.voice === 'string') {
              cfg.voice = body.voice.trim();
              // 界面手选音色时同步「出厂预设」记账——选了 girl/boy 就记它，选别的就清空。
              // 不同步的后果：重启后启动自举会把用户手选的嗓子顶回旧预设（实测过一次）。
              cfg.voicePreset = Object.prototype.hasOwnProperty.call(PRESET_VOICES, cfg.voice) ? cfg.voice : '';
              // 同时写进「这个会话」的记忆：切到别的会话再切回来，还是这个音色
              if (typeof body.session === 'string' && body.session) {
                cfg.sessions[body.session] = { voice: cfg.voice };
              }
              dirty = true;
            }
            if (body.strength && STRENGTHS[body.strength]) {
              cfg.strength = body.strength;
              dirty = true;
            }
            if (typeof body.toneInstructions === 'string' && body.toneInstructions.trim()) {
              cfg.toneInstructions = body.toneInstructions.trim();
              dirty = true;
            }
            if (typeof body.multiVoice === 'boolean') {
              cfg.multiVoice = body.multiVoice;
              // 多音色只决定「谁来说」，不再顺手改「说什么」（设计准则的两个正交维度）。
              // 首次点「多音色扮演」时由客户端自己带上 narrationMode:'script'，其余情况尊重用户选择。
              if (body.multiVoice) cfg.fallback = 'roleplay';
              dirty = true;
            }
            if (typeof body.scene === 'string') {
              if (setActiveScene(body.scene)) {
                personaCache = { at: 0, text: '', scene: '' };
                castCache = { at: 0, list: [], scene: '' };
                note('scene:switch', body.scene || '_default');
                dirty = true;
              }
            }
            if (body.narrationMode === 'script' || body.narrationMode === 'adapted') {
              cfg.narrationMode = body.narrationMode;
              dirty = true;
            }
            if (Number.isFinite(body.segmentGapMs) && body.segmentGapMs >= 0) {
              cfg.segmentGapMs = Number(body.segmentGapMs);
              dirty = true;
            }
            if (Number.isFinite(body.bufferSeconds) && body.bufferSeconds >= 0) {
              cfg.bufferSeconds = Number(body.bufferSeconds);
              dirty = true;
            }
            // 操作面板——选项放哪 + 浮层位置
            if (typeof body.controlsInPanel === 'boolean') {
              cfg.controlsInPanel = body.controlsInPanel;
              dirty = true;
            }
            // 播报音量（0~1；面板里的常驻滑块写这一个字段）
            if (Number.isFinite(body.volume)) {
              cfg.volume = clampVolume(body.volume);
              dirty = true;
            }
            // 1.0.9：垃圾桶容量上限（字节；0 = 不限）。改小之后**立刻**淘汰一次，
            // 否则要等下一次删除才生效，用户会觉得"改了没用"。
            // T5：片长（0 或 20~400）。改完**下一次播报**就生效，不用重启。
            if (Number.isFinite(body.chunkChars) && body.chunkChars >= 0) {
              cfg.chunkChars = Math.min(400, Math.round(Number(body.chunkChars)));
              dirty = true;
            }
            if (Number.isFinite(body.trashMaxBytes) && body.trashMaxBytes >= 0) {
              cfg.trashMaxBytes = Math.round(Number(body.trashMaxBytes));
              dirty = true;
              void pruneTrash('config').catch(() => {});
            }
            // 出厂音色预设（'girl' / 'boy' / ''）——只管记账，真正的切换走 tts_preset
            if (typeof body.voicePreset === 'string') {
              const want = body.voicePreset.trim();
              cfg.voicePreset = Object.prototype.hasOwnProperty.call(PRESET_VOICES, want) ? want : '';
              dirty = true;
            }
            if (body.panel && Number.isFinite(body.panel.x) && Number.isFinite(body.panel.y)) {
              cfg.panel = { x: Math.round(Number(body.panel.x)), y: Math.round(Number(body.panel.y)) };
              dirty = true;
            }
            if (dirty) await persist();
          }
          return sendJson(res, 200, {
            enabled: cfg.enabled,
            fallback: cfg.fallback,
            voice: voiceForSession(url.searchParams.get('session') || ''),
            strength: cfg.strength,
            multiVoice: Boolean(cfg.multiVoice),
            narrationMode: cfg.narrationMode,
            scene: (() => { const info = listScenes(); return { active: activeSceneId() || '_default', ids: info.ids }; })(),
            castSize: readCast().length,
            // B3（1.0.0）：变声进行中（面板据此标"忙"、把播报按钮按下去）
            converting: convertBusy > 0,
            // 2026-11-18：面板要判断"该不该显示『启动引擎』" ——
            // 只有本机 breeze + 端点没起来时才显示，所以把 kind 也交出去
            engineKind: String((tts && tts.engine && tts.engine.kind) || 'breeze'),
            engineStarting: Boolean(serverStarting),
            segmentGapMs: Number(cfg.segmentGapMs) >= 0 ? Number(cfg.segmentGapMs) : 500,
            // T5：长播报切片片长（0 = 不切）。面板「选项」页那一格读它。
            chunkChars: Number(cfg.chunkChars) || 0,
            bufferSeconds: Number(cfg.bufferSeconds) >= 0 ? Number(cfg.bufferSeconds) : 2,
            controlsInPanel: Boolean(cfg.controlsInPanel),
            volume: clampVolume(cfg.volume),
            voicePreset: String(cfg.voicePreset || ''),
            panel: {
              x: Number.isFinite(cfg.panel && cfg.panel.x) ? Number(cfg.panel.x) : 0,
              y: Number.isFinite(cfg.panel && cfg.panel.y) ? Number(cfg.panel.y) : 0,
            },
            toneInstructions: cfg.toneInstructions,
            instructions: cfg.instructions,
            cfgScale: cfg.cfgScale,
            voiceUp: await tts.healthy(),
            // （A3）：客户端据 `engine.kind/voiceMode` 决定音色下拉还列不列本机音色（`15` §4.9）
            engine: {
              id: tts.engine.id,
              kind: tts.engine.kind,
              label: tts.engine.label,
              voiceMode: activeVoiceProfile().voiceMode,
            },
            starting: serverStarting,
            pending: pendingLines.length,
            lastError: tts.lastError,
            // 最近一次"该念却没念成"（`{at, reason, count, sample}`），界面据此提示
            voiceFailure: lastVoiceFailure,
            baseUrl: cfg.baseUrl,
            maxChars: effectiveMaxChars(),
            install: await installState(),
            installJob: { state: installJob.state, phase: installJob.phase, percent: installJob.percent, error: installJob.error },
          });
        }

        if (path === '/voices') {
          const items = await listVoices();
          return sendJson(res, 200, { current: cfg.voice, items });
        }

        // 账目条目的对外形状（/pending 与 /turn 共用）
        function mapLedgerEntry(e) {
          return {
            id: e.id,
            seq: e.seq,
            text: e.text,
            chars: e.chars,
            ms: e.ms,
            turn: e.turn ?? 0,
            kind: e.kind || '',
            pauseMs: e.pauseMs || 0,
            // T5：客户端靠这个判断"下一片是不是同一段的续片"（续片不插气口）
            pieceGroup: e.pieceGroup || '',
            pieceIndex: e.pieceIndex || 0,
            url: e.pauseMs ? '' : `${ROUTE_PREFIX}audio/${e.id}.wav`,
          };
        }

        if (path === '/pending') {
          const session = url.searchParams.get('session') || '';
          const sinceRaw = url.searchParams.get('since');
          if (sinceRaw === null) return sendJson(res, 200, { seq, items: [] });
          const since = Number(sinceRaw) || 0;
          const items = [...ledger.values()]
            // session 为空的条目是"广播"（提问/审批提醒，拿不到会话 id 时），任何会话都该收到
            .filter((e) => e.seq > since && (!session || e.session === session || !e.session))
            .sort((a, b) => a.seq - b.seq)
            .map(mapLedgerEntry);
          return sendJson(res, 200, { seq, items });
        }

        // 消息尾部的重播按钮用 —— 按 messageId 找到那一轮的账目
        /*
         * 1.2.4：**「重播最新一轮」的答案由宿主给**。
         *
         * 以前客户端自己从 `/pending?since=0` 里取"最后一条"，再按它的 `turn` 分组 ——
         * 而面板生成的音频（`kind:'gen'`）也在账目里、`turn` 常常是 0（它不属于任何回合），
         * 于是"重播最新一轮"变成"把 turn=0 的全部音频从头放一遍"（用户听到生成过的十几条依次播）。
         * 现在：只认 `kind:'speech'` 的最后一条；它的 `turn>0` 就把同一 turn 的播报一起给，
         * 否则只给这一条。找不到就回空数组，让客户端说"没有可重播的语音"。
         */
        if (path === '/replay') {
          const session = url.searchParams.get('session') || '';
          const mine = [...ledger.values()]
            .filter((e) => (!session || e.session === session))
            .sort((a, b) => a.seq - b.seq);
          const speeches = mine.filter((e) => (e.kind || 'speech') === 'speech' && !e.pauseMs);
          const last = speeches[speeches.length - 1];
          if (!last) return sendJson(res, 200, { turn: 0, session, seq, items: [], reason: 'no-speech' });
          const turn = Number(last.turn) || 0;
          const items = (turn > 0
            ? mine.filter((e) => Number(e.turn) === turn && ((e.kind || 'speech') !== 'gen'))
            : [last])
            .map(mapLedgerEntry);
          note('replay', `session=${session.slice(0, 8)} kind=speech turn=${turn} items=${items.length}`);
          return sendJson(res, 200, { turn, session, seq, items });
        }

        if (path === '/turn') {
          const message = url.searchParams.get('message') || '';
          const recorded = messageTurn.get(message);
          if (!recorded) {
            return sendJson(res, 404, { error: 'unknown message', message, items: [] });
          }
          // 以"这条消息自己所属的会话"为准，不信任调用方传的 session（换窗口后两者会不一致）
          const turn = recorded.turn;
          const session = recorded.session;
          const items = [...ledger.values()]
            .filter((e) => Number(e.turn) === turn && (!session || e.session === session))
            .sort((a, b) => a.seq - b.seq)
            .map(mapLedgerEntry);
          return sendJson(res, 200, { turn, session, seq, items });
        }

        /*
         * **客户端时间线回传**。
         *
         * 起因：同一段音频会被"整段拉两遍"，但浏览器那边发生了什么（同一个 `<audio>` 重拉？
         * 还是队列里真有两份、起了两个元素？）在宿主日志里完全看不到 —— 只有 `audio:serve` 两行。
         * 客户端现在把 `play / loadstart / end / error` 四类事件各写一行到这里，落到 `events.log` 的 `client:` 前缀下。
         * 只收一行短文本、限速 40 行/10 秒，防刷。
         */
        if (path === '/client-log' && req.method === 'POST') {
          const body = await readBody(req);
          const now = Date.now();
          if (now - clientLogWindow.at > 10000) clientLogWindow = { at: now, count: 0 };
          if (clientLogWindow.count < 40) {
            clientLogWindow.count += 1;
            const msg = String(body?.msg || '').replace(/[\r\n]+/g, ' ').slice(0, 200);
            if (msg) note('client', msg);
          }
          return sendJson(res, 200, { ok: true });
        }

        if (path === '/say' && req.method === 'POST') {
          const body = await readBody(req);
          const out = await speakOnce(body, body?.session || '');
          return sendJson(res, out.status === 'error' ? 502 : 200, out);
        }

        // ─────  期 2：角色卡 / 场景管理（面板用） ─────
        if (path === '/cards') {
          if (req.method === 'POST') {
            const body = await readBody(req);
            const file = body.file === 'cast' ? 'cast.json' : body.file === 'persona' ? 'persona.md' : '';
            if (!file) return sendJson(res, 400, { ok: false, error: 'invalid-file' });
            const text = String(body.text ?? '');
            const bytes = Buffer.byteLength(text, 'utf8');
            if (text.length > CARD_WRITE_MAX) {
              return sendJson(res, 400, { ok: false, error: 'too-large', limit: CARD_WRITE_MAX });
            }
            if (file === 'cast.json') {
              const reason = castShapeError(text);
              if (reason) return sendJson(res, 400, { ok: false, error: 'invalid-cast', detail: reason });
            }
            const target = String(body.target || 'global');
            let dir;
            if (target === 'global') {
              dir = dataDir();
            } else if (target.startsWith('scene:')) {
              const id = target.slice('scene:'.length);
              if (!isSafeSceneId(id)) return sendJson(res, 400, { ok: false, error: 'invalid-scene' });
              dir = await ensureScene(id);
            } else {
              return sendJson(res, 400, { ok: false, error: 'invalid-target' });
            }
            const out = join(dir, file);
            await backupOnce(out);
            await atomicWriteText(out, text);
            invalidateCardCaches();
            note('cards:save', `${target}/${file} bytes=${bytes}`);
            return sendJson(res, 200, { ok: true, target, file, bytes });
          }

          const target = url.searchParams.get('target') || '';
          if (target) {
            let dir;
            if (target === 'global') {
              dir = dataDir();
            } else if (target.startsWith('scene:')) {
              const id = target.slice('scene:'.length);
              if (!isSafeSceneId(id)) return sendJson(res, 400, { ok: false, error: 'invalid-scene' });
              dir = sceneDirOf(id);
            } else {
              return sendJson(res, 400, { ok: false, error: 'invalid-target' });
            }
            const readOne = async (name) => {
              const file = join(dir, name);
              try {
                const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
                return { path: file, text, bytes: info.size, mtime: info.mtimeMs };
              } catch {
                return { path: file, text: '', bytes: 0, mtime: 0, missing: true };
              }
            };
            return sendJson(res, 200, {
              ok: true,
              target,
              persona: await readOne('persona.md'),
              cast: await readOne('cast.json'),
              limits: { personaMax: CARD_WRITE_MAX, personaInjectMax: PERSONA_MAX_CHARS },
            });
          }

          const { ids } = listScenes();
          const activeId = activeSceneId();
          const scenes = [];
          for (const id of ids) {
            const dir = sceneDirOf(id);
            const sizeOf = async (name) => {
              try { return (await stat(join(dir, name))).size; } catch { return 0; }
            };
            let castCount = 0;
            try {
              const parsed = JSON.parse(String((await readFile(join(dir, 'cast.json'), 'utf8')) || '{}'));
              const raw = Array.isArray(parsed) ? parsed : parsed?.characters;
              castCount = Array.isArray(raw) ? raw.length : 0;
            } catch { /* 没有或坏了都算 0 */ }
            scenes.push({
              id,
              active: id === activeId,
              personaBytes: await sizeOf('persona.md'),
              castBytes: await sizeOf('cast.json'),
              castCount,
            });
          }
          let globalInfo = { path: join(dataDir(), 'persona.md'), bytes: 0, mtime: 0 };
          try {
            const info = await stat(globalInfo.path);
            globalInfo = { ...globalInfo, bytes: info.size, mtime: info.mtimeMs };
          } catch { /* 还没有全局卡 */ }
          return sendJson(res, 200, {
            ok: true,
            active: activeId || '_default',
            global: globalInfo,
            scenes,
            limits: { personaMax: CARD_WRITE_MAX, personaInjectMax: PERSONA_MAX_CHARS },
          });
        }

        if (path === '/scenes' && req.method === 'POST') {
          const body = await readBody(req);
          const action = String(body.action || '');
          const before = listScenes().ids;
          const wasActive = activeSceneId();

          if (action === 'create') {
            const id = String(body.id || '').trim();
            if (!isSafeSceneId(id)) return sendJson(res, 400, { ok: false, error: 'invalid-id' });
            if (before.includes(id)) return sendJson(res, 409, { ok: false, error: 'exists' });
            await ensureScene(id);
            setActiveScene(id); // 新建即设为当前：用户点"新建"就是要用这一局
            invalidateCardCaches();
            note('scene:create', id);
            return sendJson(res, 200, { ok: true, active: activeSceneId(), ids: listScenes().ids });
          }

          if (action === 'rename') {
            const id = String(body.id || '');
            const newId = String(body.newId || '').trim();
            if (!isSafeSceneId(id) || id === '_default') return sendJson(res, 400, { ok: false, error: 'invalid-id' });
            if (!before.includes(id)) return sendJson(res, 404, { ok: false, error: 'not-found' });
            if (!isSafeSceneId(newId)) return sendJson(res, 400, { ok: false, error: 'invalid-new-id' });
            if (before.includes(newId)) return sendJson(res, 409, { ok: false, error: 'exists' });
            await rename(sceneDirOf(id), sceneDirOf(newId));
            if (wasActive === id) setActiveScene(newId);
            else if (wasActive === '_default' || !wasActive) setActiveScene('');
            invalidateCardCaches();
            note('scene:rename', `${id} → ${newId}`);
            return sendJson(res, 200, { ok: true, active: activeSceneId() || '_default', ids: listScenes().ids });
          }

          if (action === 'delete') {
            const id = String(body.id || '');
            if (!isSafeSceneId(id) || id === '_default') return sendJson(res, 400, { ok: false, error: 'invalid-id' });
            if (!before.includes(id)) return sendJson(res, 404, { ok: false, error: 'not-found' });
            await mkdir(trashDir, { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const moved = join(trashDir, `${id}-${stamp}`);
            await rename(sceneDirOf(id), moved);
            if (wasActive === id) setActiveScene('');
            invalidateCardCaches();
            note('scene:delete', `${id} → _trash/${id}-${stamp}`);
            return sendJson(res, 200, { ok: true, active: activeSceneId() || '_default', ids: listScenes().ids, trash: moved });
          }

          if (action === 'activate') {
            const id = String(body.id || '');
            if (id !== '_default' && !isSafeSceneId(id)) return sendJson(res, 400, { ok: false, error: 'invalid-id' });
            if (!setActiveScene(id === '_default' ? '' : id)) return sendJson(res, 404, { ok: false, error: 'not-found' });
            invalidateCardCaches();
            note('scene:switch', id);
            return sendJson(res, 200, { ok: true, active: activeSceneId() || '_default', ids: listScenes().ids });
          }

          return sendJson(res, 400, { ok: false, error: 'unknown-action' });
        }

        if (path === '/open' && req.method === 'POST') {
          const body = await readBody(req);
          const target = String(body.target || '');
          const root = dataDir();
          let dir;
          if (target === 'data') dir = root;
          else if (target === 'scenes') dir = join(root, 'scenes');
          else if (target === 'cache') dir = join(root, 'cache');
          // G5（1.0.9）：垃圾桶 —— 面板那行「打开垃圾桶」用（它在 dataDir 之内，走的是普通校验）
          else if (target === 'gen-trash') dir = trashDirPath();
          // G1：生成页的「在文件夹中显示」——输出目录可能在 dataDir 之外（用户自己填的），
          // 所以这里**只认 generatedDir() 本身**，不接受任何拼出来的子路径。
          else if (target === 'generated') dir = generatedDir();
          else if (target.startsWith('scene:')) {
            const id = target.slice('scene:'.length);
            if (!isSafeSceneId(id)) return sendJson(res, 400, { ok: false, error: 'invalid-scene' });
            dir = sceneDirOf(id);
          } else {
            return sendJson(res, 400, { ok: false, error: 'invalid-target' });
          }
          // 双保险：拼出来的路径必须还在 dataDir 之内（防 `..` 之类的手滑）。
          // G1 例外：生成页的输出目录**允许在 dataDir 之外**（用户自己填的），但只认 `generatedDir()` 这一个值，
          // 不接受任何拼出来的子路径 —— 也就是说这里放行的仍然是"配置里的那个目录"，不是任意路径。
          const norm = (value) => String(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
          if (target !== 'generated' && !norm(dir).startsWith(norm(root))) return sendJson(res, 400, { ok: false, error: 'outside-data-dir' });
          await mkdir(dir, { recursive: true });
          try {
            const opener = process.platform === 'win32' ? 'explorer.exe' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
            const child = spawn(opener, [dir], { detached: true, stdio: 'ignore' });
            child.unref();
            note('open:folder', dir);
            return sendJson(res, 200, { ok: true, path: dir });
          } catch (error) {
            return sendJson(res, 500, { ok: false, error: String((error && error.message) || error) });
          }
        }

        /*
         * G6：**把一段 wav 发给浏览器**，支持 Range，并留下"这次到底发了什么"。
         *
         * 为什么非改不可：原来一律 `accept-ranges: none` + 200 全量。媒体元素要跳读时
         * （缓冲不足、解码器重置、Chrome 自己决定重开），拿不到 206 就只能**从 0 再来一次** ——
         * 用户听到的就是"播到一半刺啦一下、然后重来 / 变长"。实测证据：同一条音频被整段拉了两次，
         * 两次相隔 8.2 s，而那段播放时长比音频本身长 8 s。
         * 现在：`accept-ranges: bytes` + 正经的 206 / 416，媒体栈要哪段给哪段。
         *
         * 同时留痕：请求进来记 `audio:req <tag> range=…`；正常写完记 `audio:send`；
         * **连接在写完之前就断了**记 `audio:abort`（这行是"浏览器中途放弃"的直接证据，以前完全没有）。
         */
        function sendWav(req, res, buf, tag) {
          const total = buf.length;
          const rangeRaw = String((req.headers && req.headers.range) || '').trim();
          let status = 200;
          let start = 0;
          let end = total - 1;
          let unsatisfiable = false;
          if (rangeRaw) {
            const m = /^bytes=(\d*)-(\d*)$/.exec(rangeRaw);
            if (m) {
              if (m[1] === '' && m[2] !== '') {
                // `bytes=-N`：最后 N 字节
                const n = Number(m[2]);
                start = Math.max(0, total - n);
                end = total - 1;
              } else if (m[1] !== '') {
                start = Number(m[1]);
                end = m[2] === '' ? total - 1 : Number(m[2]);
              }
              if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) unsatisfiable = true;
              else {
                status = 206;
                end = Math.min(end, total - 1);
              }
            }
            // 语法不认识（多段 range 等）：按 RFC 可以忽略 Range、直接给整段
          }
          note('audio:req', `${tag} range=${rangeRaw || '-'}`);
          if (unsatisfiable) {
            note('audio:req-reject', `${tag} 416 range=${rangeRaw} total=${total}`);
            res.writeHead(416, {
              'content-range': `bytes */${total}`,
              'cache-control': 'no-store',
              'accept-ranges': 'bytes',
            });
            return res.end();
          }
          const body = status === 206 ? buf.subarray(start, end + 1) : buf;
          // `typeof` 兜一层：自测用的假 res 没有 `.on`（没这一层，spike 里直接 TypeError）
          if (typeof res.on === 'function') {
            res.on('close', () => {
              // `writableFinished` 为假 = 没写完就断了 —— "浏览器中途放弃"的硬证据
              if (!res.writableFinished) note('audio:abort', `${tag} total=${total} status=${status}`);
            });
          }
          const headers = {
            'content-type': 'audio/wav',
            'content-length': body.length,
            'cache-control': 'no-store',
            'accept-ranges': 'bytes',
          };
          if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${total}`;
          res.writeHead(status, headers);
          if (req.method === 'HEAD') return res.end();
          res.end(body);
          note('audio:send', `${tag} status=${status} bytes=${body.length}${status === 206 ? ` of=${total}` : ''}`);
        }

        if (path.startsWith('/audio/')) {
          const id = path.slice('/audio/'.length).replace(/\.wav$/, '');
          const entry = ledger.get(id);
          if (!entry) return sendJson(res, 404, { error: 'unknown audio id' });

          /** 整段给药：带 content-length，浏览器知道自己拿到了多少，不会在任何中间态上瞎猜。 */
          const serveFile = async (why) => {
            const raw = await readFile(entry.file).catch(() => null);
            if (!raw) return sendJson(res, 404, { error: 'audio file missing' });
            /*
             * **无条件**过一遍 normalizeWav。
             *
             * 根因找到了：MiniMax 在每个 WAV 的 `data` 块**后面**又写了一个 `AIGC` 块
             * （1078 字节 JSON 元数据，合规水印）。桌面播放器读到 `data` 长度就停，所以本地听着是干净的；
             * 浏览器会把 `data` 之后那 1086 字节继续当音频解，于是尾部（以及每段收尾）出现刺耳呲拉声。
             *
             * `normalizeWav()` 对"只有 fmt + data"的标准文件**原样返回**（缓存里 374 个文件里 366 个原样不动，
             * 只有 8 个 MiniMax 产出的被裁剪），所以这里可以无条件调，不必看引擎类型。
             */
            const buf = normalizeWav(raw);
            const trimmed = raw.length - buf.length;
            note('audio:serve', `${id} ${why} bytes=${buf.length}${trimmed > 0 ? ` trimmed=${trimmed}` : ''}`);
            return sendWav(req, res, buf, `${id}:${why}`);
          };

          // ① 已完成（含缓存命中）：整段给出去，带 content-length，浏览器可 seek
          if (entry.done && entry.file) return serveFile('file');

          // ② 合成失败：明确告诉客户端，别让它等一个永远不来的流
          if (entry.done) return sendJson(res, 502, { error: entry.error || 'synthesis failed' });

          /*
           * ③ ：**云端引擎不再走 chunked**。
           *
           * 用户实测：MiniMax 那几轮播到一半和收尾处有刺耳呲拉声，但同一份缓存文件在本地播放器里是干净的。
           * 差别就在这里 —— 云端本来就是"整段返回"，我们却把它伪装成流式发给浏览器：
           * 分块响应没有 content-length，浏览器对"还不知道总长的 WAV"处理方式各异
           * （MiniMax 的 WAV 里还带一个 LIST/INFO 附加块），于是尾部被解成杂音。
           * 现在云端一律**等合成完成 → 带 content-length 整段给**，与本机缓存文件完全一致。
           * 真正需要边生成边播的只有本机 BreezeTTS（它的 wav 头本来就是占位长度，适合流式）。
           */
          if (tts.engine.kind !== 'breeze') {
            const deadline = Date.now() + Math.max(20000, Number(tts.engine.timeoutMs) || 120000);
            while (!entry.done && Date.now() < deadline) {
              await new Promise((resolve) => {
                entry.wake = resolve;
                setTimeout(resolve, 150);
              });
            }
            if (entry.done && entry.file) return serveFile('waited');
            if (entry.done) return sendJson(res, 502, { error: entry.error || 'synthesis failed' });
            return sendJson(res, 504, { error: 'synthesis timeout' });
          }

          // ④ 本机引擎：正在流式合成，边到边写（chunked），浏览器边下边播
          note('audio:serve', `${id} stream`);
          res.writeHead(200, {
            'content-type': 'audio/wav',
            'cache-control': 'no-store',
            'accept-ranges': 'none',
          });
          let written = 0;
          for (;;) {
            while (written < entry.chunks.length) {
              const chunk = entry.chunks[written];
              written += 1;
              try {
                res.write(chunk);
              } catch {
                return res.end();
              }
            }
            if (entry.done) break;
            await new Promise((resolve) => {
              entry.wake = resolve;
              setTimeout(resolve, 250);
            });
          }
          return res.end();
        }

        return sendJson(res, 404, { error: 'not found' });
      } catch (error) {
        tts.lastError = String((error && error.message) || error);
        ctx.logger?.warn?.(`${TAG} 路由异常: ${tts.lastError}`);
        return sendJson(res, 500, { error: tts.lastError });
      }
    }

    /** 把「为什么客户端半没加载」写成一份可读报告，避免盲猜重启。 */
    async function dumpDiagnostics() {
      const report = {
        at: new Date().toISOString(),
        cwd: process.cwd(),
        profile: process.env.DSH_PROFILE || null,
        profileDir: process.env.DSH_PROFILE_DIR || null,
      };
      const bases = [import.meta.url];
      try {
        report.profilePackage = join(homedir(), '.dsh', 'profiles', 'desktop', 'package.json');
        bases.push(report.profilePackage);
      } catch { /* ignore */ }
      for (const base of bases) {
        for (const spec of [
          'dsh-voice-lilt',
          'dsh-voice-lilt/client',
          'dsh-voice-lilt/client.js',
          'dsh-voice-lilt/package.json',
        ]) {
          const key = `resolve[${base === import.meta.url ? 'self' : 'profile'}] ${spec}`;
          try {
            report[key] = createRequire(base).resolve(spec);
          } catch (error) {
            report[key] = `ERR ${error && error.code}: ${error && error.message}`;
          }
        }
      }
      try {
        const service = ctx.get('clientModules');
        report.hasClientModules = Boolean(service);
        if (service && typeof service.graph === 'function') {
          const graph = service.graph();
          report.graphKeys = graph && typeof graph === 'object' ? Object.keys(graph) : typeof graph;
          report.graph = graph;
        } else if (service) {
          report.serviceKeys = Object.keys(service);
        }
      } catch (error) {
        report.graphError = String((error && error.message) || error);
      }
      report.problems = lastProblems;
      try {
        report.origin = ctx.webServer.getOrigin();
      } catch (error) {
        report.originError = String((error && error.message) || error);
      }
      if (report.origin) {
        try {
          const res = await fetch(new URL('/voice-breeze/state', report.origin), { signal: AbortSignal.timeout(3000) });
          report.selfTest = {
            status: res.status,
            // 403 也算“路由活着”：准入层会把宿主裸请求当非浏览器请求挡掉
            alive: res.status === 200 || res.status === 403,
            body: (await res.text()).slice(0, 300),
          };
        } catch (error) {
          report.selfTest = { error: String((error && error.message) || error) };
        }
      }
      try {
        await mkdir(dataDir(), { recursive: true });
        await writeFile(join(dataDir(), 'client-graph.json'), JSON.stringify(report, null, 2), 'utf8');
      } catch (error) {
        ctx.logger?.warn?.(`${TAG} 诊断写入失败: ${error && error.message}`);
      }
    }

    ctx.effect(() => {
      const timer = setTimeout(() => { void dumpDiagnostics(); }, 2500);
      return () => clearTimeout(timer);
    });

    ctx.effect(() => {
      let offRoute;
      let offTool;
      let offProbe;
      let offInstall;
      let offInstallStatus;
      let offTest;
      let offPreset;
      let offSaveVoice;
      let offState;
      let offCard;
      let offGenerate;
      let offQuestion;
      let offApproval;
      let offSection;
      let offEvents;
      let offStopping;
      let offCreated;
      let offDisposed;
      const extras = [];
      loadHistory(); // 把上次运行留下的账目读回内存，重启后重播仍可用
      const problems = [];
      lastProblems = problems;
      try {
      // restore() 读完盘之后**必须重建适配器**。
      // cfg 里是代码默认值（active='breeze'），而 `rebuildTts()` 在 apply 时就跑了一次；
      // 不重建的后果是「盘上 `state.json` 明明写着 active=sf，运行时却一直在用本机引擎」——
      // 2026-11-16 就是这样：`/state` 回 breeze、`/engine` 回 sf，两个真相打架。
      void restore().then(() => { pruneSceneIndex(); rebuildTts(); }).catch(() => { /* 恢复失败也要能起来 */ });

      const routeHandler = (req, res) => { void handler(req, res); };
      // webServer 的 prefix 匹配规则是 `pathname === prefix || pathname.startsWith(prefix + '/')`，
      // 所以 prefix 必须**不带**尾斜杠。写成 '/voice-breeze/' 会让所有子路径永远匹配不上，
      // 而且 register() 只查重复、不会报错——“注册成功但永不命中”正是之前的 404 根因。
      try {
        offRoute = ctx.webServer.register({ kind: 'prefix', path: '/voice-breeze', handler: routeHandler });
        problems.push('route ok: prefix /voice-breeze');
      } catch (error) {
        problems.push(`route fail prefix /voice-breeze: ${(error && error.code) || ''} ${(error && error.message) || error}`);
      }
      if (!offRoute) {
        for (const exact of ['/voice-breeze/state', '/voice-breeze/pending', '/voice-breeze/say', '/voice-breeze/voices']) {
          try {
            extras.push(ctx.webServer.register({ kind: 'exact', path: exact, handler: routeHandler }));
            problems.push(`route ok: exact ${exact}`);
          } catch (error) {
            problems.push(`route fail exact ${exact}: ${(error && error.message) || error}`);
          }
        }
      }

      // 工具注册整段兜底。 加进来的四个 tts_* 工具里只要有一个被宿主判为非法，
      // 后面的 section 与三条 session/event 监听就全都不会执行——播报和日志一起消失。
      try {
      problems.push('tool: start speak');
      offTool = ctx.tools.register({
        name: 'speak',
        description: [
          '用本机 BreezeTTS 音色把一句短话说出来，音频会在 DSH 窗口里自动播放一次。',
          '只在语音播报开启时用；这句话是给用户“听”的，不是给用户“读”的。',
          '一次只念一段，**长度只由一个依据决定：当前播报强度**（`weak` / `medium` / `strong`）。**当前是哪一档、这一轮的目标与上限，看 `tts_state` 的返回**，其次看每次 `speak` 返回里的 `strength` / `target` / `limit`——系统提示词里印的数字可能陈旧（实测：中途改档后同一会话内不刷新），不要只信它；摘要与全文档另有固定上限（默认 240 字）；',
          '绝不念代码、路径、表格、长段落，也不要复述刚写过的整段回复。',
          '**开启了多音色扮演时，必须用 `segments` 多段提交并给每段写 `speaker`**；单段 `text` 只会用主角色的嗓子念出来。',
          '**没开多音色时** 写不写 `speaker` / `voice` 都一样，只会用当前选中的那一把嗓子（`speaker` 仅作标注，不换声音）。',
          '**每轮收尾前检查一次** 这一轮如果还没调过 `speak`，先补一次再结束（调过多个工具、或中途重来的轮次尤其容易漏）。',
          '文本里可以写 `[停顿3秒]`（或 `[停顿1.5秒]`）表示气口，插件会静默等待，不会把标记念出来。',
          '典型时机：给出结论、需要用户拍板、任务跑完、出错卡住。返回 muted 表示当前已关闭语音，不要重试；返回 skipped 表示当前是「全文」模式（正文由插件从头念一遍），同样不要重试。',
          '**设计音色** 用户要"换一把嗓子/设计一个音色"时，用一次 `segments` 提交 3~6 个候选——每段 `voice:""`、`tone` 写同一句音色描述、`seed` 各不相同、`text` 同一句话；让用户报序号，再按他选的那段把 `tone` + `seed` 记下来（写进 cast.json，或 `voice` 留空 + `instructions` + `seed`）。别自己替用户定嗓子。',
          '**只写这个角色自己要说的话**（第一人称对话）：**不要**写旁白、动作、表情、神态、环境（“她把笔记本推过来”“指尖按住那行”这类一律不写）——那些属于正文，不属于语音；语音里只留“这个人正在对我说的话”。',
          '**长度标准表**（这是标准，不是当前值；当前值见 `tts_state`）：角色扮演 + AI 即兴下 **弱 80~160 字 / 1 段**、**中 320~520 字 / 1~3 段**、**强 640~900 字 / ≥2 段**；非角色扮演档是 **弱 20~40 / 中 40~120 / 强 120~240 字**。方向一致：档越强，说得越长。**中、强两档目前没有字数上限**（显式决定，不是漏项），弱档的上限 160 只作规范、宿主暂不裁剪；段数上限由宿主执行——超了会把多出来的段合进最后一段，一个字都不丢。',
          '**平时不要写 `segments[].voice`** 那一项是给"设计音色试听 / 用户明确要求换嗓子"用的。普通播报一律不写 voice，让插件按界面选的那把嗓子念——写了就会盖掉用户的选择。',
          '**一次性的风格参数** `emotion` / `speed` / `vol` / `pitch` / `voiceModify` **只作用于这一次合成**——不写盘、不用改面板，下一次不传就回到面板的全局风格。想按情景调这一句（急一点 / 沉一点 / 电话音）就直接传；这家引擎认不认识看 `tts_state` 的 `engineHints`，不认识的会被插件擦掉、不会报错。',
        ].join(''),
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要念出来的中文短句，建议 ≤ 60 字，不要含 Markdown、代码或文件路径。' },
            instructions: { type: 'string', description: '可选：语气/情绪描述，例如「更慢一点，语气严肃」。' },
            cfg_scale: { type: 'number', description: '可选：指令跟随强度（2~3 常用，越大越贴指令但可能刺耳）。' },
            /*
             * G0（0.96.0）：一次性风格参数。**只作用于这一次合成**——不写 state.json、不改面板的全局风格，
             * 下一次不传就回到全局值（合并顺序 overrides > style > cfg）。所以这里没有开关，也没有"恢复"这一步。
             * 这家引擎认不认识由 `engineCaps()` 判、`sanitizeForEngine()` 在发出去之前擦掉（`03` §2.9.3）。
             */
            emotion: { type: 'string', description: '可选：这一次合成的情绪档。只有当前引擎支持的情绪才生效（清单见 `tts_state.engineHints`）；不传就按面板的全局风格。' },
            speed: { type: 'number', description: '可选：这一次的语速（0.5~2，1=原速）。**想说得"慢"必须动它**——情绪档里没有"更慢"这一项（`calm` 压的是语调，不是时长）。' },
            vol: { type: 'number', description: '可选：这一次的音量（0.01~10，1=原音量）。' },
            pitch: { type: 'number', description: '可选：这一次的音调（-12~12，0=原调；负=更低沉）。' },
            voiceModify: {
              type: 'object',
              description: '可选：这一次的音色微调（低沉稳一点、"电话音效"之类）。不认识的引擎会整块丢掉，不会报错。',
              properties: {
                pitch: { type: 'number', description: '-100~100；正=更亮，负=更低沉' },
                intensity: { type: 'number', description: '-100~100；改动强度' },
                timbre: { type: 'number', description: '-100~100；音色明暗' },
                soundEffects: { type: 'string', description: '音效名，例如 spacious_echo / auditorium_echo / lofi_telephone / robotic' },
              },
              additionalProperties: false,
            },
            segments: {
              type: 'array',
              description: '可选：一次提交整轮多段演出（角色扮演推荐）。每段可指定 speaker（查 cast.json 取音色）与 tone。**设计音色试听** 每段写 `voice: ""` + `tone`（音色描述）+ 各不相同的 `seed`，一次就能听完多个候选嗓子。',
              items: {
                type: 'object',
                properties: {
                  speaker: { type: 'string', description: '谁在说（要能在 cast.json 里对上）' },
                  voice: { type: 'string', description: '可选：直接指定音色 id（必须存在于声音库）；**传空串 ＝ 设计模式**，按 tone 现造一把嗓子' },
                  seed: { type: 'number', description: '可选：设计模式的随机种子。同描述 + 同种子 = 同一把嗓子，换种子 = 换一把' },
                  tone: { type: 'string', description: '这一段怎么说（情绪/语速；设计模式下它就是音色描述）' },
                  text: { type: 'string', description: '这段要说的话' },
                },
                required: [],
                additionalProperties: false,
              },
            },
          },
          required: [],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              chars: { type: 'number' },
              ms: { type: 'number' },
              cached: { type: 'boolean' },
              segments: { type: 'number' },
              reason: { type: 'string' },
              expanded: { type: 'boolean' },
              narrationMode: { type: 'string' },
              fallback: { type: 'string' },
              multiVoice: { type: 'boolean' },
              cardDirty: { type: 'boolean' },
              strength: { type: 'string' },
              target: { type: 'number' },
              limit: { type: 'number' },
              note: { type: 'string' },
            },
          },
          render: (args, value) => {
            const v = value || {};
            // 卡片统一带上**当前档位 / 目标 / 上限**——模型和人都能一眼看到"这句是照哪一档说的"。
            // （提示词在会话内不刷新实测；所以这一行就是唯一可靠的档位回执。）
            const tag = [
              v.strength ? `强度=${v.strength}` : '',
              v.target ? `目标≈${v.target}字` : '',
              v.limit ? `上限${v.limit}字` : '',
            ].filter(Boolean).join(' · ');
            const suffix = `${tag ? ` · ${tag}` : ''}${v.cardDirty ? ' · 📖 角色卡已改，先调 tts_card 重读' : ''}`;
            // 扩写的结果同样是 status:'queued'，所以这一条必须判在 queued 之前，
            // 否则"按强度扩写后念"永远显示成普通的"已念（N 字）"，看卡片分不出有没有扩写。
            if (v.expanded) return [{ type: 'text', text: `🔈 按强度扩写后念（${v.chars} 字${suffix}）` }];
            if (v.status === 'queued') {
              return [{
                type: 'text',
                // `note` 里可能是"上次有 N 句没念成"——必须显示出来，
                // 否则"已念"这三个字会在引擎没起来的时候变成谎话。
                text: `🔈 已念（${v.chars} 字${v.ms ? `, ${v.ms}ms` : ''}${v.cached ? ', 缓存' : ''}${suffix}）${v.note ? ` · ${v.note}` : ''}`,
              }];
            }
            if (v.status === 'muted') return [{ type: 'text', text: '🔇 语音播报已关闭，这句没有出声' }];
            if (v.status === 'skipped') return [{ type: 'text', text: '📄 全文模式：这句不用单独念，正文会由插件从头念一遍' }];
            if (v.note) return [{ type: 'text', text: `🔈 已念（${v.chars} 字）· ${v.note}` }];
            if (v.status === 'starting') {
              // 顺手把"上次没念成"的旧账也带上，别让这两条信息互相盖住
              return [{ type: 'text', text: `⏳ BreezeTTS 正在启动，起来后自动补念（${v.chars} 字）${v.note ? ` · ${v.note}` : ''}` }];
            }
            return [{ type: 'text', text: `语音失败：${v.reason || '未知原因'}` }];
          },
        },
        async execute(args, exec) {
          if (!cfg.enabled) return { status: 'muted', chars: 0 };
          // （裁决）：**全文模式由插件通读正文**，模型在这一档调 speak 一律不合成、也不标 spoke，
          // 直接把正文留给 turn/end 的兜底念一遍。这样"念一遍、不多不少"不依赖模型听话：
          // 提示词已经说过不要调，万一调了，也只会回到同一遍全文，不会多出第二遍。
          if (cfg.fallback === 'full') {
            const raw = Array.isArray(args?.segments)
              ? args.segments.map((seg) => String(seg?.text || '')).join('')
              : String(args?.text || '');
            note('speak:skip-full', `chars=${raw.length} segments=${Array.isArray(args?.segments) ? args.segments.length : 0}`);
            return {
              status: 'skipped',
              chars: 0,
              reason: '全文模式：插件会把正文从头念一遍，这次 speak 已被忽略，不要重试',
            };
          }
          const sessionId = exec?.agent?.id ? String(exec.agent.id) : '';
          // G0（0.96.0）：这一次调用要用的风格（没有就是空对象 = 完全按面板的全局风格）。
          const callStyle = pickCallStyle(args);
          const styleArg = Object.keys(callStyle).length ? callStyle : undefined;
          // **强度必须真的生效**——角色扮演 + 即兴时，模型自己 speak 偏短就当场按正文扩写（Q24）。
          // 扩写用同一条 verbalize 通道（素材是这一轮正文，不是插件编的话）；正文还没写完就只把目标回给模型。
          let strengthNote = '';
          const rplan = cfg.fallback === 'roleplay' ? (ROLEPLAY_STRENGTHS[cfg.strength] || ROLEPLAY_STRENGTHS.medium) : null;
          if (cfg.fallback === 'roleplay' && cfg.narrationMode === 'adapted') {
            const want = Number(rplan.targetChars) || 0;
            // 扩写门槛改成显式字段 `expandBelow`（强 420 / 中 252）；**弱档不给这个字段 = 不做扩写**。
            const floor = Number(rplan.expandBelow) || 0;
            const got = String(args?.text || '').length + (Array.isArray(args?.segments) ? args.segments.reduce((sum, seg) => sum + String(seg?.text || '').length, 0) : 0);
            if (floor && want && got > 0 && got < floor) {
              const bodyLen = String(turnState.get(sessionId)?.text || '').length;
              if (bodyLen >= want * 0.5) {
                const turn = turnState.get(sessionId);
                const expanded = await verbalize(turn, {});
                if (expanded.segments.length) {
                  let sum = 0;
                  for (const seg of expanded.segments) {
                    const text = String(seg.text || '').trim();
                    if (!text) continue;
                    const spec = await resolveSegmentVoice({ speaker: seg.speaker, voice: seg.voice, instructions: seg.tone }, sessionId);
                    await enqueueLine(text, sessionId, spec, { instructions: seg.tone || undefined, style: styleArg, turn });
                    sum += text.length;
                  }
                  if (sum) {
                    note('speak:expanded', `strength=${cfg.strength} from=${got} to=${sum} target=${want}`);
                    if (turn) turn.spoke = true;
                    return stripUndefined({ status: 'queued', chars: sum, segments: expanded.segments.length, expanded: true, strength: cfg.strength, target: want });
                  }
                }
                note('speak:expand-failed', `strength=${cfg.strength} chars=${got} target=${want}`);
              } else {
                note('speak:short', `strength=${cfg.strength} chars=${got} target=${want} body=${bodyLen}`);
                strengthNote = `这一轮 ${got} 字，强度=${cfg.strength} 目标约 ${want} 字、至少 ${rplan.minSegments || 1} 段：正文还没写完时请直接用 segments 提交更长的内容。`;
              }
            }
          }
          if (!Array.isArray(args?.segments) && !String(args?.text || '').trim()) {
            return { status: 'error', chars: 0, reason: 'text 与 segments 至少要有一个' };
          }
          // 一次提交整轮：segments[] → 逐段解析音色、逐段入队
          if (Array.isArray(args?.segments) && args.segments.length) {
            // **段数上限**（弱 1 / 中 3 / 强不限，裁决）。超了就把多出来的段**合进最后一段**——
            // 一个字都不少，只改"谁单独成段"，所以听感是连续的一段而不是两段；日志 `speak:merged-segments`。
            // 2026-11-18：合并实现收进 `lib/tts.mjs` 的 `mergeSegmentsDown()`，与兜底/即兴那条路共用 ——
            // 之前两条路各写一遍（一条有、一条没有），正是"角色扮演+弱强度播出九段"的成因。
            const maxSeg = Number(rplan?.maxSegments) || 0;
            const segs = mergeSegmentsDown(args.segments, maxSeg);
            if (segs !== args.segments) {
              note('speak:merged-segments', `from=${args.segments.length} to=${segs.length} strength=${cfg.strength} max=${maxSeg} chars=${segs.reduce((n, one) => n + String(one?.text || '').length, 0)}`);
            }
            let totalChars = 0;
            let queuedCount = 0;
            let startingCount = 0;
            const trace = [];
            for (const seg of segs) {
              const text = String(seg?.text || '').trim();
              if (!text) continue;
              const spec = await resolveSegmentVoice(
                { speaker: seg.speaker, voice: seg.voice, instructions: seg.tone },
                sessionId,
              );
              // **设计音色试听**。显式给 `voice: ''` = 这一段走设计模式（按 tone 现造嗓子），
              // 显式给 `seed` = 换一把随机种子（同种子可复现）。两者都只在这一段生效——
              // 段里没写就完全按老规矩（cast → 会话记忆 → 全局默认，见裁决/Q18）。
              if (seg && typeof seg.voice === 'string') spec.voice = seg.voice.trim();
              if (seg && Number.isFinite(Number(seg.seed))) spec.seed = Number(seg.seed);
              // 工具路径也逐段记账——事后能查"这一段到底用了哪把嗓子"
              trace.push(`${seg?.speaker || '-'}:${spec.voice || '设计模式'}`);
              note('segment', `via=speak who=${seg?.speaker || '-'} voice=${spec.voice || '设计模式'} seed=${spec.seed ?? '-'} tone=${JSON.stringify((spec.instructions || '').slice(0, 40))} chars=${text.length}`);
              const ones = await enqueueLine(text, sessionId, spec, { instructions: seg.tone || undefined, style: styleArg });
              let accepted = false;
              for (const one of ones) {
                if (one.status === 'queued' || one.status === 'starting') {
                  queuedCount += 1;
                  if (one.status === 'starting') startingCount += 1;
                  totalChars += Number(one.chars) || 0;
                  accepted = true;
                }
              }
              if (accepted) markSpoken(sessionId, text);
            }
            note('speak', `segments=${queuedCount} chars=${totalChars} voices=${trace.join(',') || '-'} strength=${cfg.strength} engine=${tts.engine.id} style=${Object.keys(callStyle).join('+') || '-'} status=${startingCount === queuedCount ? 'starting' : 'queued'}`);
            const state = turnState.get(sessionId);
            if (state && queuedCount) state.spoke = true;
            if (!queuedCount) return { status: 'error', chars: 0, segments: 0, reason: '没有任何可念的段' };
            // **把当前档位回给模型**。
            return stripUndefined({
              // **引擎没起来时不能再报"已念"**。
              // 以前这一段把 `starting` 一律压成 `queued`，模型和用户都以为发出去了
              // （实测：杀了引擎仍然显示"🔈 已念（35 字）"）。现在原样透出去，卡片才会说"起来后自动补念"。
              status: startingCount === queuedCount ? 'starting' : 'queued',
              chars: totalChars,
              segments: queuedCount,
              narrationMode: cfg.fallback === 'roleplay' ? cfg.narrationMode : undefined,
              // 每次说话都顺手把"当前模式 / 多音色 / 卡有没有改过"带回给模型——
              // 省掉"模型懒得调 tts_state 就一直按旧设置说话"的那条路。
              fallback: cfg.fallback,
              multiVoice: !!cfg.multiVoice,
              cardDirty: refreshCardDirty() || undefined,
              engine: tts.engine.id,
              strength: rplan ? cfg.strength : undefined,
              target: rplan ? Number(rplan.targetChars) || undefined : undefined,
              limit: rplan && Number(rplan.maxChars) ? Number(rplan.maxChars) : undefined,
              note: voiceFailureNote() || undefined,
            });
          }

          const ones = await enqueueLine(String(args?.text || ''), sessionId, undefined, {
            instructions: args?.instructions,
            cfg_scale: args?.cfg_scale,
            style: styleArg,
          });
          const voices = ones.filter((one) => !one.pauseMs);
          // `starting` 不能再被压成 `queued` —— 引擎没起来时那句其实还没合成。
          const allStarting = voices.length > 0 && voices.every((one) => one.status === 'starting');
          const result = stripUndefined({
            status: voices.some((one) => one.status === 'queued')
              ? 'queued'
              : (allStarting ? 'starting' : (voices[0]?.status || 'error')),
            chars: ones.reduce((sum, one) => sum + (Number(one.chars) || 0), 0),
            segments: voices.length,
            reason: voices.find((one) => one.status === 'error')?.reason,
            strength: rplan ? cfg.strength : undefined,
            target: rplan ? Number(rplan.targetChars) || undefined : undefined,
            limit: rplan && Number(rplan.maxChars) ? Number(rplan.maxChars) : undefined,
            note: [strengthNote, voiceFailureNote()].filter(Boolean).join(' · ') || undefined,
            engine: tts.engine.id,
          });
          // 日志里 `voice=` 是"请求的嗓子"（界面/模型要的），`sent=` 是**实际发给引擎的**——
          // 云端下这两者会不一样（本机音色名在云端不存在，会被换成 defaultVoice 或干脆不发）。
          const requestedVoice = overridesForLog(args, sessionId) || '-';
          const sentVoice = voiceForEngine(overridesForLog(args, sessionId)) || '(不发)';
          note('speak', `chars=${result.chars || 0} voice=${requestedVoice} sent=${sentVoice} strength=${cfg.strength} engine=${tts.engine.id} style=${Object.keys(callStyle).join('+') || '-'} status=${result.status}`);
          if (result.status === 'queued' || result.status === 'starting') {
            const state = turnState.get(sessionId);
            if (state) state.spoke = true;
            markSpoken(sessionId, args?.text);
          }
          return result;
        },
      });


      /* ───────── 安装引导的三个工具（· M1） ───────── */

      problems.push('tool: start tts_probe');
      offProbe = ctx.tools.register({
        name: 'tts_probe',
        description: [
          '探测本机能不能跑 BreezeTTS2：显卡与显存、内存、Vulkan 运行库、各盘剩余空间，并给出推荐档位。',
          '安装引导的第一步就是它——先探测，再按结果给用户 2~3 个可选档位（附体积与显存要求），让用户自己选。',
        ].join(''),
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              hardware: { type: 'object' },
              recommend: { type: 'object' },
              lock: { type: 'object' },
              hint: { type: 'string' },
            },
          },
          render: (args, value) => {
            const v = value || {};
            const hw = v.hardware || {};
            const rec = v.recommend || {};
            const gpu = (hw.gpu || []).map((g) => g.name).join(' / ') || '未检测到独立显卡';
            return [{ type: 'text', text: `🖥 ${gpu}｜显存 ${hw.vramGb || '?'} GB｜Vulkan ${hw.vulkan ? '可用' : '缺失'}｜推荐 ${rec.primary || '-'}` }];
          },
        },
        async execute() {
          const hardware = await probeHardware();
          const rec = recommendTiers(hardware.vramGb);
          const tiers = Object.entries(TTS_TIERS).map(([key, spec]) => ({
            key,
            label: spec.label,
            sizeGb: spec.sizeGb,
            vramGb: spec.vramGb,
            note: spec.note,
            recommended: key === rec.primary,
          }));
          note('install:probe', `vram=${hardware.vramGb} vulkan=${hardware.vulkan} gpu=${hardware.gpu.map((g) => g.name).join('/')}`);
          return {
            status: 'ok',
            hardware,
            recommend: { primary: rec.primary, alternatives: rec.alternatives, tiers },
            lock: { version: TTS_LOCK.version },
            // 给模型的一句话提示：它要把这些翻成人话讲给用户
            hint: hardware.vulkan
              ? 'Vulkan 可用。把推荐档位和代价说清楚，再问用户装到哪个目录（纯英文、不要空格）。'
              : '没检测到 Vulkan 运行库：先请用户更新显卡驱动；坚持要装的话只能 CPU 跑，会很慢。',
          };
        },
      });

      problems.push('tool: start tts_install');
      offInstall = ctx.tools.register({
        name: 'tts_install',
        description: [
          '把 BreezeTTS2 下载并安装到用户指定的目录（后台任务，立刻返回）。',
          '**调用前必须已经问过用户两件事** ① 用途仅限个人/研究/非商业；② 安装路径。',
          '缺任何一项都不要调用——宿主会直接拒绝，并向用户暴露你跳过询问这件事。',
        ].join(''),
        parameters: {
          type: 'object',
          properties: {
            dir: { type: 'string', description: '用户亲口指定的安装目录，绝对路径，纯英文不带空格，例如 D:\\tts' },
            tier: { type: 'string', enum: Object.keys(TTS_TIERS), description: '权重档位（来自 tts_probe 的推荐）' },
            acceptNonCommercial: { type: 'boolean', description: '用户已确认「仅用于个人/研究/非商业用途」' },
            voicePreset: { type: 'string', enum: Object.keys(PRESET_VOICES), description: '可选：用户想要的出厂音色（girl=少女 / boy=沉稳学长）。装完会自动生成并存进声音库，再设为当前音色' },
            programUrl: { type: 'string', description: '可选：程序包直链（默认用内置锁定版本）' },
            weightsUrl: { type: 'string', description: '可选：权重直链（默认 HuggingFace）' },
            localProgram: { type: 'string', description: '可选：用户自己下好的程序 zip 路径，给了就不下载' },
            localWeights: { type: 'string', description: '可选：用户自己下好的 gguf 路径，给了就不下载' },
          },
          required: ['dir', 'tier', 'acceptNonCommercial'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              dir: { type: 'string' },
              tier: { type: 'string' },
              reason: { type: 'string' },
              problems: { type: 'array' },
              warnings: { type: 'array' },
              hint: { type: 'string' },
            },
          },
          render: (args, value) => {
            const v = value || {};
            if (v.status === 'started') return [{ type: 'text', text: `⬇️ 开始安装到 ${v.dir}（${v.tier}）` }];
            return [{ type: 'text', text: `安装未开始：${v.reason || '未知原因'}` }];
          },
        },
        async execute(args) {
          if (args?.acceptNonCommercial !== true) {
            return {
              status: 'error',
              reason: 'refused: 用户还没确认用途。权重是「研究与非商业」许可，必须先问清楚再装。',
            };
          }
          if (!String(args?.dir || '').trim()) {
            return { status: 'error', reason: 'refused: 没有安装路径。必须先问用户装到哪里，不能自己决定。' };
          }
          if (installing) return { status: 'error', reason: 'busy: 已经有一个安装在进行' };
          const tier = String(args.tier || '');
          if (!TTS_TIERS[tier]) return { status: 'error', reason: `unknown-tier: 可选 ${Object.keys(TTS_TIERS).join(' / ')}` };
          const check = validateInstallDir(args.dir, tier);
          if (!check.ok) return { status: 'error', reason: 'invalid-dir', problems: check.problems, warnings: check.warnings };
          installing = true;
          Object.assign(installJob, { state: 'running', phase: '排队中', percent: 0, received: 0, total: 0, error: '', message: '', dir: String(args.dir).trim(), tier, startedAt: Date.now(), finishedAt: 0, voicePreset: PRESET_VOICES[String(args.voicePreset || '')] ? String(args.voicePreset) : '' });
          void runInstall({ ...args, dir: String(args.dir).trim(), tier });
          note('install:start', `dir=${args.dir} tier=${tier}`);
          return {
            status: 'started',
            dir: String(args.dir).trim(),
            tier,
            warnings: check.warnings,
            hint: '安装是后台任务，用 tts_install_status 轮询；别在同一轮里反复调用 tts_install。',
          };
        },
      });

      problems.push('tool: start tts_install_status');
      offInstallStatus = ctx.tools.register({
        name: 'tts_install_status',
        description: '查看 tts_install 的进度：阶段、百分比、已下载字节、错误。安装中建议每 20~30 秒查一次，并用人话告诉用户进展。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              job: { type: 'object' },
            },
          },
          render: (args, value) => {
            const job = (value && value.job) || {};
            const pct = Number(job.percent) || 0;
            return [{ type: 'text', text: `📦 ${job.phase || job.state || '空闲'}${pct ? ` ${pct}%` : ''}` }];
          },
        },
        async execute() {
          return { status: 'ok', job: { ...installJob } };
        },
      });

      problems.push('tool: start tts_test');
      offTest = ctx.tools.register({
        name: 'tts_test',
        description: '安装完成后验收：确保服务能起来，合成并播放一句测试语音。返回听到的文本与结果；失败会说明原因（Vulkan/权限/端口）。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              chars: { type: 'number' },
              reason: { type: 'string' },
              text: { type: 'string' },
              installDir: { type: 'string' },
            },
          },
          render: (args, value) => {
            const v = value || {};
            if (v.status === 'ok') return [{ type: 'text', text: `🔊 测试语音已播放（${v.chars || 0} 字）` }];
            return [{ type: 'text', text: `测试失败：${v.reason || '未知原因'}` }];
          },
        },
        async execute(_args, exec) {
          const sessionId = exec?.agent?.id ? String(exec.agent.id) : '';
          // A2：当前引擎是云端时，本机引擎跟这次试听无关 —— 不要傻等它（那是 90 秒的空转）。
          const ready = tts.engine.kind === 'breeze'
            ? await breezeTts().ensureServer(Number(cfg.startWaitMs) || 90000)
            : true;
          if (!ready) {
            const inst = await installState();
            return {
              status: 'error',
              reason: inst.state === 'missing' ? 'engine-missing: 还没装好' : 'server-down: 服务起不来（看看是不是 Vulkan 缺失或端口被占）',
              installDir: inst.dir,
            };
          }
          const presetLabel = cfg.voicePreset && PRESET_VOICES[cfg.voicePreset] ? PRESET_VOICES[cfg.voicePreset].label : '';
          const text = presetLabel
            ? `安装完成，声音测试。现在用的是出厂音色：${presetLabel}。想换成别的声音，随时跟我说话就行，我可以给你设计。`
            : '安装完成，声音测试。听得到我说话，就说明可以用了。';
          const one = await speakOnce({ text }, sessionId);
          const state = turnState.get(sessionId);
          if (state && (one.status === 'queued' || one.status === 'starting')) state.spoke = true;
          note('install:test', `status=${one.status} preset=${cfg.voicePreset || '-'}`);
          return { status: one.status === 'queued' || one.status === 'starting' ? 'ok' : 'error', chars: one.chars, reason: one.reason, text };
        },
      });

      /* ───────── ：出厂预设音色 + 设计音色入库 ───────── */

      problems.push('tool: start tts_preset');
      offPreset = ctx.tools.register({
        name: 'tts_preset',
        description: [
          '装配或切换**出厂音色** `girl`（清亮偏软的少女）或 `boy`（冷静沉稳的学长）。',
          '它会先看引擎的声音库里有没有这把嗓子，没有就**当场生成参考音频并自动入库**（不需要用户手动去 WebUI 存），然后把它设为当前音色。',
          '用户第一次装好插件、或者想换回出厂音色时用它。**不要替用户决定性别** 先问一句「喜欢男声还是女声」，再按回答调用。',
        ].join(''),
        parameters: {
          type: 'object',
          properties: {
            preset: { type: 'string', enum: Object.keys(PRESET_VOICES), description: 'girl=女声 / boy=男声；省略则只返回当前状态与可选值' },
          },
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              preset: { type: 'string' },
              voice: { type: 'string' },
              label: { type: 'string' },
              imported: { type: 'boolean' },
              current: { type: 'string' },
              options: { type: 'array' },
              reason: { type: 'string' },
            },
          },
          render: (args, value) => {
            const v = value || {};
            if (v.status === 'ok') {
              return [{ type: 'text', text: `🎚 当前音色：${v.label || v.voice || v.current || '-'}${v.imported ? '（已自动存入声音库）' : ''}` }];
            }
            return [{ type: 'text', text: `预设切换失败：${v.reason || '未知原因'}` }];
          },
        },
        async execute(args) {
          if (!args || !args.preset) {
            return {
              status: 'ok',
              current: cfg.voice || '',
              preset: cfg.voicePreset || '',
              options: Object.entries(PRESET_VOICES).map(([key, item]) => ({ key, label: item.label })),
            };
          }
          try {
            const got = await ensurePresetVoice(args.preset);
            cfg.voice = got.voice;
            cfg.voicePreset = got.preset;
            await persist();
            const sessionId = '';
            void sessionId;
            return { status: 'ok', ...got };
          } catch (error) {
            note('preset:error', String((error && error.message) || error));
            return { status: 'error', reason: String((error && error.message) || error) };
          }
        },
      });

      problems.push('tool: start tts_save_voice');
      offSaveVoice = ctx.tools.register({
        name: 'tts_save_voice',
        description: [
          '把一段**设计音色**存进引擎的声音库（自动修 WAV 头、自动入库），并把当前音色切到它。',
          '标准流程：① 用 `speak({segments})` 一次提交 3~6 个候选（每段 `voice:\"\"`、同一句 `tone`、不同 `seed`、同一句台词）；',
          '② 用户报序号；③ 用他那一段的 `tone` + `seed` 调本工具，`name` 用英文/数字/-/_（建议角色名拼音）。',
          '注意事项：参考台词 5~10 秒最稳（不给就用内置那句）；同名音色会被覆盖；没有引擎时先 `tts_probe`/`tts_install`。',
        ].join(''),
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '入库的名字：字母 / 数字 / - / _，1~32 位' },
            tone: { type: 'string', description: '音色描述（就用用户选中那一段的 tone，一个字都不要改）' },
            seed: { type: 'number', description: '用户选中那一段的 seed' },
            text: { type: 'string', description: '可选：参考台词（5~10 秒）；不给就用内置那句' },
          },
          required: ['name', 'tone', 'seed'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              id: { type: 'string' },
              seconds: { type: 'number' },
              saved: { type: 'boolean' },
              reason: { type: 'string' },
            },
          },
          render: (args, value) => {
            const v = value || {};
            if (v.status === 'ok') return [{ type: 'text', text: `💾 已入库并切换：${v.id}（${v.seconds ? `${v.seconds.toFixed(1)}s 参考音频` : '已保存'}）` }];
            return [{ type: 'text', text: `入库失败：${v.reason || '未知原因'}` }];
          },
        },
        async execute(args) {
          try {
            const got = await saveVoiceToLibrary({
              name: args?.name,
              tone: args?.tone,
              seed: args?.seed,
              text: args?.text,
            });
            cfg.voice = got.id;
            cfg.voicePreset = '';
            await persist();
            return { status: 'ok', ...got };
          } catch (error) {
            note('voice:save-error', String((error && error.message) || error));
            return { status: 'error', reason: String((error && error.message) || error) };
          }
        },
      });

      /* ───────── ：只读状态自述（把"当前档位"变成事前可知） ───────── */

      problems.push('tool: start tts_state');
      offState = ctx.tools.register({
        name: 'tts_state',
        description: [
          '只读：返回**当前**的语音播报设置——档位（strength）、目标字数、字数上限、段数上下限、模式、朗读方式、当前嗓门、多音色、场景、音量，以及**当前引擎能写哪些记号**（`engineHints`）。',
          '**每轮第一次开口之前先调一次** 系统提示词在会话内不刷新（中途改档不会跟实测），所以"现在到底是哪一档"只能从这里拿，其次看上一次 `speak` 的返回。',
          '`engineHints` 是**当前**语音引擎支持的记号清单（停顿 `<#0.5#>`、括号语气词、情绪档之类，随引擎切换而变）：**只用它列出来的**；没列出来的记号写到别家引擎上会被照字念成噪音。',
          '它不改任何设置、不出声、不写盘；返回的 `strength` / `target` / `limit` / `maxSegments` 就是这一轮该遵守的长度标准。',
        ].join(''),
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              fallback: { type: 'string' },
              narrationMode: { type: 'string' },
              strength: { type: 'string' },
              target: { type: 'number' },
              limit: { type: 'number' },
              minSegments: { type: 'number' },
              bodyFormat: { type: 'string' },
              cardDirty: { type: 'boolean' },
              note: { type: 'string' },
              maxSegments: { type: 'number' },
              voice: { type: 'string' },
              multiVoice: { type: 'boolean' },
              scene: { type: 'string' },
              volume: { type: 'number' },
              engine: { type: 'string' },
              engineKind: { type: 'string' },
              engineLabel: { type: 'string' },
              engineFallback: { type: 'string' },
              engineVoiceMode: { type: 'string' },
              engineNote: { type: 'string' },
              engineHints: { type: 'array', items: { type: 'string' } },
              enginePlaybook: { type: 'array', items: { type: 'string' } },
              engineSupport: { type: 'string' },
            },
          },
          render: (args, value) => {
            const v = value || {};
            const parts = [
              v.cardDirty ? '📖 卡已改，先调 tts_card' : '',
              v.bodyFormat === 'markers' ? '正文需标记行' : (v.bodyFormat === 'free' ? '正文不限格式' : ''),
              `档位=${v.strength || '-'}`,
              v.target ? `目标≈${v.target}字` : '',
              v.limit ? `上限${v.limit}字` : '无字数上限',
              v.maxSegments ? `≤${v.maxSegments}段` : '段数不限',
              `模式=${v.fallback || '-'}`,
              `嗓门=${v.voice || '设计模式'}`,
              v.engine && v.engine !== 'breeze' ? `引擎=${v.engineLabel || v.engine}` : '',
              v.engineSupport ? `支持=${v.engineSupport}` : '',
              v.enginePlaybook && v.enginePlaybook.length ? `手册${v.enginePlaybook.length}条` : '',
              v.engineVoiceMode === 'manual' ? '⚠ 该引擎没有音色清单，音色选项已隐藏' : '',
            ].filter(Boolean);
            return [{ type: 'text', text: `🎛 ${parts.join(' · ')}` }];
          },
        },
        async execute(_args, exec) {
          const sessionId = exec?.agent?.id ? String(exec.agent.id) : '';
          const plan = cfg.fallback === 'roleplay' ? (ROLEPLAY_STRENGTHS[cfg.strength] || ROLEPLAY_STRENGTHS.medium) : null;
          return stripUndefined({
            enabled: !!cfg.enabled,
            fallback: cfg.fallback,
            narrationMode: cfg.narrationMode,
            bodyFormat: cfg.narrationMode === 'script' ? 'markers' : 'free',
            cardDirty: refreshCardDirty() || undefined,
            note: [
              cfg.narrationMode === 'script'
                ? '全文念：正文每一行都要以「旁白：」或「角色名：」开头，裸写的叙述会被整行跳过'
                : 'AI 即兴：正文不限格式',
              refreshCardDirty() ? '角色卡/音色表刚被改过：先调 `tts_card` 重读，再开演' : '',
            ].filter(Boolean).join('；'),
            strength: cfg.strength,
            target: plan ? Number(plan.targetChars) || undefined : undefined,
            limit: plan && Number(plan.maxChars) ? Number(plan.maxChars) : undefined,
            minSegments: plan ? Number(plan.minSegments) || 1 : 1,
            maxSegments: plan ? Number(plan.maxSegments) || 0 : 0,
            voice: voiceForEngine(voiceForSession(sessionId) || cfg.voice || ''),
            multiVoice: !!cfg.multiVoice,
            scene: activeSceneId() || '',
            volume: Number(cfg.volume) || 0,
            engine: tts.engine.id,
            engineKind: tts.engine.kind,
            engineLabel: tts.engine.label,
            engineFallback: engineConfig().fallbackEngine || undefined,
            // A3（`15` §4.9）：云端没有音色清单时，模型要把「谁 / 为什么藏了 / 想换怎么办」讲给用户听
            engineVoiceMode: activeVoiceProfile().voiceMode,
            engineNote: activeVoiceProfile().guidance || undefined,
            // P1：当前引擎认识哪些记号（随引擎变，所以只能靠工具返回，不能写进提示词）
            engineHints: engineHints(),
            enginePlaybook: enginePlaybookLines(),
            engineSupport: engineSupportLine(),
          });
        },
      });

      /* ───────── ：角色卡 / 音色表 的实时读取（提示词里那份可能已被改过） ───────── */

      try {
        problems.push('tool: start tts_card');
        offCard = ctx.tools.register({
          name: 'tts_card',
          description: [
            '只读：返回**当前**的角色卡与音色表（`persona.md` 正文节选 + `cast.json` 的角色名/音色/语气），以及当前场景 id。',
            '为什么需要它：角色卡与音色表是**文件**，用户可能在会话中途用操作面板改过；系统提示词里的那一份可能已经过期（提示词在会话内不刷新）。',
            '**每轮开演之前、或者你怀疑设定被改过时调一次** 以它的返回为准，别把提示词里的旧卡当成现在的设定。',
            '返回是不出声、不写盘的；`persona` 最多 6000 字（超出会被截断，截断时会带 `truncated:true`）。',
          ].join(''),
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          output: {
            schema: {
              type: 'object',
              properties: {
                scene: { type: 'string' },
                persona: { type: 'string' },
                personaBytes: { type: 'number' },
                truncated: { type: 'boolean' },
                cast: { type: 'array' },
                castSize: { type: 'number' },
                multiVoice: { type: 'boolean' },
              },
            },
            render: (args, value) => {
              const v = value || {};
              const castText = (v.cast || []).map((item) => `${item.name}→${item.voice || '设计模式'}`).join('、');
              return [{
                type: 'text',
                text: `📖 场景=${v.scene || '-'} · 角色卡 ${v.personaBytes || 0} 字${v.truncated ? '（已截断）' : ''} · 音色表 ${v.castSize || 0} 人${castText ? `：${castText}` : ''}`,
              }];
            },
          },
          async execute() {
            const raw = String(readPersona() || '');
            const cast = (readCast() || []).map((item) => ({
              name: item.name,
              voice: item.voice || '',
              tone: item.tone || '',
              seed: Number.isFinite(Number(item.seed)) ? Number(item.seed) : undefined,
            }));
            const limit = 6000;
            // 模型已经拿到最新的一份了 → 落旗（下次再改会重新举）
            cardSig = cardSignature();
            cardDirty = false;
            return stripUndefined({
              scene: activeSceneId() || '',
              persona: raw.slice(0, limit),
              personaBytes: raw.length,
              truncated: raw.length > limit ? true : undefined,
              cast,
              castSize: cast.length,
              multiVoice: !!cfg.multiVoice,
            });
          },
        });
      } catch (error) {
        problems.push(`tool: start tts_card failed: ${(error && error.message) || error}`);
        note('tools:card-fail', String((error && error.message) || error));
      }

      /* ───────── G3：生成音频的工具（与面板「生成」页同一条 `runGenerate()`） ───────── */
      try {
      problems.push('tool: start tts_generate');
        problems.push('tool: start tts_convert');
      offGenerate = ctx.tools.register({
        name: 'tts_generate',
        description: [
          '把一段文本合成为**音频成品**（不是"念给用户听"的播报，而是"可以做素材的音频"）。',
          '**默认只试听、不落盘** 合成 + 在窗口里播一遍，返回时长与字节，不写文件、不进列表。',
          '**只有用户明确要求"存下来 / 给我一个音频文件 / 导出一段"时才传 `save: true`** —— 这是用户定的硬规则（`10` §12）：',
          '能力默认允许，但落盘必须由用户那句话触发。别自作主张替用户存文件。',
          '落盘后文件进「生成」页的结果列表（`source:"model"`），用户可以在面板里微调参数再生成。',
          '**音色** 不填 `voice` 就用当前响着的嗓子；云端引擎要填它自己的 `voice_id`（清单在面板「引擎」页）。',
          '**风格** `emotion` / `speed` / `vol` / `pitch` / `voiceModify` / `timbreWeights` 与 `speak` 的一次性参数同名同义，',
          '但这里是"这一次成品"的参数（会跟着记录写进 `index.json`，方便回填）。当前引擎认识哪些看 `tts_state.engineHints`。',
          '**长度** 上限由这家引擎决定（`tts_state` 不报，超了会返回错误并告诉你上限）；生成是整段合成，不受播报强度影响。',
          '**生成模式**（`mode`）：不传 = `auto`（老行为：给了音色就用，`instructions` 有就发）。',
          '`design` = 不要音色、让引擎按 `instructions` 现造一把嗓子（BreezeTTS 的 VOICE DESIGN，`seed` 决定抽到哪一把）；',
          '`clone` = 用给定音色、**不发指令**（VOICE CLONE）；`direction` = 给定音色 + 指令（VOICE DIRECTION，必须给音色）。',
          '当前引擎有没有这几种模式，看 `/engine` 快照的 `caps.modes`，别假设云端也认。',
        ].join(''),
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要合成的声音文本（整段，不是播报片段）。可以写停顿记号，认不认识看 engineHints。' },
            name: { type: 'string', description: '可选：文件名（不含扩展名）。非法字符会被清掉；撞名自动加 -1/-2，不覆盖已有文件。' },
            save: { type: 'boolean', description: '**只有用户明确要求落盘时才传 true**（"存下来/导出/给我文件"）。不传 = 只试听：合成并播一遍，不写盘。' },
            voice: { type: 'string', description: '可选：音色 id（云端要它自己的 voice_id）。不填用当前会话音色；`mode:"design"` 时一律不用音色。' },
            mode: {
              type: 'string',
              enum: ['auto', 'design', 'clone', 'direction'],
              description: '可选：生成模式。不传 = auto（老行为）。design=无音色、instructions 当音色描述；clone=有音色不带指令；direction=有音色+指令（必须有音色）。',
            },
            instructions: { type: 'string', description: '可选：语气/音色描述（breeze 的 instructions；云端多数没有这个字段，会被丢掉）。' },
            emotion: { type: 'string', description: '可选：情绪档（只有当前引擎支持的才生效，见 tts_state.engineHints）。' },
            speed: { type: 'number', description: '可选：语速 0.5~2（1=原速）。想要"慢"要动它。' },
            vol: { type: 'number', description: '可选：音量 0.01~10。' },
            pitch: { type: 'number', description: '可选：音调 -12~12。' },
            voiceModify: {
              type: 'object',
              description: '可选：音色微调（pitch / intensity / timbre / soundEffects）。',
              properties: {
                pitch: { type: 'number' },
                intensity: { type: 'number' },
                timbre: { type: 'number' },
                soundEffects: { type: 'string' },
              },
              additionalProperties: false,
            },
            timbreWeights: {
              type: 'array',
              description: '可选：多音色混音（至少 2 条，最多 4 条，权重 1~100）。',
              items: {
                type: 'object',
                properties: {
                  voice_id: { type: 'string' },
                  weight: { type: 'number' },
                },
                required: ['voice_id'],
                additionalProperties: false,
              },
            },
            seed: { type: 'number', description: '可选：随机种子（设计音色时同描述+同种子=同一把嗓子）。默认 42。' },
            seeds: {
              type: 'array',
              items: { type: 'number' },
              description: '可选：**抽卡** —— 给 2~4 个不同的 seed，各生成一粒候选（必须同时 `save:true`）。'
                + '每粒落成 `<名字>-s<种子>.wav`、**不自动播**，用户在面板「生成」页里点哪条播哪条。',
            },
            cfg_scale: { type: 'number', description: '可选：指令跟随强度（breeze 专用）。设计 4 / 指挥 2~3 / 克隆 1，>3 易刺耳。' },
            temperature: { type: 'number', description: '可选：采样温度（breeze，0.01~3；0 或留空 = 模型默认）。' },
            top_k: { type: 'number', description: '可选：top-k（breeze，1~300 整数；0 或留空 = 模型默认）。' },
            top_p: { type: 'number', description: '可选：top-p（breeze，0.01~1；0 或留空 = 模型默认）。' },
            repetition_penalty: { type: 'number', description: '可选：重复惩罚（breeze，0.5~2；0 或留空 = 模型默认）。' },
            max_new_tokens: { type: 'number', description: '可选：单段帧上限（breeze，1~4000；12.5 帧≈1 秒，默认 750≈60 秒）。' },
            split_chars: { type: 'number', description: '可选：长文本自动切分的粒度（breeze，1~4000，引擎默认 600；0 或留空 = 用服务器设置）。' },
            session: { type: 'string', description: '可选：会话 id（决定播放归属的那一轮；一般不用填）。' },
          },
          required: ['text'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              mode: { type: 'string' },
              file: { type: 'string' },
              dir: { type: 'string' },
              chars: { type: 'number' },
              ms: { type: 'number' },
              durationMs: { type: 'number' },
              cached: { type: 'boolean' },
              engine: { type: 'string' },
              reason: { type: 'string' },
              // B2：抽卡
              take: { type: 'number' },
              seeds: { type: 'array', items: { type: 'number' } },
              files: { type: 'array', items: { type: 'string' } },
            },
          },
          render: (args, value) => {
            const v = value || {};
            const sec = v.durationMs ? `${(v.durationMs / 1000).toFixed(1)} 秒` : '';
            if (v.status === 'error') return [{ type: 'text', text: `🧩 生成失败：${v.reason || '未知原因'}` }];
            // B2：抽卡 —— 列出种子，告诉用户去面板里挑
            if (Array.isArray(v.seeds) && v.seeds.length > 1) {
              return [{
                type: 'text',
                text: `🎲 抽了 ${v.seeds.length} 粒（seed ${v.seeds.join(' / ')}）· 每粒都落了盘、都没播 ·`
                  + ' 去面板「生成」页点哪条播哪条',
              }];
            }
            if (v.mode === 'saved') {
              return [{
                type: 'text',
                text: `💾 已存成 ${v.file}（${v.chars} 字${sec ? ` · ${sec}` : ''}）· 已播一遍 · 在面板「生成」页里能看到`,
              }];
            }
            return [{
              type: 'text',
              text: `🎧 已生成并播了一遍（只试听，没有落盘${sec ? ` · ${sec}` : ''}）${args?.save === false ? '' : ' · 要存下来就说一声'}`,
            }];
          },
        },
        async execute(args, exec) {
          const sessionId = exec?.agent?.id ? String(exec.agent.id) : String(args?.session || '');
          const out = await runGenerate(args, {
            sessionId,
            // 硬规则：只有显式 `save:true` 才写盘（模型只在用户明确要求时传）
            save: args?.save === true,
            source: 'model',
          });
          if (!out.ok) return { status: 'error', reason: out.error, chars: 0 };
          // B2：抽卡是一批，不是一条 —— 别硬塞进单条的字段里
          if (Array.isArray(out.items)) {
            return stripUndefined({
              status: 'queued',
              take: out.items.length,
              seeds: out.items.map((one) => Number(one.seed) || 0),
              files: out.items.map((one) => (one.item ? one.item.file : '')).filter(Boolean),
              dir: out.dir,
              chars: out.chars,
              engine: out.engine,
            });
          }
          return stripUndefined({
            status: 'queued',
            mode: out.mode,
            file: out.item ? out.item.file : undefined,
            dir: out.item ? out.dir : undefined,
            chars: out.chars,
            ms: out.ms,
            durationMs: out.durationMs,
            cached: out.cached || undefined,
            engine: out.engine,
          });
        },
      });
      } catch (error) {
        problems.push(`tool: start tts_generate failed: ${(error && error.message) || error}`);
        note('tools:generate-fail', String((error && error.message) || error));
      }

      /*
       * ───────── B3（1.0.0）：`tts_convert` —— VOICE CHANGER ─────────
       *
       * 为什么单独一个工具而不是给 `tts_generate` 加个 mode：参数集与返回形态都不一样
       * （源是**音频**不是文本、结果是整段非流式、还要 KEEP MELODY），塞进去只会让两个
       * 都不好用。契约在 `03` §2.9.10。
       */
      try {
        ctx.tools.register({
          name: 'tts_convert',
          description: [
            '把**一段已有的录音换成另一个人的声音**（BreezeTTS 的 VOICE CHANGER，本机引擎专有）。',
            '与 `tts_generate` 的区别：那个是"给文本、造新语音"，这个是"给录音、保留内容与节奏、只换嗓子"。',
            '**默认只试听、不落盘** 合成 + 播一遍；**只有用户明确要求"存下来/导出/给我文件"才传 `save:true`**（`10` §12）。',
            '**源音频** `sourceName` = 生成列表里的文件名（最常用，免上传）；`source` = 本机 `.wav` 绝对路径。',
            '**只收 wav**（mp3 等以后再说）。',
            '**目标音色** `voice` 必填（声音库里的 id），不给会用当前会话音色。',
            '**KEEP MELODY**（`keep_acoustic`）：`0` = 说话（默认，全部重新生成）；唱歌想留住旋律给 `1` 或 `2`；',
            '**超过 2 会不稳、用在说话上反而起哄**（官方实测）。',
            '**源稿**（`text`）：源录音的逐字稿，可选；**唱歌时强烈建议给** —— 不给稿，官方实测会把词听成别的。',
            '**采样** `temperature 0.3 / top_k 1 / cfg_scale 1.0` 是转换专用默认（近乎贪心，开采样会让源音色漏回来），',
            '与 `tts_generate` 的"0 = 模型默认"不是一回事。',
            '**耗时** 转换是**非流式**的，引擎要先编码完整个源再开始，长素材很慢（141 秒素材约 137 秒）；',
            '期间引擎被独占，播报会 409，`/state.converting` 为真。',
          ].join(''),
          parameters: {
            type: 'object',
            properties: {
              sourceName: { type: 'string', description: '生成列表里的文件名（如 "开场白.wav"）。与 `source` 二选一，优先用它。' },
              source: { type: 'string', description: '本机 .wav 绝对路径。与 `sourceName` 二选一。' },
              voice: { type: 'string', description: '目标音色 id（声音库里的）。不给就用当前会话音色。' },
              keep_acoustic: {
                type: 'number',
                description: 'KEEP MELODY：0=说话（默认）/ 1~2=唱歌保留旋律 / >2 不稳。',
              },
              text: { type: 'string', description: '源录音的逐字稿（可选，唱歌时强烈建议给）。' },
              temperature: { type: 'number', description: '可选：转换用的深度采样温度，默认 0.3（别开太大，源音色会漏回来）。' },
              top_k: { type: 'number', description: '可选：转换用的 top-k，默认 1。' },
              cfg_scale: { type: 'number', description: '可选：往目标音色靠的引导强度，默认 1.0。' },
              seed: { type: 'number', description: '可选：随机种子，默认 42。' },
              name: { type: 'string', description: '可选：落盘文件名（不含扩展名），默认 `<源名>-变声`。' },
              save: { type: 'boolean', description: '**只有用户明确要求落盘时才传 true**。不传 = 只试听、不写盘。' },
            },
            required: ['voice'],
            additionalProperties: false,
          },
          output: {
            schema: {
              type: 'object',
              properties: {
                status: { type: 'string' },
                mode: { type: 'string' },
                file: { type: 'string' },
                dir: { type: 'string' },
                durationMs: { type: 'number' },
                ms: { type: 'number' },
                cached: { type: 'boolean' },
                engine: { type: 'string' },
                keepAcoustic: { type: 'number' },
                reason: { type: 'string' },
              },
            },
            render: (args, value) => {
              const v = value || {};
              const sec = v.durationMs ? `${(v.durationMs / 1000).toFixed(1)} 秒` : '';
              if (v.status === 'error') return [{ type: 'text', text: `🧩 变声失败：${v.reason || '未知原因'}` }];
              if (v.mode === 'saved') {
                return [{
                  type: 'text',
                  text: `🔁 已存成 ${v.file}（${sec || '时长未知'} · KEEP MELODY=${v.keepAcoustic ?? 0}）· 已播一遍 · 在面板「生成」页里能看到`,
                }];
              }
              return [{
                type: 'text',
                text: `🔁 换声完成并播了一遍（只试听，没有落盘${sec ? ` · ${sec}` : ''}）· 要存下来就说一声`,
              }];
            },
          },
          async execute(args, exec) {
            const sessionId = exec?.agent?.id ? String(exec.agent.id) : String(args?.session || '');
            const out = await runConvert(args, {
              sessionId,
              // 硬规则：只有显式 `save:true` 才写盘
              save: args?.save === true,
              source: 'model',
            });
            if (!out.ok) return { status: 'error', reason: out.error, chars: 0 };
            return stripUndefined({
              status: 'queued',
              mode: out.mode,
              file: out.item ? out.item.file : undefined,
              dir: out.item ? out.dir : undefined,
              durationMs: out.durationMs,
              ms: out.ms,
              cached: out.cached || undefined,
              engine: out.engine,
              keepAcoustic: out.keepAcoustic,
            });
          },
        });
      } catch (error) {
        problems.push(`tool: start tts_convert failed: ${(error && error.message) || error}`);
        note('tools:convert-fail', String((error && error.message) || error));
      }

      } catch (error) {
        problems.push(`tools fail: ${(error && error.message) || error}`);
        note('tools:fail', String((error && error.message) || error));
      }

      // 注册失败不能让整条链路全线阵亡（就栽在这：section 抛错 =
      // 后面三条 session/event 监听一个都没挂上，于是既不播报也不写日志）
      try {
      offSection = ctx.systemPrompt.section({
        name: 'voice-breeze',
        order: 210,
        // （P0）：**必须**关掉插值。这段文本里有用户自己的角色卡、cast.json 的语气，
        // 里面出现 `{{user}}` / `{{char}}` / 任何 `{{…}}` 都会被宿主当成提示词变量，
        // 未注册就抛 "unknown prompt variable … in section voice-breeze"——插件里的 try/catch
        // 拦不到（错是装配阶段抛的），整轮模型调用 step=0 直接失败。关掉插值后原样交给模型。
        interpolate: false,
        text: () => {
          try {
          if (!cfg.enabled) return '本会话的语音播报处于关闭状态：不要调用 `speak` 工具。';
          //  的老教训：只列三档范围时，模型会永远按最短那档写。
          //  的解法变了：不再把"当前强度"的数值写进提示词（它按会话固定，会陈旧），
          // 改成**三档标准表 + 明确指向 `tts_state`/`speak` 返回**（见下面 roleplay 分支）。
          const preset = strengthPreset();
          const persona = cfg.fallback === 'roleplay' ? personaBlock() : '';
          const cast = cfg.fallback === 'roleplay' ? readCast() : [];

          // P1：**引擎能力随引擎变，但这段提示词不分叉。**
          // 这里只写一句永远成立的话：能写哪些记号去问 `tts_state.engineHints`。
          // 反面做法（写死"你可以写 (laughs)"再按引擎换提示词）不成立 —— 提示词在会话内不刷新
          // （`06` 坑 18 三次实测），切引擎后模型拿到的还是旧的那套，会继续写别家的记号。
          const ENGINE_MARKER_RULE = [
            '**引擎记号随引擎变化** `<#0.5#>` 停顿、`(laughs)` 这类括号语气词、情绪档，只有部分语音引擎认识。',
            '**能写哪些，一律以 `tts_state` 返回的 `engineHints` 为准**——hints 里没提到的记号不要写。',
            '写在别家引擎上会被照字念成"小于号井号零点五井号""括号 laughs 括号"这类噪音；插件虽然会在发出去前擦掉，但你想要的停顿和笑声也就没了。',
            // P3：手册也是数据，不是提示词 —— 每轮读当前引擎那一份。
            '**每个引擎的写法手册** `tts_state` 返回的 `enginePlaybook` 是**当前引擎**的官方写法要点（怎么断句、怎么用停顿与语气词、哪些记号会被擦、情绪怎么给）。**调 `speak` 前先按它组织语音文本**——同样的内容按手册写，出来的声音质量差很多。',
            '手册里没提到的语法不要用；手册说的"别写"，就别写。切了引擎，手册会自动换一份，**不要沿用上一份的记忆**。',
            // G0（0.96.0）：一次性风格参数 —— 同样是"标准"而不是"当前值"：这里只说**可以传**，
            // 到底这家认不认识，仍然由 `engineHints` / `engineSupport` 现算。
            '**这一次想换个语气，不用去改面板** `speak` 自带一次性风格参数 `emotion` / `speed` / `vol` / `pitch` / `voiceModify`——只作用于这一次合成，不写盘、下一轮自动回到面板的全局风格，所以放心按情景用。想说得"慢"要传 `speed`（`emotion` 改的是语调形态，不是时长）。',
          ].join('\n');

          /*
           * G3：**"产出一段音频"和"念一句话"是两件事**，这里写死两者的边界。
           *
           * 用户定的落盘许可（`10` §12）：能力默认允许，但**只有用户明确要求时才写文件**。
           * 这条规则不随模式变（四档都要一致），所以三种分支共用同一段文案 —— 与坑 27 的老道理一致：
           * 提示词只放"标准与边界"，具体参数由 `tts_state.engineHints` 现算。
           */
          const GENERATE_RULE = [
            '**要产出一段能保存的音频**（素材、台词样本、给别处用）→ 用 `tts_generate(text, …)`，别用 `speak`。',
            '**落盘许可** `tts_generate` 不传 `save` 就只试听（合成 + 播一遍，不写文件、不进列表）；',
            '**只有用户明确说了"存下来 / 导出 / 给我一个音频文件"才传 `save: true`**——别自作主张替用户存文件。',
            '生成页（面板里）是用户自己动手的地方：你在那里生成的成品会带 `source:"model"` 进列表，供用户回填参数微调。',
          ].join('\n');

          // 角色扮演：一套统一的优先级链，**不再按 cast 是否为空分叉**（历史提示词残留会导致自相矛盾）
          if (cfg.fallback === 'roleplay') {
            const lines = ['## 语音播报（角色扮演）', '本会话处于角色扮演模式，语音播报开启。'];
            // **凡是会随设置变化的东西，都不能只靠提示词**——提示词在会话内不刷新（`06` 坑 18）。
            // 这里把「以实时值为准」写成两条固定指针，模式/朗读方式/多音色/强度/角色卡都可能被中途改过。
            lines.push([
              '**当前设置一律以实时工具为准**（提示词里写的是**标准与规则**，不是「现在就是某一档」）：',
              '- `tts_state`：模式 / 朗读方式（`narrationMode`）/ 多音色（`multiVoice`）/ 强度与长度 / 嗓门 / 场景；**每轮开口前调一次**。',
              '- `tts_card`：**当前**的角色卡与音色表（它们是文件，用户可能在会话中改过）；设定与说话人名字以它为准，别拿下文那份旧卡当现状。',
              '- **任何工具返回里出现 `cardDirty: true`**（`tts_state` / `speak` / `tts_card`）→ 角色卡或音色表刚被改过：**先调 `tts_card` 重读**，再按新设定演。',
            ].join('\n'));
            lines.push(ENGINE_MARKER_RULE);
            lines.push(GENERATE_RULE);
            if (cfg.narrationMode === 'script') {
              lines.push('**朗读方式：照本念** —— 插件按标记切分正文，**不会调用模型重写**。');
              lines.push([
                '正文必须逐行写清是谁在说：',
                '- `旁白：…`（环境、动作转述、时间推进）',
                '- `角色名：…`（台词）',
                '- `角色名（情绪）：…`（同一句带情绪，例如 `角色甲（声音发颤）：…`，括号里就是这一段的语气指令）',
                '- `角色名（心声）：…`（心里话）',
              ].join('\n'));
              lines.push('**只有带标记的行会被念出来。** 状态栏、当前进度、好感度、表格、代码这些不带标记的内容一律不出声。');
              lines.push('用户如果要求「旁白别念／改成气口」，就把那个位置写成 `[停顿3秒]`（保留换行、不要加冒号），插件会静默等待而不是念出来。');
              lines.push(cast.length
                ? `可识别的说话人（cast.json）：${cast.map((item) => `${item.name}→${item.voice || '设计模式'}`).join('、')}`
                : '注意：`cast.json` 为空，目前只认「旁白：」，其它名字不会被念。');
              lines.push('**普通问答、查资料、写文件这类不是剧情的回复，请直接调用 `speak(text)`**——插件会用它，正文不会被重复念。');
              lines.push('若整轮正文一条标记都没有（例如用户问的是插件一个普通问题），插件会**改用「AI 即兴」把正文播一次**——所以不会"问了却没声音"；这种情况你直接调用 `speak` 也可以，插件不会重复念。');
            } else {
              lines.push('**朗读方式：AI 即兴** —— 插件会额外调用一次模型，把这一轮完整地演出来（默认不压缩、不限 token；状态栏、进度、代码这类只给眼睛看的东西不念）。');
              lines.push('**硬规则** 每一轮给出最终答复时，必须调用一次 `speak(text)`（除非它返回 muted）。');
              // **提示词里不再写死"当前强度"的数值**——它按会话固定，中途改档这一份不会跟
              // 。
              // 所以这里只列**标准表**（三档全给，永不陈旧），当前档位一律指向 `tts_state` 的返回。
              lines.push([
                '**长度标准（角色扮演 + AI 即兴）** 弱 80~160 字、**1 段**（宿主不做扩写）；中 320~520 字、1~3 段；强 640~900 字、**≥2 段**（段间要有气口）。',
                '**当前是哪一档、这一轮该说多长，以 `tts_state` 的返回为准** 每轮开口前先调一次 `tts_state`（只读，返回 strength / target / limit / maxSegments）；`speak` 的返回里也带同名字段。',
                '**别把上面那张标准表当成"现在就是强"** 系统提示词里的文字在会话内不刷新（中途改档不会跟），`tts_state` 与 `speak` 的返回才是当前值。',
                '**这条只决定"念多长"，跟是不是在演剧情无关** 哪怕是查资料、写代码、跑任务、汇报进度这类正经事，也用角色的口吻按这个长度说——像跟用户一起把这件事做完之后再聊两句，而不是交一份报告。',
                '**语音里只有对话** 调 `speak` 时只写这个角色会说的话，**不要**写旁白、动作、表情、神态、环境（"她推过笔记本"这类一律不写）——那些写进正文就行；用户要的是“这个人在跟我说话”。',
              ].join('\n'));
            }
            // **正文格式的规则不能只写在某个朗读方式的分支里**——提示词在会话内不刷新
            // （`06` 坑 18），用户中途把「AI 即兴」切成「全文念」时，模型看到的还是旧分支，
            // 于是继续写没有 `旁白：` 的裸叙述，而宿主在 script 档只认标记行 → 旁白整段被跳过。
            // 所以这一块**两种方式都写**，并且指向 `tts_state` 的实时值（标准 + 实时值分开表述）。
            lines.push([
              '**正文格式取决于当前朗读方式**（以 `tts_state` 返回的 `narrationMode` 为准；提示词里这段是标准，不是当前值）：',
              '- `script`（全文念）：**正文每一行都必须以 `旁白：` 或 `角色名：` 开头**——插件只念带标记的行，裸写的叙述会被整行跳过（听感上就是「旁白凭空消失」）。',
              '- `adapted`（AI 即兴）：正文不限格式，想怎么写就怎么写。',
              '拿不准现在是哪一档，就先调 `tts_state`；**不确定时按 `script` 的要求写**（带标记在两种方式下都不吃亏）。',
              cfg.turnChoices && cfg.fallback === 'roleplay'
                ? '**每回合末尾给 4 个选项**（用户只回一个数字就继续）：正文最后单独列四行，格式固定为 `1) …` `2) …` `3) …` `4) …`，各一句话、彼此不同路；**这些选项行不要加 `旁白：` 标记**（这样全文念不会把选项念出来），即兴模式下也不要念选项；用户只回数字时，直接演那一条，不要复述选项、不要重新列旧选项。'
                : '',
            ].filter(Boolean).join('\n'));

            // 漏调 speak 的主因不是"不知道要调"，而是"写完正文忘了补"。
            // 把顺序写成硬规则，并针对"空角色卡第一轮"给固定句式——这一句最容易被兜底代劳。
            lines.push([
              '**这一轮的动作顺序** 先调 `speak`（该说的话一次说完），再写正文；',
              '或者写完正文后立刻补一次 `speak`——**同一轮里必须发生一次**。',
              '如果这一轮调了多个工具、或者中途被打断重来，收尾时同样要补，不要因为"正文已经写完"就跳过。',
            ].join('\n'));
            // 多音色下的共同规则（照本念 / 即兴都适用）。：以界面开关为准，不看 cast 是否非空
            if (cfg.multiVoice && cast.length) {
              lines.push([
                '**多音色已开启**（以 `tts_state.multiVoice` 为准；若它显示已关闭，按单音色处理）：',
                '- 调用 `speak` 时**必须用 `segments` 多段提交**，每段带 `speaker`（名字与音色表逐字一致）；单段 `text` 只会用一把嗓子。',
                '- 剧情里的旁白、环境、心理活动也各占一段；旁白用音色表里指定的那个声音。',
                '- 这一轮是问答或任务汇报时，用「多角色陪伴」：挑 2~3 个角色轮番或抢着把结论说出来，按角色卡的性格决定语气与抢话方式；**旁白默认不参与汇报**（除非用户要求，或场景里只有旁白 + 一个角色）。',
              ].join('\n'));
            } else if (cast.length) {
              // 单音色 + 角色扮演——设定照用，但嗓子只有一把
              lines.push([
                '**当前是单音色播报**（以 `tts_state.multiVoice` 为准；若它显示已开启，按多音色处理）：',
                '- 只用当前选中的那**一把**嗓子：`speak` 不必写 `speaker`，更不要按角色分嗓子。',
                '- 角色设定（下面的角色卡）照样生效：称呼、口吻、态度按角色来，只是声音只有一个。',
                '- 要分段就按语气/节奏分；`segments[].tone` 仍然有用。',
              ].join('\n'));
            }
            if (persona) {
              lines.push(`角色设定（正文风格与演出都按它来）：\n${persona}`);
              // 角色扮演下的日常任务/问答也要保持这个角色的口吻，不要切回助手腔
              lines.push('**不要跳出角色** 日常问答、查资料、写代码、汇报进度，也用这个角色的口吻、自称和习惯说话。');
              // 用户自己装的设定/记忆/情感插件优先级更高
              lines.push('**优先级** 如果用户自己安装或加载了人设、全局记忆、情感状态（例如情感/记忆类插件），**以它们为准**。上面这份角色设定只决定"怎么念"——称呼、语气、习惯、怎么称呼用户；**不得覆盖、改写或与之冲突**。真撞上时按用户的设定走，并把这处差异说清楚。');
            } else if (cfg.multiVoice) {
              // 多音色：一局剧本 = 角色卡 + 音色表，按顺序问（顺序固定，不用一次问完气氛）
              lines.push([
                '**这个场景还没有角色卡**（先调一次 `tts_card` 核实；如果它已经有内容，就按它演，不要问下面这些问题）：先说一句「现在是一个空白场景，开始前我有几个问题想先问你~」，然后按下面的顺序问用户（一次问一条，用户答完再问下一条）：',
                '**这一句必须由你调 `speak` 说出来**，不能只写在正文里等兜底：',
                '`speak({text:"现在是一个空白场景，开始前我有几个问题想先问你~"})`，正文里再写第一个问题。',
                '1. 用默认场景，还是新建一个场景？（新建就请用户起个名字）',
                '2. 角色卡：有现成的，还是现在一起写？（名字 / 性格 / 说话习惯或口癖 / 和用户的关系 / 世界观）',
                '3. 单角色还是多角色？多角色的话，分别是谁？',
                '4. 音色：用声音库里现成的，还是给每个角色专门设计一个？',
                '5. 旁白用哪个声音？',
                '拿到答案后依次写文件：角色卡 → `persona.md`，音色表 → `cast.json`（都没有就都放在当前场景目录里）。',
                '这一轮的 `speak` 就念你提出的第一个问题。',
              ].join('\n'));
            } else {
              // （Q11）：单音色 = **全局角色卡**，没有"场景"这回事
              lines.push([
                '**当前还没有角色卡**（先调一次 `tts_card` 核实；如果 `persona` 已有内容，就按它演，别再问下面这些）：单音色用的是全局 `~/.dsh/voice-breeze/persona.md`。',
                '**先调一次 `speak`** 说一句「角色卡还是空的，先给我一个角色吧」，不要只写在正文里等兜底。',
                '然后一次问一条，按用户走的路子来：',
                '1. 用户直接给卡（贴 JSON / 贴设定文）→ 你整理成 Markdown，**写到 `~/.dsh/voice-breeze/persona.md`**；不要新建场景，也不要写 `scenes/`。',
                '2. 用户只说想要什么样的角色 → 把「名字 / 性格 / 说话习惯或口癖 / 和用户的关系 / 世界观」补齐，缺什么就问什么，凑齐后同样写进全局 `persona.md`。',
                '3. 用户让你先问 → 按上面五项一条条问，别一次全抛。',
                '写完读回来确认一次；之后正文与语音都用这个角色的口吻。**单音色没有音色表：不要问音色，也不要问旁白。**',
              ].join('\n'));
            }
            lines.push([
              '**语音引擎没装时** `speak` / `tts_test` 会返回 `engine-missing`。不要反复重试，也不要假装念过——按顺序走：',
                '① 先问用户要不要安装；② `tts_probe` 拿硬件与推荐档位；③ 把 2~3 个档位的体积/显存/代价说清楚让用户自己选；',
                '④ **确认用途仅限个人/研究/非商业**（权重是研究与非商业许可）；⑤ **问安装路径**（纯英文、不带空格，绝不能自己定）；',
                '⑥ `tts_install`；⑦ 每 20~30 秒 `tts_install_status` 汇报进度；⑧ `tts_test` 验收，听不到就按原因分流。',
                '（另外：用户被询问选项、或需要点同意时，插件会**自己念一句提醒**（现在走会话事件，已验证可用）——**这一轮你不要为此再调用 `speak`**，否则会念两遍。除这种“纯询问”的轮次外，其它轮次照常调 `speak`。）',
            ].join('\n'));
            return lines.join('\n');
          }

          // 全文模式——正文由插件逐字念，模型不要调 speak
          if (cfg.fallback === 'full') {
            return [
              '## 语音播报（全文）',
              '本会话的语音播报处于开启状态，播报方式是**全文** 插件会把你这轮写下的正文**逐字念出来**，过长会按句切段，代码块/表格/链接不念。',
              '**这一轮不要调用 `speak`** 正文本身就是播报内容。真调了也不会出声——这一档的 `speak` 会被忽略（返回 `skipped`），照样只念一遍正文。',
              '正文照常写给用户看：句子写完整、分段清楚就行；**不要**写「旁白：」「角色名：」这类标记（那是角色扮演的写法），也不要把路径、堆栈、表格塞进要念的句子里。',
              '代码、命令、表格照旧放在正文里——插件会自动跳过它们。',
              GENERATE_RULE,
              '**若 `tts_state.fallback` 与这里写的不一致，以它为准**（设置可能在会话中途被改过；不一致时按它的档位行事）。',
            ].join('\n');
          }

          // 非角色扮演：保持原来的硬规则
          return [
            '## 语音播报',
            '本会话的语音播报处于开启状态。',
            '**若 `tts_state.fallback` 与这里写的不一致，以它为准**（设置可能在会话中途被改过）。',
            '**硬规则** 每一轮给出最终答复时，必须调用一次 `speak(text)`，没有例外（除非它返回 muted）。不要用“这轮只是回答问题／只是查资料／不算结论”说服自己跳过。',
            ENGINE_MARKER_RULE,
            GENERATE_RULE,
            // **AI 说档也不能写死"当前强度"**——和角色扮演档一样，提示词会陈旧（`10` §3.4 / Q24 / Q27 的同一原则）。
            // 这里只给三档标准表，当前档位一律指向 `tts_state` 与 `speak` 的返回。
            cfg.fallback === 'authored'
              ? [
                '**长度标准（AI 说）** 弱 20~40 字（只念一句结论）；中 40~120 字（结论 + 一句下一步或原因）；强 120~240 字（结论 + 2~3 个要点 + 下一步，可两三句）。',
                '**当前是哪一档、这一轮该说多长，以 `tts_state` 的返回为准**（`speak` 的返回里也带 `strength`/`target`/`limit`）；上面这只是标准表，别把它当成「现在就是某一档」。',
              ].join('\n')
              : `**长度上限：** 这一档最多念 ${effectiveMaxChars()} 字左右（不看强度档）。`,
            '说什么，按优先级取第一条：① 这一轮的结论或决定；② 接下来要做什么；③ 一句进度（例如「查完了，细节在正文」）。',
            '怎么说：口语化；不念代码、路径、表格、报错堆栈；不复述正文整段。一轮最多 1~2 次。',
            '正文照常写给用户看。只有这一轮确实没有任何可说的内容时才不调用——插件会用兜底模式补一句。',
            [
              '**语音引擎没装时** `speak` / `tts_test` 会返回 `engine-missing`。不要反复重试，也不要假装念过——按顺序走：',
                '① 先问用户要不要安装；② `tts_probe` 拿硬件与推荐档位；③ 把 2~3 个档位的体积/显存/代价说清楚让用户自己选；',
                '④ **确认用途仅限个人/研究/非商业**（权重是研究与非商业许可）；⑤ **问安装路径**（纯英文、不带空格，绝不能自己定）；',
                '⑥ `tts_install`；⑦ 每 20~30 秒 `tts_install_status` 汇报进度；⑧ `tts_test` 验收，听不到就按原因分流。',
                '（另外：用户被询问选项、或需要点同意时，插件会**自己念一句提醒**（现在走会话事件，已验证可用）——**这一轮你不要为此再调用 `speak`**，否则会念两遍。除这种“纯询问”的轮次外，其它轮次照常调 `speak`。）',
            ].join('\n'),
          ].join('\n');
        } catch (error) {
          // text() 在装配期抛错会连累整轮模型调用，退回一句安全文案
          note('prompt:text-error', String((error && error.message) || error));
          return '## 语音播报\n本会话语音播报处于开启状态；如果这一轮有值得听的内容，调用一次 `speak`。';
        }
      },
      });
      problems.push('prompt ok');
      } catch (error) {
        problems.push(`prompt fail: ${(error && error.message) || error}`);
        note('prompt:fail', String((error && error.message) || error));
      }
      // DSH 弹选项 / 弹审批时，先念一句提醒（waterfall：念完再放行界面，不阻塞）
      try {
        offQuestion = ctx.on('user-questions/request', questionHandler('root'));
        note('remind:attach', 'kind=question via=root');
        problems.push('events ok: user-questions/request');
      } catch (error) {
        problems.push(`events fail user-questions/request: ${(error && error.message) || error}`);
      }
      try {
        offApproval = ctx.on('approval/request', approvalHandler('root'));
        note('remind:attach', 'kind=approval via=root');
        problems.push('events ok: approval/request');
      } catch (error) {
        problems.push(`events fail approval/request: ${(error && error.message) || error}`);
      }
      // `via` 是给"重复投递去重"用的：root 与每个 agent 各挂一份，两路都会投递，
      // 不在 handler 里做幂等就会**每个事件处理两次**（表现：`events.log` 每行写两遍）。
      offEvents = ctx.on('session/event', (session, event) => onSessionEvent(session, event, 'root'));
      problems.push('events ok: session/event');
      // 第二路触发：万一 session/event 不投递，turn-stopping 也能兜住（scheduled 去重）。
      // 必须延迟 350 ms：这一路比 turn/end 早约 2 ms 触发，而 provider/model 要等 turn/end
      // 才能从 session.requestContext() 拿到——抢跑会让 authored 档的 verbalize 永远 unavailable
      // （这个真 bug，见开发记录）。turn/end 先跑过就 scheduled 去重，
      // session/event 整条不来时这里仍是看门狗。
      offStopping = ctx.on('agent/turn-stopping', (payload) => {
        const id = payload?.agent?.id ? String(payload.agent.id) : '';
        const state = id ? turnState.get(id) : undefined;
        if (!state) return;
        note('turn-stopping', `session=${id} spoke=${state.spoke} textLen=${(state.text || '').length} model=${state.model || '-'}`);
        const timer = setTimeout(() => {
          try {
            scheduleSpeech(id, state, 'turn-stopping');
          } catch (error) {
            note('turn-stopping:error', String((error && error.message) || error));
          }
        }, 350);
        if (typeof timer?.unref === 'function') timer.unref();
      });
      problems.push('events ok: agent/turn-stopping');
      // 第三路：把同一个 handler 挂到每个 agent 的 scope 上（scoped 派发对本会话必然可达）
      const agentDisposers = new Map();
      offCreated = ctx.on('agent/created', (payload) => {
        try {
          const agent = payload?.agent;
          const id = agent?.id ? String(agent.id) : '';
          if (!id || !agent?.ctx) return;
          const offSession = agent.ctx.on('session/event', (session, event) => onSessionEvent(session, event, 'agent'));
          // `user-questions/request` 与 `approval/request` 是**按 agent 作用域派发**的 waterfall
          // （宿主源码 `ctx.waterfall(scopeTarget(agent, agent), …)`）。根上注册是否命中取决于 scope 标签，
          // 实测没响过，所以这里在同一 agent 的作用域上再挂一份——两边都挂，靠 remindSeen 去重。
          let offQ = null;
          let offA = null;
          try { offQ = agent.ctx.on('user-questions/request', questionHandler(`agent:${id.slice(0, 8)}`)); } catch { /* ignore */ }
          try { offA = agent.ctx.on('approval/request', approvalHandler(`agent:${id.slice(0, 8)}`)); } catch { /* ignore */ }
          note('remind:attach', `kind=question+approval via=agent session=${id.slice(0, 8)} q=${Boolean(offQ)} a=${Boolean(offA)}`);
          const dispose = () => {
            try { offSession(); } catch { /* ignore */ }
            try { offQ?.(); } catch { /* ignore */ }
            try { offA?.(); } catch { /* ignore */ }
          };
          agentDisposers.set(id, dispose);
          note('agent/created', `session=${id}`);
        } catch (error) {
          note('agent/created:error', String((error && error.message) || error));
        }
      });
      offDisposed = ctx.on('agent/disposed', (payload) => {
        const id = payload?.agent?.id ? String(payload.agent.id) : '';
        const dispose = id ? agentDisposers.get(id) : undefined;
        if (dispose) {
          try { dispose(); } catch { /* ignore */ }
          agentDisposers.delete(id);
        }
      });
      problems.push('events ok: agent/created');
      } catch (error) {
        tts.lastError = `注册失败: ${(error && error.message) || error}`;
        ctx.logger?.warn?.(`${TAG} ${tts.lastError}`);
      }

      // 出厂音色自举——配置里定过预设（新装默认 girl）就在后台确保它在声音库里，
      // 并把当前音色指过去。失败只记日志，不阻塞插件启动。
      if (cfg.voicePreset && PRESET_VOICES[cfg.voicePreset]) {
        void (async () => {
          try {
            const got = await ensurePresetVoice(cfg.voicePreset);
            // 只有「当前音色还空着」或「已经是这个预设」时才接管；用户手选过别的嗓子就不动它。
            if (!cfg.voice || cfg.voice === got.voice) {
              if (cfg.voice !== got.voice) {
                cfg.voice = got.voice;
                await persist();
              }
            } else {
              note('preset:keep', `voice=${cfg.voice} 优先于预设 ${got.preset}`);
            }
            note('preset:boot', `preset=${got.preset} imported=${got.imported} voice=${cfg.voice}`);
          } catch (error) {
            note('preset:boot-error', String((error && error.message) || error));
          }
        })();
      }

      return () => {
        offQuestion?.();
        offApproval?.();
        offTool?.();
        offProbe?.();
        offInstall?.();
        offInstallStatus?.();
        offTest?.();
        offPreset?.();
        offSaveVoice?.();
        offState?.();
        offCard?.();
        offGenerate?.();
        offRoute?.();
        offSection?.();
        offEvents?.();
        offStopping?.();
        offCreated?.();
        offDisposed?.();
        for (const dispose of extras) dispose?.();
      };
    });
}

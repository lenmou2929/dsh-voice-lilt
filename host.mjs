/**
 * dsh-voice-lilt — Host half (entry: host.mjs)
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
import { mkdir, readFile, writeFile, appendFile, stat, rename, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync, readdirSync, createWriteStream, existsSync, statfsSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { join, dirname, isAbsolute } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { homedir } from 'node:os';
import { cleanForSpeech, capText, createTts } from './lib/tts.mjs';
import { firstSpeakableSentence, buildSummaryLine } from './lib/tts.mjs';

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
  // 酒馆角色卡里的 {{user}} / {{char}} 换成什么名字。{{user}} 是「用户」自己，
  // 所以默认写「用户」（写「你」会和系统提示词里的「你 = 模型」打架）；卡里若有固定称呼
  // （例如「主人」），把 userName 改成它就行。charName 留空 = 自动取 cast.json 里第一个角色。
  userName: '用户',
  charName: '',
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
    const tts = createTts({ cfg, cacheDir, logger: ctx.logger });

    /** @type {Map<string, {id:string,seq:number,file:string,text:string,chars:number,ms:number,session:string}>} */
    const ledger = new Map();
    let seq = 0;
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
      if (ledger.size > cfg.maxPending) {
        // 只淘汰已经合成完的，正在流的不能被踢（客户端可能正在读）
        const oldest = [...ledger.values()]
          .filter((item) => item.done)
          .sort((a, b) => a.seq - b.seq)[0];
        if (oldest) ledger.delete(oldest.id);
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
      if (await tts.healthy()) return { state: 'ready', dir: cfg.installDir || '', script: cfg.startScript || '' };
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

    function kickServer() {
      if (serverStarting) return;
      serverStarting = true;
      const startedAt = Date.now();
      const spawned = tts.startServer();
      note('server:start', `spawn=${spawned} waitMs=${cfg.startWaitMs || 90000}`);
      void (async () => {
        const deadline = Date.now() + Number(cfg.startWaitMs || 90000);
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1500));
          if (await tts.healthy()) {
            serverStarting = false;
            note('server:ready', `${Date.now() - startedAt}ms`);
            await flushPending();
            return;
          }
        }
        serverStarting = false;
        tts.lastError = `BreezeTTS 没能在 ${Math.round((cfg.startWaitMs || 90000) / 1000)} 秒内起来（${cfg.startScript}）`;
        note('server:timeout', tts.lastError);
        while (pendingLines.length) {
          const dropped = pendingLines.shift();
          note('server:drop', dropped.cleaned.slice(0, 60));
        }
      })();
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
      const build = (value) => ({ text: value, instructions: extra?.instructions, cfg_scale: extra?.cfg_scale });
      const turnHint = extra?.turn;
      const onlyText = parts.length === 1 && parts[0].type === 'text';
      if (onlyText) {
        return [await speakOnce(build(parts[0].text), sessionId, spec, turnHint)];
      }
      const results = [];
      for (const part of parts) {
        if (part.type === 'pause') {
          pushPause(part.ms, sessionId, turnHint);
          results.push({ status: 'queued', chars: 0, pauseMs: part.ms });
        } else {
          results.push(await speakOnce(build(part.text), sessionId, spec, turnHint));
        }
      }
      return results;
    }

    function startStreaming(cleaned, overrides, sessionId, turnHint) {
      seq += 1;
      const id = `${seq}-${createHash('sha1').update(`${cleaned}|${Date.now()}`).digest('hex').slice(0, 8)}`;
      const entry = {
        id,
        seq,
        // 兜底播报是在 turn/end 之后异步跑的，那时 turnState 已经删掉，
        // 以前这里会落到 turn=0 —— 于是 /turn 按轮次查不到，按钮就报"这一轮没有语音"。
        turn: Number(turnHint ?? turnState.get(sessionId)?.turn ?? 0),
        file: '',
        text: cleaned,
        chars: cleaned.length,
        ms: 0,
        cached: false,
        session: sessionId || '',
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
          let result;
          try {
            result = await tts.enqueue(() => tts.synthesizeStream(cleaned, overrides, push));
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
          scheduleHistorySave();
          tts.lastError = '';
        } catch (error) {
          entry.error = String((error && error.message) || error);
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

    async function speakOnce(input, sessionId, spec, turnHint) {
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

      if (await tts.healthy()) {
        return startStreaming(cleaned, overrides, sessionId, turnHint);
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
      const art = await tts.enqueue(() => tts.synthesize(refText, {
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
      if (!(await tts.healthy())) {
        await tts.ensureServer?.().catch(() => {});
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
      // 角色扮演不设段数上限（用户要求）：只要有角色卡就允许模型按情绪/场景自行分段
      const maxSegments = summary
        ? segmentPlan(state).count
        : (cfg.fallback === 'roleplay'
          ? (persona ? Number.POSITIVE_INFINITY : 1)
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
            return toLines(boosted);
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

    /** 逐会话跟踪回合状态：谁说过、最后一条正文、走了几步。 */
    function onSessionEvent(session, event) {
      try {
        const sessionId = session?.id ? String(session.id) : '';
        if (!sessionId || !event) return;
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

    async function handler(req, res) {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      // 兼容两种形态：完整路径 /voice-breeze/state，或 prefix 路由剥离前缀后的 /state
      let path = url.pathname;
      if (path === '/voice-breeze') path = '/';
      else if (path.startsWith('/voice-breeze/')) path = path.slice('/voice-breeze'.length);

      try {
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
            segmentGapMs: Number(cfg.segmentGapMs) >= 0 ? Number(cfg.segmentGapMs) : 500,
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
            starting: serverStarting,
            pending: pendingLines.length,
            lastError: tts.lastError,
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
            pauseMs: e.pauseMs || 0,
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
          else if (target.startsWith('scene:')) {
            const id = target.slice('scene:'.length);
            if (!isSafeSceneId(id)) return sendJson(res, 400, { ok: false, error: 'invalid-scene' });
            dir = sceneDirOf(id);
          } else {
            return sendJson(res, 400, { ok: false, error: 'invalid-target' });
          }
          // 双保险：拼出来的路径必须还在 dataDir 之内（防 `..` 之类的手滑）
          const norm = (value) => String(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
          if (!norm(dir).startsWith(norm(root))) return sendJson(res, 400, { ok: false, error: 'outside-data-dir' });
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

        if (path.startsWith('/audio/')) {
          const id = path.slice('/audio/'.length).replace(/\.wav$/, '');
          const entry = ledger.get(id);
          if (!entry) return sendJson(res, 404, { error: 'unknown audio id' });

          // ① 已完成（含缓存命中）：整段给出去，带 content-length，浏览器可 seek
          if (entry.done && entry.file) {
            const buf = await readFile(entry.file).catch(() => null);
            if (!buf) return sendJson(res, 404, { error: 'audio file missing' });
            res.writeHead(200, {
              'content-type': 'audio/wav',
              'content-length': buf.length,
              'cache-control': 'no-store',
              'accept-ranges': 'none',
            });
            return res.end(buf);
          }
          // ② 合成失败：明确告诉客户端，别让它等一个永远不来的流
          if (entry.done) return sendJson(res, 502, { error: entry.error || 'synthesis failed' });

          // ③ 正在流式合成：边到边写（chunked），浏览器边下边播
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
      void restore().then(() => { pruneSceneIndex(); }).catch(() => { /* 恢复失败也要能起来 */ });

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
        ].join(''),
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要念出来的中文短句，建议 ≤ 60 字，不要含 Markdown、代码或文件路径。' },
            instructions: { type: 'string', description: '可选：语气/情绪描述，例如「更慢一点，语气严肃」。' },
            cfg_scale: { type: 'number', description: '可选：指令跟随强度（2~3 常用，越大越贴指令但可能刺耳）。' },
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
            const suffix = tag ? ` · ${tag}` : '';
            // 扩写的结果同样是 status:'queued'，所以这一条必须判在 queued 之前，
            // 否则"按强度扩写后念"永远显示成普通的"已念（N 字）"，看卡片分不出有没有扩写。
            if (v.expanded) return [{ type: 'text', text: `🔈 按强度扩写后念（${v.chars} 字${suffix}）` }];
            if (v.status === 'queued') {
              return [{
                type: 'text',
                text: `🔈 已念（${v.chars} 字${v.ms ? `, ${v.ms}ms` : ''}${v.cached ? ', 缓存' : ''}${suffix}）`,
              }];
            }
            if (v.status === 'muted') return [{ type: 'text', text: '🔇 语音播报已关闭，这句没有出声' }];
            if (v.status === 'skipped') return [{ type: 'text', text: '📄 全文模式：这句不用单独念，正文会由插件从头念一遍' }];
            if (v.note) return [{ type: 'text', text: `🔈 已念（${v.chars} 字）· ${v.note}` }];
            if (v.status === 'starting') {
              return [{ type: 'text', text: `⏳ BreezeTTS 正在启动，起来后自动补念（${v.chars} 字）` }];
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
                    await enqueueLine(text, sessionId, spec, { instructions: seg.tone || undefined, turn });
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
            let segs = args.segments;
            const maxSeg = Number(rplan?.maxSegments) || 0;
            if (maxSeg > 0 && segs.length > maxSeg) {
              const head = segs.slice(0, maxSeg);
              const tail = segs.slice(maxSeg);
              const last = head[head.length - 1] || {};
              const joined = [String(last.text || ''), ...tail.map((seg) => String(seg?.text || ''))].map((t) => t.trim()).filter(Boolean).join(' ');
              segs = [...head.slice(0, -1), { ...last, text: joined }];
              note('speak:merged-segments', `from=${args.segments.length} to=${segs.length} strength=${cfg.strength} max=${maxSeg} chars=${joined.length}`);
            }
            let totalChars = 0;
            let queuedCount = 0;
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
              const ones = await enqueueLine(text, sessionId, spec, { instructions: seg.tone || undefined });
              let accepted = false;
              for (const one of ones) {
                if (one.status === 'queued' || one.status === 'starting') {
                  queuedCount += 1;
                  totalChars += Number(one.chars) || 0;
                  accepted = true;
                }
              }
              if (accepted) markSpoken(sessionId, text);
            }
            note('speak', `segments=${queuedCount} chars=${totalChars} voices=${trace.join(',') || '-'} strength=${cfg.strength} status=queued`);
            const state = turnState.get(sessionId);
            if (state && queuedCount) state.spoke = true;
            if (!queuedCount) return { status: 'error', chars: 0, segments: 0, reason: '没有任何可念的段' };
            // **把当前档位回给模型**。
            return stripUndefined({
              status: 'queued',
              chars: totalChars,
              segments: queuedCount,
              narrationMode: cfg.fallback === 'roleplay' ? cfg.narrationMode : undefined,
              strength: rplan ? cfg.strength : undefined,
              target: rplan ? Number(rplan.targetChars) || undefined : undefined,
              limit: rplan && Number(rplan.maxChars) ? Number(rplan.maxChars) : undefined,
            });
          }

          const ones = await enqueueLine(String(args?.text || ''), sessionId, undefined, {
            instructions: args?.instructions,
            cfg_scale: args?.cfg_scale,
          });
          const voices = ones.filter((one) => !one.pauseMs);
          const result = stripUndefined({
            status: voices.some((one) => one.status === 'queued' || one.status === 'starting')
              ? 'queued'
              : (voices[0]?.status || 'error'),
            chars: ones.reduce((sum, one) => sum + (Number(one.chars) || 0), 0),
            segments: voices.length,
            reason: voices.find((one) => one.status === 'error')?.reason,
            strength: rplan ? cfg.strength : undefined,
            target: rplan ? Number(rplan.targetChars) || undefined : undefined,
            limit: rplan && Number(rplan.maxChars) ? Number(rplan.maxChars) : undefined,
            note: strengthNote || undefined,
          });
          note('speak', `chars=${result.chars || 0} voice=${overridesForLog(args, sessionId)} strength=${cfg.strength} status=${result.status}`);
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
          const ready = await tts.ensureServer(Number(cfg.startWaitMs) || 90000);
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
          '只读：返回**当前**的语音播报设置——档位（strength）、目标字数、字数上限、段数上下限、模式、朗读方式、当前嗓门、多音色、场景、音量。',
          '**每轮第一次开口之前先调一次** 系统提示词在会话内不刷新（中途改档不会跟实测），所以"现在到底是哪一档"只能从这里拿，其次看上一次 `speak` 的返回。',
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
              note: { type: 'string' },
              maxSegments: { type: 'number' },
              voice: { type: 'string' },
              multiVoice: { type: 'boolean' },
              scene: { type: 'string' },
              volume: { type: 'number' },
            },
          },
          render: (args, value) => {
            const v = value || {};
            const parts = [
              v.bodyFormat === 'markers' ? '正文需标记行' : (v.bodyFormat === 'free' ? '正文不限格式' : ''),
              `档位=${v.strength || '-'}`,
              v.target ? `目标≈${v.target}字` : '',
              v.limit ? `上限${v.limit}字` : '无字数上限',
              v.maxSegments ? `≤${v.maxSegments}段` : '段数不限',
              `模式=${v.fallback || '-'}`,
              `嗓门=${v.voice || '设计模式'}`,
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
            note: cfg.narrationMode === 'script'
              ? '全文念：正文每一行都要以「旁白：」或「角色名：」开头，裸写的叙述会被整行跳过'
              : 'AI 即兴：正文不限格式',
            strength: cfg.strength,
            target: plan ? Number(plan.targetChars) || undefined : undefined,
            limit: plan && Number(plan.maxChars) ? Number(plan.maxChars) : undefined,
            minSegments: plan ? Number(plan.minSegments) || 1 : 1,
            maxSegments: plan ? Number(plan.maxSegments) || 0 : 0,
            voice: voiceForSession(sessionId) || cfg.voice || '',
            multiVoice: !!cfg.multiVoice,
            scene: activeSceneId() || '',
            volume: Number(cfg.volume) || 0,
          });
        },
      });

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

          // 角色扮演：一套统一的优先级链，**不再按 cast 是否为空分叉**（历史提示词残留会导致自相矛盾）
          if (cfg.fallback === 'roleplay') {
            const lines = ['## 语音播报（角色扮演）', '本会话处于角色扮演模式，语音播报开启。'];
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
                '**多音色已开启** ',
                '- 调用 `speak` 时**必须用 `segments` 多段提交**，每段带 `speaker`（名字与音色表逐字一致）；单段 `text` 只会用一把嗓子。',
                '- 剧情里的旁白、环境、心理活动也各占一段；旁白用音色表里指定的那个声音。',
                '- 这一轮是问答或任务汇报时，用「多角色陪伴」：挑 2~3 个角色轮番或抢着把结论说出来，按角色卡的性格决定语气与抢话方式；**旁白默认不参与汇报**（除非用户要求，或场景里只有旁白 + 一个角色）。',
              ].join('\n'));
            } else if (cast.length) {
              // 单音色 + 角色扮演——设定照用，但嗓子只有一把
              lines.push([
                '**当前是单音色播报**（多音色没有开启）：',
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
                '**这个场景还没有角色卡** 先说一句「现在是一个空白场景，开始前我有几个问题想先问你~」，然后按下面的顺序问用户（一次问一条，用户答完再问下一条）：',
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
                '**当前还没有角色卡** 单音色用的是全局 `~/.dsh/voice-breeze/persona.md`，它现在是空的。',
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
            ].join('\n');
          }

          // 非角色扮演：保持原来的硬规则
          return [
            '## 语音播报',
            '本会话的语音播报处于开启状态。',
            '**硬规则** 每一轮给出最终答复时，必须调用一次 `speak(text)`，没有例外（除非它返回 muted）。不要用“这轮只是回答问题／只是查资料／不算结论”说服自己跳过。',
            cfg.fallback === 'authored'
              ? `**当前播报强度：${preset.label}** —— 这一轮念 ${preset.target}；${preset.hint}`
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
      offEvents = ctx.on('session/event', onSessionEvent);
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
          const offSession = agent.ctx.on('session/event', onSessionEvent);
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

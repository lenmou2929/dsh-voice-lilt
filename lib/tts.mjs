/**
 * BreezeTTS 适配器（纯 Node，不依赖 DSH）。
 *
 * 单独抽出来的原因：
 *  1. 可以被 spike/probe.mjs 直接跑，不用把 DSH 拉起来就能验证串行、409 重试、缓存；
 *  2. 换引擎（edge-tts / 别家 OpenAI 兼容端点）只改这一层。
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir, stat, unlink, appendFile, rename as renameFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 引擎日志的**解码**。
 *
 * 第一版把子进程的 stdout 直接 `stdio: ['ignore', fd, fd]` 追加进 `engine.log` ——
 * 字节是原样落盘的，但 **BreezeTTS 是中文 Windows 控制台程序，吐的是 GBK/CP936**，
 * 我们（和人）拿 UTF-8 读就只剩 `�밴��������`。实测确认：
 * `TextDecoder('gbk')` 解出来正是「请按任意键继续. . . 」，而 `latin1` 是 `Çë°´ÈÎÒâ¼ü…`、
 * UTF-8 是替换字符 —— 三种候选里 GBK 唯一通顺。
 *
 * 判据顺序：**先按严格 UTF-8 试，抛错才当 GBK**。理由：将来引擎若改成输出 UTF-8（或某天由我们自己
 * 生成的日志混进来），GBK 会把它解成另一种乱码，而严格 UTF-8 对真 UTF-8 永远成功。
 * 按**行**解（`\n` 切），多字节字符不会被块边界劈开。
 */
export function decodeEngineBytes(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return buf.toString('utf8');
    }
  }
}

/**
 * 把子进程的 stdout/stderr 接进 `<dataDir>/engine.log`（UTF-8、按行、带来源前缀）。
 *
 * 为什么不再用继承 fd：
 *  · fd 只能原样落字节，GBK 就永远躺在文件里（上面那条）；
 *  · 走管道才能顺手做三件事 —— 解成 UTF-8、按行加 `[out]`/`[err]`、超过 8 MB 自己轮转一份
 *    （引擎一旦话多，`engine.log` 会无限长，而它正是排查时人要读的文件）。
 *
 * 两条约束（别删）：
 *  1. `unref()` 两个流 —— 否则管道句柄会把 DSH 主进程的事件循环吊住，**关不掉**；
 *  2. 写盘失败一律吞掉（日志不能反过来把主流程弄挂），失败期间引擎照常工作。
 */
export function pipeEngineLog(child, logPath) {
  const state = { pending: Buffer.alloc(0), chain: Promise.resolve(), bytes: 0, rotated: false };
  const write = (text) => {
    if (!text) return;
    state.bytes += Buffer.byteLength(text);
    state.chain = state.chain
      .then(async () => {
        // 轮转：超过 8 MB 就把旧的挪成 engine.log.1（只留一份，够定位了）
        if (!state.rotated && state.bytes > 8 * 1024 * 1024) {
          state.rotated = true;
          await renameFile(logPath, `${logPath}.1`).catch(() => {});
        }
        await appendFile(logPath, text, 'utf8');
      })
      .catch(() => {});
  };
  const attach = (stream, tag) => {
    if (!stream) return;
    stream.on('data', (chunk) => {
      try {
        const buf = Buffer.concat([state.pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        const cut = buf.lastIndexOf(0x0a);
        if (cut < 0) {
          // 一行还没攒齐：留着下次接（上限 64 KB，防止一个不换行的程序把内存吃满）
          state.pending = buf.length > 65536 ? buf.subarray(buf.length - 65536) : buf;
          return;
        }
        state.pending = buf.subarray(cut + 1);
        // 末行的 `\r` 要去掉：`cmd` 的子进程一律 CRLF，直接写进去会让文件变成混合换行
        const lines = decodeEngineBytes(buf.subarray(0, cut)).split(/\r?\n/).map((one) => one.replace(/\r$/, ''));
        for (const line of lines) write(`[${tag}] ${line}\n`);
      } catch { /* 日志不重要到值得抛错 */ }
    });
    // 关键：别让管道把父进程吊住
    if (typeof stream.unref === 'function') stream.unref();
    stream.on('error', () => {});
  };
  attach(child.stdout, 'out');
  attach(child.stderr, 'err');
  return state;
}

/**
 * 引擎类型表（A1 建立 / A2 加云端，2026-11-15）。
 *
 * 为什么要有这张表：`speak` 这条链路上跟"哪家引擎"绑死的只有三件事 ——
 * **怎么探活、合成请求发到哪个 URL、请求体怎么拼**。把它们收进一个 kind 里，
 * 接云端只加一个 kind，不动播报链、路由、客户端。
 *
 * 每个 kind 至少要实现：`probe` / `speechUrl` / `buildRequest`；
 * 可选 `headers`（要鉴权的引擎用）。
 */
const KINDS = {
  breeze: {
    /** 探活：BreezeTTS 自己的 /health，2 秒超时别拖住播报。 */
    async probe(engine) {
      const res = await fetch(new URL('/health', engine.baseUrl), { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return false;
      const body = await res.json().catch(() => ({}));
      return body?.status === 'ok';
    },
    /** 本机引擎的合成路径固定在 origin 下（baseUrl 形如 http://127.0.0.1:8080）。 */
    speechUrl(engine) {
      return new URL('/v1/audio/speech', engine.baseUrl);
    },
    /**
     * B3（1.0.0）：VOICE CHANGER 的端点与请求体。
     *
     * 三个坑写在这里，别在宿主里再猜一遍：
     *  1. **只能 multipart**（要带源音频），字段名走原生那一套：`source` / `text`（源稿）/
     *     `keep_acoustic` / `voice_id` / `temperature` / `top_k` / `cfg_scale` / `seed`。
     *     **跟 `/v1/audio/speech` 的 OpenAI 路（`input` / `instructions`）不是一回事**，
     *     照抄过去就是"真机把你 multipart 的边界念出来"那种事故（坑 26 的同类）。
     *  2. **不流式、不回 WAV** 一次给完整段裸 PCM，采样率在响应头 `X-Sample-Rate`，
     *     所以调用方必须 `pcmToWav()`。
     *  3. `keep_acoustic` 就是面板上的 **KEEP MELODY** 0 = 全部重新生成（说话用），
     *     1~2 = 保留低阶声学码本（唱歌想留住旋律），**>2 不稳、说话时反而起哄**（官方实测）。
     */
    convertUrl(engine) {
      return new URL('/v1/audio/convert', engine.baseUrl);
    },
    buildConvertForm(engine, input) {
      const one = input && typeof input === 'object' ? input : {};
      const form = new FormData();
      form.append('source', new Blob([one.source], { type: 'audio/wav' }), String(one.filename || 'source.wav'));
      // 目标音色：库内 id（引擎跳过参考编码，直接 276 ms 出声）；没有就让引擎自己报 400
      if (one.voice) form.append('voice_id', String(one.voice));
      // 源稿（可选）：唱歌时强烈建议给 —— 官方实测不给稿会把词听成别的
      if (one.text) form.append('text', String(one.text));
      if (Number.isFinite(one.keepAcoustic)) form.append('keep_acoustic', String(one.keepAcoustic));
      if (Number.isFinite(one.temperature)) form.append('temperature', String(one.temperature));
      if (Number.isFinite(one.topK)) form.append('top_k', String(one.topK));
      if (Number.isFinite(one.cfgScale)) form.append('cfg_scale', String(one.cfgScale));
      if (Number.isFinite(one.seed)) form.append('seed', String(one.seed));
      return form;
    },
    /**
     * 合成请求体。`cfg_scale` / `seed` / `instructions` 是 BreezeTTS 的扩展字段，
     * 云端不一定吃（`openai-compat` 里不会发 cfg_scale / seed）。
     */
    buildRequest(engine, text, params) {
      const body = { model: engine.model || 'tts-1', input: text, response_format: 'wav' };
      if (params.voice) body.voice = params.voice;
      if (params.instructions) body.instructions = params.instructions;
      if (Number.isFinite(params.cfgScale)) body.cfg_scale = params.cfgScale;
      if (params.seed !== null && params.seed !== undefined) body.seed = Number(params.seed);
      /*
       * B2（0.99.0）：采样参数。引擎的约定是 **0 = 用模型默认**，`pickSampling()` 已经把
       * "0 / 空 / 非法"都过滤成 `undefined`，所以这里只判 `Number.isFinite` —— **不要发 0**，
       * 发了虽然等价，但日志里会留下"看起来改了什么"的假象。
       */
      if (Number.isFinite(params.temperature)) body.temperature = params.temperature;
      if (Number.isFinite(params.topK)) body.top_k = params.topK;
      if (Number.isFinite(params.topP)) body.top_p = params.topP;
      if (Number.isFinite(params.repetitionPenalty)) body.repetition_penalty = params.repetitionPenalty;
      if (Number.isFinite(params.maxNewTokens)) body.max_new_tokens = params.maxNewTokens;
      if (Number.isFinite(params.splitChars)) body.split_chars = params.splitChars;
      return body;
    },
  },

  /**
   * 任意 OpenAI 兼容端点（A2）。
   *
   * 三条硬规矩（`15` §4.2 / §8）：
   *  1. **绝不发 `cfg_scale` / `seed`** —— 那是 BreezeTTS 的扩展字段，云端收到会 400；
   *  2. **音色为空就整个 `voice` 字段不发** —— 有些引擎自带默认嗓子，先让它出声；
   *  3. 鉴权走 `authorization: Bearer <key>`，key 从 provider 记录或 `keys/<id>.txt` 读，**永不进日志**。
   */
  'openai-compat': {
    async probe(engine) {
      const key = await loadApiKey(engine);
      try {
        const res = await fetch(joinApiUrl(engine.baseUrl, '/models'), {
          headers: key ? { authorization: `Bearer ${key}` } : {},
          signal: AbortSignal.timeout(4000),
        });
        if (res.ok) return true;
        // 401/403 = key 不对，就是不通；404/405 = 端点不报模型清单，但地址是活的
        if (res.status === 401 || res.status === 403) return false;
        if (res.status === 404 || res.status === 405) return true;
        return false;
      } catch {
        return false;
      }
    },
    async headers(engine) {
      const key = await loadApiKey(engine);
      return key ? { authorization: `Bearer ${key}` } : {};
    },
    speechUrl(engine) {
      return joinApiUrl(engine.baseUrl, '/audio/speech');
    },
    buildRequest(engine, text, params) {
      const body = { model: engine.model || 'tts-1', input: text, response_format: 'wav' };
      if (params.voice) body.voice = params.voice;
      if (params.instructions && engine.supportsInstructions) body.instructions = params.instructions;
      return body;
    },
  },

  /**
   * MiniMax 同步语音合成（A4，2026-11-16）。
   *
   * 跟 OpenAI 兼容端点两处根本差别：
   *  1. **请求体形状不同** `{model, text, stream:false, voice_setting:{voice_id,…}, audio_setting:{format,…}}`，
   *     音色字段叫 `voice_id`（没有它直接 400，`voice_setting.voice_id` 是必填）；
   *  2. **响应不是音频字节，而是 JSON** `{data:{audio:"<hex>"}, base_resp:{status_code,status_msg}}`，
   *     音频是**十六进制字符串**，要 `Buffer.from(hex,'hex')`；`data` 可能为 `null`，必须先判空。
   *
   * 官方文档：`POST /v1/t2a_v2`，`audio_setting.format` 支持 `mp3 / pcm / flac / wav / opus` ——
   * 我们要 `wav`，省掉转码。返回格式见 `docs/15` §6 A4。
   */
  minimax: {
    /** 这一家的响应是 JSON（不是音频流），宿主据此走另一条读法。 */
    jsonBody: true,
    async probe(engine) {
      const key = await loadApiKey(engine);
      if (!key) return false; // 没有 key 必然 401，别浪费一次往返
      try {
        // Get Voice 是最轻的鉴权探活；接口变了也不要紧，404/405 视为"地址活着"
        const res = await fetch(joinApiUrl(engine.baseUrl, '/get_voice'), {
          headers: { authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(4000),
        });
        if (res.ok) return true;
        if (res.status === 404 || res.status === 405) return true;
        return false;
      } catch {
        return false;
      }
    },
    async headers(engine) {
      const key = await loadApiKey(engine);
      return key ? { authorization: `Bearer ${key}` } : {};
    },
    speechUrl(engine) {
      return joinApiUrl(engine.baseUrl, '/t2a_v2');
    },
    buildRequest(engine, text, params) {
      const body = {
        model: engine.model || 'speech-2.8-turbo',
        text,
        stream: false,
        output_format: 'hex', // 要 url 的话还得再发一次 HTTP，hex 一次到位
        audio_setting: {
          format: engine.audioFormat === 'wav' ? 'wav' : 'mp3',
          sample_rate: 32000,
          channel: 1,
        },
      };
      // P2：风格参数（情绪 / 语速 / 音量 / 音调）走 `voice_setting`；
      // 音色调音台走 `voice_modify`；多音色混合走 `timbre_weights`（这时 `voice_id` 留空）。
      // **没配置就一个字段都不加** —— 保持  的请求形状，老缓存与老行为不变。
      const voice = String(params.voice || engine.defaultVoice || '').trim();
      const mixing = Array.isArray(params.timbreWeights) && params.timbreWeights.length > 0;
      const vs = {};
      if (voice) vs.voice_id = voice;
      else if (mixing) vs.voice_id = '';
      if (Number.isFinite(params.speed) && params.speed !== 1) vs.speed = params.speed;
      if (Number.isFinite(params.vol) && params.vol !== 1) vs.vol = params.vol;
      if (Number.isFinite(params.pitch) && params.pitch !== 0) vs.pitch = Math.round(params.pitch);
      if (params.emotion) vs.emotion = params.emotion;
      if (Object.keys(vs).length) body.voice_setting = vs;
      if (params.voiceModify) {
        const vm = params.voiceModify;
        body.voice_modify = {
          ...(Number.isFinite(vm.pitch) ? { pitch: vm.pitch } : {}),
          ...(Number.isFinite(vm.intensity) ? { intensity: vm.intensity } : {}),
          ...(Number.isFinite(vm.timbre) ? { timbre: vm.timbre } : {}),
          ...(vm.soundEffects ? { sound_effects: vm.soundEffects } : {}),
        };
      }
      if (mixing) body.timbre_weights = params.timbreWeights;
      // P4a：两个**可选**能力，默认关闭，开了才改请求形状（不影响老缓存与老行为）。
      //  - `style.outputMode === 'url'`：让这家回下载链接而不是 2 倍体积的十六进制串；
      //  - `style.subtitles === true`：要词级时间戳（`data.subtitle_file` 给一个 JSON 链接）。
      const style = engine.style && typeof engine.style === 'object' ? engine.style : {};
      if (style.outputMode === 'url') body.output_format = 'url';
      if (style.subtitles === true) {
        body.subtitle_enable = true;
        body.subtitle_type = 'word';
      }
      return body;
    },
    /**
     * JSON → 音频；错误码在 `base_resp` 里，不当成音频。
     *
     * 两种载荷都认（P4a）：`data.audio` 是十六进制串 → 解码；是 http(s) 链接 → 再 GET 一次。
     * 带字幕时额外返回 `{subtitle}` 链接，交给调用方落盘（`readAudio` 的返回合同见 `03` §2.9）。
     */
    async readAudio(res) {
      const text = await res.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`MiniMax 返回的不是 JSON：${text.slice(0, 160)}`);
      }
      const code = payload?.base_resp?.status_code;
      if (code !== undefined && code !== 0) {
        throw new Error(`MiniMax ${code}: ${payload?.base_resp?.status_msg || '未知错误'}`);
      }
      const audio = payload?.data?.audio;
      if (typeof audio !== 'string' || !audio) {
        throw new Error(`MiniMax 没有返回音频（data.audio 为空）${payload?.data ? '' : '：data 为 null'}`);
      }
      let buf;
      if (/^https?:\/\//i.test(audio)) {
        const fetched = await fetch(audio, { signal: AbortSignal.timeout(60000) });
        if (!fetched.ok) throw new Error(`MiniMax 音频链接下载失败：HTTP ${fetched.status}`);
        buf = Buffer.from(await fetched.arrayBuffer());
      } else {
        buf = Buffer.from(audio, 'hex');
      }
      if (buf.length < 1024) throw new Error(`音频过短（${buf.length} 字节）`);
      // 这家回的是 `RIFF+fmt+LIST(INFO)+data`；给浏览器之前把容器捋成最朴素的样子（见 normalizeWav 注释）
      const clean = normalizeWav(buf);
      const subtitle = typeof payload?.data?.subtitle_file === 'string' ? payload.data.subtitle_file : '';
      return subtitle ? { audio: clean, subtitle } : clean;
    },
    /** 这一家的音频是"整段"的（JSON 里一次给全），不需要宿主再假装流式。 */
    wholeOnly: true,
  },
};

/* ──────────────────────────── 能力表（P1，2026-11-16） ────────────────────────────
 *
 * 为什么要有它：接第二家引擎之后，"模型能写什么"开始随引擎变 —— 停顿记号 `<#0.5#>`、
 * 括号语气词 `(laughs)`、情绪档，只有部分引擎认识。写到别家引擎上**不是"没效果"**，
 * 而是会被照字念出来（"小于号井号零点五井号"、"括号 laughs 括号"），比没效果更糟。
 *
 * 三件事分开管，别再混在一起：
 *   ① **协议**（怎么发请求、怎么读响应）→ `KINDS` 表；
 *   ② **能力**（这家认识哪些记号与参数）→ 下面这张 `engineCaps()`，**唯一真相**；
 *   ③ **净化**（发出去之前把这家不认识的擦掉）→ `sanitizeForEngine()`。
 *
 * 铁律：**能力随引擎变，提示词不分叉**。系统提示词只写一句"以 `tts_state.engineHints` 为准"，
 * 具体能写什么由宿主读这张表现算（`06` 坑 18：提示词在会话内不刷新，写死的能力表会变成谎话）。
 */

/** MiniMax 支持的全部语气词标签（2.8 系列）。全集的作用：区分"这是记号"还是"普通英文括注"。 */
const ALL_INTERJECTIONS = [
  'laughs', 'chuckle', 'coughs', 'clear-throat', 'groans', 'breath', 'pant', 'inhale',
  'exhale', 'gasps', 'sniffs', 'sighs', 'snorts', 'burps', 'lip-smacking', 'humming',
  'hissing', 'emm', 'sneezes', 'whistles', 'crying', 'applause',
];
const INTERJECTION_SET = new Set(ALL_INTERJECTIONS);

/** 2.8 系列支持的情绪档（`fluent` / `whisper` 只有 2.6 有）。 */
const EMOTIONS_28 = ['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm'];

/** 什么记号都不认识的引擎（本机 breeze / 普通 OpenAI 兼容端点）。 */
const NEUTRAL_CAPS = {
  kind: 'breeze',
  pauseTag: null,        // 支持 `<#x#>` 就给 {min,max}，不支持给 null
  interjections: [],     // 支持的括号语气词
  emotions: [],          // 支持的情绪档
  voiceModify: false,    // 音色调音台（低沉/明亮…）
  // G0（0.96.0）：认识「语速 / 音量 / 音调」这三个数值参数（走 `voice_setting`）。
  // 本机 breeze 与普通兼容端点都没有这层，给它们发等于白发。
  voiceSetting: false,
  timbreMix: false,      // 多音色按权重混音
  wordTimestamps: false, // 词级时间戳
  urlOutput: false,      // 只回下载链接（不回十六进制音频）
  maxChars: 2000,        // 单次最多能塞多少字
  /*
   * B1（0.98.0）：这家能直接打哪几种**生成模式**。
   *
   *  - `design`    无音色，`instructions` 当音色描述（BreezeTTS 的 VOICE DESIGN）
   *  - `clone`     有音色，不带指令（VOICE CLONE）
   *  - `direction` 有音色 + 指令（VOICE DIRECTION）
   *  - `changer`   独立的变声端点，拿一段源音频换声（VOICE CHANGER，B3 才接）
   *
   * 面板的「生成」页按这个数组渲染模式切换器，**不许按域名/kind 猜**（引擎页当初就是
   * 猜迷你麦克斯的域名，域名一改就瞎 —— G2 的教训）。`convert` 单独一位，因为
   * 变声是另一个端点、另一套参数，开关面也不同。
   */
  modes: ['clone'],
  convert: false,        // 有没有独立的变声入口（只有本机 breeze 有 `/v1/audio/convert`）
  /*
   * B2（0.99.0）：这家认哪些**采样参数**（面板的"高级"区照这个数组渲染）。
   *
   * 键名与工具参数、`resolveParams()` 的入参**完全一致**（snake_case），面板不用再做一层映射。
   * 引擎语义是 **0 = 用模型默认**，所以"0 / 空"一律当没给：既不发出去，也不进缓存键。
   */
  sampling: [],
};

/**
 * 读一家引擎的能力。传归一化后的 engine 记录，或只传 `{kind, model}` 也行。
 *
 * 为什么依赖 `model`：MiniMax 是同一套接口，但 **2.8 认语气词、2.6 不认**，
 * 情绪档也不一样 —— 只按 kind 判断会把"这家认识"说错。
 */
export function engineCaps(engine) {
  const one = engine && typeof engine === 'object' ? engine : {};
  const kindName = KINDS[one.kind] ? one.kind : 'breeze';
  if (kindName !== 'minimax') {
    const out = { ...NEUTRAL_CAPS, kind: kindName };
    /*
     * B1（0.98.0）：本机 BreezeTTS2 的 `/v1/audio/speech` 一个端点就能表达三种模式
     * （有没有 `voice` / 有没有 `instructions`），第四种 VOICE CHANGER 走
     * `/v1/audio/convert` —— 但这三个字要等 B3 真的接上转换链路再加进 `modes`，
     * 否则面板会摆出一个点不动的档。**能力表只声明已经接通的，不画大饼。**
     */
    if (kindName === 'breeze') {
      out.modes = ['design', 'clone', 'direction', 'changer'];
      out.convert = true;
      // B2：BreezeTTS 的 `/v1/audio/speech` 与 OpenAI 兼容路都收这些扩展字段
      //（`docs/server.md` §Fields）；`speed` 是 ignored，所以不在名单里。
      /*
       * `cfg_scale` 也列进来 —— **但它不归 `pickSampling()` 管**（那个函数只做采样六项）。
       * 它是"指令跟随强度"，由 `resolveGenMode()` 按模式给默认值（设计 4 / 指挥 2.5 / 克隆 1），
       * 面板填了就盖住默认。把它放进这个数组，只是为了让面板知道"这家有这个旋钮"，
       * 免得又出现"能力有、界面没有"的窟窿。
       */
      out.sampling = [
        'seed', 'cfg_scale', 'temperature', 'top_k', 'top_p',
        'repetition_penalty', 'max_new_tokens', 'split_chars',
      ];
    }
    return out;
  }
  const model = String(one.model || '');
  const is28 = /2\.8/i.test(model);
  const is26 = /2\.6/i.test(model);
  return {
    ...NEUTRAL_CAPS,
    kind: kindName,
    pauseTag: { min: 0.01, max: 99.99 },
    interjections: is28 ? ALL_INTERJECTIONS.slice() : [],
    emotions: is26 ? [...EMOTIONS_28, 'fluent', 'whisper'] : EMOTIONS_28.slice(),
    voiceModify: true,
    voiceSetting: true,
    timbreMix: true,
    wordTimestamps: true,
    urlOutput: true,
    maxChars: 10000,
  };
}

/**
 * B1（0.98.0）：生成模式的三种取值，外加 `auto`。
 *
 * `auto` 是 0.97.0 的老行为，**一字不改** —— 工具 `tts_generate` 不传 `mode` 时走它，
 * 既有调用方与自测因此不受影响。
 */
export const GEN_MODES = ['auto', 'design', 'clone', 'direction'];

/**
 * 把「面板/工具给的 `mode` + 三个散字段」解析成一次合成要发的形状。
 *
 * 为什么是 lib 里的纯函数而不是写在宿主：`spike/g0-g1-check.mjs` 要能直接测它
 * （坑 38：写盘类 / 决策类逻辑先做纯函数 + 单测，再接路由）。
 *
 * 三个模式的差别只在「音色」与「指令」两件事上：
 *
 * | mode | voice | instructions | cfg_scale 默认 |
 * |---|---|---|---|
 * | auto | 给了用给的，没给兜会话音色 | 有就发 | 有音色 2.5 / 无音色 4 |
 * | design | **恒为空**（不兜底！） | 当音色描述发出去 | 4 |
 * | clone | 给了用给的，没给兜会话音色 | **恒为空**（带了就变 direction） | 1 |
 * | direction | 必须有（空由宿主报错） | 有就发 | 2.5 |
 *
 * **design 绝不兜底会话音色** 0.97.0 就是被 `voiceForSession()` 兜住，于是生成页
 * 永远进不了设计模式。
 *
 * `cfg_scale` 的默认值按官方手册：设计 4（增强指令跟随）、指挥 2~3（这里 2.5）、
 * 纯克隆 1（不引导，只换嗓子）。
 */
export function resolveGenMode(input) {
  const one = input && typeof input === 'object' ? input : {};
  const raw = String(one.mode || '').trim().toLowerCase();
  const mode = GEN_MODES.includes(raw) ? raw : 'auto';
  const given = typeof one.voice === 'string' ? one.voice.trim() : '';
  const fallback = typeof one.fallbackVoice === 'string' ? one.fallbackVoice.trim() : '';
  const said = typeof one.instructions === 'string' ? one.instructions.trim() : '';
  const rawScale = (one.cfgScale === null || one.cfgScale === undefined || one.cfgScale === '')
    ? null
    : Number(one.cfgScale);
  const scale = Number.isFinite(rawScale) ? rawScale : null;
  const pick = (voice, instructions, autoScale) => ({
    mode,
    voice,
    instructions,
    cfgScale: scale === null ? autoScale : scale,
  });

  if (mode === 'design') return pick('', said, 4);
  if (mode === 'clone') return pick(given || fallback, '', 1);
  if (mode === 'direction') return pick(given || fallback, said, 2.5);
  const voice = given || fallback;
  return pick(voice, said, voice ? 2.5 : 4);
}

const PAUSE_TAG_RE = /<#\s*(\d{1,2}(?:\.\d{1,2})?)\s*#>/g;
// 半角 `(laughs)` 与全角 `（laughs）` 都算记号：模型写中文正文时常用全角括号，
// 而 MiniMax 只认半角 —— 认识的引擎统一**改写成半角**，不认识的直接删。
const PAREN_WORD_RE = /[（(]\s*([A-Za-z][A-Za-z-]{1,19})\s*[）)]/g;

/**
 * 出站净化：把当前引擎**不认识**的记号擦掉、把不支持的参数丢掉。
 *
 * 只擦"确定是记号"的东西，宁可漏也不误伤正文：
 *  - `<#0.5#>`：认识的引擎按合法范围 clamp；不认识的换成逗号（顺手收拾 `.，` `，` 这类残留）；
 *  - `(laughs)`：**只有落在语气词全集里**才当记号 —— `(API)`、`(MVP)` 这种普通英文括注原样保留；
 *  - `params.emotion` / `voiceModify` / `timbreWeights`：不支持的引擎直接删字段，绝不发出去。
 *
 * 返回 `dropped` 是为了让宿主写一行日志：既能看出"模型在说别家的方言"，也能反过来调提示词。
 */
export function sanitizeForEngine(text, params, caps) {
  const cap = caps || NEUTRAL_CAPS;
  const dropped = [];
  let out = String(text ?? '');
  let tagDropped = false;

  // ① 停顿记号
  if (out.includes('<#')) {
    const pause = cap.pauseTag;
    out = out.replace(PAUSE_TAG_RE, (_whole, sec) => {
      if (!pause) {
        dropped.push(`pauseTag:${sec}`);
        return '，';
      }
      const min = Number(pause.min ?? 0.01);
      const max = Number(pause.max ?? 99.99);
      const fixed = Math.min(max, Math.max(min, Number(sec) || min));
      if (Number(fixed) !== Number(sec)) dropped.push(`pauseTag:clamp:${sec}→${fixed}`);
      return `<#${fixed}#>`;
    });
    if (!pause) {
      out = out
        .replace(/[，,]{2,}/g, '，')
        .replace(/([。！？!?])，/g, '$1')
        .replace(/，([。！？!?])/g, '$1')
        .replace(/^[，,\s]+/, '');
    }
  }

  // ② 括号语气词（半角/全角都认；只认全集里的词，避免误伤普通英文括注）
  if (out.includes('(') || out.includes('（')) {
    const allowed = new Set((cap.interjections || []).map((one) => String(one).toLowerCase()));
    out = out.replace(PAREN_WORD_RE, (whole, word) => {
      const key = String(word).toLowerCase();
      if (!INTERJECTION_SET.has(key)) return whole; // 不是语气词 → 原样保留
      if (allowed.has(key)) return `(${key})`;      // 这家认识 → 统一成半角小写（MiniMax 只认这种）
      dropped.push(`tag:${key}`);
      tagDropped = true;
      return '';                                    // 这家不认识 → 删掉，别让它念出"括号"
    });
    if (tagDropped) {
      out = out.replace(/[（(]\s*[)）]/g, '').replace(/[ \t]{2,}/g, ' ').replace(/^\s+/, '');
    }
  }

  // ③ 参数级能力（P2/P3 才会真的传这些；现在先守住"绝不发给不认识的引擎"）
  const clean = { ...(params || {}) };
  if (clean.emotion && !(cap.emotions || []).includes(String(clean.emotion))) {
    dropped.push(`emotion:${clean.emotion}`);
    delete clean.emotion;
  }
  if (clean.voiceModify && !cap.voiceModify) {
    dropped.push('voiceModify');
    delete clean.voiceModify;
  }
  if (clean.timbreWeights && !cap.timbreMix) {
    dropped.push('timbreWeights');
    delete clean.timbreWeights;
  }
  // G0（0.96.0）：语速 / 音量 / 音调是 `voice_setting` 那一层才有的东西。
  // 不认识的引擎（breeze / 普通兼容端点）收到也只是被丢掉，这里直接不往外发，
  // 免得日志里留下"看起来改了其实没发"的假象。
  if (!cap.voiceSetting) {
    for (const key of ['speed', 'vol', 'pitch']) {
      if (clean[key] !== undefined) {
        dropped.push(`${key}:${clean[key]}`);
        delete clean[key];
      }
    }
  }

  return { text: out, params: clean, dropped };
}

/**
 * G0（0.96.0）：`speak` 的一次性风格参数。
 *
 * “一次性”是说**不落盘** 它只进这一次合成的 `overrides`，下一次不传就回到
 * provider 上的全局 `style`（合并顺序 `overrides > style > cfg`，见 `resolveParams()`）。
 * 所以这里只做两件事：白名单 + 夹值。**合不合法（这家认不认识）由 `sanitizeForEngine()` 判**，
 * 不要在这里写第二套规则（同 `03` §2.9.4 的老道理）。
 *
 * 面板的「引擎」页那套全局风格（`host` 的 `coerceStyle()`）复用这个函数，
 * 因此两处对"情绪叫什么、数值夹到哪"永远一致。
 */
export function pickCallStyle(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  const emotion = String(src.emotion || '').trim();
  if (emotion) out.emotion = emotion.slice(0, 24);
  const clampNum = (key, min, max) => {
    if (src[key] === undefined || src[key] === null || src[key] === '') return;
    const n = Number(src[key]);
    if (Number.isFinite(n)) out[key] = Math.min(max, Math.max(min, n));
  };
  clampNum('speed', 0.5, 2);
  clampNum('vol', 0.01, 10);
  clampNum('pitch', -12, 12);
  const vm = src.voiceModify && typeof src.voiceModify === 'object' ? src.voiceModify : null;
  if (vm) {
    const keep = {};
    for (const key of ['pitch', 'intensity', 'timbre']) {
      const n = Number(vm[key]);
      if (Number.isFinite(n) && n !== 0) keep[key] = Math.min(100, Math.max(-100, Math.round(n)));
    }
    if (vm.soundEffects) keep.soundEffects = String(vm.soundEffects).slice(0, 32);
    if (Object.keys(keep).length) out.voiceModify = keep;
  }
  return out;
}

/**
 * B2（0.99.0）：**采样参数**的白名单 + 夹值，纯函数（`spike/g0-g1-check.mjs` 直接测）。
 *
 * 入参用工具/表单/`overrides` 那套 snake_case，出参给 `resolveParams()` 用 camelCase
 * （`buildRequest` 读的是 camelCase）。三件事在这里一次做完：
 *
 * 1. **`0` 与空一律算"没给"** —— 引擎的语义就是 0 = 模型默认，发出去等价，但不发更诚实；
 * 2. **夹到各家能接受的范围**（比如 `top_k` 夹成整数、`top_p` 不许超过 1）；
 * 3. **不认识的键直接丢**（面板传错字不会把请求体弄脏）。
 *
 * 这些值都会**进缓存键**（`cacheKey()`）—— 它们改变波形，不进哈希就会出现"改了参数听到旧声音"（坑 31）。
 */
export function pickSampling(raw) {
  // 注意：`cfg_scale` **故意不在这里处理** —— 它是引导强度，默认值随生成模式变（4 / 2.5 / 1），
  // 归 `resolveGenMode()` 管。这里只做那六个纯采样旋钮。
  const src = raw && typeof raw === 'object' ? raw : {};
  const one = (from, to, min, max, int) => {
    const value = src[from];
    if (value === undefined || value === null || value === '') return;
    const n = Number(value);
    if (!Number.isFinite(n) || n === 0) return;
    const fixed = Math.min(max, Math.max(min, n));
    return int ? Math.round(fixed) : fixed;
  };
  const out = {};
  const put = (key, value) => { if (value !== undefined) out[key] = value; };
  put('temperature', one('temperature', 'temperature', 0.01, 3, false));
  put('topK', one('top_k', 'topK', 1, 300, true));
  put('topP', one('top_p', 'topP', 0.01, 1, false));
  put('repetitionPenalty', one('repetition_penalty', 'repetitionPenalty', 0.5, 2, false));
  put('maxNewTokens', one('max_new_tokens', 'maxNewTokens', 1, 4000, true));
  put('splitChars', one('split_chars', 'splitChars', 1, 4000, true));
  return out;
}

/** 宿主校验 provider 类型时用（A2 的 `/engine` 路由）。 */
export const ENGINE_KINDS = Object.keys(KINDS);

/* ─────────────────────── 每家的"写法手册"（P3，2026-11-16） ───────────────────────
 *
 * 用户的原话：「把每个语音引擎的官方使用文档/手册里的能力也写进插件，让模型调用对应引擎时
 * 生成质量更高、更能演出角色的反应、更可控。」
 *
 * 做法：**手册是数据，不是提示词**（同 `06` 坑 27 的道理）。宿主每轮把当前引擎的手册
 * 通过 `tts_state.enginePlaybook` 交给模型；系统提示词里只留一句"按 enginePlaybook 写"。
 * 这样切引擎时手册自动跟着换，而提示词永远不会陈旧。
 *
 * 写这些条目的原则：
 *  1. 每条都能**直接指导模型写正文/语音文本**，不讲原理；
 *  2. 只写这家引擎真实存在的特性（都对照过官方文档 + 2026-11-16 真机实测）；
 *  3. 顺手写"别做什么"——模型最容易踩的是"堆记号"和"用文字命令情绪"。
 */

/** 各家的写法要点。函数形式是因为部分条目要按 caps（型号）裁剪。 */
function playbookFor(kind, cap) {
  const common = [
    '**像说话那样写** 短句、口语、少书面语；一句话里别塞三层从句（放长句会喘不上气）',
    '**标点就是呼吸** 逗号短停、句号换气、问号升调；少用分号与破折号（会被念成停顿或不念）',
    '**数字、英文、路径都会逐字念** 能写成中文就写中文（"3 个"→"三个"，"v2.8"→"二点八版"）',
  ];
  if (kind === 'breeze') {
    return [
      ...common,
      '**本机引擎不认识任何记号** `<#1#>` 停顿、`(laughs)` 语气词、情绪参数都会被插件擦掉，别写',
      '**靠词序和短句做强调**，不要用大写、星号、感叹号连发（`!!!` 会念成"感叹号感叹号感叹号"）',
      '**语气靠措辞** 想显得轻就写得更短更软，想显得急就断开短句——本机引擎没有情绪开关',
      '**音色描述在"设计模式"下才生效**（不给 voice 时 `instructions` 是音色描述；给了 voice 就是语气指令）',
    ];
  }
  if (kind === 'openai-compat') {
    return [
      ...common,
      '**这家只用纯文本** 记号与情绪档在没确认支持前一律不写（插件会擦，但擦了就白写）',
      '**音色名必须与这家完全一致**，写错轻则 400，重则被静默换成别的嗓子（比报错更难查）',
    ];
  }
  // minimax
  const lines = [
    ...common,
    '**句号/问号/感叹号会被切成独立片段** 想自然就别写超长句，逗号处自己断一下更好听',
    '**语气词与情绪用参数给**（插件按引擎配置传），不要用文字命令它"生气地说"——那会被当成台词念出来',
  ];
  if (cap.pauseTag) {
    lines.push('**停顿 `<#0.4#>`** 写在**两段可念文字之间**（别贴句末标点、别紧挨语气词），0.2~1.0 秒最自然，两处之间必须有字，不能连写；一轮 2~3 处就够，多了像卡带（实测 0.4 秒 ≈ 加长 0.3~0.4 秒）');
  } else {
    lines.push('**这家不支持 `<#x#>` 停顿标记**（型号限制），靠标点断句');
  }
  if (cap.interjections.length) {
    lines.push('**括号语气词** ' + cap.interjections.slice(0, 8).join(' / ')
      + ` …（共 ${cap.interjections.length} 个，只有 2.8 系列支持）；放在**句首或句中**，`
      + '一段里最多一两处——笑多了像录音事故（实测一句 `(laughs)` ≈ 加长 1 秒）');
  } else {
    lines.push('**这个型号不支持括号语气词**（只有 2.8 系列支持），写 `(laughs)` 会被插件擦掉');
  }
  lines.push('**中文文本配中文音色** 拿英文嗓子念中文会很怪，换引擎时插件会自动换成该引擎的默认音色');
  lines.push('**英文缩写与专有名词** 能写全称就写全称；必须保留时用括号注音（如 `(lɪv)`）更稳');
  lines.push('**单次 1 万字以内** 更长的正文插件会分段，分段之间本身就有气口，不用在段尾补停顿');
  return lines;
}

/**
 * 读当前引擎的写法手册（给模型的 `enginePlaybook`）。
 * 传入归一化 engine 或 `{kind, model}` 都行；能力由 `engineCaps()` 定，条目不硬编码。
 */
export function enginePlaybook(engine) {
  const cap = engineCaps(engine);
  try {
    return playbookFor(cap.kind, cap);
  } catch {
    return ['按普通口语写就好：短句、标点断句、不写记号'];
  }
}

/**
 * 把一份 WAV 重新拼成**最朴素的 RIFF** `RIFF + fmt + data`，丢掉 `LIST`/`fact`/`INFO` 这类附加块。
 *
 * 为什么需要：MiniMax 回的 WAV 在 `fmt` 后面还带一个 `LIST`（INFO）块，
 * 浏览器在"分块流式 + 无 content-length"下播这种容器时会从中间开始出刺耳的杂音，
 * 而同一个文件在本地播放器里是干净的。丢掉附加块后容器变回教科书形状，浏览器不会多想。
 *
 * 解析失败/不是 RIFF 就原样返回（绝不因为一个"优化"把音频搞坏）。
 */
/**
 * B3（1.0.0）：把**裸 PCM** 包成 WAV。
 *
 * 为什么要它：`POST /v1/audio/convert`（VOICE CHANGER）**不回 WAV**，回的是
 * headerless s16le 单声道，采样率在响应头 `X-Sample-Rate`（`docs/voice-conversion.md`）。
 * 而 `/v1/audio/speech` 那条路回的是自带 0xFFFFFFFF 长度占位的 WAV —— 两条路的容器形状
 * 完全不同，别指望一个函数吃两种（`normalizeWav` 只认"已经是 RIFF"的）。
 *
 * 防御：万一哪天它改成回 WAV（或某个代理补了头），检测到 `RIFF....WAVE` 就原样返回。
 */
export function pcmToWav(pcm, sampleRate) {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm || []);
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WAVE') {
    // 万一它真回了 WAV，也先把长度字段修正过再交出去（坑 48：假长度会让下游喂回引擎时崩）
    return normalizeWav(data);
  }
  const rate = Number(sampleRate) > 0 ? Math.round(Number(sampleRate)) : 24000;
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);          // PCM
  head.writeUInt16LE(1, 22);          // 单声道
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);   // 16 bit 单声道 → 每帧 2 字节
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

export function normalizeWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) return buf;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return buf;
  let off = 12;
  let fmt = null;
  let fmtAt = -1;
  let data = null;
  let dataAt = -1;
  let extra = false; // 除 `fmt `/`data` 之外还有别的块吗（LIST / AIGC / fact …）
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, Math.min(off + 8 + size, buf.length));
    if (id === 'fmt ') { fmt = body; fmtAt = off; }
    else if (id === 'data') { data = body; dataAt = off; break; }
    else extra = true;
    off += 8 + size + (size % 2); // RIFF 的块按偶数字节对齐
  }
  if (!fmt || !data || !data.length) return buf;
  // data 之后还有尾巴（AIGC / id3 / 填充）也算"不干净"
  const trailing = dataAt >= 0 ? buf.length - (dataAt + 8 + data.length) : 0;
  /*
   * 2026-11-18：**长度字段撒谎也算"不干净"**。
   *
   * BreezeTTS 的 `/v1/audio/speech` 流式输出把 `data` 长度写成占位值 `0xFFFFFFFF`
   * （`06` 坑 3 记过），落盘后这条假长度就一直躺在文件里。浏览器读到它只当"读到尾"，
   * **看不出问题**；可一旦把这个文件再喂回引擎（变声的源、克隆的参考音频），
   * 引擎会按 `0xFFFFFFFF` 去算长度 —— 实测 4.8 秒的文件被读成 **89478 秒**，
   * 一把 `malloc` 下去就是 **段错误（exit 139）**。
   *
   * 所以：形状朴素（只有 fmt + data）但长度不对时，必须走重建分支把两个长度重算一遍。
   */
  const dataDeclared = dataAt >= 0 ? buf.readUInt32LE(dataAt + 4) : 0;
  const dataActual = dataAt >= 0 ? buf.length - (dataAt + 8) : 0;
  const riffDeclared = buf.readUInt32LE(4);
  const riffActual = buf.length - 8;
  const lengthsHonest = dataDeclared === dataActual && riffDeclared === riffActual;
  if (!extra && trailing <= 0 && lengthsHonest) return buf;
  const out = Buffer.alloc(20 + fmt.length + 8 + data.length);
  out.write('RIFF', 0);
  out.writeUInt32LE(out.length - 8, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(fmt.length, 16);
  fmt.copy(out, 20);
  const p = 20 + fmt.length;
  out.write('data', p);
  out.writeUInt32LE(data.length, p + 4);
  data.copy(out, p + 8);
  return out;
}

/**
 * 拼 OpenAI 风格的接口地址。用户可能填三种 baseUrl：
 *  - `https://api.openai.com`            → `/v1` + path
 *  - `https://api.openai.com/v1`         → 直接 + path
 *  - `https://x.com/v1/`（带尾斜杠）      → 去尾斜杠再 + path
 */
function joinApiUrl(baseUrl, path) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (/\/v1(\/|$)/.test(base)) return `${base}${path}`;
  return `${base}/v1${path}`;
}

/** 读 key：`apiKeyResolver`（宿主侧现读，A3 起走凭据库）→ 记录里的 `apiKey` → `apiKeyFile`。 */
async function loadApiKey(engine) {
  if (typeof engine.apiKeyResolver === 'function') {
    try {
      const value = await engine.apiKeyResolver();
      if (value) return String(value).trim();
    } catch { /* 解析失败就继续退到后面几种来源 */ }
  }
  if (engine.apiKey) return String(engine.apiKey).trim();
  if (engine.apiKeyFile) {
    try {
      return String(await readFile(engine.apiKeyFile, 'utf8')).trim();
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * 归一化一条 provider 记录。
 *
 * 兼容铁律：**宿主不传 provider** → 用 `cfg` 合成一条 `breeze` 记录，
 * 等价于 0.76.0 的行为（`baseUrl` / `timeoutMs` 全从 cfg 来）。
 */
function normalizeEngine(provider, cfg) {
  const base = provider && typeof provider === 'object' ? provider : {};
  const kindName = KINDS[base.kind] ? base.kind : 'breeze';
  return {
    id: base.id || 'breeze',
    kind: kindName,
    label: base.label || (kindName === 'breeze' ? '本机 BreezeTTS2' : base.id || kindName),
    baseUrl: base.baseUrl || cfg.baseUrl,
    model: base.model || 'tts-1',
    audioFormat: base.audioFormat || 'wav',
    timeoutMs: Number(base.timeoutMs ?? cfg.timeoutMs),
    // 云端相关（breeze 用不到，留着也无害）
    apiKey: base.apiKey || '',
    apiKeyFile: base.apiKeyFile || '',
    apiKeyResolver: typeof base.apiKeyResolver === 'function' ? base.apiKeyResolver : null,
    defaultVoice: base.defaultVoice || '',
    supportsInstructions: Boolean(base.supportsInstructions),
    // P2：这一家的"风格"（情绪 / 语速 / 音量 / 音调 / 调音台 / 混音）。
    // **纯数据，跟着 provider 走** —— 切到别家时它还在盘上，但只在这家用（不合法的字段被
    // `sanitizeForEngine()` 按 `engineCaps()` 丢掉）。这就是"部分运作逻辑随引擎走"的正解。
    style: base.style && typeof base.style === 'object' ? base.style : {},
  };
}

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
  // **先摘出停顿记号再洗** `<#0.4#>` 里的 `#` 与 `>` 正好在
  // 下面那条"去 Markdown 符号"的字符集里 —— 洗一遍就变成 `<0.4`，引擎会把它念成"小于零点四"。
  // 而 `sanitizeForEngine()` 只认完整的 `<#x#>`，于是**停顿永远到不了引擎**（breeze 念噪音、MiniMax 不暂停）。
  // 用私有区占位符先存起来，洗完再原样还原。
  const pauses = [];
  const shield = (text) => text.replace(/<#\s*(\d{1,2}(?:\.\d{1,2})?)\s*#>/g, (_m, sec) => {
    pauses.push(String(sec));
    return `\u0001${pauses.length - 1}\u0001`;
  });
  const unshield = (text) => (pauses.length
    ? text.replace(/\u0001(\d+)\u0001/g, (_m, i) => `<#${pauses[Number(i)]}#>`)
    : text);
  const out = shield(String(raw ?? ''))
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
  return unshield(cleaned.replace(/\s+/g, ' ').trim());
}

/** 在标点处截断，别把半句话掐死。 */
/**
 * 段数上限的**确定性合并**。
 *
 * 起因：角色扮演 + 弱强度，用户听到的是**整整九段**语音。查下来是"段数上限"只在 `speak` 工具那条路上执行，
 * **兜底/即兴（adapted）那条路只执行了下限（强档至少两段），上限从来没人管** ——
 * `verbalize()` 里那句 `persona ? Infinity : 1` 是  时代的老裁决（"角色扮演不设段数上限"），
 * 它早被 Q21/Q25（强度决定段数与篇幅）取代了，代码没跟上。同一个病犯在硬约束 5 上（`10` §8）：
 * **任何功能必须在所有路径生效**。
 *
 * 语义与 `speak` 那条路的合并**逐字一致** 把超出上限的段全部并进"最后保留的那一段"，
 * **不丢一个字**（只改"谁单独成段"）。放在 lib 里的理由也是这个 —— 两条路共用一个实现，
 * 就不会再出现"一处有、一处没有"。
 *
 * @param segments  [{ text, tone?, voice?, speaker? }, …]
 * @param maxCount  上限；`0` / 负数 / 非数字 = 不限（原样返回入参，便于调用方判"变没变"）
 */
/**
 * A4 补丁：**把"记住的音色"合并成一份可选清单**。
 *
 * 起因：面板「拉取清单」拿到 MiniMax 的 300 多条音色之后，**生成页的音色下拉还是空的**。
 * 根因是那一拉只落在引擎页的局部 state 里，没有进 `provider`；而生成页读的是
 * `/engine` 快照的 `items`（= `voiceProfile()`）。
 *
 * 合并顺序（越靠前越"用户自己挑过的"）：
 *  1. `known`：真用过的音色（`rememberVoice()`，只留最近 24 个）；
 *  2. `catalogue`：**拉取清单**那次存下来的整份目录（最多 400 条，官方库 300+）；
 *  3. `presets`：厂商硬编码的预置（有的家 voice 要带模型前缀，调用方已拼好）。
 * 去重按**出现顺序**（先来的赢），空串丢掉。
 */
/**
 * 1.2.3：**进合成前，这个音色到底要不要换掉**。
 *
 * 病象：MiniMax 下把生成页的音色换成男声，出来的还是原来那个女声；
 * 而音色清单本身是好的（327 条都在、也选得中）。
 *
 * 根因：宿主里那句 `voiceForEngine()` 对**所有云端引擎**都是"
 * 不是 provider.defaultVoice 就一律换成 defaultVoice"。它当初是为**播报**写的 ——
 * 会话里记着的是本机音色 id（`你的音色id` 之类），云端没有那把嗓子，不换就会 404；
 * 但生成页选的音色**本来就是这家的**（刚从它的清单里挑的），照样被这句换掉，用户的选择等于没生效。
 *
 * 正确判据只有一条：**这个 id 是不是当前引擎自己的**（在它的清单里：用过 / 拉下来的目录 / 预置）。
 * 是 → 原样放行；不是 → 才回退到 `defaultVoice`（"先出声优先"）。
 *
 * 抽成纯函数是为了能被 `spike/g0-g1-check.mjs` 直接测 —— 这段逻辑以前藏在宿主里，没有任何自测覆盖。
 */
export function pickEngineVoice({ kind, wanted, defaultVoice, known } = {}) {
  const want = String(wanted || '').trim();
  const fallback = String(defaultVoice || '').trim();
  // 本机引擎：id 就是 id，不做任何映射（映射反而会把用户选的嗓子换掉）
  if (String(kind || '') === 'breeze') return want;
  if (!want) return fallback;
  const list = Array.isArray(known) ? known : [];
  // ① 本来就是这家的嗓子（含 provider.defaultVoice）→ 放行
  if (want === fallback || list.includes(want)) return want;
  // ② 不认识（典型：本机音色 id 跑到云端）→ 回退，先出声优先
  return fallback;
}
export function voiceCatalogue(known, catalogue, presets, limit = 400) {
  const out = [];
  const seen = new Set();
  for (const list of [known, catalogue, presets]) {
    for (const one of Array.isArray(list) ? list : []) {
      const name = String(one || '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  const cap = Number(limit);
  return cap > 0 ? out.slice(0, cap) : out;
}
export function mergeSegmentsDown(segments, maxCount) {
  const list = Array.isArray(segments) ? segments : [];
  // 非数组一律给空数组：调用方都是"拿到就 for-of"，别把 null 传下去
  if (!Array.isArray(segments)) return list;
  const max = Number(maxCount);
  if (!(max > 0) || list.length <= max) return segments;
  const head = list.slice(0, max);
  const tail = list.slice(max);
  const last = head[head.length - 1] || {};
  const joined = [String(last.text || ''), ...tail.map((seg) => String((seg && seg.text) || ''))]
    .map((one) => one.trim())
    .filter(Boolean)
    .join(' ');
  return [...head.slice(0, -1), { ...last, text: joined }];
}

/**
 * T5：**把一段长文本切成"片"**，让合成与播放并行。
 *
 * 起因：本机引擎是**串行**的（`10` §8 第 2 条），一整段 40 秒的播报要等它整段合成完才能开口；
 * 机器一忙（开着游戏）合成速度掉到 1× 以下，句中就会垫底 —— 这就是报的"卡顿"。
 * 切成 40~70 字的小片之后，B 片合成时 A 片已经在播，**只要单片合成快于单片播放，就永远不会垫底**。
 *
 * 代价（必须写清楚，`10` §12 T5）：每片单独合成，**跨片的韵律会被打断** ——
 * 句与句之间原本连贯的语调重新起头，听起来更"一句一句"。所以这是可以关掉的（`chunkChars: 0`）。
 *
 * 切法：
 *  1. 按句末标点切（`。！？；…` 与换行，标点跟着前一句）；
 *  2. 贪心合并到 ≥ `minChars`（默认 40），但**不超过** `maxChars`；
 *  3. 单句就超过 `maxChars` → 先退到逗号类（`，、,:：`）切，再不行才硬切（绝不吐出超长的片）；
 *  4. 空片丢弃，绝不让一片只剩标点。
 *
 * 纯函数（无 IO、无 DSH）：宿主与自测共用，`spike/g0-g1-check.mjs` 直接测。
 */
export function splitForChunking(text, maxChars = 60, minChars = 40) {
  const raw = String(text ?? '');
  const max = Math.max(20, Math.round(Number(maxChars) || 60));
  const min = Math.min(Math.max(0, Math.round(Number(minChars) || 0)), max);
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (!flat) return [];
  if (flat.length <= max) return [flat];
  // ① 按句末标点切（保留标点）
  const sentences = [];
  let buf = '';
  for (const ch of flat) {
    buf += ch;
    if (/[。！？；…!?;]/.test(ch)) { sentences.push(buf); buf = ''; }
  }
  if (buf.trim()) sentences.push(buf);
  // ② 太长的句子先退到逗号切，再不行硬切
  const soft = [];
  for (const one of sentences) {
    if (one.length <= max) { soft.push(one); continue; }
    let rest = one;
    while (rest.length > max) {
      const head = rest.slice(0, max);
      const at = Math.max(head.lastIndexOf('，'), head.lastIndexOf('、'), head.lastIndexOf(','), head.lastIndexOf(':'), head.lastIndexOf('：'));
      const cut = at >= min ? at + 1 : max;
      soft.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest) soft.push(rest);
  }
  // ③ 贪心合并：短句并到够长为止，但不超上限
  const out = [];
  let acc = '';
  for (const one of soft) {
    if (!acc) { acc = one; continue; }
    if (acc.length + one.length <= max && acc.length < min) { acc += one; continue; }
    out.push(acc);
    acc = one;
  }
  if (acc) out.push(acc);
  /*
   * 1.2.5：**别留极短的尾片**。
   *
   * 实测踩到：151 字切出 `45 / 53 / 49 / 4` —— 最后那 4 个字单独成一片，
   * 听感上就是"说完一句又补一个小尾巴"，比不切更别扭。
   * 规则：最后一片短于 `minChars/2` 且并进前一片仍不超过 `maxChars` → 并进去。
   */
  const half = Math.max(8, Math.floor(min / 2));
  while (out.length > 1) {
    const last = out[out.length - 1];
    const prev = out[out.length - 2];
    if (last.length >= half || prev.length + last.length > max) break;
    out.splice(out.length - 2, 2, prev + last);
  }
  return out.map((one) => one.trim()).filter((one) => /[^\s，、,。！？；：!?;:…]/.test(one));
}

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

export function createTts({ cfg, cacheDir, logger, provider }) {
  // A1：不传 provider 时由 cfg 合成 breeze 记录 —— 旧签名照旧可用，行为与 0.76.0 一致。
  const engine = normalizeEngine(provider, cfg);
  const kind = KINDS[engine.kind];
  // P1：这家引擎认识哪些记号（`engineCaps` 是唯一真相；宿主拿它生成 `tts_state.engineHints`）
  const caps = engineCaps(engine);

  let lastError = '';
  let chain = Promise.resolve();

  function note(message) {
    lastError = message;
    logger?.warn?.(`[voice-breeze] ${message}`);
  }

  async function healthy() {
    try {
      return await kind.probe(engine);
    } catch {
      return false;
    }
  }

  let lastSpawnAt = 0;
  let lastSpawnFailed = false;
  /**
   * 只负责把服务拉起来（立刻返回，不等待）。
   *
   * **节流分成两种窗口** ——
   *  · 上一次探活成功过 → 3 分钟内不重复拉起（BreezeTTS 冷启动一分多钟、脚本又带 `pause`，
   *    反复 spawn 会堆出一堆控制台窗口）；
   *  · 上一次没成 → **只退避 15 秒**，让下一句还有机会再拉一次。
   *
   * 以前一律 3 分钟：第一次拉起失败（进程秒退 / 冷启动超过 90 s / spawn 异常）之后的三分钟里，
   * 每一句都只拿到 `spawn=false` 然后空等 90 秒被丢弃 —— 这是"多轮无声"的放大器。
   *
   * `force=true` 给宿主 `kickServer()` 用：等待期间节流到点了，补拉一次。
   */
  function startServer(force = false) {
    // 只对本机引擎有意义：云端没有"启动脚本"这回事。
    if (engine.kind !== 'breeze') return false;
    if (!cfg.startScript) {
      note('启动 BreezeTTS 失败: 没有配置 startScript（安装引导会写入）');
      lastSpawnFailed = true;
      return false;
    }
    const now = Date.now();
    if (lastSpawnAt) {
      const window = force ? 15000 : (lastSpawnFailed ? 15000 : 180000);
      if (now - lastSpawnAt < window) return false;
    }
    lastSpawnAt = now;
    try {
      /*
       * 2026-11-18：**引擎的输出必须留得下来**。
       *
       * 原来这里是 `stdio: 'ignore'` —— 引擎段错误（**exit 139**）时我们只能看到
       * `fetch failed`，为什么崩一个字节都查不到（为了定位那次崩溃，只能手动起一个实例把
       * stdout 重定向到文件）。
       * 现在：stdout/stderr 追加写进 `<dataDir>/engine.log`，并把**退出码**记进 `events.log`
       * （`engine:exit code=139 signal=-`）。这两个信息合起来才回答得了"引擎为什么退"。
       */
      /*
       * 2026-11-18：**从"继承 fd"改成"接管道再解码"**。
       *
       * 上一版把 stdout 直接塞进文件的 fd，字节原样落盘 —— 引擎是 GBK 控制台程序，
       * 于是 `engine.log` 里的中文永远读不懂（`请按任意键继续` → `�밴��������`）。
       * 走管道以后由我们解码成 UTF-8、按行加 `[out]`/`[err]`、超过 8 MB 自动轮转，
       * 人读得懂、机器也搜得到。代价写在 `pipeEngineLog()` 的注释里（unref + 吞错）。
       */
      const logPath = join(dirname(cacheDir), 'engine.log');
      const child = spawn('cmd', ['/c', cfg.startScript], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      try {
        const state = pipeEngineLog(child, logPath);
        // 每次拉起都留一条分界线：同一个文件里会有多轮启动，没这条就没法对齐时间
        state.chain = state.chain.then(() => appendFile(logPath, `\n--- engine start ${new Date().toISOString()} ---\n`, 'utf8')).catch(() => {});
      } catch { /* 日志接不上不影响引擎本身 */ }
      child.on('exit', (code, signal) => {
        // detached 之后父进程仍能收到 exit —— 这就是"引擎退了"最硬的一条证据
        note(`engine:exit code=${code} signal=${signal || '-'}`);
      });
      child.on('error', (error) => note(`engine:spawn-error ${(error && error.message) || error}`));
      child.unref();
      return true;
    } catch (error) {
      note(`启动 BreezeTTS 失败: ${error && error.message}`);
      lastSpawnFailed = true;
      return false;
    }
  }

  /** 探活成功时调用：节流窗口恢复成"3 分钟"，并清掉失败标记。 */
  function markServerReady() {
    lastSpawnAt = 0;
    lastSpawnFailed = false;
  }

  /** 等超时 / 确认起不来时调用：退避窗口缩到 15 秒，下一句还能再拉一次。 */
  function markServerFailed() {
    lastSpawnFailed = true;
  }

  /** 给宿主写日志用：当前节流状态（`at` = 上次 spawn 时刻，`retryInMs` = 还要等多久）。 */
  function spawnInfo() {
    if (!lastSpawnAt) return { at: 0, failed: lastSpawnFailed, retryInMs: 0 };
    const window = lastSpawnFailed ? 15000 : 180000;
    return {
      at: lastSpawnAt,
      failed: lastSpawnFailed,
      retryInMs: Math.max(0, window - (Date.now() - lastSpawnAt)),
    };
  }

  /** 探活；不通且允许自启就拉起，然后最多等 waitMs。 */
  async function ensureServer(waitMs) {
    if (await healthy()) return true;
    if (engine.kind !== 'breeze') return false;
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
    // P2：这一家的风格参数。**放在最后合并**，overrides 仍然优先（模型/调用方要临时改一下也能盖住）。
    // 只做"搬运"，合不合法由 `sanitizeForEngine()` 按 `engineCaps()` 判 —— 这里不判断，免得两处规则打架。
    const style = engine.style && typeof engine.style === 'object' ? engine.style : {};
    const pick = (key) => (overrides[key] !== undefined ? overrides[key] : style[key]);
    const emotion = String(pick('emotion') || '').trim();
    const num = (key, min, max) => {
      const raw = pick(key);
      if (raw === undefined || raw === null || raw === '') return undefined;
      const n = Number(raw);
      if (!Number.isFinite(n)) return undefined;
      return Math.min(max, Math.max(min, n));
    };
    const voiceModify = (() => {
      const vm = pick('voiceModify');
      if (!vm || typeof vm !== 'object') return undefined;
      const out = {};
      for (const key of ['pitch', 'intensity', 'timbre']) {
        const n = Number(vm[key]);
        if (Number.isFinite(n) && n !== 0) out[key] = Math.min(100, Math.max(-100, Math.round(n)));
      }
      if (vm.soundEffects) out.soundEffects = String(vm.soundEffects);
      return Object.keys(out).length ? out : undefined;
    })();
    const timbreWeights = Array.isArray(pick('timbreWeights')) ? pick('timbreWeights') : undefined;
    /*
     * B2（0.99.0）：采样参数**只从 `overrides` 读**，不从 provider 的 `style` 读 ——
     * `style` 是"这台引擎长期怎么说话"，采样是"这一次生成怎么抽"，两件事不该混在一个口袋里。
     */
    const sampling = pickSampling(overrides);
    return {
      voice,
      instructions,
      cfgScale,
      seed,
      emotion,
      speed: num('speed', 0.5, 2),
      vol: num('vol', 0.01, 10),
      pitch: num('pitch', -12, 12),
      voiceModify,
      timbreWeights,
      ...sampling,
    };
  }

  /**
   * `409 BreezeTTS 忙` 的退避表 —— **单独算额度，不占用普通失败重试的 4 次**。
   *
   * 为什么必须单独算：BreezeTTS 是**单飞**（一次只吃一个请求），前一段还在合成时后一段必然 409；
   * 原来 4 次 × 400/800/1200 ms ≈ **2.4 秒**就放弃，长句连发时几乎必中 —— 台词直接没声，
   * 而 `speak` 早就返回 queued、界面显示"已念"`）。
   * 现在 600/1200/2400/4800/8000/8000 ≈ **25 秒**，覆盖"上一段还没合成完"这种最常见情况。
   */
  const BUSY_BACKOFF_MS = [600, 1200, 2400, 4800, 8000, 8000];

  async function requestSpeech(text, overrides, signal) {
    const params = resolveParams(overrides);
    const body = kind.buildRequest(engine, text, params);
    const extraHeaders = kind.headers ? await kind.headers(engine) : {};
    const url = kind.speechUrl(engine);

    let lastFailure = '';
    let fails = 0;
    let busy = 0;
    while (fails < 4) {
      if (signal?.aborted) throw new Error('cancelled');
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...extraHeaders },
          body: JSON.stringify(body),
          signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(engine.timeoutMs)]),
        });
        if (res.status === 409) {
          lastFailure = 'BreezeTTS 忙（409）';
          if (busy >= BUSY_BACKOFF_MS.length) break;
          await sleep(BUSY_BACKOFF_MS[busy]);
          busy += 1;
          continue; // 引擎忙不消耗普通重试额度
        }
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          lastFailure = `HTTP ${res.status} ${detail.slice(0, 200)}`;
          if (res.status >= 500) {
            fails += 1;
            await sleep(400 * fails);
            continue;
          }
          throw new Error(lastFailure);
        }
        // A4：MiniMax 这类回 JSON + 十六进制音频的引擎走自己的读法；其余按音频字节读。
        // P4a：`readAudio` 允许返 `{audio, subtitle}`（要字幕时才有），这里统一归一成 `{buf, subtitle}`。
        const got = typeof kind.readAudio === 'function'
          ? await kind.readAudio(res)
          : Buffer.from(await res.arrayBuffer());
        const buf = Buffer.isBuffer(got) ? got : (got && got.audio);
        const subtitle = Buffer.isBuffer(got) ? '' : String((got && got.subtitle) || '');
        if (!buf || buf.length < 1024) throw new Error(`音频过短（${buf ? buf.length : 0} 字节）`);
        return { buf, subtitle };
      } catch (error) {
        if (error?.name === 'AbortError' || /cancelled/.test(String(error?.message))) throw error;
        lastFailure = String((error && error.message) || error);
        fails += 1;
        await sleep(400 * fails);
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
    const body = kind.buildRequest(engine, text, params);
    const extraHeaders = kind.headers ? await kind.headers(engine) : {};
    const url = kind.speechUrl(engine);

    let lastFailure = '';
    let fails = 0;
    let busy = 0;
    while (fails < 4) {
      if (signal?.aborted) throw new Error('cancelled');
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...extraHeaders },
          body: JSON.stringify(body),
          signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(engine.timeoutMs)]),
        });
      } catch (error) {
        lastFailure = String((error && error.message) || error);
        fails += 1;
        await sleep(400 * fails);
        continue;
      }
      if (res.status === 409) {
        // 引擎忙单独算额度（≈25 s），不占普通失败的 4 次
        lastFailure = 'BreezeTTS 忙（409）';
        if (busy >= BUSY_BACKOFF_MS.length) break;
        await sleep(BUSY_BACKOFF_MS[busy]);
        busy += 1;
        continue;
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        lastFailure = `HTTP ${res.status} ${detail.slice(0, 200)}`;
        if (res.status >= 500) {
          fails += 1;
          await sleep(400 * fails);
          continue;
        }
        throw new Error(lastFailure);
      }

      // A4：有的引擎（MiniMax）回的是 JSON + 十六进制音频，不是音频字节流 —— 走 kind.readAudio。
      // P4a：它可能返 `{audio, subtitle}`，这里归一成 `{buf, subtitle}` 往下传（回调只吐音频字节）。
      if (typeof kind.readAudio === 'function') {
        const got = await kind.readAudio(res);
        const buf = Buffer.isBuffer(got) ? got : (got && got.audio);
        const subtitle = Buffer.isBuffer(got) ? '' : String((got && got.subtitle) || '');
        if (!buf || buf.length < 1024) throw new Error(`音频过短（${buf ? buf.length : 0} 字节）`);
        onChunk?.(buf);
        return { buf, subtitle };
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
      return { buf, subtitle: '' };
    }
    throw new Error(lastFailure || '未知错误');
  }

  function cacheKey(text, overrides) {
    const h = createHash('sha1');
    const params = resolveParams(overrides);
    // breeze 的哈希输入与 0.76.0 **完全一致**（旧缓存照旧命中）。
    // 换引擎才把 id/model/format 掺进去 —— 不同引擎同一句话不能互相冒充。
    const engineTag = engine.kind === 'breeze'
      ? {}
      : { engine: engine.id, model: engine.model, format: engine.audioFormat };
    /**
     * **风格参数必须进缓存键**。
     *
     * 不然改完情绪/语速再念同一句话，会直接命中上一次的缓存 —— 用户听到旧声音，
     * 以为"风格没生效"（这也正是 E18 当时"看起来生效"的运气：那几句的文本都不一样）。
     * 只算**会改变波形**的六项；`outputMode` / `subtitles` 不影响音频，不掺进来（免得白重新合成）。
     * 判据同 `engineTag`：breeze 为空，老缓存照旧命中。
     */
    const styleTag = (() => {
      if (engine.kind === 'breeze') return {};
      const out = {};
      for (const key of ['emotion', 'speed', 'vol', 'pitch', 'voiceModify', 'timbreWeights']) {
        const value = params[key];
        if (value === undefined || value === null || value === '') continue;
        if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) continue;
        out[key] = value;
      }
      return out;
    })();
    h.update(JSON.stringify({
      base: engine.baseUrl,
      text,
      voice: params.voice,
      instructions: params.instructions,
      cfgScale: params.cfgScale,
      seed: params.seed,
      /*
       * B2：采样参数同样改变波形，必须进哈希（坑 31 同一性质）。
       * **没给值时这些键是 `undefined`，`JSON.stringify` 会把它们丢掉** —— 所以老缓存键
       * 一个字节都没变，0.98.0 及以前的缓存照旧命中。
       */
      temperature: params.temperature,
      topK: params.topK,
      topP: params.topP,
      repetitionPenalty: params.repetitionPenalty,
      maxNewTokens: params.maxNewTokens,
      splitChars: params.splitChars,
      ...engineTag,
      ...styleTag,
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

  /**
   * P4a：把引擎给的**词级字幕 JSON**下载下来存盘（`<key>.subtitle.json`，与 wav 同源同寿命）。
   * 字幕是附赠：下载失败、超时都只返回空串，**绝不影响音频**。
   */
  async function saveSubtitle(key, url) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return '';
      const text = await res.text();
      const file = join(cacheDir, `${key}.subtitle.json`);
      await writeFile(file, text);
      return file;
    } catch {
      return '';
    }
  }

  async function synthesize(text, overrides, signal) {
    await mkdir(cacheDir, { recursive: true });
    // P1：**先净化、再算缓存键**。缓存键必须反映"真正发出去的那段字"，
    // 否则同一句话在不同引擎（或换了净化规则）下会互相冒充缓存。
    const prepared = sanitizeForEngine(text, overrides, caps);
    const sanitize = { dropped: prepared.dropped };
    const key = cacheKey(prepared.text, prepared.params);
    const file = join(cacheDir, `${key}.wav`);
    const cached = await stat(file).catch(() => null);
    // P4a：缓存命中时字幕可能已经在盘上（同一 key 的 `.subtitle.json`）
    const subFile = join(cacheDir, `${key}.subtitle.json`);
    const hasSub = await stat(subFile).catch(() => null);
    if (cached) return { file, ms: 0, cached: true, sanitize, subtitleFile: hasSub ? subFile : '' };

    const started = Date.now();
    const got = await requestSpeech(prepared.text, prepared.params, signal);
    /*
     * 2026-11-18：**落盘前就归一化**，让缓存文件本身诚实。
     *
     * 以前写的是原始流（BreezeTTS 的流式 WAV 头里 `RIFF` / `data` 长度是占位值 `0xFFFFFFFF`），
     * 靠"每个读它的出口自己 normalize"来兜 —— 于是磁盘上的文件至今都写着 0xFFFFFFFF，
     * 任何一条**忘了归一化**的新出口（`06` 坑 48 就是变声那次）都会让引擎/浏览器读崩或读出杂音。
     * 现在改成"写入即诚实"：源头一次修好，下游不必各自补救（下游的 `normalizeWav()` 保留 ——
     * 它幂等，用来兼容老文件）。
     */
    await writeFile(file, normalizeWav(got.buf));
    // P4a：带字幕时把 JSON 一起落盘（`<key>.subtitle.json`，和 wav 同源同寿命）。
    // 失败不算合成失败——字幕是附赠，音频永远优先。
    const subtitleFile = got.subtitle ? await saveSubtitle(key, got.subtitle) : '';
    void trimCache();
    return { file, ms: Date.now() - started, cached: false, sanitize, subtitleFile };
  }

  /**
   * 流式合成：边收边吐。onChunk(Buffer) 每收到一块音频就回调一次，
   * 调用方可以把字节直接转给浏览器，实现"边生成边播放"。
   * 缓存命中时不会有网络往返，一次性把整个文件当一块吐出来（仍是同一个回调接口）。
   */
  /**
   * B3（1.0.0）：**VOICE CHANGER** —— 拿一段源录音换声（`POST /v1/audio/convert`）。
   *
   * 与 `synthesize()` 的三个根本差别（写在代码里，免得下次又踩）：
   *  1. 入参是**音频字节**而不是文本；返回**整段**（非流式，引擎要先编码完整个源）。
   *  2. 响应是**裸 PCM** + `X-Sample-Rate`，所以必须 `pcmToWav()` 再落缓存。
   *  3. 参数默认值是**转换专用** `temperature 0.3 / top_k 1 / cfg_scale 1.0`
   *     （近乎贪心；官方明说开采样会让源音色漏回来），与 `speech` 的"0 = 模型默认"不是一回事。
   *
   * 缓存键 = 源字节 sha1 + 参数（同一段源配同一套参数只算一次）。
   */
  async function convert(input, signal) {
    const one = input && typeof input === 'object' ? input : {};
    if (engine.kind !== 'breeze' || typeof kind.buildConvertForm !== 'function') {
      throw new Error('这家引擎没有变声接口（只有本机 BreezeTTS2 有）');
    }
    /*
     * `normalizeWav()` 现在会把撒谎的长度字段重算（见它自己的注释）—— 这里对**源**再过一遍，
     * 是为了让**已经落盘的老文件**（1.0.4 之前生成的，`data` 长度还是 `0xFFFFFFFF`）也能直接当源用，
     * 不用让用户重新生成一遍。
     */
    const source = normalizeWav(Buffer.isBuffer(one.source) ? one.source : Buffer.from(one.source || []));
    if (source.length < 1024) throw new Error(`源音频太短（${source.length} 字节）`);
    const params = {
      voice: String(one.voice || ''),
      text: String(one.text || ''),
      keepAcoustic: Number.isFinite(Number(one.keepAcoustic)) ? Number(one.keepAcoustic) : 0,
      temperature: Number.isFinite(Number(one.temperature)) && Number(one.temperature) > 0 ? Number(one.temperature) : 0.3,
      topK: Number.isFinite(Number(one.topK)) && Number(one.topK) > 0 ? Math.round(Number(one.topK)) : 1,
      cfgScale: Number.isFinite(Number(one.cfgScale)) ? Number(one.cfgScale) : 1,
      seed: Number.isFinite(Number(one.seed)) ? Number(one.seed) : 42,
    };
    await mkdir(cacheDir, { recursive: true });
    const h = createHash('sha1');
    h.update(source);
    h.update(JSON.stringify(params));
    const file = join(cacheDir, `convert-${h.digest('hex')}.wav`);
    const cached = await stat(file).catch(() => null);
    if (cached) return { file, ms: 0, cached: true, bytes: cached.size, params };

    const url = kind.convertUrl(engine);
    const started = Date.now();
    let lastFailure = '';
    let fails = 0;
    let busy = 0;
    while (fails < 4) {
      if (signal?.aborted) throw new Error('cancelled');
      // **每次重试都要重建 form** FormData 的 body 是一次性流，复用会报 "body already used"
      const form = kind.buildConvertForm(engine, { ...params, source, filename: one.filename });
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          body: form,
          signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(engine.timeoutMs)]),
        });
      } catch (error) {
        // `fetch failed` 是 undici 的原话（底下还裹着一层 cause），对用户毫无信息量 ——
        // 引擎崩掉时面板上就只显示这四个英文词。翻成"连不上引擎"。
        lastFailure = /fetch failed|ECONNREFUSED|socket hang up/i.test(String(error && error.message))
          ? '连不上引擎（BreezeTTS 可能已退出或正在启动）'
          : String((error && error.message) || error);
        fails += 1;
        await sleep(400 * fails);
        continue;
      }
      if (res.status === 409) {
        lastFailure = 'BreezeTTS 忙（409）';
        if (busy >= BUSY_BACKOFF_MS.length) break;
        await sleep(BUSY_BACKOFF_MS[busy]);
        busy += 1;
        continue;
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        lastFailure = `HTTP ${res.status} ${detail.slice(0, 200)}`;
        if (res.status >= 500) {
          fails += 1;
          await sleep(400 * fails);
          continue;
        }
        throw new Error(lastFailure);
      }
      const rate = Number(res.headers.get('x-sample-rate')) || 24000;
      const raw = Buffer.from(await res.arrayBuffer());
      const wav = pcmToWav(raw, rate);
      if (wav.length < 1024) throw new Error(`转换结果过短（${wav.length} 字节）`);
      await writeFile(file, wav);
      void trimCache();
      return { file, ms: Date.now() - started, cached: false, bytes: wav.length, params, sampleRate: rate };
    }
    throw new Error(lastFailure || '变声失败');
  }

  async function synthesizeStream(text, overrides, onChunk, signal) {
    await mkdir(cacheDir, { recursive: true });
    // P1：净化在缓存键之前（理由同 `synthesize`）
    const prepared = sanitizeForEngine(text, overrides, caps);
    const sanitize = { dropped: prepared.dropped };
    const key = cacheKey(prepared.text, prepared.params);
    const file = join(cacheDir, `${key}.wav`);
    const cached = await stat(file).catch(() => null);
    const subFile = join(cacheDir, `${key}.subtitle.json`);
    const hasSub = await stat(subFile).catch(() => null);
    if (cached) {
      const buf = await readFile(file);
      onChunk?.(buf);
      return { file, ms: 0, cached: true, bytes: buf.length, sanitize, subtitleFile: hasSub ? subFile : '' };
    }

    const started = Date.now();
    const parts = [];
    const got = await requestSpeechStream(prepared.text, prepared.params, (chunk) => {
      parts.push(chunk);
      onChunk?.(chunk);
    }, signal);
    /*
     * 2026-11-18：**落盘前就归一化**，让缓存文件本身诚实。
     *
     * 以前写的是原始流（BreezeTTS 的流式 WAV 头里 `RIFF` / `data` 长度是占位值 `0xFFFFFFFF`），
     * 靠"每个读它的出口自己 normalize"来兜 —— 于是磁盘上的文件至今都写着 0xFFFFFFFF，
     * 任何一条**忘了归一化**的新出口（`06` 坑 48 就是变声那次）都会让引擎/浏览器读崩或读出杂音。
     * 现在改成"写入即诚实"：源头一次修好，下游不必各自补救（下游的 `normalizeWav()` 保留 ——
     * 它幂等，用来兼容老文件）。
     */
    await writeFile(file, normalizeWav(got.buf));
    const subtitleFile = got.subtitle ? await saveSubtitle(key, got.subtitle) : '';
    void trimCache();
    return { file, ms: Date.now() - started, cached: false, bytes: got.buf.length, sanitize, subtitleFile };
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
    /** 拉起成功/失败要回报，节流窗口才不会一直卡在"失败也不让重试"。 */
    markServerReady,
    markServerFailed,
    spawnInfo,
    synthesize,
    synthesizeStream,
    /** B3：VOICE CHANGER（源音频 → 目标音色），返回缓存里的 wav 路径。 */
    convert,
    enqueue,
    trimCache,
    get engine() { return engine; },
    /** P1：当前引擎的能力表（宿主据此生成 `tts_state.engineHints`）。 */
    get caps() { return caps; },
    /** P3：当前引擎的写法手册（宿主据此生成 `tts_state.enginePlaybook`）。 */
    get playbook() { return enginePlaybook(engine); },
    get lastError() { return lastError; },
    set lastError(value) { lastError = value; },
  };
}

/**
 * dsh-voice-lilt — Client half
 *
 * 一个常驻在输入框下方的小控件：
 *  - 显示/切换语音播报开关（Host 侧持久化）；
 *  - 每 500 ms 向 Host 增量拉取「新的要念的句子」，用 <audio> 依次播放；
 *  - ：另外在助手消息的动作行末尾挂一个声音图标，点一下重播**那一轮**（与 dock 的重播按钮共用播放器）；
 *  - 刷新页面不会重播历史（首轮只同步游标）；
 *  - 自动播放被拦时降级为「▶ 点击播放」；
 *  - 任何 HTTP 失败都把状态码显示在控件行里（不再静默失败）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-voice-lilt',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    /**
     * 两个播放入口（dock 的「↻ 重播」与消息动作行的 🔊）共用同一套播放器。
     * dock 挂载时把 { stop, playItems } 注册进来；没有 dock 时按钮会提示不可用。
     */
    const bus = {
      handlers: null,
      playing: false,
      activeMessageId: '',
      subs: new Set(),
      attach(handlers) { this.handlers = handlers; },
      setState(next) {
        Object.assign(this, next);
        for (const fn of [...this.subs]) {
          try { fn(); } catch { /* 订阅者自己炸了不该影响播放 */ }
        }
      },
      sub(fn) { this.subs.add(fn); return () => this.subs.delete(fn); },
    };

    /**
     * **轮询去重**。`tick` 由「500 ms 定时」和「立即执行一次」两路触发，且没有并发闸门——
     * 一旦某次 `/pending` 响应慢过 500 ms，两个 tick 会拿着**同一个 `since`** 各拿回同一批条目，
     * 于是同一段音频被排进队列两遍、播两遍。
     * 这里按账目 `id` 记住已经排过队的，只作用于 `/pending` 这条路；
     * 消息尾部 🔊 的手动重播走 `playItems`，不受影响（仍然可以想听几次听几次）。
     */
    const pollSeen = { session: '', ids: new Set() };

    /**
     * **共享状态仓**。原先 `/state` 的结果只活在 dock 组件的 useState 里，
     * 操作面板也要读同一份状态、改同一批选项，否则两处会各说各话（面板改了、dock 还显示旧的）。
     * 这里把「宿主状态 + 声音库 + 诊断行 + 会话 id + 面板开关」提到模块级，dock 与面板都订阅它。
     * 播放器（audio / 队列 / 轮询）仍然只在 dock 里，面板不碰音频。
     */
    const store = {
      state: { enabled: true, fallback: 'auto', voice: '', voiceUp: null, lastError: '', volume: 1 },
      voices: [],
      diag: '',
      sessionId: '',
      panelOpen: false, // 浮层面板是否打开（不落盘：刷新后默认收起）
      chipMounted: false, // tab 行里那个 chip 有没有挂上（挂上了就不再显示标题行的兜底按钮）
      subs: new Set(),
      sub(fn) {
        this.subs.add(fn);
        return () => this.subs.delete(fn);
      },
      notify() {
        for (const fn of [...this.subs]) {
          try { fn(); } catch { /* 订阅者自己炸了不影响别人 */ }
        }
      },
      setState(next) {
        const value = typeof next === 'function' ? next(this.state) : next;
        if (!value) return;
        this.state = value;
        this.notify();
      },
      setVoices(list) {
        this.voices = Array.isArray(list) ? list : [];
        this.notify();
      },
      setDiag(text) {
        const next = String(text || '');
        if (this.diag === next) return;
        this.diag = next;
        this.notify();
      },
      setPanelOpen(open) {
        const next = !!open;
        if (this.panelOpen === next) return;
        this.panelOpen = next;
        this.notify();
      },
      togglePanel() {
        this.setPanelOpen(!this.panelOpen);
      },
      setChipMounted(mounted) {
        const next = !!mounted;
        if (this.chipMounted === next) return;
        this.chipMounted = next;
        this.notify();
      },
    };

    /** 订阅共享状态仓：任何一处改动都会让 dock 与面板同时重渲染。 */
    function useStore() {
      const [, bump] = useState(0);
      useEffect(() => store.sub(() => bump((n) => n + 1)), []);
      return store;
    }

    /**
     * 写一次 `/state`：先乐观更新（按钮立刻有反应），再用宿主回传的整份状态覆盖。
     * dock 与面板共用这一条通路，避免两边各写一套。
     */
    const patchState = async (body, tag, optimistic) => {
      if (optimistic) store.setState((prev) => ({ ...prev, ...optimistic }));
      const result = await getJson('/voice-breeze/state', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (result.ok) {
        store.setState(result.data);
        store.setDiag('');
      } else {
        store.setDiag(`${tag} ${result.status || 'ERR'}`);
        void api.refresh();
      }
    };

    /**
     * 播报音量。宿主存 0~1，界面用 0~100 的百分比。
     * 非法/缺失一律当 1（满音量）——旧宿主没有这个字段时不能把声音弄没。
     * 它只改 `<audio>.volume`：合成、缓存、账目都不受影响。
     */
    const volumeRatio = (value) => {
      const n = Number(value);
      return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
    };

    /** 面板与 dock 共用的动作。全部走 store，因此两边永远看到同一份状态。 */
    const api = {
      async refresh() {
        const query = store.sessionId ? `?session=${encodeURIComponent(store.sessionId)}` : '';
        const result = await getJson(`/voice-breeze/state${query}`);
        if (result.ok) {
          store.setState(result.data);
          store.setDiag('');
        } else {
          store.setDiag(`state ${result.status || 'ERR'}`);
        }
      },
      async loadVoices() {
        const result = await getJson('/voice-breeze/voices');
        if (result.ok && Array.isArray(result.data && result.data.items)) store.setVoices(result.data.items);
      },
      async toggle() {
        const next = !store.state.enabled;
        await patchState({ enabled: next }, 'toggle', { enabled: next });
      },
      /** 下拉选中某个模式（非法值落回默认的 AI 说） */
      async pickFallback(fallback) {
        const next = FALLBACK_ORDER.includes(fallback) ? fallback : 'authored';
        if (next === store.state.fallback) return;
        await patchState({ fallback: next }, 'fallback', { fallback: next });
      },
      async cycleFallback() {
        const current = FALLBACK_ORDER.includes(store.state.fallback) ? store.state.fallback : 'auto';
        const next = FALLBACK_ORDER[(FALLBACK_ORDER.indexOf(current) + 1) % FALLBACK_ORDER.length];
        await patchState({ fallback: next }, 'fallback', { fallback: next });
      },
      async cycleStrength() {
        const current = STRENGTH_ORDER.includes(store.state.strength) ? store.state.strength : 'medium';
        const next = STRENGTH_ORDER[(STRENGTH_ORDER.indexOf(current) + 1) % STRENGTH_ORDER.length];
        await patchState({ strength: next }, 'strength', { strength: next });
      },
      async cycleNarration() {
        const current = NARRATION_ORDER.includes(store.state.narrationMode) ? store.state.narrationMode : 'script';
        const next = NARRATION_ORDER[(NARRATION_ORDER.indexOf(current) + 1) % NARRATION_ORDER.length];
        await patchState({ narrationMode: next }, 'narration', { narrationMode: next });
      },
      /** 选项放输入框下方（false）还是浮层面板里（true） */
      async setControlsInPanel(on) {
        const next = !!on;
        await patchState({ controlsInPanel: next }, 'panel', { controlsInPanel: next });
      },
      /** 播报音量（0~1）。滑块拖完再落盘，拖动过程中只改本地值。 */
      async setVolume(value) {
        const next = volumeRatio(value);
        await patchState({ volume: next }, 'volume', { volume: next });
      },
      async savePanelPos(x, y) {
        await patchState({ panel: { x: Math.round(x), y: Math.round(y) } }, 'panel-pos');
      },
      async pickVoice(voice) {
        // 三种特殊选项：进入多音色 / 切换场景 / 退出多音色
        const special = voice === 'enter-multivoice' || voice === 'exit-multivoice' || voice.startsWith('scene:');
        if (special) {
          const body = voice === 'enter-multivoice'
            ? { multiVoice: true, narrationMode: 'script' }
            : voice === 'exit-multivoice'
              ? { multiVoice: false }
              : { multiVoice: true, scene: voice.slice('scene:'.length) };
          await patchState(body, 'scene');
          return;
        }
        await patchState({ voice, session: store.sessionId }, 'voice', { voice });
      },
    };

    const POLL_MS = 500; // 多段播报时，越快发现下一段，气口才不会被"还没生成"拖长
    /**
     * dock 上的旧「↻ 重播 / ⏹ 停止」按钮**先隐藏，但代码保留**。想恢复就把这里改回 true。
     * 消息动作行末尾的 🔊 不受影响——那才是现在常用的重播入口。
     */
    const SHOW_DOCK_REPLAY = true;

    /**
     * 「声音」图标：来自素材（`素材/声音.svg`，1024 视窗，两条 path）。
     * 用 CSS mask 画而不是内联 <svg>：颜色跟 currentColor 走，深浅主题、hover 变灰都不用换图，
     * 也不必担心 hyperscript 是否按 SVG 命名空间创建元素。
     */
    const SPEAKER_MASK = 'url(data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%201024%201024%22%20fill%3D%22currentColor%22%3E%3Cpath%20d%3D%22M758.3321402026667%20421.0124523899259c-6.657625050074073-11.096042154666666-13.315251313777777-22.19208430933333-22.19208552296296-31.06891851851852l-6.657625050074073-6.657625050074073c-8.876834209185184-8.876834209185184-22.19208430933333-8.876834209185184-31.06891851851852%200s-8.876834209185184%2022.19208430933333%200%2031.06891851851852l6.657625050074073%206.657625050074073c6.657625050074073%206.657625050074073%2011.096042154666666%2013.315251313777777%2015.53445925925926%2022.19208552296296l2.219209159111111%202.2192079454814815c42.164960673185185%2064.35704498251852%2033.288126464%20122.05646612859258-26.630501413925924%20186.4135111111111-8.876834209185184%208.876834209185184-8.876834209185184%2022.19208430933333%200%2031.06891851851852%204.438417104592592%204.438417104592592%208.876834209185184%206.657625050074073%2015.53445925925926%206.657625050074073%206.657625050074073%200%2011.096042154666666-2.2192079454814815%2015.53445925925926-6.657625050074073%2073.2338791917037-79.89150424177778%2084.32992134637037-162.00221764266664%2031.06891851851852-241.89372309807408z%22%2F%3E%3Cpath%20d%3D%22M836.0044364989628%20292.2983624248889c-6.657625050074073-8.876834209185184-13.315251313777777-15.53445925925926-19.97287636385185-19.97287636385185-8.876834209185184-8.876834209185184-22.19208430933333-8.876834209185184-31.06891851851852%200-8.876834209185184%208.876834209185184-8.876834209185184%2022.19208430933333%200%2031.06891851851852l4.438417104592592%204.438417104592592%2011.096042154666666%2011.096042154666666c11.096042154666666%2015.53445925925926%2024.411293468444445%2028.849710573037036%2035.50733562311111%2046.60337777777777%2084.32992134637037%20126.49488201955555%2066.57625414162963%20248.55134814814815-51.041794882370375%20370.60781306311105-8.876834209185184%208.876834209185184-8.876834209185184%2022.19208430933333%200%2031.06891851851852%204.438417104592592%204.438417104592592%208.876834209185184%206.657625050074073%2015.53445925925926%206.657626263703703%206.657625050074073%200%2011.096042154666666-2.2192079454814815%2015.53445925925926-6.657626263703703%20130.9332991241481-135.37171622874072%20150.90617548799997-281.83947461214814%2057.69941993244444-423.86881710459255-13.315251313777777-19.97287636385185-26.630501413925924-35.50733562311111-37.72654356859259-51.04179366874074zM538.6305014139259%20143.61139488237035c-24.411293468444445-11.096042154666666-55.48021198696296-4.438417104592592-79.89150424177778%2017.75366720474074L290.0791532657778%20305.61361252503707h-79.89150424177778c-59.91862909155555%200-108.74121481481481%2051.041794882370375-108.74121481481481%20108.74121481481481v217.48242962962962c0%2062.13783703703704%2048.822585723259266%20108.74121481481481%20108.74121481481481%20108.74121481481481h68.7954620871111l179.75588606103702%20142.02934249244444c17.75366720474074%2013.315251313777777%2037.72654356859259%2019.97287636385185%2055.480210773333326%2019.972875150222222%208.876834209185184%200%2019.97287636385185-2.2192079454814815%2026.630502627555554-6.657625050074073%2024.411293468444445-11.096042154666666%2037.72654356859259-37.72654356859259%2037.72654356859259-73.2338791917037V219.0644820195556c0-35.50733562311111-13.315251313777777-64.35704498251852-39.9457527277037-75.45308713718518zM534.1920843093333%20824.9083931306667c0%2017.75366720474074-4.438417104592592%2028.849710573037036-13.315250100148146%2033.288127677629625-8.876834209185184%204.438417104592592-22.19208430933333%200-35.50733562311111-8.876834209185184l-190.8519282157037-150.90617548799997h-84.32992134637037c-35.50733562311111%200-64.35704498251852-28.849710573037036-64.35704619614813-64.35704498251852v-217.48242962962962c0-35.50733562311111%2028.849710573037036-64.35704498251852%2064.35704619614813-64.35704619614813h95.42596350103702l179.75588606103702-153.1253834334815c13.315251313777777-11.096042154666666%2024.411293468444445-15.53445925925926%2033.288126464-11.096043368296296%208.876834209185184%204.438417104592592%2015.53445925925926%2017.75366720474074%2015.53445925925926%2035.50733562311111v601.4054940065184z%22%2F%3E%3C%2Fsvg%3E)';
    /**
     * @param glyph 字形本身多大（px）
     * @param box   占位盒子多大（px）——**要跟按钮的 line-height 一致**，否则 flex 子项会把按钮压矮
     */
    const speakerIcon = (glyph, box) => {
      const size = box || glyph;
      return h('span', {
        style: {
          display: 'inline-block',
          flex: '0 0 auto',
          width: size,
          height: size,
          backgroundColor: 'currentColor',
          WebkitMaskImage: SPEAKER_MASK,
          maskImage: SPEAKER_MASK,
          WebkitMaskSize: `${glyph}px ${glyph}px`,
          maskSize: `${glyph}px ${glyph}px`,
          WebkitMaskRepeat: 'no-repeat',
          maskRepeat: 'no-repeat',
          WebkitMaskPosition: 'center',
          maskPosition: 'center',
        },
      });
    };

    /**
     * 提示条（与官方同款）：深色药丸、白字、12px、圆角 8，鼠标一进就出。
     * 做法：监听 document 的 mouseover，只在**我们自己的容器**（`[data-vb-tip-scope]`）里认
     * `title` / `data-vb-tip`；认出来先把 `title` 摘进 `data-vb-tip` 再显示——
     * 摘掉 title 是为了不让系统原生提示条随后再弹一次。
     * 位置：默认在控件上方居中，贴边自动夹住；上方空间不够就翻到下方。
     */
    const TIP_ID = 'voice-breeze-tip';
    function installTip() {
      if (typeof document === 'undefined' || document.getElementById(TIP_ID)) return;
      const tip = document.createElement('div');
      tip.id = TIP_ID;
      tip.setAttribute('role', 'tooltip');
      Object.assign(tip.style, {
        position: 'fixed',
        zIndex: '2147483000',
        padding: '6px 10px',
        borderRadius: '8px',
        background: '#2c2c2e',
        color: '#fff',
        fontSize: '12px',
        lineHeight: '16px',
        fontFamily: 'inherit',
        whiteSpace: 'normal',
        maxWidth: '320px',
        pointerEvents: 'none',
        boxShadow: '0 6px 18px rgba(0, 0, 0, 0.18)',
        opacity: '0',
        transition: 'opacity 80ms ease',
        left: '0',
        top: '0',
      });
      document.body.appendChild(tip);
      let current = null;
      const hide = () => { current = null; tip.style.opacity = '0'; };
      const show = (el, text) => {
        tip.textContent = text;
        tip.style.opacity = '1';
        const rect = el.getBoundingClientRect();
        const w = tip.offsetWidth;
        const h = tip.offsetHeight;
        let left = rect.left + rect.width / 2 - w / 2;
        left = Math.max(8, Math.min(left, (window.innerWidth || 1024) - w - 8));
        let top = rect.top - h - 6;
        if (top < 8) top = rect.bottom + 6;
        tip.style.left = `${Math.round(left)}px`;
        tip.style.top = `${Math.round(top)}px`;
        current = el;
      };
      const pick = (node) => {
        if (!node || typeof node.closest !== 'function') return null;
        const el = node.closest('[data-vb-tip], [title]');
        if (!el) return null;
        return el.closest('[data-vb-tip-scope]') ? el : null;
      };
      document.addEventListener('mouseover', (event) => {
        const el = pick(event.target);
        if (!el) { hide(); return; }
        if (el.hasAttribute('title')) {
          el.setAttribute('data-vb-tip', el.getAttribute('title') || '');
          el.removeAttribute('title');
        }
        const text = el.getAttribute('data-vb-tip');
        if (text) show(el, text); else hide();
      }, true);
      document.addEventListener('mouseout', (event) => {
        if (!current) return;
        const to = event.relatedTarget;
        if (to && current.contains && current.contains(to)) return;
        hide();
      }, true);
      document.addEventListener('mousedown', hide, true);
      document.addEventListener('keydown', hide, true);
      window.addEventListener('scroll', hide, true);
      window.addEventListener('blur', hide);
    }
    /** 播报模式：模型这轮自己说了就永远优先用它；模式只决定“模型没说时说什么”。 */
    // 四档 = 摘要(原「自动」，短→首句、长→本轮 N 步) / AI 说 /
    // 全文(新增：正文逐字念完，代码块与表格跳过) / 角色扮演。旧的「摘要」档（永远 N 步）已删除。
    // 模式改成**下拉**（与音色同一形态），顺序由用户指定 = AI 说 / 摘要 / 全文 / 角色扮演；
    // 新装插件的默认模式是「AI 说」（宿主 DEFAULTS.fallback = authored）
    const FALLBACK_ORDER = ['authored', 'auto', 'full', 'roleplay'];
    const FALLBACK_LABEL = { auto: '摘要', authored: 'AI 说', full: '全文', roleplay: '角色扮演' };
    const FALLBACK_TIP = '决定模型的说话模式：摘要只说重点、AI 说会自己总结说什么、全文逐字念完、角色扮演按角色设定说。';
    /** 角色扮演时的朗读方式：脚本照本念 / AI 即兴复述。 */
    const NARRATION_ORDER = ['script', 'adapted'];
    const NARRATION_LABEL = { script: '全文念', adapted: 'AI 即兴' };
    const NARRATION_TIP = '全文念：按「旁白：/角色：」切段念全文，不额外花 token；AI 即兴：让 AI 写语气演一遍，可精简、额外花 token。';

    /** 播报强度：一个旋钮同时决定“念多长”和“想多细”。 */
    const STRENGTH_ORDER = ['weak', 'medium', 'strong'];
    const STRENGTH_LABEL = { weak: '弱', medium: '中', strong: '强' };
    const STRENGTH_TIP = '强度越高，AI 提炼语音的质量越高，播放的时长也越久。';

    const S = {
      row: {
        display: 'flex',
        alignItems: 'center',
        // 这一排原来没有 wrap——窗口窄一点时 flex 会把控件横向压扁，
        // 下拉里的中文就被裁掉半个字（「角色扮演」的「演」）。现在窄了换行，不压字。
        flexWrap: 'wrap',
        gap: 8,
        padding: '2px 2px 0',
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
        minHeight: 22,
      },
      btn: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        borderRadius: 999,
        padding: '1px 8px',
        fontSize: 11,
        lineHeight: '18px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        flexShrink: 0,   // 与 row 的 flexWrap 配合——宁可换行，也不要压出半个字
      },
      dotOn: { width: 6, height: 6, borderRadius: '50%', background: 'var(--dsw-alias-state-success-primary)' },
      dotIdle: { width: 6, height: 6, borderRadius: '50%', background: 'var(--dsw-alias-state-idle-primary)' },
      dotErr: { width: 6, height: 6, borderRadius: '50%', background: 'var(--dsw-alias-state-error-primary)' },
      label: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '42ch' },
      err: { color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'nowrap' },
      sel: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-secondary)',
        borderRadius: 999,
        padding: '1px 6px',
        fontSize: 11,
        lineHeight: '18px',
        cursor: 'pointer',
        maxWidth: '18ch',
        fontFamily: 'inherit',
        flexShrink: 0,   // 同上
      },
    };

    /**
     *  UI：操作面板的设计令牌。
     * 面板要"一眼看出层次"，所以字号/边框/间距全部从这里取，不再各写一套：
     *   间距刻度 4 / 8 / 12 / 16；边框 l1（卡片）/ l2（输入框、主分隔）；文字 primary（主要内容）/ secondary（说明）。
     * 只用宿主暴露的主题变量（见 `Theme.listTokens`），不引第三方 UI 库、不引宿主 class。
     */
    const U = {
      gap1: 4,
      gap2: 8,
      gap3: 12,
      gap4: 16,
      radiusCard: 10,
      radiusCtl: 8,
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 12,
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        //  UI：卡片要比面板底面深一档，否则"卡片内外的白"完全一样、看不出分区
        background: 'var(--dsw-alias-bg-layer-2)',
        boxSizing: 'border-box',
      },
      cardHead: { display: 'flex', alignItems: 'center', gap: 8, minHeight: 18 },
      cardTitle: {
        fontSize: 12.5,
        fontWeight: 700,
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-primary)',
        flex: '1 1 auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      hint: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-secondary)' },
      hintStrong: { fontSize: 11.5, lineHeight: '17px', color: 'var(--dsw-alias-label-secondary)' },
      divider: { height: 1, background: 'var(--dsw-alias-border-l1)', margin: '2px 0' },
      btn: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        // **简写 + 长写不能混用——`border` 与 `background` 都一样** 
        // 值里带 var() 的简写会被 CSSOM 存成"待替换值"，之后只要再设同组的长写，这条简写就被丢掉；
        // React 在状态切换时又会把"上一次有、这一次没有"的长写清成 ''，于是那只按钮**一条背景声明都不剩**，
        // 回落到浏览器默认的 `background-color: ButtonFace`（浅灰 #efefef）——1px 半透明描边压在这层灰上，
        // 就看成了"没选中的那个边框变深了"。
        // 所以这里一律长写，且两个状态都要把 background-color / background-image 显式给出来。
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--dsw-alias-border-l2)',
        backgroundColor: 'var(--dsw-alias-bg-layer-1)',
        backgroundImage: 'none',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 8,
        padding: '3px 10px',
        fontSize: 12,
        lineHeight: '18px',
        fontWeight: 500,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        fontFamily: 'inherit',
        // 焦点环默认贴着边框画，圆角看起来会"不贴合"；往外挪 2px 让两者分开（键盘可达性保留）
        outlineOffset: 2,
      },
      btnActive: {
        borderColor: 'var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontWeight: 700,
      },
      btnPrimary: {
        // 主按钮只在"字重"上区分，形状与 `＋ 加一个角色` 完全一致
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 8,
        padding: '3px 10px',
        fontSize: 12,
        lineHeight: '18px',
        fontWeight: 700,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        fontFamily: 'inherit',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        outlineOffset: 2,
      },
      btnDanger: {
        borderColor: 'var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-state-error-primary)',
        fontWeight: 600,
      },
      btnTiny: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-secondary)',
        borderRadius: 7,
        padding: '1px 7px',
        fontSize: 11,
        lineHeight: '16px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        fontFamily: 'inherit',
        outlineOffset: 2,
      },
      badge: {
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 5,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: 999,
        padding: '2px 9px',
        fontSize: 11,
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      badgeValue: { color: 'var(--dsw-alias-label-primary)', fontWeight: 700 },
      fieldLabel: { fontSize: 11.5, fontWeight: 700, color: 'var(--dsw-alias-label-primary)' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
    };

    /** 面板里的小组件（不导出，只在本文件的 VoicePanel 里用） */
    // 选中态：**两态都是"卡片同色底 + 1px 浅灰描边"**，
    // 选中只多一层 4% 黑的渐变 + 字重加粗。
    // 关键：两个分支都把 backgroundColor / backgroundImage 显式写全，绝不让 React 去删这两个键——
    // 删了就回落到浏览器默认的 ButtonFace 灰，那才是 X1「未选中按钮边框变深」的真因。
    // backgroundClip: padding-box 让底色止于描边内侧，描边压在卡片白底上，两态边框颜色完全相同。
    const SEG_FILL = 'linear-gradient(var(--dsw-alias-border-l1), var(--dsw-alias-border-l1))';
    const segStyle = (active, extra) => ({
      ...U.btn,
      ...(extra || null),
      backgroundClip: 'padding-box',
      backgroundColor: 'var(--dsw-alias-bg-layer-1)',
      backgroundImage: active ? SEG_FILL : 'none',
      borderColor: 'var(--dsw-alias-border-l2)',
      fontWeight: active ? 700 : 500,
    });
    const panelCtl = (active) => segStyle(active);
    const panelSeg = (active) => segStyle(active, { padding: '3px 12px' });

    /**  期 2：面板里的输入控件（内联样式，客户端零 npm 依赖、不引用宿主 class） */
    const TEXTAREA_STYLE = {
      width: '100%',
      minHeight: 150,
      boxSizing: 'border-box',
      resize: 'vertical',
      padding: 8,
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-primary)',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      lineHeight: '19px',
    };
    const INPUT_STYLE = {
      flex: 1,
      minWidth: 0,
      boxSizing: 'border-box',
      padding: '4px 8px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 12,
      lineHeight: '18px',
    };

    /**
     *  F7d：音色表的「表格式」视图。
     * 面板里不让人手写 JSON：把 cast.json 解析成行，改完再序列化回去。
     * 两种输入都认（`{characters:[…]}` 与裸数组），跟宿主的 readCast() 一致。
     */
    const parseCastRows = (text) => {
      const source = String(text || '');
      // 空文件＝还没有音色表，是合法状态（宿主的 readCast() 也容忍它），别报"形状不对"
      if (!source.trim()) return { rows: [], error: '' };
      try {
        const parsed = JSON.parse(source.trim());
        const raw = Array.isArray(parsed) ? parsed : parsed?.characters;
        if (!Array.isArray(raw)) {
          return { rows: [], error: '这份 cast.json 不是 {"characters": [...]} 的形状，先用「原始 JSON」改一下' };
        }
        return {
          error: '',
          rows: raw.map((item) => ({
            name: String((item && item.name) || ''),
            voice: typeof (item && item.voice) === 'string' ? item.voice : '',
            tone: String((item && item.tone) || ''),
            seed: Number.isFinite(Number(item && item.seed)) ? String(Number(item.seed)) : '',
          })),
        };
      } catch (error) {
        return { rows: [], error: `不是合法 JSON（${(error && error.message) || ''}），先用「原始 JSON」改一下` };
      }
    };

    /** 行 → cast.json 文本（只写有值的字段，空行丢弃） */
    const serializeCastRows = (rows) => {
      const characters = (Array.isArray(rows) ? rows : [])
        .filter((row) => String(row && row.name || '').trim())
        .map((row) => {
          const out = { name: String(row.name).trim() };
          const voice = String(row.voice || '').trim();
          const tone = String(row.tone || '').trim();
          if (voice) out.voice = voice;
          if (tone) out.tone = tone;
          const seedText = String(row.seed || '').trim();
          if (seedText && Number.isFinite(Number(seedText))) out.seed = Number(seedText);
          return out;
        });
      return `${JSON.stringify({ characters }, null, 2)}\n`;
    };

    const SELECT_STYLE = {
      flex: 1,
      minWidth: 0,
      boxSizing: 'border-box',
      padding: '4px 8px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 12,
      lineHeight: '18px',
      fontFamily: 'inherit',
    };

    const getJson = async (url, init) => {
      try {
        const res = await fetch(url, { credentials: 'same-origin', ...(init || {}) });
        if (!res.ok) {
          // 把错误体也带回来（面板要用 `detail` 显示"cast.json 第 3 条没有 name"这类原因）
          let detail = null;
          try { detail = await res.json(); } catch { /* 不是 JSON 就算了 */ }
          return { ok: false, status: res.status, data: detail };
        }
        return { ok: true, status: res.status, data: await res.json() };
      } catch (error) {
        return { ok: false, status: 0, error: String((error && error.message) || error) };
      }
    };

    function VoiceBreeze(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : '';
      // 宿主状态提到共享仓（store），dock 与操作面板共用同一份；下面保留同名别名，原有逻辑不用改。
      const shared = useStore();
      const state = shared.state;
      const voices = shared.voices;
      const setState = (next) => store.setState(next);
      const setVoices = (next) => store.setVoices(next);
      if (sessionId && store.sessionId !== sessionId) store.sessionId = sessionId;
      const [now, setNow] = useState('');
      const [blocked, setBlocked] = useState(false);
      const [isPlaying, setIsPlaying] = useState(false);
      /** 播放状态同时推给总线：消息尾部的 🔊 靠它切换成 ⏹。 */
      const markPlaying = useCallback((value, messageId) => {
        setIsPlaying(value);
        bus.setState({ playing: !!value, activeMessageId: value ? String(messageId || '') : '' });
      }, []);
      const diag = shared.diag;
      const setDiag = (text) => store.setDiag(text);

      const since = useRef(null);
      const queue = useRef([]);
      const playing = useRef(false);
      const audio = useRef(null);
      const alive = useRef(true);
      const pumpRef = useRef(null);
      const lastItem = useRef(null);
      const stopFlag = useRef(false);

      // 播报音量变了就地生效——正在播的那一段也立刻跟着变，不用等下一段。
      useEffect(() => {
        const el = audio.current;
        if (!el) return;
        try { el.volume = volumeRatio(state.volume); } catch { /* 已卸载 */ }
      }, [state.volume]);

      /** 等 <audio> 攒够 N 秒音频再开播：避免流式播放中途垫底/重载。N 由 playOne 按“底数 + 时长加码”算出来。 */
      async function waitBuffered(el, seconds) {
        if (!(seconds > 0)) return;
        const enough = () => {
          try {
            const ranges = el.buffered;
            if (ranges && ranges.length) {
              const end = ranges.end(ranges.length - 1);
              if (end >= seconds) return true;
              // 整条音频本来就比目标短（例如缓存命中、短句），攒到头就算够
              if (Number.isFinite(el.duration) && el.duration > 0 && end >= el.duration - 0.15) return true;
            }
          } catch { /* 忽略 */ }
          return false;
        };
        if (enough()) return;
        await new Promise((resolve) => {
          let timer = null;
          const cleanup = () => {
            el.removeEventListener('progress', check);
            el.removeEventListener('loadeddata', check);
            el.removeEventListener('canplay', check);
            if (timer) clearTimeout(timer);
          };
          const finish = () => { cleanup(); resolve(); };
          const check = () => { if (enough()) finish(); };
          el.addEventListener('progress', check);
          el.addEventListener('loadeddata', check);
          el.addEventListener('canplay', check);
          timer = setTimeout(finish, Math.max(2500, seconds * 2000));
        });
      }

      /** 气口段：静默等待 ms，可被「停止」打断。 */
      function quietWait(ms) {
        const total = Math.max(200, Math.min(30000, Number(ms) || 0));
        return new Promise((resolve) => {
          const started = Date.now();
          const timer = setInterval(() => {
            if (!alive.current || stopFlag.current || Date.now() - started >= total) {
              clearInterval(timer);
              resolve();
            }
          }, 100);
        });
      }

      /** 播一条：等缓冲、播放、等结束。失败会把条目塞回队列并返回 false。 */
      async function playOne(item) {
        setNow(item.text || '');
        const el = new Audio(item.url);
        el.preload = 'auto';
        // 音量取**模块级 store 的当前值**，不取这次渲染的快照。
        // 轮询那条路每次都调最新的 pump（`pumpRef.current = pump`），所以一直是对的；
        // 重播走的是 `bus.attach` 时注册的那一份 `runGroup → playOne` 闭包（依赖没变就不会重建），
        // 里面的 `state` 停在注册那一刻——报"拖到 30% 后重播还是旧音量"就是它。
        el.volume = volumeRatio(store.state.volume);
        audio.current = el;
        const wantBuffer = Number(state.bufferSeconds);
        const baseSec = Number.isFinite(wantBuffer) && wantBuffer >= 0 ? wantBuffer : 2;
        // 预缓冲 = 底数 + 按本条**预计音频时长**加码（中文 TTS ≈4.2 字/秒，取保守值）。
        // 为什么不能定死：流式播放一旦"生成慢于播放"（GPU 被游戏抢占时 <1×），
        // 垫底时刻 ≈ B/(1−r)。固定 2 s 在 r=0.8 时只够撑 10 s 音频，长句必然句中卡顿；
        // 按长度加码能把长句的余量拉长，但**治本要靠把长句切成小片让生成和播放并行**。
        const estSec = (Number(item && item.chars) || 0) / 4.2;
        const wantSec = Math.min(Math.max(baseSec, 0.5 + estSec * 0.15), 4);
        await waitBuffered(el, wantSec);
        if (!alive.current) return false;
        try {
          await el.play();
        } catch (error) {
          setNow('');
          setBlocked(true);
          setDiag(`play: ${(error && error.name) || 'blocked'}`);
          return false;
        }
        await new Promise((resolve) => {
          el.onended = resolve;
          el.onerror = resolve;
          el.onpause = () => { if (stopFlag.current) resolve(); };
        });
        if (audio.current === el) audio.current = null;
        setNow('');
        return true;
      }

      async function pump() {
        if (playing.current || !alive.current) return;
        const item = queue.current.shift();
        if (!item) {
          setNow('');
          return;
        }
        stopFlag.current = false;
        playing.current = true;
        markPlaying(true);
        // 气口段——没有音频，只是静音等待（[停顿N秒] 由宿主切成这种条目）
        if (item.pauseMs) {
          setNow(`（气口 ${(Number(item.pauseMs) / 1000).toFixed(1)} 秒）`);
          await quietWait(item.pauseMs);
          playing.current = false;
          markPlaying(false);
          setNow('');
          if (!alive.current || stopFlag.current) return;
          void pump();
          return;
        }
        lastItem.current = { url: item.url, text: item.text || '', turn: item.turn };
        const ok = await playOne(item);
        playing.current = false;
        markPlaying(false);
        setBlocked(false);
        if (!ok) {
          // play() 被自动播放策略拒了：塞回队首，等用户点一下页面（unlock 会重新 pump），
          // 否则这一段会永久丢失，听感就是"跳段"。
          if (alive.current) queue.current.unshift(item);
          return;
        }
        if (!alive.current) return;
        // 多段播报之间留气口：队列里还有下一段时，先静默 gapMs 再念
        if (queue.current.length) {
          const gap = Number(state.segmentGapMs);
          await new Promise((resolve) => setTimeout(resolve, Number.isFinite(gap) && gap >= 0 ? gap : 1200));
          if (!alive.current) return;
        }
        void pump();
      }
      pumpRef.current = pump;

      // 这三个动作都提到模块级 `api` 了（操作面板要用同一套），组件里只留稳定引用，
      // 避免 dock 与面板各写一份、各自刷新各自的缓存。
      const refresh = useCallback(async () => { await api.refresh(); }, []);
      const loadVoices = useCallback(async () => { await api.loadVoices(); }, []);
      const pickVoice = useCallback(async (voice) => { await api.pickVoice(voice); }, []);

      useEffect(() => {
        alive.current = true;
        void refresh();
        void loadVoices();
        return () => {
          alive.current = false;
          if (audio.current) {
            try { audio.current.pause(); } catch { /* 已卸载 */ }
            audio.current = null;
          }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [refresh]);

      useEffect(() => {
        if (!sessionId) return undefined;
        since.current = null;
        queue.current = [];
        playing.current = false;
        let stop = false;
        let ticking = false; // 并发闸门，避免两个 tick 用同一个 since 拿回同一批
        if (pollSeen.session !== sessionId) {
          pollSeen.session = sessionId;
          pollSeen.ids.clear();
        }

        const tick = async () => {
          if (stop || ticking) return;
          ticking = true;
          try {
            const result = await getJson(
              `/voice-breeze/pending?session=${encodeURIComponent(sessionId)}${since.current === null ? '' : `&since=${since.current}`}`,
            );
            if (!result.ok) {
              if (alive.current) setDiag(`pending ${result.status || 'ERR'}`);
              return;
            }
            const data = result.data;
            if (since.current === null) {
              // 首次只同步游标：刷新页面不重播历史
              since.current = typeof data.seq === 'number' ? data.seq : 0;
              return;
            }
            if (typeof data.seq === 'number' && data.seq > since.current) since.current = data.seq;
            const items = Array.isArray(data.items) ? data.items : [];
            if (!items.length) {
              if (diag.startsWith('pending')) setDiag('');
              return;
            }
            // 按 id 去重——同一个账目只会进队列一次（并发 tick / 重复响应都挡在这里）
            const fresh = [];
            for (const item of items) {
              const id = item && item.id ? String(item.id) : '';
              if (id && pollSeen.ids.has(id)) continue;
              if (id) pollSeen.ids.add(id);
              fresh.push(item);
            }
            // 容量保护：超长会话也不让这个集合无限长（清掉只影响很久以前的 id，早已播过）
            if (pollSeen.ids.size > 2000) pollSeen.ids.clear();
            if (!fresh.length) return;
            // 队列**不再丢段**。角色扮演 / 念全文可能一轮几十段，
            // 丢最早的一段听感就是"跳段"，比慢一点严重得多。队列里只是元数据，攒着不占什么。
            for (const item of fresh) queue.current.push(item);
            void pumpRef.current?.();
          } finally {
            ticking = false;
          }
        };

        const timer = setInterval(() => { void tick(); }, POLL_MS);
        void tick();
        return () => {
          stop = true;
          clearInterval(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [sessionId]);

      useEffect(() => {
        // 状态与声音库都要周期性刷新：端点可能是「插件后台拉起来的」，
        // 页面在端点还没起来时加载过一次就再也不会自动重试，会一直显示「未启动」「音色名(缺失)」。
        const timer = setInterval(() => {
          void refresh();
          void loadVoices();
        }, 4000);
        return () => clearInterval(timer);
      }, [refresh, loadVoices]);

      useEffect(() => {
        if (!state.starting) return undefined;
        const timer = setInterval(() => {
          void refresh();
          void loadVoices();
        }, 2000);
        return () => clearInterval(timer);
      }, [state.starting, refresh, loadVoices]);

      useEffect(() => {
        if (!blocked) return undefined;
        const unlock = () => {
          setBlocked(false);
          setDiag('');
          void pumpRef.current?.();
        };
        window.addEventListener('pointerdown', unlock, true);
        return () => window.removeEventListener('pointerdown', unlock, true);
      }, [blocked]);

      /**
       * 重播最新一轮：不是最后一条，而是**同一 turn 的全部段**（两段播报、角色扮演三段都会一起放）。
       * 优先问 Host 要本会话的全部账目（带 turn 分组），拿不到再退回本地记住的那条。
       */
      /** 把一组账目按顺序放完（dock 的重播与消息尾部的 🔊 共用）。 */
      const runGroup = useCallback(async (group, messageId) => {
        const list = Array.isArray(group) ? group : [];
        if (!list.length) return;
        try { if (audio.current) audio.current.pause(); } catch { /* 忽略 */ }
        stopFlag.current = false;
        playing.current = true;
        markPlaying(true, messageId);
        setBlocked(false);
        setDiag('');
        for (let index = 0; index < list.length; index += 1) {
          if (!alive.current || stopFlag.current) break;
          if (list[index].pauseMs) {
            setNow(`（气口 ${(Number(list[index].pauseMs) / 1000).toFixed(1)} 秒）`);
            await quietWait(list[index].pauseMs);
            setNow('');
            continue;
          }
          const ok = await playOne(list[index]);
          if (!ok || stopFlag.current) break;
          if (index < list.length - 1) {
            const gap = Number(state.segmentGapMs);
            await new Promise((resolve) => setTimeout(resolve, Number.isFinite(gap) && gap >= 0 ? gap : 300));
          }
        }
        playing.current = false;
        markPlaying(false);
      }, [markPlaying, state.segmentGapMs]);

      /**
       * 重播最新一轮：不是最后一条，而是**同一 turn 的全部段**（两段播报、角色扮演三段都会一起放）。
       * 优先问 Host 要本会话的全部账目（带 turn 分组），拿不到再退回本地记住的那条。
       */
      const replay = useCallback(async () => {
        let items = [];
        if (sessionId) {
          const result = await getJson(`/voice-breeze/pending?session=${encodeURIComponent(sessionId)}&since=0`);
          if (result.ok && Array.isArray(result.data && result.data.items)) items = result.data.items;
        }
        if (!items.length && lastItem.current && lastItem.current.url) items = [lastItem.current];
        if (!items.length) {
          setDiag('没有可重播的语音');
          return;
        }
        const latest = items[items.length - 1];
        const group = latest && latest.turn !== undefined
          ? items.filter((item) => item.turn === latest.turn)
          : [latest];
        await runGroup(group, '');
      }, [sessionId, runGroup]);

      /** 立刻停止：清队列、暂停当前音频、复位按钮。 */
      const stop = useCallback(() => {
        stopFlag.current = true;
        queue.current = [];
        try { if (audio.current) audio.current.pause(); } catch { /* 忽略 */ }
        audio.current = null;
        playing.current = false;
        markPlaying(false);
        setBlocked(false);
        setNow('');
      }, [markPlaying]);

      // 把播放能力交给总线：消息尾部的 🔊 按钮就用这两个句柄
      useEffect(() => {
        bus.attach({
          stop: () => stop(),
          playItems: (items, messageId) => runGroup(items, messageId),
        });
        return () => bus.attach(null);
      }, [stop, runGroup]);

      // 四个动作都走模块级 `api`（操作面板与 dock 共用同一套），组件里只留薄封装。
      const toggle = useCallback(() => { void api.toggle(); }, []);
      const pickFallback = useCallback((value) => { void api.pickFallback(value); }, []);
      const cycleStrength = useCallback(() => { void api.cycleStrength(); }, []);
      const cycleNarration = useCallback(() => { void api.cycleNarration(); }, []);

      const starting = !!state.starting;

      const dot = !state.enabled ? S.dotIdle : (starting ? S.dotIdle : (state.voiceUp === false ? S.dotErr : S.dotOn));
      const children = [
        h(
          'button',
          {
            key: 'toggle',
            type: 'button',
            style: S.btn,
            onClick: toggle,
            title: state.enabled ? '语音播报已开启，点击关闭' : '语音播报已关闭，点击开启',
            'aria-pressed': !!state.enabled,
          },
          h('span', { style: dot }),
          h('span', null, state.enabled ? '语音播报 开' : '语音播报 关'),
        ),
      ];

      // `controlsInPanel=true` 时这一排选项整体搬进浮层面板，dock 只留「语音播报 开/关」+ 重播。
      if (state.enabled && !state.controlsInPanel) {
        children.push(h(Controls, { key: 'controls' }));
      }

      // 重播按钮**常驻** 跟「语音播报 开/关」一样，选项搬进面板时它也留在这里
      // 。图标盒子取 18px，
      // 与 S.btn 的 line-height 一致，所以两个药丸边框高度完全相同。
      // 客户端轮：**排到整排最后**——选项在输入框下方时，顺序是
      // 「开关 → 模式 → 强度 → 朗读 → 音色 → 重播」，以前它挤在模式左边。
      if (SHOW_DOCK_REPLAY) {
        children.push(h('button', {
          key: 'replay',
          type: 'button',
          style: { ...S.btn, padding: '1px 6px' },
          onClick: () => { if (isPlaying) stop(); else void replay(); },
          title: isPlaying ? '正在播报，点一下立刻停止' : '重播最新一轮（用缓存，不重新合成）',
          'aria-label': isPlaying ? '停止播报' : '重播最新一轮',
        }, isPlaying ? '⏹' : speakerIcon(12, 18)));
      }

      if (blocked) {
        children.push(h('button', {
          key: 'unblock',
          type: 'button',
          style: S.btn,
          onClick: () => { setBlocked(false); setDiag(''); void pumpRef.current?.(); },
        }, '▶ 点击播放'));
      } else if (now) {
        children.push(h('span', { key: 'now', style: S.label }, `🔈 ${now}`));
      }

      if (diag) {
        children.push(h('span', { key: 'diag', style: S.err }, `⚠ ${diag}`));
      } else if (state.enabled && state.starting) {
        children.push(h('span', { key: 'starting', style: S.label },
          `⏳ BreezeTTS 启动中…${state.pending ? `（待念 ${state.pending} 句）` : ''}`));
      } else if (state.enabled && state.voiceUp === false) {
        children.push(h('span', { key: 'err', style: S.err }, 'BreezeTTS 未启动'));
      }

      return h('div', { style: S.row, 'data-vb-dock': '', 'data-vb-tip-scope': '' }, children);
    }

    /**
     * 选项行（模式 / 强度 / 朗读 / 音色-场景）。
     * 原先写死在 dock 里，现在抽成组件：选项在输入框下方时由 dock 渲染，
     * 「选项位置=悬浮框中」时由浮层面板渲染。状态一律走 store，两处永远一致。
     */
    function Controls(props) {
      const shared = useStore();
      const state = shared.state;
      const voices = shared.voices;
      //  UI：同一份控件在 dock 里是"轻量药丸"，在面板里要更重、更清楚（面板是设置区，不是状态条）
      const inPanel = Boolean(props && props.variant === 'panel');
      const btnStyle = inPanel ? U.btn : S.btn;
      const selStyle = inPanel ? { ...SELECT_STYLE, flex: '0 1 170px' } : S.sel;
      // 模式下拉**按内容自适应宽度**（原生 select 的 auto 宽 = 最长那个选项的宽度）。
      // 以前复用 S.sel 的 `maxWidth: 18ch`，中文「模式：角色扮演」正好顶到上限，"演"会被裁掉一半。
      // flex 用 `0 0 auto`：viewport 变窄时靠外层换行，而不是把字挤掉。
      const modeSelStyle = inPanel
        ? { ...SELECT_STYLE, flex: '0 0 auto', width: 'auto', minWidth: 0, maxWidth: 'none' }
        : { ...S.sel, flex: '0 0 auto', width: 'auto', maxWidth: 'none' };
      const children = [];

      // 模式与音色同形态（下拉），不再逐次点击循环
      children.push(h('select', {
        key: 'fallback',
        style: modeSelStyle,
        value: FALLBACK_ORDER.includes(state.fallback) ? state.fallback : 'authored',
        title: FALLBACK_TIP,
        'aria-label': '播报模式',
        onChange: (event) => { void api.pickFallback(event.target.value); },
      }, FALLBACK_ORDER.map((id) => h('option', { key: id, value: id }, `模式：${FALLBACK_LABEL[id]}`))));

      // /：只有「AI 说」与「角色扮演」两档认强度；摘要（首句上限固定 240）与全文（逐字念）
      // 都不显示强度——那两个档里它要么没意义、要么根本不起作用，留着只是增加操作负担。
      // 角色扮演 + **全文念** 也藏起来——那一档按标记照念、一字不改，强度没有作用位；
      // 只有「角色扮演 + AI 即兴」才真的按强度决定段数与篇幅（强 = 至少两段）。
      const strengthMatters = state.fallback === 'authored'
        || (state.fallback === 'roleplay' && state.narrationMode !== 'script');
      if (strengthMatters) {
        children.push(h('button', {
          key: 'strength',
          type: 'button',
          style: btnStyle,
          onClick: () => { void api.cycleStrength(); },
          title: STRENGTH_TIP,
        }, `强度：${STRENGTH_LABEL[state.strength] || '中'}`));
      }

      if (state.fallback === 'roleplay') {
        children.push(h('button', {
          key: 'narration',
          type: 'button',
          style: btnStyle,
          onClick: () => { void api.cycleNarration(); },
          title: NARRATION_TIP,
        }, `朗读：${NARRATION_LABEL[state.narrationMode] || '全文念'}`));
      }

      const current = state.voice || '';
      const multiVoice = Boolean(state.multiVoice);
      const sceneInfo = state.scene || { active: '_default', ids: [] };
      let options;
      if (multiVoice) {
        // 多音色模式：同一个下拉变形为「场景选择器」
        options = [
          ...sceneInfo.ids.map((id) => ({ id: `scene:${id}`, label: id === sceneInfo.active ? `🎭 ${id} · 当前` : `🎭 ${id}` })),
          { id: 'exit-multivoice', label: '↩ 退出多音色（回到单音色）' },
        ];
      } else {
        // 去掉下拉里的「设计音色」（听感差、出过大妈音；要设计音色直接对话里说）。
        // 只删入口——cast.json 里"只写 tone 不写 voice"的设计模式仍按协议保留（开发记录 方式 B）。
        options = [
          { id: 'enter-multivoice', label: `🎭 多音色扮演${sceneInfo.ids.length ? `（${sceneInfo.active} · ${state.castSize || 0} 个音色）` : '（本场景没有音色表）'}` },
          ...voices.map((v) => ({ id: v.id, label: v.id })),
        ];
        if (!current) {
          options.push({ id: '', label: '（当前是设计音色，建议选一个）', disabled: true });
        } else if (!options.some((o) => o.id === current)) {
          options.push({ id: current, label: voices.length ? `${current}(缺失)` : current });
        }
      }
      children.push(h('select', {
        key: 'voice',
        style: selStyle,
        value: multiVoice ? `scene:${sceneInfo.active}` : current,
        title: multiVoice
          ? '选场景：连同这一局的角色卡与音色表一起换'
          : '选音色；第一项「多音色扮演」进入分角色演出',
        onFocus: () => { void api.loadVoices(); },
        onChange: (event) => { void api.pickVoice(event.target.value); },
      }, options.map((o) => h('option', { key: o.id || 'design', value: o.id, disabled: Boolean(o.disabled) }, o.label))));

      return h('span', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: inPanel ? U.gap2 : 8,
          flexWrap: 'wrap',
        },
      }, children);
    }

    const PANEL_W = 380;

    function panelDefaultPos() {
      const viewW = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1280;
      return { x: Math.max(12, viewW - PANEL_W - 48), y: 96 };
    }

    /**
     * 把面板位置夹进视口。
     * 修：最大化时把面板拖到最右，再把窗口恢复成小窗 → `position: fixed` 的坐标没变，
     * 面板就跑到缩小后的窗口外面（看不见）；重新最大化又"回来"了。窗口 resize 时一律夹回。
     */
    function clampPos(x, y) {
      const viewW = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1280;
      const viewH = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 800;
      return {
        x: Math.max(0, Math.min(Number(x) || 0, Math.max(0, viewW - PANEL_W - 8))),
        y: Math.max(0, Math.min(Number(y) || 0, Math.max(0, viewH - 80))),
      };
    }

    /** 浮层操作面板（拖动标题移动、右上角关闭、位置写回 state.json）。 */
    function VoicePanel() {
      const shared = useStore();
      const state = shared.state;
      const [pos, setPos] = useState(null);
      const posRef = useRef(null);
      const dragRef = useRef(null);

      const saved = state.panel || { x: 0, y: 0 };
      const base = pos || ((saved.x || saved.y) ? { x: saved.x, y: saved.y } : panelDefaultPos());
      /** 当前生效位置：拖动、resize 夹回、以及"打开时兜一次"都用它 */
      const effRef = useRef(base);
      effRef.current = base;
      /** 渲染时再夹一次，保证任何一帧都不会画到视口外（resize 生效前也不会闪出去） */
      const shown = clampPos(base.x, base.y);

      useEffect(() => {
        if (!shared.panelOpen) return undefined;
        const move = (event) => {
          const drag = dragRef.current;
          if (!drag) return;
          const next = clampPos(drag.ox + event.clientX - drag.sx, drag.oy + event.clientY - drag.sy);
          posRef.current = next;
          setPos(next);
        };
        const up = () => {
          if (!dragRef.current) return;
          dragRef.current = null;
          const next = posRef.current;
          if (next) void api.savePanelPos(next.x, next.y);
        };
        // 窗口尺寸变了（最大化 / 恢复 / 分屏 / 改分辨率）：被挤出视口就拉回来，新位置同时落盘
        const reclamp = () => {
          const cur = posRef.current || effRef.current || panelDefaultPos();
          const next = clampPos(cur.x, cur.y);
          if (next.x === cur.x && next.y === cur.y) return;
          posRef.current = next;
          setPos(next);
          void api.savePanelPos(next.x, next.y);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('resize', reclamp);
        reclamp();
        return () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('resize', reclamp);
        };
      }, [shared.panelOpen]);

      // ──  期 2：角色卡 / 场景（面板里直接读写文件） ──
      const [tab, setTab] = useState('options'); // options | global | scenes
      /**
       * 播报音量的滑块。`volDraft` 只在拖动过程中存在（0~100），松手/停顿后落盘，
       * 这样拖一下不会打几十个 POST，也不会因为网络慢把滑块拽回去。
       */
      const [volDraft, setVolDraft] = useState(null);
      const volTimer = useRef(null);
      const volPct = Math.round(volumeRatio(state.volume) * 100);
      const shownVol = volDraft === null ? volPct : volDraft;
      const pushVolume = (pct) => {
        const next = Math.min(100, Math.max(0, Math.round(Number(pct) || 0)));
        setVolDraft(next);
        if (volTimer.current) clearTimeout(volTimer.current);
        volTimer.current = setTimeout(() => {
          volTimer.current = null;
          setVolDraft(null);
          void api.setVolume(next / 100);
        }, 200);
      };
      /** 松手 / 键盘调整 / 失焦：立刻落盘，不等那 200 ms。 */
      const commitVolume = () => {
        if (volTimer.current) { clearTimeout(volTimer.current); volTimer.current = null; }
        if (volDraft === null) return;
        const next = volDraft;
        setVolDraft(null);
        void api.setVolume(next / 100);
      };
      useEffect(() => () => { if (volTimer.current) clearTimeout(volTimer.current); }, []);
      const [cards, setCards] = useState(null);
      const [sel, setSel] = useState(''); // 只记场景：'scene:<id>'
      const [personaText, setPersonaText] = useState('');
      const [castText, setCastText] = useState('');
      const [cardMsg, setCardMsg] = useState('');
      const [newName, setNewName] = useState('');
      const [renameTo, setRenameTo] = useState('');
      const [busy, setBusy] = useState(false);
      const [loadedFor, setLoadedFor] = useState('');
      const [confirmDel, setConfirmDel] = useState(''); // 删除二次确认：点一下变「确认删除?」，4 秒自动取消
      // F7d：音色表的表格式编辑（castRaw=true 时退回原始 JSON 文本框）
      const [castRows, setCastRows] = useState([]);
      const [castRaw, setCastRaw] = useState(false);
      const [castErr, setCastErr] = useState('');
      /**
       * 修：**当前这一页真正在编辑谁**。
       * 之前读/存都用 `sel`，而切到「全局角色卡」页时 `sel` 还停在 `scene:xxx`，
       * 于是全局页显示的是那个场景的正文、保存也写进了 `scene:xxx`（全局 `persona.md` 一直是 0 字节）。
       * 现在：全局页固定 `global`，场景页才看 `sel`，两者不再串味。
       */
      const editTarget = tab === 'global' ? 'global' : (sel.startsWith('scene:') ? sel : '');
      /** 只有"这一份真的读回来了"才允许编辑/保存，避免把上一个目标的正文存到这一个里 */
      const ready = Boolean(editTarget) && loadedFor === editTarget;

      const reloadCards = useCallback(async () => {
        const result = await getJson('/voice-breeze/cards');
        if (result.ok) setCards(result.data);
        else setCardMsg(`读取失败 ${result.status || ''}`);
      }, []);

      useEffect(() => {
        if (!shared.panelOpen) return;
        void reloadCards();
        // 表格式编辑器的音色下拉要用声音库；dock 可能没加载过（比如面板先打开）
        void api.loadVoices();
      }, [shared.panelOpen, reloadCards]);

      // 删除的二次确认：4 秒没人点就自己取消，免得一直悬着
      useEffect(() => {
        if (!confirmDel) return undefined;
        const timer = setTimeout(() => setConfirmDel(''), 4000);
        return () => clearTimeout(timer);
      }, [confirmDel]);

      useEffect(() => {
        if (!shared.panelOpen || !editTarget) return undefined;
        let alive = true;
        setLoadedFor('');
        void (async () => {
          const result = await getJson(`/voice-breeze/cards?target=${encodeURIComponent(editTarget)}`);
          if (!alive) return;
          if (result.ok) {
            const personaValue = String((result.data.persona && result.data.persona.text) || '');
            const castValue = String((result.data.cast && result.data.cast.text) || '');
            setPersonaText(personaValue);
            setCastText(castValue);
            const parsedCast = parseCastRows(castValue);
            setCastRows(parsedCast.rows);
            setCastErr(parsedCast.error);
            setLoadedFor(editTarget);
            setCardMsg('');
          } else {
            setCardMsg(`读取失败 ${result.status || ''}`);
          }
        })();
        return () => { alive = false; };
      }, [shared.panelOpen, editTarget]);

      // 进「场景」页但还没选过场景时，自动选当前场景（否则右边编辑器是空的）
      useEffect(() => {
        if (!shared.panelOpen || tab !== 'scenes' || sel) return;
        const list = (cards && cards.scenes) || [];
        if (!list.length) return;
        const active = list.find((item) => item.active) || list[0];
        setSel(`scene:${active.id}`);
      }, [shared.panelOpen, tab, sel, cards]);

      const saveCard = useCallback(async (file, textOverride) => {
        if (!editTarget) { setCardMsg('先在列表里选一个场景'); return; }
        if (loadedFor !== editTarget) { setCardMsg('还在读取这一份，稍等一下再存'); return; }
        const text = typeof textOverride === 'string' ? textOverride : (file === 'cast' ? castText : personaText);
        setBusy(true);
        const result = await getJson('/voice-breeze/cards', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ target: editTarget, file, text }),
        });
        setBusy(false);
        if (result.ok) {
          setCardMsg(`已保存到 ${editTarget === 'global' ? '全局 persona.md' : `${editTarget} 的${file === 'cast' ? 'cast.json' : 'persona.md'}`}`);
          void reloadCards();
        } else {
          const detail = result.data && (result.data.detail || result.data.error);
          setCardMsg(`保存失败：${detail || result.status || ''}`);
        }
      }, [editTarget, loadedFor, castText, personaText, reloadCards]);

      // ── F7d：表格式音色表的行操作 ──
      const updateCastRow = (index, patch) => setCastRows((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
      const voiceOptions = (current) => {
        const list = (shared.voices || []).map((v) => v && v.id).filter(Boolean);
        if (current && !list.includes(current)) list.push(current);
        return list.map((id) => h('option', { key: id, value: id }, id));
      };
      const saveCastRows = useCallback(async () => {
        const rows = (castRows || []).map((row) => ({ ...row, name: String(row.name || '').trim() }));
        const named = rows.filter((row) => row.name);
        for (const row of named) {
          if (!String(row.voice || '').trim() && !String(row.tone || '').trim()) {
            setCastErr(`「${row.name}」至少填一项：音色，或语气（音色留空＝设计模式）`);
            return;
          }
        }
        const text = serializeCastRows(named);
        setCastText(text);
        setCastErr('');
        await saveCard('cast', text);
      }, [castRows, saveCard]);

      const sceneAction = useCallback(async (action, extra) => {
        setBusy(true);
        const result = await getJson('/voice-breeze/scenes', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, ...(extra || {}) }),
        });
        setBusy(false);
        if (result.ok) {
          setCardMsg('');
          await reloadCards();
        } else {
          setCardMsg(`操作失败：${(result.data && result.data.error) || result.status || ''}`);
        }
        return result;
      }, [reloadCards]);

      const openFolder = useCallback(async (target) => {
        const result = await getJson('/voice-breeze/open', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ target }),
        });
        if (!result.ok) setCardMsg(`打不开：${result.status || ''}`);
      }, []);

      //  UI：**焦点环**要按"键盘才显示"处理。
      // 之前给按钮加 outlineOffset 只是把 Chromium 的默认焦点环推出去——鼠标点完按钮后它还在，
      // 看起来就是"没选中的那个框边框变黑了"。这里给面板内的控件注入一条
      // 自己的样式：鼠标/触摸不给 ring，键盘 :focus-visible 才给品牌色环。只作用于 `[data-vb-panel]` 之内。
      useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        const id = 'voice-breeze-panel-style';
        if (document.getElementById(id)) return undefined;
        const el = document.createElement('style');
        el.id = id;
        el.textContent = [
          // 兜底：面板里的按钮背景一律由内联样式给；万一某次状态切换让内联声明掉了，
          // 也不许回落到浏览器默认的 ButtonFace 灰。
          '[data-vb-panel] button{background-color:transparent;background-image:none}',
          // !important：宿主对按钮有全局 `:focus-visible` 规则，不加权重压不住
          '[data-vb-panel] button:focus,[data-vb-panel] input:focus,[data-vb-panel] textarea:focus,[data-vb-panel] select:focus{outline:none !important;box-shadow:none !important}',
          '[data-vb-panel] button:focus-visible,[data-vb-panel] input:focus-visible,[data-vb-panel] textarea:focus-visible,[data-vb-panel] select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary) !important;outline-offset:2px}',
        ].join('');
        document.head.appendChild(el);
        return () => { try { el.remove(); } catch { /* 已移除 */ } };
      }, []);

      installTip();
      if (!shared.panelOpen) return null;

      const startDrag = (event) => {
        if (event.button !== 0 && event.pointerType === 'mouse') return;
        const cur = effRef.current || shown;
        dragRef.current = { sx: event.clientX, sy: event.clientY, ox: cur.x, oy: cur.y };
        posRef.current = cur;
        event.preventDefault();
      };

      const inPanel = !!state.controlsInPanel;

      // ── 面板里的小积木（卡片 / 卡片头 / 说明 / 徽标 / 分隔线）──
      // 目的：三页里每一块信息都有边框、有标题、有说明，间距统一走 U 的刻度，
      // 不再"所有东西一个样"。
      const card = (key, children) => h('div', { key, style: U.card }, children);
      const cardHead = (key, title, extra) => h('div', { key, style: U.cardHead }, [
        h('span', { key: 't', style: U.cardTitle }, title),
        ...(Array.isArray(extra) ? extra : (extra ? [extra] : [])),
      ]);
      const hint = (key, text, strong) => h('div', { key, style: strong ? U.hintStrong : U.hint }, text);
      /** 状态点：绿=正常、灰=关闭/待机、红=异常（与 dock 上那个开关前的点同一套颜色） */
      const dotStyle = (kind) => ({
        width: 7,
        height: 7,
        borderRadius: '50%',
        flex: '0 0 auto',
        background: kind === 'on'
          ? 'var(--dsw-alias-state-success-primary)'
          : (kind === 'err' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-idle-primary)'),
      });
      const statusLine = (key, kind, label, text) => h('span', {
        key,
        style: { display: 'inline-flex', alignItems: 'center', gap: 6 },
      }, [
        h('span', { key: 'l', style: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' } }, label),
        text ? h('span', {
          key: 'v',
          style: { fontSize: 11.5, fontWeight: 700, color: 'var(--dsw-alias-label-primary)' },
        }, text) : null,
        // 圆点放在文字**右边**；kind 为空 = 这一项不要圆点
        kind ? h('span', { key: 'd', style: dotStyle(kind) }) : null,
      ]);
      const divider = (key) => h('div', { key, style: U.divider });
      const sceneLabel = sel.startsWith('scene:') ? sel.slice('scene:'.length) : '';

      return h('div', {
        'data-vb-panel': '',
        'data-vb-tip-scope': '',
        style: {
          position: 'fixed',
          left: shown.x,
          top: shown.y,
          width: PANEL_W,
          zIndex: 60,
          display: 'flex',
          flexDirection: 'column',
          maxHeight: '78vh',
          // 浅色主题里 bg-base / bg-layer-* 全是 #fff，卡片"浮不出来"；
          // 这里在 `bg-base` 上叠一层**中性黑 6%**（不用品牌色、不依赖 color-mix）：
          //   light: #fff → #f0f0f0；dark: #151517 → 略深，卡片 #2c2c2e 仍然更亮
          backgroundColor: 'var(--dsw-alias-bg-base)',
          backgroundImage: 'linear-gradient(rgba(0,0,0,0.06), rgba(0,0,0,0.06))',
          border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: 12,
          boxShadow: '0 16px 40px rgba(0,0,0,0.28), 0 2px 6px rgba(0,0,0,0.12)',
          fontSize: 12,
          color: 'var(--dsw-alias-label-secondary)',
          overflow: 'hidden',
        },
      }, [
        // 标题栏（拖动区）
        h('div', {
          key: 'bar',
          onPointerDown: startDrag,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 8px 8px 14px',
            cursor: 'move',
            userSelect: 'none',
            borderBottom: '1px solid var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-bg-layer-1)',
          },
        }, [
          h('span', {
            key: 'title',
            style: { fontSize: 13, fontWeight: 700, letterSpacing: 0.2, color: 'var(--dsw-alias-label-primary)', flex: 1 },
          }, '语音播报 · 设置'),
          h('button', {
            key: 'close',
            type: 'button',
            title: '关闭面板',
            'aria-label': '关闭语音播报设置面板',
            onClick: () => store.setPanelOpen(false),
            style: {
              border: '1px solid transparent',
              background: 'transparent',
              color: 'var(--dsw-alias-label-secondary)',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 13,
              lineHeight: '20px',
              padding: '0 6px',
              fontFamily: 'inherit',
            },
          }, '✕'),
        ]),

        // 页签
        h('div', {
          key: 'tabs',
          style: {
            display: 'flex',
            gap: 16,
            padding: '8px 14px 0',
            background: 'var(--dsw-alias-bg-layer-1)',
            // 用 inset 底线代替 border-bottom：子元素会盖在它上面，
            // 选中页签的浅灰块才能一直铺到那条线、和下方 2px 黑条接上
            boxShadow: 'inset 0 -1px 0 var(--dsw-alias-border-l2)',
          },
        }, [['options', '选项'], ['global', '全局角色卡'], ['scenes', '场景']].map(([id, label]) => h('button', {
          key: id,
          type: 'button',
          onClick: () => setTab(id),
          style: {
            border: 'none',
            outline: 'none',
            // 选中：比底面深一档的中性灰（叠 border-l2 = 10% 黑），左右留白靠 padding，上两角圆角，
            // 底边那根 2px 黑条与字块同宽
            backgroundColor: tab === id ? 'var(--dsw-alias-bg-base)' : 'transparent',
            backgroundImage: tab === id
              ? 'linear-gradient(var(--dsw-alias-border-l2), var(--dsw-alias-border-l2))'
              : 'none',
            color: tab === id ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
            borderBottom: tab === id ? '2px solid var(--dsw-alias-label-primary)' : '2px solid transparent',
            borderRadius: '10px 10px 0 0',
            padding: '6px 10px 6px',
            fontSize: 12,
            fontWeight: tab === id ? 700 : 500,
            cursor: 'pointer',
            fontFamily: 'inherit',
          },
        }, label))),

        // 内容
        h('div', {
          key: 'body',
          style: { padding: 12, display: 'flex', flexDirection: 'column', gap: 12, maxHeight: '62vh', overflowY: 'auto' },
        }, [
          // ───────── 选项页 ─────────
          tab === 'options' ? h('div', { key: 'opts', style: { display: 'flex', flexDirection: 'column', gap: 12 } }, [
            card('where', [
              cardHead('h', '选项位置'),
              hint('d', '决定「模式 / 强度 / 朗读 / 音色」选项位置在哪。'),
              h('div', { key: 'seg', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, [
                h('button', {
                  key: 'dock',
                  type: 'button',
                  style: panelSeg(!inPanel),
                  onClick: () => { void api.setControlsInPanel(false); },
                  title: '选项留在输入框下方',
                }, '输入框下方'),
                h('button', {
                  key: 'panel',
                  type: 'button',
                  style: panelSeg(inPanel),
                  onClick: () => { void api.setControlsInPanel(true); },
                  title: '选项搬进这个面板',
                }, '悬浮框中'),
              ]),
            ]),

            inPanel ? card('ctls', [
              cardHead('h', '播报选项'),
              hint('d', '只影响“怎么说”，不影响聊天正文。'),
              divider('dv'),
              h(Controls, { key: 'row', variant: 'panel' }),
            ]) : card('ctls-off', [
              hint('d', '选项现在在输入框下方；切成「悬浮框中」就搬到这里。'),
            ]),

            // 播报音量**常驻**面板——不管「选项位置」切到哪边，这一块都留在这里
            // 。
            card('vol', [
              cardHead('h', '播报音量', h('span', {
                key: 'v',
                style: {
                  fontSize: 11.5,
                  fontWeight: 700,
                  fontVariantNumeric: 'tabular-nums',
                  color: 'var(--dsw-alias-label-primary)',
                },
              }, `${shownVol}%`)),
              hint('d', '只调这一侧的声音大小；0% 是静音，播报本身还在跑。'),
              h('input', {
                key: 'slider',
                type: 'range',
                min: 0,
                max: 100,
                step: 5,
                value: shownVol,
                onChange: (event) => pushVolume(event.target.value),
                onPointerUp: commitVolume,
                onKeyUp: commitVolume,
                onBlur: commitVolume,
                style: {
                  width: '100%',
                  margin: '2px 0 0',
                  accentColor: 'var(--dsw-alias-brand-primary)',
                  cursor: 'pointer',
                },
              }),
            ]),

            card('status', [
              cardHead('h', '当前状态'),
              // 横向排一行；圆点在文字右边；音色只给文字不给圆点
              h('div', {
                key: 'b',
                style: { display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' },
              }, [
                statusLine('en', state.enabled ? 'on' : 'idle', '播报', ''),
                statusLine(
                  'up',
                  state.starting ? 'idle' : (state.voiceUp === false ? 'err' : 'on'),
                  '端点',
                  state.starting ? '启动中' : (state.voiceUp === false ? '未启动' : ''),
                ),
                statusLine('vo', '', '音色', state.multiVoice
                  ? `场景 ${(state.scene && state.scene.active) || '_default'}`
                  : (state.voice || '设计模式')),
              ]),
              shared.diag ? h('div', {
                key: 'diag',
                style: { ...U.hint, color: 'var(--dsw-alias-state-error-primary)' },
              }, `⚠ ${shared.diag}`) : null,
            ]),
          ]) : null,

          // ───────── 全局角色卡页 ─────────
          tab === 'global' ? card('glob', [
            cardHead('h', '全局角色卡', h('button', {
              key: 'open',
              type: 'button',
              style: U.btnTiny,
              onClick: () => { void openFolder('data'); },
            }, '📂 打开文件夹')),
            hint('p', cards && cards.global ? cards.global.path : '~/.dsh/voice-breeze/persona.md'),
            hint('tip', '单音色模式只读这一份；注入上限 6000 字符。'),
            h('textarea', {
              key: 'ta',
              value: ready ? personaText : '',
              disabled: !ready,
              spellCheck: false,
              placeholder: '例：\n世界观：……\n关系：……\n口吻：说话简短、爱用反问。',
              onChange: (event) => setPersonaText(event.target.value),
              style: TEXTAREA_STYLE,
            }),
            h('div', { key: 'row', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
              h('button', {
                key: 'save',
                type: 'button',
                style: U.btnPrimary,
                disabled: busy || !ready,
                onClick: () => { void saveCard('persona'); },
              }, '保存角色卡'),
              h('span', { key: 'c', style: U.hint }, ready ? `${personaText.length} 字符` : '读取中…'),
              cardMsg ? h('span', { key: 'm', style: { ...U.hint, color: 'var(--dsw-alias-label-primary)' } }, cardMsg) : null,
            ]),
          ]) : null,

          // ───────── 场景页 ─────────
          tab === 'scenes' ? h('div', { key: 'sc', style: { display: 'flex', flexDirection: 'column', gap: 12 } }, [
            card('list', [
              cardHead('h', '场景列表', h('button', {
                key: 'open',
                type: 'button',
                style: U.btnTiny,
                onClick: () => { void openFolder('scenes'); },
              }, '📂 scenes')),
              hint('cur', `当前：${(cards && cards.active) || (state.scene && state.scene.active) || '_default'}　（仅多音色生效）`),
              h('div', { key: 'rows', style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                (cards && cards.scenes && cards.scenes.length)
                  ? cards.scenes.map((item) => {
                    const selected = sel === `scene:${item.id}`;
                    return h('div', {
                      key: item.id,
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '4px 6px',
                        borderRadius: 8,
                        border: `1px solid ${selected ? 'var(--dsw-alias-border-l2)' : 'transparent'}`,
                        background: selected
                          ? 'var(--dsw-alias-bg-layer-2)'
                          : 'transparent',
                      },
                    }, [
                      h('button', {
                        key: 'sel',
                        type: 'button',
                        onClick: () => { setSel(`scene:${item.id}`); },
                        title: `${item.personaBytes} B 角色卡 · ${item.castCount} 个音色`,
                        style: {
                          flex: 1,
                          minWidth: 0,
                          textAlign: 'left',
                          border: 'none',
                          background: 'transparent',
                          color: 'var(--dsw-alias-label-primary)',
                          fontSize: 12,
                          fontWeight: item.active ? 700 : 500,
                          cursor: 'pointer',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontFamily: 'inherit',
                          padding: 0,
                        },
                      }, `${item.active ? '🎭 ' : '· '}${item.id}`),
                      h('span', { key: 'meta', style: { ...U.hint, fontSize: 10.5 } }, `${item.castCount} 音色`),
                      h('button', {
                        key: 'act',
                        type: 'button',
                        disabled: busy || item.active,
                        onClick: () => { void sceneAction('activate', { id: item.id }); },
                        style: { ...U.btnTiny, opacity: item.active ? 0.4 : 1 },
                        title: '设为当前场景',
                      }, '设为当前'),
                      h('button', {
                        key: 'del',
                        type: 'button',
                        disabled: busy || item.id === '_default',
                        onClick: () => {
                          if (item.id === '_default') return;
                          // 二次确认：第一下只把按钮变成「确认删除?」，再点一下才真删（防误触）
                          if (confirmDel !== item.id) { setConfirmDel(item.id); return; }
                          setConfirmDel('');
                          if (sel === `scene:${item.id}`) setSel('');
                          void sceneAction('delete', { id: item.id });
                        },
                        style: {
                          ...U.btnTiny,
                          color: 'var(--dsw-alias-state-error-primary)',
                          opacity: item.id === '_default' ? 0.35 : 1,
                          fontWeight: confirmDel === item.id ? 700 : 500,
                        },
                        title: item.id === '_default'
                          ? '默认场景不能删'
                          : '点一下确认，再点一下移到回收目录',
                      }, confirmDel === item.id ? '确认删除?' : '删除'),
                    ]);
                  })
                  : hint('none', '还没有场景（下面新建一个）')),

              cardMsg ? h('div', { key: 'm', style: { ...U.hint, color: 'var(--dsw-alias-label-primary)' } }, cardMsg) : null,
              divider('dv'),
              h('div', { key: 'new', style: { display: 'flex', alignItems: 'center', gap: 6 } }, [
                h('input', {
                  key: 'input',
                  value: newName,
                  placeholder: '新场景 id（字母 / 数字 / - / _）',
                  spellCheck: false,
                  onChange: (event) => setNewName(event.target.value),
                  style: INPUT_STYLE,
                }),
                h('button', {
                  key: 'create',
                  type: 'button',
                  disabled: busy,
                  style: U.btnPrimary,
                  onClick: async () => {
                    const id = newName.trim();
                    if (!id) { setCardMsg('先给个名字'); return; }
                    const result = await sceneAction('create', { id });
                    if (result.ok) { setNewName(''); setSel(`scene:${id}`); }
                  },
                }, '新建'),
              ]),
            ]),

            !sceneLabel ? card('pick', [
              hint('e', '点一个场景名，下面展开它的角色卡与音色表。'),
            ]) : null,

            sceneLabel ? card('rename', [
              cardHead('h', '重命名场景'),
              // 不写说明：标题 + 输入框 + 按钮已经把这件小事说完了
              h('div', { key: 'row', style: { display: 'flex', alignItems: 'center', gap: 6 } }, [
                h('input', {
                  key: 'input',
                  value: renameTo,
                  placeholder: '新名字（字母 / 数字 / - / _）',
                  spellCheck: false,
                  onChange: (event) => setRenameTo(event.target.value),
                  style: INPUT_STYLE,
                }),
                h('button', {
                  key: 'go',
                  type: 'button',
                  style: U.btnPrimary,
                  disabled: busy,
                  onClick: async () => {
                    const next = renameTo.trim();
                    if (!next) { setCardMsg('重命名：先写新名字'); return; }
                    const result = await sceneAction('rename', { id: sceneLabel, newId: next });
                    if (result.ok) { setRenameTo(''); setSel(`scene:${next}`); }
                  },
                }, '重命名'),
              ]),
            ]) : null,

            sceneLabel ? card('persona', [
              cardHead('h', `${sceneLabel} · 角色卡`, h('button', {
                key: 'open',
                type: 'button',
                style: U.btnTiny,
                onClick: () => { void openFolder(sel); },
              }, '📂 打开场景')),
              hint('d', '只在角色扮演模式生效。'),
              h('textarea', {
                key: 'pta',
                value: ready ? personaText : '',
                disabled: !ready,
                spellCheck: false,
                placeholder: '这一局的角色卡',
                onChange: (event) => setPersonaText(event.target.value),
                style: TEXTAREA_STYLE,
              }),
              h('div', { key: 'prow', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
                h('button', {
                  key: 's',
                  type: 'button',
                  style: U.btnPrimary,
                  disabled: busy || !ready,
                  onClick: () => { void saveCard('persona'); },
                }, '保存角色卡'),
                h('span', { key: 'b', style: U.hint }, ready ? `${personaText.length} 字符` : '读取中…'),
                cardMsg ? h('span', { key: 'm', style: { ...U.hint, color: 'var(--dsw-alias-label-primary)' } }, cardMsg) : null,
              ]),
            ]) : null,

            sceneLabel ? card('cast', [
              cardHead('h', '音色表（cast.json）', [
                h('button', {
                  key: 'table',
                  type: 'button',
                  style: panelCtl(!castRaw),
                  onClick: () => {
                    if (castRaw) {
                      const parsed = parseCastRows(castText);
                      setCastRows(parsed.rows);
                      setCastErr(parsed.error);
                    }
                    setCastRaw(false);
                  },
                }, '表格'),
                h('button', {
                  key: 'raw',
                  type: 'button',
                  style: panelCtl(castRaw),
                  onClick: () => { setCastRaw(true); setCastErr(''); },
                }, '原始 JSON'),
              ]),
              hint('d', '一行一个角色；名字要和正文里的称呼一致，音色留空＝按语气现造。'),

              castRaw ? h('textarea', {
                key: 'cta',
                value: ready ? castText : '',
                disabled: !ready,
                spellCheck: false,
                onChange: (event) => setCastText(event.target.value),
                style: { ...TEXTAREA_STYLE, minHeight: 120 },
              }) : h('div', { key: 'table', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
                !ready ? hint('loading', '读取中…') : null,
                ...(castRows || []).map((row, index) => h('div', {
                  key: `row-${index}`,
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    padding: 8,
                    border: '1px solid var(--dsw-alias-border-l1)',
                    borderRadius: 8,
                    background: 'var(--dsw-alias-bg-layer-1)',
                  },
                }, [
                  h('div', { key: 'l1', style: { display: 'flex', gap: 6, alignItems: 'center' } }, [
                    h('input', {
                      key: 'name',
                      value: row.name,
                      disabled: !ready,
                      placeholder: '角色名（旁白 / 心声也要登记）',
                      spellCheck: false,
                      onChange: (event) => updateCastRow(index, { name: event.target.value }),
                      style: { ...INPUT_STYLE, fontWeight: 700 },
                    }),
                    h('button', {
                      key: 'del',
                      type: 'button',
                      title: '删掉这个角色',
                      disabled: !ready,
                      onClick: () => setCastRows((rows) => rows.filter((_, i) => i !== index)),
                      style: { ...U.btnTiny, color: 'var(--dsw-alias-state-error-primary)' },
                    }, '✕'),
                  ]),
                  h('div', { key: 'l2', style: { display: 'flex', gap: 6, alignItems: 'center' } }, [
                    h('select', {
                      key: 'voice',
                      value: row.voice || '',
                      disabled: !ready,
                      title: '选声音库里的音色；留空＝按语气现造一把',
                      onChange: (event) => updateCastRow(index, { voice: event.target.value }),
                      style: SELECT_STYLE,
                    }, [
                      h('option', { key: '', value: '' }, '— 设计模式（音色留空）—'),
                      ...voiceOptions(row.voice),
                    ]),
                    h('input', {
                      key: 'seed',
                      value: row.seed,
                      disabled: !ready,
                      placeholder: 'seed',
                      title: '同一段语气每次都得到同一把嗓子',
                      spellCheck: false,
                      onChange: (event) => updateCastRow(index, { seed: event.target.value }),
                      style: { ...INPUT_STYLE, flex: '0 0 62px' },
                    }),
                  ]),
                  h('textarea', {
                    key: 'tone',
                    value: row.tone,
                    disabled: !ready,
                    placeholder: row.voice ? '语气（情绪 / 语速，别重复音色描述）' : '音色描述：年龄 / 性别 + 音质 + 语速 + 口音',
                    spellCheck: false,
                    onChange: (event) => updateCastRow(index, { tone: event.target.value }),
                    style: { ...TEXTAREA_STYLE, minHeight: 46, fontFamily: 'inherit' },
                  }),
                ])),
                h('div', { key: 'srow', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
                  h('button', {
                    key: 'add',
                    type: 'button',
                    style: U.btn,
                    disabled: !ready,
                    onClick: () => setCastRows((rows) => [...(rows || []), { name: '', voice: '', tone: '', seed: '' }]),
                  }, '＋ 加一个角色'),
                  h('button', {
                    key: 'save',
                    type: 'button',
                    style: U.btnPrimary,
                    disabled: busy || !ready,
                    onClick: () => { void saveCastRows(); },
                  }, '保存音色表'),
                  h('span', { key: 'cnt', style: U.hint }, `${(castRows || []).filter((row) => String(row.name || '').trim()).length} 个角色`),
                ]),
                castErr ? h('div', {
                  key: 'err',
                  style: { ...U.hint, color: 'var(--dsw-alias-state-error-primary)' },
                }, castErr) : null,
                cardMsg ? h('div', {
                  key: 'msg',
                  style: { ...U.hint, color: 'var(--dsw-alias-label-primary)' },
                }, cardMsg) : null,
              ]),
            ]) : null,
          ]) : null,
        ]),
      ]);
    }


    /**
     *  入口：往「对话 / 轨迹」那一行末尾追加一枚自己的 chip。
     * 那一行在官方客户端里不是插槽（`conversation.view` 只给整页视图），所以只能以官方给的
     * `data-conversation-tabs` 为锚点，**只追加自己的节点、不读不改宿主任何节点与样式**。
     * 锚点找不到（官方改版）时把 chipMounted 置 false，标题行那个原生按钮会补位。
     */
    function TabChipMount() {
      useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        let dead = false;
        let chip = null;
        let queued = false;

        const findRow = () => document.querySelector('[data-conversation-tabs]')
          || document.querySelector("[role='tablist'][aria-label*='对话']")
          || document.querySelector("[role='tablist'][aria-label*='Conversation' i]");

        const paint = () => {
          if (!chip) return;
          const on = store.panelOpen;
          // 视觉对齐宿主自己的 tab（13px / 500 / 行高 16px / 下划线 2px）。
          // 修：**只换颜色，绝不改高度**。
          // 之前开面板时把 padding-bottom 从 9px 改成 7px，chip 总高 27→25px，
          // 而这一行是 `display:flex`（默认 align-items:stretch，行高 = 最高那个子项），
          // 于是其余三个 tab 的内容跟着上下挪 1~2px——就是"点开语音其它按钮往上跳"。
          chip.style.color = on
            ? 'var(--dsw-alias-state-business-primary)'
            : 'var(--dsw-alias-label-tertiary)';
          chip.style.borderBottomColor = on
            ? 'var(--dsw-alias-state-business-primary)'
            : 'transparent';
          chip.setAttribute('aria-selected', on ? 'true' : 'false');
          chip.title = on ? '关闭语音播报设置' : '打开语音播报设置';
        };

        const ensure = () => {
          if (dead) return;
          const row = findRow();
          if (!row) {
            chip = null;
            store.setChipMounted(false);
            return;
          }
          if (!chip) {
            chip = document.createElement('button');
            chip.type = 'button';
            chip.setAttribute('data-voice-breeze-tab', '');
            chip.setAttribute('data-vb-tip-scope', '');
            Object.assign(chip.style, {
              appearance: 'none',
              border: 'none',
              borderBottom: '2px solid transparent',
              background: 'transparent',
              cursor: 'pointer',
              // 高度必须与宿主 `.tab` 一致且**开合不变** 行高 16 + padding-bottom 9 = 25px。
              // 这里用 `border-bottom: 2px`（透明）来占位，padding-bottom 取 7，合计仍是 25；
              // 打开时只把边框颜色换成主题蓝，绝不动 padding —— 否则行高会变，整行跟着跳（修）。
              padding: '0 0 7px',
              margin: 0,
              font: 'inherit',
              fontSize: '13px',
              fontWeight: '500',
              lineHeight: '16px',
              color: 'var(--dsw-alias-label-tertiary)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              position: 'relative',
              // 行是 `display:flex; gap:36px;`（无 wrap、无 overflow）：别的 tab 多了会先被压缩，
              // 我们这个不参与压缩，所以它永远完整显示、只会被往右挤。
              flex: '0 0 auto',
              whiteSpace: 'nowrap',
            });
            chip.textContent = '🎙 语音';
            chip.addEventListener('click', (event) => {
              event.preventDefault();
              event.stopPropagation();
              store.togglePanel();
            });
          }
          if (chip.parentNode !== row) row.appendChild(chip);
          store.setChipMounted(true);
          paint();
        };

        const schedule = () => {
          if (queued) return;
          queued = true;
          setTimeout(() => { queued = false; ensure(); }, 150);
        };

        ensure();
        const unsub = store.sub(paint);
        const obs = typeof MutationObserver !== 'undefined' ? new MutationObserver(schedule) : null;
        if (obs) obs.observe(document.body, { childList: true, subtree: true });
        const timer = setInterval(ensure, 1000);
        return () => {
          dead = true;
          unsub();
          if (obs) obs.disconnect();
          clearInterval(timer);
          try { if (chip && chip.parentNode) chip.parentNode.removeChild(chip); } catch { /* 已卸载 */ }
          chip = null;
          store.setChipMounted(false);
        };
      }, []);
      return null;
    }

    /**  兜底入口：tab 行锚点不可用时，在会话标题行右侧给一个原生按钮（不抢位置、只占一格）。 */
    function HeaderEntry() {
      const shared = useStore();
      if (shared.chipMounted) return null;
      return h('button', {
        type: 'button',
        onClick: () => store.togglePanel(),
        title: shared.panelOpen ? '关闭语音播报设置' : '打开语音播报设置',
        'aria-label': '语音播报设置面板',
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'transparent',
          color: 'var(--dsw-alias-label-secondary)',
          borderRadius: 999,
          padding: '1px 8px',
          fontSize: 11,
          lineHeight: '18px',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        },
      }, '🎙 语音');
    }

    /**
     * 消息动作行（复制 / 赞 / 踩 / 分享 / 用量 / 时间 那一排）末尾的重播按钮。
     * 只拿到 messageId，所以先问宿主把 messageId 换算成那一轮的账目，再交给 dock 的播放器。
     */
    function ReplayAction(props) {
      const messageId = props && props.messageId ? String(props.messageId) : '';
      const sessionId = props && props.sessionId ? String(props.sessionId) : '';
      const [, force] = useState(0);
      const [busy, setBusy] = useState(false);
      const [note, setNote] = useState('');

      useEffect(() => bus.sub(() => force((n) => n + 1)), []);
      useEffect(() => {
        if (!note) return undefined;
        const timer = setTimeout(() => setNote(''), 4000);
        return () => clearTimeout(timer);
      }, [note]);

      const playingThis = bus.playing && bus.activeMessageId === messageId;

      const onClick = useCallback(async () => {
        if (playingThis) {
          bus.handlers?.stop();
          return;
        }
        if (!bus.handlers) {
          setNote('播放器还没就绪');
          return;
        }
        if (!messageId) {
          setNote('拿不到这条消息的 id');
          return;
        }
        setBusy(true);
        try {
          const query = `/voice-breeze/turn?message=${encodeURIComponent(messageId)}${sessionId ? `&session=${encodeURIComponent(sessionId)}` : ''}`;
          const result = await getJson(query);
          if (!result.ok) {
            setNote(result.status === 404 ? '这一轮已经不可回放' : `拉取失败 ${result.status || ''}`.trim());
            return;
          }
          const items = Array.isArray(result.data && result.data.items) ? result.data.items : [];
          if (!items.length) {
            setNote('这一轮没有语音');
            return;
          }
          setNote('');
          await bus.handlers.playItems(items, messageId);
        } finally {
          setBusy(false);
        }
      }, [playingThis, messageId, sessionId]);

      // 静止态用素材里的「声音」图标；播放中仍是 ⏹，请求中 …（两者保持单字符，宽度不跳）。
      // 尺寸与颜色按同排官方图标的实测值对齐（图标簇 ~18-21px、笔画色 ≈ #81858c，
      // 而我们的字形是实心的，所以用 label-secondary + 0.9 透明度才不会显得更黑更小）。
      const label = playingThis ? '⏹' : busy ? '…' : speakerIcon(18, 18);
      const title = note || (playingThis ? '停止播放这一轮' : '重播这一轮的语音（用缓存，不重新合成）');

      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 }, 'data-vb-msg': '', 'data-vb-tip-scope': '' }, [
        h('button', {
          key: 'btn',
          type: 'button',
          onClick: () => { void onClick(); },
          title,
          'aria-label': playingThis ? '停止语音' : '重播语音',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: 24,
            minWidth: 24,
            padding: '0 4px',
            border: 'none',
            background: 'transparent',
            color: 'var(--dsw-alias-label-secondary)',
            opacity: busy ? 0.5 : 0.9,
            fontSize: 13,
            lineHeight: '24px',
            cursor: 'pointer',
          },
        }, label),
        note ? h('span', { key: 'note', style: { fontSize: 12, opacity: 0.6 } }, note) : null,
      ]);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'voice-breeze',
          order: 25,
        }, VoiceBreeze));
        // 助手消息动作行末尾的重播按钮
        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions',
          id: 'voice-breeze-replay',
          order: 90,
        }, ReplayAction));
        // 操作面板（浮层）+ tab 行 chip；chip 挂不上时由标题行的原生按钮补位
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'voice-breeze-panel',
          order: 60,
        }, VoicePanel));
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'voice-breeze-tabchip',
          order: 61,
        }, TabChipMount));
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'voice-breeze-entry',
          order: 5,
        }, HeaderEntry));
      },
    };
  },
});

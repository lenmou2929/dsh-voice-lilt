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
    // 上一次报过的"没念成"时间戳，避免每 4 秒刷新都重弹同一句提示
    let voiceFailureSeenAt = '';
    const api = {
      async refresh() {
        const query = store.sessionId ? `?session=${encodeURIComponent(store.sessionId)}` : '';
        const result = await getJson(`/voice-breeze/state${query}`);
        if (result.ok) {
          store.setState(result.data);
          // 宿主记下了"哪几句没念成"（超时丢弃 / 合成失败），这里把它摆到界面上。
          // 以前这条信息只躺在 events.log 里，用户看到的是"已念"，然后以为模型没说话。
          const failure = result.data && result.data.voiceFailure;
          if (failure && failure.at) {
            // 每 4 秒刷新都重设一次，别让提示一闪就没（`setDiag` 原来在成功分支里被无条件清空）
            voiceFailureSeenAt = failure.at;
            const why = String(failure.reason || '').replace(/^engine-timeout:\s*/, '').slice(0, 60);
            store.setDiag(`⚠ ${failure.count || 1} 句没念成：${why}`);
          } else if (voiceFailureSeenAt && String(store.diag || '').startsWith('⚠ ')) {
            // 念成过了 → 撤掉这条提示（只撤我们自己写的，别踩别人的诊断行）
            voiceFailureSeenAt = '';
            store.setDiag('');
          }
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
     * （G2）：生成页的表单初值。
     * 数值一律用字符串存（输入框的中间态就是字符串），提交前再由 `genStyleFromForm()` 洗成数字 ——
     * 这样用户清空某项时不会被 `Number('')===0` 偷偷改成"0"。
     */
    /**
     * 1.2.2：**音色清单的两种形状 → 一种**。
     *
     * 生成页的音色下拉需要 `{id, name}`，而它有两个来源、形状不同：
     *  · `GET /engine` 的 `items` —— **`string[]`**（`voiceProfile().items`，只有 id）；
     *  · `GET /voices`（本机引擎兜底）—— `{id, description}`。
     * 以前只把后者映射了一遍，前者**原样塞进 `genVoices`** —— 于是 `one.id` 是 `undefined`，
     * 三百多个 `<option>` 全是空白，用户看到的就是"一条都没有"（MiniMax 那次 327 条全隐形）。
     * 现在统一走这一个函数：字符串 → `{id:n, name:n}`；对象 → 保 id、name 兜到 id。
     */
    const normVoiceList = (list) => (Array.isArray(list) ? list : [])
      .map((one) => {
        if (typeof one === 'string') return one.trim() ? { id: one.trim(), name: one.trim() } : null;
        if (!one || typeof one !== 'object') return null;
        const id = String(one.id || one.voice_id || '').trim();
        if (!id) return null;
        return { id, name: String(one.name || one.description || id).trim() || id };
      })
      .filter(Boolean);

    const EMPTY_GEN_FORM = {
      text: '',
      name: '',
      // B1（0.98.0）：生成模式。默认 `direction` —— 这正是 0.97.0 生成页的实际行为
      // （音色兜会话音色、`instructions` 有就发），所以默认观感不变，只是现在说清楚了。
      // `auto` 只留给工具不传 mode 的老调用方，不上界面。
      mode: 'direction',
      // B2（0.99.0）：采样参数。**空 = 引擎默认**（引擎的约定是 0 = 用模型默认，所以空不是 0）。
      // `take` 是面板专属：≥2 就按 seed 递增生一串 → 一次抽 N 粒候选。
      // B3（1.0.0）：变声档专用的三个字段 —— `srcName` = 生成列表里的文件名，
      // `srcFile` = 浏览器选中的 File（上传走裸字节，不拼 FormData），`keep` = KEEP MELODY
      srcName: '',
      srcFile: null,
      keep: '0',
      seed: '',
      take: '1',
      // 引导强度（breeze 的 `cfg_scale`）：留空 = 按模式默认（设计 4 / 克隆 1 / 指挥 2.5）
      cfg_scale: '',
      temperature: '',
      top_k: '',
      top_p: '',
      repetition_penalty: '',
      max_new_tokens: '',
      split_chars: '',
      voice: '',
      instructions: '',
      emotion: '',
      soundEffects: '',
      speed: '',
      vol: '',
      pitch: '',
      vmPitch: '',
      vmIntensity: '',
      vmTimbre: '',
      // 多音色混音（`timbreWeights`）。至少两条才写进 style（少于两条在官方那里等于没混）。
      mixes: [],
    };

    /**
     * （G2）：把表单里填过的项拼成 `style` 对象（只带填了的字段）。
     *
     * 规则与宿主 `pickCallStyle()` 一致：空串 = 不传（用厂商/全局默认）；数字必须有限；
     * 调音台三项在 0 时不写（0 在 MiniMax 里等于"不动"，写进去只会让请求多一个字段）。
     * **这里是"少写"而不是"校验"** 越界由宿主 `coerceStyle()` 夹值，不在这边重复一套规则。
     */
    /**
     * B2（0.99.0）：把「高级」区那几个格子转成请求字段。
     * **空字符串一律不发** —— 引擎的约定是 `0` = 用模型默认，而空不是 0：
     * 发了 `0` 与不发等价，但不发更诚实（日志里不会留下"看起来改了什么"的假象）。
     */
    /**
     * B3：表单里的 `mode` 落到"这家真正支持的那几档"上。
     * 渲染和提交必须用**同一个判断**，否则会出现"界面显示变声、实际提交 design"这类错位。
     */
    const genModeOf = (form, caps) => {
      const list = Array.isArray(caps && caps.modes) && caps.modes.length ? caps.modes : ['clone'];
      const want = String((form && form.mode) || 'direction');
      return list.includes(want) ? want : list[list.length - 1];
    };

    const genSamplingFromForm = (form) => {
      const out = {};
      if (String(form.seed ?? '').trim() !== '') out.seed = Number(form.seed);
      // `cfg_scale` 与那六项不归同一个函数（宿主用 `resolveGenMode()` 管它），但"表单 → 请求字段"
      // 这一步只有这里，放一起最不容易漏。
      if (String(form.cfg_scale ?? '').trim() !== '') out.cfg_scale = Number(form.cfg_scale);
      for (const key of ['temperature', 'top_k', 'top_p', 'repetition_penalty', 'max_new_tokens', 'split_chars']) {
        const raw = String(form[key] ?? '').trim();
        if (raw !== '' && Number.isFinite(Number(raw))) out[key] = Number(raw);
      }
      return out;
    };

    const genStyleFromForm = (form) => {
      const src = form && typeof form === 'object' ? form : {};
      const style = {};
      if (String(src.emotion || '').trim()) style.emotion = String(src.emotion).trim();
      for (const key of ['speed', 'vol', 'pitch']) {
        const raw = String(src[key] ?? '').trim();
        if (raw !== '' && Number.isFinite(Number(raw))) style[key] = Number(raw);
      }
      const vm = {};
      for (const [from, to] of [['vmPitch', 'pitch'], ['vmIntensity', 'intensity'], ['vmTimbre', 'timbre']]) {
        const raw = String(src[from] ?? '').trim();
        if (raw !== '' && Number.isFinite(Number(raw)) && Number(raw) !== 0) vm[to] = Number(raw);
      }
      if (String(src.soundEffects || '').trim()) vm.soundEffects = String(src.soundEffects).trim();
      if (Object.keys(vm).length) style.voiceModify = vm;
      // 混音：最多 4 条、权重 1~100；少于两条不写（官方规则，见 `03` §2.9.4 ③）
      const mixes = Array.isArray(src.mixes) ? src.mixes : [];
      const weights = mixes
        .map((one) => ({
          voice_id: String((one && one.voice_id) || '').trim(),
          weight: Math.round(Number(one && one.weight) || 0),
        }))
        .filter((one) => one.voice_id && one.weight > 0)
        .slice(0, 4);
      if (weights.length >= 2) style.timbreWeights = weights;
      return style;
    };

    /**
     * G4b（1.0.8）：**一条 index 记录 → 一份表单**。
     *
     * 以前这段逻辑只长在"模型刚生成过就自动回填"的 `useEffect` 里（G3），
     * 于是「按这条参数再生成」这个按钮要重写一遍同样的映射 —— 两份必然漂。
     * 现在收成这一个纯函数（`function` 声明，提升，不存在 TDZ 问题）：
     * 自动回填、列表里每条上的「拿来再生成」，都调它。
     *
     * 两条容易漏的：
     *  ① 采样六项必须一起回填 —— 它们 1.0.8 才进 index（`generatedEntry` 白名单），
     *     老记录里是 `null`，`num()` 会落成空串（= 引擎默认），比填 0 正确（坑 42）。
     *  ② 变声记录（`genMode:'changer'`）要回填**源与 KEEP MELODY**，否则用户点进来
     *     看到的是一个空的"源音频"格，还得自己去列表里猜刚才用的是哪条。
     */
    function formFromEntry(entry) {
      const one = entry && typeof entry === 'object' ? entry : {};
      const st = one.style && typeof one.style === 'object' ? one.style : {};
      const vm = st.voiceModify && typeof st.voiceModify === 'object' ? st.voiceModify : {};
      const num = (value) => (value === undefined || value === null ? '' : String(value));
      const isChanger = String(one.genMode || '') === 'changer';
      return {
        ...EMPTY_GEN_FORM,
        text: String(one.text || ''),
        name: '',
        mode: String(one.genMode || one.mode || 'direction'),
        seed: num(one.seed),
        cfg_scale: num(one.cfgScale),
        temperature: num(one.temperature),
        top_k: num(one.top_k),
        top_p: num(one.top_p),
        repetition_penalty: num(one.repetition_penalty),
        max_new_tokens: num(one.max_new_tokens),
        split_chars: num(one.split_chars),
        voice: String(one.voice || ''),
        instructions: String(one.instructions || ''),
        emotion: String(st.emotion || ''),
        soundEffects: String(vm.soundEffects || ''),
        speed: num(st.speed),
        vol: num(st.vol),
        pitch: num(st.pitch),
        vmPitch: num(vm.pitch),
        vmIntensity: num(vm.intensity),
        vmTimbre: num(vm.timbre),
        mixes: Array.isArray(st.timbreWeights)
          ? st.timbreWeights.map((m) => ({ voice_id: String(m.voice_id || ''), weight: m.weight }))
          : [],
        // 变声档专用：源文件（`fromFile` 是 1.0.8 才记的，老记录没有 → 空，让用户重选）
        srcName: isChanger ? String(one.fromFile || '') : '',
        srcFile: null,
        keep: isChanger ? num(one.keepAcoustic) || '0' : '0',
      };
    }

    /** 文件大小 → 好读的字符串（列表里显示用） */
    const prettyBytes = (n) => {
      const v = Number(n) || 0;
      if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
      if (v >= 1024) return `${Math.round(v / 1024)} KB`;
      return `${v} B`;
    };

    /** 时长 → `m:ss` / `ss.s 秒` */
    const prettyDuration = (ms) => {
      const total = Math.max(0, Math.round(Number(ms) || 0));
      if (!total) return '';
      if (total < 60000) return `${(total / 1000).toFixed(1)} 秒`;
      const m = Math.floor(total / 60000);
      const s = Math.round((total % 60000) / 1000);
      return `${m} 分 ${s} 秒`;
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

    /**
     * **客户端时间线**。只为查"同一段音频被拉了两遍"那类问题——
     * 浏览器侧的 `loadstart` 次数是唯一能分辨"两个元素"还是"同一个元素被重拉"的证据，
     * 而它只活在浏览器里，不回传就永远看不见。一行一条、每播放一段最多 4 行。
     */
    let clientTraceSeq = 0;
    const clog = (msg) => {
      try {
        void fetch('/voice-breeze/client-log', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ msg: String(msg).slice(0, 200) }),
        }).catch(() => {});
      } catch { /* 诊断不该影响播放 */ }
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
        // 时间线。`loadstart` 是浏览器"真的去拉这个 URL"的那一刻——
        // 同一个元素上出现两次 = 浏览器自己重拉；出现两个元素序号 = 队列里有两份。
        const traceNo = (clientTraceSeq += 1);
        const shortId = String(item.id || el.src.split('/').pop() || '').slice(0, 16);
        let how = 'ended';
        clog(`play#${traceNo} id=${shortId} chars=${item.chars || 0}`);
        el.addEventListener('loadstart', () => clog(`loadstart#${traceNo} id=${shortId}`));
        /*
         * 2026-11-18：**播放器这一侧到底发生了什么**。
         *
         * 只记 `play/loadstart/end` 是不够的 —— 用户报"读到一半刺啦"，而日志里只有一条 `end`。
         * 现在把媒体元素的每个状态转折都记下来（带 `currentTime` 与已缓冲到的秒数）：
         *  · `loadedmetadata` / `duration` → 浏览器认为这条音频多长（和盘上字节对不上就是容器问题）；
         *  · `waiting` / `stalled` → 断供（这就是"刺啦 + 变长"的那一段）；
         *  · `suspend` / `abort` / `emptied` → 媒体栈自己重置了资源（与宿主 `audio:abort` 对照看）；
         *  · `error` → 解码失败的 code（MEDIA_ERR_DECODE = 3 就是"读不懂这段数据"）；
         *  · `seeked` → 有人跳读了。
         * 这些行只在播放期出现，量很小；排查时是唯一能说明"用户当时听到了什么"的证据。
         */
        const at = () => {
          try {
            const b = el.buffered;
            const bufferedTo = b && b.length ? b.end(b.length - 1) : 0;
            return `t=${Number(el.currentTime || 0).toFixed(2)} dur=${Number.isFinite(el.duration) ? Number(el.duration).toFixed(2) : '?'} buf=${Number(bufferedTo || 0).toFixed(2)}`;
          } catch { return 't=?'; }
        };
        for (const [evt, label] of [
          ['loadedmetadata', 'meta'],
          ['canplay', 'canplay'],
          ['playing', 'playing'],
          ['waiting', 'waiting'],
          ['stalled', 'stalled'],
          ['suspend', 'suspend'],
          ['abort', 'abort'],
          ['emptied', 'emptied'],
          ['seeked', 'seeked'],
        ]) {
          el.addEventListener(evt, () => clog(`${label}#${traceNo} id=${shortId} ${at()}`));
        }
        el.addEventListener('error', () => {
          const code = el.error ? el.error.code : '?';
          const msg = el.error && el.error.message ? String(el.error.message).slice(0, 60) : '';
          clog(`mediaerror#${traceNo} id=${shortId} code=${code} ${msg} ${at()}`);
        });
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
          el.onerror = () => {
            // **合成失败不再是静音的黑洞**。以前这一段被 'error' 直接当"播完了"，
            // 界面上只留一句"已念"（朋友的现场就是这么被骗了三小时）。现在至少留一句话 + 日志。
            how = 'error';
            const raw = el.error ? el.error.code : 0;
            const code = el.error ? `media ${el.error.code}` : 'unknown';
            clog(`error#${traceNo} id=${shortId} ${code}`);
            /*
             * 1.2.4：**别把所有播放失败都说成"没合成成功"**。
             * `code 4`（DEMUXER_ERROR_COULD_NOT_OPEN）几乎总是"这个 id 服务器上已经没有"
             * （账目过期 / 服务重启过）—— 那时"点重播再试一次"还是同一个 id，照样失败，
             * 等于让用户白点。`code 3`（DECODE）才是数据本身坏。
             */
            setDiag(raw === 4
              ? '🔇 这段语音已经不在了（账目过期或服务重启过）· 去「生成」页或历史里再听一次'
              : `🔇 这段没合成成功（${code}）· 点重播再试一次`);
            resolve();
          };
          el.onpause = () => { if (stopFlag.current) { how = 'paused'; resolve(); } };
        });
        clog(`end#${traceNo} id=${shortId} ${how}`);
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
        /*
         * 多段播报之间留气口：队列里还有下一段时，先静默 gapMs 再念。
         *
         * T5：**同一段的续片不插气口**。宿主把一段长文本切成几片
         * （`pieceGroup` 相同），那几片本来就是一句话的不同部分 —— 每片之间插 500 ms
         * 会把"抗卡顿"变成"一句一顿"，比原来的卡顿更难听。所以只在"换段"时留气口。
         */
        if (queue.current.length) {
          const next = queue.current[0];
          const sameGroup = Boolean(item.pieceGroup) && next && next.pieceGroup === item.pieceGroup;
          const gap = sameGroup ? 0 : Number(state.segmentGapMs);
          if (gap > 0) {
            await new Promise((resolve) => setTimeout(resolve, Number.isFinite(gap) && gap >= 0 ? gap : 1200));
            if (!alive.current) return;
          }
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
        /*
         * 1.2.4：**问宿主要"最新一轮播报"，不再自己从账目里猜**。
         *
         * 老写法取 `/pending?since=0` 的**最后一条**，再按它的 `turn` 分组。
         * 可账目里还混着面板生成的音频（`kind:'gen'`，`turn` 常常是 0 —— 它不属于任何回合），
         * 于是"重播最新一轮"变成"把 turn=0 的全部音频从头放一遍"：
         * 用户听到的是自己生成过的十几条依次播，最后还因为某条已被淘汰而 404 报红。
         */
        let group = [];
        if (sessionId) {
          const result = await getJson(`/voice-breeze/replay?session=${encodeURIComponent(sessionId)}`);
          if (result.ok && Array.isArray(result.data && result.data.items)) group = result.data.items;
        }
        if (!group.length && lastItem.current && lastItem.current.url) group = [lastItem.current];
        if (!group.length) {
          setDiag('没有可重播的语音');
          return;
        }
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
      // /（A3）：**音色下拉跟当前引擎走**。云端引擎的音色在面板「引擎」页选，
      // 这个下拉列的是本机 BreezeTTS 声音库，对云端毫无意义（发过去只会 400 或被静默换嗓子），
      // 所以云端下不列本机音色，改成一句指路（`15` §4.9）。
      const eng = state.engine || null;
      const notBreeze = Boolean(eng && eng.kind && eng.kind !== 'breeze');
      let options;
      if (multiVoice) {
        // 多音色模式：同一个下拉变形为「场景选择器」
        options = [
          ...sceneInfo.ids.map((id) => ({ id: `scene:${id}`, label: id === sceneInfo.active ? `🎭 ${id} · 当前` : `🎭 ${id}` })),
          { id: 'exit-multivoice', label: '↩ 退出多音色（回到单音色）' },
        ];
      } else if (notBreeze) {
        options = [
          { id: 'enter-multivoice', label: `🎭 多音色扮演${sceneInfo.ids.length ? `（${sceneInfo.active} · ${state.castSize || 0} 个音色）` : '（本场景没有音色表）'}` },
          { id: '', label: `（音色在面板「引擎」页里选：${eng.label || eng.id}）`, disabled: true },
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
        value: multiVoice ? `scene:${sceneInfo.active}` : (notBreeze ? '' : current),
        title: multiVoice
          ? '选场景：连同这一局的角色卡与音色表一起换'
          : (notBreeze ? '云端引擎的音色在面板「引擎」页里选' : '选音色；第一项「多音色扮演」进入分角色演出'),
        onFocus: () => { if (!notBreeze) void api.loadVoices(); },
        onChange: (event) => {
          const next = event.target.value;
          if (notBreeze && !next) return; // 说明项不是可选项
          void api.pickVoice(next);
        },
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
    /**
     * **顶栏保护线**。
     *
     * 实测：把浮窗拖到左上角（`y=0`）之后，想再拖回来时点不到它——
     * 那一条是 DSH 的窗口顶栏，点下去是"拖整个窗口 / 点顶栏按钮"。
     * 两层修法一起上：
     *  1. 面板层级提到 `Z_PANEL`（夹在 DSH 自己的浮层之间，见那里的注释）；
     *  2. **位置夹住** `y` 不允许小于这条线，旧坐标（`y=0`）在打开时就被抬回来 ——
     *     这样即使层级判断有误，面板也不会再落到顶栏里变成"够不着"。
     */
    const TITLEBAR_GUARD = 48;
    /** DSH 自己的浮层：菜单/悬停卡 100、子菜单 101、模态 1000、toast 1100（从它的 CSS 里数的）。 */
    const Z_PANEL = 300;

    function panelDefaultPos() {
      const viewW = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1280;
      return { x: Math.max(12, viewW - PANEL_W - 48), y: 96 };
    }

    /**
     * 把面板位置夹进视口。
     * 修：最大化时把面板拖到最右，再把窗口恢复成小窗 → `position: fixed` 的坐标没变，
     * 面板就跑到缩小后的窗口外面（看不见）；重新最大化又"回来"了。窗口 resize 时一律夹回。
     * 上边界从 0 提到 `TITLEBAR_GUARD`（顶栏那一条不归我们管）。
     */
    function clampPos(x, y) {
      const viewW = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1280;
      const viewH = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 800;
      return {
        x: Math.max(0, Math.min(Number(x) || 0, Math.max(0, viewW - PANEL_W - 8))),
        y: Math.max(TITLEBAR_GUARD, Math.min(Number(y) || 0, Math.max(TITLEBAR_GUARD, viewH - 80))),
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
      /*
       * T5（1.2.0）：片长的草稿值。`null` = 没在改（显示宿主的值），改完 blur/回车才落盘。
       */
      const [chunkDraft, setChunkDraft] = useState(null);
      const commitChunk = () => {
        if (chunkDraft === null) return;
        const raw = String(chunkDraft).trim();
        const next = raw === '' ? 0 : Math.min(400, Math.max(0, Math.round(Number(raw) || 0)));
        setChunkDraft(null);
        void patchState({ chunkChars: next }, '切片片长');
      };
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
      // ───────── （A3）：引擎页 ─────────
      // 设计口径（`15` §4.7 / §4.9）：本机引擎永远在列表里且不可删；云端 provider 可新建/编辑/启用/删除；
      // key 只写不读（保存后输入框清空，快照里只有 keyPresent）；**没有音色清单的引擎把音色控件藏起来，并把
      // 「现在用谁 / 为什么藏了 / 想换怎么办」用宿主给的 guidance 原话讲清楚**。
      const [engInfo, setEngInfo] = useState(null);
      const [engForm, setEngForm] = useState(null); // { id, label, baseUrl, model, apiKey, defaultVoice, isNew }
      const [engMsg, setEngMsg] = useState('');
      const [engBusy, setEngBusy] = useState(false);
      // 音色清单（`{id,name}`）。编辑时先用该 provider 快照里的 items 铺底，
      // 「拉取清单」再去问引擎要真的（MiniMax 有 `/v1/get_voice`）。
      const [voiceList, setVoiceList] = useState([]);

      const loadEngine = useCallback(async () => {
        const result = await getJson('/voice-breeze/engine');
        if (result.ok) setEngInfo(result.data);
        else setEngMsg(`读取失败：${result.status || ''}`);
      }, []);

      // 只在切到引擎页时拉一次（面板每帧都渲染，不能无条件请求）
      useEffect(() => {
        if (tab === 'engine') void loadEngine();
      }, [tab, loadEngine]);

      const enginePost = useCallback(async (payload) => {
        setEngBusy(true);
        const result = await getJson('/voice-breeze/engine', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        setEngBusy(false);
        if (result.ok) {
          setEngInfo(result.data);
          setEngMsg('');
        } else {
          setEngMsg(`操作失败：${(result.data && result.data.error) || result.status || ''}`);
        }
        return result;
      }, []);

      /** 保存一条 provider：POST 是**整组替换**，所以要把现有列表整份带上。 */
      const submitEngine = useCallback(async (form) => {
        const id = String(form.id || '').trim();
        if (!/^[A-Za-z0-9_-]{1,32}$/.test(id) || id === 'breeze') {
          setEngMsg('id 只能用字母 / 数字 / - / _（1~32 位），且不能叫 breeze');
          return null;
        }
        const baseUrl = String(form.baseUrl || '').trim();
        if (!/^https?:\/\//i.test(baseUrl)) {
          setEngMsg('baseUrl 要以 http:// 或 https:// 开头');
          return null;
        }
        const list = (((engInfo && engInfo.providers) || [])).map((one) => ({ ...one }));
        // 按域名猜厂商专用 kind —— MiniMax 不走 OpenAI 兼容形状，
        // 存成 openai-compat 会把请求打到 /v1/audio/speech 拿 404。
        let guessHost = '';
        try { guessHost = new URL(baseUrl).hostname.toLowerCase(); } catch { guessHost = ''; }
        const guessedKind = (guessHost.includes('minimax') || guessHost.includes('minimaxi')) ? 'minimax' : 'openai-compat';
        const entry = {
          id,
          kind: guessedKind,
          label: String(form.label || id).trim(),
          baseUrl,
          model: String(form.model || 'tts-1').trim(),
          defaultVoice: String(form.defaultVoice || '').trim(),
        };
        // （P2）：风格参数原样交给宿主洗（白名单 + 夹值都在 `coerceStyle()` 里）。
        // 非 MiniMax 的表单没有这一块，就不带 style —— 免得把已有的风格整组洗掉。
        if (form.style && typeof form.style === 'object') entry.style = form.style;
        if (form.apiKey && String(form.apiKey).trim()) entry.apiKey = String(form.apiKey).trim();
        const at = list.findIndex((one) => one.id === id);
        if (at >= 0) list[at] = { ...list[at], ...entry };
        else list.push(entry);
        const result = await enginePost({ providers: list });
        if (result && result.ok) setEngForm(null);
        return result;
      }, [engInfo, enginePost]);

      const removeEngine = useCallback(async (id) => {
        const list = (((engInfo && engInfo.providers) || []).filter((one) => one.id !== id)).map((one) => ({ ...one }));
        await enginePost({ providers: list });
      }, [engInfo, enginePost]);

      // ───────── （G2）：生成页 ─────────
      // 全部 hooks 必须写在这句 `return null` **之前**（`06` 坑 20：早退之后的 hook 会让组件直接抛错）。
      const [genInfo, setGenInfo] = useState(null);   // {dir, items, last}
      const [genCaps, setGenCaps] = useState(null);   // /engine 的 caps —— 与「引擎」页同源，不按域名猜
      const [genVoices, setGenVoices] = useState([]); // 当前引擎的音色清单（面板里只做候选，可自由填）
      const [genDir, setGenDir] = useState('');       // 输出目录（输入框里的值）
      const [genForm, setGenForm] = useState(EMPTY_GEN_FORM);
      const [genMsg, setGenMsg] = useState('');
      const [genBusy, setGenBusy] = useState(false);
      // 2026-11-18 用户定：**采样六格默认折叠**（常用的是种子/抽卡，那几项是偶尔才动的旋钮）。
      const [genAdv, setGenAdv] = useState(false);
      /*
       * 2026-11-18：手动「启动引擎」按钮的"刚点过"记忆。
       * 20 秒内不再发请求（宿主那边也有 `serverStarting` 闸门 + spawn 节流，双保险）；
       * 引擎起来后整张卡片会消失，所以不需要额外的"重置"逻辑。
       */
      const [engineStartedAt, setEngineStartedAt] = useState(0);
      /*
       * 提交锁：`disabled` 要等下一次渲染才生效，同一帧里的第二次点击照样会进来；
       * 结果是"第一次成功、第二次失败"，失败提示盖掉成功提示 —— 用户看到"明明播了却说失败"。
       * `useRef` 是同步的，挡得住这一帧。
       */
      const submitLock = useRef(false);
      const [genRename, setGenRename] = useState({ from: '', to: '' });
      const [genDel, setGenDel] = useState('');       // 删除二次确认（点一下变「确认删除?」）
      const [genFilledAt, setGenFilledAt] = useState(''); // 已经回填过哪一条（按 `at` 去重，避免每帧重填）
      /*
       * G4（1.0.8）：批量生成与拖拽排序。
       *
       * `genBatch` 是那行"一行一条"的原文（**与表单的 `text` 分开** 批量的输入不该把单条正文顶掉）；
       * `genBatchOpen` 默认收起 —— 批量是偶发操作，摊开会让表单长一截。
       * `genDrag` 记"正在拖哪一条"，只用于给被拖的那行加虚线框（视觉反馈，不参与数据）。
       */
      const [genBatch, setGenBatch] = useState('');
      const [genBatchOpen, setGenBatchOpen] = useState(false);
      const [genDrag, setGenDrag] = useState('');
      // G5（1.0.9）：垃圾桶「清空」的二次确认（与音频删除同一套手感，4 秒自己取消）
      const [genTrashDel, setGenTrashDel] = useState(false);

      const loadGen = useCallback(async () => {
        const [list, eng] = await Promise.all([getJson('/voice-breeze/gen'), getJson('/voice-breeze/engine')]);
        if (list.ok) {
          setGenInfo(list.data);
          setGenDir(String((list.data && list.data.dir) || ''));
        } else {
          setGenMsg(`读取生成目录失败：${list.status || ''}`);
        }
        if (eng.ok) {
          const caps = (eng.data && eng.data.caps) || null;
          setGenCaps(caps);
          // 1.2.2：`/engine.items` 是 `string[]`，**必须归一化**（否则下拉里全是空白项）
          const items = normVoiceList(eng.data && eng.data.items);
          setGenVoices(items);
          // 本机引擎的音色清单是**异步拉的**（`/v1/voices` 缓存 60 s）：刚启动时 `/engine.items` 可能是空的，
          // 于是生成页会退化成"手填音色 id"。这里补一次 `/voices`，本机用户就能直接选。
          if (!items.length && (!caps || caps.kind === 'breeze')) {
            const list = await getJson('/voice-breeze/voices');
            if (list.ok && Array.isArray(list.data && list.data.items)) {
              setGenVoices(normVoiceList(list.data.items));
            }
          }
        }
      }, []);

      useEffect(() => {
        if (tab === 'gen') void loadGen();
      }, [tab, loadGen]);

      /*
       * G3 的回填（`10` §12）：面板打开「生成」页时，若**最后一条来自模型**，
       * 把它那次用的整套参数填进表单，用户在模型给的基础上微调再生成 —— 这就是要的闭环。
       * 只在 `last.at` 变了时填一次：用户改到一半顺手刷新列表，不该把他的手改冲掉。
       */
      useEffect(() => {
        if (tab !== 'gen' || !genInfo || !genInfo.last) return;
        const last = genInfo.last;
        if (last.source !== 'model') return;
        const key = String(last.at || last.file || '');
        if (!key || key === genFilledAt) return;
        setGenFilledAt(key);
        // G4b：映射收进 `formFromEntry()`（与列表里那个「拿来再生成」按钮共用一份）
        setGenForm(formFromEntry(last));
        setGenMsg(`模型刚生成过一条（${last.file}），参数已填进表单，改完可以直接再生成`);
      }, [tab, genInfo, genFilledAt]);

      // 删除的二次确认：4 秒没人点就自己取消（与场景删除同一套手感）
      useEffect(() => {
        if (!genDel) return undefined;
        const timer = setTimeout(() => setGenDel(''), 4000);
        return () => clearTimeout(timer);
      }, [genDel]);

      // G5：「清空垃圾桶」的二次确认同样 4 秒过期（避免"确认"按钮一直挂着被误点）
      useEffect(() => {
        if (!genTrashDel) return undefined;
        const timer = setTimeout(() => setGenTrashDel(false), 4000);
        return () => clearTimeout(timer);
      }, [genTrashDel]);

      /**
       * B3（1.0.0）：变声提交。**两条投递方式**（与宿主 `/convert` 的两种 content-type 一一对应）：
       *
       *  · 从生成列表挑一条 → JSON `{sourceName, voice, keep_acoustic, …}`；
       *    源就在宿主的输出目录里，一个字节都不用上传。
       *  · 浏览器选了文件 → **body 直接是 wav 字节**、参数全在 query 上；
       *    宿主那边一行 multipart 解析都不用写（它连 form 都不建）。
       *
       * 变声是**非流式**的：引擎要先编码完整个源才出声，长素材很慢，所以这里只给一句等待提示。
       */
      const submitConvert = useCallback(async (form) => {
        const voice = String(form.voice || '').trim();
        if (!voice) { setGenMsg('先选一个目标音色'); return; }
        const hasFile = Boolean(form.srcFile);
        if (!hasFile && !String(form.srcName || '').trim()) {
          setGenMsg('先选一段源音频：列表里挑一条，或上传一个 wav');
          return;
        }
        setGenBusy(true);
        setGenMsg(hasFile ? '正在上传并换声…（引擎要先编码整段源，长素材会很久）' : '正在换声…（引擎要先编码整段源，长素材会很久）');
        const q = new URLSearchParams();
        q.set('voice', voice);
        q.set('keep', String(form.keep || '0'));
        for (const key of ['temperature', 'top_k', 'cfg_scale', 'seed']) {
          const raw = String(form[key] ?? '').trim();
          if (raw !== '') q.set(key, raw);
        }
        const srcText = String(form.text || '').trim();
        if (srcText) q.set('text', srcText);
        const wanted = String(form.name || '').trim();
        if (wanted) q.set('name', wanted);
        if (store.sessionId) q.set('session', store.sessionId);

        /*
         * ⚠ 2026-11-18：`await` 必须包住**整个三元**。
         * 原来写的是 `const result = hasFile ? await (async …)() : getJson(…)` ——
         * `await` 只绑定了 `hasFile` 为真的那一支；**从列表里挑源**（`hasFile === false`）时
         * `result` 拿到的是一个 **Promise**，于是 `!result.ok` 恒为真（`Promise.ok` 是 undefined），
         * 面板就报「换声失败：」（`data`/`status` 都没有，所以后半句还是空的）——
         * 而宿主那边**成功并播了**，日志里只有 `convert:done`。
         * `node --check` 查不出来（语法完全合法）。
         */
        const result = await (hasFile
          ? (async () => {
            q.set('filename', String(form.srcFile.name || 'upload.wav'));
            return getJson(`/voice-breeze/convert?${q.toString()}`, {
              method: 'POST',
              headers: { 'content-type': form.srcFile.type || 'audio/wav' },
              body: form.srcFile,
            });
          })()
          : getJson('/voice-breeze/convert', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sourceName: String(form.srcName || '').trim(),
              voice,
              keep_acoustic: Number(form.keep || 0),
              temperature: String(form.temperature || '').trim() || undefined,
              top_k: String(form.top_k || '').trim() || undefined,
              cfg_scale: String(form.cfg_scale || '').trim() || undefined,
              seed: String(form.seed || '').trim() || undefined,
              text: srcText || undefined,
              name: wanted || undefined,
              save: true,
            }),
          }));
        setGenBusy(false);
        // 形状兜底：将来若又把 `await` 写丢，这里会给出"没拿到回执"而不是一句空话
        if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
          setGenMsg('换声失败：前端没拿到宿主回执（多半是代码 bug，请把这句话发我）');
          return;
        }
        if (!result.ok) {
          setGenMsg(`换声失败：${(result.data && result.data.error) || result.error
            || (result.status ? `HTTP ${result.status}` : '宿主没有响应')}`);
          return;
        }
        const item = (result.data && result.data.item) || null;
        const play = (result.data && result.data.play) || null;
        setGenMsg(item
          ? `已换声 ${item.file}（${prettyDuration(item.durationMs) || '时长未知'}，${prettyBytes(item.bytes)}），正在播…`
          : '已换声，正在播…');
        if (play && play.url && bus.handlers) {
          await bus.handlers.playItems([{ id: play.id, url: play.url, chars: 0 }], '');
        }
        await loadGen();
      }, [loadGen]);
      const submitGen = useCallback(async () => {
        if (submitLock.current) return;
        submitLock.current = true;
        try {
        const form = genForm;
        // B3：变声档是另一条链路（源是音频不是文本、走 /convert、非流式），在这里分出去
        if (genModeOf(form, genCaps) === 'changer') { await submitConvert(form); return; }
        const text = String(form.text || '').trim();
        if (!text) { setGenMsg('先写要合成的文本'); return; }
        /*
         * B2（0.99.0）：抽卡。`take≥2` 且这家认 seed → 把 seed 递增生一串交给宿主，
         * 宿主逐粒合成、逐粒落盘、**都不播**，回来由用户在列表里挑。
         * 只有认 seed 的引擎才允许（面板按 `caps.sampling` 决定露不露这一格）。
         */
        const sampling = Array.isArray(genCaps && genCaps.sampling) ? genCaps.sampling : [];
        const take = Math.min(4, Math.max(1, Math.round(Number(form.take) || 1)));
        const baseSeed = Number(form.seed);
        const seeds = (sampling.includes('seed') && take > 1)
          ? Array.from({ length: take }, (_x, i) => (Number.isFinite(baseSeed) ? Math.round(baseSeed) : 42) + i)
          : undefined;
        setGenBusy(true);
        setGenMsg(seeds ? `正在抽 ${seeds.length} 粒…（每粒都要合成一次，慢一点）` : '正在合成…（长句要等一会儿）');
        const result = await getJson('/voice-breeze/gen', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text,
            name: String(form.name || '').trim() || undefined,
            mode: form.mode,
            seeds,
            voice: String(form.voice || '').trim() || undefined,
            instructions: String(form.instructions || '').trim() || undefined,
            ...genSamplingFromForm(form),
            style: genStyleFromForm(form),
            // VoicePanel 里没有 `sessionId` 变量（那是 dock 的），会话只从共享仓拿（`store.sessionId`）
            session: store.sessionId,
          }),
        });
        setGenBusy(false);
        if (!result.ok) {
          setGenMsg(`生成失败：${(result.data && result.data.error) || result.status || ''}`);
          return;
        }
        // 抽卡回来是一批：不自动播，让用户自己挑（点了才播）
        const picked = (result.data && result.data.items) || null;
        if (Array.isArray(picked) && picked.length > 1) {
          setGenMsg(`抽了 ${picked.length} 粒（seed ${picked.map((one) => one.seed).join(' / ')}）· 都没播 · 下面点哪条播哪条`);
          await loadGen();
          return;
        }
        const item = (result.data && result.data.item) || null;
        const play = (result.data && result.data.play) || null;
        setGenMsg(item
          ? `已生成 ${item.file}（${prettyDuration(item.durationMs) || '时长未知'}，${prettyBytes(item.bytes)}），正在播…`
          : '已生成，正在播…');
        // 生成后自动播一遍（走与播报同一个播放器，音量/停止都跟着全局）
        if (play && play.url && bus.handlers) {
          await bus.handlers.playItems([{ id: play.id, url: play.url, chars: text.length }], '');
        }
        await loadGen();
        } finally {
          submitLock.current = false;
        }
      }, [genForm, loadGen, genCaps, submitConvert]);


      const genPost = useCallback(async (payload) => {
        const result = await getJson('/voice-breeze/gen', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (result.ok) {
          setGenInfo(result.data);
          setGenMsg('');
        } else {
          setGenMsg(`操作失败：${(result.data && result.data.error) || result.status || ''}`);
        }
        return result;
      }, []);

      const playGen = useCallback(async (item) => {
        if (!item || !item.url || !bus.handlers) return;
        await bus.handlers.playItems([{ id: item.file, url: item.url, chars: item.chars }], '');
      }, []);

      /**
       * G4a（1.0.8）：**批量生成**。一行一条，最多 20 条。
       *
       * 与「生成并播放」的区别（三条都要说清，不然用户会以为是同一个按钮）：
       *  ① 每条**各自落盘**、**一条都不自动播**（N 条一起进队列会吵成一团，同抽卡的理由）；
       *  ② **不抽卡** 抽卡是"同一句 × N 个种子"，批量是"N 句 × 每个 1 次"，两件事不要叠；
       *  ③ **失败的照样往下走** 某行太长/被引擎拒了就记进 `failed`，不让它把后面的行一起废掉。
       * 截断到 20 条在客户端先做一次：顺手把"太长了"这句话在点之前就说清楚，别等宿主回 400。
       */
      const submitBatch = useCallback(async () => {
        const lines = String(genBatch || '')
          .split(/\r?\n/)
          .map((one) => one.trim())
          .filter(Boolean);
        if (!lines.length) { setGenMsg('批量要先写几行文本（一行一条）'); return; }
        if (lines.length > 20) { setGenMsg(`一次最多 20 条（现在 ${lines.length} 行）—— 分两批来吧`); return; }
        if (submitLock.current) return;
        submitLock.current = true;
        setGenBusy(true);
        setGenMsg(`正在批量生成 ${lines.length} 条…（引擎串行，一条一条来；都不自动播）`);
        try {
          const result = await getJson('/voice-breeze/gen', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              action: 'batch',
              texts: lines,
              namePrefix: String(genForm.name || '').trim() || undefined,
              mode: genForm.mode,
              voice: String(genForm.voice || '').trim() || undefined,
              instructions: String(genForm.instructions || '').trim() || undefined,
              ...genSamplingFromForm(genForm),
              style: genStyleFromForm(genForm),
              session: store.sessionId,
            }),
          });
          const data = (result.data && typeof result.data === 'object') ? result.data : {};
          if (!result || typeof result.ok !== 'boolean') {
            setGenMsg('批量失败：前端没拿到宿主回执（多半是代码 bug，请把这句发我）');
            return;
          }
          if (!result.ok) {
            setGenMsg(`批量失败：${data.error || (result.status ? `HTTP ${result.status}` : '宿主没有响应')}`);
            return;
          }
          const took = Number(data.take) || 0;
          const failed = Array.isArray(data.failed) ? data.failed : [];
          setGenMsg(failed.length
            ? `批量完成 ${took} 条，${failed.length} 条失败：${failed.map((one) => `第 ${one.index + 1} 行「${one.text}」${one.error}`).join('；')}`
            : `批量完成 ${took} 条（都没自动播，去下面列表里点着听）`);
        } finally {
          submitLock.current = false;
          setGenBusy(false);
        }
        await loadGen();
      }, [genBatch, genForm, loadGen]);

      /**
       * G4c（1.0.8）：**拖拽排序**。把 `fromFile` 挪到 `toFile` 的位置，整张顺序写给宿主。
       *
       * 为什么整张传而不是"交换两条"：顺序是 index 的数组顺序，一次给全量才没有中间态
       * （交换两次 = 两次写盘，中间崩一次就乱了）。宿主那边 `reorderEntries()` 还会去重、
       * 丢弃不存在的名字、把没提到的补齐 —— 客户端算错也只是"顺序不对"，不会丢记录。
       */
      const reorderGen = useCallback(async (fromFile, toFile) => {
        if (!fromFile || !toFile || fromFile === toFile) return;
        const files = ((genInfo && genInfo.items) || []).map((one) => one.file);
        const from = files.indexOf(fromFile);
        const to = files.indexOf(toFile);
        if (from < 0 || to < 0) return;
        const order = files.slice();
        const [moved] = order.splice(from, 1);
        order.splice(to, 0, moved);
        const result = await genPost({ action: 'reorder', order });
        if (result.ok) setGenMsg('顺序已保存（只影响这个列表，不动文件）');
      }, [genInfo, genPost]);

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

      /**
       * 2026-11-18：**渲染期兜底**。
       *
       * 面板是"一个组件画五页"，任何一页在**渲染期**抛错都会把整棵子树带走 ——
       * 表现就是「点开就消失、之后再点 🎙 也打不开」（`panelOpen` 还是 true，界面上却什么都没有）。
       * 这一段把"把五页都算出来"这件事挪进一个 `try` 里：哪一页炸了，就只有那一页的位置变成
       * 一张错误卡，标题栏与页签行照旧 —— 用户能拖、能关、能切页。
       *
       * **必须是"传函数"而不是直接算** 数组元素在回调里求值，异常才会真的落进 `catch`。
       */
      const safeParts = (build) => {
        try {
          return build();
        } catch (error) {
          const message = String((error && error.message) || error);
          // 现场留痕：界面上的错和日志里的错必须在同一个地方对得上（这个教训）
          clog(`page:render-fail tab=${tab} ${message}`);
          return [h('div', {
            key: 'render-fail',
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: 12,
              borderRadius: 8,
              border: '1px solid var(--dsw-alias-border-l2)',
              background: 'var(--dsw-alias-bg-layer-1)',
              color: 'var(--dsw-alias-label-primary)',
              fontSize: 12,
              lineHeight: 1.6,
            },
          }, [
            h('div', { key: 't', style: { fontWeight: 700 } }, `⚠ 「${tab}」这一页渲染出错`),
            h('div', {
              key: 'm',
              style: { color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
            }, message),
            h('div', {
              key: 'x',
              style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
            }, '面板还活着：切到别的页签再切回来就是干净的；这条已写进 events.log 的 client 时间线。'),
          ])];
        }
      };

      /**
       * （G2）：生成页。**控件按宿主给的 `caps` 现渲染**（`/engine` 快照里的那一段，
       * 与「引擎」页风格块同源 = `engineCaps()` 唯一真相）：
       * breeze / 普通兼容端点只出「文本 + 音色 + 文件名 + 目录」；MiniMax 才多出情绪 / 音效 / 三个数字 / 调音台。
       * 这里**不做第二份"这家支持什么"的判断**，也不按域名猜（那是引擎页的历史教训）。
       */
      const genPage = () => {
        const info = genInfo;
        const caps = genCaps || {};
        const items = (info && info.items) || [];
        const form = genForm;
        const upd = (patch) => setGenForm((prev) => ({ ...prev, ...patch }));
        const emotions = Array.isArray(caps.emotions) ? caps.emotions : [];
        const maxChars = Number(caps.maxChars) || 2000;
        /*
         * B1（0.98.0）：模式**只认宿主给的 `caps.modes`**（`engineCaps()` 那一份真相）。
         * 表单里留着一个这家不认的模式时，退回它支持的最后一个（breeze → direction、
         * minimax → clone），别把 `direction` 发给一个没有指令概念的引擎。
         */
        const modes = Array.isArray(caps.modes) && caps.modes.length ? caps.modes : ['clone'];
        // 与 `submitGen` 用**同一个**判断，避免"界面显示变声、实际提交 design"这类错位
        const mode = genModeOf(form, caps);
        const MODE_LABEL = { design: '设计声', clone: '克隆声', direction: '指挥语气', changer: '变声' };
        /*
         * 2026-11-18：变声期间把按钮按下去。
         * `/state.converting` 是宿主给的（`convertBusy > 0`）—— 引擎单并发，连续点几次会让
         * 每次请求都排队 409，而用户视觉上只看到"点了没反应"，于是继续点。
         * 这里给一个**看得见的忙态**（文案也换掉），比后台偷偷排队友好。
         */
        const converting = Boolean(shared.state && shared.state.converting);
        const busyNow = genBusy || (mode === 'changer' && converting);
        // 键集必须两个状态完全一致（坑 13），所以只改值不增删键
        const modeBtnStyle = (one) => ({
          ...U.btnTiny,
          fontWeight: mode === one ? 700 : 400,
          color: mode === one ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
        });
        const rowStyle = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' };
        const numInput = (key, placeholder, value, width) => h('input', {
          key,
          value: value === undefined || value === null ? '' : String(value),
          placeholder,
          spellCheck: false,
          inputMode: 'decimal',
          onChange: (event) => upd({ [key]: event.target.value }),
          style: { ...INPUT_STYLE, flex: `0 0 ${width || 58}px`, minWidth: 0, textAlign: 'center' },
        });
        /*
         * B2（0.99.0）：采样格子按能力现渲染（`seed` 单独一行，因为要配「抽卡」粒数）。
         *
         * **这段必须待在 `numInput` 定义之后** 它是立即执行的 IIFE，写在前面就会在渲染期
         * 撞上 `const numInput` 的暂时性死区（TDZ）—— `node --check` 查不出来，一进「生成」页
         * 就抛 `Cannot access 'numInput' before initialization`，React 随即卸掉整个面板
         * （表现：点开就消失、再点 🎙 也打不开）。见 `logs/162` / `06` 坑 41。
         */
        const sampling = Array.isArray(caps.sampling) ? caps.sampling : [];
        const sampleCells = (() => {
          const cells = [];
          const put = (key, label, width) => {
            if (!sampling.includes(key)) return;
            cells.push(numInput(key, label, form[key], width));
          };
          /*
           * 变声档是**另一套参数与默认值**（`docs/voice-conversion.md`）：
           * `temperature 0.3 / top_k 1 / cfg_scale 1.0 / seed 42`，**近乎贪心** ——
           * 官方明说开采样会让源音色漏回来，所以那四格只给这几项，placeholder 写死转换默认值。
           */
          if (mode === 'changer') {
            cells.push(numInput('temperature', '温度(0.3)', form.temperature, 78));
            cells.push(numInput('top_k', 'top_k(1)', form.top_k, 70));
            cells.push(numInput('cfg_scale', '引导(1)', form.cfg_scale, 74));
            cells.push(numInput('seed', '种子(42)', form.seed, 76));
            return cells;
          }
          // 引导强度排第一：它是"设计/指挥/克隆"三档差别最大的那一项
          if (sampling.includes('cfg_scale')) {
            const auto = mode === 'design' ? 4 : (mode === 'clone' ? 1 : 2.5);
            cells.push(numInput('cfg_scale', `引导(空=${auto})`, form.cfg_scale, 88));
          }
          put('temperature', '温度', 70);
          put('top_k', 'top_k', 62);
          put('top_p', 'top_p', 62);
          put('repetition_penalty', '重复罚', 70);
          put('max_new_tokens', '帧上限', 70);
          put('split_chars', '切分', 62);
          return cells;
        })();
        return h('div', { key: 'gen', style: { display: 'flex', flexDirection: 'column', gap: 12 } }, [
          card('genform', [
            cardHead('h', '生成一段音频'),
            modes.length > 1 ? h('div', { key: 'modes', style: rowStyle }, [
              h('span', { key: 't', style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, '模式'),
              ...modes.map((one) => h('button', {
                key: one,
                type: 'button',
                style: modeBtnStyle(one),
                onClick: () => upd({ mode: one }),
              }, MODE_LABEL[one] || one)),
            ]) : null,
            modes.length > 1 ? hint('mh', mode === 'design'
              ? '设计声：不给音色，照下面那段描述现造一把嗓子；同 seed 可复现。引导 4。'
              : (mode === 'clone'
                ? '克隆声：只换嗓子、不带指令（要语气请切「指挥语气」）。引导 1。'
                : (mode === 'changer'
                  ? '变声：拿一段已有录音换成目标音色，保留内容与节奏；KEEP MELODY 0 说话 / 1~2 唱歌。'
                  : '指挥语气：在给定音色上按指令演。引导 2.5，3 以上易刺耳。'))) : null,
            hint('d', `这一页产出的是**文件**（只出 wav）。当前引擎：${caps.kind || 'breeze'}，单次最多 ${maxChars} 字；`
              + '生成完会自动播一遍。想改全局音色/风格还是去「引擎」页，这里只影响这一次。'),
            /*
             * B3：变声的**源音频**（三入口里面板能用的两个）。
             * 第三个「工具传本机路径」只对模型开放 —— 浏览器端不该有能力让宿主读任意本机文件。
             */
            mode === 'changer' ? h('div', { key: 'src', style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
              h('div', { key: 'row', style: rowStyle }, [
                h('span', { key: 't', style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, '源音频'),
                h('select', {
                  key: 'pick',
                  value: form.srcFile ? '' : form.srcName,
                  onChange: (event) => upd({ srcName: event.target.value, srcFile: null }),
                  style: { ...INPUT_STYLE, flex: '1 1 200px', minWidth: 0 },
                }, [
                  h('option', { key: '', value: '' }, items.length ? '从下面的生成列表里挑一条' : '（生成列表还是空的）'),
                  ...items.map((one) => h('option', { key: one.file, value: one.file },
                    `${one.file}${one.durationMs ? `（${prettyDuration(one.durationMs)}）` : ''}`)),
                ]),
              ]),
              h('div', { key: 'row2', style: rowStyle }, [
                h('input', {
                  key: 'file',
                  type: 'file',
                  accept: '.wav,audio/wav',
                  onChange: (event) => {
                    const picked = (event.target.files && event.target.files[0]) || null;
                    // 上传与"列表里挑"互斥：选了文件就把列表选择清掉，免得用户以为两个都生效
                    upd({ srcFile: picked, srcName: picked ? '' : form.srcName });
                  },
                  style: { ...INPUT_STYLE, flex: '1 1 220px', paddingTop: 3, fontSize: 11 },
                }),
                form.srcFile ? h('span', { key: 'n', style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
                  `已选：${form.srcFile.name}（${prettyBytes(form.srcFile.size)}）`) : null,
              ]),
              h('span', { key: 'tip', style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
                converting
                  ? '⚠ 引擎正在处理上一段变声（单并发）—— 等它回来再点，播报这会儿也会排队。'
                  : '只收 wav。变声是**非流式**的：引擎要先编码完整个源才出声，长素材会比生成慢得多。'),
            ]) : null,
            h('textarea', {
              key: 'text',
              value: form.text,
              placeholder: mode === 'changer'
                ? '源录音的逐字稿（可选；**唱歌时强烈建议给**，不给稿容易把词听成别的）'
                : '要合成的文本（可以写停顿记号；认不认识看引擎能力）',
              spellCheck: false,
              onChange: (event) => upd({ text: event.target.value }),
              style: { ...TEXTAREA_STYLE, minHeight: 92 },
            }),
            h('div', { key: 'row1', style: rowStyle }, [
              h('input', {
                key: 'name',
                value: form.name,
                placeholder: '文件名（可空，默认取文本前 12 字）',
                spellCheck: false,
                onChange: (event) => upd({ name: event.target.value }),
                style: { ...INPUT_STYLE, flex: '1 1 160px' },
              }),
              /*
               * 2026-11-17 用户定：**该模式没有的控件直接不渲染，不置灰** —— 置灰既占地方又像坏了。
               * 设计声不需要音色（模式那行已经说明"不给音色"），所以这一格整个空出来给文件名。
               */
              mode === 'design' ? null : (genVoices.length ? h('select', {
                key: 'voice',
                value: form.voice,
                onChange: (event) => upd({ voice: event.target.value }),
                style: { ...INPUT_STYLE, flex: '1 1 180px' },
              }, [
                h('option', { key: '', value: '' }, '音色：用当前会话音色'),
                ...genVoices.map((one) => h('option', {
                  key: one.id,
                  value: one.id,
                }, one.name && one.name !== one.id ? `${one.name} · ${one.id}` : one.id)),
              ]) : h('input', {
                key: 'voice',
                value: form.voice,
                placeholder: '音色 id（这家不提供清单，可留空）',
                spellCheck: false,
                onChange: (event) => upd({ voice: event.target.value }),
                style: { ...INPUT_STYLE, flex: '1 1 180px' },
              })),
            ]),
            // 按能力现渲染：情绪（这家有情绪档才出）
            (emotions.length || caps.voiceModify) ? h('div', { key: 'caps1', style: rowStyle }, [
              emotions.length ? h('select', {
                key: 'emotion',
                value: form.emotion,
                onChange: (event) => upd({ emotion: event.target.value }),
                style: { ...INPUT_STYLE, flex: '1 1 140px' },
              }, [
                h('option', { key: '', value: '' }, '情绪：自动（用全局）'),
                ...emotions.map((one) => h('option', { key: one, value: one }, `情绪：${one}`)),
              ]) : null,
              caps.voiceModify ? h('select', {
                key: 'fx',
                value: form.soundEffects,
                onChange: (event) => upd({ soundEffects: event.target.value }),
                style: { ...INPUT_STYLE, flex: '1 1 140px' },
              }, [
                h('option', { key: '', value: '' }, '音效：无'),
                h('option', { key: 'spacious_echo', value: 'spacious_echo' }, '音效：空旷回声'),
                h('option', { key: 'auditorium_echo', value: 'auditorium_echo' }, '音效：礼堂'),
                h('option', { key: 'lofi_telephone', value: 'lofi_telephone' }, '音效：电话'),
                h('option', { key: 'robotic', value: 'robotic' }, '音效：机器人'),
              ]) : null,
            ]) : null,
            // 按能力现渲染：三个数字（只有认识 voice_setting 的引擎才出）
            caps.voiceSetting ? h('div', { key: 'caps2', style: rowStyle }, [
              numInput('speed', '语速', form.speed, 58),
              numInput('vol', '音量', form.vol, 58),
              numInput('pitch', '音调', form.pitch, 58),
              caps.voiceModify ? numInput('vmPitch', '低沉↔明亮', form.vmPitch, 86) : null,
              caps.voiceModify ? numInput('vmIntensity', '有力↔柔和', form.vmIntensity, 86) : null,
              caps.voiceModify ? numInput('vmTimbre', '厚重↔清脆', form.vmTimbre, 86) : null,
            ]) : null,
            caps.voiceSetting ? hint('sh', '语速 0.5~2 · 音量 0.01~10 · 音调 ±12 · 调音台三项 ±100（0 或留空 = 不动）') : null,
            // 混音（只在 `caps.timbreMix` 为真时出现）。规则跟「引擎」页同一套：
            // 最多 4 条、权重 1~100、**少于两条不生效**（`genStyleFromForm()` 里就按这个筛）。
            caps.timbreMix ? (() => {
              const mixes = Array.isArray(form.mixes) ? form.mixes : [];
              const setMixes = (next) => upd({ mixes: next.slice(0, 4) });
              const options = genVoices.length ? genVoices : [{ id: '', name: '（先切到引擎页拉一次清单）' }];
              return h('div', { key: 'mix', style: { display: 'flex', flexDirection: 'column', gap: 4 } }, [
                h('div', { key: 'h', style: rowStyle }, [
                  h('span', { key: 't', style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
                    `多音色混音（${mixes.length}/4，至少两条才生效）`),
                  h('button', {
                    key: 'add',
                    type: 'button',
                    disabled: mixes.length >= 4,
                    style: { ...U.btnTiny, opacity: mixes.length >= 4 ? 0.4 : 1 },
                    onClick: () => setMixes([...mixes, { voice_id: (genVoices[0] && genVoices[0].id) || '', weight: 50 }]),
                  }, '＋ 加一个'),
                ]),
                ...mixes.map((one, i) => h('div', { key: `m${i}`, style: rowStyle }, [
                  h('select', {
                    key: 'v',
                    value: one.voice_id || '',
                    style: { ...INPUT_STYLE, flex: '1 1 auto', minWidth: 0 },
                    onChange: (event) => {
                      const next = mixes.slice();
                      next[i] = { ...one, voice_id: event.target.value };
                      setMixes(next);
                    },
                  }, options.map((v) => h('option', { key: v.id || v, value: v.id || v },
                    v.name && v.name !== (v.id || v) ? `${v.name} · ${v.id}` : (v.id || v)))),
                  h('input', {
                    key: 'w',
                    value: one.weight === undefined || one.weight === null ? '' : String(one.weight),
                    placeholder: '权重',
                    spellCheck: false,
                    inputMode: 'numeric',
                    style: { ...INPUT_STYLE, flex: '0 0 62px', minWidth: 0, textAlign: 'center' },
                    onChange: (event) => {
                      const next = mixes.slice();
                      next[i] = { ...one, weight: event.target.value };
                      setMixes(next);
                    },
                  }),
                  h('button', {
                    key: 'x',
                    type: 'button',
                    style: U.btnTiny,
                    onClick: () => setMixes(mixes.filter((_x, k) => k !== i)),
                  }, '删'),
                ])),
              ]);
            })() : null,
            // B3：KEEP MELODY 只有变声档有意义（0 说话 / 1~2 唱歌）
            mode === 'changer' ? h('div', { key: 'keep', style: rowStyle }, [
              h('span', { key: 't', style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, 'KEEP MELODY'),
              h('select', {
                key: 'k',
                value: form.keep,
                onChange: (event) => upd({ keep: event.target.value }),
                style: { ...INPUT_STYLE, flex: '0 0 200px', minWidth: 0 },
              }, [
                h('option', { key: '0', value: '0' }, '0 · 说话（默认）'),
                h('option', { key: '1', value: '1' }, '1 · 唱歌：多留一点旋律'),
                h('option', { key: '2', value: '2' }, '2 · 唱歌：旋律更明显（可能不稳）'),
              ]),
              h('span', { key: 'tip', style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
                '说话请留 0；>2 会起哄'),
            ]) : null,
            // 克隆声**没有**指令这个概念（带了就变成指挥声），变声也不吃指令 —— 两档都不渲染这格
            (mode === 'clone' || mode === 'changer') ? null : h('input', {
              key: 'inst',
              value: form.instructions,
              placeholder: mode === 'design'
                ? '音色描述：身份底座 + 音质特征 + 表达风格 + 场景口音，四要素写全'
                : '语气指令：情绪 / 语速 / 气声（只有部分引擎认这一项）',
              spellCheck: false,
              onChange: (event) => upd({ instructions: event.target.value }),
              style: INPUT_STYLE,
            }),
            /*
             * B2（0.99.0）：**高级区默认展开**—— 采样参数是这台的常用旋钮，
             * 收起来等于没有。只渲染 `caps.sampling` 里有的那几格：breeze 全有，minimax/兼容端点
             * 一个都不认，这一整块直接不出现。
             */
            (sampling.includes('seed') && mode !== 'changer') ? h('div', { key: 'seedrow', style: rowStyle }, [
              h('span', { key: 't', style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, '种子'),
              numInput('seed', '随机种子', form.seed, 70),
              h('span', { key: 't2', style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, '抽卡'),
              h('select', {
                key: 'take',
                value: form.take,
                onChange: (event) => upd({ take: event.target.value }),
                style: { ...INPUT_STYLE, flex: '0 0 84px', minWidth: 0 },
              }, ['1', '2', '3', '4'].map((n) => h('option', { key: n, value: n }, `${n} 粒`))),
            ]) : null,
            // 折叠条（默认收起）：常用的是种子/抽卡，采样六项是"偶尔才动"的旋钮
            sampleCells.length ? h('button', {
              key: 'adv',
              type: 'button',
              style: { ...U.btnTiny, alignSelf: 'flex-start' },
              onClick: () => setGenAdv((v) => !v),
            }, genAdv
              ? `▾ 高级：${mode === 'changer' ? '转换参数' : '采样参数'}（收起）`
              : (mode === 'changer'
                ? `▸ 高级：转换参数（4 项，默认 0.3 / 1 / 1 / 42）`
                : `▸ 高级：采样参数（${sampleCells.length} 项，默认留空）`)) : null,
            (sampleCells.length && genAdv) ? h('div', { key: 'sample', style: rowStyle }, sampleCells) : null,
            (sampleCells.length && genAdv) ? hint('sh2', mode === 'changer'
              ? '留空 = 转换默认（温度 0.3 / top_k 1 / 引导 1 / 种子 42）。**开大采样会让源音色漏回来** ——'
                + '官方就是为此把转换的默认压到近乎贪心。'
              : '留空 = 引擎默认（种子 42；引导按模式：设计 4 / 克隆 1 / 指挥 2.5）。'
                + '温度抬一点更活、也更容易漏字；帧上限是防模型自己跑飞。') : null,
            /*
             * G4a（1.0.8）：批量。**默认收起** —— 它是偶发操作，摊开会把表单顶长一大截。
             * 用独立的 `genBatch`（不借用表单的 `text`）：批量输入不该把单条正文顶掉，
             * 反过来也一样 —— 用户常常是"先写好一句试听，满意了再批量跑同款参数"。
             */
            (mode === 'changer' ? null : h('div', { key: 'batch', style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
              h('button', {
                key: 't',
                type: 'button',
                style: { ...U.btnTiny, alignSelf: 'flex-start' },
                onClick: () => setGenBatchOpen((v) => !v),
              }, genBatchOpen ? '▾ 批量：一行一条（收起）' : '▸ 批量：一行一条，最多 20 条'),
              genBatchOpen ? h('textarea', {
                key: 'ta',
                value: genBatch,
                placeholder: '一行一条，逐条生成、各自落盘；**一条都不自动播**；失败的行会单独报出来，不影响后面的',
                spellCheck: false,
                onChange: (event) => setGenBatch(event.target.value),
                style: { ...TEXTAREA_STYLE, minHeight: 78, ...U.mono, fontSize: 11.5 },
              }) : null,
              genBatchOpen ? h('div', { key: 'row', style: rowStyle }, [
                h('button', {
                  key: 'go',
                  type: 'button',
                  style: { ...U.btnTiny, fontWeight: 700, opacity: busyNow ? 0.6 : 1 },
                  disabled: busyNow,
                  onClick: () => void submitBatch(),
                }, busyNow ? '批量进行中…' : '批量生成（不播）'),
                h('span', { key: 'n', style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
                  `${String(genBatch || '').split(/\r?\n/).filter((one) => one.trim()).length} 行 · 用上面那套模式/音色/采样参数`),
              ]) : null,
            ])),
            divider('gd1'),
            h('div', { key: 'dir', style: rowStyle }, [
              h('input', {
                key: 'd',
                value: genDir,
                placeholder: '输出目录（留空 = 插件目录下的 generated）',
                spellCheck: false,
                onChange: (event) => setGenDir(event.target.value),
                style: { ...INPUT_STYLE, flex: '1 1 240px', ...U.mono, fontSize: 11.5 },
              }),
              h('button', {
                key: 'saveDir',
                type: 'button',
                style: U.btnTiny,
                onClick: async () => {
                  const result = await genPost({ action: 'dir', dir: String(genDir || '').trim() });
                  if (result.ok) setGenMsg(`输出目录已设为 ${(result.data && result.data.dir) || ''}`);
                },
              }, '保存目录'),
              h('button', {
                key: 'open',
                type: 'button',
                style: U.btnTiny,
                onClick: () => void openFolder('generated'),
              }, '在文件夹中显示'),
            ]),
            h('div', { key: 'act', style: rowStyle }, [
              h('button', {
                key: 'go',
                type: 'button',
                style: { ...U.btn, fontWeight: 700, opacity: busyNow ? 0.6 : 1 },
                disabled: busyNow,
                onClick: () => void submitGen(),
              }, busyNow
                ? (mode === 'changer' ? '正在换声…' : '正在生成…')
                : (mode === 'changer' ? '换声并播放' : '生成并播放')),
              h('button', {
                key: 'reset',
                type: 'button',
                style: U.btnTiny,
                onClick: () => { setGenForm({ ...EMPTY_GEN_FORM }); setGenMsg(''); setGenFilledAt(''); },
              }, '清空表单'),
              /*
               * 2026-11-18：错误信息以前是个不换行的 `span`，长中文会直接溢出被面板裁掉 ——
               * 用户看到的是"换声失败："后面空着，等于没有信息。现在允许换行、可断词、占满一行，
               * 并且把全文塞进 `title`（悬停能看完整的）。
               */
              genMsg ? h('span', {
                key: 'msg',
                title: genMsg,
                style: {
                  flex: '1 1 100%',
                  minWidth: 0,
                  fontSize: 11,
                  color: 'var(--dsw-alias-label-secondary)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                },
              }, genMsg) : null,
            ]),
          ]),

          card('genlist', [
            cardHead('h', `已生成的音频（${items.length}）`, [
              h('button', {
                key: 'refresh',
                type: 'button',
                style: U.btnTiny,
                onClick: () => void loadGen(),
              }, '刷新'),
            ]),
            hint('d', info ? `输出目录：${info.dir}（重名自动加 -1/-2，不覆盖已有文件；删除会挪进插件的 gen-trash）` : '读取中…'),
            /*
             * G5（1.0.9）：垃圾桶状态 + 手动清空。
             *
             * 为什么要有这一行：删除是"挪进垃圾桶"，删得越多盘上越占地方，而用户看不到它 ——
             * 上限 128 MB 的自动淘汰是兜底，这一行是"知情权"。
             * 交互照旧：点「清理」变「确认清空?」，4 秒不点自己取消（与删除音频同一套手感）。
             */
            (info && info.trash) ? h('div', { key: 'trash', style: rowStyle }, [
              h('span', { key: 't', style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
                `垃圾桶：${info.trash.count} 个 · ${prettyBytes(info.trash.bytes)}`
                + `（上限 ${info.trash.maxBytes > 0 ? prettyBytes(info.trash.maxBytes) : '不限'}，超了自动删最旧的）`),
              genTrashDel
                ? h('button', {
                  key: 'del2',
                  type: 'button',
                  style: { ...U.btnTiny, ...U.btnDanger },
                  onClick: async () => {
                    const result = await genPost({ action: 'trash-empty' });
                    setGenTrashDel(false);
                    if (result.ok) {
                      const data = result.data || {};
                      setGenMsg(`垃圾桶已清空：${Number(data.count) || 0} 个 · 释放 ${prettyBytes(Number(data.freed) || 0)}`);
                    }
                  },
                }, '确认清空?')
                : h('button', {
                  key: 'del',
                  type: 'button',
                  style: U.btnTiny,
                  disabled: !info.trash.count,
                  onClick: () => setGenTrashDel(true),
                }, info.trash.count ? '清理' : '已空'),
              h('button', {
                key: 'open',
                type: 'button',
                style: U.btnTiny,
                onClick: () => void openFolder('gen-trash'),
              }, '打开垃圾桶'),
            ]) : null,
            items.length
              ? h('div', { key: 'list', style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                items.map((item) => h('div', {
                  key: item.file,
                  /*
                   * G4c（1.0.8）：拖一条到另一条上 = 挪到它的位置。
                   * 用原生 HTML5 拖放（零依赖，客户端不许引 npm）。
                   * **`opacity` 两个状态都在**（坑 13：键集必须一致，只改值），别在这里增删键。
                   */
                  draggable: true,
                  onDragStart: (event) => {
                    setGenDrag(item.file);
                    try {
                      event.dataTransfer.setData('text/plain', item.file);
                      event.dataTransfer.effectAllowed = 'move';
                    } catch { /* 某些环境禁 dataTransfer，退化成 genDrag */ }
                  },
                  onDragEnd: () => setGenDrag(''),
                  onDragOver: (event) => {
                    if (!genDrag || genDrag === item.file) return;
                    try { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } catch { /* ignore */ }
                  },
                  onDrop: (event) => {
                    try { event.preventDefault(); } catch { /* ignore */ }
                    let from = genDrag;
                    try { from = event.dataTransfer.getData('text/plain') || from; } catch { /* ignore */ }
                    setGenDrag('');
                    void reorderGen(from, item.file);
                  },
                  style: {
                    border: '1px solid var(--dsw-alias-border-l1)',
                    borderRadius: 8,
                    padding: '6px 8px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    opacity: genDrag === item.file ? 0.45 : 1,
                    cursor: 'grab',
                  },
                }, [
                  h('div', { key: 'r1', style: { ...rowStyle, justifyContent: 'space-between' } }, [
                    h('span', {
                      key: 'n',
                      style: {
                        fontSize: 12,
                        fontWeight: 600,
                        flex: '1 1 auto',
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      },
                      title: item.file,
                    }, item.file),
                    h('span', {
                      key: 'src',
                      style: { ...U.badge, padding: '0 7px' },
                    }, item.source === 'model' ? '模型生成' : '我生成的'),
                    h('button', {
                      key: 'play',
                      type: 'button',
                      style: U.btnTiny,
                      onClick: () => void playGen(item),
                    }, '播放'),
                    /*
                     * G4b（1.0.8）：「拿来再生成」—— 把这条记录的**整套参数**填回上面的表单。
                     *
                     * 它替代的是"只回填模型最后那一条"的旧闭环：现在任意一条都能当模板，
                     * 而且 `genFilledAt` 一起写上，免得自动回填逻辑过一会儿又把它盖掉。
                     */
                    h('button', {
                      key: 'refill',
                      type: 'button',
                      style: U.btnTiny,
                      title: '把这条用的文本/模式/音色/种子/采样参数填回上面',
                      onClick: () => {
                        setGenForm(formFromEntry(item));
                        setGenFilledAt(String(item.at || item.file || ''));
                        setGenMsg(`已把 ${item.file} 的参数填回上面，改完点「${String(item.genMode || '') === 'changer' ? '换声并播放' : '生成并播放'}」`);
                      },
                    }, '再生成'),
                    h('button', {
                      key: 'ren',
                      type: 'button',
                      style: U.btnTiny,
                      onClick: () => setGenRename({ from: item.name, to: item.name }),
                    }, '重命名'),
                    genDel === item.file
                      ? h('button', {
                        key: 'del2',
                        type: 'button',
                        style: { ...U.btnTiny, ...U.btnDanger },
                        onClick: async () => {
                          await genPost({ action: 'delete', name: item.name });
                          setGenDel('');
                        },
                      }, '确认删除?')
                      : h('button', {
                        key: 'del',
                        type: 'button',
                        style: U.btnTiny,
                        onClick: () => setGenDel(item.file),
                      }, '删除'),
                  ]),
                  h('div', { key: 'r2', style: U.hint }, [
                    prettyDuration(item.durationMs),
                    prettyBytes(item.bytes),
                    item.engineKind,
                    item.voice || '当前嗓子',
                    item.style && item.style.emotion ? `情绪=${item.style.emotion}` : '',
                    item.source === 'model' ? '模型生成' : '',
                    String(item.at || '').replace('T', ' ').replace(/\..*$/, ''),
                  ].filter(Boolean).join(' · ')),
                  genRename.from === item.name ? h('div', { key: 'r3', style: rowStyle }, [
                    h('input', {
                      key: 'to',
                      value: genRename.to,
                      spellCheck: false,
                      onChange: (event) => setGenRename({ from: item.name, to: event.target.value }),
                      style: { ...INPUT_STYLE, flex: '1 1 180px' },
                    }),
                    h('button', {
                      key: 'ok',
                      type: 'button',
                      style: U.btnTiny,
                      onClick: async () => {
                        const result = await genPost({ action: 'rename', from: item.name, to: genRename.to });
                        if (result.ok) setGenRename({ from: '', to: '' });
                      },
                    }, '确定'),
                    h('button', {
                      key: 'cancel',
                      type: 'button',
                      style: U.btnTiny,
                      onClick: () => setGenRename({ from: '', to: '' }),
                    }, '取消'),
                  ]) : null,
                ])))
              : hint('none', '还没有生成过。上面写一句、点「生成并播放」，文件就会落在输出目录里；模型生成的也会出现在这里（标「模型生成」）。'),
          ]),
        ]);
      };

      const enginePage = () => {
        const info = engInfo;
        const providers = (info && info.providers) || [];
        const isBreeze = !info || info.active === 'breeze';
        const items = (info && info.items) || [];
        const form = engForm;
        const rowStyle = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' };

        return h('div', { key: 'eng', style: { display: 'flex', flexDirection: 'column', gap: 12 } }, [
          card('cur', [
            cardHead('h', '当前引擎'),
            hint('d', info
              ? `正在用：${info.effective.label}（${info.effective.kind}）· ${info.effective.baseUrl}`
              : '读取中…'),
            info ? hint('k', info.keyBackend === 'credentials'
              ? '密钥存放在 DSH 凭据库（不会写进 state.json，也不回显）'
              : 'DSH 凭据库不可用，密钥暂存在本地 keys/ 目录') : null,
            // §4.9：没有音色清单 → 说清楚「现在用谁 / 为什么藏了 / 想换怎么办」
            (info && info.voiceMode === 'manual') ? hint('g', info.guidance, true) : null,
            info ? divider('dv1') : null,
            info ? h('div', { key: 'act', style: rowStyle }, [
              h('button', {
                key: 'try',
                type: 'button',
                style: U.btnTiny,
                disabled: engBusy,
                onClick: async () => {
                  const result = await getJson('/voice-breeze/say', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ text: '这是当前引擎的试听。听得到就说明它活着。', session: store.sessionId }),
                  });
                  setEngMsg(result.ok ? '试听已发出' : `试听失败：${result.status || ''}`);
                },
              }, '用当前引擎念一句'),
            ]) : null,
            // （P4a）：把「当前引擎怎么写」摊开给用户看 —— 模型看的是同一份（`tts_state.enginePlaybook`）。
            // 这是 E20 的缺口：数据一直在，只是没地方显示。
            (info && Array.isArray(info.playbook) && info.playbook.length) ? h('details', {
              key: 'pb',
              style: { marginTop: 2 },
            }, [
              h('summary', {
                key: 's',
                style: { cursor: 'pointer', fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' },
              }, `这个引擎怎么写才好听（${info.playbook.length} 条，点开看）`),
              h('div', { key: 'b', style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 } },
                info.playbook.map((line, i) => h('div', {
                  key: `l${i}`,
                  style: { fontSize: 11, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' },
                }, `${i + 1}. ${line}`))),
            ]) : null,
          ]),

          card('list', [
            cardHead('h', '引擎列表'),
            hint('d', '本机 BreezeTTS2 是内置的，删不掉；云端引擎可以随时加、改、切。'),
            h('div', { key: 'items', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
              // 本机那一行
              h('div', { key: 'breeze', style: { ...rowStyle, justifyContent: 'space-between' } }, [
                h('span', { key: 'n', style: { fontSize: 12 } }, `${isBreeze ? '● ' : '○ '}本机 BreezeTTS2`),
                h('button', {
                  key: 'use',
                  type: 'button',
                  disabled: engBusy || isBreeze,
                  style: { ...U.btnTiny, opacity: isBreeze ? 0.4 : 1 },
                  onClick: () => { void enginePost({ active: 'breeze' }); },
                }, isBreeze ? '在用' : '启用'),
              ]),
              divider('dv2'),
              providers.length ? providers.map((one) => h('div', {
                key: one.id,
                style: { display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 0' },
              }, [
                h('div', { key: 'top', style: { ...rowStyle, justifyContent: 'space-between' } }, [
                  h('span', { key: 'n', style: { fontSize: 12 } },
                    `${info && info.active === one.id ? '● ' : '○ '}${one.label || one.id}`),
                  h('div', { key: 'btns', style: { display: 'flex', gap: 4 } }, [
                    h('button', {
                      key: 'use',
                      type: 'button',
                      disabled: engBusy || (info && info.active === one.id),
                      style: { ...U.btnTiny, opacity: info && info.active === one.id ? 0.4 : 1 },
                      onClick: () => { void enginePost({ active: one.id }); },
                    }, info && info.active === one.id ? '在用' : '启用'),
                    h('button', {
                      key: 'edit',
                      type: 'button',
                      style: U.btnTiny,
                      onClick: () => {
                        setEngForm({
                          id: one.id,
                          label: one.label || one.id,
                          baseUrl: one.baseUrl,
                          model: one.model,
                          apiKey: '',
                          defaultVoice: one.defaultVoice || '',
                          style: JSON.parse(JSON.stringify(one.style || {})),
                          isNew: false,
                        });
                        setVoiceList(((one.items) || []).map((v) => ({ id: v, name: v })));
                      },
                    }, '编辑'),
                    h('button', {
                      key: 'del',
                      type: 'button',
                      style: { ...U.btnTiny, color: 'var(--dsw-alias-state-error-primary)' },
                      onClick: () => { void removeEngine(one.id); },
                      title: '删掉这条引擎（连它的密钥一起清掉）',
                    }, '删除'),
                  ]),
                ]),
                h('span', { key: 'meta', style: { ...U.hint, fontSize: 10.5 } },
                  `${one.baseUrl} · ${one.model} · 密钥${one.keyPresent ? '已保存' : '未填'} · 音色${one.voiceMode === 'list' ? `可列（${one.items.length}）` : '该引擎不提供'}`),
              ])) : hint('none', '还没有云端引擎，下面加一个。'),
            ]),
            engMsg ? h('div', { key: 'msg', style: { ...U.hint, color: 'var(--dsw-alias-label-primary)' } }, engMsg) : null,
          ]),

          card('form', [
            cardHead('h', form && !form.isNew ? `编辑：${form.id}` : '新建云端引擎'),
            hint('d', '选「OpenAI 兼容」类服务（OpenAI / 硅基流动 / Groq / MiniMax / 任意中转或自建网关）。baseUrl 写不写 /v1 都行。'),
            h('div', { key: 'f', style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
              h('input', {
                key: 'id',
                value: form ? form.id : '',
                placeholder: 'id（字母 / 数字 / - / _，如 cloud-a）',
                spellCheck: false,
                disabled: Boolean(form && !form.isNew),
                onChange: (event) => setEngForm({ ...(form || { isNew: true }), id: event.target.value }),
                style: INPUT_STYLE,
              }),
              h('input', {
                key: 'label',
                value: form ? form.label : '',
                placeholder: '显示名（如「某某云」）',
                spellCheck: false,
                onChange: (event) => setEngForm({ ...(form || { isNew: true }), label: event.target.value }),
                style: INPUT_STYLE,
              }),
              h('input', {
                key: 'base',
                value: form ? form.baseUrl : '',
                placeholder: 'baseUrl（如 https://api.openai.com/v1）',
                spellCheck: false,
                onChange: (event) => setEngForm({ ...(form || { isNew: true }), baseUrl: event.target.value }),
                style: INPUT_STYLE,
              }),
              // 告诉用户这条会被识别成哪种接口（MiniMax 是专用形状，别的按 OpenAI 兼容走）
              hint('kind', (() => {
                let host = '';
                try { host = new URL((form && form.baseUrl) || '').hostname.toLowerCase(); } catch { host = ''; }
                return (host.includes('minimax') || host.includes('minimaxi'))
                  ? '识别为：MiniMax 专用接口（/v1/t2a_v2，音色用 voice_id）'
                  : '识别为：OpenAI 兼容接口（/v1/audio/speech）';
              })()),
              h('input', {
                key: 'model',
                value: form ? form.model : '',
                placeholder: 'model（如 tts-1 / speech-02 / gpt-4o-mini-tts）',
                spellCheck: false,
                onChange: (event) => setEngForm({ ...(form || { isNew: true }), model: event.target.value }),
                style: INPUT_STYLE,
              }),
              h('input', {
                key: 'key',
                type: 'password',
                value: form ? form.apiKey : '',
                placeholder: form && !form.isNew ? 'apiKey（留空 = 不改）' : 'apiKey',
                spellCheck: false,
                autoComplete: 'off',
                onChange: (event) => setEngForm({ ...(form || { isNew: true }), apiKey: event.target.value }),
                style: INPUT_STYLE,
              }),
              // 音色：**输入框永远在**（手填是最后一条路，`15` §4.7 第 2 条）。
              // 不再用 `<datalist>` —— 浏览器会**按输入框当前值过滤选项**，
              // 已经填了音色时点开只剩一条。改成独立的 `<select>`，
              // 并且清单取**正在编辑的这个 provider**（原来错取了当前生效引擎的）。
              h('div', { key: 'voice', style: { display: 'flex', flexDirection: 'column', gap: 4 } }, [
                h('input', {
                  key: 'in',
                  value: form ? form.defaultVoice : '',
                  placeholder: voiceList.length
                    ? '默认音色（下面下拉里挑，也能自己打）'
                    : '默认音色（可空；点「拉取清单」看看这家有哪些）',
                  spellCheck: false,
                  onChange: (event) => setEngForm({ ...(form || { isNew: true }), defaultVoice: event.target.value }),
                  style: INPUT_STYLE,
                }),
                h('div', { key: 'pick', style: { display: 'flex', gap: 6, alignItems: 'center' } }, [
                  h('select', {
                    key: 'sel',
                    value: '',
                    disabled: !voiceList.length,
                    style: { ...INPUT_STYLE, flex: '1 1 auto', minWidth: 0 },
                    onChange: (event) => {
                      const picked = event.target.value;
                      if (!picked) return;
                      setEngForm({ ...(form || { isNew: true }), defaultVoice: picked });
                    },
                  }, [
                    h('option', { key: 'ph', value: '' },
                      voiceList.length ? `（从 ${voiceList.length} 条里选一个）` : '（还没有清单）'),
                    ...voiceList.map((v) => h('option', {
                      key: v.id,
                      value: v.id,
                    }, v.name && v.name !== v.id ? `${v.name} · ${v.id}` : v.id)),
                  ]),
                  h('button', {
                    key: 'fetch',
                    type: 'button',
                    disabled: engBusy || !form || !form.id,
                    style: { ...U.btnTiny, opacity: form && form.id ? 1 : 0.5 },
                    title: '向引擎要它的音色清单（MiniMax 有真接口，其余给预置）',
                    onClick: async () => {
                      if (!form || !form.id) { setEngMsg('先填 id（保存过一次才能拉清单）'); return; }
                      const result = await getJson(`/voice-breeze/engine/voices?id=${encodeURIComponent(form.id)}`);
                      if (result.ok && Array.isArray(result.data && result.data.items)) {
                        setVoiceList(result.data.items);
                        const remembered = Number(result.data && result.data.remembered) || 0;
                        setEngMsg(result.data.items.length
                          // 1.2.1：说清"已经记住了" —— 以前只存在这个页面的局部 state 里，
                          // 生成页的音色下拉永远是空的（用户报的就是这个）。
                          ? `拉到 ${result.data.items.length} 条音色${remembered ? `，已记住 ${remembered} 条（生成页的音色下拉会跟着更新）` : ''}`
                          : '这家没有返回音色清单');
                        // 让 `/engine` 快照跟着更新：生成页与「当前引擎」卡读的是它
                        void loadEngine();
                      } else {
                        setEngMsg(`拉清单失败：${(result.data && result.data.error) || result.status || ''}`);
                      }
                    },
                  }, '拉取清单'),
                ]),
              ]),
              // ───────── （P2）：这一家的"风格" ─────────
              // 口径：**只显示这家真认识的字段**（能力表在宿主侧，这里按 kind 粗判就够了）。
              // 留空 = 用厂商默认；数值越界由宿主 `coerceStyle()` 夹到位，这里不做二次校验。
              (() => {
                let host = '';
                try { host = new URL((form && form.baseUrl) || '').hostname.toLowerCase(); } catch { host = ''; }
                const isMinimax = host.includes('minimax') || host.includes('minimaxi');
                if (!isMinimax) return null;
                const st = (form && form.style) || {};
                const setStyle = (patch) => setEngForm({ ...(form || { isNew: true }), style: { ...st, ...patch } });
                const setVm = (patch) => setStyle({ voiceModify: { ...(st.voiceModify || {}), ...patch } });
                const numInput = (key, placeholder, value, onChange, width) => h('input', {
                  key,
                  value: value === undefined || value === null ? '' : String(value),
                  placeholder,
                  spellCheck: false,
                  inputMode: 'decimal',
                  onChange: (event) => onChange(event.target.value),
                  style: { ...INPUT_STYLE, flex: `0 0 ${width || 62}px`, minWidth: 0, textAlign: 'center' },
                });
                return h('div', { key: 'style', style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
                  hint('st', '风格（这家支持；留空 = 厂商默认）。情绪只影响这家的合成，切到别家自动不生效。'),
                  h('div', { key: 'srow1', style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } }, [
                    h('select', {
                      key: 'emotion',
                      value: st.emotion || '',
                      onChange: (event) => setStyle({ emotion: event.target.value }),
                      style: { ...INPUT_STYLE, flex: '1 1 120px', minWidth: 0 },
                    }, [
                      h('option', { key: '', value: '' }, '情绪：自动（推荐）'),
                      ...['calm', 'happy', 'sad', 'angry', 'surprised', 'fearful', 'disgusted'].map((one) => h('option', { key: one, value: one }, `情绪：${one}`)),
                    ]),
                    h('select', {
                      key: 'fx',
                      value: (st.voiceModify && st.voiceModify.soundEffects) || '',
                      onChange: (event) => setVm({ soundEffects: event.target.value }),
                      style: { ...INPUT_STYLE, flex: '1 1 120px', minWidth: 0 },
                    }, [
                      h('option', { key: '', value: '' }, '音效：无'),
                      h('option', { key: 'spacious_echo', value: 'spacious_echo' }, '音效：空旷回声'),
                      h('option', { key: 'auditorium_echo', value: 'auditorium_echo' }, '音效：礼堂'),
                      h('option', { key: 'lofi_telephone', value: 'lofi_telephone' }, '音效：电话'),
                      h('option', { key: 'robotic', value: 'robotic' }, '音效：机器人'),
                    ]),
                  ]),
                  h('div', { key: 'srow2', style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } }, [
                    numInput('speed', '语速', st.speed, (v) => setStyle({ speed: v }), 58),
                    numInput('vol', '音量', st.vol, (v) => setStyle({ vol: v }), 58),
                    numInput('pitch', '音调', st.pitch, (v) => setStyle({ pitch: v }), 58),
                    numInput('vmPitch', '低沉↔明亮', st.voiceModify && st.voiceModify.pitch, (v) => setVm({ pitch: v }), 82),
                    numInput('vmInt', '有力↔柔和', st.voiceModify && st.voiceModify.intensity, (v) => setVm({ intensity: v }), 82),
                    numInput('vmTimbre', '厚重↔清脆', st.voiceModify && st.voiceModify.timbre, (v) => setVm({ timbre: v }), 82),
                  ]),
                  hint('sh', '语速 0.5~2 · 音量 0.01~10 · 音调 ±12 · 调音台三项 ±100（0 = 不动）'),
                  // （P4a）：两个可选项 —— 返回链接模式、要词级字幕
                  h('div', { key: 'srow3', style: { display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' } }, [
                    h('label', { key: 'url', style: { display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, [
                      h('input', {
                        key: 'c',
                        type: 'checkbox',
                        checked: st.outputMode === 'url',
                        onChange: (event) => setStyle({ outputMode: event.target.checked ? 'url' : '' }),
                      }),
                      '返回链接模式（省内存，长回复更划算）',
                    ]),
                    h('label', { key: 'sub', style: { display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, [
                      h('input', {
                        key: 'c',
                        type: 'checkbox',
                        checked: st.subtitles === true,
                        onChange: (event) => setStyle({ subtitles: event.target.checked }),
                      }),
                      '要词级字幕（多下一次 JSON）',
                    ]),
                  ]),
                  // ───────── （P4a）：多音色混音 ─────────
                  // 官方规则：最多 4 个、权重 1~100，混合时 `voice_id` 留空（lib 里已处理）。
                  // 少于 2 条不生效，所以这里就按"要混就至少两条"来提示。
                  (() => {
                    const mixes = Array.isArray(st.timbreWeights) ? st.timbreWeights : [];
                    const setMixes = (next) => setStyle({ timbreWeights: next.slice(0, 4) });
                    const voiceOptions = voiceList.length
                      ? voiceList
                      : [{ id: (form && form.defaultVoice) || '', name: '（先拉一次清单）' }];
                    return h('div', { key: 'mix', style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 } }, [
                      h('div', { key: 'h', style: { display: 'flex', alignItems: 'center', gap: 6 } }, [
                        h('span', { key: 't', style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
                          `多音色混音（${mixes.length}/4，至少两条才生效）`),
                        h('button', {
                          key: 'add',
                          type: 'button',
                          disabled: mixes.length >= 4,
                          style: { ...U.btnTiny, opacity: mixes.length >= 4 ? 0.4 : 1 },
                          onClick: () => setMixes([...mixes, { voice_id: (voiceList[0] && voiceList[0].id) || '', weight: 50 }]),
                        }, '＋ 加一个'),
                      ]),
                      ...mixes.map((one, i) => h('div', { key: `m${i}`, style: { display: 'flex', gap: 6, alignItems: 'center' } }, [
                        h('select', {
                          key: 'v',
                          value: one.voice_id || '',
                          style: { ...INPUT_STYLE, flex: '1 1 auto', minWidth: 0 },
                          onChange: (event) => {
                            const next = mixes.slice();
                            next[i] = { ...one, voice_id: event.target.value };
                            setMixes(next);
                          },
                        }, voiceOptions.map((v) => h('option', { key: v.id || v, value: v.id || v },
                          v.name && v.name !== (v.id || v) ? `${v.name} · ${v.id}` : (v.id || v)))),
                        h('input', {
                          key: 'w',
                          value: one.weight === undefined ? '' : String(one.weight),
                          placeholder: '权重',
                          spellCheck: false,
                          inputMode: 'numeric',
                          style: { ...INPUT_STYLE, flex: '0 0 62px', textAlign: 'center' },
                          onChange: (event) => {
                            const next = mixes.slice();
                            next[i] = { ...one, weight: event.target.value };
                            setMixes(next);
                          },
                        }),
                        h('button', {
                          key: 'x',
                          type: 'button',
                          style: U.btnTiny,
                          onClick: () => setMixes(mixes.filter((_x, k) => k !== i)),
                        }, '删'),
                      ])),
                    ]);
                  })(),
                ]);
              })(),
              h('div', { key: 'row', style: rowStyle }, [
                h('button', {
                  key: 'save',
                  type: 'button',
                  disabled: engBusy || !form,
                  style: { ...U.btnPrimary, opacity: form ? 1 : 0.5 },
                  onClick: () => { if (form) void submitEngine(form); },
                }, '保存'),
                form ? h('button', {
                  key: 'cancel',
                  type: 'button',
                  style: U.btnTiny,
                  onClick: () => { setEngForm(null); setEngMsg(''); },
                }, '取消') : null,
                !form ? h('button', {
                  key: 'new',
                  type: 'button',
                  style: U.btnTiny,
                  onClick: () => { setEngForm({ id: '', label: '', baseUrl: '', model: 'tts-1', apiKey: '', defaultVoice: '', style: {}, isNew: true }); setVoiceList([]); },
                }, '新建一个') : null,
              ]),
            ]),
          ]),
        ]);
      };


      return h('div', {
        'data-vb-panel': '',
        'data-vb-tip-scope': '',
        style: {
          position: 'fixed',
          left: shown.x,
          top: shown.y,
          width: PANEL_W,
          // 盖住 DSH 顶栏（原来是 60，被顶栏压住 → 拖到左上角就点不到了）
          zIndex: Z_PANEL,
          // macOS 下顶栏是 `-webkit-app-region: drag`，落在拖拽区里的点击会被系统吃掉；
          // 这里显式声明本面板不是拖拽区（Windows 上无副作用）。
          WebkitAppRegion: 'no-drag',
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
        }, [['options', '选项'], ['global', '全局角色卡'], ['scenes', '场景'], ['gen', '生成'], ['engine', '引擎']].map(([id, label]) => h('button', {
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
        }, safeParts(() => [
          // ───────── 选项页 ─────────
          tab === 'options' ? h('div', { key: 'opts', style: { display: 'flex', flexDirection: 'column', gap: 12 } }, [
            /*
             * 引擎没在跑时才出现（**只有本机 breeze 才有"启动进程"这回事**）。
             * 判据用宿主给的 `engineKind` + `voiceUp`：云端引擎探活失败不该催用户去点启动。
             */
            (state.engineKind === 'breeze' && state.voiceUp === false) ? card('startengine', [
              cardHead('h', 'BreezeTTS 引擎没在运行'),
              hint('d', '播报、生成、变声都靠它。点下面的按钮启动，首次大约 10~20 秒；'
                + '这段时间里排队的句子会在起来后自动补念。'),
              h('div', { key: 'row', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
                (() => {
                  const cooling = Date.now() - engineStartedAt < 20000;
                  return h('button', {
                    key: 'go',
                    type: 'button',
                    style: { ...U.btnPrimary, opacity: cooling ? 0.6 : 1 },
                    disabled: cooling,
                    onClick: async () => {
                      if (cooling) return;
                      setEngineStartedAt(Date.now());
                      const res = await getJson('/voice-breeze/engine/start', { method: 'POST' });
                      // 失败了就把冷却清掉，让用户能立刻再点（宿主那边还有闸门 + spawn 节流）
                      if (!res.ok) setEngineStartedAt(0);
                    },
                  }, cooling ? '正在启动…' : '启动引擎');
                })(),
                h('span', { key: 'soft', style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
                  state.engineStarting ? '后台已经在拉了，起来后自动补念' : '也可以直接跟模型说话，模型念的时候会自动拉起'),
              ]),
            ]) : null,
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

            /*
             * T5：**长播报切片**的开关。
             *
             * 为什么把这个旋钮交给用户：切片能消灭"生成慢于播放"的句中垫底（引擎是串行的，
             * 整段 40 秒要等整段合成完才开口），但**每片单独合成，跨句韵律会被打断** ——
             * 听感是主观的，值不值由用户定。0 = 不切（回到整段合成）。
             * 交互照旧：改完 blur / 回车才落盘，拖动过程中不写盘。
             */
            card('chunk', [
              cardHead('h', '长播报切片', h('span', {
                key: 'v',
                style: { fontSize: 11.5, fontWeight: 700, color: 'var(--dsw-alias-label-primary)' },
              }, `${Number(shared.state && shared.state.chunkChars) || 0} 字`)),
              hint('d', '把长句切成小片：B 片在合成时 A 片已经在播，机器忙时不会在句中垫底。'
                + '代价是跨片韵律会被打断（每片重新起头），所以**默认关（0）**。'
                + '**推荐 90** 够抗卡顿，又不至于一句一顿；填 0 = 不切。'),
              h('div', { key: 'row', style: { display: 'flex', alignItems: 'center', gap: 6 } }, [
                h('input', {
                  key: 'n',
                  type: 'number',
                  min: 0,
                  max: 400,
                  step: 10,
                  value: chunkDraft === null ? (Number(shared.state && shared.state.chunkChars) || 0) : chunkDraft,
                  onChange: (event) => setChunkDraft(event.target.value),
                  onBlur: commitChunk,
                  onKeyUp: (event) => { if (event.key === 'Enter') commitChunk(); },
                  style: { ...INPUT_STYLE, flex: '0 0 92px', textAlign: 'center' },
                }),
                h('span', { key: 't', style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
                  '下一次播报就生效（不用重启）'),
              ]),
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
          tab === 'gen' ? genPage() : null,
          tab === 'engine' ? enginePage() : null,

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
        ])),
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

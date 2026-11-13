/**
 * dsh-deepseek-code-supervisor — 新会话的「反思模式」开关 + 开启提示卡片.
 *
 * The mode is a hard mode, not a per-turn toggle:
 *   - it can only be chosen BEFORE a conversation starts;
 *   - once a session has started, the mode is fixed by the host
 *     (`agent-preset/locked`), so this button is not rendered at all — that is
 *     the honest affordance, and it keeps the composer clean.
 *
 * Visibility rule: only a session that has not run a turn yet (blank) shows
 * the button. A conversation in progress shows nothing; the mode it runs is
 * named in the session header by the host's own preset label.
 *
 * State is PER SESSION: read from `byId[sessionId].projectionValues.agentPreset`
 * and written with `agentPresets.select(sessionId, …)`, so a new task can be
 * switched without touching the global default or another conversation.
 *
 * Turning it ON shows a centred, fully opaque card for 3 seconds; it removes
 * itself and never intercepts pointer events. It is attached to document.body
 * because the composer is a containing block for fixed descendants.
 *
 * Loaded by the browser module table; `id` must equal the package name.
 */
window.__ModuleLoader__.load({
  id: 'dsh-deepseek-code-supervisor',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PRESET_ID = 'self-reflection'
    const FALLBACK_ID = 'standard'

    // One couplet, rendered as a single line: the two halves are joined with the
    // punctuation they already carry, so nothing is inserted or lost.
    const VERSE = '君子博学而日参省乎己，则知明而行无过矣。'
    const BODY = '开启反思模式以后，AI 完成工作后会进行自检与二轮终检，极大提高交付代码质量，减少生产级产品的漏洞。'

    const NOTICE_MS = 3000
    const NOTICE_FADE_MS = 320
    const NOTICE_ID = 'dsh-reflect-notice'
    const STYLE_ID = 'dsh-reflect-style'

    const CSS = `
      .dsh-rf { display: inline-flex; align-items: center; position: relative; }

      .dsh-rf-btn {
        display: inline-flex; align-items: center; gap: 6px;
        height: 28px; padding: 0 10px; border-radius: 8px;
        border: 1px solid transparent; background: transparent;
        color: var(--dsw-alias-label-secondary, #5b5b63);
        font: inherit; font-size: 12px; font-weight: 500; line-height: 1;
        cursor: pointer; white-space: nowrap;
        transition: background .16s ease, border-color .16s ease, color .16s ease, box-shadow .2s ease;
      }
      .dsh-rf-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }
      .dsh-rf-btn:disabled { cursor: default; }
      .dsh-rf-btn.is-on {
        color: #6a4bff; border-color: rgba(106,75,255,.38);
        background: rgba(106,75,255,.09);
        box-shadow: 0 0 0 3px rgba(106,75,255,.08);
      }
      .dsh-rf-btn.is-error { color: #c0392b; border-color: rgba(192,57,43,.4); }
      .dsh-rf-ico {
        width: 13px; height: 13px; flex: none;
        fill: none; stroke: currentColor; stroke-width: 1.6;
        stroke-linecap: round; stroke-linejoin: round;
        opacity: .85;
      }
      .dsh-rf-btn.is-on .dsh-rf-ico { opacity: 1; }
      .dsh-rf-dot {
        width: 5px; height: 5px; border-radius: 50%; flex: none;
        background: currentColor; opacity: .35;
        transition: opacity .16s ease;
      }
      .dsh-rf-btn.is-on .dsh-rf-dot {
        opacity: 1; animation: dsh-rf-pulse 2.4s ease-in-out infinite;
      }

      /* ── 居中提示卡片（不透明） ───────────────────────────── */
      #${NOTICE_ID} {
        position: fixed; inset: 0; z-index: 2147483000;
        display: flex; align-items: center; justify-content: center;
        pointer-events: none;
        opacity: 0;
        transition: opacity ${NOTICE_FADE_MS}ms ease;
      }
      #${NOTICE_ID}.is-in { opacity: 1; }
      #${NOTICE_ID}.is-out { opacity: 0; }

      #${NOTICE_ID} .dsh-rf-card {
        position: relative;
        box-sizing: border-box;
        width: min(480px, calc(100vw - 40px));
        /* Padding shrinks before the couplet does: narrow viewports give the
           text the room it needs instead of forcing it to wrap. */
        padding: 30px clamp(16px, 7vw, 34px) 28px;
        border-radius: 18px;
        background:
          radial-gradient(120% 100% at 50% 0%, #f6f3ff 0%, #ffffff 46%),
          #ffffff;
        color: #1a1a1f;
        border: 1px solid #edeaf8;
        box-shadow:
          0 20px 52px rgba(26, 18, 62, .16),
          0 3px 10px rgba(26, 18, 62, .06);
        text-align: center;
        transform: translateY(8px) scale(.98);
        transition: transform 300ms cubic-bezier(.16, 1, .3, 1);
        overflow: hidden;
      }
      #${NOTICE_ID}.is-in .dsh-rf-card { transform: translateY(0) scale(1); }

      #${NOTICE_ID} .dsh-rf-card::before {
        content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px;
        background: linear-gradient(90deg, rgba(106,75,255,0), #6a4bff 32%, #9b86ff 50%, #6a4bff 68%, rgba(106,75,255,0));
      }

      /* 楷体加粗：文言用楷，笔画端正好认。
         两句合成一行。字号随卡片宽度缩放（clamp），保证 20 个字在卡片内宽里
         始终放得下；外加 nowrap 兜底，宁可溢出也不折成两行。 */
      #${NOTICE_ID} .dsh-rf-verse {
        margin: 2px 0 0;
        font-family: KaiTi, STKaiti, 'Kaiti SC', '楷体', 'Noto Serif CJK SC', serif;
        font-size: clamp(11.5px, 3.4vw, 17px);
        line-height: 1.75; font-weight: 700;
        color: #1e1e26;
        letter-spacing: .01em;
        white-space: nowrap;
      }

      #${NOTICE_ID} .dsh-rf-rule {
        width: 24px; height: 1.5px; margin: 14px auto 13px;
        border-radius: 1px;
        background: linear-gradient(90deg, rgba(106,75,255,.12), #6a4bff, rgba(106,75,255,.12));
      }

      /* 仿宋：正文用仿宋；16px 比按钮旁的小字大两号，在 480px 卡里一行约 24 字。 */
      #${NOTICE_ID} .dsh-rf-body {
        margin: 0;
        font-family: FangSong, STFangsong, 'FangSong_GB2312', '仿宋', 'Noto Serif CJK SC', serif;
        font-size: 16px; line-height: 1.9;
        color: #45424f;
        text-align: left;
        text-wrap: pretty;
      }

      #${NOTICE_ID} .dsh-rf-progress {
        position: absolute; left: 0; right: 0; bottom: 0; height: 2px;
        background: rgba(106, 75, 255, .10);
      }
      #${NOTICE_ID} .dsh-rf-progress-fill {
        display: block; height: 100%; width: 100%;
        background: linear-gradient(90deg, #8f77ff, #6a4bff);
        transform-origin: 0 50%;
        animation: dsh-rf-countdown ${NOTICE_MS}ms linear forwards;
      }

      @keyframes dsh-rf-countdown { from { transform: scaleX(1); } to { transform: scaleX(0); } }
      @keyframes dsh-rf-pulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(106,75,255,.5); }
        60% { box-shadow: 0 0 0 4px rgba(106,75,255,0); }
      }
      @media (prefers-reduced-motion: reduce) {
        #${NOTICE_ID}, #${NOTICE_ID} .dsh-rf-card { transition: none; }
        #${NOTICE_ID} .dsh-rf-progress-fill,
        .dsh-rf-btn.is-on .dsh-rf-dot { animation: none; }
      }
    `

    /** Mount the stylesheet once, on the first render or first notice. */
    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    let noticeTimer
    let removalTimer

    /** Show the centred notice for NOTICE_MS, then remove it. */
    function showNotice() {
      if (typeof document === 'undefined') return
      ensureStyle()
      const stale = document.getElementById(NOTICE_ID)
      if (stale !== null) stale.remove()
      clearTimeout(noticeTimer)
      clearTimeout(removalTimer)

      const host = document.createElement('div')
      host.id = NOTICE_ID
      host.setAttribute('role', 'status')
      host.setAttribute('aria-live', 'polite')

      const card = document.createElement('div')
      card.className = 'dsh-rf-card'

      const verse = document.createElement('p')
      verse.className = 'dsh-rf-verse'
      verse.textContent = VERSE

      const rule = document.createElement('div')
      rule.className = 'dsh-rf-rule'

      const body = document.createElement('p')
      body.className = 'dsh-rf-body'
      body.textContent = BODY

      const progress = document.createElement('div')
      progress.className = 'dsh-rf-progress'
      const fill = document.createElement('i')
      fill.className = 'dsh-rf-progress-fill'
      progress.appendChild(fill)

      card.append(verse, rule, body, progress)
      host.appendChild(card)
      document.body.appendChild(host)

      requestAnimationFrame(() => host.classList.add('is-in'))

      noticeTimer = setTimeout(() => {
        host.classList.remove('is-in')
        host.classList.add('is-out')
        removalTimer = setTimeout(() => host.remove(), NOTICE_FADE_MS)
      }, NOTICE_MS)
    }

    /** Set in apply(): the remote that selects a preset for one session. */
    let remoteRef

    /**
     * @param props - slot kit for a session-scope slot: `sessionId`,
     *   `useSession` and `useSessions`. There is deliberately no `session`
     *   prop; reading one silently yields undefined.
     */
    function ReflectionToggle(props) {
      const sessionId = props.sessionId
      const useSession = props.useSession
      const useSessions = props.useSessions

      const session = useSession ? useSession((snapshot) => snapshot) : undefined
      const recorded = useSessions && sessionId !== undefined
        ? useSessions((state) => {
            const summary = state && state.byId ? state.byId[sessionId] : undefined
            const value = summary && summary.projectionValues ? summary.projectionValues.agentPreset : undefined
            return typeof value === 'string' ? value : undefined
          })
        : undefined

      const [busy, setBusy] = React.useState(false)
      const [optimistic, setOptimistic] = React.useState(undefined)
      const [failure, setFailure] = React.useState(undefined)
      // A ref, not the `busy` state: two clicks inside one render frame both
      // read the same state value, so only a synchronous flag stops the second
      // call before it leaves for the host.
      const inFlight = React.useRef(false)

      React.useEffect(() => {
        ensureStyle()
      }, [])

      React.useEffect(() => {
        setOptimistic(undefined)
        setFailure(undefined)
      }, [recorded, sessionId])

      // The mode is fixed once a conversation starts: hide the control rather
      // than offer a switch the host refuses.
      const blank = session === undefined || session.blank === true
      if (sessionId === undefined || !blank) return null

      const effective = optimistic === undefined ? recorded : optimistic
      const on = effective === PRESET_ID

      const toggle = async () => {
        if (inFlight.current) return
        const next = on ? FALLBACK_ID : PRESET_ID
        inFlight.current = true
        setBusy(true)
        setFailure(undefined)
        try {
          const result = await remoteRef.agentPresets.select(sessionId, next)
          if (result && result.ok) {
            setOptimistic(next)
            if (next === PRESET_ID) showNotice()
            return
          }
          // The host answers a refused switch with `{ ok: false, error }`; the
          // one a user can actually hit is the lock, and the remedy is to start
          // a new task rather than to retry this button.
          const code = result && result.error && result.error.code
          setFailure(code === 'agent-preset/locked'
            ? '会话已开始，模式不能再切；请新建任务再选'
            : '切换失败，请重试')
        } catch (error) {
          // A missing remote or a dropped connection throws instead of
          // answering. Silence here looked identical to "nothing happened".
          setFailure('切换失败：连接不可用，请重试')
        } finally {
          inFlight.current = false
          setBusy(false)
        }
      }

      return h('span', { className: 'dsh-rf' }, [
        h('button', {
          key: 'btn',
          type: 'button',
          className: 'dsh-rf-btn' + (on ? ' is-on' : '') + (failure === undefined ? '' : ' is-error'),
          disabled: busy,
          onClick: toggle,
          title: failure === undefined
            ? (on
                ? '本会话将以反思模式开启，点击取消'
                : '让本会话以反思模式开启（开启后整个会话强制走二轮检测）')
            : failure,
          'aria-pressed': on,
          'aria-label': on ? '取消反思模式' : '开启反思模式',
        }, [
          h('svg', {
            key: 'ico',
            className: 'dsh-rf-ico',
            viewBox: '0 0 16 16',
            'aria-hidden': true,
          }, [
            h('path', { key: 'a', d: 'M3 2.6h6.2a2.4 2.4 0 0 1 2.4 2.4v8.4H5.4A2.4 2.4 0 0 1 3 11V2.6Z' }),
            h('path', { key: 'b', d: 'M11.6 5.2h1a1.4 1.4 0 0 1 0 2.8h-1' }),
            h('path', { key: 'c', d: 'M5.6 6.2h3.2M5.6 8.6h3.2' }),
          ]),
          h('span', { key: 'dot', className: 'dsh-rf-dot' }),
          h('span', { key: 'label' }, failure === undefined ? '反思模式' : failure),
        ]),
      ])
    }

    return {
      inject: ['slots', 'remote', 'remote.agentPresets'],
      apply(ctx) {
        remoteRef = ctx.remote
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'reflection-mode-switch',
          order: -10,
        }, ReflectionToggle))
      },
    }
  },
})

// ============================================================
// dsh-ledger —— Client 半端（浏览器 ModuleLoader bundle）
//
// 只做两件事：
//   1. 在「设置」里注册一个「记账本」分区；
//   2. 用 /api/dsh-ledger/* 的读数画看板（卡片 / 柱状趋势 / 逐日明细 /
//      余额校正弹窗 / CSV 导出）。
//
// 视觉沿用本项目对 DSH 设置页的既有做法：只使用主题 token，风格对齐
// dsh-cost-tracker 的花费统计页（卡片 + 面板 + 明细表）。
// ============================================================

window.__ModuleLoader__.load({
  id: 'dsh-ledger',
  factory(require) {
    const React = require('react')
    const e = React.createElement
    const { useState, useEffect } = React

    const STYLE_ID = 'dsh-ledger'
    const RANGES = [
      { value: 7, label: '近 7 天' },
      { value: 30, label: '近 30 天' },
      { value: 90, label: '近 90 天' },
      { value: 0, label: '全部' },
    ]

    function apiCall(method, args) {
      return fetch('/api/dsh-ledger/' + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(args || {}),
      }).then((r) => r.json())
    }

    // ---------- 格式化 ----------
    function fmtMoney(value) {
      const n = Number(value)
      if (!Number.isFinite(n)) return '--'
      if (n !== 0 && Math.abs(n) < 0.01) return n.toFixed(4)
      return n.toFixed(2)
    }
    // token 计费（本会话 / 上一轮）沿用花费统计的四位小数口径。
    function fmtCost(value) {
      const n = Number(value)
      return Number.isFinite(n) ? n.toFixed(4) : '--'
    }
    function timeOf(ts) {
      if (!ts) return '--'
      return new Date(Number(ts) + 8 * 3600000).toISOString().slice(11, 16)
    }
    function dateTimeOf(ts) {
      if (!ts) return '--'
      return new Date(Number(ts) + 8 * 3600000).toISOString().slice(5, 16).replace('T', ' ')
    }
    function shortDay(day) {
      return String(day || '').slice(5).replace('-', '/')
    }
    function weekdayName(day) {
      const t = Date.parse(String(day) + 'T00:00:00+08:00')
      if (!Number.isFinite(t)) return ''
      return '周' + '日一二三四五六'[new Date(t + 8 * 3600000).getUTCDay()]
    }
    function sourceLabel(source) {
      if (source === 'account') return '账号登录'
      if (source === 'apikey') return 'API Key'
      return '未观测'
    }
    function dayStatus(d) {
      if (d.needsReview) return { text: '待核对', cls: 'is-warn', title: '余额出现过上升，可在「余额校正」里补记实际到账' }
      if (d.correctedAt) return { text: '已校正', cls: 'is-ok', title: '已按实际到账做过余额校正' }
      if (d.partialDay) return { text: '部分数据', cls: 'is-muted', title: '当天没有覆盖完整 24 小时，金额只含已观测时段' }
      return { text: '已观测', cls: '', title: '由余额变化观测得出' }
    }
    function niceMax(value) {
      if (!(value > 0)) return 1
      const magnitude = Math.pow(10, Math.floor(Math.log10(value)))
      const n = value / magnitude
      const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
      return nice * magnitude
    }

    // ---------- 图标 ----------
    function ledgerIcon(size) {
      const s = size || 16
      return e('svg', {
        className: 'ledg-icon', width: s, height: s, viewBox: '0 0 24 24',
        fill: 'none', xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true',
      },
        e('rect', { x: 3, y: 3, width: 18, height: 18, rx: 5, stroke: 'currentColor', strokeWidth: 1.6 }),
        e('path', { d: 'M7.5 3v18', stroke: 'currentColor', strokeWidth: 1.6 }),
        e('path', { d: 'M11.5 8.5h6M11.5 12h4.5M11.5 15.5h3', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
        e('circle', { cx: 17.6, cy: 17.4, r: 2.4, fill: 'currentColor', opacity: 0.32 }))
    }

    // ---------- 卡片 ----------
    function MetricCard(props) {
      return e('div', { className: 'ledg-card' },
        e('div', { className: 'ledg-card-title' }, props.title),
        e('div', { className: 'ledg-card-value' + (props.tone ? ' ' + props.tone : '') }, props.value),
        props.sub ? e('div', { className: 'ledg-card-sub' }, props.sub) : null)
    }

    // ---------- 趋势图 ----------
    function TrendChart(props) {
      const days = props.days || []
      const [hover, setHover] = useState(-1)
      const max = days.reduce((acc, d) => Math.max(acc, Number(d.amount) || 0), 0)
      const top = niceMax(max * 1.05)
      const labelEvery = Math.max(1, Math.ceil(days.length / 8))
      const hasData = days.some((d) => d.observed)

      const bars = days.map((d, i) => {
        const pct = top > 0 ? Math.max(0, Math.min(100, (Number(d.amount) || 0) / top * 100)) : 0
        const st = dayStatus(d)
        const cls = ['ledg-bar']
        if (!d.observed) cls.push('is-empty')
        if (d.partialDay && d.observed) cls.push('is-partial')
        if (d.needsReview) cls.push('is-review')
        const edge = i < 2 ? ' edge-left' : i > days.length - 3 ? ' edge-right' : ''
        return e('div', {
          key: d.day,
          className: 'ledg-col',
          onMouseEnter: () => setHover(i),
          onMouseLeave: () => setHover(-1),
        },
          e('div', { className: 'ledg-bar-space' },
            e('div', { className: cls.join(' '), style: { height: d.observed ? Math.max(2, pct) + '%' : '2px' } },
              hover === i ? e('div', { className: 'ledg-tip' + edge },
                e('div', { className: 'ledg-tip-title' },
                  e('span', null, shortDay(d.day) + ' ' + weekdayName(d.day)),
                  e('span', { className: 'ledg-tip-total' }, d.observed ? '¥' + fmtMoney(d.amount) : '无观测')),
                d.observed ? e('div', { className: 'ledg-tip-row' },
                  e('span', { className: 'ledg-tip-name' }, '观测时段'),
                  e('span', null, timeOf(d.firstObservedAt) + '–' + timeOf(d.lastObservedAt))) : null,
                d.observed ? e('div', { className: 'ledg-tip-row' },
                  e('span', { className: 'ledg-tip-name' }, '状态'),
                  e('span', null, st.text)) : null,
                d.correctedAt ? e('div', { className: 'ledg-tip-row' },
                  e('span', { className: 'ledg-tip-name' }, '校正到账'),
                  e('span', null, '¥' + fmtMoney(d.credits))) : null,
                d.partialDay && d.observed ? e('div', { className: 'ledg-tip-note' }, '部分数据：只统计已观测时段') : null) : null)),
          e('div', { className: 'ledg-xlab' }, i % labelEvery === 0 ? shortDay(d.day) : '')
        )
      })

      return e('div', { className: 'ledg-chart-body' },
        e('div', { className: 'ledg-axis' },
          e('span', null, fmtMoney(top)),
          e('span', null, fmtMoney(top / 2)),
          e('span', null, '0')),
        e('div', { className: 'ledg-plot' },
          e('div', { className: 'ledg-grid' }, e('i'), e('i'), e('i')),
          e('div', { className: 'ledg-cols' }, bars)),
        !hasData ? e('div', { className: 'ledg-chart-empty' }, '这个区间还没有观测记录') : null)
    }

    // ---------- 余额校正弹窗 ----------
    function ReconcileDialog(props) {
      const row = props.row
      const [credits, setCredits] = useState('0')
      const [otherDebits, setOtherDebits] = useState('')
      const [confirmed, setConfirmed] = useState(false)
      const [err, setErr] = useState('')
      const [busy, setBusy] = useState(false)

      const opening = Number(row.openingBalance) || 0
      const current = Number(row.currentBalance) || 0
      const creditNum = Number(credits)
      const otherNum = otherDebits === '' ? 0 : Number(otherDebits)
      const valid = /^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(String(credits).trim())
        && (otherDebits === '' || /^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(String(otherDebits).trim()))
      const projected = valid ? opening + creditNum - otherNum - current : null

      function submit() {
        if (busy) return
        if (!valid) { setErr('金额须为非负数，最多保留 8 位小数'); return }
        if (!confirmed) { setErr('请先勾选确认，表示已核对本区间的全部余额调整'); return }
        setBusy(true)
        setErr('')
        apiCall('reconcile', {
          day: row.day,
          revision: row.revision,
          credits: String(credits).trim(),
          otherDebits: String(otherDebits).trim(),
          confirmed: true,
          days: props.days,
          scope: props.scope || undefined,
        }).then((v) => {
          if (!v || v.ok === false) {
            setErr((v && v.error) || '校正失败')
            return
          }
          props.onDone(v, row)
        }).catch((ex) => setErr(String((ex && ex.message) || ex))).finally(() => setBusy(false))
      }

      return e('div', { className: 'ledg-backdrop', onClick: props.onClose },
        e('div', {
          className: 'ledg-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '余额校正',
          onClick: (ev) => ev.stopPropagation(),
        },
          e('div', { className: 'ledg-modal-head' },
            e('div', null, '余额校正 · ' + row.day + ' ' + weekdayName(row.day)),
            e('button', { type: 'button', className: 'ledg-x', 'aria-label': '关闭', onClick: props.onClose }, '×')),
          e('div', { className: 'ledg-modal-body' },
            e('div', { className: 'ledg-kv' },
              e('span', { className: 'k' }, '当前已观测'),
              e('span', null, '¥' + fmtMoney(row.amount) + '（' + row.label + '）')),
            e('div', { className: 'ledg-kv' },
              e('span', { className: 'k' }, '统计起点余额'),
              e('span', null, '¥' + fmtMoney(row.openingBalance))),
            e('div', { className: 'ledg-kv' },
              e('span', { className: 'k' }, '当前余额'),
              e('span', null, '¥' + fmtMoney(row.currentBalance))),
            e('div', { className: 'ledg-kv' },
              e('span', { className: 'k' }, '观测区间'),
              e('span', null, timeOf(row.firstObservedAt) + '–' + timeOf(row.lastObservedAt) + (row.partialDay ? '（部分）' : ''))),
            row.observedIncrease > 0
              ? e('div', { className: 'ledg-kv' },
                e('span', { className: 'k' }, '余额上升'),
                e('span', null, '¥' + fmtMoney(row.observedIncrease)
                  + '（已识别到账 ¥' + fmtMoney(row.identifiedIncrease || 0) + '，不计入消费'
                  + (row.needsReview ? '；还有待核对部分' : '') + '）'))
              : null,
            e('label', { className: 'ledg-field' },
              e('span', null, '本区间累计到账金额（元）'),
              e('input', {
                className: 'ledg-input', type: 'text', inputMode: 'decimal',
                value: credits, placeholder: '未充值填 0',
                onChange: (ev) => setCredits(ev.target.value),
              }),
              e('em', null, '充值 / 赠金 / 退款等让余额上升的金额合计；余额接口不提供流水，需要你按实际到账填写。')),
            e('label', { className: 'ledg-field' },
              e('span', null, '其它扣减（元，可选）'),
              e('input', {
                className: 'ledg-input', type: 'text', inputMode: 'decimal',
                value: otherDebits, placeholder: '如：手动扣款，不需要可留空',
                onChange: (ev) => setOtherDebits(ev.target.value),
              })),
            e('div', { className: 'ledg-formula' + (projected !== null && projected < 0 ? ' is-bad' : '') },
              '校正后消费 = 起点余额 + 累计到账 − 其它扣减 − 当前余额 = ',
              projected === null ? '--' : '¥' + fmtMoney(projected)),
            projected !== null && projected < 0
              ? e('div', { className: 'ledg-err' }, '校正后消费为负，请核对统计起点与累计到账金额。')
              : null,
            e('label', { className: 'ledg-check' },
              e('input', {
                type: 'checkbox', checked: confirmed,
                onChange: (ev) => setConfirmed(ev.target.checked),
              }),
              '我已核对本统计区间的全部余额调整'),
            err ? e('div', { className: 'ledg-err' }, err) : null),
          e('div', { className: 'ledg-modal-foot' },
            e('button', { type: 'button', className: 'ledg-btn', onClick: props.onClose }, '取消'),
            e('button', {
              type: 'button',
              className: 'ledg-btn ledg-btn-primary',
              disabled: busy || !confirmed || !valid || (projected !== null && projected < 0),
              onClick: submit,
            }, busy ? '提交中…' : '提交校正')))
      )
    }

    // ---------- 输入框下方的数据栏胶囊 ----------
    // conversation.composer.dock 是聊天输入框下方那条环境信息栏（花费统计的胶囊也在这里）。
    // 这里放一个紧凑读数：今日已用 + 当前余额；点开有本月/观测状态的小浮层。
    function LedgerDock(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : ''
      const [data, setData] = useState(null)
      const [session, setSession] = useState(null)
      const [lastTurn, setLastTurn] = useState(null)
      const [err, setErr] = useState('')
      const [open, setOpen] = useState(false)
      const wrapRef = React.useRef(null)

      useEffect(() => {
        let alive = true
        const loadLedger = () => apiCall('overview', { days: 7 })
          .then((v) => {
            if (!alive) return
            if (v && v.ok !== false) { setData(v); setErr('') }
            else setErr((v && v.error) || '读取记账本失败')
          })
          .catch((ex) => { if (alive) setErr(String((ex && ex.message) || ex)) })
        // 本会话消耗来自花费统计插件（同一进程的 /api/cost-tracker/summary）。
        // 取不到就静默隐藏这一段，不影响余额记账读数。
        const loadSession = () => {
          if (!sessionId) return
          fetch('/api/cost-tracker/summary', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          })
            .then((r) => (r.ok ? r.json() : null))
            .then((v) => {
              if (!alive || !v || v.ok === false) return
              if (Number.isFinite(Number(v.sessionCost))) setSession(v)
            })
            .catch(() => {})
        }
        const load = () => { loadLedger(); loadSession() }
        load()
        const timer = setInterval(load, 30000)
        return () => { alive = false; clearInterval(timer) }
      }, [sessionId])

      // 上一轮对话：宿主在 turn/end 时切好时间窗并汇总，这里 10 秒取一次。
      useEffect(() => {
        if (!sessionId) return undefined
        let alive = true
        const load = () => fetch('/api/dsh-ledger/last-turn', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((v) => {
            if (!alive || !v || v.ok === false) return
            if (v.lastTurn && Number.isFinite(Number(v.lastTurn.cost))) setLastTurn(v.lastTurn)
            else setLastTurn(null)
          })
          .catch(() => {})
        load()
        const timer = setInterval(load, 10000)
        return () => { alive = false; clearInterval(timer) }
      }, [sessionId])

      useEffect(() => {
        if (!open) return undefined
        const onDoc = (ev) => {
          if (wrapRef.current && !wrapRef.current.contains(ev.target)) setOpen(false)
        }
        document.addEventListener('mousedown', onDoc)
        return () => document.removeEventListener('mousedown', onDoc)
      }, [open])

      const today = data ? data.todaySummary : null
      const balance = data && data.balance && data.balance.total !== null ? data.balance.total : null
      const amount = today ? today.amount : null
      const sessionCost = session ? Number(session.sessionCost) : null
      const sessionSub = session ? Number(session.sessionSub) || 0 : 0
      const sessionCalls = session ? Number(session.sessionCalls) || 0 : 0
      const lastCost = lastTurn ? Number(lastTurn.cost) : null
      const lastCalls = lastTurn ? Number(lastTurn.calls) || 0 : 0
      const needs = !!(today && today.needsReview)
      const title = data
        ? '今日已用 ¥' + fmtMoney(amount) + ' · 当前余额 ' + (balance === null ? '--' : '¥' + fmtMoney(balance))
          + (lastCost !== null ? ' · 上一轮 ¥' + fmtCost(lastCost) : '')
          + (sessionCost !== null ? ' · 本会话 ¥' + fmtCost(sessionCost) : '')
        : '记账本：还没有观测数据'

      return e('div', { className: 'ledg-dock-wrap', ref: wrapRef },
        e('button', {
          type: 'button',
          className: 'ledg-dock' + (needs ? ' is-warn' : ''),
          title,
          'aria-expanded': open,
          onClick: () => setOpen(!open),
        },
          ledgerIcon(13),
          e('span', null, '记账'),
          e('b', null, amount === null ? '--' : '¥' + fmtMoney(amount)),
          e('span', { className: 'ledg-dock-sep' }, '·'),
          e('span', null, '余额 '),
          e('b', null, balance === null ? '--' : '¥' + fmtMoney(balance)),
          lastCost !== null ? e('span', { className: 'ledg-dock-sep' }, '·') : null,
          lastCost !== null ? e('span', null, '上轮 ') : null,
          lastCost !== null ? e('b', null, '¥' + fmtCost(lastCost)) : null,
          sessionCost !== null ? e('span', { className: 'ledg-dock-sep' }, '·') : null,
          sessionCost !== null ? e('span', null, '本会话 ') : null,
          sessionCost !== null ? e('b', null, '¥' + fmtCost(sessionCost)) : null),
        open
          ? e('div', { className: 'ledg-dock-pop' },
            e('div', { className: 'ledg-dock-row' }, e('span', null, '今日已用'), e('b', null, amount === null ? '--' : '¥' + fmtMoney(amount))),
            e('div', { className: 'ledg-dock-row' }, e('span', null, '本月已用'), e('b', null, '¥' + fmtMoney(data ? data.totals.month : null))),
            e('div', { className: 'ledg-dock-row' }, e('span', null, '当前余额'), e('b', null, balance === null ? '--' : '¥' + fmtMoney(balance))),
            e('div', { className: 'ledg-dock-row' },
              e('span', null, '上一轮对话'),
              e('b', null, lastCost !== null
                ? '¥' + fmtCost(lastCost) + (lastCalls ? ' · ' + lastCalls + ' 次' : '')
                : '--（本轮结束后出现）')),
            sessionCost !== null
              ? e('div', { className: 'ledg-dock-row' },
                e('span', null, '本会话累计'),
                e('b', null, '¥' + fmtCost(sessionCost) + (sessionCalls ? ' · ' + sessionCalls + ' 次调用' : '')))
              : null,
            sessionSub > 0
              ? e('div', { className: 'ledg-dock-row' }, e('span', null, '本会话订阅等效'), e('b', null, '¥' + fmtCost(sessionSub)))
              : null,
            e('div', { className: 'ledg-dock-row' }, e('span', null, '最近观测'), e('b', null, dateTimeOf(data && data.status && data.status.lastSuccessAt))),
            e('div', { className: 'ledg-dock-note' },
              today
                ? today.label + (today.partialDay ? ' · 部分数据（从 ' + timeOf(today.observedFromMs) + ' 起）' : '')
                : '今天还没有观测到余额'),
            needs ? e('div', { className: 'ledg-dock-err' }, '余额有上升尚未核对，可在设置 → 记账本里校正。') : null,
            err ? e('div', { className: 'ledg-dock-err' }, err) : null,
            e('div', { className: 'ledg-dock-note' }, '「上轮」= 最近结束的一轮对话；「本会话」= 整段累计；「今日」= 余额观测。完整看板：设置 → 记账本'))
          : null)
    }

    // ---------- 设置分区 ----------
    function LedgerSection() {
      const [days, setDays] = useState(7)
      const [scope, setScope] = useState('')
      const [data, setData] = useState(null)
      const [err, setErr] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState(false)
      const [dialogRow, setDialogRow] = useState(null)

      function apply(v) {
        if (!v) return
        if (v.ok === false) { setErr(v.error || '读取记账本失败'); return }
        setErr('')
        setData(v)
      }

      function refreshNow() {
        if (busy) return
        setBusy(true)
        setNotice('')
        apiCall('refresh', { days, scope: scope || undefined })
          .then((v) => {
            apply(v)
            if (v && v.observe) {
              if (v.observe.ok === false) setNotice('余额观测失败：' + v.observe.error)
              else setNotice('已观测余额 · ' + dateTimeOf(v.observe.at))
            }
          })
          .catch((ex) => setErr(String((ex && ex.message) || ex)))
          .finally(() => setBusy(false))
      }

      // 首次进入主动取一次余额（避免看到上次关闭时的旧数字），
      // 之后切区间/换账本只读快照；页面开着时每分钟对齐一次后台观测。
      const mounted = React.useRef(false)
      useEffect(() => {
        let cancelled = false
        const initial = !mounted.current
        mounted.current = true
        if (initial) setBusy(true)
        apiCall(initial ? 'refresh' : 'overview', { days, scope: scope || undefined })
          .then((v) => {
            if (cancelled) return
            apply(v)
            if (initial && v && v.observe && v.observe.ok === false) setNotice('余额观测失败：' + v.observe.error)
          })
          .catch((ex) => { if (!cancelled) setErr(String((ex && ex.message) || ex)) })
          .finally(() => { if (!cancelled) setBusy(false) })
        const timer = setInterval(() => {
          apiCall('overview', { days, scope: scope || undefined })
            .then((v) => { if (!cancelled) apply(v) })
            .catch(() => {})
        }, 60000)
        return () => { cancelled = true; clearInterval(timer) }
      }, [days, scope])

      function setAutoObserve(on) {
        apiCall('settings', { autoObserve: on, days, scope: scope || undefined })
          .then(apply)
          .catch((ex) => setErr(String((ex && ex.message) || ex)))
      }

      function exportCsv() {
        apiCall('export', { days, scope: scope || undefined })
          .then((v) => {
            if (!v || v.ok === false) { setErr((v && v.error) || '导出失败'); return }
            const blob = new Blob([v.csv], { type: 'text/csv;charset=utf-8' })
            const url = URL.createObjectURL(blob)
            const link = document.createElement('a')
            link.href = url
            link.download = v.filename || 'ledger.csv'
            document.body.appendChild(link)
            link.click()
            link.remove()
            setTimeout(() => URL.revokeObjectURL(url), 2000)
            setNotice('已导出 ' + v.count + ' 天明细')
          })
          .catch((ex) => setErr(String((ex && ex.message) || ex)))
      }

      function doneReconcile(v, row) {
        apply(v)
        setDialogRow(null)
        setNotice('已校正 ' + row.day + '：' + ((v.reconciled && v.reconciled.label) || '已校正消费') + ' ¥' + fmtMoney(v.reconciled && v.reconciled.amount))
      }

      const status = data && data.status ? data.status : null
      const balance = data && data.balance ? data.balance : null
      const today = data ? data.todaySummary : null
      const observedRows = data ? data.days.filter((d) => d.observed) : []
      const tableRows = observedRows.slice().reverse().slice(0, 120)
      const rangeLabel = days > 0 ? '近 ' + days + ' 天' : '全部'

      return e('div', { className: 'ledg-wrap' },
        e('div', { className: 'ledg-h1' }, ledgerIcon(18), '记账本',
          e('span', { className: 'ledg-spacer' }),
          e('button', {
            type: 'button', className: 'ledg-btn ledg-btn-primary',
            disabled: busy, onClick: refreshNow,
          }, busy ? '正在记账…' : '立即记账')),
        e('p', { className: 'ledg-sub' },
          '按 DeepSeek 余额记录每日消费（北京时间自然日）。插件会分别观察「充值钱包」与「赠金钱包」：' +
          '任一钱包增加记为到账、总额的其余下降记为消费，所以充值后数字会继续累计，不需要手动校正；' +
          '只有钱包分量取不到、或充值与消费落在同一个钱包的同一个观测窗口时，才需要「余额校正」补一笔。' +
          '金额按 8 位小数记账，界面在需要时显示四位小数。'),

        data === null
          ? e('div', { className: 'ledg-hint', style: { padding: '24px 0' } }, '正在读取记账本…')
          : null,

        err ? e('div', { className: 'ledg-err', style: { margin: '4px 0 10px' } }, err) : null,
        notice ? e('div', { className: 'ledg-ok', style: { margin: '4px 0 10px' } }, notice) : null,

        data !== null ? e('div', { className: 'ledg-toolbar' },
          e('div', { className: 'ledg-row' },
            e('select', {
              className: 'ledg-select', 'aria-label': '统计区间', value: days,
              onChange: (ev) => setDays(Number(ev.target.value)),
            }, RANGES.map((r) => e('option', { key: r.value, value: r.value }, r.label))),
            data.books.length > 1
              ? e('select', {
                className: 'ledg-select', 'aria-label': '记账本', value: scope || data.scope || '',
                onChange: (ev) => setScope(ev.target.value),
              }, data.books.map((b) => e('option', { key: b.scope, value: b.scope },
                (b.active ? '当前本 · ' : '历史本 · ') + b.currency + ' · ' + b.dayCount + ' 天 · ' + b.scope.slice(0, 6))))
              : null,
            e('button', { type: 'button', className: 'ledg-btn', onClick: exportCsv }, '导出 CSV')),
          e('span', { className: 'ledg-spacer' }),
          status
            ? e('label', { className: 'ledg-check ledg-check-inline' },
              e('input', {
                type: 'checkbox', checked: status.autoObserve !== false,
                onChange: (ev) => setAutoObserve(ev.target.checked),
              }),
              '自动记账')
            : null) : null,

        data !== null && !data.active
          ? e('div', { className: 'ledg-banner' },
            '正在查看历史记账本（换过 API key 或账号）：不同记账本不会相加。',
            e('button', {
              type: 'button', className: 'ledg-btn', style: { marginLeft: 'auto' },
              onClick: () => setScope(data.books.filter((b) => b.active)[0] ? data.books.filter((b) => b.active)[0].scope : ''),
            }, '返回当前本'))
          : null,

        data !== null && !(data.status && data.status.walletSplit === true)
          ? e('div', { className: 'ledg-banner' },
            '当前运行的 DSH 宿主进程还没加载「钱包拆分」逻辑：重启一次 DSH 后，充值与赠金才会按钱包自动识别为到账。')
          : null,

        data !== null ? e('div', { className: 'ledg-cards' },
          e(MetricCard, {
            title: '当前余额（' + data.currency + '）',
            value: balance && balance.total !== null ? '¥' + fmtMoney(balance.total) : '--',
            sub: balance && balance.toppedUp !== null && balance.bonus !== null
              ? '充值 ¥' + fmtMoney(balance.toppedUp) + ' · 赠金 ¥' + fmtMoney(balance.bonus)
              : (data.currentBalance !== null ? '上次观测 ¥' + fmtMoney(data.currentBalance) : '还没有观测到余额'),
          }),
          e(MetricCard, {
            title: '今日已用',
            value: today ? '¥' + fmtMoney(today.amount) : '--',
            tone: today && today.needsReview ? 'is-warn' : '',
            sub: today
              ? today.label + (today.partialDay ? ' · 从 ' + timeOf(today.observedFromMs) + ' 起观测' : '')
              : '今天还没有完成首次观测',
          }),
          e(MetricCard, {
            title: '本月已用',
            value: '¥' + fmtMoney(data.totals.month),
            sub: data.today.slice(0, 7) + ' · 按余额观测',
          }),
          e(MetricCard, {
            title: rangeLabel + '已用',
            value: '¥' + fmtMoney(data.totals.amount),
            sub: '有数据 ' + data.totals.count + ' 天 · 日均 ¥' + fmtMoney(data.totals.average),
          })) : null,

        data !== null && data.books.length === 0
          ? e('div', { className: 'ledg-panel ledg-empty' },
            e('div', { className: 'ledg-panel-title' }, '账本还是空的'),
            e('ol', { className: 'ledg-steps' },
              e('li', null, '在「设置 → 模型」里配置 DeepSeek API Key，或在「账号与余额」里登录 DeepSeek 账号（API Key 优先）。'),
              e('li', null, '点上方「立即记账」取一次余额，作为今天的统计起点。'),
              e('li', null, '插件此后每分钟自动观测一次；消费 = 余额下降的累计。')),
            e('div', { className: 'ledg-hint' }, '没有可用的余额来源时，看板只显示「--」，不会编造 0。'))
          : null,

        data !== null ? e('div', { className: 'ledg-panel' },
          e('div', { className: 'ledg-panel-head' },
            e('div', { className: 'ledg-panel-title' }, '每日已用（' + data.currency + '）'),
            e('div', { className: 'ledg-legend' },
              e('span', null, e('i', { className: 'ledg-dot' }), '已观测'),
              e('span', null, e('i', { className: 'ledg-dot is-partial' }), '部分数据'),
              e('span', null, e('i', { className: 'ledg-dot is-review' }), '待核对'))),
          e(TrendChart, { days: data.days }),
          e('div', { className: 'ledg-note' },
            '「部分数据」= 当天不是从 00:00 开始观测，或（已经过去的日子）最后一次观测早于次日 00:00；' +
            '金额只覆盖已观测时段。余额上升若被识别为充值/赠金，会从消费里拆出（表格里标「到账」）。')) : null,

        data !== null ? e('div', { className: 'ledg-panel' },
          e('div', { className: 'ledg-panel-head' },
            e('div', { className: 'ledg-panel-title' }, '逐日明细'),
            e('div', { className: 'ledg-hint' }, '共 ' + observedRows.length + ' 天' + (observedRows.length > 120 ? '（显示最近 120 天）' : ''))),
          tableRows.length === 0
            ? e('div', { className: 'ledg-hint', style: { padding: '6px 0' } }, '这个区间还没有观测记录。')
            : e('div', { className: 'ledg-table-wrap' },
              e('table', { className: 'ledg-table' },
                e('thead', null, e('tr', null,
                  e('th', null, '日期'),
                  e('th', { className: 'ledg-num' }, '已用'),
                  e('th', null, '观测时段'),
                  e('th', null, '状态'),
                  e('th', { className: 'ledg-num' }, '操作'))),
                e('tbody', null, tableRows.map((row) => {
                  const st = dayStatus(row)
                  return e('tr', { key: row.day },
                    e('td', null, row.day, e('span', { className: 'ledg-weekday' }, weekdayName(row.day))),
                    e('td', { className: 'ledg-num' },
                    e('div', null, '¥' + fmtMoney(row.amount)),
                    row.identifiedIncrease > 0
                      ? e('div', { className: 'ledg-subnum' }, '到账 ¥' + fmtMoney(row.identifiedIncrease))
                      : null),
                    e('td', { className: 'ledg-time' }, timeOf(row.firstObservedAt) + '–' + timeOf(row.lastObservedAt)),
                    e('td', null, e('span', { className: 'ledg-badge ' + st.cls, title: st.title }, st.text)),
                    e('td', { className: 'ledg-num' },
                      data.active
                        ? e('button', {
                          type: 'button', className: 'ledg-link',
                          onClick: () => setDialogRow(row),
                        }, '校正')
                        : e('span', { className: 'ledg-hint' }, '历史本')))
                }))))) : null,

        data !== null ? e('div', { className: 'ledg-foot' },
          e('div', null, '最近观测：' + dateTimeOf(status && status.lastSuccessAt) +
            ' · 来源：' + sourceLabel(status && status.balanceSource) +
            ' · 自动记账每 ' + ((status && status.intervalSec) || 60) + ' 秒' +
            (status && status.autoObserve === false ? '（已关闭）' : '')),
          status && status.lastError
            ? e('div', { className: 'ledg-err' }, '最近一次记账失败：' + status.lastError)
            : null,
          e('div', { className: 'ledg-file' },
            '数据文件：' + ((status && status.dataFile) || '--'),
            e('span', { className: 'ledg-hint' }, ' · 记账本就存在本机，不会上传'))) : null,

        dialogRow ? e(ReconcileDialog, {
          row: dialogRow,
          days,
          scope,
          onClose: () => setDialogRow(null),
          onDone: doneReconcile,
        }) : null)
    }

    // ---------- 样式 ----------
    const CSS = `
.ledg-wrap { padding: 4px 2px 28px; color: var(--dsw-alias-label-primary, #171a1f); font-size: 13px; }
.ledg-h1 { font-size: 16px; font-weight: 600; margin: 2px 0 6px; display: flex; align-items: center; gap: 8px; }
.ledg-h1 .ledg-icon { flex: none; }
.ledg-sub { color: var(--dsw-alias-label-secondary, #5b6472); font-size: 12px; line-height: 1.65; margin: 0 0 12px; max-width: 760px; }
.ledg-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ledg-spacer { flex: 1 1 auto; }
.ledg-hint { color: var(--dsw-alias-label-secondary, #5b6472); font-size: 12px; }
.ledg-err { color: var(--dsw-alias-state-error-primary, #dc2626); font-size: 12px; line-height: 1.6; }
.ledg-ok { color: var(--dsw-alias-state-success-primary, #16a34a); font-size: 12px; line-height: 1.6; }
.ledg-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 10px 0 4px; }
.ledg-select { padding: 4px 8px; font-size: 12px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2, #d1d5db); background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #171a1f); }
.ledg-btn { padding: 4px 12px; font-size: 12px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2, #d1d5db); background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #171a1f); cursor: pointer; }
.ledg-btn:hover { background: var(--dsw-alias-bg-layer-2, #f3f4f6); }
.ledg-btn:disabled { opacity: .6; cursor: default; }
.ledg-btn-primary { background: var(--dsw-alias-state-business-primary, #4176e6); border-color: var(--dsw-alias-state-business-primary, #4176e6); color: #fff; }
.ledg-btn-primary:hover { background: var(--dsw-alias-state-business-primary, #4176e6); color: #fff; opacity: .9; }
.ledg-banner { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 10px 0; padding: 9px 12px; border-radius: 8px; font-size: 12px; color: var(--dsw-alias-state-warn-primary, #b45309); border: 1px solid var(--dsw-alias-state-warn-primary, #d97706); background: var(--dsw-alias-bg-layer-2, #fff8ed); }
.ledg-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin: 12px 0; }
.ledg-card { background: var(--dsw-alias-bg-layer-1, #fff); border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 10px; padding: 14px 16px; min-width: 0; }
.ledg-card-title { color: var(--dsw-alias-label-secondary, #5b6472); font-size: 12px; }
.ledg-card-value { font-size: 24px; font-weight: 650; margin-top: 6px; font-variant-numeric: tabular-nums; letter-spacing: .2px; }
.ledg-card-value.is-warn { color: var(--dsw-alias-state-warn-primary, #d97706); }
.ledg-card-sub { color: var(--dsw-alias-label-secondary, #5b6472); font-size: 12px; margin-top: 6px; line-height: 1.5; }
.ledg-panel { background: var(--dsw-alias-bg-layer-1, #fff); border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 10px; padding: 14px 16px; margin: 12px 0; }
.ledg-panel-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.ledg-panel-title { font-size: 14px; font-weight: 600; }
.ledg-panel-head .ledg-hint { margin-left: auto; }
.ledg-legend { margin-left: auto; display: flex; align-items: center; gap: 12px; font-size: 11px; color: var(--dsw-alias-label-secondary, #5b6472); }
.ledg-dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; background: var(--dsw-alias-state-business-primary, #4176e6); margin-right: 5px; }
.ledg-dot.is-partial { background: repeating-linear-gradient(45deg, var(--dsw-alias-state-business-primary, #4176e6) 0 2px, transparent 2px 4px); border: 1px solid var(--dsw-alias-state-business-primary, #4176e6); }
.ledg-dot.is-review { background: var(--dsw-alias-state-warn-primary, #d97706); }
.ledg-chart-body { position: relative; display: flex; gap: 10px; padding: 8px 0 22px; }
.ledg-axis { width: 46px; height: 168px; display: flex; flex-direction: column; justify-content: space-between; text-align: right; font-size: 10px; color: var(--dsw-alias-label-secondary, #5b6472); font-variant-numeric: tabular-nums; }
.ledg-plot { position: relative; flex: 1 1 auto; height: 168px; min-width: 0; }
.ledg-grid { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: space-between; pointer-events: none; }
.ledg-grid i { border-top: 1px dashed var(--dsw-alias-border-l1, #e5e7eb); }
.ledg-cols { position: absolute; inset: 0; display: flex; align-items: flex-end; gap: 4px; }
.ledg-col { position: relative; flex: 1 1 0; min-width: 0; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; cursor: default; }
.ledg-bar-space { position: relative; flex: 1 1 auto; display: flex; align-items: flex-end; }
.ledg-bar { position: relative; width: 100%; min-height: 2px; border-radius: 4px 4px 2px 2px; background: var(--dsw-alias-state-business-primary, #4176e6); transition: height .2s ease, opacity .15s ease; }
.ledg-bar:hover { opacity: .82; }
.ledg-bar.is-partial { background-image: repeating-linear-gradient(45deg, rgba(255,255,255,.34) 0 4px, transparent 4px 8px); }
.ledg-bar.is-review { background: var(--dsw-alias-state-warn-primary, #d97706); }
.ledg-bar.is-empty { background: var(--dsw-alias-border-l2, #d1d5db); opacity: .55; }
.ledg-xlab { position: absolute; bottom: -18px; left: 50%; transform: translateX(-50%); font-size: 10px; color: var(--dsw-alias-label-secondary, #5b6472); white-space: nowrap; }
.ledg-tip { position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%); z-index: 20; width: max-content; max-width: 240px; padding: 9px 12px; border-radius: 10px; background: var(--dsw-alias-bg-layer-1, #fff); border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); box-shadow: 0 6px 20px rgba(15, 23, 42, .12); font-size: 12px; white-space: normal; pointer-events: none; }
.ledg-tip.edge-left { left: 0; transform: none; }
.ledg-tip.edge-right { left: auto; right: 0; transform: none; }
.ledg-tip-title { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; font-weight: 600; margin-bottom: 5px; }
.ledg-tip-total { font-variant-numeric: tabular-nums; }
.ledg-tip-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 3px; color: var(--dsw-alias-label-secondary, #5b6472); font-variant-numeric: tabular-nums; }
.ledg-tip-note { margin-top: 5px; color: var(--dsw-alias-state-warn-primary, #b45309); font-size: 11px; }
.ledg-chart-empty { position: absolute; inset: 0 0 22px 56px; display: flex; align-items: center; justify-content: center; color: var(--dsw-alias-label-secondary, #5b6472); font-size: 12px; }
.ledg-note { color: var(--dsw-alias-label-secondary, #5b6472); font-size: 12px; line-height: 1.6; margin-top: 4px; }
.ledg-table-wrap { width: 100%; overflow-x: auto; }
.ledg-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.ledg-table th { text-align: left; color: var(--dsw-alias-label-secondary, #5b6472); font-weight: 500; padding: 6px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1, #e5e7eb); }
.ledg-table td { padding: 6px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1, #eef0f2); font-variant-numeric: tabular-nums; }
.ledg-table tr:last-child td { border-bottom: 0; }
.ledg-table .ledg-num { text-align: right; }
.ledg-subnum { font-size: 10px; color: var(--dsw-alias-label-secondary, #5b6472); margin-top: 1px; }
.ledg-table .ledg-time { color: var(--dsw-alias-label-secondary, #5b6472); }
.ledg-weekday { margin-left: 6px; color: var(--dsw-alias-label-secondary, #5b6472); font-size: 11px; }
.ledg-badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; border: 1px solid var(--dsw-alias-border-l2, #d1d5db); color: var(--dsw-alias-label-secondary, #5b6472); }
.ledg-badge.is-ok { color: var(--dsw-alias-state-success-primary, #16a34a); border-color: var(--dsw-alias-state-success-primary, #16a34a); }
.ledg-badge.is-warn { color: var(--dsw-alias-state-warn-primary, #b45309); border-color: var(--dsw-alias-state-warn-primary, #d97706); }
.ledg-badge.is-muted { color: var(--dsw-alias-label-secondary, #8b93a1); border-color: var(--dsw-alias-border-l1, #e5e7eb); }
.ledg-link { appearance: none; border: 0; background: none; padding: 0; font: inherit; font-size: 12px; color: var(--dsw-alias-state-business-primary, #4176e6); cursor: pointer; }
.ledg-link:hover { text-decoration: underline; }
.ledg-empty { margin-top: 0; }
.ledg-steps { margin: 8px 0 6px; padding-left: 20px; color: var(--dsw-alias-label-secondary, #5b6472); font-size: 12px; line-height: 1.9; }
.ledg-foot { margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l1, #e5e7eb); display: flex; flex-direction: column; gap: 4px; color: var(--dsw-alias-label-secondary, #5b6472); font-size: 12px; line-height: 1.6; }
.ledg-file { word-break: break-all; }
.ledg-dock-wrap { position: relative; display: inline-flex; align-items: center; max-width: 100%; }
.ledg-dock { appearance: none; display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2, #d1d5db); background: var(--dsw-alias-bg-layer-2, #f3f4f6); color: var(--dsw-alias-label-secondary, #5b6472); font: inherit; font-size: 12px; line-height: 1.5; white-space: nowrap; cursor: pointer; }
.ledg-dock:hover { background: var(--dsw-alias-bg-layer-1, #fff); }
.ledg-dock .ledg-icon { flex: none; opacity: .85; }
.ledg-dock b { color: var(--dsw-alias-label-primary, #171a1f); font-weight: 500; font-variant-numeric: tabular-nums; }
.ledg-dock-sep { opacity: .5; }
.ledg-dock.is-warn { border-color: var(--dsw-alias-state-warn-primary, #d97706); color: var(--dsw-alias-state-warn-primary, #b45309); }
.ledg-dock.is-warn b { color: var(--dsw-alias-state-warn-primary, #b45309); }
.ledg-dock-pop { position: absolute; bottom: calc(100% + 8px); right: 0; z-index: 40; width: 268px; max-width: calc(100vw - 32px); padding: 12px 14px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: 0 10px 30px rgba(15, 23, 42, .16); display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary, #5b6472); }
.ledg-dock-row { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; font-variant-numeric: tabular-nums; }
.ledg-dock-row b { color: var(--dsw-alias-label-primary, #171a1f); }
.ledg-dock-note { color: var(--dsw-alias-label-secondary, #8b93a1); font-size: 11px; line-height: 1.55; }
.ledg-dock-err { color: var(--dsw-alias-state-error-primary, #dc2626); font-size: 11px; line-height: 1.55; }
.ledg-kv { display: grid; grid-template-columns: 96px 1fr; gap: 6px 10px; font-size: 12px; margin-bottom: 8px; }
.ledg-kv .k { color: var(--dsw-alias-label-secondary, #5b6472); }
.ledg-field { display: flex; flex-direction: column; gap: 5px; margin-top: 10px; font-size: 12px; }
.ledg-field em { font-style: normal; color: var(--dsw-alias-label-secondary, #5b6472); font-size: 11px; line-height: 1.5; }
.ledg-input { padding: 5px 8px; font-size: 13px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2, #d1d5db); background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #171a1f); width: 100%; box-sizing: border-box; }
.ledg-formula { margin-top: 12px; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, #f7f8fa); color: var(--dsw-alias-label-secondary, #5b6472); font-size: 12px; line-height: 1.6; font-variant-numeric: tabular-nums; }
.ledg-formula.is-bad { color: var(--dsw-alias-state-error-primary, #dc2626); }
.ledg-check { display: flex; align-items: center; gap: 7px; margin-top: 10px; font-size: 12px; color: var(--dsw-alias-label-secondary, #5b6472); cursor: pointer; user-select: none; }
.ledg-check input { margin: 0; }
.ledg-check-inline { margin-top: 0; white-space: nowrap; }
.ledg-backdrop { position: fixed; inset: 0; z-index: 9999; display: flex; align-items: center; justify-content: center; padding: 20px; background: rgba(15, 23, 42, .34); }
.ledg-modal { width: 460px; max-width: 100%; max-height: calc(100vh - 40px); overflow: auto; border-radius: 14px; background: var(--dsw-alias-bg-layer-1, #fff); border: 1px solid var(--dsw-alias-border-l2, #d1d5db); box-shadow: 0 18px 50px rgba(15, 23, 42, .28); font-size: 13px; color: var(--dsw-alias-label-primary, #171a1f); }
.ledg-modal-head { display: flex; align-items: center; gap: 8px; padding: 14px 16px 10px; font-size: 14px; font-weight: 600; }
.ledg-modal-head > div { flex: 1 1 auto; }
.ledg-x { appearance: none; border: 0; background: none; font-size: 20px; line-height: 1; color: var(--dsw-alias-label-secondary, #5b6472); cursor: pointer; padding: 0 2px; }
.ledg-modal-body { padding: 2px 16px 12px; }
.ledg-modal-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 16px 14px; border-top: 1px solid var(--dsw-alias-border-l1, #e5e7eb); }
`

    function applyStyles(ctx) {
      if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') !== null) return
      const tag = document.createElement('style')
      tag.setAttribute('data-plugin', 'dsh-ledger')
      tag.setAttribute('data-plugin-css', STYLE_ID)
      tag.textContent = CSS
      document.head.appendChild(tag)
      ctx.effect(() => () => { tag.remove() }, 'dsh-ledger: styles')
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        applyStyles(ctx)
        const slots = ctx.get('slots')
        if (slots === undefined) return
        // 设置页完整看板。label 用函数形式（外壳会 resolveSlotLabel 调用它），
        // order 22 放在内置分区之后、花费统计之前，避免小窗口时落在导航尾部看不见。
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'ledger', order: 22, label: () => '记账本' },
          () => e(LedgerSection, {}),
        ))
        // 输入框下方的数据栏胶囊：不打开设置也能看到今日已用与余额。
        slots.inject('conversation.composer.dock', () => slots.register(
          { name: 'conversation.composer.dock', id: 'ledger', order: 2 },
          (props) => e(LedgerDock, props || {}),
        ))
      },
    }
  },
})

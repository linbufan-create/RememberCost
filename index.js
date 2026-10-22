// ============================================================
// dsh-ledger —— Host 半端
//
// 职责：
//   · 取 DeepSeek 余额（API key 优先，没有 key 时走 DSH 账号登录服务）；
//   · 把每次观测写进本地账本（accounting.mjs 的观测/校正内核）；
//   · 后台定时观测（默认 60 秒），使「今日已用」与观测缺口尽可能连续；
//   · 给设置页看板提供 /api/dsh-ledger/* 的读写接口；
//   · 注册 ledger_status / ledger_days / ledger_reconcile 三个 Agent 工具。
//
// 记账口径（与来源「小鲸鱼记账」一致）：
//   余额下降按观测累计为消费；余额上升（充值/赠金）单独记录，不会冲掉
//   已有消费；充值后该行标记「待核对余额调整」，由显式校正补上实际到账。
// ============================================================

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

import {
  ACCOUNTING_VERSION,
  beijingDay,
  ledgerOverview,
  observeBalance,
  reconcileBalance,
} from './accounting.mjs'

const VERSION = '1.1.1'

/** 观测周期：与来源的「小鲸鱼记账」相近；partialDay 的缺口阈值是 10 分钟。 */
const OBSERVE_INTERVAL_MS = 60 * 1000
const REQUEST_TIMEOUT_MS = 8000
const ACCOUNT_TIMEOUT_MS = 12000

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DATA_FILE = process.env.DSH_LEDGER_FILE || join(DSH_HOME, 'storages', 'ledger-accounting.json')
/** 花费统计的逐条调用记录（只读；上一轮对话的金额从这里按时间窗汇总）。 */
const COST_RECORDS_FILE = process.env.DSH_LEDGER_COST_FILE || join(DSH_HOME, 'storages', 'cost-tracker-records.json')
/** 上一轮对话的派生缓存，和账本放在同一目录。 */
const LAST_TURNS_FILE = process.env.DSH_LEDGER_TURNS_FILE || join(dirname(DATA_FILE), 'ledger-last-turns.json')
const BALANCE_URL = 'https://api.deepseek.com/user/balance'

function textOf(err) {
  return String((err && err.message) || err || '未知错误')
}

function sha24(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 24)
}

function numOrNull(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** Windows 杀毒/索引器会短暂占用刚写过的文件；遇到占用就短退避重试。 */
function ioRetry(operation) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation()
    } catch (err) {
      const code = err && err.code
      if (attempt >= 5 || ['EBUSY', 'EPERM', 'EACCES'].indexOf(code) < 0) throw err
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1))
    }
  }
}

function freshLedger(now = Date.now()) {
  return {
    date: beijingDay(now),
    accounting: { version: ACCOUNTING_VERSION, active: '', books: {}, migratedAt: now },
    settings: { autoObserve: true },
    meta: {},
  }
}

function normalizeLedger(parsed, now) {
  if (!parsed || typeof parsed !== 'object') return freshLedger(now)
  const acc = parsed.accounting
  const ok = acc && acc.version === ACCOUNTING_VERSION && acc.books && typeof acc.books === 'object'
  if (!ok) return freshLedger(now)
  parsed.settings = parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {}
  parsed.settings.autoObserve = parsed.settings.autoObserve !== false
  parsed.meta = parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {}
  return parsed
}

function timeoutAfter(ms, value) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(value), ms)
    if (timer && typeof timer.unref === 'function') timer.unref()
  })
}

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** 官方余额接口可能返回多币种：优先取「有余额的 CNY」，与来源一致。 */
function pickBalanceInfo(infos) {
  if (!Array.isArray(infos) || infos.length === 0) return null
  const total = (x) => (x && x.total_balance !== undefined ? Number(x.total_balance) : NaN)
  return infos.find((x) => x && x.currency === 'CNY' && total(x) > 0)
    || infos.find((x) => total(x) > 0)
    || infos.find((x) => x && x.currency === 'CNY')
    || infos[0]
}

export const inject = ['tools', 'webServer']

export function apply(ctx) {
  // ---------- 账本持久化 ----------
  let ledger = null

  function backupCorrupt(why) {
    try {
      const bak = DATA_FILE + '.corrupt-' + Date.now() + '.bak'
      ioRetry(() => renameSync(DATA_FILE, bak))
      console.error('[dsh-ledger] 账本损坏（' + why + '）→ 已备份为 ' + bak + '，并用空账本重建（原文件未删除）')
    } catch (err) {
      console.error('[dsh-ledger] 账本损坏（' + why + '）且备份失败：' + textOf(err))
    }
  }

  function loadLedger() {
    if (ledger) return ledger
    let raw = null
    try {
      raw = ioRetry(() => readFileSync(DATA_FILE, 'utf8'))
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        backupCorrupt((err && err.code) || 'read-error')
        ledger = freshLedger()
        return ledger
      }
    }
    if (raw == null) {
      ledger = freshLedger()
      return ledger
    }
    try {
      ledger = normalizeLedger(JSON.parse(raw), Date.now())
    } catch (err) {
      backupCorrupt('bad-json')
      ledger = freshLedger()
    }
    return ledger
  }

  function saveLedger() {
    if (!ledger) return false
    const body = JSON.stringify(ledger)
    const temp = DATA_FILE + '.tmp-' + process.pid
    try {
      ioRetry(() => mkdirSync(dirname(DATA_FILE), { recursive: true }))
      ioRetry(() => writeFileSync(temp, body, 'utf8'))
      ioRetry(() => renameSync(temp, DATA_FILE))
      return true
    } catch (err) {
      try { if (existsSync(temp)) ioRetry(() => unlinkSync(temp)) } catch (cleanupErr) { /* ignore */ }
      console.error('[dsh-ledger] 账本保存失败：' + textOf(err))
      return false
    }
  }

  // ---------- 上一轮对话消耗 ----------
  // 花费统计（dsh-cost-tracker）按每次调用落盘，但 summary 只有「本会话累计」，
  // 没有轮次。这里监听 DSH 的 turn/start / turn/end，把该轮时间窗内的调用费用
  // 汇总成「上一轮对话」；读不到记录时静默跳过，不影响余额记账。
  let lastTurns = {}
  const turnStarts = new Map()

  function loadLastTurns() {
    try {
      if (!existsSync(LAST_TURNS_FILE)) return
      const parsed = JSON.parse(ioRetry(() => readFileSync(LAST_TURNS_FILE, 'utf8')))
      if (!parsed || typeof parsed !== 'object') return
      for (const sid of Object.keys(parsed)) {
        const v = parsed[sid]
        if (!v || !Number.isFinite(Number(v.cost))) continue
        lastTurns[sid] = {
          cost: Number(v.cost),
          calls: Number(v.calls) || 0,
          at: Number(v.at) || 0,
          startAt: Number(v.startAt) || 0,
          turn: Number(v.turn) || 0,
        }
      }
    } catch (err) {
      // 派生缓存损坏不影响主账本，直接忽略。
    }
  }

  function saveLastTurns() {
    const entries = Object.entries(lastTurns).sort((a, b) => (Number(b[1].at) || 0) - (Number(a[1].at) || 0))
    if (entries.length > 200) lastTurns = Object.fromEntries(entries.slice(0, 200))
    const temp = LAST_TURNS_FILE + '.tmp-' + process.pid
    try {
      ioRetry(() => mkdirSync(dirname(LAST_TURNS_FILE), { recursive: true }))
      ioRetry(() => writeFileSync(temp, JSON.stringify(lastTurns), 'utf8'))
      ioRetry(() => renameSync(temp, LAST_TURNS_FILE))
    } catch (err) {
      try { if (existsSync(temp)) ioRetry(() => unlinkSync(temp)) } catch (cleanupErr) { /* ignore */ }
      console.error('[dsh-ledger] 上一轮记录保存失败：' + textOf(err))
    }
  }

  function readCostRecords() {
    try {
      const parsed = JSON.parse(ioRetry(() => readFileSync(COST_RECORDS_FILE, 'utf8')))
      return Array.isArray(parsed && parsed.details) ? parsed.details : null
    } catch (err) {
      return null
    }
  }

  function computeTurnCost(sessionId, startAt, endAt) {
    const records = readCostRecords()
    if (!records) return null
    let units = 0
    let calls = 0
    for (const record of records) {
      if (!record || String(record.sessionId || '') !== sessionId) continue
      const ts = Number(record.ts)
      if (!Number.isFinite(ts) || ts < startAt || ts > endAt) continue
      // 会话标题生成是后台开销，不算进「这一轮对话」。
      if (record.purpose === 'session-title') continue
      const cost = Number(record.cost)
      if (!Number.isFinite(cost) || cost <= 0) continue
      units += Math.round(cost * 1e8)
      calls += 1
    }
    if (!calls) return null
    return { cost: units / 1e8, calls, at: endAt, startAt }
  }

  /**
   * 插件可能是在某一轮进行到一半时才加载的（更新后重载、宿主重启等）。
   * 这时 turnStarts 里没有起点，就从会话日志里回找同一 turn 的 turn/start 时间。
   */
  function turnStartFromSession(session, turn) {
    try {
      const events = session && typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const ev = events[i]
        if (!ev || ev.type !== 'turn/start') continue
        const evTurn = Number(ev.data && ev.data.turn)
        if (Number.isFinite(turn) && Number.isFinite(evTurn) && evTurn !== turn) continue
        const time = Number(ev.time)
        if (Number.isFinite(time)) return time
      }
    } catch (err) {
      // 会话对象形状变化时静默放弃，不影响会话本身。
    }
    return 0
  }

  loadLastTurns()

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    try {
      const sid = session && session.id ? String(session.id) : ''
      if (!sid || !event || !event.type) return
      if (event.type === 'turn/start') {
        turnStarts.set(sid, Date.now())
        return
      }
      if (event.type !== 'turn/end') return
      const turnNo = Number(event.data && event.data.turn)
      let startAt = turnStarts.get(sid)
      turnStarts.delete(sid)
      if (!startAt) startAt = turnStartFromSession(session, turnNo)
      if (!startAt) return
      const result = computeTurnCost(sid, startAt, Date.now())
      if (!result) return
      lastTurns[sid] = { ...result, turn: Number.isFinite(turnNo) ? turnNo : 0 }
      saveLastTurns()
    } catch (err) {
      // 观察者失败不能影响会话日志追加。
    }
  }), 'dsh-ledger: turn cost tracking')

  // ---------- 余额来源 ----------
  /**
   * API key 路：官方 /user/balance。key 只从 DSH 凭据服务读，本插件不落明文。
   */
  async function tryKeyBalance() {
    let credentials = null
    try { credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : null } catch (err) { credentials = null }
    if (!credentials || typeof credentials.resolve !== 'function') {
      return { ok: false, code: 'NO_CRED', error: '凭据服务不可用' }
    }
    let credential = null
    try {
      credential = await credentials.resolve('DEEPSEEK_API_KEY')
    } catch (err) {
      return { ok: false, code: 'KEY_READ', error: '读取 DeepSeek API Key 失败：' + textOf(err) }
    }
    if (!credential || !credential.value) {
      return { ok: false, code: 'NO_KEY', error: '未配置 DeepSeek API Key' }
    }

    let lastErr = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let res
      try {
        res = await fetchWithTimeout(BALANCE_URL, {
          headers: { Authorization: 'Bearer ' + credential.value },
        }, REQUEST_TIMEOUT_MS)
      } catch (err) {
        lastErr = err
        if (attempt === 0) await timeoutAfter(500)
        continue
      }
      if (!res.ok) {
        lastErr = new Error('HTTP ' + res.status)
        if (res.status < 500) break
        if (attempt === 0) await timeoutAfter(500)
        continue
      }
      let data
      try {
        data = await res.json()
      } catch (err) {
        return { ok: false, code: 'PARSE', error: '余额接口返回不是合法 JSON' }
      }
      const info = pickBalanceInfo(data && data.balance_infos)
      if (!info || numOrNull(info.total_balance) === null) {
        return { ok: false, code: 'SHAPE', error: '余额接口返回结构异常' }
      }
      return {
        ok: true,
        total: Number(info.total_balance),
        toppedUp: numOrNull(info.topped_up_balance),
        bonus: numOrNull(info.granted_balance),
        currency: String(info.currency || 'CNY').toUpperCase(),
        source: 'apikey',
        scope: sha24(credential.value),
      }
    }
    const transient = !(lastErr && /^HTTP 4\d\d/.test(textOf(lastErr)))
    return {
      ok: false,
      code: 'HTTP',
      transient,
      error: '余额接口请求失败：' + textOf(lastErr).slice(0, 200),
    }
  }

  /**
   * 账号登录路：只通过 DSH 自己的 deepseekAccount 服务取余额。
   * 该服务也许是可选的（老宿主没有），所以绝不能写进 inject。
   */
  async function tryAccountBalance(keyErr) {
    let account = null
    try { account = typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : null } catch (err) { account = null }
    if (!account || typeof account.getBalance !== 'function') {
      const prefix = keyErr && keyErr.error ? keyErr.error + '；' : ''
      return { ok: false, code: 'NO_ACCOUNT', error: prefix + '当前 DSH 没有账号余额服务' }
    }

    let accountId = null
    try {
      const state = typeof account.getState === 'function'
        ? await Promise.race([account.getState(), timeoutAfter(3000, null)])
        : null
      accountId = (state && (state.userId || (state.profile && state.profile.userId))) || null
    } catch (err) {
      accountId = null
    }

    let locale = 'zh-CN'
    try { locale = String(Intl.DateTimeFormat().resolvedOptions().locale || 'zh-CN') } catch (err) { locale = 'zh-CN' }

    let result = null
    try {
      result = await Promise.race([
        account.getBalance({
          version: VERSION,
          locale,
          timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
        }),
        timeoutAfter(ACCOUNT_TIMEOUT_MS, null),
      ])
    } catch (err) {
      return { ok: false, code: 'ACCOUNT', error: '账号余额接口调用失败：' + textOf(err).slice(0, 160) }
    }

    if (!result) {
      return { ok: false, code: 'NO_ACCOUNT', error: '账号余额请求超时或未登录 DeepSeek 账号' }
    }
    if (result.status !== 'ready') {
      return { ok: false, code: 'ACCOUNT', error: '账号余额接口未就绪（' + String(result.status || 'unknown') + '）' }
    }

    const curOf = (w) => String((w && w.currency) || 'CNY').toUpperCase()
    const usable = (list) => (Array.isArray(list) ? list : []).filter((w) => w && numOrNull(w.balance) !== null)
    const rechargeWallets = usable(result.value)
    const bonusWallets = usable(result.bonusWallets)
    const allWallets = rechargeWallets.concat(bonusWallets)
    if (allWallets.length === 0) {
      return { ok: false, code: 'ACCOUNT', error: '账号没有可用的余额钱包' }
    }
    const nonZero = allWallets.filter((w) => Number(w.balance) > 0)
    const picked = nonZero.find((w) => curOf(w) === 'CNY')
      || nonZero[0]
      || allWallets.find((w) => curOf(w) === 'CNY')
      || allWallets[0]
    const currency = curOf(picked)
    const sumOf = (list) => list
      .filter((w) => curOf(w) === currency && numOrNull(w.balance) !== null)
      .reduce((acc, w) => acc + Number(w.balance), 0)
    const toppedUp = sumOf(rechargeWallets)
    const bonus = sumOf(bonusWallets)

    return {
      ok: true,
      total: Number((toppedUp + bonus).toFixed(6)),
      toppedUp: Number(toppedUp.toFixed(6)),
      bonus: Number(bonus.toFixed(6)),
      currency,
      source: 'account',
      scope: sha24('dsh-account:' + (accountId === null ? 'default' : String(accountId))),
    }
  }

  /** API key 永远第一优先；key 路任何失败都再试账号路（与来源 v781 一致）。 */
  async function fetchBalance() {
    const keyResult = await tryKeyBalance()
    if (keyResult.ok) return keyResult
    return tryAccountBalance(keyResult)
  }

  // ---------- 观测 ----------
  let inflight = null

  function observeNow() {
    if (inflight) return inflight
    inflight = (async () => {
      const at = Date.now()
      const led = loadLedger()
      led.meta.lastAttemptAt = at
      try {
        const balance = await fetchBalance()
        const summary = observeBalance(led, {
          balance: balance.total,
          // 两个钱包分量：用来把同一观测窗口里的「充值」和「消费」拆开。
          toppedUp: balance.toppedUp,
          bonus: balance.bonus,
          currency: balance.currency,
          scope: balance.scope,
          at,
        })
        led.meta.lastSuccessAt = at
        led.meta.lastError = ''
        led.meta.lastSource = balance.source
        led.meta.lastCurrency = balance.currency
        led.meta.lastTotalBalance = balance.total
        led.meta.lastTopUp = balance.toppedUp
        led.meta.lastBonus = balance.bonus
        saveLedger()
        return { ok: true, at, summary }
      } catch (err) {
        const message = textOf(err).slice(0, 240)
        if (led.meta.lastError !== message) {
          led.meta.lastError = message
          saveLedger()
        }
        return { ok: false, at, error: message }
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  // ---------- 看板数据 ----------
  function buildOverview(args = {}) {
    const led = loadLedger()
    const data = ledgerOverview(led, { days: args.days, scope: args.scope, now: Date.now() })
    const meta = led.meta || {}
    const balanceTotal = numOrNull(meta.lastTotalBalance)
    // 看历史记账本时，余额卡必须跟着那本账走；live 余额只属于当前账本。
    const live = data.active
    return {
      ok: true,
      ...data,
      balance: {
        total: live && balanceTotal !== null ? balanceTotal : data.currentBalance,
        currency: data.currency,
        toppedUp: live ? numOrNull(meta.lastTopUp) : null,
        bonus: live ? numOrNull(meta.lastBonus) : null,
        source: live ? String(meta.lastSource || '') : '',
        at: live ? (meta.lastSuccessAt || data.lastObservedAt) : data.lastObservedAt,
        stale: live && !!meta.lastError,
      },
      status: {
        autoObserve: !(led.settings && led.settings.autoObserve === false),
        intervalSec: Math.round(OBSERVE_INTERVAL_MS / 1000),
        lastAttemptAt: meta.lastAttemptAt || null,
        lastSuccessAt: meta.lastSuccessAt || null,
        lastError: String(meta.lastError || ''),
        balanceSource: String(meta.lastSource || ''),
        dataFile: DATA_FILE,
        version: VERSION,
        // 宿主能力标记：客户端据此判断钱包拆分是否已经随宿主加载。
        walletSplit: true,
      },
    }
  }

  function csvCell(value) {
    const text = String(value == null ? '' : value)
    return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text
  }

  function buildCsv(args = {}) {
    const data = ledgerOverview(loadLedger(), { days: args.days, scope: args.scope, now: Date.now() })
    const rows = data.days.filter((d) => d.observed)
    const lines = ['日期,消费(' + data.currency + '),币种,状态,首次观测,末次观测,起点余额,期末余额,部分数据']
    for (const row of rows) {
      const time = (ts) => (ts ? new Date(ts + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') : '')
      lines.push([
        row.day,
        row.amount.toFixed(8),
        row.currency,
        row.label || '',
        time(row.firstObservedAt),
        time(row.lastObservedAt),
        Number(row.openingBalance).toFixed(8),
        Number(row.currentBalance).toFixed(8),
        row.partialDay ? '是' : '否',
      ].map(csvCell).join(','))
    }
    return {
      ok: true,
      filename: 'ledger-' + data.from + '_' + data.to + '.csv',
      csv: '\uFEFF' + lines.join('\r\n') + '\r\n',
      count: rows.length,
    }
  }

  // ---------- HTTP 路由 ----------
  function reconcile(args = {}) {
    const led = loadLedger()
    const day = String(args.day || '')
    const data = ledgerOverview(led, { days: 0, now: Date.now() })
    const row = data.days.filter((d) => d.observed && d.day === day)[0]
    if (!row) return { ok: false, status: 404, error: '这一天没有余额观测记录，无法校正' }
    try {
      const summary = reconcileBalance(led, {
        day,
        // 看板会带它最近一次读到的 revision（乐观锁）；缺省才用当前行。
        revision: typeof args.revision === 'string' && args.revision ? args.revision : row.revision,
        action: args.action === 'reset' ? 'reset' : 'correct',
        credits: args.credits,
        otherDebits: args.otherDebits,
        confirmed: args.confirmed === true,
      }, Date.now())
      saveLedger()
      return { ok: true, reconciled: summary }
    } catch (err) {
      return { ok: false, status: err && err.status ? err.status : 400, error: textOf(err) }
    }
  }

  const routes = {
    overview: async (args) => buildOverview(args),
    refresh: async (args) => {
      const observed = await observeNow()
      const data = buildOverview(args)
      data.observe = { ok: !!observed.ok, error: observed.ok ? '' : observed.error, at: observed.at }
      return data
    },
    reconcile: async (args) => {
      const result = reconcile(args)
      if (!result.ok) return result
      return { ...buildOverview({ days: args.days, scope: args.scope }), reconciled: result.reconciled }
    },
    export: async (args) => buildCsv(args),
    'last-turn': async (args) => {
      const sid = String((args && args.sessionId) || '')
      if (!sid) return { ok: false, error: '缺少 sessionId' }
      return { ok: true, sessionId: sid, lastTurn: lastTurns[sid] || null }
    },
    settings: async (args) => {
      const led = loadLedger()
      if (typeof args.autoObserve === 'boolean') {
        led.settings.autoObserve = args.autoObserve
        saveLedger()
      }
      return buildOverview({ days: args.days, scope: args.scope })
    },
  }

  async function handleRoute(req, res) {
    const json = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
    if (req.method !== 'POST') { json(405, { ok: false, error: 'method not allowed' }); return }
    let name = ''
    try {
      const pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname)
      name = pathname.replace(/^\/api\/dsh-ledger\//, '').replace(/\/+$/, '')
    } catch (err) {
      json(400, { ok: false, error: 'bad url' })
      return
    }
    const handler = routes[name]
    if (!handler) { json(404, { ok: false, error: 'unknown route' }); return }
    let args = {}
    try {
      let raw = ''
      for await (const chunk of req) {
        raw += chunk
        if (raw.length > 262144) break
      }
      if (raw) args = JSON.parse(raw)
    } catch (err) {
      json(400, { ok: false, error: 'bad json body' })
      return
    }
    try {
      json(200, await handler(args && typeof args === 'object' ? args : {}))
    } catch (err) {
      console.error('[dsh-ledger] route ' + name + ' failed: ' + textOf(err))
      json(500, { ok: false, error: textOf(err) })
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/dsh-ledger',
    handler: handleRoute,
  }), 'dsh-ledger: api routes')

  // ---------- 自动观测 ----------
  ctx.effect(() => {
    const tick = () => {
      const led = loadLedger()
      if (led.settings && led.settings.autoObserve === false) return
      void observeNow()
    }
    const warm = setTimeout(tick, 3000)
    const timer = setInterval(tick, OBSERVE_INTERVAL_MS)
    if (warm && typeof warm.unref === 'function') warm.unref()
    if (timer && typeof timer.unref === 'function') timer.unref()
    return () => {
      clearTimeout(warm)
      clearInterval(timer)
    }
  }, 'dsh-ledger: auto observation')

  // ---------- Agent 工具 ----------
  const formatMoney = (value) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return '--'
    if (n !== 0 && Math.abs(n) < 0.01) return n.toFixed(4)
    return n.toFixed(2)
  }
  const formatTime = (ts) => (ts
    ? new Date(Number(ts) + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ')
    : '--')
  const formatClock = (ts) => (ts
    ? new Date(Number(ts) + 8 * 3600000).toISOString().slice(11, 16)
    : '--')
  const sourceLabel = (source) => (source === 'account' ? '账号登录' : source === 'apikey' ? 'API Key' : '未知')

  ctx.tools.register({
    name: 'ledger_status',
    description: '查看 DeepSeek 余额记账本：当前余额、今日已用、最近观测状态与各记账本。余额按北京时间自然日观测；可选 refresh=true 立即观测一次。',
    parameters: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: '先立即取一次余额并记账，再返回结果' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, v) => {
        if (!v || v.ok === false) return [{ type: 'text', text: '记账本读取失败：' + ((v && v.error) || '未知错误') }]
        const lines = []
        lines.push('记账本（' + v.currency + '）· 今天 ' + v.today)
        if (v.todayUsage) {
          lines.push('今日已用：' + formatMoney(v.todayUsage.amount) + '（' + v.todayUsage.label + (v.todayUsage.partialDay ? ' · 部分数据，从 ' + formatClock(v.todayUsage.observedFromMs) + ' 开始观测' : '') + '）')
          if (v.todayUsage.observedIncrease > 0) {
            lines.push('今日余额上升：' + formatMoney(v.todayUsage.observedIncrease)
              + '（已识别到账 ' + formatMoney(v.todayUsage.identifiedIncrease) + '，不计入消费'
              + (v.todayUsage.needsReview ? '；另有待核对调整' : '') + '）')
          }
        } else {
          lines.push('今日已用：--（今天还没有完成首次观测）')
        }
        lines.push('当前余额：' + (v.balance && v.balance.total != null ? formatMoney(v.balance.total) : '--')
          + (v.balance && v.balance.source ? '（' + sourceLabel(v.balance.source) + '）' : ''))
        lines.push('近 7 天已观测消费：' + formatMoney(v.totals && v.totals.amount) + ' · 本月 ' + formatMoney(v.totals && v.totals.month)
          + ' · 有数据 ' + ((v.totals && v.totals.count) || 0) + ' 天')
        lines.push('最近观测：' + formatTime(v.status && v.status.lastSuccessAt)
          + '（每 ' + ((v.status && v.status.intervalSec) || 60) + ' 秒自动记账' + (v.status && v.status.autoObserve ? '，已开启' : '，已关闭') + '）')
        if (v.status && v.status.lastError) lines.push('最近一次失败：' + v.status.lastError)
        if (v.books && v.books.length > 1) {
          lines.push('记账本：' + v.books.map((b) => (b.active ? '当前本 ' : '历史本 ') + b.scope.slice(0, 8) + '（' + b.currency + '，' + b.dayCount + ' 天）').join(' · '))
        }
        if (v.needsReview) lines.push('提示：检测到余额上升但尚未校正，可在「设置 → 记账本」里做余额校正。')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args) => {
      if (args && args.refresh) await observeNow()
      const data = buildOverview({ days: 7 })
      const today = data.todaySummary
      return {
        ok: true,
        today: data.today,
        currency: data.currency,
        balance: data.balance,
        todayUsage: today
          ? {
            amount: today.amount,
            label: today.label,
            partialDay: today.partialDay,
            observedFromMs: today.observedFromMs,
            needsReview: today.needsReview,
            observedIncrease: today.observedIncrease,
            identifiedIncrease: today.identifiedIncrease,
          }
          : null,
        totals: { amount: data.totals.amount, month: data.totals.month, count: data.totals.count },
        needsReview: !!(today && today.needsReview),
        books: data.books.map((b) => ({
          scope: b.scope,
          active: b.active,
          currency: b.currency,
          dayCount: b.dayCount,
          currentBalance: b.currentBalance,
        })),
        status: data.status,
        dataFile: DATA_FILE,
      }
    },
  })

  ctx.tools.register({
    name: 'ledger_days',
    description: '按天列出 DeepSeek 余额记账本的观测消费（北京时间自然日），包含观测区间、是否部分数据、是否待核对。默认最近 14 天。',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'number', description: '统计最近多少天（1-365，0=全部，默认 14）' },
        scope: { type: 'string', description: '记账本标识（多本时可选；缺省=当前本）' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, v) => {
        if (!v || v.ok === false) return [{ type: 'text', text: '读取失败：' + ((v && v.error) || '未知错误') }]
        const lines = ['记账明细（' + v.currency + '，' + v.from + ' ~ ' + v.to + '）']
        if (!v.days.length) lines.push('这个区间还没有观测记录。')
        for (const d of v.days) {
          const span = formatClock(d.firstObservedAt) + '–' + formatClock(d.lastObservedAt)
          const flags = []
          if (d.partialDay) flags.push('部分')
          if (d.needsReview) flags.push('待核对')
          if (d.identifiedIncrease > 0) flags.push('到账 ' + formatMoney(d.identifiedIncrease))
          if (d.correctedAt) flags.push('已校正')
          lines.push(d.day + '  ' + formatMoney(d.amount).padStart(8, ' ') + '  ' + span + (flags.length ? '  ' + flags.join('/') : ''))
        }
        lines.push('合计：' + formatMoney(v.total) + '（' + v.count + ' 天）')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args) => {
      const span = args && args.days !== undefined ? Number(args.days) : 14
      const days = Number.isFinite(span) ? Math.max(0, Math.min(365, Math.round(span))) : 14
      const data = buildOverview({ days, scope: args && args.scope })
      const observed = data.days.filter((d) => d.observed).slice().reverse()
      const total = observed.reduce((sum, d) => sum + Number(d.amount || 0), 0)
      return {
        ok: true,
        from: data.from,
        to: data.to,
        currency: data.currency,
        count: observed.length,
        total: Math.round(total * 1e8) / 1e8,
        scope: data.scope,
        active: data.active,
        books: data.books.map((b) => ({ scope: b.scope, active: b.active, currency: b.currency, dayCount: b.dayCount })),
        days: observed.map((d) => ({
          day: d.day,
          amount: d.amount,
          currency: d.currency,
          label: d.label,
          partialDay: d.partialDay,
          needsReview: d.needsReview,
          observedIncrease: d.observedIncrease,
          identifiedIncrease: d.identifiedIncrease,
          correctedAt: d.correctedAt || null,
          firstObservedAt: d.firstObservedAt,
          lastObservedAt: d.lastObservedAt,
          revision: d.revision,
        })),
      }
    },
  })

  ctx.tools.register({
    name: 'ledger_reconcile',
    description: '校正某一天的余额观测消费：按「统计起点余额 + 本区间累计到账 − 其它扣减 − 当前余额」反推。会改写账本，必须先经用户确认再调用（confirm=true）。',
    parameters: {
      type: 'object',
      properties: {
        day: { type: 'string', description: '要校正的日期（北京时间，YYYY-MM-DD）' },
        credits: { type: 'string', description: '本统计区间累计到账金额（元，未充值填 "0"）' },
        otherDebits: { type: 'string', description: '本统计区间其它扣减（元），可省略' },
        confirm: { type: 'boolean', description: '确认已与用户核对；必须为 true 才执行' },
      },
      required: ['day', 'credits', 'confirm'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, v) => (v && v.ok
        ? [{ type: 'text', text: '已校正 ' + v.day + '：' + v.label + ' ' + formatMoney(v.amount) + (v.credits != null ? '（累计到账 ' + formatMoney(v.credits) + '）' : '') }]
        : [{ type: 'text', text: '校正失败：' + ((v && v.error) || '未知错误') }]),
    },
    execute: async (args) => {
      if (!args || args.confirm !== true) {
        const err = new Error('校正会改写某一天的消费金额，必须先取得用户确认再调用（confirm=true）')
        err.dshUserFacing = true
        throw err
      }
      const led = loadLedger()
      const all = ledgerOverview(led, { days: 0, now: Date.now() })
      const row = all.days.filter((d) => d.observed && d.day === args.day)[0]
      if (!row) return { ok: false, error: '这一天没有余额观测记录，无法校正' }
      try {
        const summary = reconcileBalance(led, {
          day: String(args.day),
          revision: row.revision,
          action: 'correct',
          credits: args.credits,
          otherDebits: args.otherDebits,
          confirmed: true,
        }, Date.now())
        saveLedger()
        return {
          ok: true,
          day: summary.day,
          amount: summary.amount,
          label: summary.label,
          credits: summary.credits,
          otherDebits: summary.otherDebits,
          revision: summary.revision,
        }
      } catch (err) {
        return { ok: false, error: textOf(err) }
      }
    },
  })

  console.log('[dsh-ledger] ready · 数据文件 ' + DATA_FILE + ' · 每 ' + Math.round(OBSERVE_INTERVAL_MS / 1000) + ' 秒自动观测')
}

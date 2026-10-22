// ============================================================
// 宿主冒烟测试：用假 ctx 把 apply → 路由 → 工具 → 落盘跑一遍。
// 不访问网络（自动观测定时器会在触发前被清理）。
// 运行：node test/host-smoke.mjs
// ============================================================

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { observeBalance } from '../accounting.mjs'

const dir = mkdtempSync(join(tmpdir(), 'dsh-ledger-smoke-'))
const dataFile = join(dir, 'ledger.json')
const costFile = join(dir, 'cost-records.json')
process.env.DSH_LEDGER_FILE = dataFile
process.env.DSH_LEDGER_COST_FILE = costFile

const now = Date.now()
const seed = {
  date: '',
  accounting: { version: 1, active: '', books: {}, migratedAt: 0 },
  settings: { autoObserve: true },
  meta: {},
}
observeBalance(seed, { balance: 100, currency: 'CNY', scope: 'smoke', at: now - 120000 })
observeBalance(seed, { balance: 98, currency: 'CNY', scope: 'smoke', at: now - 60000 })
writeFileSync(dataFile, JSON.stringify(seed), 'utf8')

const cleanups = []
const routes = new Map()
const tools = new Map()
const eventHandlers = new Map()
const ctx = {
  effect(fn, label) {
    cleanups.push({ label, dispose: fn() })
  },
  on(name, handler) {
    eventHandlers.set(name, handler)
    return () => {}
  },
  get(name) {
    if (name === 'credentials') return { resolve: async () => ({ value: 'smoke-key' }) }
    if (name === 'deepseekAccount') return null
    return undefined
  },
  webServer: {
    register(route) { routes.set(route.path, route); return () => {} },
  },
  tools: {
    register(definition) { tools.set(definition.name, definition); return () => {} },
  },
}

const mod = await import('../index.js')
mod.apply(ctx)

assert.ok(routes.has('/api/dsh-ledger'))
assert.deepEqual([...tools.keys()].sort(), ['ledger_days', 'ledger_reconcile', 'ledger_status'])

function makeReq(path, body) {
  const text = JSON.stringify(body || {})
  return {
    method: 'POST',
    url: path,
    async *[Symbol.asyncIterator]() { yield Buffer.from(text, 'utf8') },
  }
}
function makeRes() {
  const state = { code: 0, text: '' }
  return {
    writeHead(code) { state.code = code },
    end(text) { state.text = text },
    get result() {
      return { code: state.code, body: JSON.parse(state.text || '{}') }
    },
  }
}
async function call(route, body) {
  const res = makeRes()
  await routes.get('/api/dsh-ledger').handler(makeReq('/api/dsh-ledger/' + route, body), res)
  return res.result
}

const overview = await call('overview', { days: 7 })
assert.equal(overview.code, 200)
assert.equal(overview.body.ok, true)
assert.equal(overview.body.currency, 'CNY')
assert.equal(overview.body.days.length, 7)
assert.equal(overview.body.todaySummary.amount, 2)
assert.equal(overview.body.totals.amount, 2)
assert.equal(overview.body.balance.total, 98)
assert.ok(overview.body.status.dataFile.endsWith('ledger.json'))
assert.equal(overview.body.status.walletSplit, true)

const settings = await call('settings', { autoObserve: false })
assert.equal(settings.body.status.autoObserve, false)
assert.equal(JSON.parse(readFileSync(dataFile, 'utf8')).settings.autoObserve, false)

const csv = await call('export', { days: 7 })
assert.equal(csv.body.ok, true)
assert.equal(csv.body.count, 1)
assert.ok(csv.body.csv.includes('日期,消费(CNY)'))
assert.ok(csv.body.csv.includes('2.00000000'))

const missing = await call('reconcile', { day: '2000-01-01', credits: '0', confirmed: true })
assert.equal(missing.body.ok, false)
assert.equal(missing.body.status, 404)

const today = overview.body.today
const badRevision = await call('reconcile', { day: today, revision: 'stale', credits: '0', confirmed: true })
assert.equal(badRevision.body.ok, false)
assert.equal(badRevision.body.status, 409)

const row = overview.body.todaySummary
const fixed = await call('reconcile', {
  day: today,
  revision: row.revision,
  credits: '5',
  otherDebits: '0',
  confirmed: true,
})
assert.equal(fixed.body.ok, true)
assert.equal(fixed.body.reconciled.amount, 7)
assert.equal(fixed.body.todaySummary.amount, 7)
assert.equal(fixed.body.reconciled.label, '已校正消费')

const daysTool = await tools.get('ledger_days').execute({ days: 7 })
assert.equal(daysTool.ok, true)
assert.equal(daysTool.count, 1)
assert.equal(daysTool.days[0].amount, 7)

const statusTool = await tools.get('ledger_status').execute({})
assert.equal(statusTool.ok, true)
assert.equal(statusTool.todayUsage.amount, 7)
assert.equal(statusTool.books.length, 1)

await assert.rejects(
  tools.get('ledger_reconcile').execute({ day: today, credits: '1', confirm: false }),
  /必须/,
)

const okTool = await tools.get('ledger_reconcile').execute({
  day: today,
  credits: '5',
  confirm: true,
})
assert.equal(okTool.ok, true)
assert.equal(okTool.amount, 7)

// 上一轮对话：turn/end 时从花费统计的逐条记录里切出该轮
const turnStart = Date.now() - 60000
writeFileSync(costFile, JSON.stringify({
  details: [
    { ts: turnStart + 100, sessionId: 'session-smoke', cost: 0.0123, purpose: '' },
    { ts: turnStart + 200, sessionId: 'session-smoke', cost: 0.0001, purpose: 'session-title' },
    { ts: turnStart + 300, sessionId: 'session-other', cost: 9, purpose: '' },
  ],
}), 'utf8')
const fakeSession = {
  id: 'session-smoke',
  snapshotEvents: () => [{ type: 'turn/start', time: turnStart, data: { turn: 3 } }],
}
const onSessionEvent = eventHandlers.get('session/event')
assert.equal(typeof onSessionEvent, 'function')
onSessionEvent(fakeSession, { type: 'turn/end', time: Date.now(), data: { turn: 3 } })

const lastTurn = await call('last-turn', { sessionId: 'session-smoke' })
assert.equal(lastTurn.body.ok, true)
assert.equal(lastTurn.body.lastTurn.cost, 0.0123)
assert.equal(lastTurn.body.lastTurn.calls, 1)
assert.equal(lastTurn.body.lastTurn.turn, 3)
const otherTurn = await call('last-turn', { sessionId: 'session-other' })
assert.equal(otherTurn.body.lastTurn, null)

for (const { dispose } of cleanups) {
  if (typeof dispose === 'function') dispose()
}
rmSync(dir, { recursive: true, force: true })
console.log('host smoke ok')

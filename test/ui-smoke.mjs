/**
 * Browser smoke test with REAL mouse input, driven over the Chrome DevTools
 * Protocol. No dependencies, not part of `npm test`.
 *
 *   npm run watch        # server on :4004
 *   npm run test:ui
 *
 * Synthetic `element.click()` would not have caught the bug this guards against:
 * a hover handler rebuilding the map destroyed the node the browser was about to
 * fire `click` on, so selecting a destination silently did nothing.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const APP = process.env.GE_URL ?? 'http://localhost:4004'
const PORT = 9222

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
]

const sleep = ms => new Promise(r => setTimeout(r, ms))
const checks = []
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  checks.push({ label, ok, actual, expected })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` - expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`)
}

const chrome = CHROME_CANDIDATES.find(existsSync)
if (!chrome) {
  console.log('no Chrome/Chromium found - skipping UI smoke test')
  process.exit(0)
}

try {
  await fetch(APP, { signal: AbortSignal.timeout(2000) })
} catch {
  console.error(`no server at ${APP} - start it with "npm run watch" first`)
  process.exit(1)
}

// ------------------------------------------------------------- fixture

const asUser = (path, body, who) => fetch(`${APP}/odata/v4/game/${path}`, {
  method: 'POST',
  headers: {
    Authorization: 'Basic ' + Buffer.from(`${who}:`).toString('base64'),
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(body)
}).then(r => r.json())

console.log('setting up a game')
const game = (await asUser('createGame', {
  name: `UI smoke ${Date.now()}`, planetCount: 40, maxPlayers: 2,
  turnLimitSec: 3600, shipSpeed: 200, mapWidth: 1600, mapHeight: 900, seed: 20260101
}, 'alice')).value
await asUser('joinGame', { game, name: 'bob' }, 'bob')
await asUser('startGame', { game }, 'alice')

// -------------------------------------------------------------- driver

const browser = spawn(chrome, [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  '--window-size=1600,900', `--user-data-dir=${process.env.TMPDIR ?? '/tmp'}/ge-ui-smoke`,
  'about:blank'
], { stdio: 'ignore' })

const shutdown = () => browser.kill()
process.on('exit', shutdown)

let target = null
for (let attempt = 0; attempt < 30 && !target; attempt++) {
  await sleep(400)
  try {
    const tabs = await (await fetch(`http://localhost:${PORT}/json/list`)).json()
    target = tabs.find(t => t.type === 'page')
  } catch { /* not up yet */ }
}
if (!target) throw new Error('Chrome did not expose a debugging target')

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r, { once: true }))

let nextId = 1
const pending = new Map()
const pageErrors = []
ws.addEventListener('message', ev => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    pageErrors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text)
  }
})

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
})

const evaluate = async expression => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true
  })
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
  return result.value
}

/** move + press + release, exactly what a human hand produces */
async function realClick (x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })
  await sleep(60)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 })
  await sleep(40)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 })
  await sleep(300)
}

const centerOf = selector => evaluate(`
  (() => { const n = document.querySelector(\`${selector}\`); if (!n) return null
    const b = n.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } })()`)

// ---------------------------------------------------------------- run

await send('Runtime.enable')
await send('Page.enable')

console.log('driving the UI')
await send('Page.navigate', { url: APP + '/' })
await sleep(1800)
await evaluate(`document.getElementById('login-user').value = 'alice'
                document.getElementById('login-btn').click(); true`)
await sleep(1500)
await evaluate(`[...document.querySelectorAll('#game-list button:not(.danger)')].find(b => !b.disabled).click(); true`)
await sleep(2500)

check('star map rendered', await evaluate(`document.querySelectorAll('#starmap .planet').length > 0`), true)

const own = await centerOf('#starmap .planet.mine:not(.ghost)')
await realClick(own.x, own.y)
check('own planet selected', await evaluate(`document.querySelectorAll('#starmap .planet.selected:not(.ghost)').length`), 1)
check('build panel opened', await evaluate(`!document.getElementById('build-box').classList.contains('hidden')`), true)

// The regression: a second real click must register as the destination.
const dest = await evaluate(`
  (() => {
    const mine = document.querySelector('#starmap .planet.mine:not(.ghost)')
    const mineNum = mine.dataset.number
    const other = [...document.querySelectorAll('#starmap .planet:not(.ghost)')]
      .find(p => p.dataset.number !== mineNum)
    const b = other.getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  })()`)
await realClick(dest.x, dest.y)
check('destination selected', await evaluate(`document.querySelectorAll('#starmap .planet.target:not(.ghost)').length`), 1)
check('send panel opened', await evaluate(`!document.getElementById('send-box').classList.contains('hidden')`), true)
check('ship count is bounded by the garrison', await evaluate(`
  (async () => {
    const res = await fetch('/odata/v4/game/starMap(game=' + document.body.dataset.game + ')',
      { headers: { Authorization: 'Basic ' + btoa('alice:') } })
    const mine = (await res.json()).value.find(p => p.mine)
    return document.getElementById('send-count').max === String(mine.ships)
  })()`), true)

const field = await centerOf('#send-count')
await realClick(field.x, field.y)
await evaluate(`document.getElementById('send-count').select(); true`)
for (const ch of '7') {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
}
await sleep(300)
check('ship count is editable', await evaluate(`document.getElementById('send-count').value`), '7')

const shipsBefore = Number(await evaluate(`document.getElementById('stat-ships').textContent`))
const sendBtn = await centerOf('#send-btn')
await realClick(sendBtn.x, sendBtn.y)
await sleep(1600)

check('fleet is in transit', await evaluate(`document.getElementById('stat-transit').textContent`), '7')
check('garrison was reduced', Number(await evaluate(`document.getElementById('stat-ships').textContent`)), shipsBefore - 7)
check('fleet marker on the map', await evaluate(`document.querySelectorAll('#starmap .fleet-marker').length > 0`), true)
check('no page errors', pageErrors, [])

ws.close()
browser.kill()

const failed = checks.filter(c => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length ? 1 : 0)

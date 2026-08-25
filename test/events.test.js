'use strict'

process.env.GE_DISABLE_TURN_TIMER = 'true'
process.env.CDS_REQUIRES_DB_CREDENTIALS_URL = ':memory:'

const cds = require('@sap/cds')
const test = require('node:test')
const assert = require('node:assert/strict')

const { POST, GET } = cds.test(__dirname + '/..')
const { connectionCount } = require('../srv/lib/event-bus')

const SRV = '/odata/v4/game'
const as = username => ({ auth: { username, password: '' } })
const post = (path, data, user) => POST(`${SRV}${path}`, data, as(user)).then(r => r.data)
const fn = (name, params, user) => {
  const args = Object.entries(params).map(([k, v]) => `${k}=${v}`).join(',')
  return GET(`${SRV}/${name}(${args})`, as(user)).then(r => r.data)
}

// Any stream left open would keep the test server from shutting down.
const openStreams = new Set()
test.after(() => { for (const close of openStreams) close() })

/** Opens an SSE connection and collects the parsed events. */
async function openStream (gameId, user) {
  const base = `http://localhost:${cds.app.server.address().port}`
  const controller = new AbortController()
  const response = await fetch(`${base}/events?game=${gameId}`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${user}:`).toString('base64') },
    signal: controller.signal
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/event-stream/)

  const events = []
  const waiters = []
  const reader = response.body.getReader()
  const decoder = new TextDecoder()

  ;(async () => {
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let split
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, split)
          buffer = buffer.slice(split + 2)
          const name = block.match(/^event: (.+)$/m)?.[1]
          const data = block.match(/^data: (.+)$/m)?.[1]
          if (!name) continue
          const event = { name, data: data ? JSON.parse(data) : null }
          events.push(event)
          waiters.filter(w => w.name === event.name).forEach(w => w.resolve(event))
        }
      }
    } catch { /* stream aborted on close */ }
  })()

  const close = () => { openStreams.delete(close); controller.abort() }
  openStreams.add(close)

  return {
    events,
    close,
    /** Resolves with the next (or already received) event of that name. */
    next (name, timeoutMs = 3000) {
      const seen = events.find(e => e.name === name)
      if (seen) return Promise.resolve(seen)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for "${name}"`)), timeoutMs)
        waiters.push({ name, resolve: e => { clearTimeout(timer); resolve(e) } })
      })
    }
  }
}

test('the event stream requires a game the caller plays in', async () => {
  const game = (await post('/createGame', { name: 'Auth', planetCount: 8, maxPlayers: 2, seed: 5 }, 'alice')).value
  const base = `http://localhost:${cds.app.server.address().port}`
  const basic = user => ({ Authorization: 'Basic ' + Buffer.from(`${user}:`).toString('base64') })

  assert.equal((await fetch(`${base}/events?game=${game}`, { headers: basic('carol') })).status, 403)
  assert.equal((await fetch(`${base}/events`, { headers: basic('alice') })).status, 400)
  assert.equal((await fetch(`${base}/events?game=${cds.utils.uuid()}`, { headers: basic('alice') })).status, 403)
})

test('players get pushed lobby, ready and turn events', async () => {
  const game = (await post('/createGame', {
    name: 'Push', planetCount: 10, maxPlayers: 2, turnLimitSec: 3600,
    mapWidth: 600, mapHeight: 600, shipSpeed: 150, seed: 42
  }, 'alice')).value

  const alice = await openStream(game, 'alice')
  assert.equal((await alice.next('connected')).data.name, 'alice')
  assert.equal(connectionCount(game), 1)

  // --- lobby ----------------------------------------------------------
  await post('/joinGame', { game, name: 'Bob' }, 'bob')
  const joined = await alice.next('playerJoined')
  assert.equal(joined.data.name, 'Bob')
  assert.equal(joined.data.players, 2)

  const bob = await openStream(game, 'bob')
  await bob.next('connected')

  await post('/startGame', { game }, 'alice')
  assert.equal((await bob.next('gameStarted')).data.turn, 1)

  // --- ready state ----------------------------------------------------
  await post('/endTurn', { game }, 'alice')
  const ready = await bob.next('playerReady')
  assert.equal(ready.data.name, 'alice')
  assert.equal(ready.data.waitingFor, 1)

  // --- turn resolution ------------------------------------------------
  await post('/endTurn', { game }, 'bob')
  const resolved = await alice.next('turnResolved')
  assert.equal(resolved.data.turn, 2)
  assert.equal(resolved.data.finished, false)
  assert.ok(resolved.data.turnDeadline, 'clients get the new deadline for their countdown')
  assert.equal(resolved.data.players.length, 2)

  alice.close()
  bob.close()
  await new Promise(r => setTimeout(r, 100))
  assert.equal(connectionCount(game), 0, 'closed connections are unsubscribed')
})

test('combat reports are pushed to the players involved only', async t => {
  const game = (await post('/createGame', {
    name: 'Reports', planetCount: 10, maxPlayers: 2, turnLimitSec: 3600,
    mapWidth: 500, mapHeight: 500, shipSpeed: 400, seed: 11
  }, 'alice')).value
  await post('/joinGame', { game, name: 'Bob' }, 'bob')
  await post('/startGame', { game }, 'alice')

  const map = (await fn('starMap', { game }, 'alice')).value
  const home = map.find(p => p.mine)
  const bobHome = (await fn('starMap', { game }, 'bob')).value.find(p => p.mine)
  // A native planet - attacking Bob would legitimately produce a report for him.
  const target = map.find(p => !p.mine && p.number !== bobHome.number)
  await post('/sendFleet', { game, origin: home.number, destination: target.number, ships: 20 }, 'alice')

  const alice = await openStream(game, 'alice')
  const bob = await openStream(game, 'bob')
  t.after(() => { alice.close(); bob.close() })
  await Promise.all([alice.next('connected'), bob.next('connected')])

  await post('/endTurn', { game }, 'alice')
  await post('/endTurn', { game }, 'bob')

  const report = await alice.next('report')
  assert.equal(report.data.turn, 2)
  const arrival = report.data.messages.find(m => m.planetNumber === target.number)
  assert.ok(arrival, 'the attacker is told what happened at the target')
  assert.ok(['CAPTURE', 'COMBAT'].includes(arrival.kind))
  assert.ok(arrival.planetName)

  await alice.next('turnResolved')
  await bob.next('turnResolved')
  assert.ok(!bob.events.some(e => e.name === 'report'), 'reports of other players stay private')
})

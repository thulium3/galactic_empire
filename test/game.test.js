'use strict'

process.env.GE_DISABLE_TURN_TIMER = 'true'
process.env.CDS_REQUIRES_DB_CREDENTIALS_URL = ':memory:'

const cds = require('@sap/cds')
const test = require('node:test')
const assert = require('node:assert/strict')

const { POST, GET } = cds.test(__dirname + '/..')

const SRV = '/odata/v4/game'
const as = username => ({ auth: { username, password: '' } })

const post = (path, data, user) => POST(`${SRV}${path}`, data, as(user)).then(r => r.data)

const fn = (name, params, user) => {
  const args = Object.entries(params).map(([k, v]) => `${k}=${v}`).join(',')
  return GET(`${SRV}/${name}(${args})`, as(user)).then(r => r.data)
}
const get = (path, user) => GET(`${SRV}${path}`, as(user)).then(r => r.data)

test('a full two player game runs from lobby to a resolved battle', async () => {
  // --- lobby ----------------------------------------------------------
  const game = (await post('/createGame', {
    name: 'Testrun', planetCount: 12, maxPlayers: 2, turnLimitSec: 3600,
    mapWidth: 600, mapHeight: 600, shipSpeed: 150, shipCost: 10, seed: 42
  }, 'alice')).value

  await post('/joinGame', { game, name: 'Bob' }, 'bob')
  assert.equal((await post('/startGame', { game }, 'alice')).value, true)

  // --- fog of war -----------------------------------------------------
  const aliceMap = (await fn('starMap', { game }, 'alice')).value
  assert.equal(aliceMap.length, 12)
  const explored = aliceMap.filter(p => p.explored)
  assert.equal(explored.length, 1, 'only the home planet is known at the start')

  const home = explored[0]
  assert.equal(home.mine, true)
  assert.equal(home.ships, 20)
  assert.equal(home.production, 10)
  assert.ok(aliceMap.every(p => typeof p.x === 'number' && typeof p.y === 'number'), 'positions are always visible')
  assert.ok(aliceMap.filter(p => !p.explored).every(p => p.name === null && p.ships === null))

  // --- building -------------------------------------------------------
  const me = (await get(`/MyPlayers?$filter=game_ID eq ${game}`, 'alice')).value[0]
  assert.equal(me.resources, 100)
  const left = (await post('/buildShips', { game, planet: home.number, ships: 5 }, 'alice')).value
  assert.equal(left, 50)

  // --- dispatching a fleet --------------------------------------------
  const target = aliceMap
    .filter(p => p.number !== home.number)
    .map(p => ({ p, r: null }))
  const routes = await Promise.all(target.map(async t => ({
    number: t.p.number,
    ...(await fn('route', { game, origin: home.number, destination: t.p.number }, 'alice'))
  })))
  const nearest = routes.sort((a, b) => a.distance - b.distance)[0]
  assert.ok(nearest.turns >= 1)

  const fleet = await post('/sendFleet', { game, origin: home.number, destination: nearest.number, ships: 15 }, 'alice')
  assert.equal(fleet.ships, 15)
  assert.equal(fleet.arrivalTurn, 1 + nearest.turns)

  const afterSend = (await fn('starMap', { game }, 'alice')).value.find(p => p.number === home.number)
  assert.equal(afterSend.ships, 5, 'dispatched ships leave the planet immediately')
  assert.equal(afterSend.pendingShips, 5)

  const inTransit = (await get(`/MyFleets?$filter=game_ID eq ${game}`, 'alice')).value
  assert.equal(inTransit.length, 1)
  assert.equal(inTransit[0].destinationNumber, nearest.number)
  assert.equal((await get(`/MyFleets?$filter=game_ID eq ${game}`, 'bob')).value.length, 0, 'fleets are private')

  // --- turn resolution ------------------------------------------------
  let result = await post('/endTurn', { game }, 'alice')
  assert.equal(result.resolved, false)
  assert.equal(result.waitingFor, 1)

  result = await post('/endTurn', { game }, 'bob')
  assert.equal(result.resolved, true)
  assert.equal(result.turn, 2)

  const turn2 = (await fn('starMap', { game }, 'alice')).value.find(p => p.number === home.number)
  assert.equal(turn2.ships, 10, 'ships built last turn are now stationed')
  assert.equal(turn2.pendingShips, 0)
  const player2 = (await get(`/MyPlayers?$filter=game_ID eq ${game}`, 'alice')).value[0]
  assert.equal(player2.resources, 60, 'home planet produced 10 resources')
  assert.equal(player2.turnDone, false, 'ready flag is reset')

  // --- let the fleet arrive -------------------------------------------
  for (let turn = 2; turn <= fleet.arrivalTurn; turn++) {
    await post('/endTurn', { game }, 'alice')
    await post('/endTurn', { game }, 'bob')
  }

  const arrivalMessages = (await get(`/MyMessages?$filter=game_ID eq ${game} and turn eq ${fleet.arrivalTurn}`, 'alice')).value
  assert.ok(arrivalMessages.length > 0, 'player is notified about the arrival')
  assert.ok(arrivalMessages.some(m => m.planetNumber === nearest.number))

  const finalMap = (await fn('starMap', { game }, 'alice')).value
  const contested = finalMap.find(p => p.number === nearest.number)
  assert.equal(contested.explored, true, 'the target planet is explored now')
  assert.ok(contested.name, 'explored planets reveal their name')

  const outcome = arrivalMessages.find(m => m.planetNumber === nearest.number)
  if (outcome.kind === 'CAPTURE') {
    assert.equal(contested.mine, true)
    assert.ok(contested.ships > 0)
  } else {
    assert.equal(contested.mine, false)
  }
})

test('rules are enforced', async () => {
  const game = (await post('/createGame', {
    name: 'Rules', planetCount: 8, maxPlayers: 2, turnLimitSec: 3600, seed: 7
  }, 'alice')).value
  await post('/joinGame', { game, name: 'Bob' }, 'bob')

  await assert.rejects(() => post('/joinGame', { game, name: 'Alice again' }, 'alice'), /already joined/)
  await assert.rejects(() => post('/startGame', { game }, 'bob'), /creator/)
  await post('/startGame', { game }, 'alice')

  const home = (await fn('starMap', { game }, 'alice')).value.find(p => p.mine)
  const foreign = (await fn('starMap', { game }, 'bob')).value.find(p => p.mine)

  await assert.rejects(() => post('/sendFleet', { game, origin: foreign.number, destination: home.number, ships: 1 }, 'alice'), /not yours/)
  await assert.rejects(() => post('/sendFleet', { game, origin: home.number, destination: home.number, ships: 1 }, 'alice'), /must differ/)
  await assert.rejects(() => post('/sendFleet', { game, origin: home.number, destination: foreign.number, ships: 999 }, 'alice'), /Only 20 ships/)
  await assert.rejects(() => post('/buildShips', { game, planet: home.number, ships: 999 }, 'alice'), /Not enough resources/)
  await assert.rejects(() => post('/sendFleet', { game, origin: home.number, destination: foreign.number, ships: 1 }, 'carol'), /not part of this game/)

  await post('/endTurn', { game }, 'alice')
  await assert.rejects(() => post('/buildShips', { game, planet: home.number, ships: 1 }, 'alice'), /already ended your turn/)
})

test('the turn timer resolves a game after its deadline', async () => {
  const { startTurnTimer, stopTurnTimer, tick } = require('../srv/lib/turn-timer')
  const { Games } = cds.entities('galactic')

  const game = (await post('/createGame', {
    name: 'Clock', planetCount: 8, maxPlayers: 2, turnLimitSec: 3600, seed: 3
  }, 'alice')).value
  await post('/joinGame', { game, name: 'Bob' }, 'bob')
  await post('/startGame', { game }, 'alice')

  await cds.tx(() => UPDATE(Games, game).with({ turnDeadline: new Date(Date.now() - 1000).toISOString() }))
  await tick()

  const after = await cds.tx(() => SELECT.one.from(Games).where({ ID: game }))
  assert.equal(after.currentTurn, 2, 'expired turns are resolved without all players being ready')

  stopTurnTimer()
  assert.equal(startTurnTimer, startTurnTimer) // keep require side effects explicit
})

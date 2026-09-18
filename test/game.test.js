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
  // cds10 defaults to `ieee754compatible`, so Decimals go over the wire as
  // strings - on every database, not just HANA and Postgres. What matters here
  // is that a position is always there and always a usable number; the client
  // coerces the type (see app/js/api.js).
  assert.ok(aliceMap.every(p => Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))),
    'positions are always visible')
  assert.ok(aliceMap.filter(p => !p.explored).every(p => p.name === null && p.ships === null))

  // --- building -------------------------------------------------------
  assert.equal(home.resources, 100, 'the starting stockpile sits on the home planet')
  const left = (await post('/buildShips', { game, planet: home.number, ships: 5 }, 'alice')).value
  assert.equal(left, 50, 'the planet paid for its own ships')

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
  assert.equal(turn2.resources, 60, 'the home planet produced 10 into its own stockpile')
  const player2 = (await get(`/MyPlayers?$filter=game_ID eq ${game}`, 'alice')).value[0]
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

test('a running game can be deleted by its creator only, and takes its data with it', async () => {
  const { Games, Players, Planets, Fleets, Messages } = cds.entities('galactic')

  const game = (await post('/createGame', {
    name: 'Doomed', planetCount: 8, maxPlayers: 2, turnLimitSec: 3600, seed: 11
  }, 'alice')).value
  await post('/joinGame', { game, name: 'Bob' }, 'bob')
  await post('/startGame', { game }, 'alice')

  const home = (await fn('starMap', { game }, 'alice')).value.find(p => p.mine)
  const target = (await fn('starMap', { game }, 'alice')).value.find(p => p.number !== home.number)
  await post('/sendFleet', { game, origin: home.number, destination: target.number, ships: 5 }, 'alice')

  await assert.rejects(() => post('/deleteGame', { game }, 'bob'), /creator/)
  await assert.rejects(() => post('/deleteGame', { game }, 'carol'), /creator/)
  assert.equal((await post('/deleteGame', { game }, 'alice')).value, true)

  const rows = await cds.tx(async () => ({
    games: await SELECT.from(Games).where({ ID: game }),
    players: await SELECT.from(Players).where({ game_ID: game }),
    planets: await SELECT.from(Planets).where({ game_ID: game }),
    fleets: await SELECT.from(Fleets).where({ game_ID: game }),
    messages: await SELECT.from(Messages).where({ game_ID: game })
  }))
  assert.equal(rows.games.length, 0)
  assert.equal(rows.players.length, 0)
  assert.equal(rows.planets.length, 0)
  assert.equal(rows.fleets.length, 0)
  assert.equal(rows.messages.length, 0)

  await assert.rejects(() => post('/deleteGame', { game }, 'alice'), /not found/)
  assert.ok(!(await get('/Games', 'alice')).value.some(g => g.ID === game))
})

test('a gamemaster can delete a game he did not create', async () => {
  const game = (await post('/createGame', {
    name: 'Purge', planetCount: 8, maxPlayers: 2, turnLimitSec: 3600, seed: 12
  }, 'alice')).value
  await post('/joinGame', { game, name: 'Bob' }, 'bob')
  await post('/startGame', { game }, 'alice')

  assert.equal((await post('/deleteGame', { game }, 'admin')).value, true)
})

test('one planet can split its garrison across several destinations in one turn', async () => {
  const game = (await post('/createGame', {
    name: 'Split', planetCount: 20, maxPlayers: 2, turnLimitSec: 3600,
    mapWidth: 1600, mapHeight: 900, shipSpeed: 200, seed: 4711
  }, 'alice')).value
  await post('/joinGame', { game, name: 'Bob' }, 'bob')
  await post('/startGame', { game }, 'alice')

  const map = (await fn('starMap', { game }, 'alice')).value
  const home = map.find(p => p.mine)
  const [first, second] = map.filter(p => p.number !== home.number)
  assert.equal(home.ships, 20)

  const one = await post('/sendFleet', { game, origin: home.number, destination: first.number, ships: 6 }, 'alice')
  const two = await post('/sendFleet', { game, origin: home.number, destination: second.number, ships: 9 }, 'alice')
  assert.equal(one.ships, 6)
  assert.equal(two.ships, 9)
  assert.notEqual(one.ID, two.ID)

  const after = (await fn('starMap', { game }, 'alice')).value.find(p => p.number === home.number)
  assert.equal(after.ships, 5, 'both dispatches leave the garrison')

  const inTransit = (await get(`/MyFleets?$filter=game_ID eq ${game}`, 'alice')).value
  assert.equal(inTransit.length, 2)
  assert.deepEqual(inTransit.map(f => f.ships).sort((a, b) => a - b), [6, 9])
  assert.ok(inTransit.every(f => f.originNumber === home.number))

  // The garrison is the only limit - the third order asks for one ship too many.
  await assert.rejects(
    () => post('/sendFleet', { game, origin: home.number, destination: first.number, ships: 6 }, 'alice'),
    /Only 5 ships/)
  await post('/sendFleet', { game, origin: home.number, destination: first.number, ships: 5 }, 'alice')
})

test('a stockpile belongs to its planet and cannot be spent anywhere else', async () => {
  const game = (await post('/createGame', {
    name: 'Local economy', planetCount: 16, maxPlayers: 2, turnLimitSec: 3600,
    mapWidth: 600, mapHeight: 600, shipSpeed: 5000, shipCost: 10, seed: 2027
  }, 'alice')).value
  await post('/joinGame', { game, name: 'Bob' }, 'bob')
  await post('/startGame', { game }, 'alice')

  const home = (await fn('starMap', { game }, 'alice')).value.find(p => p.mine)
  assert.equal(home.resources, 100)

  // Take a second planet: shipSpeed is huge, so the fleet lands next turn.
  // Which planets are uninhabited is hidden from the player, so pick one that
  // is actually undefended straight from the database.
  const empty = await cds.tx(async () => {
    const { Planets } = cds.entities('galactic')
    return SELECT.one.from(Planets)
      .where({ game_ID: game, natives: 0, owner_ID: null })
      .orderBy('number')
  })
  assert.ok(empty, 'the galaxy has at least one uninhabited planet')
  await post('/sendFleet', { game, origin: home.number, destination: empty.number, ships: 20 }, 'alice')
  await post('/endTurn', { game }, 'alice')
  await post('/endTurn', { game }, 'bob')

  const map = (await fn('starMap', { game }, 'alice')).value
  const mine = map.filter(p => p.mine)
  assert.equal(mine.length, 2, 'the second planet was taken')

  const conquered = mine.find(p => p.number === empty.number)
  const first = mine.find(p => p.number === home.number)
  assert.equal(conquered.resources, 0, 'a fresh conquest starts with an empty depot')
  assert.equal(first.resources, 100 + first.production, 'production accrues where it is produced')

  // The rich planet cannot bankroll the poor one.
  await assert.rejects(
    () => post('/buildShips', { game, planet: conquered.number, ships: 1 }, 'alice'),
    /Not enough resources on planet #/)

  // ... but the planet holding the stockpile can spend it.
  const rest = (await post('/buildShips', { game, planet: first.number, ships: 3 }, 'alice')).value
  assert.equal(rest, 100 + first.production - 30)

  // Each planet keeps its own books.
  const after = (await fn('starMap', { game }, 'alice')).value
  assert.equal(after.find(p => p.number === conquered.number).resources, 0)
  assert.equal(after.find(p => p.number === first.number).resources, rest)

  // A foreign planet never discloses its stockpile.
  const bobsView = (await fn('starMap', { game }, 'bob')).value
  assert.ok(bobsView.filter(p => !p.mine).every(p => p.resources === null),
    'stockpiles of other players stay hidden')
})

test('planets drift every turn and a fleet still reaches its moving target', async () => {
  const game = (await post('/createGame', {
    name: 'Drifting', planetCount: 16, maxPlayers: 2, turnLimitSec: 3600,
    mapWidth: 800, mapHeight: 800, shipSpeed: 120, shipCost: 10, planetDrift: 6, seed: 31337
  }, 'alice')).value
  await post('/joinGame', { game, name: 'Bob' }, 'bob')
  await post('/startGame', { game }, 'alice')

  const before = (await fn('starMap', { game }, 'alice')).value
  const home = before.find(p => p.mine)

  // Aim at a far planet so the trip lasts several turns while it moves away.
  const routes = await Promise.all(before.filter(p => p.number !== home.number).map(async p => ({
    number: p.number, ...(await fn('route', { game, origin: home.number, destination: p.number }, 'alice'))
  })))
  const far = routes.sort((a, b) => b.distance - a.distance)[0]
  assert.ok(far.turns >= 2, 'the target is more than one turn away')

  const fleet = await post('/sendFleet', { game, origin: home.number, destination: far.number, ships: 10 }, 'alice')
  const promisedArrival = fleet.arrivalTurn

  await post('/endTurn', { game }, 'alice')
  await post('/endTurn', { game }, 'bob')

  const after = (await fn('starMap', { game }, 'alice')).value
  const moved = before.filter(p => {
    const now = after.find(q => q.number === p.number)
    return Number(now.x) !== Number(p.x) || Number(now.y) !== Number(p.y)
  })
  assert.equal(moved.length, before.length, 'every planet moved, owned and unowned alike')

  // The step is small: nothing teleports across the map.
  for (const p of before) {
    const now = after.find(q => q.number === p.number)
    const step = Math.hypot(
      Math.min(Math.abs(Number(now.x) - Number(p.x)), 800 - Math.abs(Number(now.x) - Number(p.x))),
      Math.min(Math.abs(Number(now.y) - Number(p.y)), 800 - Math.abs(Number(now.y) - Number(p.y))))
    assert.ok(step > 0 && step <= 6.05, `planet #${p.number} drifted ${step}`)
  }

  // The target keeps moving, but a fleet tracks its planet: the ETA promised at
  // launch is the turn it actually lands.
  for (let turn = 2; turn <= promisedArrival; turn++) {
    await post('/endTurn', { game }, 'alice')
    await post('/endTurn', { game }, 'bob')
  }
  const inTransit = (await get(`/MyFleets?$filter=game_ID eq ${game}`, 'alice')).value
  assert.equal(inTransit.length, 0, 'the fleet arrived on the promised turn')

  const reports = (await get(`/MyMessages?$filter=game_ID eq ${game}&$orderby=turn desc`, 'alice')).value
  assert.ok(reports.some(m => m.planetNumber === far.number && ['ARRIVAL', 'CAPTURE', 'COMBAT'].includes(m.kind)),
    'the fleet reached the planet it was sent to')
})

test('a galaxy can be kept still, and planets may not outrun fleets', async () => {
  const game = (await post('/createGame', {
    name: 'Static', planetCount: 10, maxPlayers: 2, turnLimitSec: 3600,
    mapWidth: 600, mapHeight: 600, shipSpeed: 150, planetDrift: 0, seed: 5
  }, 'alice')).value
  await post('/joinGame', { game, name: 'Bob' }, 'bob')
  await post('/startGame', { game }, 'alice')

  const before = (await fn('starMap', { game }, 'alice')).value
  await post('/endTurn', { game }, 'alice')
  await post('/endTurn', { game }, 'bob')
  const after = (await fn('starMap', { game }, 'alice')).value
  assert.ok(before.every(p => {
    const now = after.find(q => q.number === p.number)
    return Number(now.x) === Number(p.x) && Number(now.y) === Number(p.y)
  }), 'planetDrift 0 leaves every planet where it was')

  await assert.rejects(() => post('/createGame', {
    name: 'Runaway', planetCount: 10, maxPlayers: 2, shipSpeed: 100, planetDrift: 100, seed: 1
  }, 'alice'), /must stay below shipSpeed/)
  await assert.rejects(() => post('/createGame', {
    name: 'Backwards', planetCount: 10, maxPlayers: 2, planetDrift: -1, seed: 1
  }, 'alice'), /cannot be negative/)
})

test('a new star ignites, shows up unexplored and is reported to everyone', async () => {
  // starBirthChance 1 fires the rule on every single turn.
  const game = (await post('/createGame', {
    name: 'Nursery', planetCount: 10, maxPlayers: 2, turnLimitSec: 3600,
    mapWidth: 600, mapHeight: 600, shipSpeed: 150, planetDrift: 0,
    starBirthChance: 1, seed: 8080
  }, 'alice')).value
  await post('/joinGame', { game, name: 'Bob' }, 'bob')
  await post('/startGame', { game }, 'alice')

  const before = (await fn('starMap', { game }, 'alice')).value
  assert.equal(before.length, 10)

  await post('/endTurn', { game }, 'alice')
  await post('/endTurn', { game }, 'bob')

  const after = (await fn('starMap', { game }, 'alice')).value
  assert.equal(after.length, 11, 'a star was born')

  const born = after.find(p => !before.some(b => b.number === p.number))
  assert.equal(born.number, 11, 'it takes the next free number')
  assert.equal(born.explored, false, 'nobody has been there')
  assert.equal(born.name, null, 'an unexplored star does not give away its name')
  assert.ok(Number.isFinite(Number(born.x)), 'its position is visible like every other position')
  assert.equal(new Set(after.map(p => p.number)).size, 11, 'numbers stay unique')

  // Both players are told - a new star is visible across the galaxy.
  for (const who of ['alice', 'bob']) {
    const reports = (await get(`/MyMessages?$filter=game_ID eq ${game} and kind eq 'STARBIRTH'`, who)).value
    assert.equal(reports.length, 1)
    assert.equal(reports[0].planetNumber, 11)
  }

  // ... and it keeps happening, turn after turn.
  await post('/endTurn', { game }, 'alice')
  await post('/endTurn', { game }, 'bob')
  assert.equal((await fn('starMap', { game }, 'alice')).value.length, 12)
})

test('without the rule the galaxy keeps exactly the stars it started with', async () => {
  const game = (await post('/createGame', {
    name: 'Barren', planetCount: 8, maxPlayers: 2, turnLimitSec: 3600, seed: 606
  }, 'alice')).value
  await post('/joinGame', { game, name: 'Bob' }, 'bob')
  await post('/startGame', { game }, 'alice')

  for (let turn = 0; turn < 3; turn++) {
    await post('/endTurn', { game }, 'alice')
    await post('/endTurn', { game }, 'bob')
  }
  assert.equal((await fn('starMap', { game }, 'alice')).value.length, 8)

  await assert.rejects(() => post('/createGame', {
    name: 'Impossible', planetCount: 8, maxPlayers: 2, starBirthChance: 2, seed: 1
  }, 'alice'), /probability between 0 and 1/)
})

test('a supernova wipes a star out, reroutes the fleets aimed at it and leaves a remnant', async () => {
  // supernovaChance 1 blows up exactly one star per turn.
  const game = (await post('/createGame', {
    name: 'Nova', planetCount: 14, maxPlayers: 2, turnLimitSec: 3600,
    mapWidth: 800, mapHeight: 800, shipSpeed: 60, planetDrift: 0,
    supernovaChance: 1, seed: 90210
  }, 'alice')).value
  await post('/joinGame', { game, name: 'Bob' }, 'bob')
  await post('/startGame', { game }, 'alice')

  const before = (await fn('starMap', { game }, 'alice')).value
  const home = before.find(p => p.mine)

  // A slow ship and a far target: the fleet is still in flight when stars start
  // exploding, so a diversion has something to work on.
  const routes = await Promise.all(before.filter(p => p.number !== home.number).map(async p => ({
    number: p.number, ...(await fn('route', { game, origin: home.number, destination: p.number }, 'alice'))
  })))
  const far = routes.sort((a, b) => b.turns - a.turns)[0]
  assert.ok(far.turns >= 3, 'the target is several turns away')
  await post('/sendFleet', { game, origin: home.number, destination: far.number, ships: 10 }, 'alice')

  await post('/endTurn', { game }, 'alice')
  await post('/endTurn', { game }, 'bob')

  const after = (await fn('starMap', { game }, 'alice')).value
  assert.equal(after.length, 14, 'the remnant keeps its place on the map')
  const wrecks = after.filter(p => p.destroyed)
  assert.equal(wrecks.length, 1, 'exactly one star went up')

  const wreck = wrecks[0]
  assert.equal(wreck.mine, false)
  assert.equal(wreck.ownerName, null)
  assert.equal(wreck.ships, null)
  assert.equal(wreck.natives, null)
  assert.equal(wreck.resources, null, 'a remnant holds nothing')

  // Everybody sees the flash, whether they had ever been there or not.
  for (const who of ['alice', 'bob']) {
    const flash = (await get(`/MyMessages?$filter=game_ID eq ${game} and kind eq 'SUPERNOVA'`, who)).value
    assert.equal(flash.length, 1)
    assert.equal(flash[0].planetNumber, wreck.number)
  }

  // Nothing can be sent to or built on a remnant any more.
  await assert.rejects(
    () => post('/sendFleet', { game, origin: home.number, destination: wreck.number, ships: 1 }, 'alice'),
    /wiped out by a supernova/)
  await assert.rejects(
    () => fn('route', { game, origin: home.number, destination: wreck.number }, 'alice'),
    /wiped out by a supernova/)

  // Now aim the next blast at the star the fleet is flying to. Waiting for the
  // rule to roll that planet would take half the galaxy with it first.
  const { Games, Planets } = cds.entities('galactic')
  await cds.tx(async () => {
    await UPDATE(Games, game).with({ supernovaChance: 0 })
    await UPDATE(Planets).set({ destroyed: true, owner_ID: null, ships: 0, natives: 0 })
      .where({ game_ID: game, number: far.number })
  })

  const flying = (await get(`/MyFleets?$filter=game_ID eq ${game}`, 'alice')).value
  assert.equal(flying.length, 1, 'the fleet is still on its way')
  const promised = flying[0].arrivalTurn

  await post('/endTurn', { game }, 'alice')
  await post('/endTurn', { game }, 'bob')

  const diverted = (await get(`/MyMessages?$filter=game_ID eq ${game} and kind eq 'DIVERSION'`, 'alice')).value
  assert.equal(diverted.length, 1, 'the fleet aimed at an exploded star was rerouted')
  assert.match(diverted[0].text, /supernova at #\d+ took the target/)

  const rerouted = (await get(`/MyFleets?$filter=game_ID eq ${game}`, 'alice')).value[0]
  assert.ok(rerouted, 'the ships survive, they just go somewhere else')
  assert.notEqual(rerouted.destinationNumber, far.number, 'it is heading somewhere else now')
  assert.ok(rerouted.arrivalTurn > promised, 'the detour costs it time')
  assert.equal(diverted[0].planetNumber, rerouted.destinationNumber, 'the report names the new target')

  const newTarget = (await fn('starMap', { game }, 'alice')).value
    .find(p => p.number === rerouted.destinationNumber)
  assert.equal(newTarget.destroyed, false, 'and not at another wreck')
})

test('a supernova on the last planet eliminates its owner', async () => {
  const { Planets, Games, Players } = cds.entities('galactic')

  const game = (await post('/createGame', {
    name: 'Last stand', planetCount: 6, maxPlayers: 2, turnLimitSec: 3600,
    mapWidth: 400, mapHeight: 400, shipSpeed: 200, planetDrift: 0, seed: 1234
  }, 'alice')).value
  await post('/joinGame', { game, name: 'Bob' }, 'bob')
  await post('/startGame', { game }, 'alice')

  // Only the two home worlds are left, so every blast now takes one of them and
  // with it the empire that sits there. Which one is up to the seed.
  await cds.tx(async () => {
    await UPDATE(Planets).set({ destroyed: true, owner_ID: null, ships: 0, natives: 0 })
      .where({ game_ID: game, owner_ID: null })
    await UPDATE(Games, game).with({ supernovaChance: 1 })
  })

  await post('/endTurn', { game }, 'alice')
  await post('/endTurn', { game }, 'bob')

  const finished = await get(`/Games(${game})`, 'alice')
  assert.equal(finished.status, 'FINISHED', 'losing the last planet ends the game')

  const states = await cds.tx(() => SELECT.from(Players).where({ game_ID: game }))
  const dead = states.filter(p => p.eliminated)
  assert.equal(dead.length, 1, 'exactly one empire went up with its home world')
  assert.equal(finished.winnerName, states.find(p => !p.eliminated).name)

  const loss = (await get(`/MyMessages?$filter=game_ID eq ${game} and kind eq 'LOSS'`, dead[0].user)).value
  assert.equal(loss.length, 1)
  assert.match(loss[0].text, /went up in a supernova/)
})

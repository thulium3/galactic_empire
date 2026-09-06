'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { resolveBattle, DEFENDER_BONUS } = require('../srv/lib/combat')
const { wrappedDelta, torusDistance, travelTurns } = require('../srv/lib/geometry')
const { generateGalaxy, assignHomePlanets } = require('../srv/lib/galaxy')
const { createRng } = require('../srv/lib/rng')

const MAP = { width: 1000, height: 1000 }

test('torus distance wraps around the map edges', () => {
  assert.equal(wrappedDelta(10, 990, 1000), 20)
  assert.equal(wrappedDelta(10, 200, 1000), 190)

  const near = torusDistance({ x: 10, y: 10 }, { x: 990, y: 990 }, MAP.width, MAP.height)
  assert.ok(Math.abs(near - Math.sqrt(800)) < 0.001, `expected ~28.28, got ${near}`)

  const half = torusDistance({ x: 0, y: 0 }, { x: 500, y: 500 }, MAP.width, MAP.height)
  assert.ok(Math.abs(half - Math.sqrt(500000)) < 0.001)
})

test('travel takes at least one turn and rounds up', () => {
  assert.equal(travelTurns(0, 120), 1)
  assert.equal(travelTurns(120, 120), 1)
  assert.equal(travelTurns(121, 120), 2)
  assert.equal(travelTurns(360, 120), 3)
})

test('37 attackers beat 20 defenders with neutral rolls', () => {
  const neutral = () => 0.5 // factor 1.0 for both sides
  const battle = resolveBattle(37, 20, neutral)

  assert.equal(battle.attackFactor, 1)
  assert.equal(battle.defenseFactor, 1 + DEFENDER_BONUS)
  assert.equal(battle.attackerWins, true)
  // 37 * 1.0 - 20 * 1.1 = 15 surviving ships
  assert.equal(battle.survivors, 15)
})

test('defenders hold when they outnumber the attackers', () => {
  const neutral = () => 0.5
  const battle = resolveBattle(10, 30, neutral)
  assert.equal(battle.attackerWins, false)
  // (33 - 10) / 1.1 = 20.9 -> 21 remaining defenders
  assert.equal(battle.survivors, 21)
})

test('combat factors always stay inside the specified range', () => {
  const rng = createRng(4711)
  for (let i = 0; i < 1000; i++) {
    const battle = resolveBattle(50, 40, rng)
    assert.ok(battle.attackFactor >= 0.7 && battle.attackFactor <= 1.3)
    assert.ok(battle.defenseFactor >= 0.8 && battle.defenseFactor <= 1.4)
    assert.ok(battle.survivors >= 0)
    assert.ok(battle.attackerWins ? battle.survivors <= 50 : battle.survivors <= 40)
  }
})

test('galaxy generation is deterministic and well formed', () => {
  const config = { planetCount: 99, mapWidth: 1000, mapHeight: 1000, seed: 12345 }
  const a = generateGalaxy(config)
  const b = generateGalaxy(config)

  assert.deepEqual(a, b, 'same seed must produce the same galaxy')
  assert.equal(a.length, 99)
  assert.equal(new Set(a.map(p => p.name)).size, 99, 'planet names must be unique')
  assert.deepEqual(a.map(p => p.number), Array.from({ length: 99 }, (_, i) => i + 1))

  for (const planet of a) {
    assert.ok(planet.x >= 0 && planet.x < 1000)
    assert.ok(planet.y >= 0 && planet.y < 1000)
    assert.ok(planet.production >= 1 && planet.production <= 10)
    assert.ok(planet.natives >= 0)
  }
})

test('home planets are spread out, native free and equally productive', () => {
  const config = { planetCount: 99, mapWidth: 1000, mapHeight: 1000, seed: 999 }
  const planets = generateGalaxy(config)
  const homes = assignHomePlanets(planets, 4, config)

  assert.equal(homes.length, 4)
  assert.equal(new Set(homes.map(h => h.number)).size, 4)
  for (const home of homes) {
    assert.equal(home.natives, 0)
    assert.equal(home.production, 10)
  }

  // No two home planets sit next to each other.
  for (let i = 0; i < homes.length; i++) {
    for (let j = i + 1; j < homes.length; j++) {
      const d = torusDistance(homes[i], homes[j], 1000, 1000)
      assert.ok(d > 150, `home planets too close: ${d}`)
    }
  }
})

/**
 * HANA hands out DECIMAL as a JSON string to keep full precision, sqlite does
 * not. `"1188.84" + 230.74` then concatenates instead of adding and the SVG
 * drops the route line to 0/0 - visible only on BTP, never locally.
 */
test('the client turns OData decimals into numbers', async () => {
  const responses = new Map()
  const original = globalThis.fetch

  globalThis.fetch = async url => {
    const body = [...responses].find(([path]) => String(url).includes(path))?.[1] ?? {}
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => body
    }
  }

  try {
    const { api } = await import('../app/js/api.js')

    responses.set('starMap', { value: [{ number: 1, x: '1188.84', y: '95.75' }] })
    const [planet] = await api.starMap('g')
    assert.equal(typeof planet.x, 'number')
    assert.equal(planet.x, 1188.84)
    assert.equal(planet.y, 95.75)

    responses.set('route', { distance: '230.74', turns: 2 })
    assert.equal((await api.route('g', 1, 2)).distance, 230.74)

    responses.set('MyFleets', { value: [{ ID: 'f', ships: 7, distance: '12.50' }] })
    assert.equal((await api.fleets('g'))[0].distance, 12.5)

    responses.set('Games(', { ID: 'g', shipSpeed: '120.00' })
    assert.equal((await api.game('g')).shipSpeed, 120)
  } finally {
    globalThis.fetch = original
  }
})

test('drift moves a planet one step and wraps it around the torus', () => {
  const { driftPosition, wrapCoordinate } = require('../srv/lib/geometry')

  assert.deepEqual(driftPosition({ x: 100, y: 200, vx: 5, vy: -2.5 }, 1000, 1000), { x: 105, y: 197.5 })

  // Coordinates arrive from the database as strings (cds10 ieee754compatible);
  // adding them without coercion would concatenate.
  assert.deepEqual(driftPosition({ x: '100.50', y: '200.25', vx: '5.00', vy: '0.25' }, 1000, 1000),
    { x: 105.5, y: 200.5 })

  // Leaving one edge re-enters on the other.
  assert.deepEqual(driftPosition({ x: 998, y: 2, vx: 5, vy: -5 }, 1000, 1000), { x: 3, y: 997 })
  assert.equal(wrapCoordinate(-1, 1000), 999)
  assert.equal(wrapCoordinate(1000, 1000), 0)

  // A planet without a velocity stays put, whatever the column default was.
  assert.deepEqual(driftPosition({ x: 10, y: 20 }, 1000, 1000), { x: 10, y: 20 })
  assert.deepEqual(driftPosition({ x: 10, y: 20, vx: 0, vy: 0 }, 1000, 1000), { x: 10, y: 20 })
})

test('drift velocities are seeded, bounded and do not disturb the placement', () => {
  const { generateGalaxy } = require('../srv/lib/galaxy')
  const args = { planetCount: 20, mapWidth: 800, mapHeight: 800, seed: 4242 }

  const a = generateGalaxy({ ...args, planetDrift: 6 })
  const b = generateGalaxy({ ...args, planetDrift: 6 })
  assert.deepEqual(a, b, 'same seed, same galaxy including velocities')

  assert.ok(a.every(p => Math.hypot(p.vx, p.vy) <= 6.02), 'no planet drifts faster than planetDrift')
  assert.ok(a.some(p => Math.hypot(p.vx, p.vy) > 1), 'planets actually move')
  assert.ok(new Set(a.map(p => `${p.vx}/${p.vy}`)).size > 1, 'headings differ, the map shears')

  const still = generateGalaxy({ ...args, planetDrift: 0 })
  assert.ok(still.every(p => p.vx === 0 && p.vy === 0), 'drift 0 keeps the galaxy static')
  assert.ok(still.every((p, i) => p.x === a[i].x && p.y === a[i].y),
    'drift does not shift the placement RNG stream')
})

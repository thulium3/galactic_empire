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

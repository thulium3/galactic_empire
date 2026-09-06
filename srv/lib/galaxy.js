'use strict'

const { createRng, mixSeed } = require('./rng')
const { torusDistance } = require('./geometry')
const { PLANET_NAMES } = require('./names')

const HOME_PRODUCTION = 10
const MAX_PLACEMENT_TRIES = 200

/**
 * Builds the star map: unique names, spread out positions on the torus,
 * production rate, native population and drift velocity per planet.
 *
 * @returns {Array<{number,name,x,y,vx,vy,production,natives}>}
 */
function generateGalaxy ({ planetCount, mapWidth, mapHeight, seed, planetDrift = 0 }) {
  const rng = createRng(seed)
  const names = shuffle([...PLANET_NAMES], rng)
  if (names.length < planetCount) throw new Error(`Only ${names.length} planet names available for ${planetCount} planets`)

  const minDistance = 0.55 * Math.sqrt((mapWidth * mapHeight) / planetCount)
  const planets = []

  for (let i = 0; i < planetCount; i++) {
    const position = findFreePosition(planets, minDistance, mapWidth, mapHeight, rng)
    const production = rng.int(1, 10)
    planets.push({
      number: i + 1,
      name: names[i],
      x: round2(position.x),
      y: round2(position.y),
      production,
      // Richer planets are better defended; ~35% of the galaxy is uninhabited.
      natives: rng() < 0.35 ? 0 : Math.max(1, Math.round(production * rng.between(1.5, 6)))
    })
  }
  assignDrift(planets, planetDrift, seed)
  return planets
}

/**
 * Gives every planet a fixed heading and speed, so the galaxy slowly rearranges
 * itself. Uses its own RNG stream derived from the seed: adding drift must not
 * shift the placement stream, or the same seed would produce a different map
 * than before.
 *
 * Speeds vary per planet so the map shears instead of sliding as one block.
 */
function assignDrift (planets, planetDrift, seed) {
  const drift = Number(planetDrift) || 0
  const rng = createRng(mixSeed(seed ?? 1, 0x0d21f7))

  for (const planet of planets) {
    if (drift <= 0) {
      planet.vx = 0
      planet.vy = 0
      continue
    }
    const heading = rng() * 2 * Math.PI
    const speed = drift * rng.between(0.3, 1)
    planet.vx = round2(Math.cos(heading) * speed)
    planet.vy = round2(Math.sin(heading) * speed)
  }
  return planets
}

/**
 * Picks home planets that are as far apart as possible (greedy farthest-point).
 * Home planets are cleared of natives and normalized to a fair production rate.
 */
function assignHomePlanets (planets, playerCount, { mapWidth, mapHeight, seed }) {
  if (playerCount > planets.length) throw new Error('More players than planets')
  const rng = createRng(seed ^ 0x5f3759df)
  const chosen = [planets[rng.int(0, planets.length - 1)]]

  while (chosen.length < playerCount) {
    let best = null
    let bestDistance = -1
    for (const planet of planets) {
      if (chosen.includes(planet)) continue
      const nearest = Math.min(...chosen.map(c => torusDistance(planet, c, mapWidth, mapHeight)))
      if (nearest > bestDistance) {
        bestDistance = nearest
        best = planet
      }
    }
    chosen.push(best)
  }

  for (const planet of chosen) {
    planet.natives = 0
    planet.production = HOME_PRODUCTION
  }
  return chosen
}

function findFreePosition (placed, minDistance, mapWidth, mapHeight, rng) {
  let relaxed = minDistance
  for (let attempt = 0; attempt < MAX_PLACEMENT_TRIES; attempt++) {
    const candidate = { x: rng() * mapWidth, y: rng() * mapHeight }
    const tooClose = placed.some(p => torusDistance(candidate, p, mapWidth, mapHeight) < relaxed)
    if (!tooClose) return candidate
    // Give up gradually instead of looping forever on dense maps.
    if (attempt % 20 === 19) relaxed *= 0.9
  }
  return { x: rng() * mapWidth, y: rng() * mapHeight }
}

function shuffle (array, rng) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = rng.int(0, i)
    ;[array[i], array[j]] = [array[j], array[i]]
  }
  return array
}

function round2 (value) {
  return Math.round(value * 100) / 100
}

module.exports = { generateGalaxy, assignHomePlanets, assignDrift, HOME_PRODUCTION }

'use strict'

const { findFreePosition, driftVelocity, spacing, round2 } = require('./galaxy')
const { torusDistance, travelTurns } = require('./geometry')
const { PLANET_NAMES } = require('./names')

/**
 * Optional special rules. Every one of them is driven by a probability on the
 * game and does nothing at all when that probability is 0, so a plain game
 * behaves exactly as it did before these rules existed.
 *
 * All rolls come from the turn RNG, which is seeded with `seed` + turn number:
 * the same game replays into the same anomalies.
 */

/** A newborn star is uninhabited - nothing had time to settle there yet. */
const NEWBORN_NATIVES = 0

/**
 * How many of the planets nearest to the lost target a thrown off fleet may end
 * up on. Keeping it small means a fleet drifts off course, it does not get
 * catapulted across the galaxy.
 */
const DIVERSION_NEIGHBOURS = 3

/**
 * Rolls for a new star igniting in the void between the existing ones.
 *
 * Returns the planet to insert, or null if nothing happened. The caller owns
 * the persistence - this function only decides what the new star looks like.
 *
 * @param {object[]} planets  the galaxy as it stands after this turn's drift
 */
function igniteStar ({ planets, game, rng }) {
  const chance = Number(game.starBirthChance) || 0
  if (chance <= 0 || rng() >= chance) return null

  const live = planets.filter(p => !p.destroyed)
  const position = findFreePosition(live, spacing(live.length + 1, game.mapWidth, game.mapHeight),
    game.mapWidth, game.mapHeight, rng)

  return {
    number: Math.max(0, ...planets.map(p => p.number)) + 1,
    name: freeName(planets, rng),
    x: round2(position.x),
    y: round2(position.y),
    production: rng.int(1, 10),
    natives: NEWBORN_NATIVES,
    ...driftVelocity(game.planetDrift, rng)
  }
}

/**
 * An unused name from the pool. Stars may be born long after the pool is spent,
 * so there is a numbered fallback - a name is required and must stay unique.
 */
function freeName (planets, rng) {
  const taken = new Set(planets.map(p => p.name))
  const free = PLANET_NAMES.filter(name => !taken.has(name))
  if (free.length) return rng.pick(free)

  for (let i = 1; ; i++) {
    const name = `Nova ${i}`
    if (!taken.has(name)) return name
  }
}


/**
 * Rolls for a supernova and returns the planet it wipes out, or null.
 *
 * Every star is fair game, home worlds included: whoever sits there loses the
 * garrison, the stockpile and the planet, and may well be eliminated by it.
 */
function pickSupernova ({ planets, game, rng }) {
  const chance = Number(game.supernovaChance) || 0
  if (chance <= 0 || rng() >= chance) return null

  const live = planets.filter(p => !p.destroyed)
  return live.length ? rng.pick(live) : null
}

/**
 * Where a fleet that lost its course ends up: one of the planets closest to the
 * target it was aiming at, picked at random. Returns null when there is nothing
 * left to divert it to.
 *
 * Ties are broken by ID so the pick stays reproducible - two planets at exactly
 * the same distance must not depend on the order the database handed them out.
 */
function divertTarget ({ target, planets, game, rng }) {
  const neighbours = planets
    .filter(p => !p.destroyed && p.ID !== target.ID)
    .map(p => ({ planet: p, detour: torusDistance(p, target, game.mapWidth, game.mapHeight) }))
    .sort((a, b) => a.detour - b.detour || String(a.planet.ID).localeCompare(String(b.planet.ID)))
    .slice(0, DIVERSION_NEIGHBOURS)

  return neighbours.length ? rng.pick(neighbours) : null
}

/**
 * The turn a diverted fleet now lands on. It first flies the leg it was already
 * on and then the detour, so being thrown off course always costs time - never
 * less than one extra turn, whatever the geometry says.
 */
function divertedArrival ({ fleet, detour, game, nextTurn }) {
  return Math.max(nextTurn, fleet.arrivalTurn) + travelTurns(detour, Number(game.shipSpeed))
}

module.exports = {
  igniteStar, pickSupernova, divertTarget, divertedArrival,
  NEWBORN_NATIVES, DIVERSION_NEIGHBOURS
}

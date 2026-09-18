'use strict'

const { findFreePosition, driftVelocity, spacing, round2 } = require('./galaxy')
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

module.exports = { igniteStar, NEWBORN_NATIVES }

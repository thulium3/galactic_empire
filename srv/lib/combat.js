'use strict'

const FACTOR_MIN = 0.7
const FACTOR_MAX = 1.3
const DEFENDER_BONUS = 0.1

/**
 * Resolves one battle between an incoming fleet and the defenders of a planet.
 *
 *   attackPower  = attackers * attackFactor
 *   defensePower = defenders * (defenseFactor + DEFENDER_BONUS)
 *
 * Both factors are rolled per battle in [0.7, 1.3]. The winner keeps the
 * surviving share of his own units, the loser is wiped out.
 *
 * @param {number} attackers  incoming ships
 * @param {number} defenders  stationed ships or natives
 * @param {function} rng      seeded random source, () => [0,1)
 */
function resolveBattle (attackers, defenders, rng) {
  const attackFactor = FACTOR_MIN + rng() * (FACTOR_MAX - FACTOR_MIN)
  const defenseFactor = FACTOR_MIN + rng() * (FACTOR_MAX - FACTOR_MIN) + DEFENDER_BONUS

  const attackPower = attackers * attackFactor
  const defensePower = defenders * defenseFactor

  const result = {
    attackers,
    defenders,
    attackFactor: round2(attackFactor),
    defenseFactor: round2(defenseFactor),
    attackPower: round2(attackPower),
    defensePower: round2(defensePower)
  }

  if (attackPower > defensePower) {
    const survivors = Math.max(1, Math.round((attackPower - defensePower) / attackFactor))
    return { ...result, attackerWins: true, survivors: Math.min(survivors, attackers) }
  }

  const survivors = Math.max(0, Math.round((defensePower - attackPower) / defenseFactor))
  return { ...result, attackerWins: false, survivors: Math.min(survivors, defenders) }
}

function round2 (value) {
  return Math.round(value * 100) / 100
}

module.exports = { resolveBattle, FACTOR_MIN, FACTOR_MAX, DEFENDER_BONUS }

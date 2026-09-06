'use strict'

/**
 * The galaxy is a torus: leaving the map on the left re-enters on the right,
 * top wraps to bottom. Distances always take the shorter way around.
 */
function wrappedDelta (a, b, size) {
  const raw = Math.abs(a - b)
  return Math.min(raw, size - raw)
}

function torusDistance (from, to, width, height) {
  const dx = wrappedDelta(Number(from.x), Number(to.x), width)
  const dy = wrappedDelta(Number(from.y), Number(to.y), height)
  return Math.sqrt(dx * dx + dy * dy)
}

/** Turns needed to cover `distance` at `speed` units per turn (at least 1). */
function travelTurns (distance, speed) {
  return Math.max(1, Math.ceil(distance / speed))
}

/** Folds a coordinate back onto the map - leaving one edge re-enters the other. */
function wrapCoordinate (value, size) {
  return ((value % size) + size) % size
}

/**
 * One turn of drift. Positions are `Decimal`, which cds hands out as strings,
 * so everything is coerced before it is added - `"1188.84" + 5` would
 * concatenate. Rounded to two decimals to match the column and to keep float
 * noise from accumulating over hundreds of turns.
 */
function driftPosition (planet, mapWidth, mapHeight) {
  return {
    x: round2(wrapCoordinate(Number(planet.x) + Number(planet.vx ?? 0), mapWidth)),
    y: round2(wrapCoordinate(Number(planet.y) + Number(planet.vy ?? 0), mapHeight))
  }
}

const round2 = value => Math.round(value * 100) / 100

module.exports = { wrappedDelta, torusDistance, travelTurns, wrapCoordinate, driftPosition }

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

module.exports = { wrappedDelta, torusDistance, travelTurns }

'use strict'

/**
 * Deterministic PRNG (mulberry32). Same seed => same galaxy and same combat rolls,
 * which makes turns reproducible and testable.
 */
function createRng (seed) {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  next.between = (min, max) => min + next() * (max - min)
  next.int = (min, max) => Math.floor(next.between(min, max + 1))
  next.pick = arr => arr[next.int(0, arr.length - 1)]
  return next
}

/** Mixes two integers into a new seed, e.g. game seed + turn number. */
function mixSeed (a, b) {
  return (Math.imul(a >>> 0, 0x9E3779B1) ^ Math.imul(b >>> 0, 0x85EBCA77)) >>> 0
}

module.exports = { createRng, mixSeed }

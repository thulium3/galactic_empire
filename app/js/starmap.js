'use strict'

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Shortest signed difference on a wrapping axis - the world is a torus. */
export function shortestDelta (from, to, size) {
  let delta = to - from
  if (delta > size / 2) delta -= size
  if (delta < -size / 2) delta += size
  return delta
}

/**
 * A straight line on a torus can leave the map on one side and come back on the
 * other. Drawing both halves and clipping to the map makes it look continuous.
 */
function torusSegments (from, to, width, height) {
  const dx = shortestDelta(from.x, to.x, width)
  const dy = shortestDelta(from.y, to.y, height)
  return [
    { x1: from.x, y1: from.y, x2: from.x + dx, y2: from.y + dy },
    { x1: to.x - dx, y1: to.y - dy, x2: to.x, y2: to.y }
  ]
}

/** Position of a fleet at `progress` (0..1) along its wrapped route. */
function positionOnRoute (from, to, progress, width, height) {
  const dx = shortestDelta(from.x, to.x, width)
  const dy = shortestDelta(from.y, to.y, height)
  return {
    x: ((from.x + dx * progress) % width + width) % width,
    y: ((from.y + dy * progress) % height + height) % height
  }
}

function el (name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name)
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) node.setAttribute(key, value)
  }
  return node
}

/** Dark text on light planets, light text on dark ones. */
function isDark (hex) {
  const value = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255]
  return (0.299 * r + 0.587 * g + 0.114 * b) < 140
}

export class StarMap {
  #svg
  #layers = {}
  #handlers
  #size = { width: 1000, height: 1000 }

  constructor (svg, handlers = {}) {
    this.#svg = svg
    this.#handlers = handlers
  }

  configure ({ mapWidth, mapHeight }) {
    this.#size = { width: mapWidth, height: mapHeight }
    this.#svg.setAttribute('viewBox', `0 0 ${mapWidth} ${mapHeight}`)
    this.#svg.replaceChildren()

    // Everything is clipped to the map, so wrapped route halves stop at the edge.
    const defs = el('defs')
    const clip = el('clipPath', { id: 'map-clip' })
    clip.append(el('rect', { x: 0, y: 0, width: mapWidth, height: mapHeight }))
    defs.append(clip)
    this.#svg.append(defs)

    const world = el('g', { 'clip-path': 'url(#map-clip)' })
    for (const name of ['routes', 'preview', 'planets', 'fleets']) {
      this.#layers[name] = el('g')
      world.append(this.#layers[name])
    }
    this.#svg.append(world)

    // The dashed border marks the seam - crossing it comes back on the far side.
    this.#svg.append(el('rect', {
      class: 'map-edge', x: 1, y: 1, width: mapWidth - 2, height: mapHeight - 2
    }))
  }

  /** Full redraw - at 99 planets this is cheaper than diffing. */
  draw ({ planets, fleets = [], currentTurn = 1, selection = {}, preview = null }) {
    this.#drawFleetRoutes(fleets, planets)
    this.#drawPreview(preview)
    this.#drawPlanets(planets, selection)
    this.#drawFleets(fleets, planets, currentTurn)
  }

  #drawPlanets (planets, selection) {
    const layer = this.#layers.planets
    layer.replaceChildren()

    for (const planet of planets) {
      const explored = planet.explored
      const radius = explored ? 8 + Math.min(planet.production ?? 0, 10) * 0.55 : 8
      const classes = ['planet']
      if (!explored) classes.push('unexplored')
      if (planet.mine) classes.push('mine')
      if (planet.number === selection.origin) classes.push('selected')
      if (planet.number === selection.target) classes.push('target')

      // A planet near the seam is drawn again on the far side, so the half that
      // the clip cuts off reappears where it belongs on a torus.
      for (const [dx, dy] of this.#wrapOffsets(planet, radius)) {
        const group = el('g', {
          class: classes.join(' ') + (dx || dy ? ' ghost' : ''),
          transform: `translate(${planet.x + dx} ${planet.y + dy})`
        })
        group.append(el('circle', { class: 'planet-body', r: radius, fill: planet.color }))

        const label = el('text', { class: `planet-num${isDark(planet.color) ? ' faint' : ''}` })
        label.textContent = planet.number
        group.append(label)

        group.addEventListener('mouseenter', event => this.#handlers.onEnter?.(planet, event))
        group.addEventListener('mousemove', event => this.#handlers.onMove?.(planet, event))
        group.addEventListener('mouseleave', () => this.#handlers.onLeave?.(planet))
        group.addEventListener('click', event => {
          event.stopPropagation()
          this.#handlers.onClick?.(planet)
        })
        layer.append(group)
      }
    }
  }

  /** [0,0] plus one offset per seam the planet overlaps, corners included. */
  #wrapOffsets (planet, radius) {
    const { width, height } = this.#size
    const margin = radius + 4
    const offsets = [[0, 0]]
    const dx = planet.x < margin ? width : (planet.x > width - margin ? -width : 0)
    const dy = planet.y < margin ? height : (planet.y > height - margin ? -height : 0)

    if (dx) offsets.push([dx, 0])
    if (dy) offsets.push([0, dy])
    if (dx && dy) offsets.push([dx, dy])
    return offsets
  }

  #drawFleetRoutes (fleets, planets) {
    const layer = this.#layers.routes
    layer.replaceChildren()
    const byNumber = new Map(planets.map(p => [p.number, p]))

    for (const fleet of fleets) {
      const from = byNumber.get(fleet.originNumber)
      const to = byNumber.get(fleet.destinationNumber)
      if (!from || !to) continue
      for (const segment of torusSegments(from, to, this.#size.width, this.#size.height)) {
        layer.append(el('line', { class: 'fleet-path', stroke: fleet.color ?? '#4ea3ff', ...segment }))
      }
    }
  }

  #drawFleets (fleets, planets, currentTurn) {
    const layer = this.#layers.fleets
    layer.replaceChildren()
    const byNumber = new Map(planets.map(p => [p.number, p]))

    for (const fleet of fleets) {
      const from = byNumber.get(fleet.originNumber)
      const to = byNumber.get(fleet.destinationNumber)
      if (!from || !to) continue

      const total = fleet.arrivalTurn - fleet.departureTurn
      const progress = total > 0 ? Math.min(1, Math.max(0, (currentTurn - fleet.departureTurn) / total)) : 1
      const at = positionOnRoute(from, to, progress, this.#size.width, this.#size.height)
      const color = fleet.color ?? '#4ea3ff'

      const group = el('g', { transform: `translate(${at.x} ${at.y})` })
      group.append(el('circle', { class: 'fleet-marker', r: 7, fill: color }))
      const label = el('text', { class: 'fleet-label' })
      label.textContent = fleet.ships
      group.append(label)
      const title = el('title')
      title.textContent = `${fleet.ships} ships, #${fleet.originNumber} -> #${fleet.destinationNumber}, arrives turn ${fleet.arrivalTurn}`
      group.append(title)
      layer.append(group)
    }
  }

  /** Dashed line for the route the player is about to order. */
  #drawPreview (preview) {
    const layer = this.#layers.preview
    layer.replaceChildren()
    if (!preview) return
    for (const segment of torusSegments(preview.from, preview.to, this.#size.width, this.#size.height)) {
      layer.append(el('line', { class: 'route', ...segment }))
    }
  }
}

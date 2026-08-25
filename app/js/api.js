'use strict'

const ODATA = '/odata/v4/game'

let authHeader = null
let currentUser = null

export function login (user) {
  currentUser = user
  authHeader = 'Basic ' + btoa(`${user}:`)
}

export function logout () {
  currentUser = null
  authHeader = null
}

export const user = () => currentUser

export class ApiError extends Error {
  constructor (status, message) {
    super(message)
    this.status = status
  }
}

async function call (path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: {
      Authorization: authHeader,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`
    try {
      const payload = await response.json()
      message = payload?.error?.message ?? message
    } catch { /* not a JSON error body */ }
    throw new ApiError(response.status, message)
  }
  return response.status === 204 ? null : response.json()
}

const action = (name, payload) => call(`${ODATA}/${name}`, { method: 'POST', body: payload })

const fn = (name, params) => {
  const args = Object.entries(params).map(([key, value]) => `${key}=${value}`).join(',')
  return call(`${ODATA}/${name}(${args})`)
}

const list = (entity, query) => call(`${ODATA}/${entity}?${query}`).then(r => r.value)

export const api = {
  // lobby
  openGames: () => list('Games', "$filter=status ne 'FINISHED'&$expand=players($select=name,color)&$orderby=createdAt desc"),
  game: id => call(`${ODATA}/Games(${id})`),
  participants: game => list('Participants', `$filter=game_ID eq ${game}&$orderby=createdAt`),
  myGames: () => list('MyPlayers', '$select=game_ID').then(rows => new Set(rows.map(r => r.game_ID))),
  createGame: settings => action('createGame', settings).then(r => r.value),
  joinGame: (game, name) => action('joinGame', { game, name }).then(r => r.value),
  startGame: game => action('startGame', { game }).then(r => r.value),

  // in game
  me: game => list('MyPlayers', `$filter=game_ID eq ${game}`).then(rows => rows[0] ?? null),
  starMap: game => fn('starMap', { game }).then(r => r.value),
  route: (game, origin, destination) => fn('route', { game, origin, destination }),
  fleets: game => list('MyFleets', `$filter=game_ID eq ${game}&$orderby=arrivalTurn`),
  reports: game => list('MyMessages', `$filter=game_ID eq ${game}&$orderby=turn desc&$top=60`),
  sendFleet: (game, origin, destination, ships) => action('sendFleet', { game, origin, destination, ships }),
  buildShips: (game, planet, ships) => action('buildShips', { game, planet, ships }).then(r => r.value),
  endTurn: game => action('endTurn', { game })
}

/**
 * Server-Sent Events over fetch instead of EventSource: EventSource cannot send
 * an Authorization header. Reconnects on its own, like EventSource would.
 */
export function openEventStream (game, handlers) {
  let stopped = false
  let controller = null

  async function loop () {
    while (!stopped) {
      try {
        controller = new AbortController()
        const response = await fetch(`/events?game=${game}`, {
          headers: { Authorization: authHeader, Accept: 'text/event-stream' },
          signal: controller.signal
        })
        if (!response.ok) throw new ApiError(response.status, `event stream refused (${response.status})`)
        await consume(response.body, handlers)
      } catch (err) {
        if (stopped) return
        handlers.error?.(err)
      }
      if (stopped) return
      await new Promise(resolve => setTimeout(resolve, 3000))
    }
  }

  loop()
  return () => { stopped = true; controller?.abort() }
}

async function consume (body, handlers) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true })

    let boundary
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const name = block.match(/^event: (.+)$/m)?.[1]
      const data = block.match(/^data: (.+)$/m)?.[1]
      if (!name) continue // comment or retry hint
      handlers[name]?.(data ? JSON.parse(data) : null)
    }
  }
}

'use strict'

const ODATA = '/odata/v4/game'

let authHeader = null      // dev only: mocked basic auth
let sessionAuth = false    // production: identity comes from the approuter
let currentUser = null
let csrfToken = null

/** Dev login against CAP's mocked users. */
export function login (user) {
  currentUser = user
  sessionAuth = false
  authHeader = 'Basic ' + btoa(`${user}:`)
}

/**
 * Production: the approuter already authenticated the request and forwards a
 * JWT. We must not send an Authorization header of our own - the session
 * cookie carries the identity.
 */
export function useSessionAuth (name) {
  currentUser = name
  sessionAuth = true
  authHeader = null
}

export function logout () {
  currentUser = null
  authHeader = null
  sessionAuth = false
  csrfToken = null
}

export const user = () => currentUser
export const isSessionAuth = () => sessionAuth

/**
 * Decides how we authenticate.
 *
 * We ask the approuter's user API, and *only* that: it answers 404 when it is
 * not there, which is harmless. Probing a protected OData path instead would
 * earn a 401 with `WWW-Authenticate: Basic`, and the browser answers that with
 * a modal login dialog that swallows every mouse event on the page.
 *
 * If this misfires we fall back to the dev login, which still works behind the
 * approuter - the session carries the identity and `ensureCsrfToken` runs
 * regardless of what we concluded here.
 *
 * Returns null when the dev login is needed, else `{ name }` (name may be null).
 */
export async function detectSession () {
  try {
    const response = await fetch('/user-api/currentUser', { headers: { Accept: 'application/json' } })
    if (!response.ok) return null
    const info = await response.json()
    const name = [info.firstname, info.lastname].filter(Boolean).join(' ') || info.name || info.email || null
    return { name }
  } catch {
    return null
  }
}

export class ApiError extends Error {
  constructor (status, message) {
    super(message)
    this.status = status
  }
}

const authHeaders = () => (authHeader ? { Authorization: authHeader } : {})

/**
 * The approuter rejects unsafe methods without a matching CSRF token. We always
 * try to fetch one: where nothing hands one out (local dev) we send none, so a
 * wrong guess about the environment cannot break every POST.
 */
async function ensureCsrfToken (force = false) {
  if (csrfToken && !force) return csrfToken
  const response = await fetch(`${ODATA}/`, {
    headers: { ...authHeaders(), Accept: 'application/json', 'x-csrf-token': 'fetch' }
  })
  csrfToken = response.headers.get('x-csrf-token')
  return csrfToken
}

async function call (path, { method = 'GET', body, retry = true } = {}) {
  const unsafe = method !== 'GET'
  const token = unsafe ? await ensureCsrfToken() : null

  const response = await fetch(path, {
    method,
    headers: {
      ...authHeaders(),
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { 'x-csrf-token': token } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })

  // A stale token after a session refresh: fetch a new one and try once more.
  if (response.status === 403 && unsafe && retry &&
      (response.headers.get('x-csrf-token') ?? '').toLowerCase() === 'required') {
    await ensureCsrfToken(true)
    return call(path, { method, body, retry: false })
  }

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

/**
 * OData v4 serializes `Decimal` as a JSON *string* to keep full precision.
 * Everything downstream does arithmetic with these values, where a string
 * silently concatenates instead of adding, so they are coerced right here at
 * the boundary. Never let a raw decimal escape into the view layer.
 */
const num = value => (value === null || value === undefined ? value : Number(value))

const planetCoords = planet => ({ ...planet, x: num(planet.x), y: num(planet.y) })

export const api = {
  // lobby
  openGames: () => list('Games', "$filter=status ne 'FINISHED'&$expand=players($select=name,color)&$orderby=createdAt desc"),
  game: id => call(`${ODATA}/Games(${id})`)
    .then(g => ({ ...g, shipSpeed: num(g.shipSpeed), planetDrift: num(g.planetDrift) })),
  participants: game => list('Participants', `$filter=game_ID eq ${game}&$orderby=createdAt`),
  /** The caller's games plus the principal id behind them - needed to spot own games. */
  myGames: () => list('MyPlayers', '$select=game_ID,user').then(rows => ({
    games: new Set(rows.map(r => r.game_ID)),
    user: rows[0]?.user ?? null
  })),
  createGame: settings => action('createGame', settings).then(r => r.value),
  joinGame: (game, name) => action('joinGame', { game, name }).then(r => r.value),
  startGame: game => action('startGame', { game }).then(r => r.value),
  deleteGame: game => action('deleteGame', { game }).then(r => r.value),

  // in game
  me: game => list('MyPlayers', `$filter=game_ID eq ${game}`).then(rows => rows[0] ?? null),
  starMap: game => fn('starMap', { game }).then(r => r.value.map(planetCoords)),
  route: (game, origin, destination) => fn('route', { game, origin, destination })
    .then(r => ({ ...r, distance: num(r.distance) })),
  fleets: game => list('MyFleets', `$filter=game_ID eq ${game}&$orderby=arrivalTurn`)
    .then(rows => rows.map(f => ({ ...f, distance: num(f.distance) }))),
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
          headers: { ...authHeaders(), Accept: 'text/event-stream' },
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

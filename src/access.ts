import type { CollectionSlug, Payload, PayloadRequest, Where } from 'payload'

import type { ResolvedMembership } from './types.js'

/** Only an answer of exactly `true` passes; anything else, a thrown error included, is no. */
export async function exactlyTrue(check: () => unknown): Promise<boolean> {
  try {
    return (await check()) === true
  } catch {
    return false
  }
}

const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

const scalar = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v)
const scalars = (v: unknown, minimum: number) => Array.isArray(v) && v.length >= minimum && v.every(scalar)
const nonEmptyText = (v: unknown) => typeof v === 'string' && v.length > 0
const number = (v: unknown) => typeof v === 'number' || typeof v === 'string'

/**
 * The operators the plugin accepts, each with a check on its value. An unknown operator (a typo
 * such as `equal`) is refused rather than ignored, because Payload ignores some unknown operators
 * on writes. Values that would match every row, such as an empty `like` or an empty `not_in`, are refused.
 */
const OPERATORS: Record<string, (v: unknown) => boolean> = {
  equals: scalar,
  not_equals: scalar,
  in: (v) => scalars(v, 0), // an empty list matches nothing
  not_in: (v) => scalars(v, 1),
  all: (v) => scalars(v, 1),
  exists: (v) => typeof v === 'boolean',
  greater_than: number,
  greater_than_equal: number,
  less_than: number,
  less_than_equal: number,
  like: nonEmptyText,
  contains: nonEmptyText,
}

/**
 * A usable query: a plain object with at least one key, where `and`/`or` hold non-empty lists of
 * usable queries and every field key holds a non-empty plain object of known operators with
 * sensible values. `{}` matches every row, so it is not usable: a host that means "all" returns `true`.
 */
export function usableWhere(w: unknown, depth = 0): w is Where {
  if (!isPlain(w) || depth > 8) return false
  const keys = Object.keys(w)
  if (!keys.length) return false
  return keys.every((k) => {
    const v = w[k]
    if (k === 'and' || k === 'or') return Array.isArray(v) && v.length > 0 && v.every((x) => usableWhere(x, depth + 1))
    if (!isPlain(v)) return false
    const ops = Object.entries(v)
    return ops.length > 0 && ops.every(([op, arg]) => Object.hasOwn(OPERATORS, op) && OPERATORS[op]!(arg))
  })
}

/**
 * What a manager may reach: `true` (everything), a query (only the rows it matches), or `null` (nothing).
 * Only an exact `true` or a usable query counts, and a query must also run against the memberships
 * collection (an unknown field makes it a no). Everything else, a throw or rejection included,
 * and anyone not signed in, is `null`.
 */
export type ManagerScope = true | Where | null

export async function managerScope(o: Pick<ResolvedMembership, 'canManage' | 'memberships'>, req: PayloadRequest): Promise<ManagerScope> {
  if (!req.user) return null
  try {
    const answer: unknown = await o.canManage({ req })
    if (answer === true) return true
    if (!usableWhere(answer)) return null
    const checked = ((req.context as Record<string, unknown>).membershipWhereChecked ??= new Map<string, boolean>()) as Map<string, boolean>
    const key = JSON.stringify(answer)
    let ok = checked.get(key)
    if (ok === undefined) {
      try {
        await req.payload.count({ collection: o.memberships as CollectionSlug, where: answer, overrideAccess: true, req })
        ok = true
      } catch {
        ok = false
      }
      checked.set(key, ok)
    }
    return ok ? answer : null
  } catch {
    return null
  }
}

/** A manager of anything at all (a scope or all): for callers that go on to check a particular row. */
export async function isManager(o: Pick<ResolvedMembership, 'canManage' | 'memberships'>, req: PayloadRequest): Promise<boolean> {
  return (await managerScope(o, req)) !== null
}

/** The query as it applies to payments: written against memberships, so every field goes through `membership`. */
export function viaMembership(where: Where): Where {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(where)) {
    if (k === 'and' || k === 'or') out[k] = (v as Where[]).map(viaMembership)
    else out[k === 'id' ? 'membership' : `membership.${k}`] = v
  }
  return out as Where
}

const idOf = (v: unknown): unknown => (v && typeof v === 'object' && 'id' in v ? (v as { id: unknown }).id : v)
const same = (a: unknown, b: unknown) => a != null && b != null && String(idOf(a)) === String(idOf(b))

/**
 * Checks a query against data in memory (a row about to be created). Supports `equals`, `not_equals`,
 * `in`, `not_in`, `exists`, `and` and `or`; anything else is no, so an unknown operator fails closed.
 */
export function matchesWhere(where: Where, data: Record<string, unknown> | undefined): boolean {
  if (!data) return false
  return Object.entries(where).every(([k, v]) => {
    if (k === 'and') return (v as Where[]).every((x) => matchesWhere(x, data))
    if (k === 'or') return (v as Where[]).some((x) => matchesWhere(x, data))
    const value = data[k]
    return Object.entries(v as Record<string, unknown>).every(([op, arg]) => {
      switch (op) {
        case 'equals':
          return same(value, arg)
        case 'not_equals':
          return value != null && !same(value, arg)
        case 'in':
          return Array.isArray(arg) && arg.some((a) => same(value, a))
        case 'not_in':
          return value != null && Array.isArray(arg) && !arg.some((a) => same(value, a))
        case 'exists':
          return (value != null) === Boolean(arg)
        default:
          return false
      }
    })
  })
}

/**
 * Whether this manager may reach one row: `true` always, a query only when it matches that row
 * (checked against the database), nobody else. The answer is kept for the request.
 */
export async function managerReaches(
  o: Pick<ResolvedMembership, 'canManage' | 'memberships'>,
  req: PayloadRequest,
  collection: string,
  id: unknown,
  via: (w: Where) => Where = (w) => w,
): Promise<boolean> {
  const scope = await managerScope(o, req)
  if (scope === true) return true
  if (!scope || id == null || id === '') return false
  const cache = ((req.context as Record<string, unknown>).membershipReach ??= new Map<string, boolean>()) as Map<string, boolean>
  const key = `${collection}:${String(id)}:${JSON.stringify(scope)}`
  const known = cache.get(key)
  if (known !== undefined) return known
  let reached = false
  try {
    const found = await req.payload.count({
      collection: collection as CollectionSlug,
      where: { and: [{ id: { equals: id } }, via(scope)] } as Where,
      overrideAccess: true,
      req,
    })
    reached = found.totalDocs > 0
  } catch {
    reached = false
  }
  cache.set(key, reached)
  return reached
}

/** Checkout is allowed here: no `canCheckout`, or `canCheckout` answered exactly `true`. */
export const checkoutAllowed = (o: Pick<ResolvedMembership, 'canCheckout'>, payload: Payload): Promise<boolean> =>
  o.canCheckout ? exactlyTrue(() => o.canCheckout!({ payload })) : Promise.resolve(true)

import { APIError } from 'payload'
import type { CollectionBeforeOperationHook, CollectionConfig, Field, PayloadRequest } from 'payload'

import { managerScope, matchesWhere } from './access.js'
import type { ResolvedMembership } from './types.js'

/** How deep a write's data may nest before it is refused outright (fail closed). */
const MAX_DEPTH = 32

export const BAD_KEY_MESSAGE = 'Field names in a save can’t start with a dollar sign or contain a dot. Send each field by its plain name.'

/** A key that isn't a plain field name: a leading dollar sign, a dot or a NUL. */
const badKey = (k: string) => k.startsWith('$') || k.includes('.') || k.includes('\u0000')

/** The parts of a field config the scan needs, read loosely so every field type fits. */
type FieldLike = { name?: string; type: string; fields?: Field[]; tabs?: { name?: string; fields: Field[] }[]; blocks?: { slug: string; fields: Field[] }[]; blockReferences?: (string | { slug: string; fields: Field[] })[]; localized?: boolean }

/** The fields that store data at this level, looking through rows, collapsibles and unnamed tabs. */
function named(fields: Field[] | undefined): Map<string, FieldLike> {
  const out = new Map<string, FieldLike>()
  const walk = (list: Field[] | undefined) => {
    for (const f of (list ?? []) as unknown as FieldLike[]) {
      if (f.type === 'tabs') {
        for (const t of f.tabs ?? []) {
          if (t.name) out.set(t.name, { ...(t as unknown as FieldLike), type: 'group' })
          else walk(t.fields)
        }
      } else if ((f.type === 'row' || f.type === 'collapsible' || (f.type === 'group' && !f.name)) && f.fields) walk(f.fields)
      else if (f.name) out.set(f.name, f)
    }
  }
  walk(fields)
  return out
}

/**
 * Throws when any key in a save's data isn't a plain field name. Values of rich text and JSON fields are their own documents and are left alone; anything
 * the plugin can't place against the field config is checked all the way down.
 */
export function refuseBadKeys(data: unknown, fields: Field[] | null | undefined, req: PayloadRequest, depth = 0): void {
  if (depth > MAX_DEPTH) throw new APIError(BAD_KEY_MESSAGE, 400, undefined, true)
  if (Array.isArray(data)) {
    for (const item of data) refuseBadKeys(item, fields, req, depth + 1)
    return
  }
  if (!data || typeof data !== 'object') return
  const known = fields ? named(fields) : null
  const locales = req.payload.config.localization ? req.payload.config.localization.localeCodes : []
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (badKey(k)) throw new APIError(BAD_KEY_MESSAGE, 400, undefined, true)
    const field = known?.get(k)
    if (!field) {
      refuseBadKeys(v, null, req, depth + 1)
      continue
    }
    checkFieldValue(field, v, req, depth + 1, locales)
  }
}

function checkFieldValue(field: FieldLike, v: unknown, req: PayloadRequest, depth: number, locales: string[]): void {
  if (field.type === 'json' || field.type === 'richText') return
  // With every locale at once, a localized field holds one value per locale code.
  if (field.localized && v && typeof v === 'object' && !Array.isArray(v) && locales.length && Object.keys(v).length && Object.keys(v).every((k) => locales.includes(k))) {
    for (const each of Object.values(v)) checkFieldValue({ ...field, localized: false }, each, req, depth + 1, locales)
    return
  }
  if (field.type === 'group') return refuseBadKeys(v, field.fields, req, depth)
  if (field.type === 'array') return refuseBadKeys(v, field.fields, req, depth)
  if (field.type === 'blocks' && Array.isArray(v)) {
    for (const row of v) {
      const type = row && typeof row === 'object' ? (row as { blockType?: unknown }).blockType : undefined
      const blocks = [...(field.blocks ?? []), ...(field.blockReferences ?? []).map((b) => (typeof b === 'string' ? req.payload.config.blocks?.find((x) => x.slug === b) : b))]
      const block = blocks.find((b) => b && b.slug === type)
      refuseBadKeys(row, block ? block.fields : null, req, depth + 1)
    }
    return
  }
  refuseBadKeys(v, null, req, depth)
}

/**
 * Added at the front of the collection's `beforeOperation` hooks after the host's overrides, so it
 * sees the data as the request sent it, ahead of the collection's other hooks. A plugin that runs
 * after this one can still add a hook in front of it.
 *
 * - Create, update and duplicate, for every caller (server code with `overrideAccess` too): refuses
 *   keys that aren't plain field names.
 * - Restoring a version, for callers held to access rules: a manager limited to a scope may only
 *   restore a version that is itself inside their scope. A version that can't be read is refused.
 */
export function writeGuard(o: ResolvedMembership): CollectionBeforeOperationHook {
  return async ({ args, collection, operation, overrideAccess, req }) => {
    const a = args as { data?: unknown; id?: unknown }
    // Every caller, server code included: the Local API overrides access by default, so a host that
    // passes a request body straight to it gets the same check.
    if (operation === 'create' || operation === 'update') {
      refuseBadKeys(a.data, collection.fields, req)
      return args
    }
    if (operation === 'restoreVersion' && !overrideAccess) {
      const scope = await managerScope(o, req)
      if (scope === true || !scope) return args // no scope at all is refused by update access
      let version: Record<string, unknown> | undefined
      try {
        const { docs } = await req.payload.db.findVersions({ collection: collection.slug, limit: 1, locale: 'all', pagination: false, req, where: { id: { equals: a.id as string } } })
        version = (docs[0] as { version?: Record<string, unknown> } | undefined)?.version
      } catch {
        version = undefined
      }
      if (!version || !matchesWhere(scope, version)) throw new APIError('This version belongs outside what you manage, so it can’t be restored here.', 403, undefined, true)
    }
    return args
  }
}

/** Puts the guard in front of the collection's `beforeOperation` hooks as they are after the host's overrides. */
export function guarded(o: ResolvedMembership, c: CollectionConfig): CollectionConfig {
  return { ...c, hooks: { ...c.hooks, beforeOperation: [writeGuard(o), ...(c.hooks?.beforeOperation ?? [])] } }
}

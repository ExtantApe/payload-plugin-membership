import type { Access, CollectionBeforeChangeHook, CollectionConfig, CollectionSlug, FieldAccess, Where } from 'payload'
import { generateKeyBetween } from 'payload/shared'

import { managerReaches, managerScope, matchesWhere, viaMembership } from './access.js'
import type { ResolvedMembership } from './types.js'

const idOf = (v: unknown) => (v && typeof v === 'object' ? String((v as { id: unknown }).id) : v ? String(v) : null)

/** Drag-and-drop ordered (Payload `orderable`); a new record goes between its alphabetical neighbours. */
const placeAlphabetically =
  (o: ResolvedMembership, slug: string, field: string): CollectionBeforeChangeHook =>
  async ({ data, operation, req }) => {
    if (operation !== 'create' || data._order || !data[field]) return data
    const scope = o.scopeField ? idOf(data[o.scopeField]) : null
    const { docs } = await req.payload.find({
      collection: slug as never,
      where: o.scopeField && scope ? { [o.scopeField]: { equals: scope } } : {},
      sort: '_order',
      depth: 0,
      pagination: false,
      overrideAccess: true,
      select: { [field]: true, _order: true } as never,
      req,
    })
    const ordered = docs as unknown as Record<string, string | undefined>[]
    const next = ordered.findIndex((d) => String(d[field]).localeCompare(String(data[field]), 'en', { sensitivity: 'base' }) > 0)
    const before = next === -1 ? (ordered.at(-1)?._order ?? null) : next > 0 ? (ordered[next - 1]!._order ?? null) : null
    const after = next === -1 ? null : (ordered[next]!._order ?? null)
    try {
      data._order = generateKeyBetween(before, after)
    } catch {
      // Neighbours out of order after manual moves: Payload appends it at the end instead.
    }
    return data
  }

/** No write through the API for anyone: only the plugin's own server code (with overrideAccess) changes these. */
const LOCKED = { update: () => false }

/** Only the member whose row it is. */
const memberOnly: FieldAccess = ({ req, doc }) => Boolean(req.user) && String(idOf((doc as { user?: unknown } | undefined)?.user)) === String(req.user!.id)

/** Only the member sets `wall.show` to true; a manager may only hide (`false`), e.g. for an offensive name or a takedown request. */
const wallShow = (o: ResolvedMembership): FieldAccess => async (args) => {
  if (await memberOnly(args)) return true
  if ((args.siblingData as { show?: unknown } | undefined)?.show !== false) return false
  const scope = await managerScope(o, args.req)
  if (scope === true) return true
  const id = args.id ?? (args.doc as { id?: unknown } | undefined)?.id
  return Boolean(scope) && id != null && managerReaches(o, args.req, o.memberships, id)
}

type Via = (w: Where) => Where

/**
 * Manager access by `canManage`'s answer: `true` is every row, a query is only the rows it matches
 * (`via` rewrites it for a collection that holds the rows indirectly), anything else is no. A new
 * row (`create`) must match the query in its own data.
 */
function scopedManager(o: ResolvedMembership, via: Via = (w) => w, collection?: string) {
  // An update by a limited manager must leave the row inside their query: the existing row with the
  // incoming data merged over it is matched in memory, so a row can't be moved out of scope or into
  // another site. Nothing to check unless the data touches a field the query names.
  const update: Access = async ({ req, id, data }) => {
    const scope = await managerScope(o, req)
    if (scope === true) return true
    if (!scope) return false
    const where = via(scope)
    if (data && collection && referencedFields(scope).some((k) => k in data)) {
      let merged: Record<string, unknown> = data
      if (id != null) {
        const existing = await req.payload.findByID({ collection: collection as CollectionSlug, id, depth: 0, overrideAccess: true, disableErrors: true, req })
        if (!existing) return false
        merged = { ...(existing as Record<string, unknown>), ...data }
      }
      if (!matchesWhere(scope, merged)) return false
    }
    return where
  }
  const rows =
    (): Access =>
    async ({ req }) => {
      const scope = await managerScope(o, req)
      return scope === true ? true : scope ? via(scope) : false
    }
  const create: Access = async ({ req, data }) => {
    const scope = await managerScope(o, req)
    return scope === true || (scope !== null && matchesWhere(scope, data))
  }
  return { create, update: collection ? update : rows(), remove: rows() }
}

/** Top-level field names a query mentions. */
function referencedFields(where: Where): string[] {
  return Object.entries(where).flatMap(([k, v]) => (k === 'and' || k === 'or' ? (v as Where[]).flatMap(referencedFields) : [k.split('.')[0]!]))
}

/** Managers read what `canManage` reaches and members their own rows; anyone else gets nothing. */
function ownOrScoped(o: ResolvedMembership, via: Via = (w) => w): Access {
  return async ({ req }) => {
    if (!req.user) return false
    const own = { user: { equals: req.user.id } } satisfies Where
    const scope = await managerScope(o, req)
    if (scope === true) return true
    return scope ? ({ or: [via(scope), own] } satisfies Where) : own
  }
}

/** A relationship may only be set to a row the manager reaches (nothing to check when it isn't being set). */
function inScope(o: ResolvedMembership, target: string): FieldAccess {
  return async ({ req, siblingData, data }) => {
    const sent = (siblingData as Record<string, unknown> | undefined)?.parent ?? (data as Record<string, unknown> | undefined)?.parent
    if (sent == null || sent === '') return true
    return managerReaches(o, req, target, idOf(sent))
  }
}

/** Field access for managers: judged on the particular row, never on a bare yes. */
function managerFieldOn(o: ResolvedMembership, collection: string): FieldAccess {
  return async ({ req, id, doc, data }) => {
    const scope = await managerScope(o, req)
    if (scope === true) return true
    if (!scope) return false
    const rowId = id ?? (doc as { id?: unknown } | undefined)?.id
    return rowId != null ? managerReaches(o, req, collection, rowId) : matchesWhere(scope, data)
  }
}

const money = (name: string, label: string, description: string) =>
  ({ name, label, type: 'number' as const, min: 0, admin: { description: `${description} In cents (e.g. 500 = 5.00).` } })

export function tiersCollection(o: ResolvedMembership): CollectionConfig {
  const { create, update, remove } = scopedManager(o, undefined, o.tiers)
  const managerField = managerFieldOn(o, o.tiers)
  return {
    slug: o.tiers,
    labels: { singular: 'Membership tier', plural: 'Membership tiers' },
    admin: {
      useAsTitle: 'name',
      defaultColumns: ['name', 'monthly', 'yearly', 'active'],
      description: 'Fixed-price levels (Patreon-style). Shown in this order: drag rows to change it.',
    },
    access: { read: () => true, create, update, delete: remove },
    orderable: true,
    defaultSort: '_order',
    hooks: { beforeChange: [placeAlphabetically(o, o.tiers, 'name')] },
    fields: [
      { name: 'name', type: 'text', required: true },
      { name: 'active', label: 'Open to new members', type: 'checkbox', defaultValue: true, admin: { position: 'sidebar' } },
      { type: 'row', fields: [{ ...money('monthly', 'Monthly price', 'Per month; empty: not offered monthly.'), admin: { width: '50%' } }, { ...money('yearly', 'Yearly price', 'Per year; empty: not offered yearly.'), admin: { width: '50%' } }] },
      { name: 'description', type: 'textarea' },
      { name: 'perks', type: 'array', fields: [{ name: 'perk', type: 'text', required: true }] },
      { name: 'color', type: 'text', admin: { position: 'sidebar', description: 'Badge color, e.g. #cf8137.' } },
      {
        name: 'sponsorListing',
        label: 'Members are listed as sponsors',
        type: 'checkbox',
        admin: { position: 'sidebar', description: 'A perk your site can act on in onStatusChange (e.g. with payload-plugin-sponsors).' },
      },
      // Stripe product for this tier/category (created on first checkout; prices are set per member).
      { name: 'stripeProduct', type: 'text', access: { read: managerField, create: managerField, update: managerField }, admin: { position: 'sidebar', readOnly: true } },
    ],
    timestamps: true,
  }
}

export function categoriesCollection(o: ResolvedMembership): CollectionConfig {
  const { create, update, remove } = scopedManager(o, undefined, o.categories)
  const managerField = managerFieldOn(o, o.categories)
  return {
    slug: o.categories,
    labels: { singular: 'Membership category', plural: 'Membership categories' },
    admin: {
      useAsTitle: 'name',
      defaultColumns: ['name', 'parent', 'minimum', 'active'],
      description: 'What members can choose to support, setting their own amount (A–Z for new ones; drag to reorder). Add your own fields to tie categories to anything.',
    },
    access: { read: () => true, create, update, delete: remove },
    orderable: true,
    defaultSort: '_order',
    hooks: { beforeChange: [placeAlphabetically(o, o.categories, 'name')] },
    fields: [
      { name: 'name', type: 'text', required: true },
      { name: 'active', label: 'Open to new pledges', type: 'checkbox', defaultValue: true, admin: { position: 'sidebar' } },
      { name: 'parent', type: 'relationship', relationTo: o.categories as never, access: { create: inScope(o, o.categories), update: inScope(o, o.categories) }, admin: { position: 'sidebar', description: 'Optional: nest under a broader category.' } },
      { name: 'description', type: 'textarea' },
      money('minimum', 'Minimum per month', 'Smallest monthly amount for this category (yearly: 12×).'),
      {
        name: 'earmarked',
        type: 'checkbox',
        admin: { description: 'Off: the category is the member’s preference. On: pledges are reserved for work in this category (say so on your page).' },
      },
      { name: 'color', type: 'text', admin: { position: 'sidebar' } },
      // Stripe product for this tier/category (created on first checkout; prices are set per member).
      { name: 'stripeProduct', type: 'text', access: { read: managerField, create: managerField, update: managerField }, admin: { position: 'sidebar', readOnly: true } },
    ],
    timestamps: true,
  }
}

export function membershipsCollection(o: ResolvedMembership): CollectionConfig {
  const { update, remove } = scopedManager(o, undefined, o.memberships)
  const managerField = managerFieldOn(o, o.memberships)
  // A manager reads what `canManage` reaches; members read their own (the plugin's own query, never the site's answer).
  const ownOrManager = ownOrScoped(o)
  const nobody = () => false
  return {
    slug: o.memberships,
    labels: { singular: 'Membership', plural: 'Memberships' },
    admin: {
      useAsTitle: 'label',
      defaultColumns: ['label', 'kind', 'amount', 'interval', 'status', 'currentPeriodEnd'],
      description: 'Members’ subscriptions. Created and updated by checkout and Stripe; edit the wall name or notes here.',
    },
    // Created by checkout and updated by Stripe webhooks; members manage theirs through the plugin's endpoints.
    access: { read: ownOrManager, create: nobody, update, delete: remove },
    fields: [
      { name: 'label', type: 'text', access: LOCKED, admin: { readOnly: true } },
      { name: 'user', type: 'relationship', relationTo: o.users as never, required: true, index: true, access: LOCKED, admin: { readOnly: true } },
      {
        type: 'row',
        fields: [
          { name: 'kind', type: 'select', required: true, options: [{ label: 'Tier', value: 'tier' }, { label: 'Pledge to categories', value: 'pledge' }], access: LOCKED, admin: { width: '33%', readOnly: true } },
          {
            name: 'status',
            type: 'select',
            required: true,
            defaultValue: 'pending',
            index: true,
            access: LOCKED,
            options: ['pending', 'incomplete', 'active', 'past_due', 'canceled'].map((v) => ({ label: v.replace('_', ' '), value: v })),
            admin: { width: '33%', readOnly: true },
          },
          { name: 'interval', type: 'select', required: true, options: [{ label: 'Monthly', value: 'month' }, { label: 'Yearly', value: 'year' }], access: LOCKED, admin: { width: '34%', readOnly: true } },
        ],
      },
      { name: 'tier', type: 'relationship', relationTo: o.tiers as never, index: true, access: LOCKED, admin: { readOnly: true, condition: (d) => d?.kind === 'tier' } },
      {
        name: 'pledges',
        type: 'array',
        access: LOCKED,
        admin: { readOnly: true, condition: (d) => d?.kind === 'pledge' },
        fields: [
          { name: 'category', type: 'relationship', relationTo: o.categories as never, required: true, index: true },
          { name: 'amount', type: 'number', required: true, min: 0, admin: { description: 'Per interval, in cents.' } },
        ],
      },
      {
        type: 'row',
        fields: [
          { name: 'amount', type: 'number', required: true, min: 0, access: LOCKED, admin: { width: '33%', readOnly: true, description: 'Per interval, in cents.' } },
          { name: 'currency', type: 'text', required: true, access: LOCKED, admin: { width: '33%', readOnly: true } },
          {
            name: 'totalPaid',
            type: 'number',
            defaultValue: 0,
            // Only invoice.paid changes it, with an atomic $inc. Payload saves the whole document,
            // so an edit, a Stripe event or a hook saved at the same moment as an invoice would
            // write back an older total: leave it out of every save (0 on create).
            access: { create: () => false, update: () => false },
            hooks: {
              beforeChange: [
                ({ operation, siblingData }) => {
                  if (operation === 'create') return 0
                  delete siblingData.totalPaid
                  return undefined
                },
              ],
            },
            admin: { width: '34%', readOnly: true, description: 'All paid invoices, in cents.' },
          },
        ],
      },
      {
        type: 'row',
        fields: [
          { name: 'startedAt', type: 'date', access: LOCKED, admin: { width: '25%', readOnly: true } },
          { name: 'currentPeriodEnd', type: 'date', access: LOCKED, admin: { width: '25%', readOnly: true } },
          { name: 'cancelAtPeriodEnd', type: 'checkbox', access: LOCKED, admin: { width: '25%', readOnly: true } },
          { name: 'canceledAt', type: 'date', access: LOCKED, admin: { width: '25%', readOnly: true } },
        ],
      },
      {
        name: 'wall',
        label: 'Backers wall',
        type: 'group',
        admin: { description: 'Members choose whether and how they appear; nothing is public otherwise.' },
        fields: [
          { name: 'show', label: 'Show on the backers wall', type: 'checkbox', defaultValue: false, access: { update: wallShow(o) } },
          { name: 'name', label: 'Name on the wall', type: 'text', maxLength: 80, access: { update: memberOnly } },
        ],
      },
      // Stripe references: managers only, never in public responses.
      {
        name: 'stripe',
        type: 'group',
        access: { read: managerField, create: LOCKED.update, update: LOCKED.update },
        admin: { position: 'sidebar', readOnly: true },
        fields: [
          { name: 'customer', type: 'text', index: true },
          { name: 'subscription', type: 'text', index: true },
          { name: 'checkoutSession', type: 'text', index: true },
        ],
      },
      { name: 'notes', type: 'textarea', access: { read: managerField, update: managerField }, admin: { position: 'sidebar' } },
    ],
    timestamps: true,
  }
}

export function paymentsCollection(o: ResolvedMembership): CollectionConfig {
  const { remove } = scopedManager(o, viaMembership)
  const ownOrManager = ownOrScoped(o, viaMembership)
  return {
    slug: o.payments,
    labels: { singular: 'Membership payment', plural: 'Membership payments' },
    admin: { useAsTitle: 'invoiceId', defaultColumns: ['membership', 'amount', 'currency', 'paidAt'], description: 'Every paid invoice, recorded once from Stripe.' },
    access: { read: ownOrManager, create: () => false, update: () => false, delete: remove },
    fields: [
      { name: 'membership', type: 'relationship', relationTo: o.memberships as never, required: true, index: true },
      { name: 'user', type: 'relationship', relationTo: o.users as never, required: true, index: true },
      { type: 'row', fields: [{ name: 'amount', type: 'number', required: true, admin: { width: '33%' } }, { name: 'currency', type: 'text', required: true, admin: { width: '33%' } }, { name: 'paidAt', type: 'date', required: true, index: true, admin: { width: '34%' } }] },
      { name: 'invoiceId', type: 'text', required: true, unique: true },
      { name: 'tier', type: 'relationship', relationTo: o.tiers as never },
      { name: 'pledges', type: 'array', fields: [{ name: 'category', type: 'relationship', relationTo: o.categories as never }, { name: 'amount', type: 'number' }] },
    ],
    timestamps: true,
  }
}

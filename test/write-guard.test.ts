import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { configToSchema } from '@payloadcms/graphql'
import type { GraphQLSchema } from 'graphql'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, createLocalReq, getPayload, handleEndpoints, type CollectionConfig, type Field, type Payload, type PayloadRequest } from 'payload'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { membershipPlugin } from '../src/index.js'
import { refuseBadKeys } from '../src/guard.js'
import { fakeStripe } from './fake-stripe.js'

// What a save by anyone held to access rules may carry, on a multi-site host that turns on drafts for
// tiers and categories and versions for memberships through `overrides`. Made-up sites, example.com
// people, a fake Stripe, a throwaway in-memory database.
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

// The same copy of graphql that Payload's schema builder loads in Node (a second copy would refuse its schema).
const { graphql } = createRequire(import.meta.url)('graphql') as typeof import('graphql')

const KEY = 'membership-write-guard'
const PASSWORD = 'a-made-up-test-password'
const SITE_FIELD = { name: 'site', type: 'text' as const, index: true }
const TIERS = 'membership-tiers'
const CATS = 'membership-categories'
const MS = 'memberships'

let mongo: MongoMemoryReplSet
let payload: Payload
let schema: GraphQLSchema
const { stripe, subs, event } = fakeStripe()
const answer = (u: Doc) => (u.role === 'manager' ? { site: { equals: u.site } } : u.role === 'admin' ? true : false)

let managerA: Doc, adminAll: Doc, memberA: Doc
let tierA: Doc, catB: Doc
let mA: Doc

const tokens = new Map<string, string>()
async function login(user: Doc) {
  if (!tokens.has(String(user.id))) tokens.set(String(user.id), (await payload.login({ collection: 'users', data: { email: user.email, password: PASSWORD } })).token!)
  return tokens.get(String(user.id))!
}
async function send(request: Request) {
  const res = await handleEndpoints({ config: Promise.resolve(payload.config), payloadInstanceCacheKey: KEY, request } as never)
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Doc }
}
async function rest(method: string, path: string, user: Doc | null, body?: unknown, site?: string) {
  const headers = new Headers({ 'content-type': 'application/json', ...(site ? { 'x-site': site } : {}) })
  if (user) headers.set('Authorization', `JWT ${await login(user)}`)
  return send(new Request(`https://members.example.com/api${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }))
}
/** The same save sent as a form, the way an upload or the admin can send it. */
async function multipart(method: string, path: string, user: Doc, body: unknown) {
  const form = new FormData()
  form.set('_payload', JSON.stringify(body))
  return send(new Request(`https://members.example.com/api${path}`, { method, headers: { Authorization: `JWT ${await login(user)}` }, body: form }))
}
async function gql(source: string, user: Doc | null, variableValues?: Doc) {
  schema ??= configToSchema(payload.config).schema
  const req = (await createLocalReq({ user: user ? ({ ...user, collection: 'users' } as never) : undefined }, payload)) as PayloadRequest
  req.payloadAPI = 'GraphQL'
  return graphql({ schema, source, contextValue: { req, headers: new Headers() }, variableValues })
}
const as = (u: Doc) => ({ user: { ...u, collection: 'users' } as never, overrideAccess: false as const })
const get = (collection: string, id: unknown) => payload.findByID({ collection: collection as never, id: id as string, depth: 0, draft: true }) as Promise<Doc>
/** The row as stored in the database. */
const raw = async (collection: string, id: unknown) => {
  const models = (payload.db as unknown as { collections: Record<string, { findById: (id: unknown) => { lean: () => Promise<unknown> } }> }).collections
  return JSON.stringify(await models[collection]!.findById(id).lean())
}
const count = async (collection: string) => (await payload.count({ collection: collection as never })).totalDocs

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  const drafts = (c: CollectionConfig): CollectionConfig => ({ ...c, versions: { drafts: true }, fields: [...c.fields, SITE_FIELD] })
  payload = await getPayload({
    key: KEY,
    config: await buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      serverURL: 'https://members.example.com',
      typescript: { autoGenerate: false },
      db: mongooseAdapter({ url: mongo.getUri(KEY), ensureIndexes: true }),
      collections: [{ slug: 'users', auth: true, fields: [{ name: 'role', type: 'text' }, { name: 'site', type: 'text' }] }],
      admin: { user: 'users' },
      plugins: [
        membershipPlugin({
          stripe,
          webhookSecret: 'whsec_test',
          scopeField: 'site',
          scopeOf: (req: PayloadRequest) => req.headers.get('x-site') ?? null,
          canManage: ({ req }) => answer(req.user as Doc) as never,
          overrides: { tiers: drafts, categories: drafts, memberships: (c) => ({ ...c, versions: true, fields: [...c.fields, SITE_FIELD] }) },
        }),
      ],
    }),
  })
  const models = (payload.db as unknown as { collections: Record<string, { createCollection: () => Promise<unknown>; ensureIndexes: () => Promise<unknown> }> }).collections
  for (const m of Object.values(models)) await m.createCollection().catch(() => undefined)
  for (const m of Object.values(models)) await m.ensureIndexes()
  const user = (email: string, site: string, role: string) => payload.create({ collection: 'users', data: { email, password: PASSWORD, role, site } as never }) as Promise<Doc>
  managerA = await user('manager-a@example.com', 'a', 'manager')
  adminAll = await user('admin@example.com', 'a', 'admin')
  memberA = await user('member-a@example.com', 'a', 'member')
  const create = (collection: string, data: Doc) => payload.create({ collection: collection as never, data: { _status: 'published', ...data } as never, depth: 0 }) as Promise<Doc>
  tierA = await create(TIERS, { site: 'a', name: 'Friend', monthly: 500, stripeProduct: 'prod_a' })
  catB = await create(CATS, { site: 'b', name: 'Elsewhere', stripeProduct: 'prod_cat_b' })
  // A real membership on site A, paid once through the webhook.
  const res = await rest('POST', '/memberships/checkout', memberA, { tier: String(tierA.id), interval: 'month' }, 'a')
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  const id = res.body.membership as string
  subs.set('sub_a', { id: 'sub_a', status: 'active', customer: 'cus_a', items: { data: [{ id: 'si_a', current_period_end: 1_900_000_000 }] }, metadata: { membership: id } })
  await signed(event('checkout.session.completed', { mode: 'subscription', metadata: { membership: id }, subscription: 'sub_a', customer: 'cus_a' }))
  await signed(event('invoice.paid', { id: 'in_a1', subscription: 'sub_a', amount_paid: 500, currency: 'usd', created: 1_800_000_000 }))
  mA = await get(MS, id)
  expect(mA).toMatchObject({ status: 'active', totalPaid: 500, site: 'a', stripe: { customer: 'cus_a', subscription: 'sub_a' } })
}, 180_000)

afterAll(async () => {
  await payload?.destroy()
  await mongo?.stop()
})

function signed(e: Doc) {
  return send(new Request('https://members.example.com/api/memberships/stripe-webhook', { method: 'POST', headers: { 'stripe-signature': 'good' }, body: JSON.stringify(e) }))
}

/** Save data with field names the plugin doesn't accept, on fields nobody has defined. */
const unusual = (): Doc[] => [
  { '$odd': 1 },
  { 'odd.name': 1 },
  { 'odd\u0000name': 1 },
  { extra: { '$odd': 1 } },
  { extra: [{ 'odd.name': 1 }] },
]

describe('save data with unusual field names', () => {
  const targets = () => [
    { collection: MS, id: mA.id },
    { collection: TIERS, id: tierA.id },
  ]

  it('is refused on updates in the Local API, single and bulk, for scoped and all-site managers', async () => {
    for (const { collection, id } of targets()) {
      const before = await raw(collection, id)
      for (const who of [managerA, adminAll])
        for (const data of unusual()) {
          const label = `${collection} ${who.role} ${JSON.stringify(data)}`
          await expect(payload.update({ collection: collection as never, id, data: data as never, ...as(who) }), label).rejects.toThrow(/dollar sign/)
          await expect(payload.update({ collection: collection as never, where: { id: { equals: id } }, data: data as never, ...as(who) }), label).rejects.toThrow(/dollar sign/)
          if (collection === TIERS) await expect(payload.update({ collection: collection as never, id, draft: true, data: data as never, ...as(who) } as never), label).rejects.toThrow(/dollar sign/)
        }
      expect(await raw(collection, id), collection).toBe(before)
    }
  })

  it('is refused on updates over REST, as JSON and as a form, single and bulk', async () => {
    for (const { collection, id } of targets()) {
      const before = await raw(collection, id)
      for (const who of [managerA, adminAll])
        for (const data of unusual()) {
          const label = `${collection} ${who.role} ${JSON.stringify(data)}`
          for (const path of [`/${collection}/${id}`, `/${collection}?where[id][equals]=${id}`]) {
            const json = await rest('PATCH', path, who, data)
            expect(json.status, `${label} JSON ${path}`).toBe(400)
            expect(JSON.stringify(json.body), label).toMatch(/dollar sign/)
            expect((await multipart('PATCH', path, who, data)).status, `${label} form ${path}`).toBe(400)
          }
        }
      expect(await raw(collection, id), collection).toBe(before)
    }
  })

  it('is refused for server code too, where the Local API overrides access by default', async () => {
    for (const { collection, id } of targets()) {
      const before = await raw(collection, id)
      for (const data of unusual()) {
        const label = `${collection} server ${JSON.stringify(data)}`
        await expect(payload.update({ collection: collection as never, id, data: data as never }), label).rejects.toThrow(/dollar sign/)
        await expect(payload.update({ collection: collection as never, where: { id: { equals: id } }, data: data as never }), label).rejects.toThrow(/dollar sign/)
      }
      expect(await raw(collection, id), collection).toBe(before)
    }
    const rows = await count(TIERS)
    for (const extra of unusual()) {
      await expect(payload.create({ collection: TIERS as never, data: { name: 'New row', site: 'a', ...extra } as never })).rejects.toThrow(/dollar sign/)
      await expect(payload.duplicate({ collection: TIERS as never, id: tierA.id, data: { ...extra } as never })).rejects.toThrow(/dollar sign/)
    }
    expect(await count(TIERS)).toBe(rows)
  })

  it('is refused on creates and duplicates, and nothing is stored', async () => {
    for (const collection of [TIERS, CATS]) {
      const rows = await count(collection)
      for (const who of [managerA, adminAll])
        for (const extra of unusual()) {
          const data = { name: 'New row', site: 'a', ...extra }
          const label = `${collection} ${who.role} ${JSON.stringify(extra)}`
          await expect(payload.create({ collection: collection as never, data: data as never, ...as(who) }), label).rejects.toThrow(/dollar sign/)
          expect((await rest('POST', `/${collection}`, who, data)).status, label).toBe(400)
          expect((await multipart('POST', `/${collection}`, who, data)).status, label).toBe(400)
          const source = collection === TIERS ? tierA.id : catB.id
          await expect(payload.duplicate({ collection: collection as never, id: source, data: data as never, ...as(who) }), label).rejects.toThrow(/dollar sign/)
          expect((await rest('POST', `/${collection}/${source}/duplicate`, who, data)).status, label).toBe(400)
        }
      expect(await count(collection), collection).toBe(rows)
    }
  })

  it('can’t be sent in GraphQL at all, and the row is unchanged', async () => {
    const before = await raw(TIERS, tierA.id)
    for (const who of [managerA, adminAll]) {
      const odd = await gql(`mutation ($data: mutationMembershipTierUpdateInput!) { updateMembershipTier(id: "${tierA.id}", data: $data) { id } }`, who, { data: { name: 'x', 'odd.name': 'y' } })
      expect(odd.errors?.length, who.role).toBeGreaterThan(0)
    }
    expect(await raw(TIERS, tierA.id)).toBe(before)
  })

  it('still lets ordinary saves through: Local API, REST as JSON and as a form, and GraphQL', async () => {
    await expect(payload.update({ collection: MS as never, id: mA.id, data: { notes: 'one' } as never, ...as(managerA) })).resolves.toMatchObject({ notes: 'one' })
    expect((await rest('PATCH', `/${MS}/${mA.id}`, managerA, { notes: 'two' })).status).toBe(200)
    expect((await multipart('PATCH', `/${MS}/${mA.id}`, managerA, { notes: 'three' })).status).toBe(200)
    expect((await get(MS, mA.id)).notes).toBe('three')
    const renamed = await gql(`mutation { updateMembershipTier(id: "${tierA.id}", data: { name: "Friend of the site" }) { name } }`, managerA)
    expect(renamed.errors).toBeUndefined()
    expect((await get(TIERS, tierA.id)).name).toBe('Friend of the site')
    // A draft save and a nested group save by a manager.
    expect((await rest('PATCH', `/${TIERS}/${tierA.id}?draft=true`, managerA, { name: 'Draft name' })).status).toBe(200)
    await payload.update({ collection: MS as never, id: mA.id, data: { wall: { show: false } } as never, ...as(managerA) })
    await payload.update({ collection: TIERS as never, id: tierA.id, data: { name: 'Friend', _status: 'published' } as never })
    await payload.update({ collection: MS as never, id: mA.id, data: { notes: null } as never })
  })

  it('leaves the plugin’s own server writes alone: a paid invoice, a server save and a cancel', async () => {
    await signed(event('invoice.paid', { id: 'in_a2', subscription: 'sub_a', amount_paid: 500, currency: 'usd', created: 1_800_100_000 }))
    expect((await get(MS, mA.id)).totalPaid).toBe(1000)
    // Server code with plain field names saves as before.
    await payload.update({ collection: MS as never, id: mA.id, data: { notes: 'server' } as never })
    expect((await get(MS, mA.id)).notes).toBe('server')
    // And a cancel through the plugin's endpoint still records itself.
    expect((await rest('POST', `/${MS}/${mA.id}/cancel`, managerA, undefined, 'a')).status).toBe(200)
    expect((await get(MS, mA.id)).cancelAtPeriodEnd).toBe(true)
    await payload.update({ collection: MS as never, id: mA.id, data: { cancelAtPeriodEnd: false, notes: null } as never })
  })

  it('looks inside groups, arrays and blocks but leaves rich text and JSON values alone', () => {
    const req = { payload: { config: { localization: { localeCodes: ['en', 'fr'] }, blocks: [] } } } as unknown as PayloadRequest
    const fields = [
      { name: 'body', type: 'richText' },
      { name: 'meta', type: 'json' },
      { type: 'row', fields: [{ name: 'deep', type: 'json' }] },
      { type: 'tabs', tabs: [{ name: 'named', fields: [{ name: 'inner', type: 'json' }] }, { label: 'Plain', fields: [{ name: 'flat', type: 'richText' }] }] },
      { name: 'list', type: 'array', fields: [{ name: 'x', type: 'text' }] },
      { name: 'grp', type: 'group', localized: true, fields: [{ name: 'note', type: 'json' }] },
      { name: 'layout', type: 'blocks', blocks: [{ slug: 'quote', fields: [{ name: 'rich', type: 'richText' }] }] },
    ] as unknown as Field[]
    const nodeState = { root: { children: [{ type: 'paragraph', $: { color: 'red' } }] } }
    expect(() => refuseBadKeys({ body: nodeState, meta: { $any: 1, 'a.b': 2 }, deep: { $x: 1 }, named: { inner: { $y: 1 } }, flat: nodeState, grp: { en: { note: { $z: 1 } } }, layout: [{ blockType: 'quote', rich: nodeState }] }, fields, req)).not.toThrow()
    for (const bad of [{ $odd: {} }, { 'a.b': 1 }, { list: [{ $x: 1 }] }, { named: { $y: 1 } }, { grp: { $z: 1 } }, { layout: [{ blockType: 'quote', $q: 1 }] }, { layout: [{ blockType: 'unknown', rich: nodeState }] }, { unknown: { nested: { $deep: 1 } } }])
      expect(() => refuseBadKeys(bad, fields, req), JSON.stringify(bad)).toThrow(/dollar sign/)
    // Very deep data is refused rather than walked forever.
    let deep: Doc = { leaf: 1 }
    for (let i = 0; i < 40; i++) deep = { next: deep }
    expect(() => refuseBadKeys(deep, fields, req)).toThrow(/dollar sign/)
  })
})

describe('a category’s parent, judged on the final value', () => {
  const mk = (name: string, site: string, extra: Doc = {}) => payload.create({ collection: CATS as never, data: { name, site, _status: 'published', ...extra } as never, depth: 0 }) as Promise<Doc>

  it('lets a limited manager duplicate a category only when its parent is one they manage (Local API, REST, GraphQL)', async () => {
    const childB = await mk('Child B', 'b', { parent: catB.id })
    const rows = await count(CATS)
    await expect(payload.duplicate({ collection: CATS as never, id: childB.id, data: { site: 'a' } as never, ...as(managerA) })).rejects.toThrow(/parent category is outside/)
    const viaRest = await rest('POST', `/${CATS}/${childB.id}/duplicate`, managerA, { site: 'a' })
    expect(viaRest.status).toBe(403)
    expect(JSON.stringify(viaRest.body)).toMatch(/parent category is outside/)
    const viaGql = await gql(`mutation { duplicateMembershipCategory(id: "${childB.id}", data: { name: "Copy", site: "a" }) { id parent { id } } }`, managerA)
    expect(viaGql.errors?.[0]?.message).toMatch(/parent category is outside/)
    expect(await count(CATS)).toBe(rows)
    // Clearing the parent in the copy is allowed.
    const copy = (await payload.duplicate({ collection: CATS as never, id: childB.id, data: { site: 'a', parent: null } as never, ...as(managerA) })) as Doc
    expect([copy.site, copy.parent ?? null]).toEqual(['a', null])
    // An all-site manager and server code may keep it.
    expect(String(((await payload.duplicate({ collection: CATS as never, id: childB.id, data: { site: 'a' } as never, depth: 0, ...as(adminAll) })) as Doc).parent)).toBe(String(catB.id))
    expect(String(((await payload.duplicate({ collection: CATS as never, id: childB.id, data: { site: 'a' } as never, depth: 0 })) as Doc).parent)).toBe(String(catB.id))
  })

  it('lets a manager duplicate and edit their own site’s nested categories', async () => {
    const parentA = await mk('Parent A', 'a')
    const childA = await mk('Child A', 'a', { parent: parentA.id })
    const copy = (await payload.duplicate({ collection: CATS as never, id: childA.id, data: { name: 'Child A copy', site: 'a' } as never, depth: 0, ...as(managerA) })) as Doc
    expect(String(copy.parent)).toBe(String(parentA.id))
    await expect(payload.update({ collection: CATS as never, id: childA.id, data: { name: 'Child A renamed' } as never, ...as(managerA) })).resolves.toMatchObject({ name: 'Child A renamed' })
    expect((await rest('PATCH', `/${CATS}/${childA.id}`, managerA, { parent: parentA.id, name: 'Child A again' })).status).toBe(200)
  })
})

describe('restoring a version', () => {
  const versionsOf = async (collection: string, id: unknown) =>
    (await payload.findVersions({ collection: collection as never, where: { parent: { equals: id } }, sort: 'createdAt', depth: 0, pagination: false })).docs as Doc[]

  /** A row that was on site B and was later moved to site A by server code. */
  async function movedRow(collection: string, extra: Doc) {
    const row = (await payload.create({ collection: collection as never, data: { site: 'b', ...extra } as never, depth: 0 })) as Doc
    await payload.update({ collection: collection as never, id: row.id, data: { site: 'a', ...(collection === MS ? {} : { _status: 'published' }) } as never })
    const versions = await versionsOf(collection, row.id)
    const old = versions.find((v) => v.version.site === 'b')!
    const current = versions.find((v) => v.version.site === 'a')!
    expect(old && current, collection).toBeTruthy()
    return { row, old, current }
  }

  it('lets a limited manager restore only versions inside their scope (Local API, REST, GraphQL)', async () => {
    const cases = [
      { collection: TIERS, singular: 'MembershipTier', extra: { name: 'Moved tier', _status: 'published' } },
      { collection: CATS, singular: 'MembershipCategory', extra: { name: 'Moved category', _status: 'published' } },
      { collection: MS, singular: 'Membership', extra: { label: 'Moved', user: memberA.id, kind: 'tier', status: 'active', interval: 'month', amount: 500, currency: 'usd' } },
    ]
    for (const { collection, singular, extra } of cases) {
      const { row, old, current } = await movedRow(collection, extra)
      await expect(payload.restoreVersion({ collection: collection as never, id: old.id, ...as(managerA) }), collection).rejects.toThrow(/outside what you manage/)
      expect((await rest('POST', `/${collection}/versions/${old.id}`, managerA)).status, collection).toBe(403)
      const viaGql = await gql(`mutation { restoreVersion${singular}(id: "${old.id}") { id } }`, managerA)
      expect(viaGql.errors?.[0]?.message, collection).toMatch(/outside what you manage/)
      expect((await get(collection, row.id)).site, collection).toBe('a')
      if (collection === MS) {
        // Memberships' fields are server-set, so only server code restores them (as before).
        await payload.restoreVersion({ collection: collection as never, id: old.id })
      } else {
        // A version inside their scope restores, and an all-site manager may restore either.
        await expect(payload.restoreVersion({ collection: collection as never, id: current.id, ...as(managerA) }), collection).resolves.toBeTruthy()
        await payload.restoreVersion({ collection: collection as never, id: old.id, ...as(adminAll) })
      }
      expect((await get(collection, row.id)).site, collection).toBe('b')
    }
  })

  it('judges a restored category’s parent like any other save', async () => {
    const row = (await payload.create({ collection: CATS as never, data: { name: 'Was nested', site: 'a', parent: catB.id, _status: 'published' } as never, depth: 0 })) as Doc
    await payload.update({ collection: CATS as never, id: row.id, data: { parent: null, _status: 'published' } as never })
    const old = (await versionsOf(CATS, row.id)).find((v) => v.version.parent)!
    await expect(payload.restoreVersion({ collection: CATS as never, id: old.id, ...as(managerA) })).rejects.toThrow(/parent category is outside/)
    expect((await get(CATS, row.id)).parent ?? null).toBeNull()
  })

  it('refuses a version that can’t be found, for a limited manager', async () => {
    await expect(payload.restoreVersion({ collection: TIERS as never, id: '000000000000000000000000', ...as(managerA) })).rejects.toThrow(/outside what you manage/)
  })
})

describe('reading tiers and categories when a host turns on drafts', () => {
  it('shows unpublished rows only to managers who reach them', async () => {
    const draftA = (await payload.create({ collection: TIERS as never, data: { name: 'Unannounced A', site: 'a', _status: 'draft' } as never, draft: true })) as Doc
    const draftB = (await payload.create({ collection: TIERS as never, data: { name: 'Unannounced B', site: 'b', _status: 'draft' } as never, draft: true })) as Doc
    const names = async (args: Doc) => ((await payload.find({ collection: TIERS as never, depth: 0, pagination: false, overrideAccess: false, ...args })).docs as Doc[]).map((d) => d.name)
    for (const who of [null, memberA]) {
      const seen = await names(who ? { user: { ...who, collection: 'users' } } : {})
      expect(seen, String(who?.role)).toContain('Friend')
      expect(seen, String(who?.role)).not.toContain('Unannounced A')
      expect(seen, String(who?.role)).not.toContain('Unannounced B')
      await expect(payload.findByID({ collection: TIERS as never, id: draftA.id, overrideAccess: false, ...(who ? { user: { ...who, collection: 'users' } } : {}) } as never)).rejects.toThrow()
    }
    const anonymous = await rest('GET', `/${TIERS}?depth=0&draft=true`, null)
    expect(JSON.stringify(anonymous.body)).not.toMatch(/Unannounced/)
    expect((await rest('GET', `/${TIERS}/${draftA.id}`, null)).status).toBe(404)
    const viaGql = await gql('{ MembershipTiers(draft: true) { docs { name } } }', null)
    expect(JSON.stringify(viaGql.data)).not.toMatch(/Unannounced/)
    expect(JSON.stringify(viaGql.data)).toMatch(/Friend/)
    expect(await names(as(managerA))).toEqual(expect.arrayContaining(['Friend', 'Unannounced A']))
    expect(await names(as(managerA))).not.toContain('Unannounced B')
    expect(await names(as(adminAll))).toEqual(expect.arrayContaining(['Unannounced A', 'Unannounced B']))
    for (const d of [draftA, draftB]) await payload.delete({ collection: TIERS as never, id: d.id })
  })
})

describe('a copy of a membership made by server code', () => {
  it('starts as a new, unpaid row without the original’s Stripe ids, status, dates, staff notes or wall choice', async () => {
    await payload.update({ collection: MS as never, id: mA.id, data: { notes: 'staff only', wall: { show: true, name: 'A made-up name' } } as never })
    const source = await get(MS, mA.id)
    expect(source.stripe.subscription).toBe('sub_a')
    const copy = (await payload.duplicate({ collection: MS as never, id: mA.id, depth: 0 })) as Doc
    expect(copy).toMatchObject({ status: 'pending', totalPaid: 0, cancelAtPeriodEnd: false, user: source.user, site: 'a' })
    for (const k of ['startedAt', 'currentPeriodEnd', 'canceledAt']) expect(copy[k] ?? null, k).toBeNull()
    expect([copy.stripe?.customer, copy.stripe?.subscription, copy.stripe?.checkoutSession].map((v) => v ?? null)).toEqual([null, null, null])
    expect([copy.notes ?? null, copy.wall?.show ?? false, copy.wall?.name ?? null]).toEqual([null, false, null])
    // A value server code gives on purpose is kept, and the original is untouched.
    const given = (await payload.duplicate({ collection: MS as never, id: mA.id, data: { status: 'active', stripe: { customer: 'cus_given' } } as never, depth: 0 })) as Doc
    expect([given.status, given.stripe.customer]).toEqual(['active', 'cus_given'])
    expect(await get(MS, mA.id)).toMatchObject({ status: 'active', stripe: { customer: 'cus_a', subscription: 'sub_a' } })
    for (const d of [copy, given]) await payload.delete({ collection: MS as never, id: d.id })
    await payload.update({ collection: MS as never, id: mA.id, data: { notes: null, wall: { show: false, name: null } } as never })
  })
})

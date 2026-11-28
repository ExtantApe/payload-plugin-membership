import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { configToSchema } from '@payloadcms/graphql'
import type { GraphQLSchema } from 'graphql'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, createLocalReq, getPayload, handleEndpoints, type CollectionConfig, type Field, type Payload, type PayloadRequest } from 'payload'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { membershipPlugin } from '../src/index.js'
import { fakeStripe } from './fake-stripe.js'

// Who reads saved versions, and a category's parent in every locale, on a multi-site host with two
// locales that turns on versions for all four collections through `overrides`. Made-up sites,
// example.com people, a throwaway in-memory database.
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const { graphql } = createRequire(import.meta.url)('graphql') as typeof import('graphql')

const KEY = 'membership-version-reads'
const PASSWORD = 'a-made-up-test-password'
const SITE_FIELD = { name: 'site', type: 'text' as const, index: true }
const TIERS = 'membership-tiers'
const CATS = 'membership-categories'
const MS = 'memberships'
const PAY = 'membership-payments'

let mongo: MongoMemoryReplSet
let payload: Payload
let schema: GraphQLSchema
const answer = (u: Doc) => (u.role === 'manager' ? { site: { equals: u.site } } : u.role === 'admin' ? true : false)

let memberA: Doc, memberB: Doc, managerA: Doc, managerB: Doc, adminAll: Doc
let tierA: Doc, tierB: Doc, mA: Doc, mB: Doc, payA: Doc, payB: Doc

const tokens = new Map<string, string>()
async function login(user: Doc) {
  if (!tokens.has(String(user.id))) tokens.set(String(user.id), (await payload.login({ collection: 'users', data: { email: user.email, password: PASSWORD } })).token!)
  return tokens.get(String(user.id))!
}
async function rest(method: string, path: string, user: Doc | null, body?: unknown) {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (user) headers.set('Authorization', `JWT ${await login(user)}`)
  const request = new Request(`https://members.example.com/api${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const res = await handleEndpoints({ config: Promise.resolve(payload.config), payloadInstanceCacheKey: KEY, request } as never)
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Doc }
}
async function gql(source: string, user: Doc | null) {
  schema ??= configToSchema(payload.config).schema
  const req = (await createLocalReq({ user: user ? ({ ...user, collection: 'users' } as never) : undefined }, payload)) as PayloadRequest
  req.payloadAPI = 'GraphQL'
  const res = await graphql({ schema, source, contextValue: { req, headers: new Headers() } })
  return res as { data?: Doc | null; errors?: readonly unknown[] }
}
const as = (u: Doc) => ({ user: { ...u, collection: 'users' } as never, overrideAccess: false as const })
const idOf = (v: unknown) => String(v && typeof v === 'object' ? (v as Doc).id : v)
const versionsOf = async (collection: string, id: unknown) =>
  (await payload.findVersions({ collection: collection as never, where: { parent: { equals: id } }, sort: 'createdAt', depth: 0, pagination: false, locale: 'all' as never })).docs as Doc[]

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  const withSite = (c: CollectionConfig, versions: CollectionConfig['versions']): CollectionConfig => ({ ...c, versions, fields: [...c.fields, SITE_FIELD] })
  // Only the parent is localized, as a host might do through `overrides`.
  const localParent = (fields: Field[]) => fields.map((f) => ('name' in f && f.name === 'parent' ? ({ ...f, localized: true } as Field) : f))
  payload = await getPayload({
    key: KEY,
    config: await buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      serverURL: 'https://members.example.com',
      typescript: { autoGenerate: false },
      localization: { locales: ['en', 'fr'], defaultLocale: 'en', fallback: false },
      db: mongooseAdapter({ url: mongo.getUri(KEY), ensureIndexes: true }),
      collections: [{ slug: 'users', auth: true, fields: [{ name: 'role', type: 'text' }, { name: 'site', type: 'text' }] }],
      admin: { user: 'users' },
      plugins: [
        membershipPlugin({
          stripe: fakeStripe().stripe,
          canManage: ({ req }) => answer(req.user as Doc) as never,
          overrides: {
            tiers: (c) => withSite(c, { drafts: true }),
            categories: (c) => ({ ...withSite(c, { drafts: true }), fields: localParent([...c.fields, SITE_FIELD]) }),
            memberships: (c) => withSite(c, true),
            // A host that rebuilds access from scratch, keeping only the rules it names.
            payments: (c) => ({ ...withSite(c, true), access: { read: c.access!.read, create: c.access!.create, update: c.access!.update, delete: c.access!.delete } }),
          },
        }),
      ],
    }),
  })
  const models = (payload.db as unknown as { collections: Record<string, { createCollection: () => Promise<unknown>; ensureIndexes: () => Promise<unknown> }> }).collections
  for (const m of Object.values(models)) await m.createCollection().catch(() => undefined)
  for (const m of Object.values(models)) await m.ensureIndexes()
  const user = (email: string, site: string, role: string) => payload.create({ collection: 'users', data: { email, password: PASSWORD, role, site } as never }) as Promise<Doc>
  memberA = await user('member-a@example.com', 'a', 'member')
  memberB = await user('member-b@example.com', 'b', 'member')
  managerA = await user('manager-a@example.com', 'a', 'manager')
  managerB = await user('manager-b@example.com', 'b', 'manager')
  adminAll = await user('admin@example.com', 'a', 'admin')
  const create = (collection: string, data: Doc) => payload.create({ collection: collection as never, data: data as never, depth: 0 }) as Promise<Doc>
  tierA = await create(TIERS, { site: 'a', name: 'Friend A', _status: 'published' })
  tierB = await create(TIERS, { site: 'b', name: 'Friend B', _status: 'published' })
  const membership = (site: string, u: Doc, tier: Doc) =>
    create(MS, { site, label: `Made-up ${site}`, user: u.id, kind: 'tier', tier: tier.id, status: 'active', interval: 'month', amount: 500, currency: 'usd', notes: `staff note ${site}`, stripe: { customer: `cus_${site}` } })
  mA = await membership('a', memberA, tierA)
  mB = await membership('b', memberB, tierB)
  // A second save, so each membership has more than one version.
  for (const m of [mA, mB]) await payload.update({ collection: MS as never, id: m.id, data: { notes: `staff note ${m.site}, second` } as never })
  payA = await create(PAY, { site: 'a', membership: mA.id, user: memberA.id, amount: 500, currency: 'usd', paidAt: '2026-01-01T00:00:00.000Z', invoiceId: 'in_made_up_a' })
  payB = await create(PAY, { site: 'b', membership: mB.id, user: memberB.id, amount: 500, currency: 'usd', paidAt: '2026-01-01T00:00:00.000Z', invoiceId: 'in_made_up_b' })
}, 180_000)

afterAll(async () => {
  await payload?.destroy()
  await mongo?.stop()
})

/** Which parents' versions a caller saw: none when refused outright. */
const parents = (res: { status: number; body: Doc }) => (res.status === 200 ? ((res.body.docs ?? []) as Doc[]).map((d) => idOf(d.parent)).sort() : [])

describe('reading saved versions', () => {
  const rows = () => [
    { collection: MS, a: mA, b: mB, list: 'versionsMemberships', one: 'versionMembership' },
    { collection: TIERS, a: tierA, b: tierB, list: 'versionsMembershipTiers', one: 'versionMembershipTier' },
    { collection: PAY, a: payA, b: payB, list: 'versionsMembershipPayments', one: 'versionMembershipPayment' },
  ]

  it('keeps versions for managers: members and signed-out callers get none (REST and GraphQL, list and by id)', async () => {
    for (const { collection, a, b, list, one } of rows()) {
      const vb = (await versionsOf(collection, b.id))[0]!
      const va = (await versionsOf(collection, a.id))[0]!
      for (const who of [memberA, memberB, null]) {
        const label = `${collection} ${who?.email ?? 'signed out'}`
        expect(parents(await rest('GET', `/${collection}/versions?depth=0`, who)), label).toEqual([])
        expect(parents(await rest('GET', `/${collection}/versions?depth=0&where[parent][equals]=${b.id}`, who)), label).toEqual([])
        for (const v of [va, vb]) expect((await rest('GET', `/${collection}/versions/${v.id}?depth=0`, who)).status, label).not.toBe(200)
        const all = await gql(`{ ${list} { docs { id } } }`, who)
        expect(all.data?.[list]?.docs ?? [], label).toEqual([])
        const byId = await gql(`{ ${one}(id: "${vb.id}") { id } }`, who)
        expect(byId.data?.[one] ?? null, label).toBeNull()
        if (who) {
          await expect(payload.findVersions({ collection: collection as never, ...as(who) }).then((r) => r.docs.length), label).rejects.toThrow()
          await expect(payload.findVersionByID({ collection: collection as never, id: vb.id, ...as(who) }), label).rejects.toThrow()
        }
      }
    }
  })

  it('gives a limited manager only their own site’s versions, and an all-site manager every one', async () => {
    for (const { collection, a, b, list, one } of rows()) {
      const vb = (await versionsOf(collection, b.id))[0]!
      const va = (await versionsOf(collection, a.id))[0]!
      expect(new Set(parents(await rest('GET', `/${collection}/versions?depth=0&limit=100`, managerA))), collection).toEqual(new Set([String(a.id)]))
      expect(new Set(parents(await rest('GET', `/${collection}/versions?depth=0&limit=100`, managerB))), collection).toEqual(new Set([String(b.id)]))
      expect(parents(await rest('GET', `/${collection}/versions?depth=0&where[parent][equals]=${b.id}`, managerA)), collection).toEqual([])
      expect((await rest('GET', `/${collection}/versions/${vb.id}?depth=0`, managerA)).status, collection).not.toBe(200)
      expect((await rest('GET', `/${collection}/versions/${va.id}?depth=0`, managerA)).status, collection).toBe(200)
      const all = await gql(`{ ${list}(limit: 100) { docs { parent { id } } } }`, managerA)
      expect(new Set(((all.data?.[list]?.docs ?? []) as Doc[]).map((d) => idOf(d.parent))), collection).toEqual(new Set([String(a.id)]))
      expect((await gql(`{ ${one}(id: "${vb.id}") { id } }`, managerA)).data?.[one] ?? null, collection).toBeNull()
      expect((await gql(`{ ${one}(id: "${va.id}") { id } }`, managerA)).data?.[one]?.id, collection).toBe(String(va.id))
      expect(new Set(parents(await rest('GET', `/${collection}/versions?depth=0&limit=100`, adminAll))), collection).toEqual(new Set([String(a.id), String(b.id)]))
    }
  })

  it('shows a limited manager the full versions of their own site’s memberships', async () => {
    const res = await rest('GET', `/${MS}/versions?depth=0&where[parent][equals]=${mA.id}&sort=-createdAt`, managerA)
    expect(res.status).toBe(200)
    expect(res.body.docs[0].version.notes).toBe('staff note a, second')
  })

  it('leaves restoring to managers and server code, and the row unchanged', async () => {
    const [first] = await versionsOf(MS, mA.id)
    for (const who of [memberA, null]) expect((await rest('POST', `/${MS}/versions/${first!.id}`, who)).status, String(who?.email)).toBe(403)
    await expect(payload.restoreVersion({ collection: MS as never, id: first!.id, ...as(memberA) })).rejects.toThrow()
    expect(((await payload.findByID({ collection: MS as never, id: mA.id, depth: 0 })) as Doc).notes).toBe('staff note a, second')
  })
})

describe('a category’s parent when only the parent is localized', () => {
  const mk = (name: string, site: string, parent?: unknown) =>
    payload.create({ collection: CATS as never, data: { name, site, _status: 'published', ...(parent ? { parent } : {}) } as never, depth: 0, locale: 'en' }) as Promise<Doc>
  const count = async () => (await payload.count({ collection: CATS as never })).totalDocs

  it('judges every locale’s parent on duplicate, update and restore, and allows it once the other locale is cleared', async () => {
    const catA = await mk('Home A', 'a')
    const catB = await mk('Home B', 'b')
    const lc = await mk('Two parents', 'a', catA.id)
    // Server code points the French parent at another site's category.
    await payload.update({ collection: CATS as never, id: lc.id, locale: 'fr', data: { parent: catB.id, _status: 'published' } as never })
    const elsewhere = (await versionsOf(CATS, lc.id)).at(-1)!
    expect(idOf(elsewhere.version.parent.fr)).toBe(String(catB.id))
    const rows = await count()

    await expect(payload.duplicate({ collection: CATS as never, id: lc.id, locale: 'en', data: { site: 'a' } as never, ...as(managerA) })).rejects.toThrow(/parent category is outside/)
    const viaRest = await rest('POST', `/${CATS}/${lc.id}/duplicate?locale=en`, managerA, { site: 'a' })
    expect(viaRest.status).toBe(403)
    expect(await count()).toBe(rows)
    await expect(payload.update({ collection: CATS as never, id: lc.id, locale: 'en', data: { name: 'Renamed' } as never, ...as(managerA) })).rejects.toThrow(/parent category is outside/)
    expect((await rest('PATCH', `/${CATS}/${lc.id}?locale=en`, managerA, { name: 'Renamed' })).status).toBe(403)
    // Sending a parent for every locale at once is judged per locale too.
    await expect(payload.update({ collection: CATS as never, id: lc.id, locale: 'all' as never, data: { parent: { en: catA.id, fr: catB.id } } as never, ...as(managerA) })).rejects.toThrow(/parent category is outside/)

    // Clearing the French parent is allowed, and then the row can be edited and copied.
    await payload.update({ collection: CATS as never, id: lc.id, locale: 'fr', data: { parent: null } as never, ...as(managerA) })
    await expect(payload.update({ collection: CATS as never, id: lc.id, locale: 'en', data: { name: 'Renamed' } as never, ...as(managerA) })).resolves.toMatchObject({ name: 'Renamed' })
    const copy = (await payload.duplicate({ collection: CATS as never, id: lc.id, locale: 'all' as never, data: { site: 'a' } as never, depth: 0, ...as(managerA) })) as Doc
    expect(idOf(copy.parent?.en)).toBe(String(catA.id))
    expect(copy.parent?.fr ?? null).toBeNull()

    // Restoring the version with the French parent on another site is refused.
    await expect(payload.restoreVersion({ collection: CATS as never, id: elsewhere.id, ...as(managerA) })).rejects.toThrow(/parent category is outside/)
    const now = (await payload.findByID({ collection: CATS as never, id: lc.id, locale: 'all' as never, depth: 0 })) as Doc
    expect(now.parent?.fr ?? null).toBeNull()

    // An all-site manager and server code may still do all of it.
    await expect(payload.restoreVersion({ collection: CATS as never, id: elsewhere.id, ...as(adminAll) })).resolves.toBeTruthy()
    await expect(payload.duplicate({ collection: CATS as never, id: lc.id, locale: 'en', data: { site: 'a' } as never, ...as(adminAll) })).resolves.toBeTruthy()
    // Server code acting for a limited manager, with access overridden as the Local API does by default.
    const user = { ...managerA, collection: 'users' } as never
    await expect(payload.update({ collection: CATS as never, id: lc.id, locale: 'en', data: { name: 'Server rename' } as never, user })).resolves.toMatchObject({ name: 'Server rename' })
    await expect(payload.duplicate({ collection: CATS as never, id: lc.id, locale: 'en', data: { site: 'a' } as never, user })).resolves.toBeTruthy()
    await expect(payload.restoreVersion({ collection: CATS as never, id: elsewhere.id, user })).resolves.toBeTruthy()
  })

  it('lets a manager keep same-site parents in both locales', async () => {
    const p1 = await mk('Parent one', 'a')
    const p2 = await mk('Parent two', 'a')
    const c = await mk('Child', 'a', p1.id)
    await payload.update({ collection: CATS as never, id: c.id, locale: 'fr', data: { parent: p2.id } as never, ...as(managerA) })
    const copy = (await payload.duplicate({ collection: CATS as never, id: c.id, locale: 'en', data: { site: 'a' } as never, depth: 0, ...as(managerA) })) as Doc
    expect(idOf(copy.parent)).toBe(String(p1.id))
    expect((await rest('PATCH', `/${CATS}/${c.id}?locale=en`, managerA, { name: 'Child renamed' })).status).toBe(200)
  })
})

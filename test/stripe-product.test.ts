import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, handleEndpoints, type CollectionConfig, type Field, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { membershipPlugin, startCheckout } from '../src/index.js'
import { fakeStripe } from './fake-stripe.js'

// `stripeProduct` on tiers and categories is set only by server code, and a copy of a row starts without
// one. Run twice: on a plain host, and on one that turns on localization (the field included) and drafts.
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const PASSWORD = 'a-made-up-test-password'
const SITE_FIELD = { name: 'site', type: 'text' as const, index: true }
const SLUGS = ['membership-tiers', 'membership-categories'] as const

let mongo: MongoMemoryReplSet

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
}, 120_000)

afterAll(async () => {
  await mongo?.stop()
})

describe.each([
  { host: 'a plain host', rich: false },
  { host: 'a host with localization and drafts', rich: true },
])('stripeProduct on $host', ({ rich }) => {
  const KEY = `membership-stripe-product-${rich ? 'rich' : 'plain'}`
  let payload: Payload
  let managerA: Doc, admin: Doc, member: Doc
  const { stripe, calls } = fakeStripe()
  let n = 0

  const withHost = (c: CollectionConfig): CollectionConfig => ({
    ...c,
    ...(rich ? { versions: { drafts: true } } : {}),
    fields: [...c.fields.map((f) => (rich && 'name' in f && f.name === 'stripeProduct' ? ({ ...f, localized: true } as Field) : f)), SITE_FIELD],
  })

  beforeAll(async () => {
    payload = await getPayload({
      key: KEY,
      config: await buildConfig({
        secret: 'test-secret-not-for-production',
        telemetry: false,
        serverURL: 'https://members.example.com',
        typescript: { autoGenerate: false },
        db: mongooseAdapter({ url: mongo.getUri(KEY), ensureIndexes: true }),
        ...(rich ? { localization: { locales: ['en', 'fr'], defaultLocale: 'en', fallback: true } } : {}),
        collections: [{ slug: 'users', auth: true, fields: [{ name: 'role', type: 'text' }, { name: 'site', type: 'text' }] }],
        admin: { user: 'users' },
        plugins: [
          membershipPlugin({
            stripe,
            scopeField: 'site',
            canManage: ({ req }) => {
              const u = req.user as Doc
              return u.role === 'manager' ? { site: { equals: u.site } } : u.role === 'admin'
            },
            overrides: { tiers: withHost, categories: withHost, memberships: (c) => ({ ...c, fields: [...c.fields, SITE_FIELD] }) },
          }),
        ],
      }),
    })
    const user = (email: string, role: string) => payload.create({ collection: 'users', data: { email, password: PASSWORD, role, site: 'a' } as never }) as Promise<Doc>
    managerA = await user(`manager-${KEY}@example.com`, 'manager')
    admin = await user(`admin-${KEY}@example.com`, 'admin')
    member = await user(`member-${KEY}@example.com`, 'member')
  }, 120_000)

  afterAll(async () => {
    await payload?.destroy()
  })

  const tokens = new Map<string, string>()
  async function rest(method: string, path: string, user: Doc, body?: unknown) {
    if (!tokens.has(String(user.id))) tokens.set(String(user.id), (await payload.login({ collection: 'users', data: { email: user.email, password: PASSWORD } })).token!)
    const headers = new Headers({ 'content-type': 'application/json', Authorization: `JWT ${tokens.get(String(user.id))}` })
    const request = new Request(`https://members.example.com/api${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    const res = await handleEndpoints({ config: Promise.resolve(payload.config), payloadInstanceCacheKey: KEY, request } as never)
    return { status: res.status, body: (await res.json()) as Doc }
  }
  const as = (u: Doc) => ({ user: { ...u, collection: 'users' } as never, overrideAccess: false as const })

  /** A row made by server code, with its own product (in every locale when localized). */
  async function seed(collection: string, site: string, product: string | null = `prod_seed_${++n}`): Promise<Doc> {
    const doc = (await payload.create({
      collection: collection as never,
      data: { name: `Row ${++n}`, site, active: true, monthly: 500, ...(product ? { stripeProduct: product } : {}), ...(rich ? { _status: 'published' } : {}) } as never,
    })) as Doc
    if (rich && product) await payload.update({ collection: collection as never, id: doc.id, locale: 'fr' as never, data: { stripeProduct: `${product}_fr`, _status: 'published' } as never })
    return { ...doc, product }
  }

  /** Everything stored for a row: the main record and, with drafts, its latest version, all locales. */
  async function stored(collection: string, id: unknown): Promise<string> {
    const read = (draft: boolean) => payload.findByID({ collection: collection as never, id: id as string, depth: 0, draft, ...(rich ? { locale: 'all' as never } : {}) }) as Promise<Doc>
    const raw = await payload.db.findOne({ collection: collection as never, where: { id: { equals: id } } })
    const docs = [await read(false), ...(rich ? [await read(true)] : [])]
    return JSON.stringify([raw, ...docs])
  }
  const productsIn = async (collection: string, id: unknown) => (await stored(collection, id)).match(/prod_\w+/g) ?? []

  /** Every spelling a caller might try. */
  const attempts = (): Doc[] => [
    { stripeProduct: 'prod_caller' },
    ...(rich ? [{ stripeProduct: { en: 'prod_caller', fr: 'prod_caller' } }] : []),
  ]
  const localeArgs = rich ? ([{}, { locale: 'fr' }, { locale: 'all' }, { draft: true }] as Doc[]) : [{} as Doc]
  const queries = rich ? ['', '?locale=fr', '?locale=all', '?draft=true'] : ['']
  /** A refused request is as good as an ignored field; anything else must not fail unexpectedly. */
  const settle = async (p: Promise<unknown>) => (await p.then((d) => d as Doc, () => null)) as Doc | null

  describe.each(SLUGS)('%s', (collection) => {
    it('ignores it on a create by a manager (Local API)', async () => {
      for (const who of [managerA, admin])
        for (const extra of attempts())
          for (const args of localeArgs) {
            const label = JSON.stringify([who.role, extra, args])
            const made = await settle(payload.create({ collection: collection as never, data: { name: `Mine ${++n}`, site: 'a', ...extra } as never, depth: 0, ...args, ...as(who) } as never))
            if (!made) continue
            expect(await productsIn(collection, made.id), label).toEqual([])
          }
      // The plain spelling is ignored, not refused.
      const plain = (await payload.create({ collection: collection as never, data: { name: `Mine ${++n}`, site: 'a', stripeProduct: 'prod_caller' } as never, ...as(managerA) })) as Doc
      expect(await productsIn(collection, plain.id)).toEqual([])
    })

    it('ignores it on a create by a manager (REST)', async () => {
      for (const who of [managerA, admin])
        for (const extra of attempts())
          for (const query of queries) {
            const res = await rest('POST', `/${collection}${query}`, who, { name: `Rest ${++n}`, site: 'a', ...extra })
            if (res.status >= 400) continue
            expect(await productsIn(collection, res.body.doc.id), JSON.stringify([who.role, extra, query])).toEqual([])
          }
    })

    it('leaves the stored value alone on updates by a manager (Local API and REST, single and bulk)', async () => {
      const row = await seed(collection, 'a')
      const before = (await productsIn(collection, row.id)).sort()
      expect(before.length).toBeGreaterThan(0)
      const same = async (label: string) => expect([...new Set(await productsIn(collection, row.id))].sort(), label).toEqual([...new Set(before)].sort())
      for (const who of [managerA, admin])
        for (const extra of [...attempts(), { stripeProduct: null }, { stripeProduct: '' }]) {
          for (const args of localeArgs) {
            await settle(payload.update({ collection: collection as never, id: row.id, data: extra as never, ...args, ...as(who) } as never))
            await same(`local ${who.role} ${JSON.stringify([extra, args])}`)
            await settle(payload.update({ collection: collection as never, where: { id: { equals: row.id } }, data: extra as never, ...args, ...as(who) } as never))
            await same(`local bulk ${who.role} ${JSON.stringify([extra, args])}`)
          }
          for (const query of queries) {
            await rest('PATCH', `/${collection}/${row.id}${query}`, who, extra)
            await same(`REST ${who.role} ${JSON.stringify([extra, query])}`)
            await rest('PATCH', `/${collection}${query ? `${query}&` : '?'}where[id][equals]=${row.id}`, who, extra)
            await same(`REST bulk ${who.role} ${JSON.stringify([extra, query])}`)
          }
        }
    })

    it('starts a copy without one when a manager duplicates a row (Local API)', async () => {
      for (const site of ['a', 'b']) {
        const source = await seed(collection, site)
        for (const who of [managerA, admin])
          for (const data of [undefined, {}, { site: 'a' }, ...attempts().map((x) => ({ site: 'a', ...x }))])
            for (const args of [...localeArgs, ...(rich ? [{ selectedLocales: ['fr'] }] : [])]) {
              const label = JSON.stringify([site, who.role, data, args])
              const copy = await settle(payload.duplicate({ collection: collection as never, id: source.id, data: data as never, depth: 0, ...args, ...as(who) } as never))
              if (!copy) continue
              expect(JSON.stringify(copy), label).not.toMatch(/prod_/)
              expect(await productsIn(collection, copy.id), label).toEqual([])
            }
        expect(await productsIn(collection, source.id)).toContain(source.product)
      }
      // Not vacuous: an ordinary duplicate goes through.
      const own = await seed(collection, 'a')
      const copy = (await payload.duplicate({ collection: collection as never, id: own.id, data: { site: 'a' } as never, ...as(managerA) })) as Doc
      expect(copy.id).not.toEqual(own.id)
      expect(await productsIn(collection, copy.id)).toEqual([])
    })

    it('starts a copy without one when a manager duplicates a row (REST)', async () => {
      const source = await seed(collection, 'b')
      let made = 0
      for (const who of [managerA, admin])
        for (const body of [undefined, {}, { site: 'a' }, ...attempts().map((x) => ({ site: 'a', ...x }))])
          for (const query of queries) {
            const res = await rest('POST', `/${collection}/${source.id}/duplicate${query}`, who, body)
            if (res.status >= 400) continue
            made++
            const label = JSON.stringify([who.role, body, query])
            expect(JSON.stringify(res.body), label).not.toMatch(/prod_/)
            expect(await productsIn(collection, res.body.doc.id), label).toEqual([])
          }
      expect(made).toBeGreaterThan(0)
    })

    it('starts a copy without one when the host’s server code duplicates a row', async () => {
      const source = await seed(collection, 'a')
      for (const data of [undefined, { name: 'Server copy' }])
        for (const args of [...localeArgs, ...(rich ? [{ selectedLocales: ['fr'] }] : [])]) {
          const label = JSON.stringify([data, args])
          const copy = (await payload.duplicate({ collection: collection as never, id: source.id, data: data as never, depth: 0, ...args } as never)) as Doc
          expect(await productsIn(collection, copy.id), label).toEqual([])
          // Also with a signed-in user passed along, access still overridden.
          const withUser = (await payload.duplicate({ collection: collection as never, id: source.id, data: data as never, ...args, user: { ...managerA, collection: 'users' } } as never)) as Doc
          expect(await productsIn(collection, withUser.id), label).toEqual([])
        }
      expect(await productsIn(collection, source.id)).toContain(source.product)
    })

    it('keeps what server code writes on purpose: create, update and a value given to duplicate', async () => {
      const row = await seed(collection, 'a')
      expect(await productsIn(collection, row.id)).toContain(row.product)
      await payload.update({ collection: collection as never, id: row.id, data: { stripeProduct: 'prod_moved', ...(rich ? { _status: 'published' } : {}) } as never })
      expect(await productsIn(collection, row.id)).toContain('prod_moved')
      const copy = (await payload.duplicate({ collection: collection as never, id: row.id, data: { stripeProduct: 'prod_given' } as never })) as Doc
      expect(copy.stripeProduct).toBe('prod_given')
    })

    it('stays readable to a manager of the row, and keeps its value when they edit other fields', async () => {
      const row = await seed(collection, 'a')
      const edited = (await payload.update({ collection: collection as never, id: row.id, data: { name: 'Renamed', ...(rich ? { _status: 'published' } : {}) } as never, ...as(managerA) })) as Doc
      expect(edited.stripeProduct).toBe(row.product)
      const other = await seed(collection, 'b')
      expect(JSON.stringify(await payload.findByID({ collection: collection as never, id: other.id, ...as(managerA) }))).not.toMatch(/prod_/)
    })
  })

  it('gives a copy its own product at its first checkout, reuses it after, and leaves the source’s alone', async () => {
    for (const collection of SLUGS) {
      const source = await seed(collection, 'a')
      const copy = (await payload.duplicate({ collection: collection as never, id: source.id, data: { name: `Copy of ${collection}`, site: 'a', active: true, ...(rich ? { _status: 'published' } : {}) } as never, ...as(managerA) })) as Doc
      const checkout = (email: string) =>
        startCheckout(payload, {
          user: { id: member.id, email },
          interval: 'month',
          scope: null,
          successURL: 'https://members.example.com/ok',
          cancelURL: 'https://members.example.com/no',
          ...(collection === 'membership-tiers' ? { tier: String(copy.id) } : { pledges: [{ category: String(copy.id), amount: 900 }] }),
        })
      const before = calls.filter((c) => c.what === 'product').length
      await checkout(member.email)
      await checkout(member.email)
      const made = calls.filter((c) => c.what === 'product').slice(before)
      expect(made.map((c) => c.params.metadata)).toEqual([{ payloadCollection: collection, payloadId: String(copy.id) }])
      const own = ((await payload.findByID({ collection: collection as never, id: copy.id })) as Doc).stripeProduct
      expect(own).toMatch(/^prod_\d+$/)
      const lines = calls.filter((c) => c.what === 'checkout').slice(-2).map((c) => c.params.line_items[0].price_data.product)
      expect(lines).toEqual([own, own])
      expect(await productsIn(collection, source.id)).toContain(source.product)
    }
  })

  it('is not open to a create or duplicate of a membership or payment by any manager', async () => {
    for (const collection of ['memberships', 'membership-payments'])
      for (const who of [managerA, admin]) {
        await expect(payload.create({ collection: collection as never, data: {} as never, ...as(who) }), collection).rejects.toThrow(/not allowed/)
        expect((await rest('POST', `/${collection}`, who, {})).status, collection).toBe(403)
      }
    const row = (await payload.create({ collection: 'memberships' as never, data: { label: 'y', user: member.id, kind: 'tier', status: 'active', interval: 'month', amount: 500, currency: 'usd', site: 'a' } as never })) as Doc
    for (const who of [managerA, admin]) {
      await expect(payload.duplicate({ collection: 'memberships' as never, id: row.id, ...as(who) })).rejects.toThrow()
      expect((await rest('POST', `/memberships/${row.id}/duplicate`, who, {})).status).toBeGreaterThanOrEqual(400)
    }
  })
})

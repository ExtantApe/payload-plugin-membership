import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { membershipPlugin, startCheckout } from '../src/index.js'
import { fakeStripe } from './fake-stripe.js'

// Upgrading from 0.2.0 (the same plugin code as commit 97fb115): rows in the shape 0.2.0 stores,
// written straight to a throwaway database, then read and edited with this version. Also runs the
// clean-up steps the README gives a host, against a fake Stripe. Made-up sites and people.
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const KEY = 'membership-upgrade'
const PASSWORD = 'a-made-up-test-password'
const SITE_FIELD = { name: 'site', type: 'text' as const, index: true }
const TIERS = 'membership-tiers'
const CATS = 'membership-categories'

let mongo: MongoMemoryReplSet
let payload: Payload
const { stripe, calls } = fakeStripe()
let managerA: Doc, member: Doc
const rows: Record<string, Doc> = {}

/** What the host's own Stripe account says about each product (made up): its metadata names one row. */
const stripeProducts = new Map<string, { metadata: Record<string, string> }>()

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
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
          scopeField: 'site',
          canManage: ({ req }) => ((req.user as Doc).role === 'manager' ? { site: { equals: (req.user as Doc).site } } : false),
          overrides: {
            tiers: (c) => ({ ...c, fields: [...c.fields, SITE_FIELD] }),
            categories: (c) => ({ ...c, fields: [...c.fields, SITE_FIELD] }),
            memberships: (c) => ({ ...c, fields: [...c.fields, SITE_FIELD] }),
          },
        }),
      ],
    }),
  })
  managerA = (await payload.create({ collection: 'users', data: { email: 'manager-a@example.com', password: PASSWORD, role: 'manager', site: 'a' } as never })) as Doc
  member = (await payload.create({ collection: 'users', data: { email: 'member@example.com', password: PASSWORD, role: 'member', site: 'a' } as never })) as Doc
  // Older rows, written straight to the database to stand in for data a site already has.
  const put = async (name: string, collection: string, data: Doc) => (rows[name] = (await payload.db.create({ collection: collection as never, data: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...data } })) as Doc)
  await put('original', TIERS, { name: 'Original', site: 'a', active: true, monthly: 500, stripeProduct: 'prod_shared', _order: 'a0' })
  await put('copied', TIERS, { name: 'Copied', site: 'a', active: true, monthly: 700, stripeProduct: 'prod_shared', _order: 'a1' })
  await put('mismatched', TIERS, { name: 'Mismatched product', site: 'a', active: true, monthly: 900, stripeProduct: 'prod_mismatched', _order: 'a2' })
  await put('fine', TIERS, { name: 'Fine', site: 'a', active: true, monthly: 1100, stripeProduct: 'prod_fine', _order: 'a3' })
  await put('catB', CATS, { name: 'Site B parent', site: 'b', active: true, _order: 'a0' })
  await put('catA', CATS, { name: 'Nested child', site: 'a', active: true, parent: rows.catB!.id, _order: 'a1' })
  await put('membership', 'memberships', { label: 'Old row', user: member.id, kind: 'tier', tier: rows.fine!.id, status: 'active', interval: 'month', amount: 1100, currency: 'usd', totalPaid: 1_100, site: 'a', stripe: { customer: 'cus_old', subscription: 'sub_old' } })
  await put('payment', 'membership-payments', { membership: rows.membership!.id, user: member.id, amount: 1100, currency: 'usd', paidAt: new Date().toISOString(), invoiceId: 'in_old', tier: rows.fine!.id })
  stripeProducts.set('prod_shared', { metadata: { payloadCollection: TIERS, payloadId: String(rows.original!.id) } })
  stripeProducts.set('prod_mismatched', { metadata: { payloadCollection: TIERS, payloadId: 'some-other-row' } })
  stripeProducts.set('prod_fine', { metadata: { payloadCollection: TIERS, payloadId: String(rows.fine!.id) } })
}, 180_000)

afterAll(async () => {
  await payload?.destroy()
  await mongo?.stop()
})

const as = (u: Doc) => ({ user: { ...u, collection: 'users' } as never, overrideAccess: false as const })
const get = (collection: string, id: unknown) => payload.findByID({ collection: collection as never, id: id as string, depth: 0 }) as Promise<Doc>

/**
 * The README's stored product clean-up, from server code: clear any product id that more than one
 * row holds, or whose Stripe metadata doesn't name this row. The next checkout makes a fresh one.
 */
async function cleanUpProducts(retrieve: (id: string) => Promise<{ metadata: Record<string, string> } | null>) {
  const cleared: string[] = []
  for (const collection of [TIERS, CATS]) {
    const { docs } = await payload.find({ collection: collection as never, where: { stripeProduct: { exists: true } }, depth: 0, pagination: false, overrideAccess: true })
    const holders = new Map<string, number>()
    for (const d of docs as Doc[]) holders.set(d.stripeProduct, (holders.get(d.stripeProduct) ?? 0) + 1)
    for (const d of docs as Doc[]) {
      const product = await retrieve(d.stripeProduct).catch(() => null)
      const own = product?.metadata.payloadCollection === collection && product.metadata.payloadId === String(d.id)
      if (holders.get(d.stripeProduct)! > 1 || !own) {
        await payload.update({ collection: collection as never, id: d.id, data: { stripeProduct: null } as never, overrideAccess: true })
        cleared.push(d.name)
      }
    }
  }
  return cleared.sort()
}

describe('upgrading rows stored by 0.2.0', () => {
  it('reads them as before', async () => {
    expect((await payload.find({ collection: TIERS as never, pagination: false, overrideAccess: false })).docs.map((d) => (d as Doc).name)).toEqual(['Original', 'Copied', 'Mismatched product', 'Fine'])
    expect(await get('memberships', rows.membership!.id)).toMatchObject({ status: 'active', totalPaid: 1_100 })
  })

  it('refuses a limited manager’s edit of a category whose parent is on another site until the parent is cleared', async () => {
    await expect(payload.update({ collection: CATS as never, id: rows.catA!.id, data: { name: 'Renamed' } as never, ...as(managerA) })).rejects.toThrow(/parent category is outside/)
    expect((await get(CATS, rows.catA!.id)).name).toBe('Nested child')
    await payload.update({ collection: CATS as never, id: rows.catA!.id, data: { parent: null } as never, ...as(managerA) })
    await expect(payload.update({ collection: CATS as never, id: rows.catA!.id, data: { name: 'Renamed' } as never, ...as(managerA) })).resolves.toMatchObject({ name: 'Renamed', parent: null })
  })

  it('the stored product clean-up clears shared and mismatched ids, and checkout then makes fresh ones', async () => {
    expect(await cleanUpProducts(async (id) => stripeProducts.get(id) ?? null)).toEqual(['Copied', 'Mismatched product', 'Original'])
    expect((await get(TIERS, rows.fine!.id)).stripeProduct).toBe('prod_fine')
    // Running it again finds nothing.
    expect(await cleanUpProducts(async (id) => stripeProducts.get(id) ?? null)).toEqual([])
    const before = calls.filter((c) => c.what === 'product').length
    const newcomer = (await payload.create({ collection: 'users', data: { email: 'newcomer@example.com', password: PASSWORD, role: 'member', site: 'a' } as never })) as Doc
    await startCheckout(payload, { user: { id: newcomer.id, email: newcomer.email }, interval: 'month', scope: 'a', tier: String(rows.copied!.id), successURL: 'https://members.example.com/ok', cancelURL: 'https://members.example.com/no' })
    const made = calls.filter((c) => c.what === 'product').slice(before)
    expect(made.map((c) => c.params.metadata)).toEqual([{ payloadCollection: TIERS, payloadId: String(rows.copied!.id) }])
  })
})

import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, handleEndpoints, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { membershipPlugin } from '../src/index.js'
import { fakeStripe } from './fake-stripe.js'

// A multi-site host WITHOUT any tenant plugin: the only thing keeping a manager to their own site is
// what `canManage` returns. Made-up sites, example.com people, a fake Stripe.
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const KEY = 'membership-manager-scope'
const PASSWORD = 'a-made-up-test-password'
const SITE_FIELD = { name: 'site', type: 'text' as const, index: true }

let mongo: MongoMemoryReplSet
let payload: Payload
const { stripe, calls, subs, event } = fakeStripe()
/** What the host's `canManage` answers, per role, so a test can swap the answer. */
let answer: (user: Doc) => unknown = (u) => (u.role === 'manager' ? { site: { equals: u.site } } : u.role === 'admin' ? true : false)

let managerA: Doc, memberA: Doc, memberB: Doc, adminAll: Doc, bothRoles: Doc
let tierA: Doc, tierB: Doc
let mA: Doc, mB: Doc

const tokens = new Map<string, string>()
async function rest(method: string, path: string, user: Doc | null, opts: { body?: unknown; site?: string } = {}) {
  const headers = new Headers({ 'content-type': 'application/json', ...(opts.site ? { 'x-site': opts.site } : {}) })
  if (user) {
    if (!tokens.has(String(user.id))) tokens.set(String(user.id), (await payload.login({ collection: 'users', data: { email: user.email, password: PASSWORD } })).token!)
    headers.set('Authorization', `JWT ${tokens.get(String(user.id))}`)
  }
  const request = new Request(`https://members.example.com/api${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) })
  const res = await handleEndpoints({ config: Promise.resolve(payload.config), payloadInstanceCacheKey: KEY, request } as never)
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Doc }
}
const as = (u: Doc) => ({ user: { ...u, collection: 'users' } as never, overrideAccess: false as const })
const get = (collection: string, id: unknown) => payload.findByID({ collection: collection as never, id: id as string, depth: 0 }) as Promise<Doc>
const webhook = (e: Doc) => rest('POST', '/memberships/stripe-webhook', null, { body: e }).catch(() => null)

async function join(member: Doc, site: string, tier: Doc, sub: string, invoice: string) {
  const res = await rest('POST', '/memberships/checkout', member, { site, body: { tier: String(tier.id), interval: 'month' } })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  const id = res.body.membership as string
  subs.set(sub, { id: sub, status: 'active', customer: `cus_${sub}`, items: { data: [{ id: `si_${sub}`, current_period_end: 1_900_000_000 }] }, metadata: { membership: id } })
  const signed = async (e: Doc) => {
    const request = new Request('https://members.example.com/api/memberships/stripe-webhook', { method: 'POST', headers: { 'stripe-signature': 'good' }, body: JSON.stringify(e) })
    return handleEndpoints({ config: Promise.resolve(payload.config), payloadInstanceCacheKey: KEY, request } as never)
  }
  await signed(event('checkout.session.completed', { mode: 'subscription', metadata: { membership: id }, subscription: sub, customer: `cus_${sub}` }))
  await signed(event('invoice.paid', { id: invoice, subscription: sub, amount_paid: tier.monthly, currency: 'usd', created: 1_800_000_000 }))
  await payload.update({ collection: 'memberships' as never, id, data: { notes: `note ${site}` } as never })
  return get('memberships', id)
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  payload = await getPayload({
    key: KEY,
    config: await buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      serverURL: 'https://members.example.com',
      typescript: { autoGenerate: false },
      db: mongooseAdapter({ url: mongo.getUri('membership-manager-scope'), ensureIndexes: true }),
      collections: [{ slug: 'users', auth: true, fields: [{ name: 'role', type: 'text' }, { name: 'site', type: 'text' }] }],
      admin: { user: 'users' },
      plugins: [
        membershipPlugin({
          stripe,
          webhookSecret: 'whsec_test',
          scopeField: 'site',
          scopeOf: (req: PayloadRequest) => req.headers.get('x-site') ?? null,
          canManage: ({ req }) => answer(req.user as Doc) as never,
          overrides: {
            tiers: (c) => ({ ...c, fields: [...c.fields, SITE_FIELD] }),
            categories: (c) => ({ ...c, fields: [...c.fields, SITE_FIELD] }),
            memberships: (c) => ({ ...c, fields: [...c.fields, SITE_FIELD] }),
          },
        }),
      ],
    }),
  })
  const models = (payload.db as unknown as { collections: Record<string, { createCollection: () => Promise<unknown>; ensureIndexes: () => Promise<unknown> }> }).collections
  for (const m of Object.values(models)) await m.createCollection().catch(() => undefined)
  for (const m of Object.values(models)) await m.ensureIndexes()
  const user = (email: string, site: string, role = 'member') => payload.create({ collection: 'users', data: { email, password: PASSWORD, role, site } as never }) as Promise<Doc>
  managerA = await user('manager-a@example.com', 'a', 'manager')
  memberA = await user('member-a@example.com', 'a')
  memberB = await user('member-b@example.com', 'b')
  adminAll = await user('admin@example.com', 'a', 'admin')
  // Manager of site A, and a plain member of site B (the case that was open).
  bothRoles = managerA
  const create = (collection: string, data: Doc) => payload.create({ collection: collection as never, data: data as never, depth: 0 }) as Promise<Doc>
  tierA = await create('membership-tiers', { site: 'a', name: 'Friend', monthly: 500, stripeProduct: 'prod_a' })
  tierB = await create('membership-tiers', { site: 'b', name: 'Friend', monthly: 700, stripeProduct: 'prod_b' })
  mA = await join(memberA, 'a', tierA, 'sub_a', 'in_a1')
  mB = await join(memberB, 'b', tierB, 'sub_b', 'in_b1')
}, 180_000)

afterAll(async () => {
  await payload?.destroy()
  await mongo?.stop()
})

const payB = async () => ((await payload.find({ collection: 'membership-payments' as never, where: { invoiceId: { equals: 'in_b1' } }, depth: 0, pagination: false })).docs as Doc[])[0]!
const payA = async () => ((await payload.find({ collection: 'membership-payments' as never, where: { invoiceId: { equals: 'in_a1' } }, depth: 0, pagination: false })).docs as Doc[])[0]!

describe('a manager limited to one site by a Where', () => {
  it('reads their site’s memberships and payments, with notes and stripe ids', async () => {
    const found = (await payload.find({ collection: 'memberships' as never, depth: 0, pagination: false, ...as(managerA) })).docs as Doc[]
    expect(found.map((d) => d.site)).toEqual(['a'])
    expect(found[0]).toMatchObject({ notes: 'note a', stripe: { customer: 'cus_sub_a' } })
    const pays = (await payload.find({ collection: 'membership-payments' as never, depth: 0, pagination: false, ...as(managerA) })).docs as Doc[]
    expect(pays.map((p) => p.invoiceId)).toEqual(['in_a1'])
    expect(JSON.stringify(await payload.findByID({ collection: 'membership-tiers' as never, id: tierA.id, ...as(managerA) }))).toContain('prod_a')
  })

  it('never sees another site’s memberships, payments, notes or stripe ids (Local API)', async () => {
    await expect(payload.findByID({ collection: 'memberships' as never, id: mB.id, ...as(managerA) })).rejects.toThrow()
    await expect(payload.findByID({ collection: 'membership-payments' as never, id: (await payB()).id, ...as(managerA) })).rejects.toThrow()
    const all = (await payload.find({ collection: 'memberships' as never, depth: 0, pagination: false, ...as(managerA) })).docs
    expect(JSON.stringify(all)).not.toMatch(/note b|cus_sub_b/)
    // Another site's tier: readable by anyone, but its Stripe product is for managers of that site only.
    expect(JSON.stringify(await payload.findByID({ collection: 'membership-tiers' as never, id: tierB.id, ...as(managerA) }))).not.toContain('prod_b')
  })

  it('refuses writes, deletes and cancels on another site, and creating a tier there', async () => {
    await expect(payload.update({ collection: 'memberships' as never, id: mB.id, data: { notes: 'cross' } as never, ...as(managerA) })).rejects.toThrow()
    await expect(payload.delete({ collection: 'memberships' as never, id: mB.id, ...as(managerA) })).rejects.toThrow()
    await expect(payload.delete({ collection: 'membership-payments' as never, id: (await payB()).id, ...as(managerA) })).rejects.toThrow()
    await expect(payload.update({ collection: 'membership-tiers' as never, id: tierB.id, data: { name: 'Hijacked' } as never, ...as(managerA) })).rejects.toThrow()
    await expect(payload.delete({ collection: 'membership-tiers' as never, id: tierB.id, ...as(managerA) })).rejects.toThrow()
    await expect(payload.create({ collection: 'membership-tiers' as never, data: { name: 'Planted', site: 'b' } as never, ...as(managerA) })).rejects.toThrow()
    await expect(payload.create({ collection: 'membership-tiers' as never, data: { name: 'No site' } as never, ...as(managerA) })).rejects.toThrow()
    const after = await get('memberships', mB.id)
    expect([after.notes, (await get('membership-tiers', tierB.id)).name]).toEqual(['note b', 'Friend'])
  })

  it('may write and delete on their own site', async () => {
    const t = await payload.create({ collection: 'membership-tiers' as never, data: { name: 'Own site tier', site: 'a' } as never, ...as(managerA) })
    await expect(payload.update({ collection: 'membership-tiers' as never, id: t.id, data: { name: 'Renamed' } as never, ...as(managerA) })).resolves.toMatchObject({ name: 'Renamed' })
    await payload.delete({ collection: 'membership-tiers' as never, id: t.id, ...as(managerA) })
    await expect(payload.update({ collection: 'memberships' as never, id: mA.id, data: { notes: 'edited by A' } as never, ...as(managerA) })).resolves.toMatchObject({ notes: 'edited by A' })
    await payload.update({ collection: 'memberships' as never, id: mA.id, data: { notes: 'note a' } as never })
  })

  it('REST: lists, reads, patches and deletes only their own site', async () => {
    const list = await rest('GET', '/memberships?depth=0', managerA)
    expect((list.body.docs as Doc[]).map((d) => d.site)).toEqual(['a'])
    expect((await rest('GET', `/memberships/${mB.id}`, managerA)).status).toBe(404)
    expect((await rest('GET', `/membership-payments/${(await payB()).id}`, managerA)).status).toBe(404)
    expect(((await rest('GET', '/membership-payments?depth=0', managerA)).body.docs as Doc[]).map((p) => p.invoiceId)).toEqual(['in_a1'])
    expect((await rest('PATCH', `/memberships/${mB.id}`, managerA, { body: { notes: 'cross' } })).status).toBeGreaterThanOrEqual(403)
    expect((await rest('DELETE', `/memberships/${mB.id}`, managerA)).status).toBeGreaterThanOrEqual(403)
    expect((await rest('DELETE', `/membership-payments/${(await payB()).id}`, managerA)).status).toBeGreaterThanOrEqual(403)
    expect((await get('memberships', mB.id)).notes).toBe('note b')
  })

  it('their notes and stripe fields are judged per row, so a mixed list shows only their rows’ values', async () => {
    // Even through a read that is not limited to their site (the member’s own row on site B).
    const own = await payload.create({ collection: 'users', data: { email: 'dual@example.com', password: PASSWORD, role: 'manager', site: 'a' } as never }) as Doc
    const dualB = await join(own, 'b', tierB, 'sub_dual', 'in_dual')
    await payload.update({ collection: 'memberships' as never, id: dualB.id, data: { notes: 'staff note b' } as never })
    const seen = (await payload.find({ collection: 'memberships' as never, depth: 0, pagination: false, ...as(own) })).docs as Doc[]
    const mine = seen.find((d) => String(d.id) === String(dualB.id))!
    expect(mine, 'a member sees their own membership on site B').toBeTruthy()
    expect(mine.notes).toBeUndefined()
    expect(mine.stripe).toBeUndefined()
    expect(JSON.stringify(seen)).not.toContain('staff note b')
    const patched = await rest('PATCH', `/memberships/${dualB.id}`, own, { body: { notes: 'self-set' } })
    expect(patched.status).toBeGreaterThanOrEqual(400)
    expect((await get('memberships', dualB.id)).notes).toBe('staff note b')
  })
})

describe('member endpoints with a scoped manager', () => {
  it('refuse a manager from site A on site B’s membership, whatever site they ask from', async () => {
    const before = calls.length
    for (const site of ['a', 'b'])
      for (const action of ['cancel', 'change', 'portal', 'wall']) {
        const res = await rest('POST', `/memberships/${mB.id}/${action}`, managerA, { site, body: { tier: String(tierB.id), show: false, name: 'x' } })
        expect(res.status, `${action} from ${site}`).toBe(404)
      }
    expect(calls.slice(before)).toEqual([])
  })

  it('let a manager of the site cancel, but never open the member’s portal or change their plan', async () => {
    const before = calls.length
    for (const action of ['portal', 'change']) expect((await rest('POST', `/memberships/${mA.id}/${action}`, managerA, { site: 'a', body: { tier: String(tierA.id) } })).status, action).toBe(404)
    expect(calls.slice(before)).toEqual([])
    expect((await rest('POST', `/memberships/${mA.id}/cancel`, managerA, { site: 'a' })).status).toBe(200)
    expect((await get('memberships', mA.id)).cancelAtPeriodEnd).toBe(true)
    await payload.update({ collection: 'memberships' as never, id: mA.id, data: { cancelAtPeriodEnd: false } as never })
  })

  it('give the member their own portal and plan change', async () => {
    expect(await rest('POST', `/memberships/${mA.id}/portal`, memberA, { site: 'a', body: {} })).toMatchObject({ status: 200, body: { url: 'https://portal.example/cus_sub_a' } })
    expect((await rest('POST', `/memberships/${mA.id}/portal`, memberB, { site: 'a', body: {} })).status).toBe(404)
  })

  it('serve a manager of everything (true) for cancel across sites, but still not portal or change', async () => {
    expect((await rest('POST', `/memberships/${mB.id}/portal`, adminAll, { site: 'b' })).status).toBe(404)
    expect((await rest('POST', `/memberships/${mB.id}/change`, adminAll, { site: 'b', body: { tier: String(tierB.id) } })).status).toBe(404)
    expect((await rest('POST', `/memberships/${mB.id}/cancel`, adminAll, { site: 'b' })).status).toBe(200)
    await payload.update({ collection: 'memberships' as never, id: mB.id, data: { cancelAtPeriodEnd: false } as never })
  })
})

describe('the answers of canManage', () => {
  const answering = async (fn: (u: Doc) => unknown, body: () => Promise<void>) => {
    const was = answer
    answer = fn
    try {
      await body()
    } finally {
      answer = was
    }
  }

  it('true is every row, including notes and stripe ids', async () => {
    const found = (await payload.find({ collection: 'memberships' as never, depth: 0, pagination: false, ...as(adminAll) })).docs as Doc[]
    expect(found.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(found)).toMatch(/note b/)
    expect(JSON.stringify(found)).toMatch(/cus_sub_b/)
  })

  it('an empty Where, null, 0, an empty string, a throw and a rejection all mean no manager', async () => {
    const noes: unknown[] = [{}, null, 0, '', undefined, { and: [] }, { or: [] }, { site: {} }, [], 'a']
    const failures = [() => { throw new Error('made-up failure') }, async () => { throw new Error('made-up failure') }]
    for (const fn of [...noes.map((v) => () => v), ...failures])
      await answering(fn, async () => {
        const seen = (await payload.find({ collection: 'memberships' as never, depth: 0, pagination: false, ...as(managerA) })).docs as Doc[]
        expect(seen, String(fn)).toEqual([]) // managerA owns no membership, so a no leaves nothing
        expect((await payload.find({ collection: 'membership-payments' as never, depth: 0, pagination: false, ...as(managerA) })).docs).toEqual([])
        await expect(payload.update({ collection: 'memberships' as never, id: mA.id, data: { notes: 'x' } as never, ...as(managerA) })).rejects.toThrow()
        await expect(payload.delete({ collection: 'memberships' as never, id: mA.id, ...as(managerA) })).rejects.toThrow()
        await expect(payload.create({ collection: 'membership-tiers' as never, data: { name: 'Nope', site: 'a' } as never, ...as(managerA) })).rejects.toThrow()
        expect((await rest('POST', `/memberships/${mA.id}/cancel`, managerA, { site: 'a' })).status).toBe(404)
        expect((await rest('GET', '/memberships?depth=0', managerA)).body.docs).toEqual([])
      })
    expect((await get('memberships', mA.id)).notes).toBe('note a')
  })

  it('a Where that matches nothing shows nothing, and an allow-all query is the host’s explicit choice', async () => {
    await answering(() => ({ site: { equals: 'nowhere' } }), async () => {
      expect((await payload.find({ collection: 'memberships' as never, depth: 0, pagination: false, ...as(managerA) })).docs).toEqual([])
      expect((await rest('POST', `/memberships/${mA.id}/cancel`, managerA, { site: 'a' })).status).toBe(404)
    })
    await answering(() => ({ site: { exists: true } }), async () => {
      expect((await payload.find({ collection: 'memberships' as never, depth: 0, pagination: false, ...as(managerA) })).docs.length).toBeGreaterThanOrEqual(2)
    })
    await answering(() => ({ or: [{ site: { equals: 'a' } }, { site: { in: ['zzz'] } }] }), async () => {
      expect(((await payload.find({ collection: 'memberships' as never, depth: 0, pagination: false, ...as(managerA) })).docs as Doc[]).map((d) => d.site)).toEqual(['a'])
      await expect(payload.create({ collection: 'membership-tiers' as never, data: { name: 'Via or', site: 'a' } as never, ...as(managerA) })).resolves.toBeTruthy()
    })
  })

  it('a create is checked against the query: an operator it can’t judge is a no', async () => {
    await answering(() => ({ site: { like: 'a' } }), async () => {
      await expect(payload.create({ collection: 'membership-tiers' as never, data: { name: 'Odd', site: 'a' } as never, ...as(managerA) })).rejects.toThrow()
    })
  })

  it('a signed-out caller is never a manager, even when canManage says true', async () => {
    await answering(() => true, async () => {
      await expect(payload.find({ collection: 'memberships' as never, overrideAccess: false })).rejects.toThrow()
    })
  })

  it('leaves nothing behind but what the tests made, and the fake Stripe saw no portal for managers', async () => {
    expect(calls.filter((c) => c.what === 'portal').map((c) => c.params.customer)).toEqual(['cus_sub_a'])
    expect((await payA()).invoiceId).toBe('in_a1')
  })
})

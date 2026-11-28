# payload-plugin-membership

Memberships for [Payload](https://payloadcms.com), billed as Stripe subscriptions. Run it like
Patreon, or let members support **categories** with **their own amount** — or both.

- **Tiers** (Patreon-style): fixed monthly and/or yearly prices, perks, colors. Drag-and-drop order.
- **Categories**: things members can choose to support (e.g. "Turtles", "North American turtles"),
  nestable, with a minimum amount and an optional **earmarked** flag (otherwise the category is the
  member's preference). New categories go in A–Z; drag to reorder. Add your own fields to tie them to
  anything (taxa, regions, projects…).
- **Memberships**: one running membership per member (per scope); a tier, or pledges split across
  categories. Monthly or yearly. Members change, cancel (at the end of the paid period) or open Stripe's
  customer portal.
- **Payments ledger**: every paid invoice recorded once (idempotent webhooks). `onPayment` runs once per
  invoice: award perks, votes, credits, receipts.
- **Backers wall**: opt-in only, with the name the member chooses; listed under their tier or under each
  category they support, **A–Z within each group**.
- **Works with** [`@extantape/payload-plugin-sponsors`](https://www.npmjs.com/package/@extantape/payload-plugin-sponsors):
  mark a tier "Members are listed as sponsors" and call `upsertListing`/`retireListing` from `onStatusChange`.

## On its own, and with others

**On its own.** Membership needs a Stripe account (a secret key and a webhook) and an auth collection for members. It doesn't import any other plugin. Perks, votes and credits are whatever your own `onPayment` and `onStatusChange` do.

**Works with:**

- **Sponsors** (`@extantape/payload-plugin-sponsors`): tick "Members are listed as sponsors" on a tier, and call Sponsors' `upsertListing()` and `retireListing()` from `onStatusChange`. Your site makes the call; neither plugin imports the other.
- **Roadmap** (`@extantape/payload-plugin-roadmap`): Roadmap's extra votes come from a number your site works out (`allocation.earned`), and a membership can be where they come from. There's no adapter for this. It's a few lines of your own code.
- **Multi-tenant** (`@payloadcms/plugin-multi-tenant`): set `scopeField` and `scopeOf`, and each site has its own tiers and members. The member endpoints answer only for the site `scopeOf` names: another site's membership, or a request from a site `scopeOf` doesn't know, gets a 404, and so does a request where `scopeOf` throws (only the error's name is logged). Managers also need the collection's read access, so the tenant plugin's rules apply to them. Pass `scope` to `getBackers`, or it lists every site.

**Family.** Membership is in the Patronage family, with Sponsors, Backing, Credits, Printify and Roadmap. Backing and Credits are named but not built yet, and the families are a working draft that may change.

## Install

```bash
npm install @extantape/payload-plugin-membership
```

```ts
import { membershipPlugin } from '@extantape/payload-plugin-membership'

export default buildConfig({
  plugins: [
    membershipPlugin({
      stripeSecretKey: process.env.STRIPE_SECRET_KEY,
      webhookSecret: process.env.STRIPE_MEMBERSHIP_WEBHOOK_SECRET,
      canManage: ({ req }) => req.user?.role === 'admin',
      onPayment: async ({ payload, payment, membership }) => {
        // e.g. thank the member, grant perks
      },
    }),
  ],
})
```

In Stripe, add a webhook endpoint `https://<your site>/api/memberships/stripe-webhook` for
`checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`,
`customer.subscription.updated` and `customer.subscription.deleted`.

## Endpoints (signed-in members)

| Endpoint | Body | Result |
|---|---|---|
| `POST /api/memberships/checkout` | `{ tier }` or `{ pledges: [{ category, amount }] }`, `interval` (`month`/`year`), `wall?: { show, name }`, `successPath?`, `cancelPath?` | `{ url }` of Stripe Checkout |
| `POST /api/memberships/:id/change` | `{ tier }` or `{ pledges }` | the updated membership (from the next invoice) |
| `POST /api/memberships/:id/cancel` | | cancels at the end of the paid period |
| `POST /api/memberships/:id/portal` | `{ returnPath? }` | `{ url }` of Stripe's customer portal |
| `POST /api/memberships/:id/wall` | `{ show, name }` | the member's backers-wall choice. A manager may only send `show: false` |

Amounts are in cents. Server code can call `startCheckout`, `changeMembership`, `cancelMembership`,
`portalLink`, `myMembership` and `getBackers` directly.

## Options

| Option | Default | |
|---|---|---|
| `slugs` | `membership-tiers`, `membership-categories`, `memberships`, `membership-payments` | |
| `users` | `admin.user` | The members' auth collection |
| `canManage` | nobody | Who manages tiers, categories and memberships in the admin: `true`, or a `Where` for one site's rows. See [Access](#access) |
| `canCheckout` | always | E.g. off in development. Only `true` allows a checkout |
| `stripeSecretKey` / `stripe` | | Key, or a ready client (tests) |
| `webhookSecret` | | Signing secret of the webhook endpoint |
| `currency` | `usd` | |
| `publicURL` | `serverURL` | Origin for Stripe return links |
| `scopeField` / `scopeOf` | | Multi-site: the owner field (e.g. `tenant`) and how to read it from a request |
| `onPayment` | | Once per paid invoice |
| `onStatusChange` | | When a membership's status changes |
| `overrides` | | Adjust the generated collections |

## Access

`canManage` decides everything a manager can do. It gets `{ req }` and answers one of three things:

- `true`: a manager of every row.
- A `Where`, such as `{ tenant: { equals: siteId } }`: a manager of only the rows it matches. Write it
  against the memberships collection and the `scopeField` of tiers and categories. For payments the
  plugin applies it through each payment's `membership`.
- Anything else is no: `false`, `null`, `0`, `''`, `1`, `'yes'`, an array, an empty `{}` or `{ and: [] }`,
  a field with no operator, an operator Payload doesn't have or the plugin doesn't take (a typo such as
  `equal` included), a value that would match every row (`like: ''`, `contains: ''`, `not_in: []`,
  `all: []`), a query that doesn't run against the memberships collection (an unknown field), or an
  error thrown or rejected. The request is refused cleanly, never a 500. An empty `{}` would match
  every row, so it is a no. Return `true` to mean all. The accepted operators are `equals`,
  `not_equals`, `in`, `not_in`, `all`, `exists`, `greater_than`, `greater_than_equal`, `less_than`,
  `less_than_equal`, `like` and `contains`. `in: []` is accepted and matches nothing.

Nobody who isn't signed in is a manager, whatever `canManage` says.

```ts
canManage: ({ req }) => {
  const user = req.user as { role?: string; site?: string } | null
  if (user?.role === 'admin') return true
  if (user?.role === 'manager' && user.site) return { site: { equals: user.site } }
  return false
}
```

A manager limited by a `Where` reaches only the matching memberships, payments, tiers and categories:
list, read, edit, delete, REST and GraphQL alike, and the endpoints below. A new tier or category
must match the `Where` in its own data. The plugin checks `equals`, `not_equals`, `in`, `not_in`,
`exists`, `and` and `or` there; any other operator is a no for a create. An update that names a
field your `Where` uses is checked the same way, on the stored row with the new data merged over it, so
a limited manager can't move a row out of their scope or into another one. An update that leaves those
fields alone isn't checked again.

`notes`, `stripe` and `stripeProduct` are judged row by row with the same answer, so a manager of
site A never reads site B's notes or Stripe ids, even in a list that includes site B's rows (for
example a membership they hold as a member there).

| Where | A manager | A signed-in member | Signed out |
|---|---|---|---|
| Tiers, categories | Reads; creates, edits, deletes within their scope | Reads | Reads |
| Their `stripeProduct` (field) | Reads within their scope; never writes | Never sees it | Never sees it |
| Memberships | Reads and edits within their scope, deletes within their scope | Reads their own | Nothing |
| A membership's `stripe` and `notes` (fields) | Reads and writes within their scope | Never sees them | Nothing |
| Payments | Reads and deletes within their scope | Reads their own | Nothing |
| `cancel` endpoint | A membership within their scope, on this request's site | Their own | 404 |
| `wall` endpoint | Only to hide (`show: false`), within their scope | Their own, show and name | 404 |
| `change`, `portal` endpoints | Never | Their own | 404 |

Only the member changes their own plan, opens their own Stripe billing portal, shows themselves on the
backers wall or sets the wall name. A manager, even one who manages everything, gets a 404 on `change`
and `portal`, and may only hide a wall entry (`show: false`, for an offensive name or a takedown
request). Managers keep `cancel`. (Decided 2026-11-23.)

This is enforced in field access too, not just in the endpoints, so editing a membership through
Payload's own REST, GraphQL or admin can't get around it. A manager can't write a membership's `user`,
`kind`, `status`, `interval`, `tier`, `pledges`, `amount`, `currency`, `label`, the period dates or the
`stripe` group, or `wall.name`, and can only set `wall.show` to `false`. Only `notes` is theirs to edit.
Server code that writes with `overrideAccess` (checkout, Stripe events) is unchanged. A manager can
set a category's `parent` only to a category in their scope. That is judged on the parent the row
ends up with, whether the save is a create, an update, a duplicate (which keeps the original's parent
unless the data changes it) or a restore. A save whose final parent is outside their scope is refused
with a message saying so; clear the parent or choose one they manage. If you localize `parent` through
`overrides`, every locale's parent counts: a save in one locale is refused while another locale's
parent is outside their scope, until that locale's parent is cleared or moved.

Saves to the plugin's collections send each field by its plain name, with nested fields as nested
objects. A field name that starts with a dollar sign or contains a dot is refused (400) on every save,
through any API, bulk updates, drafts and duplicates included, and from your server code with
`overrideAccess` too, since the Local API overrides access by default. The values of JSON and rich
text fields are left alone. The plugin puts this check at the front of each collection's
`beforeOperation` hooks, after your `overrides`. A plugin that runs after this one can still add its
own hook in front of it, so that hook sees the data before the check does.

A manager limited by a `Where` may restore a version of a tier, category or membership only when the
version itself matches their `Where`. A version that can't be read is refused. (Restoring a
membership by anyone other than server code fails validation, as it did before, because the fields
managers can't write aren't refilled on restore.)

If you turn on drafts for tiers or categories through `overrides`, people who aren't managers read
only published rows (and rows saved before drafts were on). A limited manager also reads drafts in
their scope, and a manager of every row reads all of them.

Saved versions are for managers only: the `versions` routes in REST, the version queries in GraphQL,
and `findVersions` and `findVersionByID` in the Local API with access on. Members and signed-out
visitors get none, and a limited manager gets only the versions that match their `Where`. This covers
all four collections, versions you turn on through `overrides` included. If your `overrides` set
`access.readVersions`, your rule is used. If they replace `access` without one, the plugin's rule is
put back, so these collections always have a rule for versions.

A server-side duplicate of a membership starts as `pending`, without Stripe ids, period dates,
`canceledAt` or `cancelAtPeriodEnd`. It also starts without the staff `notes` and off the backers
wall (`wall.show` false, no `wall.name`). Server code that wants any of these on the copy passes them
in `data`.

`stripeProduct` on tiers and categories is set only by server code (`overrideAccess`): the plugin
stores it at a row's first checkout, and your own server code (a seed or an import) may set it on
create or update. A create or update that doesn't override access ignores it. It belongs to one row,
so a duplicate starts without it, in every locale, and gets its own at its first checkout. That
includes a duplicate made by your server code. To give a copy a particular value, pass `stripeProduct`
in the `data` of a duplicate that overrides access.

Nobody creates memberships or payments directly: checkout and Stripe do. The member endpoints answer
404, not 403, to anyone who may not use them, so they don't say whether a membership exists.

Memberships' and payments' read access returns a query for members: the plugin's own "your rows"
filter. A manager's query comes only from `canManage`, and only when it passes the checks above.
`canCheckout` follows the exact-`true` rule: only `true` lets a checkout start, and anything else,
an error included, refuses it with "Memberships are not available here yet." (503).

Upgrading: a `canManage` that returned `true` or `false` works as before. One that returned an object
(it was a no) now has that object used as a query, so return `false` if you meant no.

Upgrading, `stripeProduct`: if anything other than server code writes it (the REST or GraphQL API, or
the Local API with `overrideAccess: false`), move that write to server code with `overrideAccess`,
after your own permission check. If your server code duplicates a tier or category and expects the
copy to keep the value, pass it in `data`. Rows saved earlier keep what they hold, and checkout uses
it, so check them: each value should be used by one row only, and a product the plugin created names
its row in its Stripe metadata (`payloadCollection`, `payloadId`). Where a value belongs to another
row, set it to `null` from server code (in each locale, if you localize the field). The next checkout
creates the row's own product.

Upgrading from 0.2.0, checks to run once from server code:

1. Stored products. For each tier and category with a `stripeProduct`, clear it (set `null` with
   `overrideAccess`, in each locale if you localize the field) when more than one row holds the same
   value, or when the product's Stripe metadata `payloadCollection` and `payloadId` don't name this
   collection and this row's id. Clear every row that shares a value, the first one too. The next
   checkout makes each row its own product. Running it again should find nothing.
2. Parent categories. If you use a `Where` for managers, list categories whose `parent` is outside the
   category's own scope (on another site). If you localize `parent`, check it in each locale. A limited
   manager can't save such a category until its parent is cleared or moved into their scope, so fix
   these from server code or as a manager of every row.

Use Payload 3.94.2 or later.

Saves to these collections, from your front end, scripts and server code alike, must use plain field
names (no leading dollar sign, no dots). Nested fields go as nested objects.

`overrides` can change a collection's `access`; if you do, your rules replace these, except that a
collection whose `access` has no `readVersions` keeps the plugin's.

## License

MIT

# Changelog

## 0.2.0 (2026-11-26)

### Changed (breaking for hosts that return an object from `canManage`)

- `canManage` can now return a `Where` as well as `true` or `false`. A `Where` limits the manager to the rows it matches, on memberships, payments (through each payment's `membership`), tiers, categories, the `notes`, `stripe` and `stripeProduct` fields, and the `cancel` and `wall` endpoints. Before, a manager of one site who was a plain member of another site got manager rights on the other site's memberships and payments, Stripe ids and notes included. An object that used to count as no is now used as a query, so a host returning one should return `false`.
- Only an exact `true` or a usable `Where` counts. `null`, `0`, `''`, `{}`, `{ and: [] }`, arrays, a field with no operator, a throw and a rejection are all no. An empty `{}` is no because it would match every row; return `true` to mean all.
- A new tier or category from a limited manager must match their `Where` in its own data (`equals`, `not_equals`, `in`, `not_in`, `exists`, `and`, `or`; any other operator is a no).
- An update by a limited manager is matched in memory against the stored row with the new data merged in, so a row can't be moved out of scope or into another site (memberships, tiers, categories; payments aren't writable).
- Only known operators count in a `Where` (`equals`, `not_equals`, `in`, `not_in`, `all`, `exists`, the four comparisons, `like`, `contains`). A typo such as `equal` used to be ignored by Payload on writes, so a manager could write across sites; it is now a no. Values that match every row (`like: ''`, `contains: ''`, `not_in: []`, `all: []`) are refused, and a Where must run against the memberships collection once (a throw is a no), so a bad answer is a clean refusal, never a 500.
- Managers can no longer write a membership's `user`, `kind`, `status`, `interval`, `tier`, `pledges`, `amount`, `currency`, `label`, period dates or `stripe` group (field access), which closed a way around member-only `portal` and `change` and a way to reach another site's Stripe objects. A manager can set a category's `parent` only to a category in their scope.
- Wall (owner decision, 2026-11-23: member only, managers may hide): only the member sets `wall.show` to true or changes `wall.name`; a manager may only set `show: false`. Field access and the `wall` endpoint both enforce it.
- Field access for `notes`, `stripe` and `stripeProduct` is judged on the row, not on a bare yes.
- `change` and `portal` are for the member only. A manager now gets a 404 on both; `cancel` stays. Owner decision, 2026-11-23.
- The `cancel` and `wall` endpoints still go through the collection's own read access for a manager, so rules the host added there also apply.

### Tested

- New `test/manager-scope.test.ts` against an in-memory MongoDB with no tenant plugin and a fake Stripe: a manager limited to site A is refused on site B for read, find, update, delete and create, on memberships, payments, tiers and notes and Stripe fields, through the Local API (access on) and REST (list, read, PATCH, DELETE); is served on site A; the `cancel` and `wall` endpoints refuse across sites; `change` and `portal` are member only, for a site manager and for an all-rows manager; `true`, a matching `Where`, a `Where` that matches nothing, an `or` query and an unsupported create operator; all the no answers listed above.
- Existing suites updated for member-only `change` and `portal`. 69 tests, run three times, plus typecheck and the leak check.

### Not tested

- GraphQL over HTTP. `@payloadcms/graphql` is not installed here, so the GraphQL route was not called. GraphQL runs the same collection and field access functions as the Local API and REST cases above.
- A real Stripe account, the admin UI in a browser, and Postgres or SQLite (only MongoDB).

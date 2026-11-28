# Changelog

## 0.3.0 (2026-11-28)

### Requires Payload 3.94.2 or later (breaking for hosts on older Payload)

- The `payload` peer range is now `^3.94.2` (it was `^3.80.0`). A host on an older Payload must upgrade Payload to 3.94.2 or later before installing this version.

### Changed (breaking for hosts that write `stripeProduct` outside server code)

- `stripeProduct` on tiers and categories is set only by server code (`overrideAccess`): the plugin's checkout, and the host's own seeds and imports. A create or update that doesn't override access ignores it. Managers still read it within their scope.
- A duplicate of a tier or category starts without `stripeProduct`, in every locale, whoever makes the copy, the host's server code included. The copy gets its own product at its first checkout. A value passed in the `data` of a duplicate that overrides access is kept.

**Upgrade note.** If your site writes `stripeProduct` through the REST or GraphQL API, or the Local API with `overrideAccess: false`, move that write to server code with `overrideAccess`, after your own permission check. If your server code duplicates a tier or category and expects the copy to keep the value, pass it in `data`. The upgrade doesn't change stored rows, and checkout uses what they hold, so check that each value is used by one row only. A product the plugin created names its row in its Stripe metadata (`payloadCollection`, `payloadId`). Where a value belongs to another row, set it to `null` from server code (in each locale, if you localize the field), and the next checkout creates the row's own product.

### Changed (access rules)

- Saves to the plugin's collections send plain field names. A field name that starts with a dollar sign or contains a dot is refused (400) on create, update (single, bulk and draft) and duplicate, through every API, server code with `overrideAccess` included (breaking for server code that saved dotted paths; send nested objects). JSON and rich text values are left alone. The plugin adds the check at the front of each collection's `beforeOperation` hooks, after `overrides`; a plugin that runs after this one can still add a hook in front of it.
- A category's `parent` is judged on the value the row ends up with, on create, update, duplicate and restore, and a save whose final parent is outside a limited manager's scope is refused with a message. Behavior change: a limited manager can't save a category whose stored parent is outside their scope until the parent is cleared or moved.
- When a host localizes a category's `parent`, every locale's final parent must be in a limited manager's scope.
- A limited manager may restore a version only when the version matches their scope. A version that can't be read is refused.
- With drafts turned on for tiers or categories through `overrides`, anyone who isn't a manager reads only published rows; limited managers also read drafts in their scope.
- Saved versions of all four collections are read by managers, a limited manager only within their `Where` (REST `versions` routes, GraphQL version queries, `findVersions` and `findVersionByID`). Versions a host turns on through `overrides` are covered, and if `overrides` replace `access` without `readVersions`, the plugin's rule is put back. A host that sets `readVersions` keeps its own.
- A server duplicate of a membership starts as `pending` with no Stripe ids, dates or cancel flags, no staff `notes`, and off the backers wall. Server code can pass any of them in `data`.

**Upgrade from 0.2.0.** Run once from server code: clear any stored `stripeProduct` that more than one row holds or whose Stripe metadata doesn't name its own row, and find categories whose parent is outside their own scope, in each locale if you localize it, and fix them. Make sure saves send plain field names. Upgrade Payload to 3.94.2 or later first, since this version requires it. The README has the steps.

### Tested

- `test/write-guard.test.ts` (15 tests) on a host with drafts on tiers and categories and versions on memberships: field names with a dollar sign, a dot or a NUL refused on create, update (single, bulk, draft) and duplicate through the Local API with access on and off, REST JSON and REST form data, with stored rows unchanged; GraphQL in-process through `@payloadcms/graphql` (now a dev dependency); ordinary saves, webhooks, server code and cancel still work; a category's parent on duplicate, update and restore; restore scope for tiers, categories and memberships, and a missing version; draft reads for anonymous users, members and managers; a server duplicate of a membership. The field-name tests use names of fields the collections don't define.
- `test/upgrade.test.ts` (3 tests): rows written straight to the database in the 0.2.0 shape, read and edited with this version, plus the README's product clean-up (against a fake Stripe product list) and the parent fix.
- `test/stripe-product.test.ts` against an in-memory MongoDB and a fake Stripe, on a plain host and on one with localization (the field localized too) and drafts turned on through `overrides`: create, update (single and bulk) and duplicate through the Local API with access on and REST, by a site manager and an all-rows manager, with and without data, with per-locale values; duplicate by server code; server create, update and a value passed to duplicate; checkout giving a copy its own product once and reusing it.
- `test/version-reads.test.ts` (6 tests) on a host with two locales, versions on all four collections, a localized category parent, and a payments override that rebuilds `access`: version reads through REST (list and by id), GraphQL (list and by id) and the Local API for two members, a signed-out caller, a limited manager of each site and an all-site manager; restores by a member and a signed-out caller; the localized parent on duplicate (Local API and REST), update (one locale and all), restore, after clearing a locale, and by server code. Removing each part of the change (the rule put back after `overrides`, the version query rewrite, the per-locale check, the server-code mark) makes at least one test fail.
- 129 tests in 8 files, run twice, plus typecheck, build, the leak check and `npm pack --dry-run`, on Payload 3.94.2 (with `@payloadcms/db-mongodb`, `@payloadcms/graphql` and `@payloadcms/plugin-multi-tenant` 3.94.2) and Node 26.13.0.

### Not tested

- GraphQL over HTTP (only in-process), the admin UI in a browser (including its version history view for managers), real Stripe, database adapters other than MongoDB, Payload versions other than 3.94.2, Node versions other than 26.13.0, a host that sets `readVersions` itself, an upgrade of a real 0.2.0 database (only rows written in its shape), and restoring a membership by a manager (it fails validation, unchanged).

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

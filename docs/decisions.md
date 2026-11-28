# Decisions

## 2026-11-23: a manager can be limited to a set of rows

A security sweep found that `canManage` took `{ req }` and answered with a yes or no. On a site with several owners, a manager of site A who was a plain member of site B got manager rights on site B's memberships and payments, Stripe ids and staff notes included.

Decided:

- `canManage` may return `true` (every row), a `Where` (only the rows it matches) or no. Only an exact `true` or a usable `Where` counts. A list of scope ids was not added: a `Where` already says the same thing and works with whatever field the host uses.
- An empty `{}` is no, since it would match every row. A host that means all returns `true`.
- Field access for notes and Stripe fields checks the particular row against the answer.
- Owner decision, 2026-11-23: only the member opens their own Stripe billing portal and changes their own plan. `/:id/portal` and `/:id/change` are member only, for every manager. Managers keep `/:id/cancel`.
- The `Where` is written against the memberships collection. Payments get it through `membership.<field>`.
- This is breaking only for a host that returned an object from `canManage`, which used to mean no.

## 2026-11-23: the wall is the member's, and managers can't rewrite the member

- Owner decision ("Member only, managers may hide"): only the member sets `wall.show` to true or changes `wall.name`. A manager may only set `show: false`. Field access enforces it as well as the endpoint.
- Managers get no write access on `user`, `stripe`, `kind`, `status`, `interval`, `tier`, `pledges`, `amount`, `currency`, `label` and the period dates. Otherwise a manager could reassign `user` and then pass the member-only portal and change checks, or point `stripe` at another site's subscription.
- A `Where` accepts only known operators with values that can't match every row, and must run once against the memberships collection. Payload ignores some unknown operators on writes, so a typo would otherwise have allowed cross-site writes.

## 2026-11-27: versions are for managers, and a localized parent counts in every locale

- The plugin sets `readVersions` on all four collections: managers only, a limited manager only within their `Where` (rewritten for the versions collection). Members read their membership itself; version history is for managers.
- The rule is put back after `overrides` when the host's `access` has none, so turning versions on or rebuilding `access` keeps the rule. A host that sets `readVersions` keeps its own.
- When a host localizes a category's `parent`, every locale's final parent is checked. Payload doesn't tell a `beforeChange` field hook whether access is overridden, so the `beforeValidate` hook marks server-code saves; an unmarked save is checked, which can only refuse more.
- A server copy of a membership starts without staff notes and off the backers wall, like its Stripe ids and dates. Server code passes values in `data` to keep them.

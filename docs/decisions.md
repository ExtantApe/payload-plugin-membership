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

# API Surface Audit for Desktop Integration

**Scope:** exploration only, 2026-08-25. Sources are the controller/service/DTO code under `apps/api/src`, shared types under `packages/shared-types/src`, the Prisma schema, and current callers in `apps/admin/src` and `apps/web`. No application code was changed.

**Swagger cross-check (2026-08-25):** reconciled this static audit against the live OpenAPI document at `http://localhost:3000/api/docs-json`. The live spec contains all documented controller/domain route families and no additional business endpoints were found. Swagger security metadata is incomplete for many routes, and several DTO schemas are emitted as empty objects, so source code remains authoritative for authorization and request-contract details where noted below.

## Conventions

- The runtime prefix is `/api/v1`; health and metrics are excluded from that prefix and are `/health/*` and `/metrics`.
- JSON success responses normally have `{ success: true, data: ... }`. `APIResponseInterceptor` is used by the integration controllers. Paginated routes generally return `{ success: true, data: items[], meta: { total, page, limit, totalPages } }`; the admin client normalizes this to `{ items, total, page, limit, totalPages }`. Some routes return raw arrays or ordinary objects inside `data`; some admin wrappers incorrectly expect `items` after normalization or refer to routes that do not exist. These differences are called out below.
- `J` means `JwtAuthGuard`; `P` means `PermissionsGuard`; `T` means `ThrottlerGuard`. `J+P+R:x` means the permission resource/action pair. `super_admin` bypasses `PermissionsGuard`; services still apply their own role and branch rules.
- A branch-scoped staff user is normally restricted by `request.user.branchId`; a super admin can cross branches. Customer tokens have `principal=customer`, `isCustomer=true`, and `customerId` from the JWT subject.
- Consumer labels: **Admin** = current `apps/admin/src/api.ts` or page call; **Web** = current `apps/web`; **Desktop** = intended POS consumer, not evidence of an existing call; **None** = no current caller found.
- Swagger lists the health and metrics exclusions without `/api/v1`, matching the `main.ts` global-prefix exclusions. All other documented application routes appear under `/api/v1` in the live spec.
- Swagger exposes generic 200/201/400/401/403/404 responses on many decorated operations, but does not consistently describe operation-specific response schemas or 5xx responses. Treat the source audit and runtime behavior as authoritative where the spec is generic.
- Swagger security metadata is absent on many operations that the source audit identifies as JWT- or permission-protected, including users, transfers, customers, orders, payments, reports, notifications, and several admin controllers. These are metadata contradictions requiring re-verification against source code, not evidence that the routes are public.

## Authentication and authorization

### Token flow

- `POST /api/v1/auth/login` accepts `LoginRequest { email: string; password: string }`. It authenticates a `User`, falling back to a registered `Customer`, and returns `{ success: true, data: { accessToken: string, user: AuthUser } }`; it also sets an HTTP-only `refreshToken` cookie.
- `POST /api/v1/auth/admin-login` has the same body and response, but currently rejects every email except the literal `admin@example.com` before calling the normal login service. **Admin consumer only; not a general desktop login endpoint.**
- Access JWT TTL is 15 minutes. Refresh JWT TTL is 7 days. Refresh tokens are rotated, hashed in Redis (or an in-memory fallback when Redis is unavailable), individually keyed by user and token id, and the old token is blacklisted. Multiple token IDs per user are supported; logout removes only the presented token.
- `POST /api/v1/auth/refresh` uses the `refreshToken` cookie, returns `{ success: true, data: { accessToken } }`, and sets a replacement cookie. Cookie options are `httpOnly`, `SameSite=Strict`, production `secure`, path `/api/v1/auth`.
- `POST /api/v1/auth/logout` (`J`) accepts no body and returns `{ success: true, data: null }`; it invalidates the presented refresh token. `GET /auth/me` (`J`) returns `{ success: true, data: CurrentUserResponse }`. `POST /auth/change-password` (`J`) accepts `ChangePasswordRequest` and returns `{ success: true, data: null }` (the controller/service must be consulted for the exact field names before implementing a new client).
- JWTs use `Authorization: Bearer <accessToken>`. There is no client-id, audience, desktop/admin discriminator, or user-agent authorization rule. The `principal` claim distinguishes `user` and `customer`, not client applications.
- Admin stores the access token in `localStorage.admin_token` and sends credentials on every fetch so the refresh cookie is included. A desktop app must use a separate storage namespace and preferably a separate staff account; using the same browser storage is the actual collision hazard, while server-side sessions are token-specific.

## Domain inventory

The following tables enumerate every controller method currently found. Request types use the actual DTO/schema names where available; `raw` means the controller does not validate the body with a DTO pipe. Responses use the service's returned object unless the controller wraps it.

### Auth

Source: `auth/auth.controller.ts`.

| Method and full path | Request | Response | Auth / consumer |
|---|---|---|---|
| POST `/api/v1/auth/register` | `RegisterRequest { name, email, phone, password }` | `{ success, data: { id, name, email, phone } }` | Public; Web registration exists, Admin/desktop none |
| POST `/api/v1/auth/admin-login` | `LoginRequest { email, password }` | `{ success, data: { accessToken, user } }` + refresh cookie | Public + T; literal admin email restriction; Admin |
| POST `/api/v1/auth/login` | `LoginRequest { email, password }` | Same as above + refresh cookie | Public + T; Web |
| POST `/api/v1/auth/refresh` | No body; refresh cookie | `{ success, data: { accessToken } }` + rotated cookie | Public cookie endpoint; Admin and Web clients |
| POST `/api/v1/auth/logout` | No body; refresh cookie | `{ success, data: null }` | J; Admin and Web |
| GET `/api/v1/auth/me` | No body | `{ success, data: CurrentUserResponse }` | J; Web; Admin can call through client if needed |
| POST `/api/v1/auth/change-password` | `ChangePasswordRequest` (exact fields are in shared auth types) | `{ success, data: null }` | J; no current Admin/Desktop caller found |

### Users

Source: `users/users.controller.ts`; all routes `J+P`.

`CreateUserRequest` is `{ name, email, password, phone?, roleId, branchId?, lang? }`; `ListUsersQuery` is `{ page?, limit?, search?, roleId?, branchId?, isActive? }`; update is the same editable fields optional; reset password is `ResetPasswordRequest`; detail/list responses include user identity plus `{ role: { id, name }, branch: { id, nameAr, nameEn } }`.

| Routes | Request and response | Permission / scope / consumer |
|---|---|---|
| POST `/users` | Create body -> `{ success, data: UserResponse }` | `USER:create`; service additionally requires `super_admin`; Admin |
| GET `/users` | query above -> `{ success, data: UserListItem[], meta }` | `USER:read`; branch scoped; Admin |
| GET `/users/:id` | UUID path -> `{ success, data: UserResponse }` | `USER:read`; branch/service scope; Admin |
| PATCH `/users/:id` | update body -> `{ success, data: UserResponse }` | `USER:update`; branch/service scope; Admin |
| DELETE `/users/:id` | no body -> `{ success, data: null }` | `USER:delete`; Admin |
| POST `/users/:id/reset-password` | `ResetPasswordRequest` -> `{ success, data: null }` | `USER:update`; Admin; token/session invalidation is service behavior to verify before use |

### Branches

Source: `branches/branches.controller.ts`; `J+P` and `BRANCH` actions. `BranchCreate/Update` fields are `nameAr`, `nameEn`, `address?`, `phone?`, `isActive?`; list query has `page`, `limit`, `search`, `isActive`. Responses are `Branch` objects; list is `{ success, data: Branch[], meta }`.

| Routes | Response / consumer |
|---|---|
| POST `/branches` (`BRANCH:create`) | `{ success, data: Branch }`; Admin only |
| GET `/branches` (`BRANCH:read`) | paginated envelope; Admin (`BranchContext`) |
| GET `/branches/:id` (`BRANCH:read`) | `{ success, data: Branch }`; Admin |
| PATCH `/branches/:id` (`BRANCH:update`) | `{ success, data: Branch }`; Admin |
| DELETE `/branches/:id` (`BRANCH:delete`) | `{ success, data: null }`; Admin |

### Catalog: brands and categories

Sources: `brands/brands.controller.ts`, `categories/categories.controller.ts`. These controllers are public for GET and require `J+P` for writes, with `MOTORCYCLE:create/update/delete`.

- `POST /brands`: `{ nameAr, nameEn, logo?, sortOrder? }` -> `{ success, data: Brand }`.
- `GET /brands`: query `{ isActive? }` -> `{ success, data: Brand[] }`; anonymous sees active records, authenticated staff can see inactive records and counts. `GET /brands/:id` -> `{ success, data: Brand }`.
- `PATCH /brands/:id`: optional `{ nameAr?, nameEn?, logo?, isActive?, sortOrder? }` -> Brand. `DELETE /brands/:id` -> `data:null`. Admin uses all current admin wrappers; Web uses catalog GETs.
- `POST /categories`: `{ nameAr, nameEn, parentId?, sortOrder? }` -> Category. `GET /categories`: query `{ isActive?, flat? }` -> `{ success, data: tree[]|flat[] }`. `GET /categories/:id` -> category with parent, children, and count. `PATCH /categories/:id`: optional fields `{ nameAr?, nameEn?, parentId?, isActive?, sortOrder? }` -> Category. `DELETE` -> `data:null`. Admin and Web use GETs; Admin uses writes.

### Motorcycles and upload

Source: `motorcycles/motorcycles.controller.ts`, `upload/upload.controller.ts`.

`MotorcycleInput` is `{ vin, model, year, color?, engineSize?, descriptionAr?, descriptionEn?, price, costPrice, brandId, categoryId, branchId, images?, status? }`; update excludes VIN/branch/status and requires at least one field; status body is `{ status, reason? }`. List query includes `{ page?, limit?, search?, brandId?, categoryId?, branchId?, status?, minPrice?, maxPrice?, minYear?, maxYear?, color?, sort?, order? }`.

| Routes | Response / auth / consumer |
|---|---|
| POST `/motorcycles` | `{ success, data: MotorcycleResponse }`; `J+P MOTORCYCLE:create`, branch scoped; Admin |
| GET `/motorcycles` | `{ success, data: MotorcycleListItem[], meta }`; public; customer/anonymous limited to available and omit `costPrice`; staff may filter branch/status; Admin and Web |
| GET `/motorcycles/:id` | `{ success, data: MotorcycleDetails }`; public, but customer visibility and staff branch checks depend on JWT; Admin and Web |
| PATCH `/motorcycles/:id` | update body -> MotorcycleResponse; `MOTORCYCLE:update`, branch scoped; Admin |
| PATCH `/motorcycles/:id/status` | status body -> `{ id, vin, model, status, previousStatus, updatedAt }`; `MOTORCYCLE:update`, lifecycle transition and event; Admin |
| DELETE `/motorcycles/:id` | no body -> `data:null`; `MOTORCYCLE:delete`, branch scoped; Admin |
| POST `/upload` | multipart `file` (JPEG/JPG/PNG/WebP, max 5 MiB) -> `{ success, data: { url, filename, size, mimeType } }`; `MOTORCYCLE:create`; Admin; no current file caller |

### Suppliers and purchases

Sources: `suppliers/suppliers.controller.ts`, `purchases/purchases.controller.ts`. All routes are `J+P`; permissions are `SUPPLIER` and `PURCHASE`. Supplier create/update fields: `{ name, contactPerson?, phone?, email?, address?, isActive? }`. Purchase create: `{ supplierId, branchId?, notes?, items: [{ model, vin?, quantity, unitCost }] }`; update fields optional; receive body `{ items: [{ purchaseItemId, vin }] }`.

| Routes | Response / scope / consumer |
|---|---|
| POST/GET/PATCH/DELETE `/suppliers[/:id]` | Supplier object, paginated `{ data, meta }`, updated object, or `data:null`; supplier permission; Admin |
| POST `/purchases` | created purchase -> `{ success, data: Purchase }`; `PURCHASE:create`; branch scoped; Admin |
| GET `/purchases` | query `{ page, limit, search, supplierId, branchId, status, startDate, endDate }` -> paginated purchase items with supplier/branch summaries; `PURCHASE:read`; Admin |
| GET `/purchases/:id` | detailed purchase with supplier, branch, user, items and linked motorcycle summaries; `PURCHASE:read`; Admin |
| PATCH `/purchases/:id` | update body -> purchase; `PURCHASE:update`; draft-only; Admin |
| POST `/purchases/:id/order` | no body -> updated purchase; `PURCHASE:update`; Admin |
| POST `/purchases/:id/receive` | receive body -> `{ id, purchaseNumber, status, receivedAt, receivedMotorcycles[] }`; `PURCHASE:update`; creates motorcycle inventory rows and is concurrency-sensitive; Admin |
| POST `/purchases/:id/cancel` | no body -> `data:null`; `PURCHASE:delete`; Admin |
| DELETE `/purchases/:id` | no body -> `data:null`; `PURCHASE:delete`; Admin |

### Transfers

Source: `transfers/transfers.controller.ts`; all `J+P`. Create schema is `{ fromBranchId, toBranchId, notes?, items: [{ motorcycleId }] }`; list accepts unvalidated query values for pagination, dates, status, and branch filters; detail ID relies on downstream UUID handling. Responses are transfer objects; list is intended paginated `{ data, meta }`.

| Routes | Permission / behavior / consumer |
|---|---|---|
| POST `/transfers` | `TRANSFER:create`; creates transfer and items, branch checks; Admin |
| GET `/transfers`, GET `/transfers/:id` | `TRANSFER:read`; list/detail; branch-dependent; Admin |
| POST `/transfers/:id/ship` | `TRANSFER:update`; changes transfer/motorcycle state; branch actor checks; Admin |
| POST `/transfers/:id/receive` | `TRANSFER:update`; destination branch operation; Admin |
| POST `/transfers/:id/cancel` | `TRANSFER:delete`; cancellation; Admin |

### Customers and reservations

Sources: `customers/customers.controller.ts`, `customers/customers-financial.controller.ts`, `reservations/*.controller.ts`. Customer registration is public; staff customer CRUD is `J+P` with `CUSTOMER` permissions. Customer bodies are `CreateCustomerRequest`, `UpdateCustomerRequest`, address DTOs, and change-password DTOs from shared types; customer search query is `{ q, limit? }`. Service responses are customer/address/summary objects, and list endpoints use paginated envelopes where noted.

| Routes | Request / response | Auth and consumers |
|---|---|---|
| POST `/customers/register` | registration body -> customer profile | Public; Web uses this route |
| POST `/customers` | `CreateCustomerRequest` -> customer | `CUSTOMER:create`; Admin/POS intended |
| GET `/customers` | list query -> paginated customers | `CUSTOMER:read`; branch/user context as service applies; Admin |
| GET `/customers/search` | `q`, `limit?` -> search array/object | `CUSTOMER:read`; Admin and POS controller are separate search surfaces |
| GET/PATCH `/customers/:id` | UUID and update body -> customer | `CUSTOMER:read/update`; customer ownership or staff scope; Admin/Web profile |
| POST `/customers/:id/change-password` | change-password body -> null | authenticated owner or permission depending service; Web |
| POST `/customers/:id/deactivate`, POST `/customers/:id/reactivate` | no body -> customer/status result | customer update permission; Admin |
| POST/GET `/customers/:id/addresses` | address body or no body -> address / address[] | customer ownership or staff scope; Web and Admin |
| PATCH `/customers/:customerId/addresses/:id`, POST same path `/set-default`, DELETE same path | update/no body/no body -> address or null | customer ownership; Web |
| GET `/customers/:id/summary` | no body -> summary object | `CUSTOMER:read`; Admin |
| GET `/customers/:id/orders` | query pagination/filter -> order list/envelope | `ORDER:read`; customer/branch scoped; Admin/Web |
| GET `/customers/:id/financing-summary` | no body -> financial summary | financing read; Admin/Web |
| GET `/customers/:id/financing-contracts` | query pagination -> contracts/envelope | financing read; Admin |
| GET `/customers/:customerId/invoices`, `/payments`, `/financial-summary` | query for invoice/payment lists; no body for summary | staff route (`J+P` financial permissions) is customerId-scoped; Admin |
| GET `/customers/me/invoices`, `/payments`, `/financial-summary` | query for lists; no body for summary | customer JWT; customer-only Web account routes |

Reservations use `J+P` and `RESERVATION` actions. Create is `{ customerId, motorcycleId, branchId?, paidAmount, paymentReference?, expirationDays?, notes? }`; update `{ expiresAt?, notes? }`; extend `{ expiresAt, reason? }`; cancel `{ reason? }`; convert `{ notes? }`.

| Routes | Response / conflict notes / consumers |
|---|---|
| POST `/reservations` | reservation detail -> `{ success, data: Reservation }`; locks motorcycle and changes status; Admin and Web |
| GET `/reservations` | query `{ page, limit, search, customerId, branchId, status, startDate, endDate, expiringBefore, sort, order }` -> `{ data: items, meta }`; branch/customer scoped; Admin |
| GET/PATCH `/reservations/:id` | detail or updated detail; read/update; branch/customer scoped; Admin/Web detail |
| POST `/reservations/:id/extend` | extend body -> result/detail; update; Admin |
| POST `/reservations/:id/cancel` | cancel body -> `data:null`; delete; Admin/Web |
| POST `/reservations/expire` | raw `{ limit?: number }` -> expiration result; `J+P+SCHEDULER:update`; scheduler-only and not exposed to POS roles |
| POST `/reservations/:id/convert` | `{ notes? }` -> reservation/order result; update; Admin and POS intended |
| GET `/reservations/:id/history` | audit/history array; read; Admin |
| GET `/customers/:customerId/reservations` | query -> reservation array/envelope; customerId ownership/staff permission; Web and Admin |

### Orders and POS

`orders/orders.controller.ts` is class `J`; methods add `P` and `ORDER` permissions. Controller DTOs are `CreateOrderDto`, update/status DTOs, and `ListOrdersQuery` from shared types. Exact order response is an order with customer, branch, items, payments/invoice relations as selected by the service; list is `{ success, data: items, meta }`.

| Routes | Request / response / consumer |
|---|---|
| POST `/orders` | `CreateOrderDto` -> order; `ORDER:create`; Web checkout and Admin |
| POST `/orders/:id/confirm` | no body -> order; `ORDER:update`; Admin |
| GET `/orders` | `ListOrdersQuery` -> paginated orders; `ORDER:read`; branch/customer scope; Admin |
| GET `/orders/:id` | no body -> order; `ORDER:read`; branch/customer scope; Admin/Web |
| POST `/orders/:id/status` | status body -> order; `ORDER:update`; Admin |
| PATCH `/orders/:id` | update body -> order; `ORDER:update`; Admin |
| POST `/orders/:id/cancel` | cancel body -> order/null according to service; `ORDER:delete`; Admin |
| GET `/orders/:id/history` | history array; `ORDER:read`; Admin |

POS routes are explicitly documented for Desktop but currently have no caller in `apps/desktop` found in this audit. They are class `J+P`:

| Route | Request -> response | Permission and risk |
|---|---|---|
| GET `/pos/dashboard` | no body -> dashboard/current-shift object | `ORDER:read`; branch derived from JWT; Desktop intended |
| GET `/pos/customers/search` | query search/limit fields -> customer results | `CUSTOMER:read`; Desktop intended |
| GET `/pos/motorcycles/search` | query search/branch/status fields -> inventory results | `MOTORCYCLE:read`; Desktop intended |
| POST `/pos/validate-transaction` | `POS transaction` DTO from shared `pos.ts` -> validation result | `ORDER:create`; Desktop intended; verify exact fields before coding |
| POST `/pos/transactions` | same transaction DTO -> created sale/order/payment result | `ORDER:create`; atomic/concurrency-sensitive; Desktop intended |
| GET `/pos/reservations/active` | query branch/customer/search fields -> active reservations | `RESERVATION:read`; Desktop intended |
| POST `/pos/reservations/:id/convert` | conversion body from POS types -> sale result | `RESERVATION:update`; locks/converts inventory; Desktop intended |
| GET `/pos/offline/sync-status` | no body -> sync status | `ORDER:read`; Desktop intended |
| POST `/pos/offline/queue` | `QueueOfflineOperationDto` -> queued operation result | `POS:create`; service currently accepts only customer create/update operations |
| GET `/pos/offline/queue` | query pagination/status -> queue items | `ORDER:read`; Desktop intended |

### Invoices, payments, refunds, financing, installments

Invoices are class `J+P` with `INVOICES` permissions. Create/update schemas are `CreateInvoiceRequest` and `UpdateInvoiceRequest`; issue/cancel have no body. Responses are invoice objects with customer/order/branch/items and financial values, wrapped in `{ success, data }`. Routes: `POST /invoices` create, `GET /invoices` paginated query (`page`, `limit`, status/customer/branch/date filters), `GET /invoices/:id`, `PATCH /invoices/:id`, `POST /invoices/:id/issue`, `POST /invoices/:id/cancel`. All are Admin; customer invoice reads also occur via `/customers/me/invoices`. Branch scope and invoice status transitions are service-enforced.

Payments are class `J+P`, resource `PAYMENTS`. `CreatePaymentRequest` contains payment amount/method/reference, invoice/order/customer/branch linkage as defined in shared financial types, plus `idempotencyKey` where required; confirm/cancel have no body. Routes: `POST /payments` -> payment, `GET /payments` paginated, `GET /payments/:id` -> detail, `PATCH /payments/:id/confirm` -> detail, `PATCH /payments/:id/cancel` -> detail/null, `GET /payments/:id/allocations` -> allocation array. Admin and Web customer financial reads use them; writes are Admin. Financial mutations use database locking/idempotency and must be treated as concurrent operations.

Refunds are class `J+P`, resource `PAYMENTS`: `POST /refunds` with `CreateRefundRequest` -> refund, `GET /refunds` paginated -> refund items, `GET /refunds/:id` -> refund detail. Admin only; branch/payment ownership and financial audit rules apply.

Financing contract routes are class `J+P`, resource `FINANCING_CONTRACT`: `POST /financing-contracts` with `{ orderId, customerId, branchId?, totalAmount, downPayment?, numberOfInstallments, installmentFrequency?, interestRate?, startDate, notes? }`; `GET` paginated query; `GET /:id`; `PATCH /:id/status` with `{ status?, notes? }`; `PATCH /:id/approve` with `{ notes? }`; `POST /:id/settle` with raw `{ paymentMethod, reference?, notes? }`. Responses are `{ success, data: contract }` with installments on create/detail. Approve additionally requires `branch_admin` or `super_admin`. Admin only; branch/customer scope.

Installments are class `J+P`: `POST /installments/:id/payments` body `{ amount, method, reference?, idempotencyKey, notes? }` -> payment/allocation result; `GET /installments/:id` -> installment with contract; `GET /installments/contract/:contractId` -> installment array; `POST /installments/status-update` no body -> scheduler `{ updated }`. Permissions are `PAYMENT:create`, `FINANCING_CONTRACT:read`, `FINANCING_CONTRACT:update` respectively. The last route is an externally scheduled operation and has no special scheduler secret; do not expose it to a cashier desktop.

### Letters

Sources: `letters/letters.controller.ts`, customer controllers. Staff routes are `J+P` with `LETTER` actions; several bodies are raw DTOs (`CreateLetterDto`, `UpdateLetterDto`, query params). `POST /letters` creates a letter; `GET /letters` lists paginated letters; `GET /letters/stats` returns statistics; `GET /letters/:id` returns detail; `PUT /letters/:id` updates; `POST /letters/:id/confirm-receipt`, `POST /letters/:id/record-non-receipt` change receipt state; `POST /letters/:id/documents` generates a document; `GET /letters/:id/documents/:documentId/url` returns `{ url }`; `GET /letters/:id/history` returns history. Admin wrappers currently call `/issue`, `/send`, `/not-received`, `/cancel`, and `/documents/generate`, which are not routes in this controller: this is a confirmed stale client surface.

`GET /customers/:customerId/letters` is staff `LETTER:read` and returns customer letter items with customer ownership/branch checks. `GET /customer/letters` and `GET /customer/letters/:id` use customer JWT and return the authenticated customer's letters/detail. Current Web customer portal uses the customer-oriented path; no desktop caller.

### Reports

`reports/reports.controller.ts` is `J+P`, `REPORT:read`. All are GETs and return report-specific objects or arrays, not a common pagination envelope. Query inputs are report-specific date/branch/filter values; `branches` is a comma-separated query string for aging, inventory, and installment reports. Routes: `/reports/dashboard/executive`, `/dashboard/operational`, `/sales/summary`, `/sales/by-dimension`, `/financial/revenue-collection`, `/financial/aging`, `/inventory/current-status`, `/inventory/movement`, `/purchases/analytics`, `/suppliers/performance`, `/installments/portfolio`, `/installments/overdue`, `/customers/analytics`. Admin calls most of these; no Web/Desktop caller. These are admin reporting data and should remain unavailable to cashier roles unless `REPORT:read` is intentionally granted.

### Configuration and integrations

Configuration has two controllers: public-ish `/config` and admin `/admin/config`; inspect each method's decorators in `configuration/configuration.controller.ts`. The admin client calls the following actual routes: `GET/PATCH /admin/config/system`, `GET /admin/config/schema`, `GET/PATCH /admin/config/company`, `GET/PATCH /admin/config/branches/:branchId`, `GET /admin/config/branches`, `GET/PATCH/POST /admin/config/feature-flags`, `GET/PATCH /admin/config/numbering`, `POST /admin/config/numbering/:documentType/reset`, `GET/PUT /admin/config/working-hours/:branchId`, `GET/POST/DELETE /admin/config/holidays`, `GET /admin/config/audit`, `GET /admin/config/stats`, `GET /config/resolved`, `GET /config/value/:key`, and `GET /config/feature/:flagKey/status`. Request fields are `QueryConfigurationDto` and `UpdateConfigurationDto` for configuration values, plus raw feature/holiday/working-hours bodies in some methods; responses are configuration arrays or `{ updated, configurations }`, numbering/holiday/working-hour objects, and resolved key/value objects. These are settings operations, guarded by setting permissions where applicable, and Admin only. Branch IDs in URL are not a substitute for JWT branch authorization.

Integration controllers are under admin paths and use `J`, response interceptor, and `SETTING` permissions. `GET /admin/integrations`, `GET /admin/integrations/health`, `GET /admin/integrations/:id`, `PATCH /admin/integrations/:id`, `POST /admin/integrations/:id/test`, `GET /admin/integrations/:id/logs`, `GET /admin/integrations/:id/metrics`; `GET /admin/providers`, `PATCH /admin/providers/:key/toggle`, `GET /admin/providers/:key/health`, `GET /admin/providers/:key/metrics`; and `GET /admin/webhooks`, `POST /admin/webhooks` (raw webhook body), `POST /admin/webhooks/:id/test`. Responses are provider/integration/webhook records, health/metric/log objects, or test results. Admin only; no desktop use.

Swagger route correction: feature flags also expose `PATCH /admin/config/feature-flags/:flagKey`, and numbering updates use `PATCH /admin/config/numbering/:documentType`; the collection-level method group above should not be read as documenting those item paths. The live Swagger schemas for the configuration DTOs are empty objects, so their field names and requiredness still require source verification.

Inbound automation routes are unauthenticated by design: `POST /api/v1/webhooks/:providerKey/:integrationId` and `POST /api/v1/webhooks/payments/:providerId` (payment webhook), plus `POST /api/v1/webhooks/payments/reconcile/:paymentId`. They rely on provider/webhook verification in services rather than JWT and are not desktop APIs. Verify signature/idempotency configuration before exposing any external network path.

API keys: `POST /admin/api-keys` body contains description/environment/scope/branch/expiry fields, `GET /admin/api-keys` returns key records, `DELETE /admin/api-keys/:id` returns null. They use JWT and settings permissions; the create response is the only time the secret is available. Admin only; do not embed an admin-generated key in a desktop binary without a dedicated scope/rotation plan.

### Notifications

`notifications/notifications.controller.ts` is `J`. User-specific routes are `GET /notifications` (query `NotificationQueryDto` -> notification list), `GET /notifications/unread-count` -> `{ count }`, `PATCH /notifications/:id/read`, `POST /notifications/mark-read` body `MarkAsReadDto`, `POST /notifications/mark-all-read`, `DELETE /notifications/:id`, `GET /notifications/preferences`, `PATCH /notifications/preferences` body preference DTO. These use `request.user.id`; users can only affect their own notifications. `POST /notifications` body `CreateNotificationDto` and `POST /notifications/bulk` body `{ notifications: CreateNotificationDto[] }` require `NOTIFICATION:create` in addition to the class JWT. This admin-only fanout permission is not granted to POS roles. No current Admin/Web caller found.

### Health, metrics, sockets

- `GET /health/live`, `/health/ready`, `/health/deps`, and `/metrics` are excluded from the global prefix. They are unauthenticated operational endpoints; use only for deployment monitoring, not desktop UI.
- Socket.IO uses the same access JWT in `handshake.auth.token` or Bearer handshake header. The middleware currently looks up a `User` only and does not support customer principals. Motorcycle events are broadcast with `server.emit`, not branch-filtered rooms. A second desktop client will receive global motorcycle events and can increase connection/event load; no client-type or permission filtering exists. Redis Socket.IO adapter is configured in `main.ts`.

## Consumer map and immediate integration guidance

### Safe to integrate immediately, with a dedicated staff account

The POS-specific read/transaction surface (`/pos/dashboard`, customer/motorcycle search, transaction validation/creation, active reservation lookup/conversion, and offline status/queue after reviewing its DTOs) is the intended desktop surface and is already JWT/permission/branch based. Existing shared inventory, customer, order, reservation, invoice, payment, and installment endpoints can also be used by a desktop user whose role has only the required permissions and whose branch is correct. Public catalog GETs and customer self-service routes remain Web/customer use, not a substitute for staff authorization.

### Must be changed or verified before desktop production use

1. `/reservations/expire` now requires `SCHEDULER:update`; notification create/bulk now require `NOTIFICATION:create`; `/pos/offline/queue` now requires `POS:create`. Scheduler/webhook routes still need separate service authentication and rate/signature checks for automation callers.
2. Define a desktop client distinction only if policy requires it: currently the backend authorizes identity/role/branch, not application type. A header alone is not security. Prefer a dedicated `pos_cashier`/`pos_manager` role and permissions, optionally with a server-validated client/audience claim and device registration.
3. Fix or version stale admin wrappers, especially letters, before sharing a client library. Do not copy `/admin-login` or admin localStorage semantics into desktop.
4. Confirm all POS DTOs and response shapes from `packages/shared-types/src/pos.ts`; the controllers use typed DTOs in some places but raw bodies in others.
5. Add idempotency and conflict handling to every desktop retry of sale/payment/reservation operations. Database locks protect key financial/inventory paths, but clients must not blindly replay a timed-out mutation.
6. Decide whether global Socket.IO motorcycle broadcasts are acceptable for desktop; add branch rooms and authorization if branch isolation or event volume matters.

**Recommendation:** authenticate desktop as its own staff identity/role, never reuse a human admin credential. Use a desktop-specific secure token store and refresh-cookie handling (or a desktop-specific refresh transport), keep branch context server-derived from the JWT, and grant the smallest permission set needed for the POS page. A separate client identifier is useful for telemetry and policy, but it must not replace role/permission checks.

## Phase 1 security verification

- Added `notification`, `pos`, and `scheduler` permission resources. Seed synchronization replaces each role's permission rows, so the explicit lists are authoritative.
- `pos_cashier`: `pos:create`, `order:read`, `order:create`, `customer:read`, `customer:create`, `motorcycle:read`, `reservation:read`, `reservation:update`.
- `pos_sales`: all cashier permissions plus `reservation:create`, `reservation:delete`, and `payment:read`.
- Neither POS role receives branch, setting, user, report, integration/API-key, notification, or scheduler permissions. Branch scope remains JWT-derived from the assigned user's `branchId`.
- Standard `/auth/login` authenticates non-customer `User` accounts with these roles; `/auth/admin-login` remains the restricted admin path.
- Refresh records are keyed by user and token ID (`refresh_token:<userId>:<tokenId>`). Separate cashier/admin users therefore have independent JWTs, refresh records, rotation, and logout state. Backend changes add no shared client storage key or cookie namespace.
- Login throttling is not per account: Nest's default request tracker is normally remote-IP based, so users on the same IP can share the login budget. This remains a follow-up and was not changed in this scope.

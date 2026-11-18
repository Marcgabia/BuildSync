# BuildSync Procurement

BuildSync is an Express/EJS procurement management system backed by MySQL 8.
It covers the full procurement cycle — requisition → approval → purchase order →
delivery → inventory → budget — with role-based access control, notifications,
an append-only activity log, and database-driven reports.

MySQL 8 is the only supported database; the app never falls back to a local database.

## Modules

| Navigation | What it does |
|---|---|
| Overview | Live KPIs, monthly expense chart, PO status chart, alerts, upcoming deliveries, recent activity |
| Suppliers | Directory, search/filter, add/edit, deactivate/reactivate, delete when unused, purchase history, performance ratings |
| Products & inventory | Catalog with categories, supplier assignment, low-stock alerts, stock adjustments, movement history |
| Purchase requisitions | Multi-item requests, drafts, submit/resubmit, cancel, history |
| Approvals | Approve / reject / return requisitions and POs with comments and configurable levels (1–3) |
| Purchase orders | Multi-item orders (discount + tax), conversion from requisitions, approval, print/PDF, CSV export |
| Deliveries & receiving | Scheduled and received deliveries, partial receipts, damaged quantities, private receipt uploads |
| Budget management | Annual/monthly department budgets, commitments vs actual spending, thresholds, ledger |
| Reports & analytics | 15 reports with date ranges, filters, CSV (Excel) export, and print/PDF |
| Notifications | Bell with unread count, filters, mark read / mark all read, links to records |
| Activity logs | Read-only audit trail with filters and CSV export |
| Users & roles | Users, custom roles, permission assignment, activation, password reset |
| Settings | Approval levels, self-approval policy, budget policy, alert windows, departments |

## Run locally (Laragon / any MySQL 8)

Requirements: Node.js 22 or later and a running MySQL 8 server.

```powershell
npm ci
npm start
```

Configure `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME` (default `buildsync_db`),
`DATABASE_USER`, and `DATABASE_PASSWORD` if they differ from the Laragon defaults
(`127.0.0.1`, `3306`, `root`, empty password). The database must already exist.

**Startup applies pending migrations automatically.** Back up the database before the
first start after an upgrade (see below).

### First sign-in

When no user accounts exist, opening the app redirects to `/setup`, where you create
the first **Super Admin**. The page closes permanently once an account exists. Create
it immediately after the first start, and keep the server bound to `127.0.0.1` until
you have done so. All other users are then created under **Users & roles**; they must
change their temporary password at first sign-in.

### Creating an account

The sign-in page has a **Create an account** link (`/register`). Self-registered accounts always
receive the least-privileged role configured in **Settings → Role for self-registered users**
(default: Department Requester; Super Admin can never be chosen). **Settings → Self-registration** controls
the policy:

- `approval` (default): the account is created as *Pending*; administrators are notified and approve it
  from **Users & roles** (the *Approve* action). The user can sign in only after approval.
- `open`: the account is active immediately and the user is signed in.
- `disabled`: the link is hidden and registration is refused; only administrators create accounts.

`011_self_registration.sql` adds the *Pending* status and these settings; it is applied automatically on the next `npm start`.

### Cannot sign in?

Accounts are never removed by updates. If a password is forgotten or an account is locked
(5 failed attempts lock it for 15 minutes), an administrator with access to the server can run:

```powershell
npm run user:list                                   # show all accounts, status, failed attempts, locks
npm run user:reset-password -- --email you@example.com   # prompts for a new password
npm run user:reset-password -- --email you@example.com --activate   # also activates a Pending/Inactive account
```

The reset clears failed attempts and locks, signs out old sessions, and is recorded in the activity log.
If sign-in fails repeatedly, click **Show** on the password field: the browser may have auto-filled a
different saved password for the same site.

## Database migrations

Migrations live in `migrations/` and are recorded in `schema_migrations`. Files 001–003
are the original JavaScript migrations; 004–010 are reviewed `.sql` files:

| File | Purpose |
|---|---|
| `004_auth_rbac.sql` | departments, users, roles, permissions, user_roles, role_permissions, user_sessions, settings + initial roles/permissions/settings |
| `005_activity_notifications.sql` | activity_logs, notifications |
| `006_products_inventory.sql` | categories, products, inventory_transactions; adds `tax_id` and `reliability_rating` to suppliers |
| `007_requisitions_approvals.sql` | purchase_requisitions, requisition_items, approvals |
| `008_purchase_order_items.sql` | purchase_order_items; extends purchase_orders (requisition link, department, discount, tax, workflow dates); copies every existing order into one line item; renames legacy status `Received` → `Completed` |
| `009_deliveries.sql` | deliveries, delivery_items, delivery_attachments |
| `010_budgets.sql` | budgets, budget_transactions; adds `budget_id` to purchase_orders |
| `011_self_registration.sql` | adds the Pending account status and self-registration settings |

All changes are additive: no table or existing record is deleted. Existing purchase
orders keep their legacy single-item columns, which become optional.

Ways to apply them (choose one):

1. **Automatic** — `npm run db:migrate`, or simply `npm start`.
2. **phpMyAdmin** — select `buildsync_db`, open *Import*, and import
   `database/buildsync_v2_upgrade.sql` once. It contains 004–010 and marks them as
   applied so the app does not run them again.

### Backup and rollback

Before upgrading:

```powershell
# Laragon MySQL CLI (or phpMyAdmin > Export > Custom > structure + data)
& "C:\laragon\bin\mysql\mysql-8.4.3-winx64\bin\mysqldump.exe" -uroot --single-transaction buildsync_db > backups\buildsync_db_before_v2.sql
```

MySQL DDL commits implicitly, so a migration cannot be rolled back with a transaction.
To roll back **before** new data is entered, drop and recreate `buildsync_db` and
import the backup. After users start working, prefer a data-aware reverse migration;
each `.sql` file lists its reverse statements in its header comments.

`backups/` and `storage/` (uploaded delivery receipts) are git-ignored. Back up `storage/` with the database.

## Roles and permissions

Permissions are stored in MySQL and checked on the server for every route; the sidebar
only shows modules the user may open. Roles are fully editable under **Users & roles**.

| Initial role | Main permissions |
|---|---|
| Super Admin | Everything (cannot be reduced or deactivated) |
| Procurement Officer | Suppliers, products, purchase orders, view all requisitions, reports + export |
| Purchasing Manager | Approve requisitions and purchase orders, view modules, reports, activity logs |
| Warehouse / Inventory Staff | Deliveries, inventory adjustments, view products/POs, create requisitions |
| Finance Officer | Manage budgets, view POs/deliveries, reports + export |
| Department Requester | Create and track own requisitions, view products |

## Workflow rules

- Requisitions: Draft → Submitted → (Under Review for multi-level) → Approved / Rejected /
  Returned for Revision → Converted to Purchase Order. Rejected requisitions cannot be converted.
- A requisition can have only one live purchase order (enforced by a unique index); cancelling
  that order makes the requisition available again.
- Approvers cannot decide on their own requests unless *Allow self-approval* is enabled, and each
  approval level must be a different person. Reject and return require a comment.
- Purchase orders: Draft → Pending Approval → Approved → Ordered → Partially Received → Completed,
  or Cancelled. Only drafts can be edited. Totals are recalculated on the server.
- Approval commits the order total against the department's active budget (monthly before
  annual). With policy `block`, approval fails when the remaining budget is insufficient.
- Receiving: received quantity may not exceed the remaining quantity; accepted = received −
  damaged; only accepted quantities increase stock, count toward the order, and become actual
  spending (with proportional discount and tax). The same delivery can never be received twice.
- Cancelling an order releases its outstanding commitment. Stock can never become negative.

## Security

- Passwords hashed with scrypt (memory-hard, per-user salt); 5 failed sign-ins lock the account for 15 minutes.
- Server-side sessions (only a SHA-256 hash of the session token is stored), HttpOnly/SameSite cookies,
  configurable idle timeout (default 30 minutes), 12-hour absolute lifetime, sign-out of other sessions on password change.
- CSRF tokens on every state-changing request, prepared statements throughout, EJS output escaping,
  strict Content-Security-Policy, and CSV formula-injection protection.
- Delivery receipts: PDF/PNG/JPEG only, 5 MB limit, content signature checked, random file names,
  stored outside `public/`, and served only to users with delivery permissions.
- Activity logs have no update or delete route. For defense in depth, grant the app's MySQL user only
  `SELECT, INSERT` on `activity_logs`.

## Run with Docker

1. Copy `.env.example` to `.env` and replace both sample passwords.
2. Run `docker compose up --build`.
3. Open `http://localhost:3000` and complete `/setup`.

MySQL data is stored in the `mysql-data` volume and uploaded receipts in the `uploads` volume.

## Deploy to AWS EC2

1. Launch an Ubuntu 24.04 instance (t3.small or larger, 20 GB disk). Security group: SSH (22) from
   your IP only, HTTP (80) and HTTPS (443) from anywhere. Never open 3306.
2. Attach an Elastic IP. If you use a domain, add a DNS `A` record pointing to it.
3. SSH in, `git clone` this repository, `cd` into it, and run `bash scripts/ec2-setup.sh`
   (installs Docker and creates `.env` with `APP_BIND_ADDRESS=0.0.0.0`, `APP_PORT=80` and random passwords).
4. Log out and back in, run `docker compose up -d --build`, then open `http://<Elastic-IP>` and complete `/setup`.

Update with `git pull && docker compose up -d --build`. Back up with EBS snapshots.

## Commands

- `npm start` — start the server (applies pending migrations).
- `npm run db:migrate` — apply pending migrations without starting the server.
- `npm run db:seed` — add sample suppliers and purchase orders (not for production).
- `npm test` — validation, view, migration, workflow, and permission tests against temporary
  MySQL databases (`buildsync_test_*`, `buildsync_flow_*`). The MySQL user needs permission to
  create and drop databases. Tests never touch `buildsync_db`.

## Application structure

- `migrations/` — schema history and runner (`.js` and reviewed `.sql` migrations).
- `database/` — combined upgrade script for phpMyAdmin.
- `models/` — database queries (suppliers, orders, products, requisitions, deliveries, budgets, users, reports, dashboard).
- `services/` — transactional workflows: requisitions, approvals, purchase orders, deliveries, inventory, budget, notifications, audit, alerts, settings.
- `controllers/`, `routes/` — request handling and permission-guarded routes.
- `middleware/` — CSRF, sessions, authentication/authorization.
- `lib/` — validation, formatting, password hashing, transactions, HTTP helpers.
- `views/` — EJS pages, shared partials, and SVG chart partials.
- `public/` — stylesheet and client script (line items, confirmations, loading states, print).

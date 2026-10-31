# Brightloop

Brightloop is a responsive subscription management system for managing customers, products, plans, recurring subscriptions, invoices, discounts, and payments. It uses a browser-based JavaScript frontend, an Express API, and SQLite for persistent storage.

## Features

- Session-based registration, login, logout, and password reset with Admin, Staff, and Customer roles.
- Backend role checks: only Admin can create Staff or manage administrative catalog, discounts, and quote templates; customer portal data is scoped to the signed-in customer.
- Customer and staff account management.
- Product and product-variant catalog, including brand pricing, and Daily, Weekly, Monthly, and Yearly plans.
- Quote templates and subscription workflow from Draft or Quotation through Confirmed and Active to Closed.
- Subscription activation, pause, resume, renewal, expiry, and early closure.
- Recurring invoices with billing-period duplicate protection, payment terms, line-level taxes, plan discounts, and eligible fixed or percentage promotional discounts.
- Invoice draft, confirmation, cancellation, optional email delivery, print view, and overdue tracking.
- Partial and full payment recording with payment method, date, and notes; outstanding balances update as payments are recorded.
- Dashboard statistics, date filters, revenue/subscription charts, and manual billing-run action. A scheduler also checks for due subscriptions.
- Responsive layout, search, sortable tables, loading/empty states, and success/error feedback.

Payments are recorded manually; the application does not connect to a card processor or collect card details.

## Technology

- Node.js (22.5 or newer; uses the built-in `node:sqlite` module)
- Express 5
- SQLite
- HTML, CSS, and browser JavaScript
- `express-session` with a SQLite session store
- `bcryptjs` for password hashing
- Optional Nodemailer SMTP integration for reset and invoice emails

## Project structure

```text
brightloop/
├── public/
│   ├── app.js          # Frontend navigation, views, and API calls
│   ├── index.html      # Application shell
│   └── styles.css      # Shared responsive design system
├── test/
│   └── workflow.test.js # API integration and persistence tests
├── server.js           # Express routes, auth, billing, migrations, and SQLite setup
├── package.json
├── package-lock.json
└── README.md
```

The local database is created and migrated automatically at startup. By default it is `brightloop.sqlite` in the project directory. SQLite files and environment secrets are excluded from Git.

## Install and run

Install Node.js 22.5+ first, then open PowerShell in the project directory:

```powershell
npm.cmd install
npm.cmd start
```

Open [http://localhost:3000](http://localhost:3000). For development with automatic server restarts:

```powershell
npm.cmd run dev
```

Run the end-to-end integration tests:

```powershell
npm.cmd test
```

The tests start an isolated server and temporary SQLite database; they do not use or alter the local demo database.

## Demo accounts

On a fresh database, the app seeds these accounts and sample catalog/customer records:

| Role | Email | Password |
|---|---|---|
| Admin | `admin@brightloop.com` | `Brightloop123!` |
| Staff | `staff@brightloop.com` | `Staff123!` |
| Customer | `jordan@example.com` | `Customer123!` |

Change demo passwords before exposing the app to a network. The Admin, Staff, and Customer seed credentials can be overridden on the first startup using `ADMIN_EMAIL` / `ADMIN_PASSWORD`, `STAFF_EMAIL` / `STAFF_PASSWORD`, and `CUSTOMER_EMAIL` / `CUSTOMER_PASSWORD`. Existing accounts are not overwritten on later starts.

Passwords must be at least 9 characters and include uppercase and lowercase letters and a special character. Public registration creates Customer accounts only. Staff accounts are created by an Admin.

## Configuration

Set environment variables in the shell before starting the server:

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP port | `3000` |
| `DB_PATH` | SQLite database file path | `./brightloop.sqlite` |
| `SESSION_SECRET` | Secret used to sign sessions | Random per server start |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Initial Admin account | Demo credentials above |
| `STAFF_EMAIL`, `STAFF_PASSWORD` | Initial Staff account | Demo credentials above |
| `CUSTOMER_EMAIL`, `CUSTOMER_PASSWORD` | Initial Customer account | Demo credentials above |
| `SMTP_HOST`, `SMTP_PORT` | SMTP server and port | Email disabled |
| `SMTP_SECURE` | Use TLS for SMTP | `false` |
| `SMTP_USER`, `SMTP_PASSWORD` | SMTP credentials | No authentication |
| `SMTP_FROM` | Sender address | `SMTP_USER` |
| `NODE_ENV` | Enables secure cookies in production | Not set |

If SMTP is not configured, development password-reset tokens are printed in the server terminal. Emailing invoices is unavailable and returns a clear configuration error. Configure SMTP before using email features in a deployed environment. For production, also configure a stable, private `SESSION_SECRET`, set `NODE_ENV=production`, use HTTPS, and protect the server and database file.

## Main demonstration flow

1. Sign in as Admin and review the dashboard.
2. Add a customer, or use the seeded Jordan Lee account.
3. Create a product, variant, and billing plan in the catalog.
4. Create an active subscription or use a quote template; the active subscription and its first invoice are created together.
5. Open the invoice and record a partial payment, then record the remaining balance. Confirm the invoice status changes to Paid.
6. Pause and resume a subscription, renew it, or run the due-billing action to generate invoices for elapsed billing periods.
7. Sign in as Staff to confirm administrative write restrictions, then sign in as the seeded Customer to view only their own portal subscriptions and invoices.

All monetary amounts are stored as integer cents. The brand variant premium is $560. Invoices are protected against duplicate subscription/billing-period entries. The application calculates tax and discounts on invoice line items and tracks payment balances and overdue status.

## API overview

All endpoints use JSON unless they serve the frontend. Sign in first; the browser uses the resulting HTTP-only session cookie. Requests outside the customer portal require an authenticated Admin or Staff account. Customer accounts are restricted to `/api/portal/*`; role restrictions are enforced on the API.

| Area | Routes |
|---|---|
| Authentication | `GET /api/auth/session`, `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `POST /api/auth/password-reset/request`, `POST /api/auth/password-reset/complete` |
| Customer portal | `GET /api/portal/profile`, `GET /api/portal/subscriptions`, `GET /api/portal/invoices`, `GET /api/portal/invoices/:id` |
| Dashboard | `GET /api/dashboard` (optional `from` and `to` date filters) |
| Customers and staff | `GET/POST /api/customers`, `PUT /api/customers/:id`, `GET/POST /api/staff`, `PATCH /api/staff/:id` |
| Catalog | `GET /api/catalog`; `POST/PUT/DELETE /api/products`, `/api/variants`, and `/api/plans` (updates and deletes use `/:id`) |
| Discounts and quotes | `GET/POST/PUT/DELETE /api/discounts` and `/api/quote-templates` (updates and deletes use `/:id`) |
| Subscriptions | `GET/POST /api/subscriptions`, `POST /api/subscriptions/:id/renew`, `PATCH /api/subscriptions/:id/status` |
| Billing and invoices | `POST /api/billing/run-due`, `GET/POST /api/invoices`, `GET /api/invoices/:id`, `PATCH /api/invoices/:id/status` |
| Payments | `GET /api/payments`, `POST /api/invoices/:id/payments` |

For route payload details, see the corresponding handlers in `server.js` and the API calls in `public/app.js`.

## Screenshots

To prepare submission screenshots, run the app with sample data, capture the signed-in Admin dashboard at desktop width, and capture at least one catalog/subscription/invoice workflow. Also capture the customer portal and a narrow mobile viewport. Do not include real customer information, passwords, reset tokens, or SMTP credentials in screenshots.

## GitHub submission

From the project directory, create a repository on GitHub (without pre-populating it with a README), then replace `YOUR_GITHUB_USERNAME` with your GitHub username and run:

```powershell
git init
git add .
git commit -m "Complete Brightloop subscription management system"
git branch -M main
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/brightloop.git
git push -u origin main
```

The `.gitignore` excludes `node_modules`, local SQLite databases, environment files, and logs. Review `git status` before pushing and never commit real credentials or customer data.

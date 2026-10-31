# Brightloop

Brightloop is a responsive subscription management app built with Express, browser JavaScript and SQLite. Customers, catalog entries, subscriptions, invoices and recorded payments are persisted in `brightloop.sqlite` in the project folder.

## Run locally

Requirements: Node.js 22.5 or newer.

```powershell
npm.cmd install
npm.cmd start
```

Open [http://localhost:3000](http://localhost:3000). For auto-restart while developing, run `npm.cmd run dev`.

The first launch creates a local administrator and a small sample catalog:

- Email: `admin@brightloop.com`
- Password: `Brightloop123!`

Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` before the first launch to choose different administrator credentials. Set `SESSION_SECRET` to a long, random value when deploying, `PORT` to change the listening port, and `DB_PATH` to choose another SQLite file. Keep the database and credentials private; change the demo password before exposing the app to a network.

## Main workflow

1. Add a customer, or use one of the sample customers.
2. Create a product, one or more variants and a subscription plan. Plans support monthly or yearly billing, tax and a percentage discount.
3. Create a subscription. Brightloop saves it and generates its first invoice in one transaction.
4. Open the invoice to review its line-item totals, tax, discount and balance. Record a full or partial payment against it.
5. View collected revenue and monthly recurring revenue on the dashboard. Unpaid invoices past their due date are marked overdue.
6. Renew an active subscription to issue the next invoice; pause, resume or close subscriptions from the subscriptions page.

## API and storage

The browser uses the authenticated JSON API under `/api`. Admin authentication is session-based, and business records are stored in SQLite with foreign-key constraints and prepared statements. Invoice totals are stored in integer cents; discounts are applied before tax and rounding is to the nearest cent. Invoice due dates are seven days after issue.

Useful endpoints include:

- `POST /api/auth/login` and `POST /api/auth/logout`
- `GET/POST/PUT /api/customers`
- `GET /api/catalog`, `POST/PUT /api/products`, `POST/PUT /api/variants`, `POST/PUT /api/plans`
- `GET/POST /api/subscriptions`, `POST /api/subscriptions/:id/renew`, `PATCH /api/subscriptions/:id/status`
- `GET /api/invoices`, `GET /api/invoices/:id`, `POST /api/invoices/:id/payments`
- `GET /api/payments` and `GET /api/dashboard`

Run the end-to-end workflow tests with:

```powershell
npm.cmd test
```

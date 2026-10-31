const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const app = express();
const port = Number(process.env.PORT) || 3000;
const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'brightloop.sqlite'));

db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    company TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS variants (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sku TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY,
    variant_id INTEGER NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    interval TEXT NOT NULL CHECK (interval IN ('monthly', 'yearly')),
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    tax_percent REAL NOT NULL DEFAULT 0 CHECK (tax_percent >= 0 AND tax_percent <= 100),
    discount_percent REAL NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent <= 100),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    plan_id INTEGER NOT NULL REFERENCES plans(id),
    status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'canceled')),
    started_at TEXT NOT NULL,
    next_billing_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY,
    subscription_id INTEGER NOT NULL REFERENCES subscriptions(id),
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    invoice_number TEXT NOT NULL UNIQUE,
    subtotal_cents INTEGER NOT NULL,
    discount_cents INTEGER NOT NULL,
    tax_cents INTEGER NOT NULL,
    total_cents INTEGER NOT NULL,
    paid_cents INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('open', 'paid', 'overdue')),
    issued_at TEXT NOT NULL,
    due_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    method TEXT NOT NULL,
    reference TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
  CREATE INDEX IF NOT EXISTS idx_invoices_due_status ON invoices(status, due_at);
  CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
`);

function transaction(callback) {
  return (...args) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback(...args);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
}

async function seedData() {
  const email = (process.env.ADMIN_EMAIL || 'admin@brightloop.com').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || 'Brightloop123!';
  if (!db.prepare('SELECT id FROM admins WHERE email = ?').get(email)) {
    db.prepare('INSERT INTO admins (email, password_hash) VALUES (?, ?)').run(email, await bcrypt.hash(password, 10));
  }

  if (!db.prepare('SELECT id FROM products LIMIT 1').get()) {
    const insertProduct = db.prepare('INSERT INTO products (name, description) VALUES (?, ?)');
    const insertVariant = db.prepare('INSERT INTO variants (product_id, name, sku) VALUES (?, ?, ?)');
    const insertPlan = db.prepare(`INSERT INTO plans
      (variant_id, name, interval, price_cents, tax_percent, discount_percent) VALUES (?, ?, ?, ?, ?, ?)`);
    const productId = Number(insertProduct.run('Brightloop Studio', 'A flexible toolkit for creative teams.').lastInsertRowid);
    const starterId = Number(insertVariant.run(productId, 'Starter', 'BL-STUDIO-STARTER').lastInsertRowid);
    const teamId = Number(insertVariant.run(productId, 'Team', 'BL-STUDIO-TEAM').lastInsertRowid);
    insertPlan.run(starterId, 'Starter monthly', 'monthly', 2900, 8.25, 0);
    insertPlan.run(starterId, 'Starter annual', 'yearly', 29000, 8.25, 10);
    insertPlan.run(teamId, 'Team monthly', 'monthly', 7900, 8.25, 0);
    insertPlan.run(teamId, 'Team annual', 'yearly', 79000, 8.25, 10);
    const insertCustomer = db.prepare('INSERT INTO customers (name, email, company, phone) VALUES (?, ?, ?, ?)');
    insertCustomer.run('Jordan Lee', 'jordan@example.com', 'Northstar Creative', '+1 (415) 555-0132');
    insertCustomer.run('Sam Rivera', 'sam@example.com', 'Fieldwork Studio', '+1 (312) 555-0188');
  }
}

app.use(express.json({ limit: '100kb' }));
app.use(session({
  name: 'brightloop.sid',
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

function apiError(res, status, message) {
  return res.status(status).json({ error: message });
}

function requireAuth(req, res, next) {
  if (!req.session.adminId) return apiError(res, 401, 'Please sign in to continue.');
  next();
}

function text(value, label, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new Error(`${label} is required and must be ${max} characters or fewer.`);
  }
  return value.trim();
}

function optionalText(value, label, max = 500) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.trim().length > max) throw new Error(`${label} must be ${max} characters or fewer.`);
  return value.trim();
}

function positiveInt(value, label, allowZero = false) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < (allowZero ? 0 : 1)) throw new Error(`${label} must be a ${allowZero ? 'non-negative' : 'positive'} whole number.`);
  return number;
}

function percent(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100) throw new Error(`${label} must be between 0 and 100.`);
  return number;
}

function emailAddress(value) {
  const email = text(value, 'Email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
  return email;
}

function handleValidation(res, error) {
  if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return apiError(res, 409, 'That email or SKU is already in use.');
  if (error.message && /FOREIGN KEY/.test(error.message)) return apiError(res, 400, 'The selected related record does not exist.');
  return apiError(res, 400, error.message || 'The request could not be completed.');
}

function addInterval(date, interval) {
  const next = new Date(date);
  if (interval === 'monthly') next.setUTCMonth(next.getUTCMonth() + 1);
  else next.setUTCFullYear(next.getUTCFullYear() + 1);
  return next;
}

function createInvoice(subscriptionId) {
  const subscription = db.prepare(`
    SELECT s.id, s.customer_id, p.price_cents, p.tax_percent, p.discount_percent, p.name AS plan_name
    FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.id = ?
  `).get(subscriptionId);
  if (!subscription) throw new Error('Subscription not found.');

  const subtotal = subscription.price_cents;
  const discount = Math.round(subtotal * subscription.discount_percent / 100);
  const tax = Math.round((subtotal - discount) * subscription.tax_percent / 100);
  const total = subtotal - discount + tax;
  const issued = new Date();
  const due = new Date(issued);
  due.setUTCDate(due.getUTCDate() + 7);
  const number = `BL-${issued.toISOString().slice(0, 10).replaceAll('-', '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const result = db.prepare(`
    INSERT INTO invoices
      (subscription_id, customer_id, invoice_number, subtotal_cents, discount_cents, tax_cents, total_cents, status, issued_at, due_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
  `).run(subscriptionId, subscription.customer_id, number, subtotal, discount, tax, total, issued.toISOString(), due.toISOString());
  return db.prepare('SELECT * FROM invoices WHERE id = ?').get(Number(result.lastInsertRowid));
}

function refreshInvoiceStatus(invoice) {
  if (invoice.status === 'paid') return invoice.status;
  const status = new Date(invoice.due_at) < new Date() ? 'overdue' : 'open';
  if (invoice.status !== status) db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(status, invoice.id);
  return status;
}

app.get('/api/auth/session', (req, res) => {
  res.json({ authenticated: Boolean(req.session.adminId), email: req.session.adminEmail || null });
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const email = emailAddress(req.body.email);
    const password = text(req.body.password, 'Password', 200);
    const admin = db.prepare('SELECT * FROM admins WHERE email = ?').get(email);
    if (!admin || !(await bcrypt.compare(password, admin.password_hash))) return apiError(res, 401, 'Email or password is incorrect.');
    req.session.adminId = admin.id;
    req.session.adminEmail = admin.email;
    res.json({ authenticated: true, email: admin.email });
  } catch (error) {
    handleValidation(res, error);
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy((error) => {
    if (error) return apiError(res, 500, 'Unable to end your session.');
    res.clearCookie('brightloop.sid');
    res.json({ ok: true });
  });
});

app.use('/api', requireAuth);

app.get('/api/dashboard', (req, res) => {
  const today = new Date().toISOString();
  db.prepare("UPDATE invoices SET status = 'overdue' WHERE status = 'open' AND due_at < ?").run(today);
  const revenue = db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS total FROM payments').get().total;
  const active = db.prepare("SELECT COUNT(*) AS count FROM subscriptions WHERE status = 'active'").get().count;
  const mrr = db.prepare(`
    SELECT COALESCE(SUM(CASE p.interval WHEN 'yearly' THEN p.price_cents / 12.0 ELSE p.price_cents END), 0) AS total
    FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.status = 'active'
  `).get().total;
  const overdue = db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(total_cents - paid_cents), 0) AS amount FROM invoices WHERE status = 'overdue'").get();
  const recent = db.prepare(`
    SELECT i.id, i.invoice_number, i.total_cents, i.status, i.issued_at, c.name AS customer_name
    FROM invoices i JOIN customers c ON c.id = i.customer_id ORDER BY i.id DESC LIMIT 6
  `).all();
  const monthlyRevenue = db.prepare(`
    SELECT strftime('%Y-%m', recorded_at) AS month, SUM(amount_cents) AS total
    FROM payments WHERE recorded_at >= ? GROUP BY month ORDER BY month
  `).all(new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString());
  res.json({ revenue_cents: revenue, active_subscriptions: active, mrr_cents: Math.round(mrr), overdue_count: overdue.count, overdue_cents: overdue.amount, recent_invoices: recent, monthly_revenue: monthlyRevenue });
});

app.get('/api/customers', (req, res) => {
  res.json(db.prepare(`
    SELECT c.*, COUNT(DISTINCT s.id) AS subscription_count
    FROM customers c LEFT JOIN subscriptions s ON s.customer_id = c.id
    GROUP BY c.id ORDER BY c.id DESC
  `).all());
});

app.post('/api/customers', (req, res) => {
  try {
    const result = db.prepare('INSERT INTO customers (name, email, company, phone) VALUES (?, ?, ?, ?)').run(
      text(req.body.name, 'Name'),
      emailAddress(req.body.email),
      optionalText(req.body.company, 'Company', 160),
      optionalText(req.body.phone, 'Phone', 40)
    );
    res.status(201).json(db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(result.lastInsertRowid)));
  } catch (error) {
    handleValidation(res, error);
  }
});

app.put('/api/customers/:id', (req, res) => {
  try {
    const result = db.prepare('UPDATE customers SET name = ?, email = ?, company = ?, phone = ? WHERE id = ?').run(
      text(req.body.name, 'Name'), emailAddress(req.body.email),
      optionalText(req.body.company, 'Company', 160), optionalText(req.body.phone, 'Phone', 40),
      positiveInt(req.params.id, 'Customer ID')
    );
    if (!result.changes) return apiError(res, 404, 'Customer not found.');
    res.json(db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(req.params.id)));
  } catch (error) {
    handleValidation(res, error);
  }
});

app.get('/api/catalog', (req, res) => {
  const products = db.prepare('SELECT * FROM products ORDER BY id DESC').all();
  const variants = db.prepare(`
    SELECT v.*, p.name AS product_name FROM variants v JOIN products p ON p.id = v.product_id ORDER BY v.id DESC
  `).all();
  const plans = db.prepare(`
    SELECT pl.*, v.name AS variant_name, v.sku, p.name AS product_name
    FROM plans pl JOIN variants v ON v.id = pl.variant_id JOIN products p ON p.id = v.product_id ORDER BY pl.id DESC
  `).all();
  res.json({ products, variants, plans });
});

app.post('/api/products', (req, res) => {
  try {
    const result = db.prepare('INSERT INTO products (name, description) VALUES (?, ?)').run(
      text(req.body.name, 'Product name'), optionalText(req.body.description, 'Description')
    );
    res.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(Number(result.lastInsertRowid)));
  } catch (error) {
    handleValidation(res, error);
  }
});

app.put('/api/products/:id', (req, res) => {
  try {
    const result = db.prepare('UPDATE products SET name = ?, description = ? WHERE id = ?').run(
      text(req.body.name, 'Product name'), optionalText(req.body.description, 'Description'),
      positiveInt(req.params.id, 'Product ID')
    );
    if (!result.changes) return apiError(res, 404, 'Product not found.');
    res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id)));
  } catch (error) {
    handleValidation(res, error);
  }
});

app.post('/api/variants', (req, res) => {
  try {
    const result = db.prepare('INSERT INTO variants (product_id, name, sku) VALUES (?, ?, ?)').run(
      positiveInt(req.body.product_id, 'Product'), text(req.body.name, 'Variant name'), text(req.body.sku, 'SKU', 80).toUpperCase()
    );
    res.status(201).json(db.prepare('SELECT * FROM variants WHERE id = ?').get(Number(result.lastInsertRowid)));
  } catch (error) {
    handleValidation(res, error);
  }
});

app.put('/api/variants/:id', (req, res) => {
  try {
    const result = db.prepare('UPDATE variants SET product_id = ?, name = ?, sku = ? WHERE id = ?').run(
      positiveInt(req.body.product_id, 'Product'), text(req.body.name, 'Variant name'),
      text(req.body.sku, 'SKU', 80).toUpperCase(), positiveInt(req.params.id, 'Variant ID')
    );
    if (!result.changes) return apiError(res, 404, 'Variant not found.');
    res.json(db.prepare('SELECT * FROM variants WHERE id = ?').get(Number(req.params.id)));
  } catch (error) {
    handleValidation(res, error);
  }
});

app.post('/api/plans', (req, res) => {
  try {
    if (!['monthly', 'yearly'].includes(req.body.interval)) throw new Error('Billing interval must be monthly or yearly.');
    const result = db.prepare(`
      INSERT INTO plans (variant_id, name, interval, price_cents, tax_percent, discount_percent) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      positiveInt(req.body.variant_id, 'Variant'), text(req.body.name, 'Plan name'), req.body.interval,
      positiveInt(req.body.price_cents, 'Price', true), percent(req.body.tax_percent ?? 0, 'Tax'),
      percent(req.body.discount_percent ?? 0, 'Discount')
    );
    res.status(201).json(db.prepare('SELECT * FROM plans WHERE id = ?').get(Number(result.lastInsertRowid)));
  } catch (error) {
    handleValidation(res, error);
  }
});

app.put('/api/plans/:id', (req, res) => {
  try {
    if (!['monthly', 'yearly'].includes(req.body.interval)) throw new Error('Billing interval must be monthly or yearly.');
    const result = db.prepare(`
      UPDATE plans SET variant_id = ?, name = ?, interval = ?, price_cents = ?, tax_percent = ?, discount_percent = ? WHERE id = ?
    `).run(
      positiveInt(req.body.variant_id, 'Variant'), text(req.body.name, 'Plan name'), req.body.interval,
      positiveInt(req.body.price_cents, 'Price', true), percent(req.body.tax_percent ?? 0, 'Tax'),
      percent(req.body.discount_percent ?? 0, 'Discount'), positiveInt(req.params.id, 'Plan ID')
    );
    if (!result.changes) return apiError(res, 404, 'Plan not found.');
    res.json(db.prepare('SELECT * FROM plans WHERE id = ?').get(Number(req.params.id)));
  } catch (error) {
    handleValidation(res, error);
  }
});

app.get('/api/subscriptions', (req, res) => {
  res.json(db.prepare(`
    SELECT s.*, c.name AS customer_name, c.email AS customer_email, p.name AS plan_name,
      p.price_cents, p.interval, pr.name AS product_name, v.name AS variant_name
    FROM subscriptions s JOIN customers c ON c.id = s.customer_id
    JOIN plans p ON p.id = s.plan_id JOIN variants v ON v.id = p.variant_id
    JOIN products pr ON pr.id = v.product_id ORDER BY s.id DESC
  `).all());
});

app.post('/api/subscriptions', (req, res) => {
  const create = transaction(() => {
    const customerId = positiveInt(req.body.customer_id, 'Customer');
    const planId = positiveInt(req.body.plan_id, 'Plan');
    const plan = db.prepare('SELECT interval FROM plans WHERE id = ?').get(planId);
    if (!plan) throw new Error('The selected plan does not exist.');
    if (!db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId)) throw new Error('The selected customer does not exist.');
    const started = new Date();
    const nextBilling = addInterval(started, plan.interval);
    const result = db.prepare(`
      INSERT INTO subscriptions (customer_id, plan_id, status, started_at, next_billing_at)
      VALUES (?, ?, 'active', ?, ?)
    `).run(customerId, planId, started.toISOString(), nextBilling.toISOString());
    const subscriptionId = Number(result.lastInsertRowid);
    const invoice = createInvoice(subscriptionId);
    return { subscription: db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subscriptionId), invoice };
  });
  try {
    res.status(201).json(create());
  } catch (error) {
    handleValidation(res, error);
  }
});

app.post('/api/subscriptions/:id/renew', (req, res) => {
  const renew = transaction(() => {
    const id = positiveInt(req.params.id, 'Subscription ID');
    const subscription = db.prepare('SELECT s.*, p.interval FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.id = ?').get(id);
    if (!subscription) throw new Error('Subscription not found.');
    if (subscription.status !== 'active') throw new Error('Only active subscriptions can be renewed.');
    const from = new Date(Math.max(Date.now(), new Date(subscription.next_billing_at).getTime()));
    const nextBilling = addInterval(from, subscription.interval);
    db.prepare('UPDATE subscriptions SET next_billing_at = ? WHERE id = ?').run(nextBilling.toISOString(), id);
    return { subscription: db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id), invoice: createInvoice(id) };
  });
  try {
    res.status(201).json(renew());
  } catch (error) {
    handleValidation(res, error);
  }
});

app.patch('/api/subscriptions/:id/status', (req, res) => {
  try {
    const status = req.body.status;
    if (!['active', 'paused', 'canceled'].includes(status)) throw new Error('Choose a valid subscription status.');
    const result = db.prepare('UPDATE subscriptions SET status = ? WHERE id = ?').run(status, positiveInt(req.params.id, 'Subscription ID'));
    if (!result.changes) return apiError(res, 404, 'Subscription not found.');
    res.json(db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(Number(req.params.id)));
  } catch (error) {
    handleValidation(res, error);
  }
});

app.get('/api/invoices', (req, res) => {
  const invoices = db.prepare(`
    SELECT i.*, c.name AS customer_name, c.email AS customer_email, s.id AS subscription_number,
      p.name AS plan_name, p.interval
    FROM invoices i JOIN customers c ON c.id = i.customer_id JOIN subscriptions s ON s.id = i.subscription_id
    JOIN plans p ON p.id = s.plan_id ORDER BY i.id DESC
  `).all();
  res.json(invoices.map((invoice) => ({ ...invoice, status: refreshInvoiceStatus(invoice) })));
});

app.get('/api/invoices/:id', (req, res) => {
  const invoice = db.prepare(`
    SELECT i.*, c.name AS customer_name, c.email AS customer_email, c.company, c.phone,
      p.name AS plan_name, p.interval, pr.name AS product_name, v.name AS variant_name
    FROM invoices i JOIN customers c ON c.id = i.customer_id
    JOIN subscriptions s ON s.id = i.subscription_id JOIN plans p ON p.id = s.plan_id
    JOIN variants v ON v.id = p.variant_id JOIN products pr ON pr.id = v.product_id WHERE i.id = ?
  `).get(positiveInt(req.params.id, 'Invoice ID'));
  if (!invoice) return apiError(res, 404, 'Invoice not found.');
  invoice.status = refreshInvoiceStatus(invoice);
  invoice.payments = db.prepare('SELECT * FROM payments WHERE invoice_id = ? ORDER BY id DESC').all(invoice.id);
  res.json(invoice);
});

app.post('/api/invoices/:id/payments', (req, res) => {
  const recordPayment = transaction(() => {
    const invoiceId = positiveInt(req.params.id, 'Invoice ID');
    const amount = positiveInt(req.body.amount_cents, 'Payment amount');
    const method = text(req.body.method, 'Payment method', 40);
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    if (!invoice) throw new Error('Invoice not found.');
    if (invoice.status === 'paid' || invoice.paid_cents >= invoice.total_cents) throw new Error('This invoice is already paid.');
    if (amount > invoice.total_cents - invoice.paid_cents) throw new Error('Payment cannot exceed the remaining invoice balance.');
    const recorded = new Date().toISOString();
    db.prepare('INSERT INTO payments (invoice_id, amount_cents, method, reference, recorded_at) VALUES (?, ?, ?, ?, ?)').run(
      invoiceId, amount, method, optionalText(req.body.reference, 'Reference', 120) || `MANUAL-${crypto.randomBytes(4).toString('hex').toUpperCase()}`, recorded
    );
    const paid = invoice.paid_cents + amount;
    const status = paid === invoice.total_cents ? 'paid' : (new Date(invoice.due_at) < new Date() ? 'overdue' : 'open');
    db.prepare('UPDATE invoices SET paid_cents = ?, status = ? WHERE id = ?').run(paid, status, invoiceId);
    return db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  });
  try {
    res.status(201).json(recordPayment());
  } catch (error) {
    handleValidation(res, error);
  }
});

app.get('/api/payments', (req, res) => {
  res.json(db.prepare(`
    SELECT p.*, i.invoice_number, c.name AS customer_name
    FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN customers c ON c.id = i.customer_id
    ORDER BY p.id DESC
  `).all());
});

app.use('/api', (req, res) => apiError(res, 404, 'API endpoint not found.'));

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'An unexpected server error occurred.' });
});

seedData().then(() => {
  app.listen(port, () => console.log(`Brightloop is running at http://localhost:${port}`));
}).catch((error) => {
  console.error('Unable to initialize Brightloop:', error);
  process.exitCode = 1;
});

module.exports = { app, db };

const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');

const app = express();
const port = Number(process.env.PORT) || 3000;
const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'brightloop.sqlite'));
const mailTransport = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true',
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined
}) : null;

class SQLiteSessionStore extends session.Store {
  get(sid, callback) {
    try {
      const row = db.prepare('SELECT session_json, expires_at FROM web_sessions WHERE sid = ?').get(sid);
      if (!row) return callback(null, null);
      if (row.expires_at <= Date.now()) {
        db.prepare('DELETE FROM web_sessions WHERE sid = ?').run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.session_json));
    } catch (error) {
      callback(error);
    }
  }

  set(sid, sessionData, callback = () => {}) {
    try {
      const expiresAt = sessionData.cookie?.expires
        ? new Date(sessionData.cookie.expires).getTime()
        : Date.now() + (Number(sessionData.cookie?.maxAge) || 8 * 60 * 60 * 1000);
      db.prepare(`INSERT INTO web_sessions (sid, session_json, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET session_json = excluded.session_json, expires_at = excluded.expires_at`)
        .run(sid, JSON.stringify(sessionData), expiresAt);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, sessionData, callback = () => {}) {
    try {
      const expiresAt = sessionData.cookie?.expires
        ? new Date(sessionData.cookie.expires).getTime()
        : Date.now() + (Number(sessionData.cookie?.maxAge) || 8 * 60 * 60 * 1000);
      db.prepare('UPDATE web_sessions SET expires_at = ? WHERE sid = ?').run(expiresAt, sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      db.prepare('DELETE FROM web_sessions WHERE sid = ?').run(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }
}

db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS web_sessions (
    sid TEXT PRIMARY KEY,
    session_json TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'staff', 'customer')),
    customer_id INTEGER REFERENCES customers(id),
    reset_token_hash TEXT,
    reset_expires_at TEXT,
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
  CREATE TABLE IF NOT EXISTS discounts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE COLLATE NOCASE,
    discount_type TEXT NOT NULL CHECK (discount_type IN ('fixed', 'percent')),
    amount INTEGER NOT NULL CHECK (amount >= 0),
    min_purchase_cents INTEGER NOT NULL DEFAULT 0 CHECK (min_purchase_cents >= 0),
    min_quantity INTEGER NOT NULL DEFAULT 1 CHECK (min_quantity >= 1),
    starts_at TEXT,
    expires_at TEXT,
    usage_limit INTEGER CHECK (usage_limit IS NULL OR usage_limit >= 1),
    usage_count INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS quote_templates (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    plan_id INTEGER NOT NULL REFERENCES plans(id),
    product_lines TEXT NOT NULL DEFAULT '[]',
    validity_days INTEGER NOT NULL DEFAULT 30 CHECK (validity_days >= 1),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS subscription_lines (
    id INTEGER PRIMARY KEY,
    subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES products(id),
    description TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
    unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
    tax_percent REAL NOT NULL DEFAULT 0 CHECK (tax_percent >= 0 AND tax_percent <= 100)
  );
  CREATE TABLE IF NOT EXISTS invoice_lines (
    id INTEGER PRIMARY KEY,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity >= 1),
    unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
    tax_percent REAL NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
  CREATE INDEX IF NOT EXISTS idx_invoices_due_status ON invoices(status, due_at);
  CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function inputDate(value, label, endOfDay = false) {
  const dateOnly = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(dateOnly ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} is invalid.`);
  return date;
}

for (const [table, column, definition] of [
  ['products', 'product_type', "TEXT NOT NULL DEFAULT 'service'"],
  ['products', 'selling_price_cents', 'INTEGER NOT NULL DEFAULT 0'],
  ['products', 'cost_price_cents', 'INTEGER NOT NULL DEFAULT 0'],
  ['products', 'notes', "TEXT NOT NULL DEFAULT ''"],
  ['variants', 'brand', "TEXT NOT NULL DEFAULT ''"],
  ['plans', 'billing_interval', "TEXT NOT NULL DEFAULT 'monthly'"],
  ['plans', 'min_quantity', 'INTEGER NOT NULL DEFAULT 1'],
  ['plans', 'available_from', 'TEXT'],
  ['plans', 'available_until', 'TEXT'],
  ['plans', 'auto_close', 'INTEGER NOT NULL DEFAULT 0'],
  ['subscriptions', 'subscription_number', 'TEXT'],
  ['subscriptions', 'workflow_status', "TEXT NOT NULL DEFAULT 'active'"],
  ['subscriptions', 'expires_at', 'TEXT'],
  ['subscriptions', 'quote_expires_at', 'TEXT'],
  ['subscriptions', 'payment_terms_days', 'INTEGER NOT NULL DEFAULT 7'],
  ['subscriptions', 'discount_id', 'INTEGER REFERENCES discounts(id)'],
  ['invoices', 'period_start', 'TEXT'],
  ['invoices', 'period_end', 'TEXT'],
  ['invoices', 'document_status', "TEXT NOT NULL DEFAULT 'confirmed'"],
  ['invoices', 'discount_id', 'INTEGER REFERENCES discounts(id)'],
  ['payments', 'notes', "TEXT NOT NULL DEFAULT ''"]
]) ensureColumn(table, column, definition);
ensureColumn('users', 'active', 'INTEGER NOT NULL DEFAULT 1');

db.exec(`
  UPDATE plans SET billing_interval = interval WHERE billing_interval = 'monthly' AND interval <> 'monthly';
  UPDATE subscriptions SET subscription_number = printf('SUB-%06d', id) WHERE subscription_number IS NULL;
  UPDATE invoices SET period_start = issued_at WHERE period_start IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_number ON subscriptions(subscription_number);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_subscription_period ON invoices(subscription_id, period_start);
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
  const password = validPassword(process.env.ADMIN_PASSWORD || 'Brightloop123!');
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

  const admin = db.prepare('SELECT * FROM admins WHERE email = ?').get(email);
  db.prepare(`INSERT OR IGNORE INTO users (email, password_hash, role) VALUES (?, ?, 'admin')`)
    .run(email, admin.password_hash);
  const staffEmail = (process.env.STAFF_EMAIL || 'staff@brightloop.com').toLowerCase();
  db.prepare(`INSERT OR IGNORE INTO users (email, password_hash, role) VALUES (?, ?, 'staff')`)
    .run(staffEmail, await bcrypt.hash(validPassword(process.env.STAFF_PASSWORD || 'Staff123!'), 10));
  const customerEmail = (process.env.CUSTOMER_EMAIL || 'jordan@example.com').toLowerCase();
  const customer = db.prepare('SELECT id FROM customers WHERE email = ?').get(customerEmail);
  if (customer) {
    db.prepare(`INSERT OR IGNORE INTO users (email, password_hash, role, customer_id) VALUES (?, ?, 'customer', ?)`)
      .run(customerEmail, await bcrypt.hash(validPassword(process.env.CUSTOMER_PASSWORD || 'Customer123!'), 10), customer.id);
  }
}

app.use(express.json({ limit: '100kb' }));
app.use(session({
  name: 'brightloop.sid',
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  store: new SQLiteSessionStore(),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

function apiError(res, status, message) {
  return res.status(status).json({ error: message });
}

function formatMoney(cents) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((Number(cents) || 0) / 100);
}

function requireAuth(req, res, next) {
  if (!req.session.userId || !req.session.role) return apiError(res, 401, 'Please sign in to continue.');
  const user = db.prepare('SELECT active FROM users WHERE id = ?').get(req.session.userId);
  if (!user || !user.active) {
    req.session.destroy(() => {});
    return apiError(res, 401, 'Your account is no longer active. Please contact an administrator.');
  }
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

function validPassword(value) {
  if (typeof value !== 'string' || value.length < 9 || value.length > 200 ||
      !/[A-Z]/.test(value) || !/[a-z]/.test(value) || !/[^A-Za-z0-9]/.test(value)) {
    throw new Error('Password must be at least 9 characters and include uppercase, lowercase, and a special character.');
  }
  return value;
}

function requireRoles(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.session.role)) return apiError(res, 403, 'You do not have permission to perform this action.');
    next();
  };
}

function adminOnly(req, res, next) {
  return requireRoles('admin')(req, res, next);
}

function handleValidation(res, error) {
  if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/i.test(error.message || '')) {
    return apiError(res, 409, 'That email, code, or SKU is already in use.');
  }
  if (error.message && /FOREIGN KEY/.test(error.message)) return apiError(res, 400, 'The selected related record does not exist.');
  return apiError(res, 400, error.message || 'The request could not be completed.');
}

function addInterval(date, interval) {
  const next = new Date(date);
  if (interval === 'daily') next.setUTCDate(next.getUTCDate() + 1);
  else if (interval === 'weekly') next.setUTCDate(next.getUTCDate() + 7);
  else if (interval === 'yearly') {
    const month = next.getUTCMonth();
    const day = next.getUTCDate();
    next.setUTCDate(1);
    next.setUTCFullYear(next.getUTCFullYear() + 1);
    next.setUTCMonth(month);
    next.setUTCDate(Math.min(day, new Date(Date.UTC(next.getUTCFullYear(), month + 1, 0)).getUTCDate()));
  } else {
    const day = next.getUTCDate();
    const monthIndex = next.getUTCMonth() + 1;
    next.setUTCDate(1);
    next.setUTCMonth(monthIndex);
    next.setUTCDate(Math.min(day, new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate()));
  }
  return next;
}

function eligibleDiscount(discount, subtotal, quantity, now = new Date()) {
  if (!discount || !discount.active || (discount.usage_limit !== null && discount.usage_count >= discount.usage_limit)) return 0;
  if (discount.starts_at && new Date(discount.starts_at) > now) return 0;
  if (discount.expires_at && new Date(discount.expires_at) < now) return 0;
  if (subtotal < discount.min_purchase_cents || quantity < discount.min_quantity) return 0;
  return discount.discount_type === 'percent'
    ? Math.min(subtotal, Math.round(subtotal * discount.amount / 100))
    : Math.min(subtotal, discount.amount);
}

function createInvoice(subscriptionId, periodStart, periodEnd, documentStatus = 'confirmed') {
  const subscription = db.prepare(`
    SELECT s.id, s.customer_id, s.discount_id, s.payment_terms_days, s.started_at, s.next_billing_at,
      p.price_cents, p.tax_percent,
      p.discount_percent, p.name AS plan_name, p.min_quantity, v.brand
    FROM subscriptions s JOIN plans p ON p.id = s.plan_id
    JOIN variants v ON v.id = p.variant_id WHERE s.id = ?
  `).get(subscriptionId);
  if (!subscription) throw new Error('Subscription not found.');

  const start = periodStart || subscription.started_at || new Date().toISOString();
  const duplicate = db.prepare('SELECT * FROM invoices WHERE subscription_id = ? AND period_start = ?').get(subscriptionId, start);
  if (duplicate) return duplicate;
  const lines = db.prepare('SELECT * FROM subscription_lines WHERE subscription_id = ?').all(subscriptionId);
  const quantity = lines.length ? lines.reduce((sum, line) => sum + line.quantity, 0) : subscription.min_quantity;
  const variantPremium = subscription.brand ? 56000 : 0;
  const invoiceItems = lines.length
    ? lines.map((line) => ({ description: line.description, quantity: line.quantity, price: line.unit_price_cents, tax: line.tax_percent }))
    : [{ description: subscription.plan_name, quantity, price: subscription.price_cents + variantPremium, tax: subscription.tax_percent }];
  const subtotal = invoiceItems.reduce((sum, line) => sum + line.price * line.quantity, 0);
  const planDiscount = Math.round(subtotal * subscription.discount_percent / 100);
  const promo = subscription.discount_id ? db.prepare('SELECT * FROM discounts WHERE id = ?').get(subscription.discount_id) : null;
  const promoDiscount = eligibleDiscount(promo, subtotal - planDiscount, quantity);
  const discount = Math.min(subtotal, planDiscount + promoDiscount);
  const discountedSubtotal = subtotal - discount;
  const taxableBase = invoiceItems.reduce((sum, line) => sum + Math.round(line.price * line.quantity * (1 - (subtotal ? discount / subtotal : 0))), 0);
  const weightedTax = invoiceItems.reduce((sum, line) => sum + Math.round(line.price * line.quantity * (1 - (subtotal ? discount / subtotal : 0)) * line.tax / 100), 0);
  const tax = invoiceItems.every((line) => line.tax === 0) ? 0 : (weightedTax || Math.round(taxableBase * subscription.tax_percent / 100));
  const total = subtotal - discount + tax;
  const issued = new Date();
  const due = new Date(issued);
  due.setUTCDate(due.getUTCDate() + subscription.payment_terms_days);
  const end = periodEnd || subscription.next_billing_at || addInterval(new Date(start), 'monthly').toISOString();
  const number = `BL-${issued.toISOString().slice(0, 10).replaceAll('-', '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const result = db.prepare(`
    INSERT INTO invoices
      (subscription_id, customer_id, invoice_number, subtotal_cents, discount_cents, tax_cents, total_cents,
       status, issued_at, due_at, period_start, period_end, discount_id, document_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)
  `).run(subscriptionId, subscription.customer_id, number, subtotal, discount, tax, total,
    issued.toISOString(), due.toISOString(), start, end, promoDiscount ? subscription.discount_id : null, documentStatus);
  const invoiceId = Number(result.lastInsertRowid);
  const insertLine = db.prepare('INSERT INTO invoice_lines (invoice_id, description, quantity, unit_price_cents, tax_percent) VALUES (?, ?, ?, ?, ?)');
  for (const line of invoiceItems) insertLine.run(invoiceId, line.description, line.quantity, line.price, line.tax);
  if (promoDiscount) db.prepare('UPDATE discounts SET usage_count = usage_count + 1 WHERE id = ?').run(subscription.discount_id);
  return db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
}

function refreshInvoiceStatus(invoice) {
  if (invoice.status === 'paid' || invoice.document_status === 'canceled') return invoice.status;
  const status = new Date(invoice.due_at) < new Date() ? 'overdue' : 'open';
  if (invoice.status !== status) db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(status, invoice.id);
  return status;
}

function billDueSubscriptions(now = new Date()) {
  const bill = transaction(() => {
    let invoicesCreated = 0;
    db.prepare(`UPDATE subscriptions SET status = 'canceled', workflow_status = 'closed'
      WHERE status = 'active' AND workflow_status = 'active' AND expires_at <= ?
      AND EXISTS (SELECT 1 FROM plans p WHERE p.id = subscriptions.plan_id AND p.auto_close = 1)`)
      .run(now.toISOString());
    const subscriptions = db.prepare(`
      SELECT s.*, p.billing_interval, p.auto_close
      FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.status = 'active' AND s.workflow_status = 'active' AND s.next_billing_at <= ?
      ORDER BY s.next_billing_at
    `).all(now.toISOString());
    for (const subscription of subscriptions) {
      let next = new Date(subscription.next_billing_at);
      let periods = 0;
      while (next <= now && periods < 120) {
        const periodEnd = addInterval(next, subscription.billing_interval);
        if (subscription.expires_at && next >= new Date(subscription.expires_at)) {
          db.prepare("UPDATE subscriptions SET status = 'canceled', workflow_status = 'closed' WHERE id = ?").run(subscription.id);
          break;
        }
        createInvoice(subscription.id, next.toISOString(), periodEnd.toISOString());
        invoicesCreated += 1;
        next = periodEnd;
        periods += 1;
        if (subscription.expires_at && next >= new Date(subscription.expires_at) && subscription.auto_close) {
          db.prepare("UPDATE subscriptions SET status = 'canceled', workflow_status = 'closed', next_billing_at = ? WHERE id = ?")
            .run(next.toISOString(), subscription.id);
          break;
        }
      }
      if (periods) {
        db.prepare('UPDATE subscriptions SET next_billing_at = ? WHERE id = ?').run(next.toISOString(), subscription.id);
      }
    }
    return invoicesCreated;
  });
  return bill();
}

app.get('/api/auth/session', (req, res) => {
  res.json({ authenticated: Boolean(req.session.userId), email: req.session.userEmail || null, role: req.session.role || null });
});

function signIn(req, res, user) {
  req.session.regenerate((error) => {
    if (error) return apiError(res, 500, 'Unable to start your session.');
    req.session.userId = user.id;
    req.session.userEmail = user.email;
    req.session.role = user.role;
    req.session.customerId = user.customer_id || null;
    req.session.save((saveError) => {
      if (saveError) return apiError(res, 500, 'Unable to save your session.');
      res.json({ authenticated: true, email: user.email, role: user.role });
    });
  });
}

app.post('/api/auth/register', async (req, res) => {
  try {
    const email = emailAddress(req.body.email);
    const password = validPassword(req.body.password);
    const name = text(req.body.name, 'Name');
    const company = optionalText(req.body.company, 'Company', 160);
    const phone = optionalText(req.body.phone, 'Phone', 40);
    const passwordHash = await bcrypt.hash(password, 10);
    const register = transaction(() => {
      const existing = db.prepare('SELECT id FROM customers WHERE email = ? COLLATE NOCASE').get(email);
      let customerId;
      if (existing) {
        customerId = existing.id;
        db.prepare('UPDATE customers SET name = ?, company = ?, phone = ? WHERE id = ?').run(name, company, phone, customerId);
      } else {
        customerId = Number(db.prepare('INSERT INTO customers (name, email, company, phone) VALUES (?, ?, ?, ?)').run(name, email, company, phone).lastInsertRowid);
      }
      const result = db.prepare("INSERT INTO users (email, password_hash, role, customer_id) VALUES (?, ?, 'customer', ?)").run(email, passwordHash, customerId);
      return db.prepare('SELECT id, email, role, customer_id FROM users WHERE id = ?').get(Number(result.lastInsertRowid));
    });
    signIn(req, res.status(201), register());
  } catch (error) {
    handleValidation(res, error);
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const email = emailAddress(req.body.email);
    const password = text(req.body.password, 'Password', 200);
    const user = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE AND active = 1').get(email);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) return apiError(res, 401, 'Email or password is incorrect.');
    signIn(req, res, user);
  } catch (error) {
    handleValidation(res, error);
  }
});

app.post('/api/auth/password-reset/request', async (req, res) => {
  try {
    const email = emailAddress(req.body.email);
    const user = db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(email);
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      db.prepare('UPDATE users SET reset_token_hash = ?, reset_expires_at = ? WHERE id = ?').run(tokenHash, expiresAt, user.id);
      if (mailTransport) {
        try {
          await mailTransport.sendMail({
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to: email,
            subject: 'Reset your Brightloop password',
            text: `Use this password reset token within 30 minutes: ${token}`
          });
        } catch (mailError) {
          console.error('Password reset email failed:', mailError);
          return apiError(res, 502, 'Password reset email could not be delivered.');
        }
      } else if (process.env.NODE_ENV !== 'production') console.info(`Brightloop password reset token for ${email}: ${token}`);
    }
    res.json({ message: 'If an account exists for that email, password reset instructions will be sent.' });
  } catch (error) {
    handleValidation(res, error);
  }
});

app.post('/api/auth/password-reset/complete', async (req, res) => {
  try {
    const token = text(req.body.token, 'Reset token', 128);
    const password = validPassword(req.body.password);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const user = db.prepare('SELECT id FROM users WHERE reset_token_hash = ? AND reset_expires_at > ?').get(tokenHash, new Date().toISOString());
    if (!user) return apiError(res, 400, 'Reset token is invalid or expired.');
    const passwordHash = await bcrypt.hash(password, 10);
    db.prepare('UPDATE users SET password_hash = ?, reset_token_hash = NULL, reset_expires_at = NULL WHERE id = ?').run(passwordHash, user.id);
    res.json({ message: 'Password updated. You can now sign in.' });
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
app.use('/api', (req, res, next) => {
  if (req.session.role === 'customer' && !req.path.startsWith('/portal/')) return apiError(res, 403, 'Customer accounts can only access their own portal.');
  if (req.session.role === 'staff' && (/^\/(products|variants|plans|discounts|quote-templates|staff)(\/|$)/.test(req.path) && req.method !== 'GET')) {
    return apiError(res, 403, 'Only an admin can manage the product catalog, discounts, templates, or staff.');
  }
  next();
});

app.get('/api/portal/profile', (req, res) => {
  const profile = db.prepare('SELECT id, name, email, company, phone FROM customers WHERE id = ?').get(req.session.customerId);
  if (!profile) return apiError(res, 404, 'Customer profile not found.');
  res.json(profile);
});

app.get('/api/portal/subscriptions', (req, res) => {
  res.json(db.prepare(`
    SELECT s.id, s.subscription_number, s.status, s.workflow_status, s.started_at, s.expires_at, s.next_billing_at,
      p.name AS plan_name, p.price_cents, p.billing_interval, pr.name AS product_name, v.name AS variant_name
    FROM subscriptions s JOIN plans p ON p.id = s.plan_id
    JOIN variants v ON v.id = p.variant_id JOIN products pr ON pr.id = v.product_id
    WHERE s.customer_id = ? ORDER BY s.id DESC
  `).all(req.session.customerId));
});

app.get('/api/portal/invoices', (req, res) => {
  res.json(db.prepare(`
    SELECT i.id, i.invoice_number, i.total_cents, i.paid_cents, i.status, i.document_status, i.issued_at, i.due_at
    FROM invoices i WHERE i.customer_id = ? ORDER BY i.id DESC
  `).all(req.session.customerId).map((invoice) => ({ ...invoice, status: refreshInvoiceStatus(invoice) })));
});

app.get('/api/staff', adminOnly, (req, res) => {
  res.json(db.prepare("SELECT id, email, active, created_at FROM users WHERE role = 'staff' ORDER BY id DESC").all());
});

app.patch('/api/staff/:id', adminOnly, (req, res) => {
  const result = db.prepare("UPDATE users SET active = ? WHERE id = ? AND role = 'staff'")
    .run(req.body.active === false ? 0 : 1, positiveInt(req.params.id, 'Staff ID'));
  if (!result.changes) return apiError(res, 404, 'Staff account not found.');
  res.json(db.prepare('SELECT id, email, role, active FROM users WHERE id = ?').get(Number(req.params.id)));
});

app.post('/api/staff', adminOnly, async (req, res) => {
  try {
    const email = emailAddress(req.body.email);
    const password = validPassword(req.body.password);
    const result = db.prepare("INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'staff')")
      .run(email, await bcrypt.hash(password, 10));
    res.status(201).json(db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(Number(result.lastInsertRowid)));
  } catch (error) {
    handleValidation(res, error);
  }
});

app.get('/api/dashboard', (req, res) => {
  billDueSubscriptions();
  const today = new Date().toISOString();
  db.prepare("UPDATE invoices SET status = 'overdue' WHERE status = 'open' AND due_at < ?").run(today);
  const from = req.query.from ? new Date(req.query.from) : null;
  const to = req.query.to ? new Date(`${req.query.to}T23:59:59.999Z`) : null;
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) return apiError(res, 400, 'Dashboard date filter is invalid.');
  if (from && to && from > to) return apiError(res, 400, 'Dashboard date range start must be before its end.');
  const revenue = db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS total FROM payments
    WHERE (? IS NULL OR recorded_at >= ?) AND (? IS NULL OR recorded_at <= ?)`)
    .get(from?.toISOString() || null, from?.toISOString() || null, to?.toISOString() || null, to?.toISOString() || null).total;
  const active = db.prepare("SELECT COUNT(*) AS count FROM subscriptions WHERE status = 'active'").get().count;
  const activePlans = db.prepare(`
    SELECT s.id, s.discount_id, p.billing_interval, p.price_cents, p.min_quantity, p.discount_percent,
      v.brand, COALESCE(SUM(sl.quantity * sl.unit_price_cents),
        p.price_cents + CASE WHEN v.brand <> '' THEN 56000 ELSE 0 END) AS subtotal_cents,
      COALESCE(SUM(sl.quantity), p.min_quantity) AS quantity
    FROM subscriptions s JOIN plans p ON p.id = s.plan_id
    JOIN variants v ON v.id = p.variant_id
    LEFT JOIN subscription_lines sl ON sl.subscription_id = s.id
    WHERE s.status = 'active' AND s.workflow_status = 'active'
    GROUP BY s.id
  `).all();
  const mrr = activePlans.reduce((total, subscription) => {
    const planDiscount = Math.round(subscription.subtotal_cents * subscription.discount_percent / 100);
    const promo = subscription.discount_id
      ? db.prepare('SELECT * FROM discounts WHERE id = ?').get(subscription.discount_id)
      : null;
    const promoDiscount = eligibleDiscount(promo, subscription.subtotal_cents - planDiscount, subscription.quantity);
    const monthlyFactor = { daily: 30.4375, weekly: 52 / 12, monthly: 1, yearly: 1 / 12 }[subscription.billing_interval] || 1;
    return total + (subscription.subtotal_cents - planDiscount - promoDiscount) * monthlyFactor;
  }, 0);
  const overdue = db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(total_cents - paid_cents), 0) AS amount FROM invoices WHERE status = 'overdue' AND document_status <> 'canceled'").get();
  const outstanding = db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(total_cents - paid_cents), 0) AS amount FROM invoices WHERE status IN ('open', 'overdue') AND document_status <> 'canceled'").get();
  const recent = db.prepare(`
    SELECT i.id, i.invoice_number, i.total_cents, i.status, i.issued_at, c.name AS customer_name
    FROM invoices i JOIN customers c ON c.id = i.customer_id ORDER BY i.id DESC LIMIT 6
  `).all();
  const monthlyRevenue = db.prepare(`
    SELECT strftime('%Y-%m', recorded_at) AS month, SUM(amount_cents) AS total
    FROM payments WHERE recorded_at >= ? GROUP BY month ORDER BY month
  `).all(new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString());
  const monthlySubscriptions = db.prepare(`
    SELECT strftime('%Y-%m', started_at) AS month, COUNT(*) AS total
    FROM subscriptions WHERE started_at >= ? GROUP BY month ORDER BY month
  `).all(new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString());
  res.json({ revenue_cents: revenue, payments_received_cents: revenue, active_subscriptions: active,
    mrr_cents: Math.round(mrr), outstanding_count: outstanding.count, outstanding_cents: outstanding.amount,
    overdue_count: overdue.count, overdue_cents: overdue.amount, recent_invoices: recent,
    monthly_revenue: monthlyRevenue, monthly_subscriptions: monthlySubscriptions });
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
    SELECT v.*, p.name AS product_name, p.selling_price_cents FROM variants v JOIN products p ON p.id = v.product_id ORDER BY v.id DESC
  `).all();
  const plans = db.prepare(`
    SELECT pl.*, v.name AS variant_name, v.sku, p.name AS product_name
    FROM plans pl JOIN variants v ON v.id = pl.variant_id JOIN products p ON p.id = v.product_id ORDER BY pl.id DESC
  `).all().map((plan) => ({ ...plan, interval: plan.billing_interval }));
  res.json({ products, variants, plans });
});

app.post('/api/products', (req, res) => {
  try {
    const result = db.prepare(`INSERT INTO products
      (name, description, product_type, selling_price_cents, cost_price_cents, notes) VALUES (?, ?, ?, ?, ?, ?)`).run(
      text(req.body.name, 'Product name'), optionalText(req.body.description, 'Description'),
      req.body.product_type === 'physical' ? 'physical' : 'service',
      positiveInt(req.body.selling_price_cents ?? 0, 'Selling price', true),
      positiveInt(req.body.cost_price_cents ?? 0, 'Cost price', true),
      optionalText(req.body.notes, 'Notes')
    );
    res.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(Number(result.lastInsertRowid)));
  } catch (error) {
    handleValidation(res, error);
  }
});

app.put('/api/products/:id', (req, res) => {
  try {
    const result = db.prepare(`UPDATE products SET name = ?, description = ?, product_type = ?,
      selling_price_cents = ?, cost_price_cents = ?, notes = ? WHERE id = ?`).run(
      text(req.body.name, 'Product name'), optionalText(req.body.description, 'Description'),
      req.body.product_type === 'physical' ? 'physical' : 'service',
      positiveInt(req.body.selling_price_cents ?? 0, 'Selling price', true),
      positiveInt(req.body.cost_price_cents ?? 0, 'Cost price', true),
      optionalText(req.body.notes, 'Notes'),
      positiveInt(req.params.id, 'Product ID')
    );
    if (!result.changes) return apiError(res, 404, 'Product not found.');
    res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id)));
  } catch (error) {
    handleValidation(res, error);
  }
});

app.delete('/api/products/:id', adminOnly, (req, res) => {
  try {
    const result = db.prepare('DELETE FROM products WHERE id = ?').run(positiveInt(req.params.id, 'Product ID'));
    if (!result.changes) return apiError(res, 404, 'Product not found.');
    res.json({ ok: true });
  } catch (error) {
    if (/FOREIGN KEY/.test(error.message)) return apiError(res, 409, 'This product is used by existing plans and cannot be deleted.');
    handleValidation(res, error);
  }
});

app.post('/api/variants', (req, res) => {
  try {
    const result = db.prepare('INSERT INTO variants (product_id, name, sku, brand) VALUES (?, ?, ?, ?)').run(
      positiveInt(req.body.product_id, 'Product'), text(req.body.name, 'Variant name'),
      text(req.body.sku, 'SKU', 80).toUpperCase(), optionalText(req.body.brand, 'Brand', 100)
    );
    res.status(201).json(db.prepare('SELECT * FROM variants WHERE id = ?').get(Number(result.lastInsertRowid)));
  } catch (error) {
    handleValidation(res, error);
  }
});

app.put('/api/variants/:id', (req, res) => {
  try {
    const result = db.prepare('UPDATE variants SET product_id = ?, name = ?, sku = ?, brand = ? WHERE id = ?').run(
      positiveInt(req.body.product_id, 'Product'), text(req.body.name, 'Variant name'),
      text(req.body.sku, 'SKU', 80).toUpperCase(), optionalText(req.body.brand, 'Brand', 100),
      positiveInt(req.params.id, 'Variant ID')
    );
    if (!result.changes) return apiError(res, 404, 'Variant not found.');
    res.json(db.prepare('SELECT * FROM variants WHERE id = ?').get(Number(req.params.id)));
  } catch (error) {
    handleValidation(res, error);
  }
});

app.delete('/api/variants/:id', adminOnly, (req, res) => {
  try {
    const result = db.prepare('DELETE FROM variants WHERE id = ?').run(positiveInt(req.params.id, 'Variant ID'));
    if (!result.changes) return apiError(res, 404, 'Variant not found.');
    res.json({ ok: true });
  } catch (error) {
    if (/FOREIGN KEY/.test(error.message)) return apiError(res, 409, 'This variant is used by a subscription plan and cannot be deleted.');
    handleValidation(res, error);
  }
});

app.post('/api/plans', (req, res) => {
  try {
    const billingInterval = req.body.billing_interval || req.body.interval;
    if (!['daily', 'weekly', 'monthly', 'yearly'].includes(billingInterval)) throw new Error('Billing interval must be daily, weekly, monthly, or yearly.');
    const quantity = positiveInt(req.body.min_quantity ?? 1, 'Minimum quantity');
    const availableFrom = req.body.available_from ? inputDate(req.body.available_from, 'Availability start date') : null;
    const availableUntil = req.body.available_until ? inputDate(req.body.available_until, 'Availability end date', true) : null;
    if (availableFrom && availableUntil && availableUntil < availableFrom) throw new Error('Availability end must be after its start.');
    const result = db.prepare(`
      INSERT INTO plans (variant_id, name, interval, billing_interval, price_cents, tax_percent, discount_percent,
        min_quantity, available_from, available_until, auto_close) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      positiveInt(req.body.variant_id, 'Variant'), text(req.body.name, 'Plan name'),
      billingInterval === 'yearly' ? 'yearly' : 'monthly', billingInterval,
      positiveInt(req.body.price_cents, 'Price', true), percent(req.body.tax_percent ?? 0, 'Tax'),
      percent(req.body.discount_percent ?? 0, 'Discount'), quantity,
      availableFrom?.toISOString() || null, availableUntil?.toISOString() || null,
      req.body.auto_close === true || req.body.auto_close === '1' ? 1 : 0
    );
    res.status(201).json(db.prepare('SELECT * FROM plans WHERE id = ?').get(Number(result.lastInsertRowid)));
  } catch (error) {
    handleValidation(res, error);
  }
});

app.put('/api/plans/:id', (req, res) => {
  try {
    const billingInterval = req.body.billing_interval || req.body.interval;
    if (!['daily', 'weekly', 'monthly', 'yearly'].includes(billingInterval)) throw new Error('Billing interval must be daily, weekly, monthly, or yearly.');
    const quantity = positiveInt(req.body.min_quantity ?? 1, 'Minimum quantity');
    const availableFrom = req.body.available_from ? inputDate(req.body.available_from, 'Availability start date') : null;
    const availableUntil = req.body.available_until ? inputDate(req.body.available_until, 'Availability end date', true) : null;
    if (availableFrom && availableUntil && availableUntil < availableFrom) throw new Error('Availability end must be after its start.');
    const result = db.prepare(`
      UPDATE plans SET variant_id = ?, name = ?, interval = ?, billing_interval = ?, price_cents = ?,
        tax_percent = ?, discount_percent = ?, min_quantity = ?, available_from = ?, available_until = ?,
        auto_close = ? WHERE id = ?
    `).run(
      positiveInt(req.body.variant_id, 'Variant'), text(req.body.name, 'Plan name'),
      billingInterval === 'yearly' ? 'yearly' : 'monthly', billingInterval,
      positiveInt(req.body.price_cents, 'Price', true), percent(req.body.tax_percent ?? 0, 'Tax'),
      percent(req.body.discount_percent ?? 0, 'Discount'), quantity,
      availableFrom?.toISOString() || null, availableUntil?.toISOString() || null,
      req.body.auto_close === true || req.body.auto_close === '1' ? 1 : 0,
      positiveInt(req.params.id, 'Plan ID')
    );
    if (!result.changes) return apiError(res, 404, 'Plan not found.');
    res.json(db.prepare('SELECT * FROM plans WHERE id = ?').get(Number(req.params.id)));
  } catch (error) {
    handleValidation(res, error);
  }
});

app.delete('/api/plans/:id', adminOnly, (req, res) => {
  try {
    const result = db.prepare('DELETE FROM plans WHERE id = ?').run(positiveInt(req.params.id, 'Plan ID'));
    if (!result.changes) return apiError(res, 404, 'Plan not found.');
    res.json({ ok: true });
  } catch (error) {
    if (/FOREIGN KEY/.test(error.message)) return apiError(res, 409, 'This plan is used by subscriptions and cannot be deleted.');
    handleValidation(res, error);
  }
});

app.get('/api/discounts', (req, res) => {
  res.json(db.prepare('SELECT * FROM discounts ORDER BY id DESC').all());
});

app.post('/api/discounts', adminOnly, (req, res) => {
  try {
    if (!['fixed', 'percent'].includes(req.body.discount_type)) throw new Error('Discount type must be fixed or percent.');
    const amount = req.body.discount_type === 'percent'
      ? percent(req.body.amount, 'Discount percent')
      : positiveInt(req.body.amount_cents, 'Discount amount');
    const minPurchase = positiveInt(req.body.min_purchase_cents ?? 0, 'Minimum purchase', true);
    const minQuantity = positiveInt(req.body.min_quantity ?? 1, 'Minimum quantity');
    const limit = req.body.usage_limit ? positiveInt(req.body.usage_limit, 'Usage limit') : null;
    const starts = req.body.starts_at ? inputDate(req.body.starts_at, 'Discount start date') : null;
    const expires = req.body.expires_at ? inputDate(req.body.expires_at, 'Discount expiry date', true) : null;
    if (starts && expires && expires < starts) throw new Error('Discount expiry must be after its start.');
    const result = db.prepare(`INSERT INTO discounts
      (name, code, discount_type, amount, min_purchase_cents, min_quantity, starts_at, expires_at, usage_limit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      text(req.body.name, 'Discount name'), text(req.body.code, 'Discount code', 80).toUpperCase(),
      req.body.discount_type, amount, minPurchase, minQuantity, starts?.toISOString() || null,
      expires?.toISOString() || null, limit
    );
    res.status(201).json(db.prepare('SELECT * FROM discounts WHERE id = ?').get(Number(result.lastInsertRowid)));
  } catch (error) {
    handleValidation(res, error);
  }
});

app.put('/api/discounts/:id', adminOnly, (req, res) => {
  try {
    if (!['fixed', 'percent'].includes(req.body.discount_type)) throw new Error('Discount type must be fixed or percent.');
    const amount = req.body.discount_type === 'percent'
      ? percent(req.body.amount, 'Discount percent')
      : positiveInt(req.body.amount_cents, 'Discount amount');
    const result = db.prepare(`UPDATE discounts SET name = ?, code = ?, discount_type = ?, amount = ?,
      min_purchase_cents = ?, min_quantity = ?, starts_at = ?, expires_at = ?, usage_limit = ?, active = ?
      WHERE id = ?`).run(
      text(req.body.name, 'Discount name'), text(req.body.code, 'Discount code', 80).toUpperCase(),
      req.body.discount_type, amount, positiveInt(req.body.min_purchase_cents ?? 0, 'Minimum purchase', true),
      positiveInt(req.body.min_quantity ?? 1, 'Minimum quantity'),
      req.body.starts_at ? inputDate(req.body.starts_at, 'Discount start date').toISOString() : null,
      req.body.expires_at ? inputDate(req.body.expires_at, 'Discount expiry date', true).toISOString() : null,
      req.body.usage_limit ? positiveInt(req.body.usage_limit, 'Usage limit') : null,
      req.body.active === false ? 0 : 1, positiveInt(req.params.id, 'Discount ID')
    );
    if (!result.changes) return apiError(res, 404, 'Discount not found.');
    res.json(db.prepare('SELECT * FROM discounts WHERE id = ?').get(Number(req.params.id)));
  } catch (error) {
    handleValidation(res, error);
  }
});

app.delete('/api/discounts/:id', adminOnly, (req, res) => {
  try {
    const result = db.prepare('DELETE FROM discounts WHERE id = ?').run(positiveInt(req.params.id, 'Discount ID'));
    if (!result.changes) return apiError(res, 404, 'Discount not found.');
    res.json({ ok: true });
  } catch (error) {
    if (/FOREIGN KEY/.test(error.message)) return apiError(res, 409, 'This discount is attached to a subscription and cannot be deleted.');
    handleValidation(res, error);
  }
});

app.get('/api/quote-templates', (req, res) => {
  res.json(db.prepare('SELECT * FROM quote_templates ORDER BY id DESC').all().map((template) => ({
    ...template, product_lines: JSON.parse(template.product_lines)
  })));
});

app.post('/api/quote-templates', adminOnly, (req, res) => {
  try {
    const lines = req.body.product_lines || [];
    if (!Array.isArray(lines)) throw new Error('Template product lines must be a list.');
    const validity = positiveInt(req.body.validity_days ?? 30, 'Quote validity');
    const result = db.prepare(`INSERT INTO quote_templates (name, plan_id, product_lines, validity_days)
      VALUES (?, ?, ?, ?)`).run(
      text(req.body.name, 'Template name'), positiveInt(req.body.plan_id, 'Plan'),
      JSON.stringify(lines.map((line) => ({
        product_id: line.product_id ? positiveInt(line.product_id, 'Product') : null,
        description: text(line.description, 'Line description', 160),
        quantity: positiveInt(line.quantity, 'Line quantity'),
        unit_price_cents: positiveInt(line.unit_price_cents, 'Unit price', true),
        tax_percent: percent(line.tax_percent ?? 0, 'Line tax')
      }))), validity
    );
    res.status(201).json(db.prepare('SELECT * FROM quote_templates WHERE id = ?').get(Number(result.lastInsertRowid)));
  } catch (error) {
    handleValidation(res, error);
  }
});

app.put('/api/quote-templates/:id', adminOnly, (req, res) => {
  try {
    const lines = req.body.product_lines || [];
    if (!Array.isArray(lines)) throw new Error('Template product lines must be a list.');
    const result = db.prepare(`UPDATE quote_templates SET name = ?, plan_id = ?, product_lines = ?, validity_days = ?
      WHERE id = ?`).run(
      text(req.body.name, 'Template name'), positiveInt(req.body.plan_id, 'Plan'),
      JSON.stringify(lines.map((line) => ({
        product_id: line.product_id ? positiveInt(line.product_id, 'Product') : null,
        description: text(line.description, 'Line description', 160),
        quantity: positiveInt(line.quantity, 'Line quantity'),
        unit_price_cents: positiveInt(line.unit_price_cents, 'Unit price', true),
        tax_percent: percent(line.tax_percent ?? 0, 'Line tax')
      }))), positiveInt(req.body.validity_days ?? 30, 'Quote validity'),
      positiveInt(req.params.id, 'Template ID')
    );
    if (!result.changes) return apiError(res, 404, 'Quote template not found.');
    res.json(db.prepare('SELECT * FROM quote_templates WHERE id = ?').get(Number(req.params.id)));
  } catch (error) {
    handleValidation(res, error);
  }
});

app.delete('/api/quote-templates/:id', adminOnly, (req, res) => {
  const result = db.prepare('DELETE FROM quote_templates WHERE id = ?').run(positiveInt(req.params.id, 'Template ID'));
  if (!result.changes) return apiError(res, 404, 'Quote template not found.');
  res.json({ ok: true });
});

app.get('/api/subscriptions', (req, res) => {
  res.json(db.prepare(`
    SELECT s.*, c.name AS customer_name, c.email AS customer_email, p.name AS plan_name,
      p.price_cents, p.billing_interval AS interval, p.min_quantity, pr.name AS product_name, v.name AS variant_name
    FROM subscriptions s JOIN customers c ON c.id = s.customer_id
    JOIN plans p ON p.id = s.plan_id JOIN variants v ON v.id = p.variant_id
    JOIN products pr ON pr.id = v.product_id ORDER BY s.id DESC
  `).all());
});

app.post('/api/subscriptions', (req, res) => {
  const create = transaction(() => {
    const customerId = positiveInt(req.body.customer_id, 'Customer');
    const template = req.body.template_id ? db.prepare('SELECT * FROM quote_templates WHERE id = ?').get(positiveInt(req.body.template_id, 'Template ID')) : null;
    if (req.body.template_id && !template) throw new Error('The selected quote template does not exist.');
    const planId = positiveInt(req.body.plan_id || template?.plan_id, 'Plan');
    const plan = db.prepare(`SELECT pl.*, v.brand FROM plans pl
      JOIN variants v ON v.id = pl.variant_id WHERE pl.id = ?`).get(planId);
    if (!plan) throw new Error('The selected plan does not exist.');
    if (!db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId)) throw new Error('The selected customer does not exist.');
    const started = req.body.start_date ? inputDate(req.body.start_date, 'Subscription start date') : new Date();
    if (plan.available_from && started < new Date(plan.available_from)) throw new Error('This plan is not available yet.');
    if (plan.available_until && started > new Date(plan.available_until)) throw new Error('This plan is no longer available.');
    const now = new Date();
    const quantity = positiveInt(req.body.quantity ?? plan.min_quantity, 'Quantity');
    if (quantity < plan.min_quantity) throw new Error(`This plan requires at least ${plan.min_quantity} items.`);
    const interval = plan.billing_interval || plan.interval;
    const nextBilling = addInterval(started, interval);
    const expiry = req.body.expires_at ? inputDate(req.body.expires_at, 'Subscription expiry date', true) : (plan.auto_close && plan.available_until ? new Date(plan.available_until) : null);
    if (expiry && expiry <= started) throw new Error('Subscription expiry must be after its start date.');
    const workflowStatus = req.body.workflow_status || (template ? 'quotation' : (started > now ? 'draft' : 'active'));
    if (!['draft', 'quotation', 'confirmed', 'active'].includes(workflowStatus)) throw new Error('Subscription must start as Draft, Quotation, Confirmed, or Active.');
    if (started > now && workflowStatus === 'active') throw new Error('Future-dated subscriptions must start as a draft or quotation.');
    const paymentTermsDays = positiveInt(req.body.payment_terms_days ?? 7, 'Payment terms');
    const discount = req.body.discount_code
      ? db.prepare('SELECT * FROM discounts WHERE code = ? COLLATE NOCASE').get(text(req.body.discount_code, 'Discount code', 80))
      : null;
    if (req.body.discount_code && !discount) throw new Error('Discount code not found.');
    const result = db.prepare(`
      INSERT INTO subscriptions (customer_id, plan_id, status, workflow_status, started_at, next_billing_at,
        expires_at, quote_expires_at, payment_terms_days, discount_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(customerId, planId, workflowStatus === 'active' ? 'active' : 'paused', workflowStatus,
      started.toISOString(), nextBilling.toISOString(), expiry?.toISOString() || null,
      workflowStatus === 'quotation' ? new Date(Date.now() + positiveInt(req.body.validity_days ?? template?.validity_days ?? 30, 'Quote validity') * 86400000).toISOString() : null,
      paymentTermsDays, discount?.id || null);
    const subscriptionId = Number(result.lastInsertRowid);
    const subscriptionNumber = `SUB-${String(subscriptionId).padStart(6, '0')}`;
    db.prepare('UPDATE subscriptions SET subscription_number = ? WHERE id = ?').run(subscriptionNumber, subscriptionId);
    db.prepare(`INSERT INTO subscription_lines (subscription_id, product_id, description, quantity, unit_price_cents, tax_percent)
      SELECT ?, p.id, pl.name, ?, pl.price_cents + CASE WHEN v.brand <> '' THEN 56000 ELSE 0 END, pl.tax_percent
      FROM plans pl JOIN variants v ON v.id = pl.variant_id JOIN products p ON p.id = v.product_id WHERE pl.id = ?`)
      .run(subscriptionId, quantity, planId);
    const extraLines = req.body.lines || (template ? JSON.parse(template.product_lines) : []);
    if (!Array.isArray(extraLines)) throw new Error('Subscription product lines must be a list.');
    for (const line of extraLines) {
      db.prepare(`INSERT INTO subscription_lines
        (subscription_id, product_id, description, quantity, unit_price_cents, tax_percent)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
        subscriptionId, line.product_id ? positiveInt(line.product_id, 'Product') : null,
        text(line.description, 'Line description', 160), positiveInt(line.quantity, 'Line quantity'),
        positiveInt(line.unit_price_cents, 'Unit price', true), percent(line.tax_percent ?? plan.tax_percent, 'Line tax')
      );
    }
    const invoice = workflowStatus === 'active'
      ? createInvoice(subscriptionId, started.toISOString(), nextBilling.toISOString())
      : null;
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
    const subscription = db.prepare(`SELECT s.*, p.billing_interval FROM subscriptions s
      JOIN plans p ON p.id = s.plan_id WHERE s.id = ?`).get(id);
    if (!subscription) throw new Error('Subscription not found.');
    if (subscription.status !== 'active') throw new Error('Only active subscriptions can be renewed.');
    if (subscription.expires_at && new Date(subscription.expires_at) <= new Date()) throw new Error('This subscription has expired and cannot be renewed.');
    const from = new Date(subscription.next_billing_at);
    const nextBilling = addInterval(from, subscription.billing_interval);
    db.prepare('UPDATE subscriptions SET next_billing_at = ? WHERE id = ?').run(nextBilling.toISOString(), id);
    return { subscription: db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id), invoice: createInvoice(id, from.toISOString(), nextBilling.toISOString()) };
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
    const id = positiveInt(req.params.id, 'Subscription ID');
    const subscription = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
    if (!subscription) return apiError(res, 404, 'Subscription not found.');
    if (['draft', 'quotation', 'confirmed', 'closed'].includes(status)) {
      const transitions = { draft: ['quotation', 'confirmed'], quotation: ['confirmed'], confirmed: ['active'], active: ['closed'] };
      if (!(transitions[subscription.workflow_status] || []).includes(status)) {
        throw new Error(`Cannot move a ${subscription.workflow_status} subscription to ${status}.`);
      }
      if (subscription.workflow_status === 'quotation' && subscription.quote_expires_at && new Date(subscription.quote_expires_at) < new Date()) {
        throw new Error('This quotation has expired and cannot be confirmed.');
      }
      const operationalStatus = status === 'active' ? 'active' : (status === 'closed' ? 'canceled' : 'paused');
      db.prepare('UPDATE subscriptions SET status = ?, workflow_status = ? WHERE id = ?').run(operationalStatus, status, id);
      if (status === 'active') createInvoice(id, subscription.started_at, subscription.next_billing_at);
    } else if (['active', 'paused', 'canceled'].includes(status)) {
      const workflow = status === 'canceled' ? 'closed' : (status === 'active' ? 'active' : subscription.workflow_status);
      const result = db.prepare('UPDATE subscriptions SET status = ?, workflow_status = ? WHERE id = ?').run(status, workflow, id);
      if (status === 'active' && subscription.status !== 'active') createInvoice(id, subscription.started_at, subscription.next_billing_at);
    } else throw new Error('Choose a valid subscription status.');
    res.json(db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(Number(req.params.id)));
  } catch (error) {
    handleValidation(res, error);
  }
});

app.get('/api/invoices', (req, res) => {
  const invoices = db.prepare(`
    SELECT i.*, c.name AS customer_name, c.email AS customer_email, s.id AS subscription_number,
      p.name AS plan_name, p.billing_interval AS interval
    FROM invoices i JOIN customers c ON c.id = i.customer_id JOIN subscriptions s ON s.id = i.subscription_id
    JOIN plans p ON p.id = s.plan_id ORDER BY i.id DESC
  `).all();
  res.json(invoices.map((invoice) => ({ ...invoice, status: refreshInvoiceStatus(invoice) })));
});

app.post('/api/invoices', (req, res) => {
  try {
    const subscriptionId = positiveInt(req.body.subscription_id, 'Subscription');
    const subscription = db.prepare('SELECT s.*, p.billing_interval FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.id = ?').get(subscriptionId);
    if (!subscription) return apiError(res, 404, 'Subscription not found.');
    if (!['active', 'confirmed'].includes(subscription.workflow_status)) throw new Error('Only confirmed or active subscriptions can be invoiced.');
    const periodStart = req.body.period_start ? new Date(req.body.period_start) : new Date();
    const periodEnd = req.body.period_end ? new Date(req.body.period_end) : addInterval(periodStart, subscription.billing_interval);
    if (Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime()) || periodEnd <= periodStart) {
      throw new Error('Invoice period dates are invalid.');
    }
    if (db.prepare('SELECT id FROM invoices WHERE subscription_id = ? AND period_start = ?').get(subscriptionId, periodStart.toISOString())) {
      return apiError(res, 409, 'An invoice already exists for that subscription period.');
    }
    const invoice = transaction(() => createInvoice(subscriptionId, periodStart.toISOString(), periodEnd.toISOString(), 'draft'))();
    res.status(201).json(invoice);
  } catch (error) {
    handleValidation(res, error);
  }
});

app.post('/api/billing/run-due', adminOnly, (req, res) => {
  try {
    res.json({ invoices_created: billDueSubscriptions() });
  } catch (error) {
    console.error('Manual billing run failed:', error);
    apiError(res, 500, 'Due subscriptions could not be billed. Check server logs for details.');
  }
});

app.get('/api/invoices/:id', (req, res) => {
  const invoice = db.prepare(`
    SELECT i.*, c.name AS customer_name, c.email AS customer_email, c.company, c.phone,
      p.name AS plan_name, p.billing_interval AS interval, pr.name AS product_name, v.name AS variant_name
    FROM invoices i JOIN customers c ON c.id = i.customer_id
    JOIN subscriptions s ON s.id = i.subscription_id JOIN plans p ON p.id = s.plan_id
    JOIN variants v ON v.id = p.variant_id JOIN products pr ON pr.id = v.product_id WHERE i.id = ?
  `).get(positiveInt(req.params.id, 'Invoice ID'));
  if (!invoice) return apiError(res, 404, 'Invoice not found.');
  invoice.status = refreshInvoiceStatus(invoice);
  invoice.payments = db.prepare('SELECT * FROM payments WHERE invoice_id = ? ORDER BY id DESC').all(invoice.id);
  invoice.lines = db.prepare('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY id').all(invoice.id);
  res.json(invoice);
});

app.patch('/api/invoices/:id/status', (req, res) => {
  try {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(positiveInt(req.params.id, 'Invoice ID'));
    if (!invoice) return apiError(res, 404, 'Invoice not found.');
    const action = req.body.action;
    if (action === 'confirm') {
      if (invoice.document_status !== 'draft') throw new Error('Only draft invoices can be confirmed.');
      db.prepare("UPDATE invoices SET document_status = 'confirmed' WHERE id = ?").run(invoice.id);
    } else if (action === 'cancel') {
      if (invoice.paid_cents > 0) throw new Error('An invoice with recorded payments cannot be canceled.');
      db.prepare("UPDATE invoices SET document_status = 'canceled' WHERE id = ?").run(invoice.id);
    } else if (action === 'send') {
      if (!mailTransport) return apiError(res, 503, 'Invoice email is not configured. Set SMTP_* environment variables to enable delivery.');
      if (invoice.document_status === 'canceled') throw new Error('Canceled invoices cannot be sent.');
      const customer = db.prepare('SELECT name, email FROM customers WHERE id = ?').get(invoice.customer_id);
      mailTransport.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: customer.email,
        subject: `Brightloop invoice ${invoice.invoice_number}`,
        text: `Hello ${customer.name},\n\nYour invoice ${invoice.invoice_number} is ${formatMoney(invoice.total_cents)}. Due date: ${invoice.due_at}.\n\nThank you.`
      }).then(() => db.prepare("UPDATE invoices SET document_status = 'sent' WHERE id = ?").run(invoice.id))
        .then(() => res.json({ ok: true, document_status: 'sent' }))
        .catch((error) => {
          console.error('Invoice email failed:', error);
          apiError(res, 502, 'The invoice email could not be delivered.');
        });
      return;
    } else throw new Error('Invoice action must be confirm, cancel, or send.');
    res.json(db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoice.id));
  } catch (error) {
    handleValidation(res, error);
  }
});

app.get('/api/portal/invoices/:id', (req, res) => {
  const invoice = db.prepare(`SELECT i.*, c.name AS customer_name, c.email AS customer_email,
    s.subscription_number, p.name AS plan_name, p.billing_interval AS interval
    FROM invoices i JOIN customers c ON c.id = i.customer_id
    JOIN subscriptions s ON s.id = i.subscription_id JOIN plans p ON p.id = s.plan_id
    WHERE i.id = ? AND i.customer_id = ?`).get(positiveInt(req.params.id, 'Invoice ID'), req.session.customerId);
  if (!invoice) return apiError(res, 404, 'Invoice not found.');
  invoice.status = refreshInvoiceStatus(invoice);
  invoice.lines = db.prepare('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY id').all(invoice.id);
  invoice.payments = db.prepare('SELECT amount_cents, method, recorded_at FROM payments WHERE invoice_id = ? ORDER BY id DESC').all(invoice.id);
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
    if (invoice.document_status === 'canceled') throw new Error('Payments cannot be recorded against a canceled invoice.');
    if (!['confirmed', 'sent'].includes(invoice.document_status)) throw new Error('Confirm the invoice before recording a payment.');
    const recorded = req.body.recorded_at ? new Date(req.body.recorded_at) : new Date();
    if (Number.isNaN(recorded.getTime())) throw new Error('Payment date is invalid.');
    db.prepare('INSERT INTO payments (invoice_id, amount_cents, method, reference, recorded_at, notes) VALUES (?, ?, ?, ?, ?, ?)').run(
      invoiceId, amount, method, optionalText(req.body.reference, 'Reference', 120) || `MANUAL-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
      recorded.toISOString(), optionalText(req.body.notes, 'Payment notes')
    );
    const paid = invoice.paid_cents + amount;
    const status = paid === invoice.total_cents ? 'paid' : (new Date(invoice.due_at) < new Date() ? 'overdue' : 'open');
    db.prepare('UPDATE invoices SET paid_cents = ?, status = ?, document_status = ? WHERE id = ?')
      .run(paid, status, paid === invoice.total_cents ? 'paid' : invoice.document_status, invoiceId);
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
  billDueSubscriptions();
  app.listen(port, () => console.log(`Brightloop is running at http://localhost:${port}`));
  const billingTimer = setInterval(() => {
    try {
      billDueSubscriptions();
    } catch (error) {
      console.error('Scheduled subscription billing failed:', error);
    }
  }, 60 * 1000);
  billingTimer.unref();
}).catch((error) => {
  console.error('Unable to initialize Brightloop:', error);
  process.exitCode = 1;
});

module.exports = { app, db, billDueSubscriptions };

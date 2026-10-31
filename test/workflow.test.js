const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { DatabaseSync } = require('node:sqlite');

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

test('admin can create a subscription, invoice it and record a payment', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'brightloop-test-'));
  const port = await unusedPort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(directory, 'test.sqlite'),
      ADMIN_EMAIL: 'admin@test.local',
      ADMIN_PASSWORD: 'workflow-test-password',
      SESSION_SECRET: 'workflow-test-session-secret'
    },
    stdio: 'ignore'
  });
  t.after(async () => {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) assert.fail('Brightloop server exited before becoming ready.');
    try {
      const response = await fetch(`${baseUrl}/api/auth/session`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, 'server should start within eight seconds');

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@test.local', password: 'workflow-test-password' })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  async function request(url, options = {}) {
    const response = await fetch(`${baseUrl}${url}`, {
      ...options,
      headers: { Cookie: cookie, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
    });
    const payload = await response.json();
    return { response, payload };
  }

  const customerResponse = await request('/api/customers', {
    method: 'POST',
    body: JSON.stringify({ name: 'Workflow Customer', email: 'workflow@example.com' })
  });
  assert.equal(customerResponse.response.status, 201);

  const catalog = await request('/api/catalog');
  const plan = catalog.payload.plans.find((item) => item.discount_percent > 0);
  assert.ok(plan, 'seed catalog should include a discounted plan');
  const updatedPlan = await request(`/api/plans/${plan.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      variant_id: plan.variant_id, name: `${plan.name} revised`, interval: plan.interval,
      price_cents: plan.price_cents, tax_percent: plan.tax_percent, discount_percent: plan.discount_percent
    })
  });
  assert.equal(updatedPlan.response.status, 200);
  assert.equal(updatedPlan.payload.name, `${plan.name} revised`);

  const created = await request('/api/subscriptions', {
    method: 'POST',
    body: JSON.stringify({ customer_id: customerResponse.payload.id, plan_id: plan.id })
  });
  assert.equal(created.response.status, 201);
  const invoice = created.payload.invoice;
  const discount = Math.round(plan.price_cents * plan.discount_percent / 100);
  const tax = Math.round((plan.price_cents - discount) * plan.tax_percent / 100);
  assert.equal(invoice.total_cents, plan.price_cents - discount + tax);
  assert.equal(invoice.status, 'open');

  const partial = Math.floor(invoice.total_cents / 2);
  const firstPayment = await request(`/api/invoices/${invoice.id}/payments`, {
    method: 'POST',
    body: JSON.stringify({ amount_cents: partial, method: 'Bank transfer' })
  });
  assert.equal(firstPayment.payload.status, 'open');
  assert.equal(firstPayment.payload.paid_cents, partial);

  const overpayment = await request(`/api/invoices/${invoice.id}/payments`, {
    method: 'POST',
    body: JSON.stringify({ amount_cents: invoice.total_cents, method: 'Card' })
  });
  assert.equal(overpayment.response.status, 400);

  const finalPayment = await request(`/api/invoices/${invoice.id}/payments`, {
    method: 'POST',
    body: JSON.stringify({ amount_cents: invoice.total_cents - partial, method: 'Card' })
  });
  assert.equal(finalPayment.payload.status, 'paid');
  assert.equal(finalPayment.payload.paid_cents, invoice.total_cents);

  const dashboard = await request('/api/dashboard');
  assert.equal(dashboard.payload.revenue_cents, invoice.total_cents);
  assert.equal(dashboard.payload.active_subscriptions, 1);

  const paused = await request(`/api/subscriptions/${created.payload.subscription.id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'paused' })
  });
  assert.equal(paused.payload.status, 'paused');
  const pausedRenewal = await request(`/api/subscriptions/${created.payload.subscription.id}/renew`, { method: 'POST', body: '{}' });
  assert.equal(pausedRenewal.response.status, 400);

  const resumed = await request(`/api/subscriptions/${created.payload.subscription.id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'active' })
  });
  assert.equal(resumed.payload.status, 'active');
  const renewal = await request(`/api/subscriptions/${created.payload.subscription.id}/renew`, { method: 'POST', body: '{}' });
  assert.equal(renewal.response.status, 201);
  assert.equal(renewal.payload.invoice.status, 'open');

  const database = new DatabaseSync(path.join(directory, 'test.sqlite'));
  database.prepare('UPDATE invoices SET due_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', renewal.payload.invoice.id);
  database.close();
  const invoices = await request('/api/invoices');
  assert.equal(invoices.payload.find((item) => item.id === renewal.payload.invoice.id).status, 'overdue');
  const overdueDashboard = await request('/api/dashboard');
  assert.equal(overdueDashboard.payload.overdue_count, 1);

  const closed = await request(`/api/subscriptions/${created.payload.subscription.id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'canceled' })
  });
  assert.equal(closed.payload.status, 'canceled');
});

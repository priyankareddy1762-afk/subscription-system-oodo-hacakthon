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
  const serverEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(directory, 'test.sqlite'),
    ADMIN_EMAIL: 'admin@test.local',
    ADMIN_PASSWORD: 'WorkflowTest123!',
    SESSION_SECRET: 'workflow-test-session-secret'
  };
  function startServer() {
    const processHandle = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      cwd: path.join(__dirname, '..'), env: serverEnv, stdio: ['ignore', 'pipe', 'pipe']
    });
    processHandle.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
    processHandle.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });
    return processHandle;
  }
  let serverOutput = '';
  let child = startServer();
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
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
    body: JSON.stringify({ email: 'admin@test.local', password: 'WorkflowTest123!' })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  async function request(url, options = {}, requestCookie = cookie) {
    const response = await fetch(`${baseUrl}${url}`, {
      ...options,
      headers: { Cookie: requestCookie, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
    });
    const payload = await response.json();
    return { response, payload };
  }

  async function signIn(email, password) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const payload = await response.json();
    return { response, payload, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }

  const weakRegistration = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Weak Password', email: 'weak@example.com', password: 'lowercaseonly' })
  });
  assert.equal(weakRegistration.response.status, 400);

  const customerResponse = await request('/api/customers', {
    method: 'POST',
    body: JSON.stringify({ name: 'Workflow Customer', email: 'workflow@example.com' })
  });
  assert.equal(customerResponse.response.status, 201);

  const staffCreated = await request('/api/staff', {
    method: 'POST',
    body: JSON.stringify({ email: 'workflow-staff@example.com', password: 'StaffWorkflow123!' })
  });
  assert.equal(staffCreated.response.status, 201);
  const staffLogin = await signIn('workflow-staff@example.com', 'StaffWorkflow123!');
  assert.equal(staffLogin.response.status, 200);
  assert.equal(staffLogin.payload.role, 'staff');
  const forbiddenStaffList = await request('/api/staff', {}, staffLogin.cookie);
  assert.equal(forbiddenStaffList.response.status, 403);
  const forbiddenCatalogWrite = await request('/api/products', {
    method: 'POST',
    body: JSON.stringify({ name: 'Staff cannot add products' })
  }, staffLogin.cookie);
  assert.equal(forbiddenCatalogWrite.response.status, 403);
  const deactivateStaff = await request(`/api/staff/${staffCreated.payload.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ active: false })
  });
  assert.equal(deactivateStaff.payload.active, 0);
  assert.equal((await signIn('workflow-staff@example.com', 'StaffWorkflow123!')).response.status, 401);

  const customerRegistration = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Workflow Customer', email: 'workflow@example.com', password: 'CustomerWorkflow123!' })
  }, '');
  assert.equal(customerRegistration.response.status, 201);
  assert.equal(customerRegistration.payload.role, 'customer');
  const customerCookie = customerRegistration.response.headers.get('set-cookie').split(';')[0];
  const blockedCustomerList = await request('/api/customers', {}, customerCookie);
  assert.equal(blockedCustomerList.response.status, 403);
  assert.equal((await request('/api/portal/profile', {}, customerCookie)).payload.email, 'workflow@example.com');
  const duplicateRegistration = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Duplicate', email: 'workflow@example.com', password: 'CustomerWorkflow123!' })
  }, '');
  assert.equal(duplicateRegistration.response.status, 409);

  const resetRequest = await request('/api/auth/password-reset/request', {
    method: 'POST',
    body: JSON.stringify({ email: 'workflow@example.com' })
  }, '');
  assert.equal(resetRequest.response.status, 200);
  let resetToken;
  for (let attempt = 0; attempt < 30 && !resetToken; attempt += 1) {
    resetToken = serverOutput.match(/password reset token for workflow@example\.com: ([a-f0-9]{64})/)?.[1];
    if (!resetToken) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(resetToken, 'reset token should be delivered to the development log');
  const resetComplete = await request('/api/auth/password-reset/complete', {
    method: 'POST',
    body: JSON.stringify({ token: resetToken, password: 'ChangedWorkflow123!' })
  }, '');
  assert.equal(resetComplete.response.status, 200);
  assert.equal((await signIn('workflow@example.com', 'CustomerWorkflow123!')).response.status, 401);
  assert.equal((await signIn('workflow@example.com', 'ChangedWorkflow123!')).response.status, 200);

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

  const datePlans = [];
  for (const interval of ['daily', 'weekly', 'monthly', 'yearly']) {
    const createdPlan = await request('/api/plans', {
      method: 'POST',
      body: JSON.stringify({ variant_id: plan.variant_id, name: `${interval} workflow`, interval, price_cents: 5000, min_quantity: 2, tax_percent: 5 })
    });
    assert.equal(createdPlan.response.status, 201);
    assert.equal(createdPlan.payload.billing_interval, interval);
    datePlans.push(createdPlan.payload);
  }
  const tooFew = await request('/api/subscriptions', {
    method: 'POST',
    body: JSON.stringify({ customer_id: customerResponse.payload.id, plan_id: datePlans[0].id, quantity: 1 })
  });
  assert.equal(tooFew.response.status, 400);
  const futureStart = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const futureActive = await request('/api/subscriptions', {
    method: 'POST',
    body: JSON.stringify({ customer_id: customerResponse.payload.id, plan_id: datePlans[2].id, start_date: futureStart, workflow_status: 'active' })
  });
  assert.equal(futureActive.response.status, 400);
  const futureSubscription = await request('/api/subscriptions', {
    method: 'POST',
    body: JSON.stringify({ customer_id: customerResponse.payload.id, plan_id: datePlans[2].id, start_date: futureStart })
  });
  assert.equal(futureSubscription.response.status, 201);
  assert.equal(futureSubscription.payload.subscription.workflow_status, 'draft');
  assert.equal(futureSubscription.payload.invoice, null);

  const product = await request('/api/products', {
    method: 'POST',
    body: JSON.stringify({ name: 'Brand product', product_type: 'physical', selling_price_cents: 10000, cost_price_cents: 4000, notes: 'test product' })
  });
  assert.equal(product.response.status, 201);
  const brandVariant = await request('/api/variants', {
    method: 'POST',
    body: JSON.stringify({ product_id: product.payload.id, name: 'Premium', sku: 'BRAND-WORKFLOW-1', brand: 'Brightloop' })
  });
  assert.equal(brandVariant.response.status, 201);
  const brandPlan = await request('/api/plans', {
    method: 'POST',
    body: JSON.stringify({ variant_id: brandVariant.payload.id, name: 'Brand monthly', interval: 'monthly', price_cents: 10000 })
  });
  assert.equal(brandPlan.response.status, 201);

  const discount = await request('/api/discounts', {
    method: 'POST',
    body: JSON.stringify({ name: 'Workflow ten dollars', code: 'WORKFLOW10', discount_type: 'fixed', amount_cents: 1000, usage_limit: 1, min_quantity: 1 })
  });
  assert.equal(discount.response.status, 201);
  const discountedSubscription = await request('/api/subscriptions', {
    method: 'POST',
    body: JSON.stringify({ customer_id: customerResponse.payload.id, plan_id: brandPlan.payload.id, discount_code: 'WORKFLOW10' })
  });
  assert.equal(discountedSubscription.response.status, 201);
  assert.equal(discountedSubscription.payload.invoice.subtotal_cents, 66000);
  assert.equal(discountedSubscription.payload.invoice.discount_cents, 1000);
  assert.equal((await request('/api/discounts')).payload[0].usage_count, 1);

  const secondUse = await request('/api/subscriptions', {
    method: 'POST',
    body: JSON.stringify({ customer_id: customerResponse.payload.id, plan_id: brandPlan.payload.id, discount_code: 'WORKFLOW10' })
  });
  assert.equal(secondUse.response.status, 201);
  assert.equal(secondUse.payload.invoice.discount_cents, 0);

  const template = await request('/api/quote-templates', {
    method: 'POST',
    body: JSON.stringify({ name: 'Workflow quote', plan_id: plan.id, validity_days: 14, product_lines: [] })
  });
  assert.equal(template.response.status, 201);
  const quote = await request('/api/subscriptions', {
    method: 'POST',
    body: JSON.stringify({ customer_id: customerResponse.payload.id, template_id: template.payload.id })
  });
  assert.equal(quote.response.status, 201, JSON.stringify(quote.payload));
  assert.equal(quote.payload.subscription.workflow_status, 'quotation');
  assert.equal(quote.payload.invoice, null);
  assert.equal((await request(`/api/subscriptions/${quote.payload.subscription.id}/status`, {
    method: 'PATCH', body: JSON.stringify({ status: 'confirmed' })
  })).payload.workflow_status, 'confirmed');
  const activatedQuote = await request(`/api/subscriptions/${quote.payload.subscription.id}/status`, {
    method: 'PATCH', body: JSON.stringify({ status: 'active' })
  });
  assert.equal(activatedQuote.payload.workflow_status, 'active');
  assert.equal((await request('/api/portal/subscriptions', {}, customerCookie)).payload.length, 4);

  const created = await request('/api/subscriptions', {
    method: 'POST',
    body: JSON.stringify({ customer_id: customerResponse.payload.id, plan_id: plan.id })
  });
  assert.equal(created.response.status, 201);
  const invoice = created.payload.invoice;
  const planDiscount = Math.round(plan.price_cents * plan.discount_percent / 100);
  const tax = Math.round((plan.price_cents - planDiscount) * plan.tax_percent / 100);
  assert.equal(invoice.total_cents, plan.price_cents - planDiscount + tax);
  assert.equal(invoice.status, 'open');
  assert.equal((await request(`/api/portal/invoices/${invoice.id}`, {}, customerCookie)).response.status, 200);
  const duplicateDraft = await request('/api/invoices', {
    method: 'POST',
    body: JSON.stringify({ subscription_id: created.payload.subscription.id, period_start: invoice.period_start })
  });
  assert.equal(duplicateDraft.response.status, 409);

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
  assert.equal(dashboard.payload.active_subscriptions, 4);
  const mrrBeforeYearly = dashboard.payload.mrr_cents;
  const yearlySubscription = await request('/api/subscriptions', {
    method: 'POST',
    body: JSON.stringify({ customer_id: customerResponse.payload.id, plan_id: datePlans[3].id, quantity: 3 })
  });
  assert.equal(yearlySubscription.response.status, 201);
  const dashboardWithYearly = await request('/api/dashboard');
  assert.equal(dashboardWithYearly.payload.mrr_cents - mrrBeforeYearly, 1250);
  assert.equal(dashboardWithYearly.payload.active_subscriptions, 5);

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

  const draftInvoice = await request('/api/invoices', {
    method: 'POST',
    body: JSON.stringify({ subscription_id: discountedSubscription.payload.subscription.id, period_start: '2021-01-01T00:00:00.000Z', period_end: '2021-02-01T00:00:00.000Z' })
  });
  assert.equal(draftInvoice.payload.document_status, 'draft');
  const confirmedInvoice = await request(`/api/invoices/${draftInvoice.payload.id}/status`, {
    method: 'PATCH', body: JSON.stringify({ action: 'confirm' })
  });
  assert.equal(confirmedInvoice.payload.document_status, 'confirmed');
  const sendWithoutSmtp = await request(`/api/invoices/${draftInvoice.payload.id}/status`, {
    method: 'PATCH', body: JSON.stringify({ action: 'send' })
  });
  assert.equal(sendWithoutSmtp.response.status, 503);
  const canceledInvoice = await request(`/api/invoices/${draftInvoice.payload.id}/status`, {
    method: 'PATCH', body: JSON.stringify({ action: 'cancel' })
  });
  assert.equal(canceledInvoice.payload.document_status, 'canceled');

  const billingSubscription = await request('/api/subscriptions', {
    method: 'POST',
    body: JSON.stringify({ customer_id: customerResponse.payload.id, plan_id: datePlans[2].id })
  });
  const dbHandle = new DatabaseSync(path.join(directory, 'test.sqlite'));
  const dueStart = new Date(Date.now() - 3 * 31 * 86400000);
  dbHandle.prepare('UPDATE subscriptions SET next_billing_at = ? WHERE id = ?').run(dueStart.toISOString(), billingSubscription.payload.subscription.id);
  dbHandle.close();
  const billingRun = await request('/api/billing/run-due', { method: 'POST', body: '{}' });
  assert.ok(billingRun.payload.invoices_created >= 3);
  const invoiceCountAfterBilling = (await request('/api/invoices')).payload.filter((item) => item.subscription_id === billingSubscription.payload.subscription.id).length;
  assert.equal((await request('/api/billing/run-due', { method: 'POST', body: '{}' })).payload.invoices_created, 0);
  const invoiceCountAfterRepeat = (await request('/api/invoices')).payload.filter((item) => item.subscription_id === billingSubscription.payload.subscription.id).length;
  assert.equal(invoiceCountAfterRepeat, invoiceCountAfterBilling);

  const stopped = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await stopped;
  child = startServer();
  let restarted = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) assert.fail(`Brightloop failed to restart: ${serverOutput}`);
    try {
      if ((await fetch(`${baseUrl}/api/auth/session`)).ok) {
        restarted = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(restarted, true, 'the persisted database should restart successfully');
  assert.equal((await request('/api/customers', {}, cookie)).response.status, 200, 'SQLite-backed admin sessions should survive a server restart');
  const persistedAdmin = await signIn('admin@test.local', 'WorkflowTest123!');
  assert.equal(persistedAdmin.response.status, 200);
  const persistedCustomers = await request('/api/customers', {}, persistedAdmin.cookie);
  assert.ok(persistedCustomers.payload.some((item) => item.email === 'workflow@example.com'));
  const persistedInvoices = await request('/api/invoices', {}, persistedAdmin.cookie);
  assert.ok(persistedInvoices.payload.some((item) => item.invoice_number === invoice.invoice_number));
});

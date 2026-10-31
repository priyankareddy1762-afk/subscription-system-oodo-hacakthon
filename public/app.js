const state = { view: 'dashboard', email: '', role: '', customers: [], catalog: { products: [], variants: [], plans: [] }, subscriptions: [], invoices: [], payments: [], dashboard: null, dashboardFilters: {} };
const root = document.getElementById('viewRoot');
const modalRoot = document.getElementById('modalRoot');
const titles = { dashboard: 'Overview', customers: 'Customers', catalog: 'Products & plans', subscriptions: 'Subscriptions', invoices: 'Invoices', payments: 'Payments', discounts: 'Discounts', staff: 'Team access', 'portal-dashboard': 'My account', 'portal-subscriptions': 'My subscriptions', 'portal-invoices': 'My invoices' };

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const money = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((Number(cents) || 0) / 100);
const shortDate = (value) => value ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(value)) : '—';
const initials = (value) => String(value || '?').trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
const statusBadge = (status) => `<span class="status status-${escapeHtml(status)}">${escapeHtml(status)}</span>`;

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status}).`);
  return data;
}

function toast(message, error = false) {
  const item = document.createElement('div');
  item.className = `toast${error ? ' error' : ''}`;
  item.textContent = message;
  document.getElementById('toastRoot').append(item);
  setTimeout(() => item.remove(), 3500);
}

function setAuthenticated(email, role = '') {
  state.email = email || '';
  state.role = email ? role : '';
  document.getElementById('adminEmail').textContent = state.email;
  document.getElementById('loginScreen').hidden = Boolean(email);
  document.getElementById('appShell').hidden = !email;
  document.querySelectorAll('.admin-only').forEach((item) => { item.hidden = state.role !== 'admin'; });
  document.querySelectorAll('.customer-only').forEach((item) => { item.hidden = state.role !== 'customer'; });
  document.querySelectorAll('.main-nav > .nav-link:not(.admin-only):not(.customer-only)').forEach((item) => { item.hidden = state.role === 'customer'; });
  document.querySelector('.profile-text strong').textContent = state.role ? `${state.role[0].toUpperCase()}${state.role.slice(1)} account` : 'Brightloop';
  if (email) {
    state.view = state.role === 'customer' ? 'portal-dashboard' : 'dashboard';
    navigate(state.view);
  }
}

function updateHeader(view) {
  state.view = view;
  state.tablePage = 1;
  document.getElementById('currentPageName').textContent = titles[view] || 'Overview';
  document.querySelectorAll('.nav-link').forEach((link) => link.classList.toggle('active', link.dataset.view === view));
  document.getElementById('sidebar').classList.remove('open');
  root.focus({ preventScroll: true });
}

async function navigate(view) {
  updateHeader(view);
  const search = document.getElementById('globalSearch');
  search.value = '';
  root.setAttribute('aria-busy', 'true');
  root.innerHTML = `<div class="loading-state" aria-label="Loading page"><div class="skeleton" style="width:145px;margin-bottom:12px"></div><div class="skeleton" style="width:230px;height:28px;margin-bottom:9px"></div><div class="skeleton" style="width:310px;margin-bottom:24px"></div><section class="metrics-grid"><div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div></section><div class="panel skeleton-card" style="height:230px;margin-top:16px"></div></div>`;
  try {
    if (view === 'dashboard') await renderDashboard();
    else if (view === 'customers') await renderCustomers();
    else if (view === 'catalog') await renderCatalog();
    else if (view === 'subscriptions') await renderSubscriptions();
    else if (view === 'invoices') await renderInvoices();
    else if (view === 'payments') await renderPayments();
    else if (view === 'discounts') await renderDiscounts();
    else if (view === 'staff') await renderStaff();
    else if (view.startsWith('portal-')) await renderCustomerPortal(view);
  } catch (error) {
    root.innerHTML = `<section class="panel empty-state"><strong>Couldn't load this page</strong>${escapeHtml(error.message)}<br><button class="button button-secondary" data-action="retry-view" style="margin-top:14px">Try again</button></section>`;
  } finally {
    root.removeAttribute('aria-busy');
  }
}

function pageHeading(kicker, title, description, buttonLabel, action) {
  return `<div class="page-heading"><div><div class="eyebrow">${escapeHtml(kicker)}</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div>${buttonLabel ? `<button class="button button-primary" data-action="${escapeHtml(action)}"><span>＋</span>${escapeHtml(buttonLabel)}</button>` : ''}</div>`;
}

function tableEmpty(message, columns) {
  return `<tr><td colspan="${columns}" class="empty-state">${escapeHtml(message)}</td></tr>`;
}

function tablePanel(title, subtitle, headers, rows, tools = '') {
  return `<section class="panel table-panel"><div class="panel-head"><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(subtitle)}</p></div>${tools}</div><div class="table-scroll"><table><thead><tr>${headers.map((header, index) => `<th>${header ? `<button class="sort-button" data-sort-column="${index}" type="button">${escapeHtml(header)} <span aria-hidden="true">↕</span></button>` : ''}</th>`).join('')}</tr></thead><tbody>${rows || tableEmpty('Nothing here yet. Create your first record to get started.', headers.length)}</tbody></table></div><div class="pagination"></div></section>`;
}

async function renderDashboard() {
  const search = new URLSearchParams(state.dashboardFilters);
  const data = await api(`/api/dashboard${search.size ? `?${search}` : ''}`);
  state.dashboard = data;
  const recent = data.recent_invoices.map((invoice) => `<tr><td><strong>${escapeHtml(invoice.invoice_number)}</strong><span class="cell-subtitle">${shortDate(invoice.issued_at)}</span></td><td>${escapeHtml(invoice.customer_name)}</td><td><strong>${money(invoice.total_cents)}</strong></td><td>${statusBadge(invoice.status)}</td><td><button class="action-button" data-action="view-invoice" data-id="${invoice.id}">View</button></td></tr>`).join('');
  const max = Math.max(1, ...data.monthly_revenue.map((item) => Number(item.total)));
  const bars = data.monthly_revenue.length ? data.monthly_revenue.map((item) => {
    const height = Math.max(5, Math.round(Number(item.total) / max * 100));
    const month = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(new Date(`${item.month}-01T00:00:00Z`));
    return `<div class="chart-column" title="${escapeHtml(month)}: ${money(item.total)}"><div class="chart-bar" style="height:${height}%"></div><span>${escapeHtml(month)}</span></div>`;
  }).join('') : '<div class="chart-empty">Payments will appear here as you record them.</div>';
  const maxSubscriptions = Math.max(1, ...data.monthly_subscriptions.map((item) => Number(item.total)));
  const subscriptionBars = data.monthly_subscriptions.length ? data.monthly_subscriptions.map((item) => {
    const height = Math.max(5, Math.round(Number(item.total) / maxSubscriptions * 100));
    const month = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(new Date(`${item.month}-01T00:00:00Z`));
    return `<div class="chart-column" title="${escapeHtml(month)}: ${item.total} subscriptions"><div class="chart-bar subscription-bar" style="height:${height}%"></div><span>${escapeHtml(month)}</span></div>`;
  }).join('') : '<div class="chart-empty">New subscriptions will appear here.</div>';
  root.innerHTML = `
    ${pageHeading('YOUR BUSINESS AT A GLANCE', 'Welcome back 👋', 'Here’s what’s happening with your subscriptions today.', 'New subscription', 'new-subscription')}
    <div class="report-filters"><span>Revenue period</span><input type="date" id="reportFrom" aria-label="Revenue start date"><span>to</span><input type="date" id="reportTo" aria-label="Revenue end date"><button class="button button-secondary button-small" data-action="filter-dashboard">Apply</button><button class="plain-link" data-action="clear-dashboard-filter">Reset</button></div>
    <section class="metrics-grid">
      <article class="metric-card"><div class="metric-top">Total revenue <span class="metric-icon">↗</span></div><div class="metric-value">${money(data.revenue_cents)}</div><div class="metric-note">Collected payments to date</div></article>
      <article class="metric-card"><div class="metric-top">Monthly recurring revenue <span class="metric-icon green">⟳</span></div><div class="metric-value">${money(data.mrr_cents)}</div><div class="metric-note">From active subscriptions</div></article>
      <article class="metric-card"><div class="metric-top">Active subscriptions <span class="metric-icon amber">▤</span></div><div class="metric-value">${data.active_subscriptions}</div><div class="metric-note">Currently generating revenue</div></article>
      <article class="metric-card"><div class="metric-top">Outstanding invoices <span class="metric-icon red">!</span></div><div class="metric-value">${money(data.outstanding_cents)}</div><div class="metric-note">${data.overdue_count} overdue · ${data.outstanding_count} unpaid invoices</div></article>
    </section>
    <div class="dashboard-grid">
      <section class="panel"><div class="panel-head"><div><h2>Revenue over time</h2><p>Payments recorded in the last six months</p></div><span class="metric-icon green">↗</span></div><div class="chart-wrap"><div class="chart">${bars}</div></div></section>
      <section class="panel"><div class="panel-head"><div><h2>Subscription growth</h2><p>New subscriptions in the last six months</p></div><span class="metric-icon">⟳</span></div><div class="chart-wrap"><div class="chart">${subscriptionBars}</div></div></section>
      <section class="panel"><div class="panel-head"><div><h2>At a glance</h2><p>Your billing activity</p></div></div><div class="quick-stats">
        <div class="quick-row"><span class="quick-label"><i class="quick-dot green"></i>Active subscriptions</span><strong>${data.active_subscriptions}</strong></div>
        <div class="quick-row"><span class="quick-label"><i class="quick-dot amber"></i>Overdue invoices</span><strong>${data.overdue_count}</strong></div>
        <div class="quick-row"><span class="quick-label"><i class="quick-dot"></i>Overdue amount</span><strong>${money(data.overdue_cents)}</strong></div>
        <div class="quick-row"><span class="quick-label"><i class="quick-dot red"></i>Total collected</span><strong>${money(data.revenue_cents)}</strong></div>
      </div></section>
    </div>
    ${tablePanel('Recent invoices', 'Your latest billing activity', ['Invoice', 'Customer', 'Amount', 'Status', ''], recent, '<button class="plain-link" data-view="invoices">All invoices →</button>')}`;
  root.querySelectorAll('[data-view="invoices"]').forEach((item) => item.addEventListener('click', () => navigate('invoices')));
  document.getElementById('reportFrom').value = state.dashboardFilters.from || '';
  document.getElementById('reportTo').value = state.dashboardFilters.to || '';
  const overdueNav = document.getElementById('overdueNavCount');
  overdueNav.textContent = data.overdue_count;
  overdueNav.hidden = data.overdue_count === 0;
  document.getElementById('notificationDot').hidden = data.overdue_count === 0 || state.role === 'customer';
  document.getElementById('notificationButton').hidden = state.role === 'customer';
}

async function renderCustomers() {
  state.customers = await api('/api/customers');
  const rows = state.customers.map((customer) => `<tr><td><div class="cell-primary"><span class="mini-avatar">${escapeHtml(initials(customer.name))}</span><span><strong>${escapeHtml(customer.name)}</strong><span class="cell-subtitle">${escapeHtml(customer.company || 'Individual')}</span></span></div></td><td>${escapeHtml(customer.email)}</td><td>${escapeHtml(customer.phone || '—')}</td><td>${customer.subscription_count}</td><td>${shortDate(customer.created_at)}</td><td><button class="action-button" data-action="edit-customer" data-id="${customer.id}">Edit</button></td></tr>`).join('');
  root.innerHTML = `${pageHeading('RELATIONSHIPS', 'Customers', 'Keep your customer details organized in one place.', 'Add customer', 'new-customer')}${tablePanel('All customers', `${state.customers.length} customer${state.customers.length === 1 ? '' : 's'} in your workspace`, ['Customer', 'Email', 'Phone', 'Subscriptions', 'Added', ''], rows, '<input class="search-input" data-search placeholder="Search customers…" aria-label="Search customers">')}`;
  addTableSearch('customers');
}

async function renderCatalog() {
  state.catalog = await api('/api/catalog');
  const admin = state.role === 'admin';
  const products = state.catalog.products.map((item) => `<div class="list-row"><div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.product_type)} · ${money(item.selling_price_cents)} · cost ${money(item.cost_price_cents)} · ${escapeHtml(item.description || item.notes || 'No notes')}</span></div>${admin ? `<div class="row-actions"><button class="action-button" data-action="edit-product" data-id="${item.id}">Edit</button><button class="action-button" data-action="delete-product" data-id="${item.id}">Delete</button><button class="action-button" data-action="new-variant" data-product-id="${item.id}">＋ Variant</button></div>` : ''}</div>`).join('');
  const variants = state.catalog.variants.map((item) => `<div class="list-row"><div><strong>${escapeHtml(item.product_name)} · ${escapeHtml(item.name)}</strong><span>SKU ${escapeHtml(item.sku)}${item.brand ? ` · ${escapeHtml(item.brand)} (+$560)` : ''}</span></div>${admin ? `<div class="row-actions"><button class="action-button" data-action="edit-variant" data-id="${item.id}">Edit</button><button class="action-button" data-action="delete-variant" data-id="${item.id}">Delete</button></div>` : ''}</div>`).join('');
  const plans = state.catalog.plans.map((item) => `<div class="list-row"><div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.product_name)} · ${escapeHtml(item.variant_name)} · ${escapeHtml(item.interval)} · min ${item.min_quantity} · ${item.tax_percent}% tax${item.discount_percent ? ` · ${item.discount_percent}% plan discount` : ''}${item.auto_close ? ' · auto-close' : ''}</span></div><div class="row-actions"><span class="list-price">${money(item.price_cents)} / ${escapeHtml(item.interval)}</span>${admin ? `<button class="action-button" data-action="edit-plan" data-id="${item.id}">Edit</button><button class="action-button" data-action="delete-plan" data-id="${item.id}">Delete</button>` : ''}</div></div>`).join('');
  const templates = await api('/api/quote-templates');
  state.quoteTemplates = templates;
  const templateRows = templates.map((item) => `<div class="list-row"><div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.validity_days)} day quote · ${escapeHtml(state.catalog.plans.find((plan) => plan.id === item.plan_id)?.name || 'Plan')} · ${item.product_lines.length} add-on lines</span></div><div class="row-actions"><button class="action-button" data-action="create-quote" data-id="${item.id}">Create quote</button>${admin ? `<button class="action-button" data-action="edit-template" data-id="${item.id}">Edit</button><button class="action-button button-danger" data-action="delete-template" data-id="${item.id}">Delete</button>` : ''}</div></div>`).join('');
  root.innerHTML = `${pageHeading('YOUR OFFERING', 'Products & plans', 'Build the catalog customers can subscribe to.', admin ? 'Add product' : '', 'new-product')}
    <div class="catalog-grid">
      <section class="panel catalog-card"><div class="panel-head"><div><h2>Products</h2><p>${state.catalog.products.length} products</p></div></div>${products || '<div class="empty-state">No products yet.</div>'}</section>
      <section class="panel catalog-card"><div class="panel-head"><div><h2>Variants</h2><p>Brand variants add $560 to base plan price</p></div>${admin ? '<button class="button button-secondary button-small" data-action="new-variant">＋ Add</button>' : ''}</div>${variants || '<div class="empty-state">Add a product variant to continue.</div>'}</section>
      <section class="panel catalog-card full"><div class="panel-head"><div><h2>Subscription plans</h2><p>Daily, weekly, monthly and yearly billing with availability rules</p></div>${admin ? '<button class="button button-secondary button-small" data-action="new-plan">＋ Add plan</button>' : ''}</div>${plans || '<div class="empty-state">Add a variant, then create your first plan.</div>'}</section>
      <section class="panel catalog-card full"><div class="panel-head"><div><h2>Quote templates</h2><p>Reusable plan and product quote layouts with validity periods</p></div>${admin ? '<button class="button button-secondary button-small" data-action="new-template">＋ Add template</button>' : ''}</div>${templateRows || '<div class="empty-state">Create a quote template to speed up sales.</div>'}</section>
    </div>`;
}

async function renderSubscriptions() {
  state.subscriptions = await api('/api/subscriptions');
  const rows = state.subscriptions.map((sub) => {
    let actions = sub.status === 'active' && sub.workflow_status === 'active'
      ? `<button class="action-button" data-action="renew-subscription" data-id="${sub.id}">Renew</button>`
      : '';
    if (sub.status === 'active') actions += `<button class="action-button" data-action="subscription-status" data-status="paused" data-id="${sub.id}">Pause</button>`;
    if (sub.status === 'paused') actions += `<button class="action-button" data-action="subscription-status" data-status="active" data-id="${sub.id}">Resume</button>`;
    if (sub.status !== 'canceled') actions += `<button class="action-button button-danger" data-action="subscription-status" data-status="canceled" data-id="${sub.id}">Close</button>`;
    if (sub.workflow_status === 'draft') actions = `<button class="action-button" data-action="subscription-status" data-status="quotation" data-id="${sub.id}">Prepare quote</button>`;
    if (sub.workflow_status === 'quotation') actions = `<button class="action-button" data-action="subscription-status" data-status="confirmed" data-id="${sub.id}">Confirm quote</button>`;
    if (sub.workflow_status === 'confirmed') actions = `<button class="action-button" data-action="subscription-status" data-status="active" data-id="${sub.id}">Activate</button>`;
    const displayStatus = sub.status === 'paused' ? 'paused' : (sub.status === 'canceled' ? 'closed' : sub.workflow_status);
    if (sub.status === 'active' && sub.workflow_status === 'active') actions += `<button class="action-button" data-action="create-draft-invoice" data-id="${sub.id}">Draft invoice</button>`;
    return `<tr><td><strong>${escapeHtml(sub.subscription_number || `SUB-${String(sub.id).padStart(6, '0')}`)}</strong><span class="cell-subtitle">${escapeHtml(sub.product_name)} · ${escapeHtml(sub.variant_name)}</span></td><td><strong>${escapeHtml(sub.customer_name)}</strong><span class="cell-subtitle">${escapeHtml(sub.customer_email)}</span></td><td>${escapeHtml(sub.plan_name)}<span class="cell-subtitle">${escapeHtml(sub.interval)}</span></td><td><strong>${money(sub.price_cents)}</strong><span class="cell-subtitle">per ${escapeHtml(sub.interval)}</span></td><td>${statusBadge(displayStatus)}</td><td>${shortDate(sub.next_billing_at)}</td><td><div class="row-actions">${actions}</div></td></tr>`;
  }).join('');
  root.innerHTML = `${pageHeading('RECURRING REVENUE', 'Subscriptions', 'Create, renew, pause or close a customer subscription.', 'New subscription', 'new-subscription')}${tablePanel('All subscriptions', `${state.subscriptions.length} subscription${state.subscriptions.length === 1 ? '' : 's'}`, ['Subscription', 'Customer', 'Plan', 'Price', 'Status', 'Next billing', 'Actions'], rows, '<input class="search-input" data-search placeholder="Search subscriptions…" aria-label="Search subscriptions">')}`;
  addTableSearch('subscriptions');
}

async function renderInvoices() {
  state.invoices = await api('/api/invoices');
  const overdueCount = state.invoices.filter((invoice) => invoice.status === 'overdue').length;
  const overdueBalance = state.invoices.filter((invoice) => invoice.status === 'overdue').reduce((sum, invoice) => sum + invoice.total_cents - invoice.paid_cents, 0);
  const rows = state.invoices.map((invoice) => `<tr><td><strong>${escapeHtml(invoice.invoice_number)}</strong><span class="cell-subtitle">${escapeHtml(invoice.document_status)} · ${escapeHtml(invoice.period_start?.slice(0, 10) || '')}</span></td><td><strong>${escapeHtml(invoice.customer_name)}</strong><span class="cell-subtitle">${escapeHtml(invoice.customer_email)}</span></td><td>${shortDate(invoice.issued_at)}</td><td>${shortDate(invoice.due_at)}</td><td><strong>${money(invoice.total_cents)}</strong><span class="cell-subtitle">${invoice.paid_cents ? `${money(invoice.paid_cents)} paid` : ''}</span></td><td>${statusBadge(invoice.document_status === 'canceled' ? 'canceled' : invoice.status)}</td><td><div class="row-actions"><button class="action-button" data-action="view-invoice" data-id="${invoice.id}">View</button>${invoice.document_status === 'draft' ? `<button class="action-button" data-action="confirm-invoice" data-id="${invoice.id}">Confirm</button>` : ''}${invoice.document_status !== 'canceled' && invoice.status !== 'paid' ? `<button class="action-button" data-action="pay-invoice" data-id="${invoice.id}">Payment</button><button class="action-button" data-action="send-invoice" data-id="${invoice.id}">Send</button><button class="action-button button-danger" data-action="cancel-invoice" data-id="${invoice.id}">Cancel</button>` : ''}</div></td></tr>`).join('');
  root.innerHTML = `${pageHeading('BILLING', 'Invoices', 'Review generated invoices and follow up on balances.', '', '')}${overdueCount ? `<div class="overdue-banner"><strong>${overdueCount} overdue ${overdueCount === 1 ? 'invoice' : 'invoices'}</strong><span>·</span>${money(overdueBalance)} outstanding</div>` : ''}${tablePanel('All invoices', `${state.invoices.length} invoice${state.invoices.length === 1 ? '' : 's'} generated`, ['Invoice', 'Customer', 'Issued', 'Due date', 'Total', 'Status', 'Actions'], rows, '<input class="search-input" data-search placeholder="Search invoices…" aria-label="Search invoices">')}`;
  addTableSearch('invoices');
}

async function renderPayments() {
  state.payments = await api('/api/payments');
  const collected = state.payments.reduce((sum, payment) => sum + payment.amount_cents, 0);
  const rows = state.payments.map((payment) => `<tr><td><strong>PAY-${String(payment.id).padStart(5, '0')}</strong><span class="cell-subtitle">${escapeHtml(payment.reference)}</span></td><td>${escapeHtml(payment.customer_name)}</td><td><button class="action-button" data-action="view-invoice" data-id="${payment.invoice_id}">${escapeHtml(payment.invoice_number)}</button></td><td><strong>${money(payment.amount_cents)}</strong></td><td>${escapeHtml(payment.method)}</td><td>${shortDate(payment.recorded_at)}</td></tr>`).join('');
  root.innerHTML = `${pageHeading('CASH FLOW', 'Payments', 'Every payment recorded against an invoice.', '', '')}<section class="metrics-grid" style="grid-template-columns:repeat(2,minmax(0,1fr));max-width:620px;margin-bottom:18px"><article class="metric-card"><div class="metric-top">Payments recorded <span class="metric-icon green">✓</span></div><div class="metric-value">${state.payments.length}</div><div class="metric-note">Successful manual entries</div></article><article class="metric-card"><div class="metric-top">Total collected <span class="metric-icon">＄</span></div><div class="metric-value">${money(collected)}</div><div class="metric-note">Across all invoices</div></article></section>${tablePanel('Payment history', 'Payments are recorded directly against invoices', ['Payment', 'Customer', 'Invoice', 'Amount', 'Method', 'Date'], rows, '<input class="search-input" data-search placeholder="Search payments…" aria-label="Search payments">')}`;
  addTableSearch('payments');
}

async function renderDiscounts() {
  const discounts = await api('/api/discounts');
  state.discounts = discounts;
  const rows = discounts.map((discount) => `<tr><td><strong>${escapeHtml(discount.name)}</strong><span class="cell-subtitle">${escapeHtml(discount.code)}</span></td><td>${escapeHtml(discount.discount_type === 'percent' ? `${discount.amount}%` : money(discount.amount))}</td><td>${money(discount.min_purchase_cents)} · ${discount.min_quantity} item(s)</td><td>${discount.usage_count}${discount.usage_limit ? ` / ${discount.usage_limit}` : ' / unlimited'}</td><td>${discount.expires_at ? shortDate(discount.expires_at) : 'No expiry'}</td><td>${statusBadge(discount.active && (!discount.expires_at || new Date(discount.expires_at) >= new Date()) && (!discount.usage_limit || discount.usage_count < discount.usage_limit) ? 'active' : 'expired')}</td><td><div class="row-actions"><button class="action-button" data-action="edit-discount" data-id="${discount.id}">Edit</button><button class="action-button button-danger" data-action="delete-discount" data-id="${discount.id}">Delete</button></div></td></tr>`).join('');
  root.innerHTML = `${pageHeading('PROMOTIONS', 'Discounts', 'Set up discounts with eligibility, validity and usage limits.', 'Create discount', 'new-discount')}${tablePanel('Discount codes', `${discounts.length} discount${discounts.length === 1 ? '' : 's'}`, ['Discount', 'Value', 'Conditions', 'Usage', 'Expires', 'Status', 'Actions'], rows, '<input class="search-input" data-search placeholder="Search discounts…" aria-label="Search discounts">')}`;
  addTableSearch('discounts');
}

async function renderStaff() {
  const staff = await api('/api/staff');
  const rows = staff.map((member) => `<tr><td><strong>${escapeHtml(member.email)}</strong></td><td>${shortDate(member.created_at)}</td><td>${statusBadge('active')}</td></tr>`).join('');
  root.innerHTML = `${pageHeading('WORKSPACE ACCESS', 'Team access', 'Only admins can create staff accounts. Staff cannot manage users, catalog, or discount rules.', 'Invite staff', 'new-staff')}${tablePanel('Staff accounts', `${staff.length} team member${staff.length === 1 ? '' : 's'}`, ['Email', 'Added', 'Status'], rows)}`;
}

async function renderCustomerPortal(view) {
  const [profile, subscriptions, invoices] = await Promise.all([
    api('/api/portal/profile'), api('/api/portal/subscriptions'), api('/api/portal/invoices')
  ]);
  const page = view === 'portal-invoices' ? 'invoices' : (view === 'portal-subscriptions' ? 'subscriptions' : 'dashboard');
  const heading = page === 'invoices' ? 'Your invoices' : page === 'subscriptions' ? 'Your subscriptions' : `Welcome, ${profile.name.split(' ')[0]}`;
  const recent = invoices.map((invoice) => `<tr><td><strong>${escapeHtml(invoice.invoice_number)}</strong></td><td>${shortDate(invoice.issued_at)}</td><td>${shortDate(invoice.due_at)}</td><td><strong>${money(invoice.total_cents)}</strong></td><td>${money(invoice.paid_cents)} paid</td><td>${statusBadge(invoice.status)}</td><td><button class="action-button" data-action="view-portal-invoice" data-id="${invoice.id}">Details</button></td></tr>`).join('');
  const subs = subscriptions.map((sub) => `<tr><td><strong>${escapeHtml(sub.subscription_number)}</strong></td><td>${escapeHtml(sub.product_name)} · ${escapeHtml(sub.variant_name)}</td><td>${escapeHtml(sub.plan_name)}</td><td>${money(sub.price_cents)} / ${escapeHtml(sub.billing_interval)}</td><td>${statusBadge(sub.status === 'paused' ? 'paused' : sub.workflow_status)}</td><td>${shortDate(sub.next_billing_at)}</td></tr>`).join('');
  root.innerHTML = `${pageHeading('CUSTOMER PORTAL', heading, 'Your subscriptions and billing, all in one place.', '', '')}${page === 'dashboard' ? `<section class="metrics-grid"><article class="metric-card"><div class="metric-top">Subscriptions <span class="metric-icon">⟳</span></div><div class="metric-value">${subscriptions.length}</div><div class="metric-note">Your subscription history</div></article><article class="metric-card"><div class="metric-top">Invoices <span class="metric-icon green">▤</span></div><div class="metric-value">${invoices.length}</div><div class="metric-note">${money(invoices.reduce((sum, invoice) => sum + invoice.total_cents - invoice.paid_cents, 0))} outstanding</div></article></section>` : ''}${page !== 'invoices' ? tablePanel('Your subscriptions', 'Only subscriptions linked to your account', ['Subscription', 'Product', 'Plan', 'Price', 'Status', 'Next billing'], subs) : ''}${page !== 'subscriptions' ? tablePanel('Your invoices', 'Only invoices linked to your account', ['Invoice', 'Issued', 'Due', 'Total', 'Paid', 'Status', ''], recent) : ''}`;
}

function addTableSearch(type) {
  const search = root.querySelector('[data-search]');
  if (!search) return;
  search.addEventListener('input', () => filterCurrentPage(type));
  addTablePagination();
  addTablePagination();
}

function addTablePagination() {
  const table = root.querySelector('.table-panel table');
  const pager = root.querySelector('.table-panel .pagination');
  if (!table || !pager) return;
  const allRows = [...table.querySelectorAll('tbody tr')].filter((row) => !row.classList.contains('search-empty'));
  const visibleRows = allRows.filter((row) => row.dataset.filterHidden !== 'true');
  const perPage = 10;
  const pages = Math.max(1, Math.ceil(visibleRows.length / perPage));
  state.tablePage = Math.min(state.tablePage || 1, pages);
  visibleRows.forEach((row, index) => { row.hidden = index < (state.tablePage - 1) * perPage || index >= state.tablePage * perPage; });
  pager.innerHTML = `<span>Page ${state.tablePage} of ${pages} · ${visibleRows.length} records</span><div><button class="button button-secondary button-small" data-action="table-page" data-page="${Math.max(1, state.tablePage - 1)}" ${state.tablePage === 1 ? 'disabled' : ''}>Previous</button><button class="button button-secondary button-small" data-action="table-page" data-page="${Math.min(pages, state.tablePage + 1)}" ${state.tablePage === pages ? 'disabled' : ''}>Next</button></div>`;
  allRows.filter((row) => row.dataset.filterHidden === 'true').forEach((row) => { row.hidden = true; });
}

function filterCurrentPage(type = 'records') {
  const globalQuery = globalSearch.value.trim().toLowerCase();
  const localQuery = root.querySelector('[data-search]')?.value.trim().toLowerCase() || '';
  const query = [globalQuery, localQuery].filter(Boolean).join(' ');
  const rows = [...root.querySelectorAll('tbody tr')].filter((row) => !row.classList.contains('search-empty'));
  rows.forEach((row) => {
    row.dataset.filterHidden = Boolean(query) && !row.textContent.toLowerCase().includes(query) ? 'true' : '';
  });
  const items = [...root.querySelectorAll('.list-row')];
  items.forEach((item) => { item.hidden = Boolean(globalQuery) && !item.textContent.toLowerCase().includes(globalQuery); });
  const visible = rows.some((row) => row.dataset.filterHidden !== 'true');
  let empty = root.querySelector('.search-empty');
  if (rows.length && !visible && !empty) {
    empty = document.createElement('tr');
    empty.className = 'search-empty';
    const label = type === 'records' ? titles[state.view].toLowerCase() : type;
    empty.innerHTML = `<td colspan="${root.querySelectorAll('thead th').length}" class="empty-state">No ${escapeHtml(label)} match your search.</td>`;
    root.querySelector('tbody').append(empty);
  } else if ((visible || !query) && empty) empty.remove();
}

function showModal(title, subtitle, body) {
  modalRoot.innerHTML = `<div class="modal-backdrop" data-action="backdrop-close"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle"><header class="modal-head"><div><h2 id="modalTitle">${escapeHtml(title)}</h2><p>${escapeHtml(subtitle)}</p></div><button class="modal-close" data-action="close-modal" aria-label="Close dialog">×</button></header><div class="modal-body">${body}</div></section></div>`;
  modalRoot.querySelector('.modal').addEventListener('click', (event) => event.stopPropagation());
  modalRoot.querySelector('input,select,button')?.focus();
}

function formField(label, name, type = 'text', options = {}) {
  const required = options.required === false ? '' : 'required';
  const value = options.value !== undefined ? ` value="${escapeHtml(options.value)}"` : '';
  if (type === 'select') {
    const choices = options.choices || [];
    return `<label>${escapeHtml(label)}<select name="${escapeHtml(name)}" ${required}>${options.placeholder ? '<option value="">Choose…</option>' : ''}${choices.map((choice) => `<option value="${escapeHtml(choice.value)}"${String(choice.value) === String(options.selected ?? '') ? ' selected' : ''}>${escapeHtml(choice.label)}</option>`).join('')}</select></label>`;
  }
  if (type === 'textarea') return `<label>${escapeHtml(label)}<textarea name="${escapeHtml(name)}" ${required}>${escapeHtml(options.value || '')}</textarea></label>`;
  return `<label>${escapeHtml(label)}<input name="${escapeHtml(name)}" type="${type}"${value} ${required}${options.min !== undefined ? ` min="${options.min}"` : ''}${options.max !== undefined ? ` max="${options.max}"` : ''}${options.step ? ` step="${options.step}"` : ''}${options.placeholder ? ` placeholder="${escapeHtml(options.placeholder)}"` : ''}></label>`;
}

function showForm(title, subtitle, action, fields, submitLabel) {
  showModal(title, subtitle, `<form class="form-stack" data-form-action="${escapeHtml(action)}">${fields}<div class="form-error" role="alert"></div><div class="form-actions"><button type="button" class="button button-secondary" data-action="close-modal">Cancel</button><button type="submit" class="button button-primary">${escapeHtml(submitLabel)}</button></div></form>`);
}

async function openInvoice(id) {
  const invoice = await api(`/api/invoices/${id}`);
  const due = invoice.total_cents - invoice.paid_cents;
  showModal('Invoice details', `${escapeHtml(invoice.invoice_number)} · ${shortDate(invoice.issued_at)}`, `<div class="invoice-sheet">
    <div class="invoice-brand"><span class="brand brand-dark"><span class="brand-mark">b</span><span>brightloop</span></span>${statusBadge(invoice.status)}</div>
    <h3 class="invoice-title">Invoice</h3><div class="invoice-meta">Invoice number: ${escapeHtml(invoice.invoice_number)}<br>Issued ${shortDate(invoice.issued_at)} · Due ${shortDate(invoice.due_at)}</div>
    <div class="invoice-parties"><div><span>Billed to</span><strong>${escapeHtml(invoice.customer_name)}</strong><div class="invoice-meta">${escapeHtml(invoice.company || '')}<br>${escapeHtml(invoice.customer_email)}</div></div><div><span>Subscription</span><strong>${escapeHtml(invoice.product_name)} · ${escapeHtml(invoice.variant_name)}</strong><div class="invoice-meta">${escapeHtml(invoice.plan_name)}<br>Billing ${escapeHtml(invoice.interval)}</div></div></div>
    <div class="invoice-lines">${invoice.lines.map((line) => `<div class="invoice-line"><span>${escapeHtml(line.description)} <small>× ${line.quantity} · ${line.tax_percent}% tax</small></span><strong>${money(line.unit_price_cents * line.quantity)}</strong></div>`).join('')}</div>
    <div class="invoice-total-list"><div class="invoice-total-row"><span>Subtotal</span><strong>${money(invoice.subtotal_cents)}</strong></div>${invoice.discount_cents ? `<div class="invoice-total-row"><span>Discount</span><strong>−${money(invoice.discount_cents)}</strong></div>` : ''}<div class="invoice-total-row"><span>Tax</span><strong>${money(invoice.tax_cents)}</strong></div><div class="invoice-total-row final"><span>Total</span><strong>${money(invoice.total_cents)}</strong></div><div class="invoice-total-row"><span>Paid</span><strong>${money(invoice.paid_cents)}</strong></div><div class="invoice-total-row"><span>Balance due</span><strong>${money(due)}</strong></div></div>
    ${invoice.payments.length ? `<div style="margin-top:20px"><strong style="font-size:10px">Payment history</strong>${invoice.payments.map((payment) => `<div class="invoice-total-row" style="margin-top:8px"><span>${shortDate(payment.recorded_at)} · ${escapeHtml(payment.method)}</span><strong>${money(payment.amount_cents)}</strong></div>`).join('')}</div>` : ''}
    <div class="invoice-actions"><button class="button button-secondary" data-action="print-invoice">Print / save PDF</button>${invoice.document_status === 'draft' ? `<button class="button button-secondary" data-action="confirm-invoice" data-id="${invoice.id}">Confirm</button>` : ''}${due > 0 && invoice.document_status !== 'canceled' ? `<button class="button button-secondary" data-action="send-invoice" data-id="${invoice.id}">Send email</button><button class="button button-primary" data-action="pay-invoice" data-id="${invoice.id}">Record payment</button>` : ''}</div>
  </div>`);
}

async function openPortalInvoice(id) {
  const invoice = await api(`/api/portal/invoices/${id}`);
  showModal('Invoice details', `${escapeHtml(invoice.invoice_number)} · ${shortDate(invoice.issued_at)}`, `<div class="invoice-sheet">
    <div class="invoice-brand"><span class="brand brand-dark"><span class="brand-mark">b</span><span>brightloop</span></span>${statusBadge(invoice.status)}</div>
    <h3 class="invoice-title">Invoice</h3><div class="invoice-meta">Invoice number: ${escapeHtml(invoice.invoice_number)}<br>Issued ${shortDate(invoice.issued_at)} · Due ${shortDate(invoice.due_at)}</div>
    <div class="invoice-parties"><div><span>Subscription</span><strong>${escapeHtml(invoice.plan_name)}</strong><div class="invoice-meta">${escapeHtml(invoice.subscription_number)}</div></div><div><span>Payment status</span><strong>${money(invoice.paid_cents)} paid</strong><div class="invoice-meta">${money(invoice.total_cents - invoice.paid_cents)} outstanding</div></div></div>
    <div class="invoice-lines">${invoice.lines.map((line) => `<div class="invoice-line"><span>${escapeHtml(line.description)} <small>× ${line.quantity} · ${line.tax_percent}% tax</small></span><strong>${money(line.unit_price_cents * line.quantity)}</strong></div>`).join('')}</div>
    <div class="invoice-total-list"><div class="invoice-total-row"><span>Subtotal</span><strong>${money(invoice.subtotal_cents)}</strong></div><div class="invoice-total-row"><span>Discount</span><strong>−${money(invoice.discount_cents)}</strong></div><div class="invoice-total-row"><span>Tax</span><strong>${money(invoice.tax_cents)}</strong></div><div class="invoice-total-row final"><span>Total</span><strong>${money(invoice.total_cents)}</strong></div></div>
    <div class="invoice-actions"><button class="button button-secondary" data-action="print-invoice">Print / save PDF</button></div>
  </div>`);
}

function openPayment(id) {
  const invoice = state.invoices.find((item) => Number(item.id) === Number(id));
  const due = invoice ? invoice.total_cents - invoice.paid_cents : 0;
  if (!invoice) {
    api('/api/invoices').then((items) => {
      state.invoices = items;
      openPayment(id);
    }).catch((error) => toast(error.message, true));
    return;
  }
  const dollars = (due / 100).toFixed(2);
  showForm(`Record payment · ${invoice.invoice_number}`, `Balance due ${money(due)} for ${invoice.customer_name}`, `payment:${id}`,
    `<div class="form-grid">${formField('Amount (USD)', 'amount', 'number', { value: dollars, min: 0.01, step: 0.01 })}${formField('Payment method', 'method', 'select', { choices: ['Card', 'Bank transfer', 'Cash', 'Other'].map((value) => ({ value, label: value })) })}</div><div class="form-grid">${formField('Payment date', 'recorded_at', 'date', { value: new Date().toISOString().slice(0, 10) })}${formField('Reference (optional)', 'reference', 'text', { required: false, placeholder: 'Transaction ID' })}</div>${formField('Notes (optional)', 'notes', 'textarea', { required: false })}`,
    'Save payment');
}

function openCustomerForm(customer) {
  const editing = Boolean(customer);
  showForm(editing ? 'Edit customer' : 'Add customer', editing ? 'Update customer contact details.' : 'Add a customer to your workspace.', editing ? `customer-edit:${customer.id}` : 'customer-create',
    `<div class="form-grid">${formField('Full name', 'name', 'text', { value: customer?.name })}${formField('Email address', 'email', 'email', { value: customer?.email })}</div><div class="form-grid">${formField('Company (optional)', 'company', 'text', { value: customer?.company || '', required: false })}${formField('Phone (optional)', 'phone', 'tel', { value: customer?.phone || '', required: false })}</div>`,
    editing ? 'Save changes' : 'Create customer');
}

function openCreateSubscription(templateId) {
  if (!state.customers.length || !state.catalog.plans.length) {
    toast(!state.customers.length ? 'Add a customer before creating a subscription.' : 'Create a product plan before starting a subscription.', true);
    if (!state.customers.length) navigate('customers'); else navigate('catalog');
    return;
  }
  const template = state.quoteTemplates?.find((item) => Number(item.id) === Number(templateId));
  const templateField = template ? `<input type="hidden" name="template_id" value="${template.id}">` : '';
  showForm(template ? `Create quote · ${template.name}` : 'New subscription', 'Create a customer subscription or issue a valid quote.', 'subscription-create',
    `${templateField}<div class="form-grid">${formField('Customer', 'customer_id', 'select', { placeholder: true, choices: state.customers.map((item) => ({ value: item.id, label: `${item.name} · ${item.email}` })) })}${formField('Plan', 'plan_id', 'select', { placeholder: true, selected: template?.plan_id, choices: state.catalog.plans.map((item) => ({ value: item.id, label: `${item.name} · ${money(item.price_cents)} / ${item.interval}` })) })}</div><div class="form-grid">${formField('Start date', 'start_date', 'date', { value: new Date().toISOString().slice(0, 10) })}${formField('Quantity', 'quantity', 'number', { min: '1', value: '1' })}</div><div class="form-grid">${formField('Payment terms (days)', 'payment_terms_days', 'number', { min: '1', value: '7' })}${formField('Expiry date (optional)', 'expires_at', 'date', { required: false })}</div><div class="form-grid">${formField('Stage', 'workflow_status', 'select', { selected: template ? 'quotation' : 'active', choices: [{ value: 'active', label: 'Active (invoice now)' }, { value: 'draft', label: 'Draft' }, { value: 'quotation', label: 'Quotation' }, { value: 'confirmed', label: 'Confirmed' }] })}${formField('Discount code (optional)', 'discount_code', 'text', { required: false, placeholder: 'e.g. WELCOME10' })}</div><div class="invoice-meta">Brand variants add $560 to plan pricing. Drafts and quotations do not generate invoices until activated.</div>`,
    template ? 'Issue quote' : 'Create & invoice');
}

function openProductForm(product) {
  const editing = Boolean(product);
  showForm(editing ? 'Edit product' : 'Add product', 'Set the product type, selling and cost prices, and notes.', editing ? `product-edit:${product.id}` : 'product-create',
    `<div class="form-grid">${formField('Product name', 'name', 'text', { value: product?.name })}${formField('Type', 'product_type', 'select', { selected: product?.product_type || 'service', choices: [{ value: 'service', label: 'Service' }, { value: 'physical', label: 'Physical' }] })}</div><div class="form-grid">${formField('Selling price (USD)', 'selling_price', 'number', { value: ((product?.selling_price_cents || 0) / 100).toFixed(2), min: 0, step: 0.01 })}${formField('Cost price (USD)', 'cost_price', 'number', { value: ((product?.cost_price_cents || 0) / 100).toFixed(2), min: 0, step: 0.01 })}</div>${formField('Description', 'description', 'textarea', { value: product?.description || '', required: false })}${formField('Internal notes', 'notes', 'textarea', { value: product?.notes || '', required: false })}`,
    editing ? 'Save changes' : 'Create product');
}

function openVariantForm(productId, variant) {
  if (!state.catalog.products.length) {
    toast('Add a product before creating a variant.', true);
    openProductForm();
    return;
  }
  const editing = Boolean(variant);
  showForm(editing ? 'Edit product variant' : 'Add product variant', 'Brand variants add $560 to the product price.', editing ? `variant-edit:${variant.id}` : 'variant-create',
    `${formField('Product', 'product_id', 'select', { placeholder: !editing, selected: variant?.product_id || productId, choices: state.catalog.products.map((item) => ({ value: item.id, label: item.name })) })}<div class="form-grid">${formField('Variant name', 'name', 'text', { value: variant?.name })}${formField('SKU', 'sku', 'text', { value: variant?.sku, placeholder: 'e.g. BL-PRO-01' })}</div>${formField('Brand (optional)', 'brand', 'text', { value: variant?.brand || '', required: false, placeholder: 'A named brand adds $560' })}`,
    editing ? 'Save changes' : 'Create variant');
}

function openPlanForm() {
  if (!state.catalog.variants.length) {
    toast('Create a product variant before adding a plan.', true);
    if (!state.catalog.products.length) openProductForm(); else openVariantForm();
    return;
  }
  showForm('Add subscription plan', 'Configure billing frequency, price, tax and discount.', 'plan-create',
    `${formField('Product variant', 'variant_id', 'select', { placeholder: true, choices: state.catalog.variants.map((item) => ({ value: item.id, label: `${item.product_name} · ${item.name}${item.brand ? ' · +$560' : ''}` })) })}<div class="form-grid">${formField('Plan name', 'name')}${formField('Billing interval', 'interval', 'select', { choices: ['daily', 'weekly', 'monthly', 'yearly'].map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) })) })}</div><div class="form-grid">${formField('Price (USD)', 'price', 'number', { min: 0, step: 0.01, placeholder: '29.00' })}${formField('Tax rate (%)', 'tax_percent', 'number', { value: '0', min: 0, max: 100, step: 0.01 })}</div><div class="form-grid">${formField('Minimum quantity', 'min_quantity', 'number', { value: '1', min: 1 })}${formField('Discount (%)', 'discount_percent', 'number', { value: '0', min: 0, max: 100, step: 0.01 })}</div><div class="form-grid">${formField('Available from', 'available_from', 'date', { required: false })}${formField('Available until', 'available_until', 'date', { required: false })}</div>${formField('Auto-close at availability end', 'auto_close', 'select', { choices: [{ value: '0', label: 'No' }, { value: '1', label: 'Yes' }] })}`,
    'Create plan');
}

function openEditPlanForm(plan) {
  showForm('Edit subscription plan', 'Update plan billing and pricing settings.', `plan-edit:${plan.id}`,
    `${formField('Product variant', 'variant_id', 'select', { selected: plan.variant_id, choices: state.catalog.variants.map((item) => ({ value: item.id, label: `${item.product_name} · ${item.name}` })) })}<div class="form-grid">${formField('Plan name', 'name', 'text', { value: plan.name })}${formField('Billing interval', 'interval', 'select', { selected: plan.interval, choices: ['daily', 'weekly', 'monthly', 'yearly'].map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) })) })}</div><div class="form-grid">${formField('Price (USD)', 'price', 'number', { value: (plan.price_cents / 100).toFixed(2), min: 0, step: 0.01 })}${formField('Tax rate (%)', 'tax_percent', 'number', { value: String(plan.tax_percent), min: 0, max: 100, step: 0.01 })}</div><div class="form-grid">${formField('Minimum quantity', 'min_quantity', 'number', { value: String(plan.min_quantity || 1), min: 1 })}${formField('Discount (%)', 'discount_percent', 'number', { value: String(plan.discount_percent), min: 0, max: 100, step: 0.01 })}</div><div class="form-grid">${formField('Available from', 'available_from', 'date', { value: plan.available_from?.slice(0, 10), required: false })}${formField('Available until', 'available_until', 'date', { value: plan.available_until?.slice(0, 10), required: false })}</div>${formField('Auto-close at availability end', 'auto_close', 'select', { selected: plan.auto_close ? '1' : '0', choices: [{ value: '0', label: 'No' }, { value: '1', label: 'Yes' }] })}`,
    'Save changes');
}

function openQuoteTemplateForm(template) {
  if (!state.catalog.plans.length) {
    toast('Create a subscription plan before creating a quote template.', true);
    navigate('catalog');
    return;
  }
  const editing = Boolean(template);
  const line = template?.product_lines?.[0];
  showForm(editing ? 'Edit quote template' : 'New quote template', 'Set quote validity and one optional product line.', editing ? `template-edit:${template.id}` : 'template-create',
    `<div class="form-grid">${formField('Template name', 'name', 'text', { value: template?.name })}${formField('Plan', 'plan_id', 'select', { selected: template?.plan_id, choices: state.catalog.plans.map((plan) => ({ value: plan.id, label: plan.name })) })}</div>${formField('Validity (days)', 'validity_days', 'number', { value: String(template?.validity_days || 30), min: '1' })}<div class="form-grid">${formField('Add-on product (optional)', 'product_id', 'select', { required: false, placeholder: true, selected: line?.product_id, choices: state.catalog.products.map((product) => ({ value: product.id, label: product.name })) })}${formField('Add-on quantity', 'line_quantity', 'number', { value: String(line?.quantity || 1), min: '1' })}</div>${formField('Add-on description', 'line_description', 'text', { value: line?.description || '', required: false })}<div class="form-grid">${formField('Add-on price (USD)', 'line_price', 'number', { value: ((line?.unit_price_cents || 0) / 100).toFixed(2), min: '0', step: '0.01' })}${formField('Add-on tax (%)', 'line_tax', 'number', { value: String(line?.tax_percent || 0), min: '0', max: '100', step: '0.01' })}</div>`,
    editing ? 'Save changes' : 'Create template');
}

function openDiscountForm(discount) {
  const editing = Boolean(discount);
  showForm(editing ? 'Edit discount' : 'Create discount', 'Set value, eligibility and limits. Discount applies to the next eligible invoice.', editing ? `discount-edit:${discount.id}` : 'discount-create',
    `<div class="form-grid">${formField('Name', 'name', 'text', { value: discount?.name })}${formField('Code', 'code', 'text', { value: discount?.code, placeholder: 'WELCOME10' })}</div><div class="form-grid">${formField('Type', 'discount_type', 'select', { selected: discount?.discount_type || 'percent', choices: [{ value: 'percent', label: 'Percentage' }, { value: 'fixed', label: 'Fixed amount' }] })}${formField('Value (% or USD)', 'amount', 'number', { value: discount?.discount_type === 'fixed' ? (discount.amount / 100).toFixed(2) : String(discount?.amount ?? 10), min: 0, step: 0.01 })}</div><div class="form-grid">${formField('Minimum purchase (USD)', 'min_purchase', 'number', { value: ((discount?.min_purchase_cents || 0) / 100).toFixed(2), min: 0, step: 0.01 })}${formField('Minimum quantity', 'min_quantity', 'number', { value: String(discount?.min_quantity || 1), min: 1 })}</div><div class="form-grid">${formField('Starts', 'starts_at', 'date', { value: discount?.starts_at?.slice(0, 10), required: false })}${formField('Expires', 'expires_at', 'date', { value: discount?.expires_at?.slice(0, 10), required: false })}</div><div class="form-grid">${formField('Usage limit', 'usage_limit', 'number', { value: discount?.usage_limit || '', min: 1, required: false })}${editing ? formField('Active', 'active', 'select', { selected: discount.active ? '1' : '0', choices: [{ value: '1', label: 'Yes' }, { value: '0', label: 'No' }] }) : ''}</div>`,
    editing ? 'Save changes' : 'Create discount');
}

function openStaffForm() {
  showForm('Invite staff', 'Create a restricted staff login for your workspace.', 'staff-create',
    `<div class="form-grid">${formField('Email address', 'email', 'email')}${formField('Temporary password', 'password', 'password', { placeholder: '9+ chars, upper/lower + symbol' })}</div><div class="invoice-meta">Staff can manage customers, subscriptions, invoices and payments. Only admins can manage the catalog, discounts and team.</div>`,
    'Create staff');
}

function formPayload(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function toCents(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) throw new Error('Enter an amount greater than zero.');
  return Math.round(value * 100);
}

function toNonNegativeCents(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 0) throw new Error('Enter a non-negative price.');
  return Math.round(value * 100);
}

async function submitForm(form) {
  const action = form.dataset.formAction;
  const payload = formPayload(form);
  const submit = form.querySelector('[type="submit"]');
  submit.dataset.originalLabel = submit.textContent;
  const errorNode = form.querySelector('.form-error');
  submit.disabled = true;
  submit.textContent = 'Saving…';
  errorNode.textContent = '';
  try {
    if (action === 'customer-create') {
      await api('/api/customers', { method: 'POST', body: payload });
      await renderCustomers();
      toast('Customer created.');
    } else if (action.startsWith('customer-edit:')) {
      await api(`/api/customers/${action.split(':')[1]}`, { method: 'PUT', body: payload });
      await renderCustomers();
      toast('Customer updated.');
    } else if (action.startsWith('product-edit:')) {
      await api(`/api/products/${action.split(':')[1]}`, { method: 'PUT', body: { ...payload, selling_price_cents: toNonNegativeCents(payload.selling_price), cost_price_cents: toNonNegativeCents(payload.cost_price) } });
      await renderCatalog();
      toast('Product updated.');
    } else if (action === 'product-create') {
      await api('/api/products', { method: 'POST', body: { ...payload, selling_price_cents: toNonNegativeCents(payload.selling_price), cost_price_cents: toNonNegativeCents(payload.cost_price) } });
      await renderCatalog();
      toast('Product created.');
    } else if (action === 'variant-create') {
      await api('/api/variants', { method: 'POST', body: payload });
      await renderCatalog();
      toast('Variant created.');
    } else if (action.startsWith('variant-edit:')) {
      await api(`/api/variants/${action.split(':')[1]}`, { method: 'PUT', body: payload });
      await renderCatalog();
      toast('Variant updated.');
    } else if (action === 'plan-create') {
      await api('/api/plans', { method: 'POST', body: { ...payload, price_cents: toNonNegativeCents(payload.price), tax_percent: Number(payload.tax_percent), discount_percent: Number(payload.discount_percent), min_quantity: Number(payload.min_quantity), auto_close: payload.auto_close === '1' } });
      await renderCatalog();
      toast('Subscription plan created.');
    } else if (action.startsWith('plan-edit:')) {
      await api(`/api/plans/${action.split(':')[1]}`, { method: 'PUT', body: { ...payload, price_cents: toNonNegativeCents(payload.price), tax_percent: Number(payload.tax_percent), discount_percent: Number(payload.discount_percent), min_quantity: Number(payload.min_quantity), auto_close: payload.auto_close === '1' } });
      await renderCatalog();
      toast('Subscription plan updated.');
    } else if (action === 'subscription-create') {
      const request = { ...payload, customer_id: Number(payload.customer_id), plan_id: Number(payload.plan_id), quantity: Number(payload.quantity), payment_terms_days: Number(payload.payment_terms_days) };
      if (!request.expires_at) delete request.expires_at;
      const result = await api('/api/subscriptions', { method: 'POST', body: request });
      await navigate('subscriptions');
      toast(result.invoice ? `Subscription created · invoice ${result.invoice.invoice_number} generated.` : 'Draft subscription or quotation created.');
    } else if (action.startsWith('payment:')) {
      const id = action.split(':')[1];
      await api(`/api/invoices/${id}/payments`, { method: 'POST', body: { amount_cents: toCents(payload.amount), method: payload.method, reference: payload.reference, notes: payload.notes, recorded_at: new Date(`${payload.recorded_at}T12:00:00Z`).toISOString() } });
      await renderInvoices();
      toast('Payment recorded and invoice balance updated.');
    } else if (action === 'template-create' || action.startsWith('template-edit:')) {
      const lineDescription = payload.line_description || state.catalog.products.find((product) => Number(product.id) === Number(payload.product_id))?.name;
      const productLines = lineDescription ? [{
        product_id: payload.product_id ? Number(payload.product_id) : null,
        description: lineDescription,
        quantity: Number(payload.line_quantity),
        unit_price_cents: toNonNegativeCents(payload.line_price),
        tax_percent: Number(payload.line_tax)
      }] : [];
      const id = action.startsWith('template-edit:') ? action.split(':')[1] : '';
      await api(id ? `/api/quote-templates/${id}` : '/api/quote-templates', {
        method: id ? 'PUT' : 'POST',
        body: { name: payload.name, plan_id: Number(payload.plan_id), validity_days: Number(payload.validity_days), product_lines: productLines }
      });
      await renderCatalog();
      toast(id ? 'Quote template updated.' : 'Quote template created.');
    } else if (action.startsWith('discount-edit:') || action === 'discount-create') {
      const id = action.startsWith('discount-edit:') ? action.split(':')[1] : '';
      const discountType = payload.discount_type;
      const body = {
        ...payload, discount_type: discountType,
        amount: discountType === 'percent' ? Number(payload.amount) : undefined,
        amount_cents: discountType === 'fixed' ? toNonNegativeCents(payload.amount) : undefined,
        min_purchase_cents: toNonNegativeCents(payload.min_purchase),
        min_quantity: Number(payload.min_quantity),
        usage_limit: payload.usage_limit ? Number(payload.usage_limit) : null,
        active: payload.active !== '0'
      };
      if (!body.starts_at) delete body.starts_at;
      if (!body.expires_at) delete body.expires_at;
      await api(id ? `/api/discounts/${id}` : '/api/discounts', { method: id ? 'PUT' : 'POST', body });
      await renderDiscounts();
      toast(id ? 'Discount updated.' : 'Discount created.');
    } else if (action === 'staff-create') {
      await api('/api/staff', { method: 'POST', body: payload });
      await renderStaff();
      toast('Staff account created.');
    } else if (action === 'auth-register') {
      const result = await api('/api/auth/register', { method: 'POST', body: payload });
      modalRoot.innerHTML = '';
      setAuthenticated(result.email, result.role);
      toast('Customer account created.');
      return;
    } else if (action === 'auth-reset-request') {
      await api('/api/auth/password-reset/request', { method: 'POST', body: { email: payload.email } });
      showForm('Enter reset token', 'A token was sent to your email, or printed in the server terminal when SMTP is not configured.', 'auth-reset-complete',
        `${formField('Reset token', 'token')}${formField('New password', 'password', 'password', { placeholder: '9+ chars, upper/lower + symbol' })}`,
        'Reset password');
      return;
    } else if (action === 'auth-reset-complete') {
      await api('/api/auth/password-reset/complete', { method: 'POST', body: payload });
      modalRoot.innerHTML = '';
      toast('Password updated. Sign in with your new password.');
      return;
    }
    modalRoot.innerHTML = '';
  } catch (error) {
    errorNode.textContent = error.message;
    submit.disabled = false;
    submit.textContent = submit.dataset.originalLabel || 'Save';
  }
}

document.addEventListener('click', async (event) => {
  const sortButton = event.target.closest('[data-sort-column]');
  if (sortButton) {
    const table = sortButton.closest('.table-panel').querySelector('table');
    const body = table.querySelector('tbody');
    const column = Number(sortButton.dataset.sortColumn);
    const direction = sortButton.dataset.direction === 'asc' ? 'desc' : 'asc';
    sortButton.dataset.direction = direction;
    const rows = [...body.querySelectorAll('tr:not(.search-empty)')];
    rows.sort((a, b) => {
      const left = a.cells[column]?.textContent.trim() || '';
      const right = b.cells[column]?.textContent.trim() || '';
      return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }) * (direction === 'asc' ? 1 : -1);
    });
    rows.forEach((row) => body.append(row));
    state.tablePage = 1;
    filterCurrentPage();
    return;
  }
  const nav = event.target.closest('[data-view]');
  if (nav) {
    event.preventDefault();
    navigate(nav.dataset.view);
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  try {
    if (action === 'table-page') {
      state.tablePage = Number(button.dataset.page);
      addTablePagination();
    }
    if (action === 'create-draft-invoice') {
      const periodStart = new Date();
      const result = await api('/api/invoices', { method: 'POST', body: { subscription_id: Number(button.dataset.id), period_start: periodStart.toISOString() } });
      toast(`Draft invoice ${result.invoice_number} created.`);
      await navigate('invoices');
    }
    if (action === 'new-customer') openCustomerForm();
    else if (action === 'edit-customer') openCustomerForm(state.customers.find((item) => Number(item.id) === Number(button.dataset.id)));
    else if (action === 'edit-product') openProductForm(state.catalog.products.find((item) => Number(item.id) === Number(button.dataset.id)));
    else if (action === 'edit-variant') openVariantForm(null, state.catalog.variants.find((item) => Number(item.id) === Number(button.dataset.id)));
    else if (action === 'edit-plan') openEditPlanForm(state.catalog.plans.find((item) => Number(item.id) === Number(button.dataset.id)));
    else if (action === 'new-product') openProductForm();
    else if (action === 'new-variant') openVariantForm(button.dataset.productId);
    else if (action === 'new-plan') openPlanForm();
    else if (action === 'new-template') openQuoteTemplateForm();
    else if (action === 'edit-template') openQuoteTemplateForm(state.quoteTemplates.find((item) => Number(item.id) === Number(button.dataset.id)));
    else if (action === 'create-quote') {
      if (!state.customers.length) state.customers = await api('/api/customers');
      if (!state.catalog.plans.length) state.catalog = await api('/api/catalog');
      if (!state.quoteTemplates) state.quoteTemplates = await api('/api/quote-templates');
      openCreateSubscription(button.dataset.id);
    }
    else if (action === 'new-discount') openDiscountForm();
    else if (action === 'edit-discount') openDiscountForm(state.discounts.find((item) => Number(item.id) === Number(button.dataset.id)));
    else if (action === 'delete-discount') {
      if (!confirm('Delete this discount? This cannot be undone.')) return;
      await api(`/api/discounts/${button.dataset.id}`, { method: 'DELETE' });
      await renderDiscounts();
      toast('Discount deleted.');
    } else if (action === 'delete-product' || action === 'delete-variant' || action === 'delete-plan') {
      const label = action.replace('delete-', '');
      if (!confirm(`Delete this ${label}?`)) return;
      await api(`/api/${label}s/${button.dataset.id}`, { method: 'DELETE' });
      await renderCatalog();
      toast(`${label[0].toUpperCase()}${label.slice(1)} deleted.`);
    } else if (action === 'delete-template') {
      if (!confirm('Delete this quote template?')) return;
      await api(`/api/quote-templates/${button.dataset.id}`, { method: 'DELETE' });
      await renderCatalog();
      toast('Quote template deleted.');
    } else if (action === 'new-staff') openStaffForm();
    else if (action === 'filter-dashboard') {
      const from = document.getElementById('reportFrom').value;
      const to = document.getElementById('reportTo').value;
      if (from && to && from > to) return toast('The start date must be before the end date.', true);
      state.dashboardFilters = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
      await renderDashboard();
    } else if (action === 'clear-dashboard-filter') {
      state.dashboardFilters = {};
      await renderDashboard();
    } else if (action === 'confirm-invoice' || action === 'cancel-invoice' || action === 'send-invoice') {
      const operation = action.replace('-invoice', '');
      if (operation === 'cancel' && !confirm('Cancel this invoice? An invoice with recorded payments cannot be canceled.')) return;
      await api(`/api/invoices/${button.dataset.id}/status`, { method: 'PATCH', body: { action: operation } });
      await navigate('invoices');
      toast(operation === 'send' ? 'Invoice email sent.' : operation === 'confirm' ? 'Invoice confirmed.' : 'Invoice canceled.');
    } else if (action === 'view-portal-invoice') await openPortalInvoice(button.dataset.id);
    else if (action === 'new-subscription') {
      if (!state.customers.length) state.customers = await api('/api/customers');
      if (!state.catalog.plans.length) state.catalog = await api('/api/catalog');
      if (!state.discounts) state.discounts = await api('/api/discounts');
      openCreateSubscription();
    } else if (action === 'view-invoice') await openInvoice(button.dataset.id);
    else if (action === 'pay-invoice') openPayment(button.dataset.id);
    else if (action === 'print-invoice') window.print();
    else if (action === 'close-modal') modalRoot.innerHTML = '';
    else if (action === 'backdrop-close' && event.target === button) modalRoot.innerHTML = '';
    else if (action === 'retry-view') navigate(state.view);
    else if (action === 'renew-subscription') {
      const result = await api(`/api/subscriptions/${button.dataset.id}/renew`, { method: 'POST', body: {} });
      toast(`Renewal invoice ${result.invoice.invoice_number} generated.`);
      await navigate('subscriptions');
    } else if (action === 'subscription-status') {
      const label = button.dataset.status === 'canceled' ? 'close' : button.dataset.status === 'paused' ? 'pause' : 'resume';
      if (button.dataset.status === 'canceled' && !confirm('Close this subscription? This cannot be undone.')) return;
      await api(`/api/subscriptions/${button.dataset.id}/status`, { method: 'PATCH', body: { status: button.dataset.status } });
      toast(`Subscription ${label === 'close' ? 'closed' : label === 'pause' ? 'paused' : 'resumed'}.`);
      await navigate('subscriptions');
    }
  } catch (error) {
    toast(error.message, true);
  }
});

document.addEventListener('submit', (event) => {
  if (event.target.id === 'loginForm') {
    event.preventDefault();
    const form = event.target;
    const errorNode = document.getElementById('loginError');
    errorNode.textContent = '';
    api('/api/auth/login', { method: 'POST', body: formPayload(form) })
      .then((result) => setAuthenticated(result.email, result.role))
      .catch((error) => { errorNode.textContent = error.message; });
  } else if (event.target.matches('[data-form-action]')) {
    event.preventDefault();
    submitForm(event.target);
  }
});

document.getElementById('logoutButton').addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
    state.view = 'dashboard';
    setAuthenticated('', '');
  } catch (error) {
    toast(error.message, true);
  }
});
document.getElementById('menuToggle').addEventListener('click', () => document.getElementById('sidebar').classList.toggle('open'));
document.getElementById('notificationButton').addEventListener('click', () => navigate(state.role === 'customer' ? 'portal-invoices' : 'invoices'));
document.querySelectorAll('[data-auth-action]').forEach((button) => button.addEventListener('click', () => {
  if (button.dataset.authAction === 'register') {
    showForm('Create customer account', 'Register to view your own subscriptions and invoices.', 'auth-register',
      `<div class="form-grid">${formField('Full name', 'name')}${formField('Email address', 'email', 'email')}</div><div class="form-grid">${formField('Password', 'password', 'password', { placeholder: '9+ chars, upper/lower + symbol' })}${formField('Company (optional)', 'company', 'text', { required: false })}</div>${formField('Phone (optional)', 'phone', 'tel', { required: false })}`,
      'Create account');
  } else {
    showForm('Reset password', 'Request a secure, time-limited password reset token.', 'auth-reset-request',
      formField('Email address', 'email', 'email'),
      'Send reset instructions');
  }
}));
document.getElementById('todayLabel').textContent = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date());
const globalSearch = document.getElementById('globalSearch');
globalSearch.addEventListener('input', () => {
  filterCurrentPage();
});
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    globalSearch.focus();
  }
  if (event.key === 'Escape' && document.activeElement === globalSearch) {
    globalSearch.value = '';
    globalSearch.dispatchEvent(new Event('input'));
    globalSearch.blur();
  }
});

api('/api/auth/session')
  .then((result) => setAuthenticated(result.authenticated ? result.email : '', result.role))
  .catch((error) => {
    document.getElementById('loginScreen').hidden = false;
    document.getElementById('loginError').textContent = error.message;
  });

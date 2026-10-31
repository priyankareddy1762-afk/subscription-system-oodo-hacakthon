const state = { view: 'dashboard', email: '', customers: [], catalog: { products: [], variants: [], plans: [] }, subscriptions: [], invoices: [], payments: [], dashboard: null };
const root = document.getElementById('viewRoot');
const modalRoot = document.getElementById('modalRoot');
const titles = { dashboard: 'Overview', customers: 'Customers', catalog: 'Products & plans', subscriptions: 'Subscriptions', invoices: 'Invoices', payments: 'Payments' };

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

function setAuthenticated(email) {
  state.email = email || '';
  document.getElementById('adminEmail').textContent = state.email;
  document.getElementById('loginScreen').hidden = Boolean(email);
  document.getElementById('appShell').hidden = !email;
  if (email) navigate(state.view);
}

function updateHeader(view) {
  state.view = view;
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
  return `<section class="panel table-panel"><div class="panel-head"><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(subtitle)}</p></div>${tools}</div><div class="table-scroll"><table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${rows || tableEmpty('Nothing here yet. Create your first record to get started.', headers.length)}</tbody></table></div></section>`;
}

async function renderDashboard() {
  const data = await api('/api/dashboard');
  state.dashboard = data;
  const recent = data.recent_invoices.map((invoice) => `<tr><td><strong>${escapeHtml(invoice.invoice_number)}</strong><span class="cell-subtitle">${shortDate(invoice.issued_at)}</span></td><td>${escapeHtml(invoice.customer_name)}</td><td><strong>${money(invoice.total_cents)}</strong></td><td>${statusBadge(invoice.status)}</td><td><button class="action-button" data-action="view-invoice" data-id="${invoice.id}">View</button></td></tr>`).join('');
  const max = Math.max(1, ...data.monthly_revenue.map((item) => Number(item.total)));
  const bars = data.monthly_revenue.length ? data.monthly_revenue.map((item) => {
    const height = Math.max(5, Math.round(Number(item.total) / max * 100));
    const month = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(new Date(`${item.month}-01T00:00:00Z`));
    return `<div class="chart-column" title="${escapeHtml(month)}: ${money(item.total)}"><div class="chart-bar" style="height:${height}%"></div><span>${escapeHtml(month)}</span></div>`;
  }).join('') : '<div class="chart-empty">Payments will appear here as you record them.</div>';
  root.innerHTML = `
    ${pageHeading('YOUR BUSINESS AT A GLANCE', 'Welcome back 👋', 'Here’s what’s happening with your subscriptions today.', 'New subscription', 'new-subscription')}
    <section class="metrics-grid">
      <article class="metric-card"><div class="metric-top">Total revenue <span class="metric-icon">↗</span></div><div class="metric-value">${money(data.revenue_cents)}</div><div class="metric-note">Collected payments to date</div></article>
      <article class="metric-card"><div class="metric-top">Monthly recurring revenue <span class="metric-icon green">⟳</span></div><div class="metric-value">${money(data.mrr_cents)}</div><div class="metric-note">From active subscriptions</div></article>
      <article class="metric-card"><div class="metric-top">Active subscriptions <span class="metric-icon amber">▤</span></div><div class="metric-value">${data.active_subscriptions}</div><div class="metric-note">Currently generating revenue</div></article>
      <article class="metric-card"><div class="metric-top">Overdue invoices <span class="metric-icon red">!</span></div><div class="metric-value">${data.overdue_count}</div><div class="metric-note">${money(data.overdue_cents)} outstanding balance</div></article>
    </section>
    <div class="dashboard-grid">
      <section class="panel"><div class="panel-head"><div><h2>Revenue over time</h2><p>Payments recorded in the last six months</p></div><span class="metric-icon green">↗</span></div><div class="chart-wrap"><div class="chart">${bars}</div></div></section>
      <section class="panel"><div class="panel-head"><div><h2>At a glance</h2><p>Your billing activity</p></div></div><div class="quick-stats">
        <div class="quick-row"><span class="quick-label"><i class="quick-dot green"></i>Active subscriptions</span><strong>${data.active_subscriptions}</strong></div>
        <div class="quick-row"><span class="quick-label"><i class="quick-dot amber"></i>Overdue invoices</span><strong>${data.overdue_count}</strong></div>
        <div class="quick-row"><span class="quick-label"><i class="quick-dot"></i>Overdue amount</span><strong>${money(data.overdue_cents)}</strong></div>
        <div class="quick-row"><span class="quick-label"><i class="quick-dot red"></i>Total collected</span><strong>${money(data.revenue_cents)}</strong></div>
      </div></section>
    </div>
    ${tablePanel('Recent invoices', 'Your latest billing activity', ['Invoice', 'Customer', 'Amount', 'Status', ''], recent, '<button class="plain-link" data-view="invoices">All invoices →</button>')}`;
  root.querySelectorAll('[data-view="invoices"]').forEach((item) => item.addEventListener('click', () => navigate('invoices')));
  const overdueNav = document.getElementById('overdueNavCount');
  overdueNav.textContent = data.overdue_count;
  overdueNav.hidden = data.overdue_count === 0;
}

async function renderCustomers() {
  state.customers = await api('/api/customers');
  const rows = state.customers.map((customer) => `<tr><td><div class="cell-primary"><span class="mini-avatar">${escapeHtml(initials(customer.name))}</span><span><strong>${escapeHtml(customer.name)}</strong><span class="cell-subtitle">${escapeHtml(customer.company || 'Individual')}</span></span></div></td><td>${escapeHtml(customer.email)}</td><td>${escapeHtml(customer.phone || '—')}</td><td>${customer.subscription_count}</td><td>${shortDate(customer.created_at)}</td><td><button class="action-button" data-action="edit-customer" data-id="${customer.id}">Edit</button></td></tr>`).join('');
  root.innerHTML = `${pageHeading('RELATIONSHIPS', 'Customers', 'Keep your customer details organized in one place.', 'Add customer', 'new-customer')}${tablePanel('All customers', `${state.customers.length} customer${state.customers.length === 1 ? '' : 's'} in your workspace`, ['Customer', 'Email', 'Phone', 'Subscriptions', 'Added', ''], rows, '<input class="search-input" data-search placeholder="Search customers…" aria-label="Search customers">')}`;
  addTableSearch('customers');
}

async function renderCatalog() {
  state.catalog = await api('/api/catalog');
  const products = state.catalog.products.map((item) => `<div class="list-row"><div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.description || 'No description')}</span></div><div class="row-actions"><button class="action-button" data-action="edit-product" data-id="${item.id}">Edit</button><button class="action-button" data-action="new-variant" data-product-id="${item.id}">＋ Variant</button></div></div>`).join('');
  const variants = state.catalog.variants.map((item) => `<div class="list-row"><div><strong>${escapeHtml(item.product_name)} · ${escapeHtml(item.name)}</strong><span>SKU ${escapeHtml(item.sku)}</span></div><button class="action-button" data-action="edit-variant" data-id="${item.id}">Edit</button></div>`).join('');
  const plans = state.catalog.plans.map((item) => `<div class="list-row"><div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.product_name)} · ${escapeHtml(item.variant_name)} · ${escapeHtml(item.interval)} · ${item.tax_percent}% tax${item.discount_percent ? ` · ${item.discount_percent}% discount` : ''}</span></div><div class="row-actions"><span class="list-price">${money(item.price_cents)} / ${item.interval === 'monthly' ? 'mo' : 'yr'}</span><button class="action-button" data-action="edit-plan" data-id="${item.id}">Edit</button></div></div>`).join('');
  root.innerHTML = `${pageHeading('YOUR OFFERING', 'Products & plans', 'Build the catalog customers can subscribe to.', 'Add product', 'new-product')}
    <div class="catalog-grid">
      <section class="panel catalog-card"><div class="panel-head"><div><h2>Products</h2><p>${state.catalog.products.length} products</p></div></div>${products || '<div class="empty-state">No products yet.</div>'}</section>
      <section class="panel catalog-card"><div class="panel-head"><div><h2>Variants</h2><p>Sell different versions of your product</p></div><button class="button button-secondary button-small" data-action="new-variant">＋ Add</button></div>${variants || '<div class="empty-state">Add a product variant to continue.</div>'}</section>
      <section class="panel catalog-card full"><div class="panel-head"><div><h2>Subscription plans</h2><p>Pricing, billing cadence, tax and discount settings</p></div><button class="button button-secondary button-small" data-action="new-plan">＋ Add plan</button></div>${plans || '<div class="empty-state">Add a variant, then create your first plan.</div>'}</section>
    </div>`;
}

async function renderSubscriptions() {
  state.subscriptions = await api('/api/subscriptions');
  const rows = state.subscriptions.map((sub) => {
    let actions = `<button class="action-button" data-action="renew-subscription" data-id="${sub.id}">Renew</button>`;
    if (sub.status === 'active') actions += `<button class="action-button" data-action="subscription-status" data-status="paused" data-id="${sub.id}">Pause</button>`;
    if (sub.status === 'paused') actions += `<button class="action-button" data-action="subscription-status" data-status="active" data-id="${sub.id}">Resume</button>`;
    if (sub.status !== 'canceled') actions += `<button class="action-button button-danger" data-action="subscription-status" data-status="canceled" data-id="${sub.id}">Close</button>`;
    return `<tr><td><strong>SUB-${String(sub.id).padStart(4, '0')}</strong><span class="cell-subtitle">${escapeHtml(sub.product_name)} · ${escapeHtml(sub.variant_name)}</span></td><td><strong>${escapeHtml(sub.customer_name)}</strong><span class="cell-subtitle">${escapeHtml(sub.customer_email)}</span></td><td>${escapeHtml(sub.plan_name)}</td><td><strong>${money(sub.price_cents)}</strong><span class="cell-subtitle">per ${escapeHtml(sub.interval === 'monthly' ? 'month' : 'year')}</span></td><td>${statusBadge(sub.status)}</td><td>${shortDate(sub.next_billing_at)}</td><td><div class="row-actions">${actions}</div></td></tr>`;
  }).join('');
  root.innerHTML = `${pageHeading('RECURRING REVENUE', 'Subscriptions', 'Create, renew, pause or close a customer subscription.', 'New subscription', 'new-subscription')}${tablePanel('All subscriptions', `${state.subscriptions.length} subscription${state.subscriptions.length === 1 ? '' : 's'}`, ['Subscription', 'Customer', 'Plan', 'Price', 'Status', 'Next billing', 'Actions'], rows, '<input class="search-input" data-search placeholder="Search subscriptions…" aria-label="Search subscriptions">')}`;
  addTableSearch('subscriptions');
}

async function renderInvoices() {
  state.invoices = await api('/api/invoices');
  const overdueCount = state.invoices.filter((invoice) => invoice.status === 'overdue').length;
  const overdueBalance = state.invoices.filter((invoice) => invoice.status === 'overdue').reduce((sum, invoice) => sum + invoice.total_cents - invoice.paid_cents, 0);
  const rows = state.invoices.map((invoice) => `<tr><td><strong>${escapeHtml(invoice.invoice_number)}</strong><span class="cell-subtitle">Subscription #${invoice.subscription_number}</span></td><td><strong>${escapeHtml(invoice.customer_name)}</strong><span class="cell-subtitle">${escapeHtml(invoice.customer_email)}</span></td><td>${shortDate(invoice.issued_at)}</td><td>${shortDate(invoice.due_at)}</td><td><strong>${money(invoice.total_cents)}</strong><span class="cell-subtitle">${invoice.paid_cents ? `${money(invoice.paid_cents)} paid` : ''}</span></td><td>${statusBadge(invoice.status)}</td><td><div class="row-actions"><button class="action-button" data-action="view-invoice" data-id="${invoice.id}">View</button>${invoice.status !== 'paid' ? `<button class="action-button" data-action="pay-invoice" data-id="${invoice.id}">Record payment</button>` : ''}</div></td></tr>`).join('');
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

function addTableSearch(type) {
  const search = root.querySelector('[data-search]');
  if (!search) return;
  search.addEventListener('input', () => filterCurrentPage(type));
}

function filterCurrentPage(type = 'records') {
  const globalQuery = globalSearch.value.trim().toLowerCase();
  const localQuery = root.querySelector('[data-search]')?.value.trim().toLowerCase() || '';
  const query = [globalQuery, localQuery].filter(Boolean).join(' ');
  const rows = [...root.querySelectorAll('tbody tr')].filter((row) => !row.classList.contains('search-empty'));
  rows.forEach((row) => { row.hidden = Boolean(query) && !row.textContent.toLowerCase().includes(query); });
  const items = [...root.querySelectorAll('.list-row')];
  items.forEach((item) => { item.hidden = Boolean(globalQuery) && !item.textContent.toLowerCase().includes(globalQuery); });
  const visible = rows.some((row) => !row.hidden);
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
    <div class="invoice-total-list"><div class="invoice-total-row"><span>Subtotal</span><strong>${money(invoice.subtotal_cents)}</strong></div>${invoice.discount_cents ? `<div class="invoice-total-row"><span>Discount</span><strong>−${money(invoice.discount_cents)}</strong></div>` : ''}<div class="invoice-total-row"><span>Tax</span><strong>${money(invoice.tax_cents)}</strong></div><div class="invoice-total-row final"><span>Total</span><strong>${money(invoice.total_cents)}</strong></div><div class="invoice-total-row"><span>Paid</span><strong>${money(invoice.paid_cents)}</strong></div><div class="invoice-total-row"><span>Balance due</span><strong>${money(due)}</strong></div></div>
    ${invoice.payments.length ? `<div style="margin-top:20px"><strong style="font-size:10px">Payment history</strong>${invoice.payments.map((payment) => `<div class="invoice-total-row" style="margin-top:8px"><span>${shortDate(payment.recorded_at)} · ${escapeHtml(payment.method)}</span><strong>${money(payment.amount_cents)}</strong></div>`).join('')}</div>` : ''}
    <div class="invoice-actions"><button class="button button-secondary" data-action="print-invoice">Print / save PDF</button>${due > 0 ? `<button class="button button-primary" data-action="pay-invoice" data-id="${invoice.id}">Record payment</button>` : ''}</div>
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
    `<div class="form-grid">${formField('Amount (USD)', 'amount', 'number', { value: dollars, min: 0.01, step: 0.01 })}${formField('Payment method', 'method', 'select', { choices: ['Card', 'Bank transfer', 'Cash', 'Other'].map((value) => ({ value, label: value })) })}</div>${formField('Reference (optional)', 'reference', 'text', { required: false, placeholder: 'Transaction ID or note' })}`,
    'Save payment');
}

function openCustomerForm(customer) {
  const editing = Boolean(customer);
  showForm(editing ? 'Edit customer' : 'Add customer', editing ? 'Update customer contact details.' : 'Add a customer to your workspace.', editing ? `customer-edit:${customer.id}` : 'customer-create',
    `<div class="form-grid">${formField('Full name', 'name', 'text', { value: customer?.name })}${formField('Email address', 'email', 'email', { value: customer?.email })}</div><div class="form-grid">${formField('Company (optional)', 'company', 'text', { value: customer?.company || '', required: false })}${formField('Phone (optional)', 'phone', 'tel', { value: customer?.phone || '', required: false })}</div>`,
    editing ? 'Save changes' : 'Create customer');
}

function openCreateSubscription() {
  if (!state.customers.length || !state.catalog.plans.length) {
    toast(!state.customers.length ? 'Add a customer before creating a subscription.' : 'Create a product plan before starting a subscription.', true);
    if (!state.customers.length) navigate('customers'); else navigate('catalog');
    return;
  }
  showForm('New subscription', 'Choose a customer and plan. An invoice is generated immediately.', 'subscription-create',
    `<div class="form-grid">${formField('Customer', 'customer_id', 'select', { placeholder: true, choices: state.customers.map((item) => ({ value: item.id, label: `${item.name} · ${item.email}` })) })}${formField('Plan', 'plan_id', 'select', { placeholder: true, choices: state.catalog.plans.map((item) => ({ value: item.id, label: `${item.name} · ${money(item.price_cents)} / ${item.interval === 'monthly' ? 'mo' : 'yr'}` })) })}</div><div class="invoice-meta">The first billing period is invoiced when the subscription is created. Tax and discounts are applied from the selected plan.</div>`,
    'Create & invoice');
}

function openProductForm() {
  showForm('Add product', 'Start with the product customers will subscribe to.', 'product-create',
    `${formField('Product name', 'name')}${formField('Description', 'description', 'textarea', { required: false })}`,
    'Create product');
}

function openEditProductForm(product) {
  showForm('Edit product', 'Update the product customers subscribe to.', `product-edit:${product.id}`,
    `${formField('Product name', 'name', 'text', { value: product.name })}${formField('Description', 'description', 'textarea', { value: product.description, required: false })}`,
    'Save changes');
}

function openVariantForm(productId) {
  if (!state.catalog.products.length) {
    toast('Add a product before creating a variant.', true);
    openProductForm();
    return;
  }
  showForm('Add product variant', 'Define a sellable version of a product.', 'variant-create',
    `${formField('Product', 'product_id', 'select', { placeholder: true, selected: productId, choices: state.catalog.products.map((item) => ({ value: item.id, label: item.name })) })}<div class="form-grid">${formField('Variant name', 'name')}${formField('SKU', 'sku', 'text', { placeholder: 'e.g. BL-PRO-01' })}</div>`,
    'Create variant');
}

function openEditVariantForm(variant) {
  showForm('Edit product variant', 'Update the sellable product version.', `variant-edit:${variant.id}`,
    `${formField('Product', 'product_id', 'select', { selected: variant.product_id, choices: state.catalog.products.map((item) => ({ value: item.id, label: item.name })) })}<div class="form-grid">${formField('Variant name', 'name', 'text', { value: variant.name })}${formField('SKU', 'sku', 'text', { value: variant.sku })}</div>`,
    'Save changes');
}

function openPlanForm() {
  if (!state.catalog.variants.length) {
    toast('Create a product variant before adding a plan.', true);
    if (!state.catalog.products.length) openProductForm(); else openVariantForm();
    return;
  }
  showForm('Add subscription plan', 'Configure billing frequency, price, tax and discount.', 'plan-create',
    `${formField('Product variant', 'variant_id', 'select', { placeholder: true, choices: state.catalog.variants.map((item) => ({ value: item.id, label: `${item.product_name} · ${item.name}` })) })}<div class="form-grid">${formField('Plan name', 'name')}${formField('Billing interval', 'interval', 'select', { choices: [{ value: 'monthly', label: 'Monthly' }, { value: 'yearly', label: 'Yearly' }] })}</div><div class="form-grid">${formField('Price (USD)', 'price', 'number', { min: 0, step: 0.01, placeholder: '29.00' })}${formField('Tax rate (%)', 'tax_percent', 'number', { value: '0', min: 0, max: 100, step: 0.01 })}</div>${formField('Discount (%)', 'discount_percent', 'number', { value: '0', min: 0, max: 100, step: 0.01 })}`,
    'Create plan');
}

function openEditPlanForm(plan) {
  showForm('Edit subscription plan', 'Update plan billing and pricing settings.', `plan-edit:${plan.id}`,
    `${formField('Product variant', 'variant_id', 'select', { selected: plan.variant_id, choices: state.catalog.variants.map((item) => ({ value: item.id, label: `${item.product_name} · ${item.name}` })) })}<div class="form-grid">${formField('Plan name', 'name', 'text', { value: plan.name })}${formField('Billing interval', 'interval', 'select', { selected: plan.interval, choices: [{ value: 'monthly', label: 'Monthly' }, { value: 'yearly', label: 'Yearly' }] })}</div><div class="form-grid">${formField('Price (USD)', 'price', 'number', { value: (plan.price_cents / 100).toFixed(2), min: 0, step: 0.01 })}${formField('Tax rate (%)', 'tax_percent', 'number', { value: String(plan.tax_percent), min: 0, max: 100, step: 0.01 })}</div>${formField('Discount (%)', 'discount_percent', 'number', { value: String(plan.discount_percent), min: 0, max: 100, step: 0.01 })}`,
    'Save changes');
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
      await api(`/api/products/${action.split(':')[1]}`, { method: 'PUT', body: payload });
      await renderCatalog();
      toast('Product updated.');
    } else if (action === 'product-create') {
      await api('/api/products', { method: 'POST', body: payload });
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
      await api('/api/plans', { method: 'POST', body: { ...payload, price_cents: toNonNegativeCents(payload.price), tax_percent: Number(payload.tax_percent), discount_percent: Number(payload.discount_percent) } });
      await renderCatalog();
      toast('Subscription plan created.');
    } else if (action.startsWith('plan-edit:')) {
      await api(`/api/plans/${action.split(':')[1]}`, { method: 'PUT', body: { ...payload, price_cents: toNonNegativeCents(payload.price), tax_percent: Number(payload.tax_percent), discount_percent: Number(payload.discount_percent) } });
      await renderCatalog();
      toast('Subscription plan updated.');
    } else if (action === 'subscription-create') {
      const result = await api('/api/subscriptions', { method: 'POST', body: { customer_id: Number(payload.customer_id), plan_id: Number(payload.plan_id) } });
      await navigate('subscriptions');
      toast(`Subscription created · invoice ${result.invoice.invoice_number} generated.`);
    } else if (action.startsWith('payment:')) {
      const id = action.split(':')[1];
      await api(`/api/invoices/${id}/payments`, { method: 'POST', body: { amount_cents: toCents(payload.amount), method: payload.method, reference: payload.reference } });
      await renderInvoices();
      toast('Payment recorded and invoice balance updated.');
    }
    modalRoot.innerHTML = '';
  } catch (error) {
    errorNode.textContent = error.message;
    submit.disabled = false;
    submit.textContent = submit.dataset.originalLabel || 'Save';
  }
}

document.addEventListener('click', async (event) => {
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
    if (action === 'new-customer') openCustomerForm();
    else if (action === 'edit-customer') openCustomerForm(state.customers.find((item) => Number(item.id) === Number(button.dataset.id)));
    else if (action === 'edit-product') openEditProductForm(state.catalog.products.find((item) => Number(item.id) === Number(button.dataset.id)));
    else if (action === 'edit-variant') openEditVariantForm(state.catalog.variants.find((item) => Number(item.id) === Number(button.dataset.id)));
    else if (action === 'edit-plan') openEditPlanForm(state.catalog.plans.find((item) => Number(item.id) === Number(button.dataset.id)));
    else if (action === 'new-product') openProductForm();
    else if (action === 'new-variant') openVariantForm(button.dataset.productId);
    else if (action === 'new-plan') openPlanForm();
    else if (action === 'new-subscription') {
      if (!state.customers.length) state.customers = await api('/api/customers');
      if (!state.catalog.plans.length) state.catalog = await api('/api/catalog');
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
      .then((result) => setAuthenticated(result.email))
      .catch((error) => { errorNode.textContent = error.message; });
  } else if (event.target.matches('[data-form-action]')) {
    event.preventDefault();
    submitForm(event.target);
  }
});

document.getElementById('logoutButton').addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
    setAuthenticated('');
  } catch (error) {
    toast(error.message, true);
  }
});
document.getElementById('menuToggle').addEventListener('click', () => document.getElementById('sidebar').classList.toggle('open'));
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
  .then((result) => setAuthenticated(result.authenticated ? result.email : ''))
  .catch((error) => {
    document.getElementById('loginScreen').hidden = false;
    document.getElementById('loginError').textContent = error.message;
  });

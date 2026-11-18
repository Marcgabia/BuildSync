document.addEventListener('change', (event) => {
  if (!event.target.matches('.js-auto-submit')) return;
  const form = event.target.form;
  if (form) form.requestSubmit();
});

document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!form.matches('.js-confirm')) return;
  const message = form.dataset.confirm || 'Are you sure you want to continue?';
  if (!window.confirm(message)) event.preventDefault();
});

/* Confirmation for individual submit buttons (e.g. Reject / Cancel inside a shared form). */
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-confirm-click]');
  if (!button) return;
  if (!window.confirm(button.dataset.confirmClick)) event.preventDefault();
});

/* Loading indicator: disable the submit button once a form is really submitted. */
document.addEventListener('submit', (event) => {
  const form = event.target;
  if (event.defaultPrevented || form.method.toLowerCase() === 'get' || form.matches('.js-no-loading')) return;
  const button = event.submitter || form.querySelector('[type="submit"]');
  if (button) {
    // The submitter's name/value is captured synchronously; disabling afterwards is safe.
    window.setTimeout(() => {
      button.disabled = true;
      button.classList.add('is-loading');
    }, 0);
  }
});

/* Print / save as PDF buttons. */
document.addEventListener('click', (event) => {
  if (event.target.closest('.js-print')) {
    event.preventDefault();
    window.print();
  }
});

/* Navigate when a selector with data-navigate changes (e.g. choose a PO to receive). */
document.addEventListener('change', (event) => {
  const select = event.target.closest('[data-navigate]');
  if (!select || !select.value) return;
  window.location.href = select.dataset.navigate + encodeURIComponent(select.value);
});

/* ---------- Dynamic line items with live (display-only) totals ---------- */
const peso = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' });

function recalc(container) {
  const form = container.closest('form');
  let subtotalCents = 0;
  container.querySelectorAll('tbody tr').forEach((row) => {
    const qty = Number(row.querySelector('[name="quantity"]')?.value || 0);
    const price = Number(row.querySelector('[name="unit_price"]')?.value || 0);
    const cents = Math.round(price * 100) * (Number.isFinite(qty) ? Math.max(qty, 0) : 0);
    subtotalCents += cents;
    const cell = row.querySelector('.js-line-total');
    if (cell) cell.textContent = peso.format(cents / 100);
  });
  const box = form && form.querySelector('.js-totals');
  if (!box) return;
  const discountCents = Math.round(Number(form.querySelector('[name="discount_amount"]')?.value || 0) * 100);
  const taxRate = Number(form.querySelector('[name="tax_rate"]')?.value || 0);
  const taxable = Math.max(subtotalCents - discountCents, 0);
  const taxCents = Math.round(taxable * taxRate / 100);
  const set = (key, cents) => {
    const el = box.querySelector(`[data-total="${key}"]`);
    if (el) el.textContent = peso.format(cents / 100);
  };
  set('subtotal', subtotalCents);
  set('discount', discountCents);
  set('tax', taxCents);
  set('total', taxable + taxCents);
}

document.querySelectorAll('.js-line-items').forEach((container) => {
  const body = container.querySelector('tbody');
  const template = container.querySelector('template');
  const form = container.closest('form');

  container.addEventListener('click', (event) => {
    const remove = event.target.closest('.js-remove-line');
    if (!remove) return;
    event.preventDefault();
    if (body.querySelectorAll('tr').length > 1) {
      remove.closest('tr').remove();
    } else {
      remove.closest('tr').querySelectorAll('input, select').forEach((input) => { input.value = ''; });
    }
    recalc(container);
  });

  const addButton = form && form.querySelector('.js-add-line');
  if (addButton) {
    addButton.addEventListener('click', (event) => {
      event.preventDefault();
      body.appendChild(template.content.cloneNode(true));
      recalc(container);
    });
  }

  container.addEventListener('change', (event) => {
    const select = event.target.closest('select[name="product_id"]');
    if (select) {
      const option = select.selectedOptions[0];
      const price = select.closest('tr').querySelector('[name="unit_price"]');
      if (option && option.dataset.price && price && !price.dataset.touched) price.value = option.dataset.price;
    }
    recalc(container);
  });
  container.addEventListener('input', (event) => {
    if (event.target.name === 'unit_price') event.target.dataset.touched = '1';
    recalc(container);
  });
  if (form) {
    form.addEventListener('input', (event) => {
      if (['discount_amount', 'tax_rate'].includes(event.target.name)) recalc(container);
    });
  }
  recalc(container);
});

/* ---------- Mobile navigation drawer ---------- */
function setNav(open) {
  document.body.classList.toggle('nav-open', open);
  document.querySelectorAll('.js-nav-toggle').forEach((button) => {
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  });
}
document.addEventListener('click', (event) => {
  if (event.target.closest('.js-nav-toggle')) setNav(!document.body.classList.contains('nav-open'));
  else if (event.target.closest('.js-nav-close')) setNav(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.body.classList.contains('nav-open')) setNav(false);
});

/* ---------- Show / hide password fields ----------
   The toggle button lives next to (not inside) the input's <label>, so the click
   always reaches this handler. preventDefault stops any surrounding form/label behavior. */
document.addEventListener('click', (event) => {
  const toggle = event.target.closest('.js-toggle-password');
  if (!toggle) return;
  event.preventDefault();
  const input = document.getElementById(toggle.getAttribute('aria-controls'));
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  toggle.setAttribute('aria-pressed', String(show));
  toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  const label = toggle.querySelector('.js-toggle-label');
  if (label) label.textContent = show ? 'Hide' : 'Show';
  // Keep the cursor in the field at the end of the text.
  input.focus();
  const end = input.value.length;
  try { input.setSelectionRange(end, end); } catch { /* some input types do not support selection */ }
});
// Never submit a form with the password still visible in the browser's form history.
document.addEventListener('submit', (event) => {
  event.target.querySelectorAll('.password-field input[type="text"]').forEach((input) => { input.type = 'password'; });
}, true);

/* ---------- Light / dark theme ----------
   The choice is stored in a cookie so the server renders the right theme on the next
   page load (no flash). Without a saved choice the operating-system setting is used. */
const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
function effectiveTheme() {
  const saved = document.documentElement.getAttribute('data-theme');
  if (saved === 'dark' || saved === 'light') return saved;
  return darkQuery && darkQuery.matches ? 'dark' : 'light';
}
function syncThemeButtons() {
  const dark = effectiveTheme() === 'dark';
  document.querySelectorAll('.js-theme-toggle').forEach((button) => {
    button.setAttribute('aria-pressed', String(dark));
    button.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    button.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
  });
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0b0f14' : '#111827');
}
document.addEventListener('click', (event) => {
  if (!event.target.closest('.js-theme-toggle')) return;
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  document.cookie = `buildsync_theme=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
  syncThemeButtons();
});
if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener('change', syncThemeButtons);
syncThemeButtons();

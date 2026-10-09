/* ═══════════════════════════════════════════════════════════════════
   CashFlow – script.js
   Salary & Expense Tracker — Vanilla JS, fully modular

   ARCHITECTURE (modules defined in dependency order):
   ─────────────────────────────────────────────────────
   1.  STATE        → Single source of truth (salary, expenses, chart, currency, fx)
   2.  Storage      → localStorage serialize / deserialize helpers
   3.  Validation   → Input guard functions (parseFloat-based)
   4.  Calc         → Pure computation helpers (totals, balance, health %)
   5.  Currency     → Frankfurter API fetch + symbol/conversion helpers
   6.  ChartManager → Chart.js lifecycle (render + CRITICAL destroy-before-redraw)
   7.  DOM          → All DOM reads/writes, element cache, formatters
   8.  Actions      → User-initiated mutations (setSalary, addExpense, deleteExpense)
   9.  PDF          → jsPDF report generation
   10. Init         → Boot sequence + centralised event binding

   ═══════════════════════════════════════════════════════════════════ */

'use strict';

/* ─────────────────────────────────────────────────────────────────
   1. STATE — Single Source of Truth
   Every piece of mutable data lives here. No module stores its own
   state; they read/write STATE properties directly.
   ───────────────────────────────────────────────────────────────── */
const STATE = {
  /** Monthly salary in USD (always stored in base USD, converted for display) */
  salary: 0,

  /**
   * Array of expense objects.
   * Each object: { id: string, name: string, amount: number, date: string }
   * `amount` is always stored in USD.
   */
  expenses: [],

  /**
   * Reference to the active Chart.js instance.
   * CRITICAL: Must be destroyed before creating a new chart to avoid
   * the "canvas is already in use" error.
   */
  chartInstance: null,

  /** Active display currency: 'USD' | 'INR' */
  currency: 'USD',

  /** USD → INR conversion rate fetched from the Frankfurter API */
  fxRate: 83.0,

  /** Whether the FX rate has been successfully fetched (or fallen back) */
  fxReady: false,
};


/* ─────────────────────────────────────────────────────────────────
   2. Storage — localStorage Helpers
   Serialises/deserialises STATE to persist across page reloads.
   Keys: 'cf_salary' (number), 'cf_expenses' (JSON array)
   ───────────────────────────────────────────────────────────────── */
const Storage = {
  KEYS: {
    SALARY:   'cf_salary',
    EXPENSES: 'cf_expenses',
  },

  /**
   * Persist current STATE to localStorage.
   * JSON.stringify() serialises the expenses array to a JSON string.
   */
  save() {
    localStorage.setItem(this.KEYS.SALARY,   STATE.salary);
    localStorage.setItem(this.KEYS.EXPENSES, JSON.stringify(STATE.expenses));
  },

  /**
   * Restore STATE from localStorage on page load.
   * JSON.parse() deserialises the JSON string back to an object array.
   * parseFloat() is used to coerce the stored salary string to a number.
   * Gracefully handles missing or corrupted data.
   */
  load() {
    // ── Salary ────────────────────────────────────────────────────
    const rawSalary = localStorage.getItem(this.KEYS.SALARY);
    // parseFloat() guards against string concatenation if value was stored oddly
    STATE.salary = rawSalary !== null ? parseFloat(rawSalary) : 0;
    if (isNaN(STATE.salary) || STATE.salary < 0) STATE.salary = 0; // safety guard

    // ── Expenses ──────────────────────────────────────────────────
    const rawExpenses = localStorage.getItem(this.KEYS.EXPENSES);
    if (rawExpenses) {
      try {
        const parsed = JSON.parse(rawExpenses); // deserialise array
        // Validate the parsed result is actually an array before accepting
        STATE.expenses = Array.isArray(parsed) ? parsed : [];
      } catch (err) {
        console.warn('[CashFlow] Corrupted expense data in localStorage. Resetting.', err);
        STATE.expenses = [];
      }
    }
  },

  /** Clear all persisted data (used for a full reset) */
  clear() {
    localStorage.removeItem(this.KEYS.SALARY);
    localStorage.removeItem(this.KEYS.EXPENSES);
  },
};


/* ─────────────────────────────────────────────────────────────────
   3. Validation — Input Guard Functions
   Returns plain objects { valid: boolean, value?: number } so callers
   can decide how to proceed without coupling to DOM.
   ───────────────────────────────────────────────────────────────── */
const Validation = {
  /**
   * Validate a salary input string.
   * parseFloat() prevents string concatenation bugs.
   * @param   {string} raw – Raw input value string
   * @returns {{ valid: boolean, value: number }}
   */
  salary(raw) {
    const value = parseFloat(raw); // always use parseFloat for numeric fields
    if (raw.trim() === '' || isNaN(value) || value < 0) {
      return { valid: false, value: 0 };
    }
    return { valid: true, value };
  },

  /**
   * Validate an expense name string.
   * @param   {string} name
   * @returns {{ valid: boolean }}
   */
  expenseName(name) {
    return { valid: name.trim().length > 0 };
  },

  /**
   * Validate an expense amount string.
   * Must be > 0 (zero-value expenses are meaningless).
   * parseFloat() prevents string concatenation bugs.
   * @param   {string} raw
   * @returns {{ valid: boolean, value: number }}
   */
  expenseAmount(raw) {
    const value = parseFloat(raw); // always use parseFloat for numeric fields
    if (raw.trim() === '' || isNaN(value) || value <= 0) {
      return { valid: false, value: 0 };
    }
    return { valid: true, value };
  },
};


/* ─────────────────────────────────────────────────────────────────
   4. Calc — Pure Computation Helpers
   No side-effects. All functions read from STATE and return values.
   ───────────────────────────────────────────────────────────────── */
const Calc = {
  /** @returns {number} Sum of all expense amounts (USD) */
  totalExpenses() {
    return STATE.expenses.reduce((sum, exp) => sum + exp.amount, 0);
  },

  /**
   * @returns {number} Remaining balance (may be negative if overspent)
   *  Formula: Total Salary − Total Expenses = Remaining Balance
   */
  remainingBalance() {
    return STATE.salary - this.totalExpenses();
  },

  /**
   * Threshold alert: fires when remaining balance < 10% of salary.
   * @returns {boolean}
   */
  isCritical() {
    if (STATE.salary <= 0) return false;
    return this.remainingBalance() < STATE.salary * 0.10;
  },

  /**
   * Financial health as a clamped 0–100 percentage.
   * Represents the fraction of salary still remaining.
   * @returns {number}
   */
  healthPercent() {
    if (STATE.salary <= 0) return 100; // no salary set → full bar
    const pct = (this.remainingBalance() / STATE.salary) * 100;
    return Math.max(0, Math.min(100, pct)); // clamp to [0, 100]
  },
};


/* ─────────────────────────────────────────────────────────────────
   5. Currency — Frankfurter API + Toggle Logic
   Fetches live USD→INR rate. Converts and formats amounts for display.
   ───────────────────────────────────────────────────────────────── */
const Currency = {
  /** Frankfurter API endpoint for USD → INR */
  API_URL: 'https://api.frankfurter.app/latest?from=USD&to=INR',

  /**
   * Fetch the live USD → INR exchange rate from the Frankfurter API.
   * Non-blocking: called without await during boot so UI renders immediately.
   * Falls back to 83.00 if the network request fails.
   */
  async fetchRate() {
    try {
      const res  = await fetch(this.API_URL);
      if (!res.ok) throw new Error(`Frankfurter API returned HTTP ${res.status}`);
      const data = await res.json();

      STATE.fxRate  = data.rates.INR; // e.g. 83.74
      STATE.fxReady = true;

      // Display the fetched rate in the header
      DOM.setFxLabel(`1 USD = ₹${STATE.fxRate.toFixed(2)}`);
      console.log(`[CashFlow] FX rate loaded: 1 USD = ${STATE.fxRate} INR`);

      // If user has already toggled to INR before the rate arrived, re-render
      if (STATE.currency === 'INR') {
        DOM.renderAll();
        ChartManager.render();
      }
    } catch (err) {
      // Offline / API down — use a sensible fallback
      console.warn('[CashFlow] FX rate fetch failed. Falling back to 83.00.', err);
      STATE.fxRate  = 83.00;
      STATE.fxReady = true;
      DOM.setFxLabel('1 USD ≈ ₹83.00 (offline)');
    }
  },

  /**
   * Convert a USD amount to the currently active display currency.
   * @param   {number} usd
   * @returns {number}
   */
  convert(usd) {
    return STATE.currency === 'INR' ? usd * STATE.fxRate : usd;
  },

  /**
   * Return the currency symbol for the active currency.
   * @returns {'$' | '₹'}
   */
  symbol() {
    return STATE.currency === 'INR' ? '₹' : '$';
  },

  /**
   * Toggle between USD and INR, then re-render the entire UI.
   * Called by Actions.toggleCurrency().
   */
  toggle() {
    // Flip the currency
    STATE.currency = STATE.currency === 'USD' ? 'INR' : 'USD';

    // Update every currency symbol in the DOM
    const sym = this.symbol();
    document.querySelectorAll('.cur-sym').forEach(el => { el.textContent = sym; });
    document.getElementById('salaryPfx').textContent  = sym;
    document.getElementById('expensePfx').textContent = sym;

    // Re-render all monetary displays and redraw the chart
    DOM.renderAll();
    ChartManager.render();
  },
};


/* ─────────────────────────────────────────────────────────────────
   6. ChartManager — Chart.js Lifecycle Management
   CRITICAL CONTRACT: Always call STATE.chartInstance.destroy() before
   creating a new Chart instance to prevent canvas duplication errors.
   ───────────────────────────────────────────────────────────────── */
const ChartManager = {
  /**
   * Render (or re-render) the doughnut chart.
   *
   * Step 1 – DESTROY: If a Chart.js instance already exists in STATE,
   *   call its .destroy() method. This removes the canvas binding and
   *   frees memory. Skipping this step causes the "canvas already in use"
   *   error and corrupts subsequent renders.
   *
   * Step 2 – GUARD: If no salary is set, show the overlay and return early.
   *
   * Step 3 – CREATE: Build a fresh Chart instance and save the reference
   *   to STATE.chartInstance so it can be destroyed on the next render.
   */
  render() {
    const canvas = document.getElementById('expenseChart');
    const ctx    = canvas.getContext('2d');

    // ── STEP 1: DESTROY previous instance ─────────────────────────
    // This is the CRITICAL step that prevents canvas duplication errors.
    if (STATE.chartInstance !== null) {
      STATE.chartInstance.destroy();
      STATE.chartInstance = null; // clear the reference
    }

    // ── STEP 2: GUARD – nothing to draw without a salary ──────────
    const salary    = STATE.salary;
    const totalExp  = Calc.totalExpenses();
    const remaining = Calc.remainingBalance();

    if (salary <= 0) {
      DOM.setChartOverlay(true);
      document.getElementById('chartLegend').classList.add('hidden');
      return;
    }

    // We have data – hide the placeholder overlay
    DOM.setChartOverlay(false);

    // Compute display values in the active currency
    const sym      = Currency.symbol();
    const mult     = STATE.currency === 'INR' ? STATE.fxRate : 1;
    const expDisp  = (totalExp  * mult).toFixed(2);
    const balDisp  = (Math.max(remaining, 0) * mult).toFixed(2);

    // ── STEP 3: CREATE new Chart.js instance ─────────────────────
    STATE.chartInstance = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: [
          `Expenses (${sym}${Number(expDisp).toLocaleString('en-IN')})`,
          `Balance (${sym}${Number(balDisp).toLocaleString('en-IN')})`,
        ],
        datasets: [{
          // When there are no expenses, show 100% balance
          data: [
            totalExp > 0          ? totalExp           : 0,
            Math.max(remaining, 0) > 0 ? Math.max(remaining, 0) : salary,
          ],
          backgroundColor: [
            'rgba(251, 113, 133, 0.88)',  // rose – expenses
            'rgba(74,  222, 128, 0.88)',  // green – balance
          ],
          borderColor: [
            'rgba(251, 113, 133, 1)',
            'rgba(74,  222, 128, 1)',
          ],
          borderWidth: 2,
          hoverOffset: 12,
          hoverBorderWidth: 3,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '64%', // doughnut hole – larger = thinner ring
        plugins: {
          legend: { display: false }, // we render our own legend below the chart
          tooltip: {
            backgroundColor: 'rgba(15, 22, 35, 0.95)',
            titleColor: '#f1f5f9',
            bodyColor:  '#94a3b8',
            borderColor: 'rgba(255,255,255,0.1)',
            borderWidth: 1,
            padding: 12,
            cornerRadius: 8,
            callbacks: {
              // Show the value in the active currency inside the tooltip
              label: (ctx) => {
                const val = (ctx.raw * mult).toLocaleString('en-IN', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                });
                return `  ${sym}${val}`;
              },
            },
          },
        },
        animation: {
          animateRotate: true,
          animateScale:  false,
          duration: 650,
          easing: 'easeInOutQuart',
        },
      },
    });

    // Update the custom legend beneath the chart
    DOM.updateChartLegend(expDisp, balDisp, sym);
  },
};


/* ─────────────────────────────────────────────────────────────────
   7. DOM — All DOM Read/Write Operations
   This module owns every getElementById, textContent assignment, and
   classList mutation. Keeps presentation cleanly separated from state.
   ───────────────────────────────────────────────────────────────── */
const DOM = {
  /** Cached element references (populated by DOM.cache() at boot) */
  el: {},

  /**
   * Cache all frequently-accessed elements once at boot.
   * Avoids repeated getElementById calls on every re-render.
   */
  cache() {
    const $ = id => document.getElementById(id);
    this.el = {
      // ── Forms ────────────────────────────────────────
      salaryInput:        $('salaryInput'),
      salaryError:        $('salaryError'),
      setSalaryBtn:       $('setSalaryBtn'),

      expenseNameInput:   $('expenseNameInput'),
      expenseNameError:   $('expenseNameError'),
      expenseAmountInput: $('expenseAmountInput'),
      expenseAmountError: $('expenseAmountError'),
      addExpenseBtn:      $('addExpenseBtn'),

      // ── Summary Values ───────────────────────────────
      salaryVal:          $('salaryVal'),
      expensesVal:        $('expensesVal'),
      balanceVal:         $('balanceVal'),
      displayBalance:     $('displayBalance'),   // the entire <p> (for class toggling)

      // ── Equation Bar ─────────────────────────────────
      eqSalary:           $('eqSalary'),
      eqExpenses:         $('eqExpenses'),
      eqBalance:          $('eqBalance'),

      // ── Expense List ─────────────────────────────────
      expenseList:        $('expenseList'),
      expenseCount:       $('expenseCount'),
      emptyState:         $('emptyState'),

      // ── Warning Banner ───────────────────────────────
      warningBanner:      $('warningBanner'),
      closeBanner:        $('closeBanner'),

      // ── Health Bar ───────────────────────────────────
      healthBar:          $('healthBar'),
      healthLabel:        $('healthLabel'),
      healthTrack:        document.querySelector('.health-track'),

      // ── Chart ────────────────────────────────────────
      chartOverlay:       $('chartOverlay'),
      chartLegend:        $('chartLegend'),
      legendExpenses:     $('legendExpenses'),
      legendBalance:      $('legendBalance'),

      // ── Header ───────────────────────────────────────
      fxRateLabel:        $('fxRateLabel'),
      currencyToggle:     $('currencyToggle'),

      // ── PDF Button ───────────────────────────────────
      downloadPdfBtn:     $('downloadPdfBtn'),
    };
  },

  /* ── Number Formatting ──────────────────────────────────────── */

  /**
   * Format a USD number for display in the active currency.
   * Uses en-IN locale for comma formatting (works well for INR too).
   * @param   {number} usd
   * @returns {string} e.g. "1,23,456.78" (INR) or "1,234.56" (USD)
   */
  fmt(usd) {
    const converted = Currency.convert(usd);
    return converted.toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  },

  /**
   * Build a full currency string with active symbol.
   * @param   {number} usd
   * @returns {string} e.g. "$1,234.56" or "₹1,03,456.00"
   */
  fmtFull(usd) {
    return `${Currency.symbol()}${this.fmt(usd)}`;
  },

  /* ── Full Re-render ─────────────────────────────────────────── */

  /** Re-render all summary, equation, threshold, and health sections */
  renderAll() {
    this.renderSummary();
    this.renderEquation();
    this.checkThreshold();
    this.renderHealthBar();
    this.renderExpenseList(); // amounts need currency update
  },

  /* ── Summary Cards ──────────────────────────────────────────── */

  /** Update the three summary card values */
  renderSummary() {
    const salary  = STATE.salary;
    const totalEx = Calc.totalExpenses();
    const balance = Calc.remainingBalance();

    this.el.salaryVal.textContent   = this.fmt(salary);
    this.el.expensesVal.textContent = this.fmt(totalEx);
    this.el.balanceVal.textContent  = this.fmt(balance);
  },

  /* ── Equation Bar ───────────────────────────────────────────── */

  /** Update Salary − Expenses = Balance equation display */
  renderEquation() {
    const salary  = STATE.salary;
    const totalEx = Calc.totalExpenses();
    const balance = Calc.remainingBalance();

    this.el.eqSalary.textContent   = this.fmtFull(salary);
    this.el.eqExpenses.textContent = this.fmtFull(totalEx);
    this.el.eqBalance.textContent  = this.fmtFull(balance);
  },

  /* ── Threshold Alert ────────────────────────────────────────── */

  /**
   * Phase 3 – Threshold Alert:
   * If remaining balance < 10% of salary → turn balance RED + show banner.
   * Removes these states if the threshold is no longer breached.
   */
  checkThreshold() {
    const critical = Calc.isCritical();
    const banner   = this.el.warningBanner;
    const balEl    = this.el.displayBalance;

    if (critical) {
      // Show the sticky red banner at the top of the page
      banner.classList.remove('hidden');
      // Turn the balance value text red (with pulsing glow animation via CSS)
      balEl.classList.add('balance-critical');
    } else {
      banner.classList.add('hidden');
      balEl.classList.remove('balance-critical');
    }
  },

  /* ── Health Bar ─────────────────────────────────────────────── */

  /** Update the gradient progress bar and status label */
  renderHealthBar() {
    const pct   = Calc.healthPercent();
    const bar   = this.el.healthBar;
    const label = this.el.healthLabel;

    // Set bar width (CSS transition handles the animation)
    bar.style.width = `${pct}%`;

    // Update aria attribute for accessibility
    this.el.healthTrack && this.el.healthTrack.setAttribute('aria-valuenow', pct.toFixed(0));

    // Determine status text and colour
    let text, color;
    if (pct >= 50) {
      text  = `Excellent (${pct.toFixed(0)}%)`;
      color = '#4ade80'; // green
    } else if (pct >= 20) {
      text  = `Moderate (${pct.toFixed(0)}%)`;
      color = '#fbbf24'; // amber
    } else {
      text  = `Critical (${pct.toFixed(0)}%)`;
      color = '#ef4444'; // red
    }

    label.textContent  = text;
    label.style.color  = color;
  },

  /* ── Expense List ───────────────────────────────────────────── */

  /**
   * Full re-render of the expense <ul>.
   * Called on page load and after currency toggles.
   */
  renderExpenseList() {
    const list = this.el.expenseList;
    list.innerHTML = ''; // clear existing DOM nodes

    if (STATE.expenses.length === 0) {
      this.el.emptyState.classList.remove('hidden');
      this.el.expenseCount.textContent = '0 items';
      return;
    }

    this.el.emptyState.classList.add('hidden');
    this.updateExpenseCount();

    // Render each expense without animation delay (bulk load)
    STATE.expenses.forEach(exp => this._appendItemToList(exp, false));
  },

  /**
   * Append a single newly-added expense <li> to the DOM.
   * Uses the same helper as renderExpenseList but with animation enabled.
   * @param {object} exp – Expense object
   */
  addItemToList(exp) {
    this.el.emptyState.classList.add('hidden');
    this.updateExpenseCount();
    this._appendItemToList(exp, true);
  },

  /**
   * Internal helper: build and append an expense <li>.
   * @param {object}  exp       – Expense object
   * @param {boolean} animate   – Whether to apply the slide-up animation
   */
  _appendItemToList(exp, animate) {
    const li       = document.createElement('li');
    li.className   = 'expense-item';
    li.dataset.id  = exp.id;

    // Optionally suppress animation for bulk re-renders
    if (!animate) li.style.animationDuration = '0ms';

    li.innerHTML = `
      <div class="expense-item-left">
        <span class="expense-dot" aria-hidden="true"></span>
        <div style="min-width:0;">
          <p class="expense-name" title="${this._escHtml(exp.name)}">${this._escHtml(exp.name)}</p>
          <p class="expense-date">${exp.date}</p>
        </div>
      </div>
      <span class="expense-amount">${Currency.symbol()}${this.fmt(exp.amount)}</span>
      <button
        class="btn-delete"
        data-id="${exp.id}"
        title="Delete ${this._escHtml(exp.name)}"
        aria-label="Delete expense: ${this._escHtml(exp.name)}"
      >
        <!-- Trash icon (inline SVG) -->
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"
             fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round"
            d="M19 7l-.867 12.142A2 2 0 0116.138 21
               H7.862a2 2 0 01-1.995-1.858L5 7
               m5 4v6m4-6v6
               m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3
               M4 7h16"/>
        </svg>
      </button>
    `;

    // Bind delete handler directly on the button (avoids event delegation issues)
    li.querySelector('.btn-delete').addEventListener('click', () => {
      Actions.deleteExpense(exp.id, li);
    });

    this.el.expenseList.appendChild(li);
  },

  /** Update the item-count badge in the ledger header */
  updateExpenseCount() {
    const n = STATE.expenses.length;
    this.el.expenseCount.textContent = `${n} item${n !== 1 ? 's' : ''}`;
  },

  /* ── Chart Helpers ──────────────────────────────────────────── */

  /**
   * Show or hide the chart placeholder overlay.
   * @param {boolean} show
   */
  setChartOverlay(show) {
    if (show) {
      this.el.chartOverlay.classList.remove('hidden');
      this.el.chartOverlay.setAttribute('aria-hidden', 'false');
    } else {
      this.el.chartOverlay.classList.add('hidden');
      this.el.chartOverlay.setAttribute('aria-hidden', 'true');
    }
  },

  /**
   * Update the custom legend below the chart.
   * @param {string} expDisp  – Formatted expense amount string
   * @param {string} balDisp  – Formatted balance amount string
   * @param {string} sym      – Currency symbol
   */
  updateChartLegend(expDisp, balDisp, sym) {
    this.el.chartLegend.classList.remove('hidden');
    this.el.legendExpenses.textContent = `${sym}${Number(expDisp).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
    this.el.legendBalance.textContent  = `${sym}${Number(balDisp).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
  },

  /* ── Error State Helpers ────────────────────────────────────── */

  /**
   * Mark an input as invalid and show its associated error message.
   * @param {HTMLElement} input
   * @param {HTMLElement} errorEl
   */
  showError(input, errorEl) {
    input.classList.add('error');
    errorEl.classList.remove('hidden');
  },

  /**
   * Clear the error state from an input.
   * @param {HTMLElement} input
   * @param {HTMLElement} errorEl
   */
  clearError(input, errorEl) {
    input.classList.remove('error');
    errorEl.classList.add('hidden');
  },

  /* ── FX Rate Label ──────────────────────────────────────────── */

  /** Set the exchange-rate label in the header. @param {string} text */
  setFxLabel(text) {
    this.el.fxRateLabel.textContent = text;
  },

  /* ── Utility ────────────────────────────────────────────────── */

  /**
   * Escape HTML special characters to prevent XSS when injecting
   * user-provided text into innerHTML.
   * @param   {string} str
   * @returns {string}
   */
  _escHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  },
};


/* ─────────────────────────────────────────────────────────────────
   8. Actions — User-Initiated State Mutations
   Each function: validate → mutate STATE → persist → update DOM → re-draw chart.
   DOM manipulation is always delegated to the DOM module.
   ───────────────────────────────────────────────────────────────── */
const Actions = {
  /**
   * Handle "Set Salary" button click.
   * Validates input, updates STATE.salary, persists, re-renders.
   */
  setSalary() {
    const input   = DOM.el.salaryInput;
    const errorEl = DOM.el.salaryError;
    const result  = Validation.salary(input.value);

    if (!result.valid) {
      DOM.showError(input, errorEl);
      input.focus();
      return;
    }

    // ── Mutate state ───────────────────────────────────────────
    DOM.clearError(input, errorEl);
    STATE.salary = result.value; // already parseFloat'd by Validation.salary()

    // ── Persist to localStorage ────────────────────────────────
    Storage.save();

    // ── Update DOM ─────────────────────────────────────────────
    DOM.renderSummary();
    DOM.renderEquation();
    DOM.checkThreshold();
    DOM.renderHealthBar();

    // ── Re-draw chart (destroys old instance first) ────────────
    ChartManager.render();

    // Brief ring highlight on the salary card for visual feedback
    const card = DOM.el.salaryVal.closest('.summary-card');
    if (card) {
      card.style.outline = '2px solid rgba(96,165,250,0.6)';
      setTimeout(() => { card.style.outline = ''; }, 900);
    }
  },

  /**
   * Handle "Add Expense" button click.
   * Validates both fields, constructs an expense object, appends to STATE,
   * persists, updates the DOM list, recalculates, and redraws the chart.
   */
  addExpense() {
    const nameInput   = DOM.el.expenseNameInput;
    const amountInput = DOM.el.expenseAmountInput;
    const nameResult  = Validation.expenseName(nameInput.value);
    const amtResult   = Validation.expenseAmount(amountInput.value);

    // Show ALL errors simultaneously (no short-circuit)
    let isValid = true;
    if (!nameResult.valid) {
      DOM.showError(nameInput, DOM.el.expenseNameError);
      isValid = false;
    } else {
      DOM.clearError(nameInput, DOM.el.expenseNameError);
    }
    if (!amtResult.valid) {
      DOM.showError(amountInput, DOM.el.expenseAmountError);
      isValid = false;
    } else {
      DOM.clearError(amountInput, DOM.el.expenseAmountError);
    }

    if (!isValid) return;

    // ── Build expense object ───────────────────────────────────
    const expense = {
      // Unique ID: timestamp + short random string (collision-proof for client use)
      id:     `exp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name:   nameInput.value.trim(),
      // amtResult.value is already parseFloat'd by Validation.expenseAmount()
      amount: amtResult.value,
      // Human-readable date stamp
      date: new Date().toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
      }),
    };

    // ── Mutate state ───────────────────────────────────────────
    STATE.expenses.push(expense);

    // ── Persist to localStorage (JSON.stringify serialises the array) ─
    Storage.save();

    // ── Update DOM ─────────────────────────────────────────────
    DOM.addItemToList(expense);   // append new item (no full re-render)
    DOM.renderSummary();
    DOM.renderEquation();
    DOM.checkThreshold();
    DOM.renderHealthBar();

    // ── Re-draw chart (destroys old instance first) ────────────
    ChartManager.render();

    // ── Reset form ─────────────────────────────────────────────
    nameInput.value   = '';
    amountInput.value = '';
    nameInput.focus();
  },

  /**
   * Handle trash-icon click on an expense row.
   * Removes the expense from STATE and localStorage, animates removal
   * from the DOM, recalculates, and redraws the chart.
   *
   * @param {string}      id       – Unique expense ID
   * @param {HTMLElement} listItem – The <li> element to animate and remove
   */
  deleteExpense(id, listItem) {
    // ── Mutate state ───────────────────────────────────────────
    STATE.expenses = STATE.expenses.filter(exp => exp.id !== id);

    // ── Persist updated array to localStorage ──────────────────
    Storage.save();

    // ── Animate the <li> out, then remove it ──────────────────
    listItem.style.transition = 'opacity 0.22s ease, transform 0.22s ease';
    listItem.style.opacity    = '0';
    listItem.style.transform  = 'translateX(18px)';

    setTimeout(() => {
      listItem.remove();

      // Show empty state if list is now empty
      if (STATE.expenses.length === 0) {
        DOM.el.emptyState.classList.remove('hidden');
        DOM.el.expenseCount.textContent = '0 items';
      } else {
        DOM.updateExpenseCount();
      }

      // Recalculate and re-render after DOM update
      DOM.renderSummary();
      DOM.renderEquation();
      DOM.checkThreshold();
      DOM.renderHealthBar();
      ChartManager.render(); // destroys previous instance before redrawing
    }, 240);
  },

  /**
   * Handle currency toggle interaction.
   * Flips STATE.currency, updates all monetary displays, redraws chart.
   */
  toggleCurrency() {
    const track = DOM.el.currencyToggle;
    // Update the toggle's visual state
    track.classList.toggle('active');
    track.setAttribute('aria-checked', track.classList.contains('active').toString());
    // Delegate the actual currency switch to the Currency module
    Currency.toggle();
  },
};


/* ─────────────────────────────────────────────────────────────────
   9. PDF — jsPDF Report Generator
   Exports a styled A4 PDF with salary summary, expense table,
   and the net remaining balance. Uses the jsPDF UMD build
   available via window.jspdf.
   ───────────────────────────────────────────────────────────────── */
const PDF = {
  /**
   * Generate and trigger a PDF download of the current financial state.
   * Falls back gracefully if the jsPDF library is not available.
   */
  download() {
    // Guard: jsPDF must be available on the window object
    if (!window.jspdf || !window.jspdf.jsPDF) {
      alert('The PDF library could not be loaded. Please check your internet connection and try again.');
      return;
    }

    const { jsPDF }  = window.jspdf;
    const doc        = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    const pageW      = doc.internal.pageSize.getWidth();
    const pageH      = doc.internal.pageSize.getHeight();
    const margin     = 20;
    const usableW    = pageW - margin * 2;
    let   y          = 0; // current Y cursor

    // ── Utility: add a new page if remaining space is insufficient
    const ensureSpace = (needed) => {
      if (y + needed > pageH - 16) {
        doc.addPage();
        y = margin;
      }
    };

    // ── Computed values ────────────────────────────────────────
    const sym      = Currency.symbol();
    const mult     = STATE.currency === 'INR' ? STATE.fxRate : 1;
    const fmtAmt   = (usd) => (usd * mult).toLocaleString('en-IN', { minimumFractionDigits: 2 });
    const salary   = fmtAmt(STATE.salary);
    const totalEx  = fmtAmt(Calc.totalExpenses());
    const balance  = fmtAmt(Calc.remainingBalance());
    const critical = Calc.isCritical();

    // ── 1. HEADER BANNER ──────────────────────────────────────
    doc.setFillColor(8, 12, 24); // dark navy
    doc.rect(0, 0, pageW, 42, 'F');

    // App name
    doc.setTextColor(74, 222, 128); // green accent
    doc.setFontSize(24);
    doc.setFont('helvetica', 'bold');
    doc.text('CashFlow', margin, 18);

    // Sub-label
    doc.setTextColor(148, 163, 184);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text('Salary & Expense Report', margin, 27);

    // Meta info (right-aligned)
    const now = new Date().toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'short' });
    doc.text(`Generated: ${now}`, pageW - margin, 22, { align: 'right' });
    doc.text(`Currency: ${STATE.currency}`, pageW - margin, 29, { align: 'right' });

    y = 50;

    // ── 2. SUMMARY ROW ────────────────────────────────────────
    doc.setFillColor(31, 41, 55);
    doc.roundedRect(margin, y, usableW, 36, 3, 3, 'F');

    const colW = usableW / 3;

    // Salary column
    doc.setTextColor(96, 165, 250); // blue
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.text('TOTAL SALARY', margin + 6, y + 11);
    doc.setTextColor(241, 245, 249);
    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.text(`${sym}${salary}`, margin + 6, y + 24);

    // Expenses column
    const c2 = margin + colW;
    doc.setTextColor(251, 113, 133); // rose
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.text('TOTAL EXPENSES', c2, y + 11);
    doc.setTextColor(241, 245, 249);
    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.text(`${sym}${totalEx}`, c2, y + 24);

    // Balance column
    const c3 = margin + colW * 2;
    const balColor = critical ? [239, 68, 68] : [74, 222, 128];
    doc.setTextColor(...balColor);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.text('REMAINING BALANCE', c3, y + 11);
    doc.setTextColor(241, 245, 249);
    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.text(`${sym}${balance}`, c3, y + 24);

    y += 45;

    // ── 3. CRITICAL ALERT BANNER (if applicable) ──────────────
    if (critical) {
      ensureSpace(14);
      doc.setFillColor(127, 29, 29); // dark red
      doc.roundedRect(margin, y, usableW, 12, 2, 2, 'F');
      doc.setTextColor(252, 165, 165);
      doc.setFontSize(8.5);
      doc.setFont('helvetica', 'bold');
      doc.text(
        '⚠  CRITICAL ALERT: Remaining balance is below 10% of your total salary!',
        margin + 5, y + 8
      );
      y += 18;
    }

    // ── 4. EXPENSE TABLE ─────────────────────────────────────
    ensureSpace(20);

    // Section header
    doc.setTextColor(226, 232, 240);
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.text('Expense Breakdown', margin, y);
    y += 8;

    // Table header row
    doc.setFillColor(31, 41, 55);
    doc.rect(margin, y, usableW, 9, 'F');
    doc.setTextColor(100, 116, 139);
    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'bold');
    doc.text('#',            margin + 4,           y + 6);
    doc.text('EXPENSE NAME', margin + 14,          y + 6);
    doc.text('DATE',         margin + usableW * 0.55, y + 6);
    doc.text('AMOUNT',       pageW - margin - 4,   y + 6, { align: 'right' });
    y += 12;

    // Expense rows
    if (STATE.expenses.length === 0) {
      ensureSpace(10);
      doc.setTextColor(100, 116, 139);
      doc.setFontSize(9);
      doc.setFont('helvetica', 'italic');
      doc.text('No expenses have been recorded.', margin + 4, y);
      y += 12;
    } else {
      STATE.expenses.forEach((exp, i) => {
        ensureSpace(10);
        // Alternating row background
        if (i % 2 === 0) {
          doc.setFillColor(18, 26, 42);
          doc.rect(margin, y - 4.5, usableW, 9, 'F');
        }

        doc.setTextColor(226, 232, 240);
        doc.setFontSize(8.5);
        doc.setFont('helvetica', 'normal');
        doc.text(`${i + 1}`, margin + 4, y + 2);
        doc.text(exp.name.substring(0, 35), margin + 14, y + 2); // truncate long names
        doc.text(exp.date, margin + usableW * 0.55, y + 2);

        doc.setTextColor(251, 113, 133); // rose for amounts
        doc.setFont('helvetica', 'bold');
        doc.text(`${sym}${fmtAmt(exp.amount)}`, pageW - margin - 4, y + 2, { align: 'right' });

        y += 9;
      });
    }

    // ── 5. TOTAL ROW ─────────────────────────────────────────
    ensureSpace(18);
    y += 4;
    // Divider line in green
    doc.setDrawColor(74, 222, 128);
    doc.setLineWidth(0.5);
    doc.line(margin, y, pageW - margin, y);
    y += 7;

    doc.setTextColor(74, 222, 128);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text('Net Remaining Balance', margin + 4, y);
    doc.text(`${sym}${balance}`, pageW - margin - 4, y, { align: 'right' });

    // ── 6. FOOTER ON EVERY PAGE ───────────────────────────────
    const totalPages = doc.internal.getNumberOfPages();
    for (let p = 1; p <= totalPages; p++) {
      doc.setPage(p);
      doc.setFontSize(7);
      doc.setTextColor(100, 116, 139);
      doc.text(
        `CashFlow Report  ·  Page ${p} of ${totalPages}  ·  Generated by CashFlow Tracker`,
        pageW / 2,
        pageH - 8,
        { align: 'center' }
      );
    }

    // ── Trigger browser download ──────────────────────────────
    const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    doc.save(`CashFlow_Report_${dateStr}.pdf`);
  },
};


/* ─────────────────────────────────────────────────────────────────
   10. Init — Boot Sequence & Event Binding
   ───────────────────────────────────────────────────────────────── */
const Init = {
  /**
   * Application entry point.
   * Execution order matters: cache → load → bind → render → fetch FX.
   */
  async boot() {
    console.log('[CashFlow] Booting…');

    // 1. Cache all DOM element references
    DOM.cache();

    // 2. Restore persisted state from localStorage (JSON.parse on load)
    Storage.load();

    // 3. Bind all event listeners
    this.bindEvents();

    // 4. Render initial UI with restored data
    DOM.renderSummary();
    DOM.renderEquation();
    DOM.renderExpenseList();
    DOM.checkThreshold();
    DOM.renderHealthBar();
    ChartManager.render();

    // 5. Pre-fill salary input if a salary was previously stored
    if (STATE.salary > 0) {
      DOM.el.salaryInput.value = STATE.salary;
    }

    // 6. Fetch live FX rate (non-blocking; UI renders immediately above)
    Currency.fetchRate(); // returns a Promise we deliberately do not await

    console.log(
      `[CashFlow] Boot complete. Salary: ${STATE.salary} | Expenses: ${STATE.expenses.length}`
    );
  },

  /**
   * Centralised event listener registration.
   * All listeners are defined here for easy auditing of the event map.
   */
  bindEvents() {
    const el = DOM.el;

    // ── Salary Form ──────────────────────────────────────────
    el.setSalaryBtn.addEventListener('click',   Actions.setSalary);
    el.salaryInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') Actions.setSalary();
    });
    // Live validation: clear error as user types
    el.salaryInput.addEventListener('input', () => {
      if (el.salaryInput.value.trim()) DOM.clearError(el.salaryInput, el.salaryError);
    });

    // ── Expense Form ─────────────────────────────────────────
    el.addExpenseBtn.addEventListener('click', Actions.addExpense);

    // Tab-like flow: Enter on name field moves focus to amount field
    el.expenseNameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        el.expenseAmountInput.focus();
      }
    });
    // Enter on amount field submits the form
    el.expenseAmountInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') Actions.addExpense();
    });
    // Live validation
    el.expenseNameInput.addEventListener('input', () => {
      if (el.expenseNameInput.value.trim())
        DOM.clearError(el.expenseNameInput, el.expenseNameError);
    });
    el.expenseAmountInput.addEventListener('input', () => {
      if (el.expenseAmountInput.value.trim())
        DOM.clearError(el.expenseAmountInput, el.expenseAmountError);
    });

    // ── Currency Toggle ──────────────────────────────────────
    el.currencyToggle.addEventListener('click', Actions.toggleCurrency);
    // Keyboard accessibility: Space/Enter activates the toggle
    el.currencyToggle.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        Actions.toggleCurrency();
      }
    });

    // ── Warning Banner Dismiss ───────────────────────────────
    el.closeBanner.addEventListener('click', () => {
      el.warningBanner.classList.add('hidden');
    });

    // ── PDF Download ─────────────────────────────────────────
    el.downloadPdfBtn.addEventListener('click', () => PDF.download());
  },
};


/* ─────────────────────────────────────────────────────────────────
   BOOTSTRAP
   Wait for the DOM to be fully parsed before running Init.boot().
   ───────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => Init.boot());

/**
 * HOA API Performance Audit
 *
 * Phase 1 baseline: exercise the full HOA board flow against a running API and
 * capture latency percentiles per endpoint. Target threshold: 200 ms (configurable).
 *
 * Usage:
 *   HOA_PERF_EMAIL=board@example.com HOA_PERF_PASSWORD=secret npm run audit:hoa-api
 *
 * Optional env:
 *   HOA_PERF_BASE_URL     default http://localhost:5000/api/v1
 *   HOA_PERF_HOA_ID       skip /my-hoas lookup when set
 *   HOA_PERF_ITERATIONS   default 5 (per endpoint, for P50/P95/P99)
 *   HOA_PERF_THRESHOLD_MS default 200
 *   HOA_PERF_OUTPUT       JSON report path (default scripts/reports/hoa-api-perf-<timestamp>.json)
 *   HOA_PERF_WARMUP       default 1 (warmup iteration excluded from stats)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env.local') });
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const BASE_URL = (process.env.HOA_PERF_BASE_URL || 'http://127.0.0.1:5000/api/v1').replace(/\/$/, '');
const EMAIL = process.env.HOA_PERF_EMAIL || process.env.HOA_PERF_LOGIN_EMAIL;
const PASSWORD = process.env.HOA_PERF_PASSWORD || process.env.HOA_PERF_LOGIN_PASSWORD;
const ITERATIONS = Math.max(1, Number(process.env.HOA_PERF_ITERATIONS || 5));
const WARMUP = Math.max(0, Number(process.env.HOA_PERF_WARMUP ?? 1));
const THRESHOLD_MS = Number(process.env.HOA_PERF_THRESHOLD_MS || 200);
const TIMEOUT_MS = Number(process.env.HOA_PERF_TIMEOUT_MS || 30000);

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function summarizeTimings(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, n) => acc + n, 0);
  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    avg: sorted.length ? Math.round(sum / sorted.length) : 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

async function login() {
  if (!EMAIL || !PASSWORD) {
    throw new Error('Set HOA_PERF_EMAIL and HOA_PERF_PASSWORD (or HOA_PERF_LOGIN_* aliases)');
  }
  const res = await axios.post(`${BASE_URL}/auth/login`, { email: EMAIL, password: PASSWORD }, {
    timeout: TIMEOUT_MS,
    validateStatus: () => true,
  });
  if (res.status !== 200) {
    throw new Error(`Login failed (${res.status}): ${JSON.stringify(res.data)}`);
  }
  if (res.data?.mfaRequired && !res.data?.accessToken) {
    throw new Error('MFA required for perf audit account - use a trusted device or MFA-skipped test user');
  }
  const token = res.data?.accessToken || res.data?.token;
  if (!token) throw new Error('Login response missing accessToken');
  return token;
}

async function resolveHoaId(token) {
  if (process.env.HOA_PERF_HOA_ID) return process.env.HOA_PERF_HOA_ID;
  const res = await axios.get(`${BASE_URL}/hoa/board-members/my-hoas`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: TIMEOUT_MS,
  });
  const hoas = res.data?.data || res.data?.hoas || res.data || [];
  const list = Array.isArray(hoas) ? hoas : [];
  if (!list.length) throw new Error('No HOAs found for audit user');
  const first = list[0];
  return String(first.hoaId || first._id || first.id);
}

function buildClient(token, hoaId) {
  return axios.create({
    baseURL: BASE_URL,
    timeout: TIMEOUT_MS,
    headers: {
      Authorization: `Bearer ${token}`,
      'x-hoa-id': hoaId,
      'X-Requested-With': 'XMLHttpRequest',
    },
    validateStatus: () => true,
  });
}

/**
 * HOA flows to benchmark (read-heavy list/view paths + auth/session).
 * Mutating routes are intentionally omitted to avoid side effects during baseline runs.
 */
function buildScenarios(sampleIds = {}) {
  const { propertyId, ownerId, invoiceId, expenseId, vendorId, payeeId, maintenanceId } = sampleIds;
  const page = { pageNumber: 1, pageSize: 10 };

  const scenarios = [
    { module: 'Authentication', name: 'Session', method: 'GET', url: '/auth/session' },
    { module: 'Dashboard', name: 'Summary', method: 'GET', url: '/hoa/dashboard/summary', params: { preset: 'last_3_months' } },
    { module: 'Dashboard', name: 'Recent Activity', method: 'GET', url: '/hoa/dashboard/recent-activity' },
    { module: 'Dashboard', name: 'Activity Log', method: 'GET', url: '/hoa/dashboard/activity/recent', params: page },
    { module: 'Property', name: 'List', method: 'GET', url: '/hoa/property/properties', params: page },
    { module: 'Property', name: 'Search', method: 'GET', url: '/hoa/property/search', params: { search: 'unit', ...page } },
    { module: 'Property', name: 'Picker', method: 'GET', url: '/hoa/property/picker', params: { limit: 20 } },
    { module: 'Property', name: 'Portfolio Overview', method: 'GET', url: '/hoa/property/portfolio-overview' },
    { module: 'Owner', name: 'List', method: 'GET', url: '/hoa/owners/', params: page },
    { module: 'Owner', name: 'Picker', method: 'GET', url: '/hoa/owners/picker', params: { limit: 20 } },
    { module: 'Invoice', name: 'List', method: 'GET', url: '/hoa/invoice/', params: page },
    { module: 'Invoice', name: 'Statistics', method: 'GET', url: '/hoa/invoice/statistics', params: page },
    { module: 'Expense', name: 'List', method: 'GET', url: '/hoa/expense/', params: page },
    { module: 'Expense', name: 'Payee List', method: 'GET', url: '/hoa/expense/payees', params: page },
    { module: 'Vendor', name: 'List', method: 'GET', url: '/hoa/vendors/', params: page },
    { module: 'Vendor Invoice', name: 'Dashboard', method: 'GET', url: '/hoa/vendor-invoice/dashboard' },
    { module: 'Vendor Invoice', name: 'Received List', method: 'GET', url: '/hoa/vendor-invoice/received', params: page },
    { module: 'Vendor Invoice', name: 'Statistics', method: 'GET', url: '/hoa/vendor-invoice/statistics' },
    { module: 'Maintenance', name: 'List', method: 'GET', url: '/hoa/maintenance/request', params: page },
    { module: 'Documents', name: 'List', method: 'GET', url: '/documents/hoa/' },
    { module: 'HOA Fees', name: 'Settings', method: 'GET', url: '/hoa/hoa-settings/' },
    { module: 'Board Members', name: 'My HOAs', method: 'GET', url: '/hoa/board-members/my-hoas' },
    { module: 'Board Members', name: 'Members', method: 'GET', url: '/hoa/board-members/', params: page },
    { module: 'Settings', name: 'Billing Settings', method: 'GET', url: '/hoa/billing-settings/' },
    { module: 'Settings', name: 'Billing Effective', method: 'GET', url: '/hoa/billing-settings/effective' },
    { module: 'Users', name: 'Profile', method: 'GET', url: '/hoa/users/profile' },
    { module: 'Search', name: 'Property Filter', method: 'GET', url: '/hoa/property/properties', params: { ...page, search: 'a' } },
    { module: 'Search', name: 'Owner Filter', method: 'GET', url: '/hoa/owners/', params: { ...page, search: 'a' } },
    { module: 'Pagination', name: 'Property Page 2', method: 'GET', url: '/hoa/property/properties', params: { pageNumber: 2, pageSize: 10 } },
    { module: 'Pagination', name: 'Invoice Page 2', method: 'GET', url: '/hoa/invoice/', params: { pageNumber: 2, pageSize: 10 } },
  ];

  if (propertyId) {
    scenarios.push(
      { module: 'Property', name: 'Detail', method: 'GET', url: `/hoa/property/properties/${propertyId}` },
    );
  }
  if (ownerId) {
    scenarios.push({ module: 'Owner', name: 'Detail', method: 'GET', url: `/hoa/owners/${ownerId}` });
  }
  if (invoiceId) {
    scenarios.push({ module: 'Invoice', name: 'Detail', method: 'GET', url: `/hoa/invoice/${invoiceId}` });
  }
  if (expenseId) {
    scenarios.push({ module: 'Expense', name: 'Detail', method: 'GET', url: `/hoa/expense/${expenseId}` });
  }
  if (vendorId) {
    scenarios.push({ module: 'Vendor', name: 'Detail', method: 'GET', url: `/hoa/vendors/${vendorId}` });
  }
  if (payeeId) {
    scenarios.push({ module: 'Expense', name: 'Payee Detail', method: 'GET', url: `/hoa/expense/payees/${payeeId}` });
  }
  if (maintenanceId) {
    scenarios.push({ module: 'Maintenance', name: 'Detail', method: 'GET', url: `/hoa/maintenance/request/${maintenanceId}` });
  }

  return scenarios;
}

async function fetchSampleIds(client) {
  const ids = {};
  try {
    const [props, owners, invoices, expenses, vendors, payees, maintenance] = await Promise.all([
      client.get('/hoa/property/properties', { params: { pageNumber: 1, pageSize: 1 } }),
      client.get('/hoa/owners/', { params: { pageNumber: 1, pageSize: 1 } }),
      client.get('/hoa/invoice/', { params: { pageNumber: 1, pageSize: 1 } }),
      client.get('/hoa/expense/', { params: { pageNumber: 1, pageSize: 1 } }),
      client.get('/hoa/vendors/', { params: { pageNumber: 1, pageSize: 1 } }),
      client.get('/hoa/expense/payees', { params: { pageNumber: 1, pageSize: 1 } }),
      client.get('/hoa/maintenance/request', { params: { pageNumber: 1, pageSize: 1 } }),
    ]);
    const propRow = props.data?.data?.[0] || props.data?.data?.data?.[0];
    ids.propertyId = propRow?.id || propRow?._id;
    const ownerRow = owners.data?.data?.[0];
    ids.ownerId = ownerRow?._id || ownerRow?.id;
    const invRow = invoices.data?.data?.[0];
    ids.invoiceId = invRow?.id || invRow?._id;
    const expRow = expenses.data?.data?.[0];
    ids.expenseId = expRow?._id || expRow?.id;
    const vendorRow = (vendors.data?.data || vendors.data?.vendors || [])[0];
    ids.vendorId = vendorRow?._id || vendorRow?.id;
    const payeeRow = (payees.data?.data || payees.data?.payees || [])[0];
    ids.payeeId = payeeRow?._id || payeeRow?.id;
    const maintRow = (maintenance.data?.data || maintenance.data?.requests || [])[0];
    ids.maintenanceId = maintRow?._id || maintRow?.id;
  } catch {
    // sample ids are optional
  }
  return ids;
}

async function measureEndpoint(client, scenario) {
  const timings = [];
  const errors = [];
  let lastStatus = 0;
  let lastResponseBytes = 0;
  let lastRequestBytes = 0;

  const totalRuns = WARMUP + ITERATIONS;
  for (let i = 0; i < totalRuns; i++) {
    const start = Date.now();
    try {
      const res = await client.request({
        method: scenario.method,
        url: scenario.url,
        params: scenario.params,
        data: scenario.body,
      });
      const elapsed = Date.now() - start;
      lastStatus = res.status;
      lastResponseBytes = Buffer.byteLength(JSON.stringify(res.data || {}), 'utf8');
      lastRequestBytes = scenario.body ? Buffer.byteLength(JSON.stringify(scenario.body), 'utf8') : 0;
      if (i >= WARMUP) {
        if (res.status >= 400) {
          errors.push({ status: res.status, message: res.data?.message || res.statusText });
        } else {
          timings.push(elapsed);
        }
      }
    } catch (err) {
      const elapsed = Date.now() - start;
      if (i >= WARMUP) {
        errors.push({ status: 0, message: err.message });
        timings.push(elapsed);
      }
    }
  }

  const stats = summarizeTimings(timings);
  const errorRate = errors.length / Math.max(1, ITERATIONS);
  return {
    endpoint: scenario.url,
    module: scenario.module,
    page: scenario.name,
    requestType: scenario.method,
    ...stats,
    responseTime: stats.p50,
    httpStatus: lastStatus,
    errorRate: Number(errorRate.toFixed(4)),
    errors: errors.slice(0, 3),
    requestSizeBytes: lastRequestBytes,
    responseSizeBytes: lastResponseBytes,
    thresholdMs: THRESHOLD_MS,
    exceedsThreshold: stats.p50 > THRESHOLD_MS,
    priority: stats.p95 >= 1000 ? 'critical' : stats.p95 >= 600 ? 'high' : stats.p50 > THRESHOLD_MS ? 'medium' : 'ok',
  };
}

function printReport(results) {
  const slow = results.filter((r) => r.p50 > THRESHOLD_MS).sort((a, b) => b.p95 - a.p95);
  const ok = results.filter((r) => r.p50 <= THRESHOLD_MS);

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(' HOA API Performance Audit');
  console.log(` Base URL: ${BASE_URL}  |  Threshold: ${THRESHOLD_MS} ms  |  Iterations: ${ITERATIONS}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log(` Within threshold (${ok.length}):`);
  for (const r of ok.sort((a, b) => b.p50 - a.p50).slice(0, 10)) {
    console.log(`   ${r.p50}ms P50  ${r.module}/${r.page}  ${r.requestType} ${r.endpoint}`);
  }
  if (ok.length > 10) console.log(`   ... and ${ok.length - 10} more`);

  console.log(`\n⚠️  Exceeding ${THRESHOLD_MS} ms threshold (${slow.length}):`);
  console.log('   API                          Module           P50    P95    P99   Status  Priority');
  console.log('   ─────────────────────────────────────────────────────────────────────────────');
  for (const r of slow) {
    const label = `${r.requestType} ${r.endpoint}`.padEnd(28);
    console.log(
      `   ${label} ${r.module.padEnd(16)} ${String(r.p50).padStart(5)}ms ${String(r.p95).padStart(5)}ms ${String(r.p99).padStart(5)}ms ${String(r.httpStatus).padStart(6)}  ${r.priority}`
    );
  }

  console.log('\n📊 Before/after tracking template (fill After post-optimization):');
  console.log('   API                    Before   Target    After   Improvement');
  for (const r of slow.slice(0, 8)) {
    console.log(`   ${r.page.padEnd(22)} ${String(r.p50).padStart(5)}ms   <${THRESHOLD_MS}ms      -       -`);
  }
  console.log('');
}

async function main() {
  console.log('🔐 Logging in...');
  const token = await login();
  const hoaId = await resolveHoaId(token);
  console.log(` Authenticated - HOA ${hoaId}`);

  const client = buildClient(token, hoaId);
  const sampleIds = await fetchSampleIds(client);
  const scenarios = buildScenarios(sampleIds);
  console.log(`📋 Benchmarking ${scenarios.length} endpoints (${ITERATIONS} timed iterations each)...\n`);

  const results = [];
  for (const scenario of scenarios) {
    process.stdout.write(`  • ${scenario.module}/${scenario.name}...`);
    const row = await measureEndpoint(client, scenario);
    results.push(row);
    process.stdout.write(` P50=${row.p50}ms P95=${row.p95}ms status=${row.httpStatus}\n`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    hoaId,
    thresholdMs: THRESHOLD_MS,
    iterations: ITERATIONS,
    warmup: WARMUP,
    summary: {
      totalEndpoints: results.length,
      withinThreshold: results.filter((r) => r.p50 <= THRESHOLD_MS).length,
      exceedingThreshold: results.filter((r) => r.p50 > THRESHOLD_MS).length,
      critical: results.filter((r) => r.priority === 'critical').length,
      high: results.filter((r) => r.priority === 'high').length,
    },
    results: results.sort((a, b) => b.p95 - a.p95),
  };

  const reportsDir = path.join(__dirname, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const outPath = process.env.HOA_PERF_OUTPUT
    || path.join(reportsDir, `hoa-api-perf-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n💾 Report saved: ${outPath}`);

  printReport(results);
  process.exit(report.summary.critical > 0 || report.summary.exceedingThreshold > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error(' Audit failed:', err.message);
  process.exit(1);
});

/**
 * Guard against accidentally emptied or stubbed critical modules.
 *
 * Empty .js files pass `node --check` and many unit suites never require the
 * HOA invoice service, so a wipe can reach development while list/stats/dashboard
 * APIs 500 at runtime. This suite fails CI when that happens.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORTALS_ROOT = path.join(ROOT, 'portals');

/** Files under this size are treated as accidentally wiped / stubbed. */
const MIN_SERVICE_FILE_BYTES = 100;

/**
 * Required runtime exports for modules that power high-traffic board APIs.
 * Keep this list focused on contracts controllers actually call.
 */
const CRITICAL_EXPORT_CONTRACTS = [
  {
    relativePath: 'portals/hoa-board/modules/invoice/service/invoice.service.js',
    minBytes: 50_000,
    exports: [
      'createInvoice',
      'getInvoices',
      'getInvoiceById',
      'updateInvoice',
      'deleteInvoice',
      'getInvoiceStatistics',
      'getInvoiceDashboardSummary',
      'exportInvoicesCsv',
      'deleteInvoicePayment',
      'previewInvoicePaymentReversal',
      'previewInvoicePaymentAllocation',
      'applyCreditToInvoice',
      'waiveInvoiceBalance',
      'reverseWaiveInvoiceBalance',
      'getPolicyTermJobStatus',
    ],
  },
  {
    relativePath: 'portals/hoa-board/modules/dashboard/service/dashboard.service.js',
    minBytes: 5_000,
    exports: ['getDashboardSummary', 'getRecentActivity'],
  },
  {
    relativePath: 'portals/landlord/modules/invoice/service/invoice.service.js',
    minBytes: 20_000,
    exports: [
      'createInvoice',
      'getInvoices',
      'getInvoiceById',
      'getInvoiceStatistics',
      'withInvoiceTransaction',
      'mergeInvoiceScopeFromActor',
    ],
  },
];

function collectServiceFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectServiceFiles(full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.js')) continue;
    if (entry.name.endsWith('.test.js')) continue;
    const parts = full.split(path.sep);
    if (!parts.includes('service')) continue;
    out.push(full);
  }
  return out;
}

describe('critical module export contracts', () => {
  for (const contract of CRITICAL_EXPORT_CONTRACTS) {
    it(`${contract.relativePath} is non-empty and exports required APIs`, () => {
      const absolutePath = path.join(ROOT, contract.relativePath);
      assert.ok(
        fs.existsSync(absolutePath),
        `Missing critical module: ${contract.relativePath}`,
      );

      const stat = fs.statSync(absolutePath);
      assert.ok(
        stat.size >= contract.minBytes,
        `${contract.relativePath} is only ${stat.size} bytes (expected >= ${contract.minBytes}). ` +
          'This usually means the file was accidentally emptied or truncated.',
      );

      // Clear cache so a prior empty require in the same process cannot mask failure.
      delete require.cache[require.resolve(absolutePath)];
      const mod = require(absolutePath);
      assert.equal(
        typeof mod,
        'object',
        `${contract.relativePath} must export an object`,
      );
      assert.notEqual(mod, null);

      const missing = contract.exports.filter((name) => typeof mod[name] !== 'function');
      assert.deepEqual(
        missing,
        [],
        `${contract.relativePath} is missing required function exports: ${missing.join(', ')}`,
      );
    });
  }
});

describe('portal service files must not be empty', () => {
  it(`every portals/**/service/*.js is at least ${MIN_SERVICE_FILE_BYTES} bytes`, () => {
    const files = collectServiceFiles(PORTALS_ROOT);
    assert.ok(files.length > 0, 'Expected to discover portal service files');

    const emptied = files
      .map((absolutePath) => ({
        relativePath: path.relative(path.join(ROOT, '..'), absolutePath),
        size: fs.statSync(absolutePath).size,
      }))
      .filter((entry) => entry.size < MIN_SERVICE_FILE_BYTES);

    assert.deepEqual(
      emptied,
      [],
      'Accidentally emptied service file(s) detected:\n' +
        emptied.map((e) => `  - ${e.relativePath} (${e.size} bytes)`).join('\n'),
    );
  });
});

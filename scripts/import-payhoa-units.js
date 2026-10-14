/**
 * Import PayHOA-style units into PropMv via the HOA board API.
 *
 * Do not paste the 142-unit payload into this file. Save the API JSON to a file
 * (default: scripts/data/payhoa-units.json) and point the script at it.
 *
 * Usage:
 *   node scripts/import-payhoa-units.js --input scripts/data/payhoa-units.json
 *   node scripts/import-payhoa-units.js --dry-run --limit 5
 *
 * Required env (except --dry-run):
 *   HOA_IMPORT_EMAIL / HOA_PERF_EMAIL
 *   HOA_IMPORT_PASSWORD / HOA_PERF_PASSWORD
 *   HOA_IMPORT_BANK_ACCOUNT_ID   24-char Mongo ObjectId of the HOA deposit bank
 *
 * Optional env:
 *   HOA_IMPORT_BASE_URL / HOA_PERF_BASE_URL   default http://127.0.0.1:5000/api/v1
 *   HOA_IMPORT_HOA_ID / HOA_PERF_HOA_ID       skip /my-hoas lookup
 *   HOA_IMPORT_INPUT                          JSON file path
 *   HOA_IMPORT_DELAY_MS                       default 150
 *   HOA_IMPORT_DEFAULT_FEE                    dollars; only used when a unit has a
 *                                             starting balance but no PayHOA fee
 *   HOA_IMPORT_OWNER_EMAIL                    owner to assign on every unit
 *                                             (default hiteshchavhan0501@gmail.com)
 *   HOA_IMPORT_OWNER_FIRST_NAME / LAST_NAME   used only if that owner is created
 *   HOA_IMPORT_OWNER_PHONE                    10-digit seed for placeholder phones
 *   HOA_IMPORT_CONFIRM_PRODUCTION=1           required when BASE_URL is not local
 *
 * Units are created in the logged-in board member's HOA. By default every unit
 * is associated with HOA_IMPORT_OWNER_EMAIL. If that email is the board member
 * (not an HOA owner), units are still created in that HOA without owner invites.
 *
 * Duplicate PayHOA titles get a unique suffix using the PayHOA unit id.
 * Production imports must pass --confirm-production and a deposit bank that
 * belongs to the target HOA (or one already used on a unit in that HOA).
 *
 * Note: POST /hoa/owners always queues an invitation email (controller sets
 * triggerInvite: true). Placeholder phones are used when creating the owner.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env.local') });
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { isValidPersonName } = require('../src/shared/utils/personNameValidation.util');
const { createUnitSchema } = require('../src/portals/hoa-board/modules/owners/validators/createUnit.validator');

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const BASE_URL = (
  process.env.HOA_IMPORT_BASE_URL
  || process.env.HOA_PERF_BASE_URL
  || 'http://127.0.0.1:5000/api/v1'
).replace(/\/$/, '');
const EMAIL = process.env.HOA_IMPORT_EMAIL || process.env.HOA_PERF_EMAIL || process.env.HOA_PERF_LOGIN_EMAIL;
const PASSWORD = process.env.HOA_IMPORT_PASSWORD || process.env.HOA_PERF_PASSWORD || process.env.HOA_PERF_LOGIN_PASSWORD;
const HOA_ID_ENV = process.env.HOA_IMPORT_HOA_ID || process.env.HOA_PERF_HOA_ID || '';
const DELAY_MS = Math.max(0, Number(process.env.HOA_IMPORT_DELAY_MS || 150));
const DEFAULT_FEE = Number(process.env.HOA_IMPORT_DEFAULT_FEE || 100);
const PHONE_SEED = digitsOnly(process.env.HOA_IMPORT_OWNER_PHONE || '4342000001').slice(0, 10) || '4342000001';
const DEFAULT_OWNER_EMAIL = 'hiteshchavhan0501@gmail.com';
const OWNER_EMAIL_ENV = String(process.env.HOA_IMPORT_OWNER_EMAIL || DEFAULT_OWNER_EMAIL).trim().toLowerCase();
const OWNER_FIRST_NAME = process.env.HOA_IMPORT_OWNER_FIRST_NAME || 'Hitesh';
const OWNER_LAST_NAME = process.env.HOA_IMPORT_OWNER_LAST_NAME || 'Chavhan';

function parseArgs(argv) {
  const args = {
    input: process.env.HOA_IMPORT_INPUT || '',
    dryRun: false,
    skipExisting: true,
    limit: 0,
    bankAccountId: process.env.HOA_IMPORT_BANK_ACCOUNT_ID || '',
    confirmProduction: false,
    propertiesOnly: false,
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--dry-run' || a === '-n') args.dryRun = true;
    else if (a === '--no-skip-existing') args.skipExisting = false;
    else if (a === '--skip-existing') args.skipExisting = true;
    else if (a === '--input' || a === '-i') args.input = rest[++i] || '';
    else if (a === '--limit') args.limit = Math.max(0, Number(rest[++i] || 0));
    else if (a === '--bank-account-id') args.bankAccountId = rest[++i] || '';
    else if (a === '--hoa-id') args.hoaId = rest[++i] || '';
    else if (a === '--owner-email') args.ownerEmail = rest[++i] || '';
    else if (a === '--confirm-production') args.confirmProduction = true;
    else if (a === '--properties-only') args.propertiesOnly = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--') continue;
    else if (!a.startsWith('-') && !args.input) args.input = a;
  }
  if (process.env.HOA_IMPORT_DRY_RUN === '1' || process.env.HOA_IMPORT_DRY_RUN === 'true') args.dryRun = true;
  if (process.env.HOA_IMPORT_LIMIT) args.limit = Math.max(args.limit, Number(process.env.HOA_IMPORT_LIMIT) || 0);
  if (process.env.HOA_IMPORT_SKIP_EXISTING === '0' || process.env.HOA_IMPORT_SKIP_EXISTING === 'false') args.skipExisting = false;
  if (process.env.HOA_IMPORT_CONFIRM_PRODUCTION === '1' || process.env.HOA_IMPORT_CONFIRM_PRODUCTION === 'true') {
    args.confirmProduction = true;
  }
  if (process.env.HOA_IMPORT_PROPERTIES_ONLY === '1' || process.env.HOA_IMPORT_PROPERTIES_ONLY === 'true') {
    args.propertiesOnly = true;
  }
  return args;
}

function printHelp() {
  console.log(`Import PayHOA units into PropMv (HOA board API).

Usage:
  node scripts/import-payhoa-units.js --input <payhoa-units.json> [options]

Options:
  --input, -i PATH          PayHOA JSON file ({ "data": [ ...units ] })
  --dry-run, -n             Map and log payloads without calling write APIs
  --limit N                 Import only the first N units
  --no-skip-existing        Create even if a unit with the same title exists
  --bank-account-id ID      Deposit bank ObjectId for THIS HOA (required unless
                            an existing unit in the HOA already has a bank)
  --hoa-id ID               HOA id (otherwise first membership from /my-hoas)
  --owner-email EMAIL       Assign every unit to this HOA owner (default ${DEFAULT_OWNER_EMAIL})
  --properties-only         Create units with no associatedOwnerIds; never create owners
  --confirm-production      Required when HOA_IMPORT_BASE_URL is not localhost

Env: HOA_IMPORT_EMAIL, HOA_IMPORT_PASSWORD, HOA_IMPORT_BANK_ACCOUNT_ID
     HOA_IMPORT_OWNER_EMAIL (default ${DEFAULT_OWNER_EMAIL})
     HOA_IMPORT_BASE_URL (default ${BASE_URL})
`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function todayYmd() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function centsToDollars(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n) / 100;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function unwrap(res) {
  if (res && res.data && res.data.data !== undefined) return res.data.data;
  return res ? res.data : undefined;
}

function apiError(res) {
  const body = res && res.data;
  if (!body) return `HTTP ${res && res.status}`;
  const msg = body.message || body.error || (body.data && body.data.message);
  const fields = Array.isArray(body.fieldErrors)
    ? body.fieldErrors.map((e) => `${e.field}: ${e.message}`).join('; ')
    : '';
  return [msg || `HTTP ${res.status}`, fields].filter(Boolean).join(' - ');
}

function loadUnits(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Input file not found: ${abs}`);
  }
  const parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const units = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.data)
      ? parsed.data
      : Array.isArray(parsed.units)
        ? parsed.units
        : null;
  if (!units) {
    throw new Error('JSON must be an array or { "data": [ ...units ] }');
  }
  return units;
}

function normalizeCity(raw) {
  const city = String(raw || '').trim();
  const lower = city.toLowerCase();
  if (!city) return 'Lynchburg';
  if (/lynchb?u?rg/.test(lower) || lower.includes('lynchbrug') || lower.includes('lychburg') || lower.includes('lynchurg')) {
    return 'Lynchburg';
  }
  if (lower.startsWith('lynchburg')) return 'Lynchburg';
  return city.slice(0, 50);
}

function normalizeState(region, zip) {
  const r = String(region || '').trim();
  if (zip === '24502') return 'Virginia';
  if (!r) return 'Virginia';
  return r.slice(0, 50);
}

function normalizeZip(postalCode) {
  const digits = digitsOnly(postalCode);
  if (digits.length >= 9) return `${digits.slice(0, 5)}-${digits.slice(5, 9)}`;
  if (digits.length >= 5) return digits.slice(0, 5);
  return '24502';
}

function truncate(value, max) {
  return String(value || '').trim().slice(0, max);
}

function sanitizePersonName(raw, fallback) {
  let v = String(raw || '')
    .replace(/[/,]+/g, ' ')
    .replace(/[_]+/g, ' ')
    .replace(/[^A-Za-z0-9 .'\-&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!v) v = fallback;
  if (v && !/^[A-Za-z]/.test(v)) v = `${fallback} ${v}`.trim();
  v = v.replace(/^&+|&+$/g, '').trim() || fallback;
  if (v.length > 100) v = v.slice(0, 100).trim();
  if (!isValidPersonName(v)) return fallback;
  return v;
}

function extractTags(unit) {
  const tags = Array.isArray(unit.tags) ? unit.tags : [];
  const out = [];
  const seen = new Set();
  for (const t of tags) {
    const label = truncate(t && t.tag, 50);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

function extractFee(unit) {
  const templates = Array.isArray(unit.recurringChargeTemplates) ? unit.recurringChargeTemplates : [];
  const tpl = templates[0];
  if (!tpl) return { monthlyRecurringFee: 0, paymentDueDay: 1 };
  const amountCents = (tpl.pivot && tpl.pivot.amount != null) ? tpl.pivot.amount : tpl.chargeAmount;
  const dueDay = Number(tpl.recursOn);
  let paymentDueDay = Number.isInteger(dueDay) && dueDay >= 1 && dueDay <= 31 ? dueDay : 1;
  if (!paymentDueDay && tpl.firstDueDate) {
    const d = new Date(tpl.firstDueDate);
    if (!Number.isNaN(d.getTime())) paymentDueDay = d.getUTCDate();
  }
  return {
    monthlyRecurringFee: centsToDollars(amountCents),
    paymentDueDay: clamp(paymentDueDay || 1, 1, 31),
  };
}

function dateYmd(raw) {
  if (!raw) return todayYmd();
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return todayYmd();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

function isLocalApi(url) {
  return /localhost|127\.0\.0\.1/i.test(String(url || ''));
}

function uniqueImportTitle(unit, seenTitles) {
  const base = truncate(unit.title, 100) || `Unit ${unit.id}`;
  const key = base.toLowerCase();
  const used = seenTitles.get(key) || 0;
  seenTitles.set(key, used + 1);
  if (used === 0) return base;
  const suffix = ` (${unit.id})`;
  return `${truncate(base, 100 - suffix.length)}${suffix}`;
}

function mapAddress(unit) {
  const addr = unit.address || {};
  const zipCode = normalizeZip(addr.postalCode || unit.zip);
  return {
    line1: truncate(addr.line1 || unit.title || 'Unknown address', 100) || 'Unknown address',
    line2: truncate(addr.line2, 100),
    city: normalizeCity(addr.city || unit.city),
    state: normalizeState(addr.region || unit.state, zipCode),
    zipCode,
  };
}

function mapUnitPayload(unit, { title, associatedOwnerIds, depositBankAccountId }) {
  const address = mapAddress(unit);
  const { monthlyRecurringFee: feeFromTpl, paymentDueDay } = extractFee(unit);
  const startingBalance = centsToDollars(unit.balance);
  const hasBalance = startingBalance !== 0;
  const payload = {
    propertyName: title,
    title,
    description: truncate(unit.description, 500),
    address,
    depositBankAccountId,
    tags: extractTags(unit),
    associatedOwnerIds,
    paymentTerm: 12,
    paymentDueDay,
  };

  let monthlyRecurringFee = feeFromTpl;
  if (hasBalance && !(monthlyRecurringFee > 0)) {
    monthlyRecurringFee = DEFAULT_FEE;
    payload._usedDefaultFee = true;
  }
  if (monthlyRecurringFee > 0) payload.monthlyRecurringFee = monthlyRecurringFee;

  if (hasBalance || monthlyRecurringFee > 0) {
    payload.startingBalance = clamp(startingBalance, -5000, 1000000);
    payload.balanceAsOf = dateYmd(unit.updatedAt || unit.createdAt);
    if (!(payload.monthlyRecurringFee > 0)) payload.monthlyRecurringFee = DEFAULT_FEE;
  }
  return payload;
}

function nextPlaceholderPhone(used, seed) {
  let n = Number(seed);
  if (!Number.isFinite(n) || n < 2000000000) n = 4342000001;
  while (used.has(String(n))) n += 1;
  const phone = String(n);
  used.add(phone);
  return phone;
}

function extractAccessToken(res) {
  const seen = new Set();
  const walk = (obj, depth) => {
    if (!obj || typeof obj !== 'object' || depth > 6 || seen.has(obj)) return '';
    seen.add(obj);
    if (typeof obj.accessToken === 'string' && obj.accessToken) return obj.accessToken;
    if (typeof obj.token === 'string' && obj.token.length > 20) return obj.token;
    if (obj.data) {
      const nested = walk(obj.data, depth + 1);
      if (nested) return nested;
    }
    return '';
  };
  return walk(res && res.data, 0);
}

async function readLoginOtpFromDb(email) {
  const mongoose = require('mongoose');
  const url = process.env.DB_URL;
  if (!url) return null;
  const conn = await mongoose.createConnection(url, { dbName: process.env.DB_NAME || 'PropMv' }).asPromise();
  try {
    const user = await conn.db.collection('users').findOne(
      { email: String(email).trim().toLowerCase() },
      { projection: { mfaOtp: 1 } }
    );
    return user && user.mfaOtp ? String(user.mfaOtp) : null;
  } finally {
    await conn.close();
  }
}

async function login() {
  const headers = { 'X-Requested-With': 'XMLHttpRequest' };
  const res = await axios.post(`${BASE_URL}/auth/login`, { email: EMAIL, password: PASSWORD }, {
    timeout: 30000,
    headers,
    validateStatus: () => true,
  });
  if (res.status >= 400) throw new Error(`Login failed: ${apiError(res)}`);
  let token = extractAccessToken(res);
  if (token) return token;

  const data = unwrap(res) || res.data || {};
  if (!data.mfaRequired) {
    throw new Error('Login succeeded but no accessToken was returned');
  }

  let otp = data.devOtp || process.env.HOA_IMPORT_MFA_OTP || '';
  if (!otp) otp = await readLoginOtpFromDb(EMAIL);
  if (!otp) {
    throw new Error(
      'Login requires MFA. Set AUTH_EXPOSE_OTP_IN_RESPONSE=true, or HOA_IMPORT_MFA_OTP, '
      + 'or run against a local DB the script can read (DB_URL in .env.local).'
    );
  }

  const verify = await axios.post(`${BASE_URL}/auth/verify-mfa-otp`, {
    email: EMAIL,
    otp: String(otp),
    trustDevice: true,
  }, {
    timeout: 30000,
    headers,
    validateStatus: () => true,
  });
  if (verify.status >= 400) throw new Error(`MFA verify failed: ${apiError(verify)}`);
  token = extractAccessToken(verify);
  if (!token) throw new Error('MFA verified but no accessToken was returned');
  return token;
}

async function resolveHoaId(client, override) {
  if (override) return String(override);
  const res = await client.get('/hoa/board-members/my-hoas');
  if (res.status >= 400) throw new Error(`Failed to list HOAs: ${apiError(res)}`);
  const rows = unwrap(res);
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) throw new Error('No HOAs found for this board member');
  const first = list[0];
  return String(first.hoaId || first._id || first.id);
}

function buildClient(token, hoaId) {
  return axios.create({
    baseURL: BASE_URL,
    timeout: 60000,
    headers: {
      Authorization: `Bearer ${token}`,
      'x-hoa-id': hoaId,
      'X-Requested-With': 'XMLHttpRequest',
    },
    validateStatus: () => true,
  });
}

async function listAllOwners(client) {
  const all = [];
  let pageNumber = 1;
  const pageSize = 100;
  while (true) {
    const res = await client.get('/hoa/owners/', { params: { pageNumber, pageSize, showArchived: 'false' } });
    if (res.status >= 400) throw new Error(`Failed to list owners: ${apiError(res)}`);
    const payload = unwrap(res) || {};
    const rows = Array.isArray(payload.data) ? payload.data : Array.isArray(payload) ? payload : [];
    all.push(...rows);
    const total = Number(payload.total || 0);
    if (!rows.length || all.length >= total || rows.length < pageSize) break;
    pageNumber += 1;
  }
  return all;
}

async function listExistingProperties(client) {
  const titles = new Set();
  const bankIds = [];
  let page = 1;
  const pageSize = 200;
  while (true) {
    const res = await client.get('/hoa/property/properties', { params: { page, pageSize, pageNumber: page } });
    if (res.status >= 400) throw new Error(`Failed to list properties: ${apiError(res)}`);
    const payload = res.data && res.data.data && Array.isArray(res.data.data.data)
      ? res.data.data
      : (unwrap(res) && unwrap(res).data ? unwrap(res) : res.data);
    const rows = Array.isArray(payload && payload.data) ? payload.data : Array.isArray(payload) ? payload : [];
    for (const p of rows) {
      const name = String(p.name || '').trim().toLowerCase();
      if (name) titles.add(name);
      const units = Array.isArray(p.unitDetails) ? p.unitDetails : [];
      for (const u of units) {
        const un = String(u.unitName || '').trim().toLowerCase();
        if (un) titles.add(un);
      }
      const bankId = p.depositBankAccountId && String(p.depositBankAccountId);
      if (bankId && OBJECT_ID_RE.test(bankId)) bankIds.push(bankId);
    }
    const total = Number((payload && payload.total) || 0);
    if (!rows.length || (total && page * pageSize >= total) || rows.length < pageSize) break;
    page += 1;
  }
  return { titles, bankIds };
}

function assertProductionAllowed(args) {
  if (args.dryRun || isLocalApi(BASE_URL)) return;
  if (args.confirmProduction) return;
  throw new Error(
    `Refusing to write to ${BASE_URL}. Re-run with --confirm-production after you have set `
    + 'HOA_IMPORT_HOA_ID and HOA_IMPORT_BANK_ACCOUNT_ID for the production HOA.'
  );
}

function validateMappedPayload(payload, label) {
  const toValidate = { ...payload };
  delete toValidate._usedDefaultFee;
  const { error } = createUnitSchema.validate(toValidate, { abortEarly: false, stripUnknown: true });
  if (error) {
    throw new Error(`${label} failed validation: ${error.details.map((d) => d.message).join('; ')}`);
  }
}

async function ensureTargetOwner(client, { email, ownerByEmail, usedPhones, dryRun, propertiesOnly }) {
  if (propertiesOnly) {
    console.log('Properties-only import: skipping owner create/assign. Units will have no associatedOwnerIds.');
    return { id: null, created: false };
  }
  if (!EMAIL_RE.test(email)) {
    throw new Error(`Invalid HOA_IMPORT_OWNER_EMAIL: ${email}`);
  }
  if (ownerByEmail.has(email)) {
    return { id: ownerByEmail.get(email), created: false };
  }

  const loginEmail = String(EMAIL || '').trim().toLowerCase();
  if (loginEmail && loginEmail === email) {
    console.log(`Owner email ${email} is the logged-in board member, not an HOA owner. Units will be created in this HOA without associatedOwnerIds.`);
    return { id: null, created: false };
  }

  const firstName = sanitizePersonName(OWNER_FIRST_NAME, 'Hitesh');
  const lastName = sanitizePersonName(OWNER_LAST_NAME, 'Chavhan');
  const phone = nextPlaceholderPhone(usedPhones, PHONE_SEED);
  const ownerPayload = {
    firstName,
    lastName,
    email,
    emailConfirm: email,
    phone,
    hasUnits: false,
    sendInvite: false,
  };

  if (dryRun) {
    const dryId = `dry-run-${email}`;
    ownerByEmail.set(email, dryId);
    console.log(`Would create owner ${firstName} ${lastName} <${email}> phone ${phone}`);
    return { id: dryId, created: true };
  }

  try {
    const id = await createOwner(client, ownerPayload);
    ownerByEmail.set(email, id);
    console.log(`Created owner ${firstName} ${lastName} <${email}> (${id})`);
    return { id, created: true };
  } catch (err) {
    throw new Error(
      `Could not resolve HOA owner ${email}: ${err.message}. `
      + 'If this email already belongs to a board member (not an HOA owner), add the HOA Owner role or use a different --owner-email.'
    );
  }
}

async function createOwner(client, ownerPayload) {
  const res = await client.post('/hoa/owners/', ownerPayload);
  if (res.status >= 400) throw new Error(apiError(res));
  const data = unwrap(res) || {};
  const owner = data.owner || data;
  const id = owner && (owner._id || owner.id);
  if (!id) throw new Error('Owner created but response had no _id');
  return String(id);
}

async function createUnit(client, unitPayload) {
  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await client.post('/hoa/owners/units', unitPayload);
    const errText = res.status >= 400 ? apiError(res) : '';
    if (res.status === 429 || /too many requests/i.test(errText)) {
      const wait = Math.min(45000, 2500 * (2 ** (attempt - 1)));
      console.warn(`Rate limited creating ${unitPayload.title}; waiting ${wait}ms (attempt ${attempt}/${maxAttempts})`);
      await sleep(wait);
      continue;
    }
    if (res.status >= 400) throw new Error(errText);
    const data = unwrap(res) || {};
    const unit = data.unit || data;
    return unit;
  }
  throw new Error('Too many requests after retries');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  assertProductionAllowed(args);

  const inputPath = args.input || path.join(__dirname, 'data', 'payhoa-units.json');
  const units = loadUnits(inputPath);
  const toImport = args.limit > 0 ? units.slice(0, args.limit) : units;
  console.log(`Loaded ${units.length} unit(s) from ${path.resolve(inputPath)}; importing ${toImport.length}.`);

  if (!args.dryRun) {
    if (!EMAIL || !PASSWORD) {
      throw new Error('Set HOA_IMPORT_EMAIL and HOA_IMPORT_PASSWORD (or HOA_PERF_EMAIL / HOA_PERF_PASSWORD)');
    }
  }

  const ownerEmail = String(args.ownerEmail || OWNER_EMAIL_ENV || DEFAULT_OWNER_EMAIL).trim().toLowerCase();
  if (!EMAIL_RE.test(ownerEmail)) {
    throw new Error(`Invalid owner email: ${ownerEmail}`);
  }
  console.log(`Target HOA board login: ${EMAIL || '(not set)'}`);
  console.log(`All units will be assigned to owner ${ownerEmail} when that user is an HOA owner.`);

  let client = null;
  const ownerByEmail = new Map();
  const usedPhones = new Set();
  const existingTitles = new Set();
  let hoaBankIds = [];

  if (!args.dryRun) {
    const token = await login();
    const bootstrap = buildClient(token, args.hoaId || HOA_ID_ENV || 'pending');
    const hoaId = await resolveHoaId(bootstrap, args.hoaId || HOA_ID_ENV);
    client = buildClient(token, hoaId);
    console.log(`Authenticated. Using HOA ${hoaId}`);

    const owners = await listAllOwners(client);
    for (const o of owners) {
      const email = String(o.email || '').trim().toLowerCase();
      if (email) ownerByEmail.set(email, String(o._id || o.id));
      const phone = digitsOnly(o.phone);
      if (phone.length === 10) usedPhones.add(phone);
      if (phone.length === 11 && phone.startsWith('1')) usedPhones.add(phone.slice(1));
    }
    console.log(`Cached ${ownerByEmail.size} existing owner email(s).`);

    const existing = await listExistingProperties(client);
    existing.titles.forEach((t) => existingTitles.add(t));
    hoaBankIds = existing.bankIds;
    console.log(`Found ${existingTitles.size} existing unit/property title(s) and ${hoaBankIds.length} deposit bank(s) already on units.`);
  } else {
    console.log('Dry run: no login or writes.');
  }

  let bankAccountId = args.bankAccountId;
  if (!OBJECT_ID_RE.test(bankAccountId) && hoaBankIds.length) {
    bankAccountId = hoaBankIds[0];
    console.log(`Using deposit bank already attached to a unit in this HOA: ${bankAccountId}`);
  }
  if (!args.dryRun && !OBJECT_ID_RE.test(bankAccountId)) {
    throw new Error(
      'This HOA has no deposit bank on file. Add a receiving bank in HOA settings, then set '
      + 'HOA_IMPORT_BANK_ACCOUNT_ID to that 24-character ObjectId. Do not reuse a bank from another HOA.'
    );
  }
  if (args.dryRun && !OBJECT_ID_RE.test(bankAccountId)) {
    bankAccountId = '000000000000000000000000';
  }

  const targetOwner = await ensureTargetOwner(client, {
    email: ownerEmail,
    ownerByEmail,
    usedPhones,
    dryRun: args.dryRun,
    propertiesOnly: args.propertiesOnly,
  });
  const associatedOwnerIds = targetOwner.id ? [targetOwner.id] : [];
  if (!args.dryRun && targetOwner.id && !OBJECT_ID_RE.test(targetOwner.id)) {
    throw new Error(`Resolved owner ${ownerEmail} but id is not a valid ObjectId: ${targetOwner.id}`);
  }
  if (targetOwner.id) {
    console.log(
      targetOwner.created
        ? `Owner ${ownerEmail} created (${targetOwner.id}).`
        : `Reusing existing owner ${ownerEmail} (${targetOwner.id}).`
    );
  }
  if (DELAY_MS && targetOwner.created && !args.dryRun) await sleep(DELAY_MS);

  const stats = {
    created: 0,
    skipped: 0,
    failed: 0,
    ownersCreated: targetOwner.created ? 1 : 0,
    defaultFee: 0,
  };
  const failures = [];
  const seenSourceTitles = new Map();

  for (let i = 0; i < toImport.length; i++) {
    const unit = toImport[i];
    const title = uniqueImportTitle(unit, seenSourceTitles);
    const label = `[${i + 1}/${toImport.length}] ${title}`;

    if (args.skipExisting && existingTitles.has(title.toLowerCase())) {
      console.log(`${label} - skipped (already exists)`);
      stats.skipped += 1;
      continue;
    }

    const unitPayload = mapUnitPayload(unit, {
      title,
      associatedOwnerIds: associatedOwnerIds.filter((id) => OBJECT_ID_RE.test(id)),
      depositBankAccountId: bankAccountId,
    });
    if (unitPayload._usedDefaultFee) {
      stats.defaultFee += 1;
      console.warn(`${label} - no PayHOA fee template; using HOA_IMPORT_DEFAULT_FEE=${DEFAULT_FEE}`);
      delete unitPayload._usedDefaultFee;
    }
    validateMappedPayload(unitPayload, label);

    if (args.dryRun) {
      console.log(`${label} - would create unit`, JSON.stringify({
        title: unitPayload.title,
        address: unitPayload.address,
        startingBalance: unitPayload.startingBalance,
        monthlyRecurringFee: unitPayload.monthlyRecurringFee,
        paymentDueDay: unitPayload.paymentDueDay,
        tags: unitPayload.tags,
        associatedOwnerIds,
      }));
      stats.created += 1;
      continue;
    }

    try {
      const created = await createUnit(client, unitPayload);
      const id = created && (created._id || created.id || (created.unit && created.unit._id));
      console.log(`${label} - created${id ? ` (${id})` : ''}`);
      stats.created += 1;
      existingTitles.add(title.toLowerCase());
    } catch (err) {
      console.error(`${label} - failed: ${err.message}`);
      stats.failed += 1;
      failures.push({ title, error: err.message });
    }
    if (DELAY_MS) await sleep(DELAY_MS);
  }

  console.log('\nDone.');
  console.log(`Units created: ${stats.created}`);
  console.log(`Units skipped: ${stats.skipped}`);
  console.log(`Units failed:  ${stats.failed}`);
  console.log(`Owner ${ownerEmail}: ${stats.ownersCreated ? 'created' : (targetOwner.id ? 'reused' : 'not assigned (board member)')}`);
  if (stats.defaultFee) console.log(`Units that used default fee: ${stats.defaultFee}`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.title}: ${f.error}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

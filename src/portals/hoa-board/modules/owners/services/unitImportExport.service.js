/**
 * ------------------------------------------------------------------
 * File: unitImportExport.service.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * unitImportExport.controller
 * ------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const ExcelJS = require('exceljs');
const unitService = require('./unit.service');
const ImportJob = require('../models/importJob.model');
const { buildHoaBoardPropertyMatch } = require('../../../../../middleware/hoaDataIsolation');
const { ClockService, DateUtil } = require('../../../../../common/date');
const { getDateKeyInTimeZone } = require('../../../../../common/helpers/hoaBillingDates');

const UNIT_IMPORT_HEADERS = [
  'propertyName', 'title', 'description', 'startingBalance', 'balanceAsOf',
  'monthlyRecurringFee', 'paymentTerm', 'depositBankAccountId',
  'address[line1]', 'address[line2]', 'address[city]', 'address[state]', 'address[zipCode]',
  'tags[]', 'associatedOwnerIds[]',
];

const MAX_IMPORT_ROWS = 5000;
const MAX_EXPORT_ROWS = 10000;

const UPLOAD_BASE_DIR = path.resolve(__dirname, '../../../../../../uploads/imports');
const ALLOWED_FORMATS = new Set(['csv', 'json', 'xlsx']);
const UNIT_IMPORT_HEADERS_SET = Object.fromEntries(UNIT_IMPORT_HEADERS.map((h) => [h, true]));

function safeFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(UPLOAD_BASE_DIR + path.sep) && resolved !== UPLOAD_BASE_DIR) return null;
  return resolved;
}

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

function sanitizeJobId(jobId) {
  const s = String(jobId || '').trim();
  return /^import_[0-9a-f-]{36}$/.test(s) ? s : null;
}

function sanitizeImportCell(value) {
  let s = value == null ? '' : String(value).trim();
  if (/^[=+\-@]+/.test(s)) s = s.replace(/^[=+\-@]+/, '').trim();
  return s;
}

function csvEscape(value) {
  let s = value == null ? '' : String(value);
  if (/^[+\-=@]/.test(s.charAt(0))) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  values.push(current.trim());
  return values;
}

function parseCSV(content) {
  const lines = String(content || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter((l) => l.trim());
  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = parseCsvLine(lines[0]).map((h) => h.replace(/^"|"$/g, '').trim());
  const rows = lines.slice(1).map((line) => {
    const values = parseCsvLine(line).map((v) => v.replace(/^"|"$/g, '').trim());
    const row = Object.create(null);
    headers.forEach((h, i) => {
      if (h && Object.prototype.hasOwnProperty.call(UNIT_IMPORT_HEADERS_SET, h)) {
        row[h] = values[i] || '';
      }
    });
    return row;
  });

  return { headers, rows };
}

function parseJSON(content) {
  const data = JSON.parse(content);
  if (!Array.isArray(data)) throw new Error('JSON must be an array of objects');
  if (data.length === 0) return { headers: [], rows: [] };

  const headers = Object.keys(data[0]).filter((h) => UNIT_IMPORT_HEADERS_SET[h]);
  const rows = data.map((item) => {
    const row = Object.create(null);
    headers.forEach((h) => { row[h] = item[h] != null ? String(item[h]) : ''; });
    return row;
  });
  return { headers, rows };
}

async function parseExcel(filePath) {
  const safePath = safeFilePath(filePath);
  if (!safePath) throw new Error('Invalid file path');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(safePath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return { headers: [], rows: [] };

  const rows = [];
  let headers = [];

  worksheet.eachRow((row, rowNumber) => {
    const values = row.values.slice(1).map((v) => {
      if (v == null) return '';
      if (typeof v === 'object' && v.text) return String(v.text).trim();
      if (v instanceof Date) return v.toISOString().split('T')[0];
      return String(v).trim();
    });

    if (rowNumber === 1) {
      headers = values.filter((h) => UNIT_IMPORT_HEADERS_SET[h]);
      return;
    }

    const obj = Object.create(null);
    headers.forEach((h, i) => {
      obj[h] = values[i] || '';
    });
    rows.push(obj);
  });

  return { headers, rows };
}

async function buildExcelBuffer(headers, dataRows) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Units');
  worksheet.addRow(headers);
  dataRows.forEach((row) => worksheet.addRow(row));
  worksheet.getRow(1).font = { bold: true };
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function validateRow(row, rowNum, options = {}) {
  const errors = [];
  const defaultBankId = String(options.defaultDepositBankAccountId || '').trim();
  const allowedIds = Array.isArray(options.allowedDepositBankAccountIds)
    ? options.allowedDepositBankAccountIds.map((id) => String(id))
    : [];
  const mandatory = [
    'propertyName',
    'title',
    'address[line1]',
    'address[city]',
    'address[state]',
    'address[zipCode]',
  ];

  for (const field of mandatory) {
    if (!row[field] || String(row[field]).trim() === '') {
      errors.push(`Row ${rowNum}: Missing mandatory field "${field}"`);
    }
  }

  const bankId = String(row.depositBankAccountId || '').trim() || defaultBankId;
  if (!bankId) {
    errors.push(`Row ${rowNum}: Missing mandatory field "depositBankAccountId" (and no default bank account was provided)`);
  } else if (!mongoose.Types.ObjectId.isValid(bankId)) {
    errors.push(`Row ${rowNum}: depositBankAccountId must be a valid ObjectId`);
  } else if (allowedIds.length > 0 && !allowedIds.includes(bankId)) {
    errors.push(`Row ${rowNum}: depositBankAccountId is not one of this HOA's configured bank accounts`);
  }

  return errors;
}

function transformRowToUnit(row, userId, hoaContext = null, options = {}) {
  const defaultBankId = String(options.defaultDepositBankAccountId || '').trim();
  const unitData = {
    propertyName: sanitizeImportCell(row.propertyName || row.title),
    title: sanitizeImportCell(row.title),
    description: sanitizeImportCell(row.description || ''),
    address: {
      line1: sanitizeImportCell(row['address[line1]']),
      line2: sanitizeImportCell(row['address[line2]'] || ''),
      city: sanitizeImportCell(row['address[city]']),
      state: sanitizeImportCell(row['address[state]']),
      zipCode: sanitizeImportCell(row['address[zipCode]']),
    },
    startingBalance: parseFloat(row.startingBalance) || 0,
    balanceAsOf: row.balanceAsOf || getDateKeyInTimeZone(ClockService.now()),
    monthlyRecurringFee: parseFloat(row.monthlyRecurringFee) || 0,
    paymentTerm: parseInt(row.paymentTerm, 10) || 12,
    depositBankAccountId: String(row.depositBankAccountId || '').trim() || defaultBankId,
    tags: [],
    boardMemberId: userId,
    hoaBoardMemberId: userId,
    createdBy: userId,
    associatedOwnerIds: [],
  };

  if (hoaContext?.hoaId) {
    unitData.hoaId = hoaContext.hoaId;
  }

  if (row['tags[]'] && String(row['tags[]']).trim()) {
    unitData.tags = String(row['tags[]']).split(';').map((t) => sanitizeImportCell(t)).filter(Boolean);
  }

  if (row['associatedOwnerIds[]'] && String(row['associatedOwnerIds[]']).trim()) {
    const ownerIds = String(row['associatedOwnerIds[]']).split(';').map((id) => id.trim()).filter(Boolean);
    unitData.associatedOwnerIds = ownerIds.filter((id) => /^[0-9a-fA-F]{24}$/.test(id));
  }

  return unitData;
}

function serializeHoaContext(hoaContext) {
  if (!hoaContext?.hoaId) return null;
  return {
    hoaId: String(hoaContext.hoaId),
    isHOABoardMember: Boolean(hoaContext.isHOABoardMember),
    userId: hoaContext.userId ? String(hoaContext.userId) : null,
    hoaMemberUserIds: Array.isArray(hoaContext.hoaMemberUserIds)
      ? hoaContext.hoaMemberUserIds.map((id) => String(id))
      : [],
  };
}

async function startImport(filePath, fileName, format, userId, hoaContext = null, options = {}) {
  const safePath = safeFilePath(filePath);
  if (!safePath) throw Object.assign(new Error('Invalid upload file path'), { status: 400 });

  const safeFormat = ALLOWED_FORMATS.has(format) ? format : null;
  if (!safeFormat) throw Object.assign(new Error('Unsupported format'), { status: 400 });

  const safeUserId = toObjectId(userId);
  if (!safeUserId) throw Object.assign(new Error('Invalid userId'), { status: 400 });

  const jobId = `import_${uuidv4()}`;
  const serializedHoa = serializeHoaContext(hoaContext);
  const safeHoaId = serializedHoa?.hoaId ? toObjectId(serializedHoa.hoaId) : null;

  const defaultDepositBankAccountId = String(options.defaultDepositBankAccountId || '').trim() || undefined;
  const allowedDepositBankAccountIds = Array.isArray(options.allowedDepositBankAccountIds)
    ? options.allowedDepositBankAccountIds.map((id) => String(id).trim()).filter(Boolean)
    : [];

  if (defaultDepositBankAccountId && !mongoose.Types.ObjectId.isValid(defaultDepositBankAccountId)) {
    const err = new Error('defaultDepositBankAccountId must be a valid ObjectId');
    err.status = 400;
    throw err;
  }

  await ImportJob.create({
    jobId,
    userId: safeUserId,
    hoaId: safeHoaId || undefined,
    defaultDepositBankAccountId,
    allowedDepositBankAccountIds,
    fileName: String(fileName || '').trim().slice(0, 255),
    fileFormat: safeFormat,
    status: 'pending',
    totalRecords: 0,
    processedRecords: 0,
    successCount: 0,
    failedCount: 0,
    errors: [],
  });

  setImmediate(() => processImport(jobId, safePath, safeFormat, safeUserId, serializedHoa));

  return { jobId, status: 'processing' };
}

async function processImport(jobId, filePath, format, userId, hoaContext = null) {
  const safeJobId = sanitizeJobId(jobId);
  if (!safeJobId) return;
  const safePath = safeFilePath(filePath);
  if (!safePath) return;
  let job = await ImportJob.findOne({ jobId: { $eq: safeJobId } });
  if (!job) return;

  try {
    job.status = 'processing';
    await job.save();

    let parsed;
    if (format === 'csv') {
      const content = fs.readFileSync(safePath, 'utf8');
      parsed = parseCSV(content);
    } else if (format === 'json') {
      const content = fs.readFileSync(safePath, 'utf8');
      parsed = parseJSON(content);
    } else if (format === 'xlsx') {
      parsed = await parseExcel(safePath);
    } else {
      throw new Error('Unsupported format');
    }

    const { rows } = parsed;
    if (rows.length > MAX_IMPORT_ROWS) {
      throw Object.assign(
        new Error(`Import is limited to ${MAX_IMPORT_ROWS} rows. Split the file and try again.`),
        { status: 400 }
      );
    }

    job.totalRecords = rows.length;
    await job.save();

    const BATCH_SIZE = 500;
    const errors = [];
    const rowOptions = {
      defaultDepositBankAccountId: job.defaultDepositBankAccountId || '',
      allowedDepositBankAccountIds: job.allowedDepositBankAccountIds || [],
    };
    const serviceOptions = {
      hoaContext: hoaContext?.hoaId
        ? {
            hoaId: hoaContext.hoaId,
            isHOABoardMember: true,
            userId: hoaContext.userId || userId,
            hoaMemberUserIds: hoaContext.hoaMemberUserIds || [],
          }
        : null,
    };

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);

      for (let j = 0; j < batch.length; j += 1) {
        const row = batch[j];
        const rowNum = i + j + 2;

        try {
          const validationErrors = validateRow(row, rowNum, rowOptions);
          if (validationErrors.length > 0) {
            errors.push({ row: rowNum, message: validationErrors.join(', '), data: JSON.stringify(row) });
            job.failedCount += 1;
            continue;
          }

          const unitData = transformRowToUnit(row, userId, serviceOptions.hoaContext, rowOptions);
          await unitService.createUnit(unitData, serviceOptions);
          job.successCount += 1;
        } catch (err) {
          errors.push({ row: rowNum, message: err.message, data: JSON.stringify(row) });
          job.failedCount += 1;
        }

        job.processedRecords += 1;
      }

      await job.save();
    }

    job.status = 'completed';
    job.errors = errors;
    job.completedAt = ClockService.now();
    await job.save();

    try { fs.unlinkSync(safePath); } catch (e) { /* ignore */ }
  } catch (err) {
    job.status = 'failed';
    job.errors = [{ row: 0, message: err.message, data: '' }];
    job.completedAt = ClockService.now();
    await job.save();
    try { fs.unlinkSync(safePath); } catch (e) { /* ignore */ }
  }
}

async function getImportStatus(jobId) {
  const safeJobId = sanitizeJobId(jobId);
  if (!safeJobId) {
    const err = new Error('Import job not found');
    err.status = 404;
    throw err;
  }
  const job = await ImportJob.findOne({ jobId: { $eq: safeJobId } });
  if (!job) {
    const err = new Error('Import job not found');
    err.status = 404;
    throw err;
  }

  return {
    jobId: job.jobId,
    status: job.status,
    totalRecords: job.totalRecords,
    processedRecords: job.processedRecords,
    successCount: job.successCount,
    failedCount: job.failedCount,
    errors: job.errors.slice(0, 100),
    createdAt: job.createdAt,
    completedAt: job.completedAt,
  };
}

function buildUnitExportRows(units) {
  return units.map((u) => [
    u.name || '',
    u.unitDetails?.[0]?.unitName || '',
    u.description || '',
    u.startingBalance || 0,
    u.balanceAsOf ? DateUtil.toISO(u.balanceAsOf).split('T')[0] : '',
    u.monthlyRecurringFee || 0,
    u.paymentTerm || 12,
    u.depositBankAccountId || '',
    u.address?.street || '',
    '',
    u.address?.city || '',
    u.address?.state || '',
    u.address?.zip || '',
    (u.tags || []).join(';'),
    (u.associatedOwnerIds || []).map((id) => id.toString()).join(';'),
  ]);
}

async function exportUnits(userId, format = 'csv', hoaContext = null, listFilters = {}) {
  const Property = require('../../property/model/property.model');
  const {
    mergeSearchClauseIntoFilter,
    buildPropertyTextSearchClauseWithOwners,
  } = require('../../property/helpers/propertyListSearch.helper');

  const filter = { isDeleted: { $ne: true } };
  const hoaMatch = buildHoaBoardPropertyMatch(
    hoaContext?.isHOABoardMember
      ? hoaContext
      : { isHOABoardMember: true, hoaId: hoaContext?.hoaId, userId }
  );

  if (hoaMatch) {
    Object.assign(filter, hoaMatch);
  } else if (userId) {
    const safeUserId = toObjectId(userId);
    if (!safeUserId) {
      const err = new Error('Unable to resolve HOA scope for unit export');
      err.status = 400;
      throw err;
    }
    filter.$or = [
      { landlord_id: safeUserId },
      { createdBy: safeUserId },
      { hoaBoardMemberId: safeUserId },
    ];
  } else {
    const err = new Error('Unable to resolve HOA scope for unit export');
    err.status = 400;
    throw err;
  }

  // Mirror Properties list filters so export matches the filtered UI
  if (listFilters.city) filter['address.city'] = new RegExp(String(listFilters.city).trim(), 'i');
  if (listFilters.state) filter['address.state'] = new RegExp(String(listFilters.state).trim(), 'i');
  if (listFilters.zip) filter['address.zip'] = new RegExp(String(listFilters.zip).trim(), 'i');
  if (listFilters.status && listFilters.status !== 'all') {
    filter.status = listFilters.status;
  }
  // Match property list archived semantics (field name is legacy-spelled isArchieved)
  if (listFilters.showArchived === true || listFilters.showArchived === 'true') {
    filter.isArchieved = true;
  } else {
    filter.isArchieved = { $ne: true };
  }

  const search = String(listFilters.search || '').trim();
  if (search) {
    mergeSearchClauseIntoFilter(
      filter,
      await buildPropertyTextSearchClauseWithOwners(search),
    );
  }

  const units = await Property.find(filter)
    .select('name unitDetails description startingBalance balanceAsOf monthlyRecurringFee paymentTerm depositBankAccountId address tags associatedOwnerIds')
    .limit(MAX_EXPORT_ROWS)
    .lean();
  const dataRows = buildUnitExportRows(units);

  if (format === 'csv') {
    const csv = [UNIT_IMPORT_HEADERS, ...dataRows]
      .map((row) => row.map((cell) => csvEscape(cell)).join(','))
      .join('\n');
    return { content: csv, mimeType: 'text/csv', extension: 'csv' };
  }

  if (format === 'xlsx') {
    const content = await buildExcelBuffer(UNIT_IMPORT_HEADERS, dataRows);
    return {
      content,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      extension: 'xlsx',
    };
  }

  if (format === 'json') {
    const data = units.map((u) => ({
      propertyName: u.name || '',
      title: u.unitDetails?.[0]?.unitName || '',
      description: u.description || '',
      startingBalance: u.startingBalance || 0,
      balanceAsOf: u.balanceAsOf ? DateUtil.toISO(u.balanceAsOf).split('T')[0] : '',
      monthlyRecurringFee: u.monthlyRecurringFee || 0,
      paymentTerm: u.paymentTerm || 12,
      depositBankAccountId: u.depositBankAccountId || '',
      'address[line1]': u.address?.street || '',
      'address[line2]': '',
      'address[city]': u.address?.city || '',
      'address[state]': u.address?.state || '',
      'address[zipCode]': u.address?.zip || '',
      'tags[]': (u.tags || []).join(';'),
      'associatedOwnerIds[]': (u.associatedOwnerIds || []).map((id) => id.toString()).join(';'),
    }));

    return { content: JSON.stringify(data, null, 2), mimeType: 'application/json', extension: 'json' };
  }

  throw new Error('Unsupported format');
}

async function downloadTemplate(format = 'csv', options = {}) {
  const bankId = String(options.depositBankAccountId || '').trim();
  const sampleBankId = mongoose.Types.ObjectId.isValid(bankId)
    ? bankId
    : 'REPLACE_WITH_YOUR_BANK_ACCOUNT_ID';

  const sampleRow = [
    'Sunset Villa', 'Unit 101', 'Modern residential unit', '1000', '2024-01-01',
    '100', '12', sampleBankId,
    '123 Main St', 'Apt 4', 'Los Angeles', 'CA', '90001',
    'residential;premium', '',
  ];

  if (format === 'csv') {
    const csv = [UNIT_IMPORT_HEADERS, sampleRow]
      .map((row) => row.map((cell) => csvEscape(cell)).join(','))
      .join('\n');
    return { content: csv, mimeType: 'text/csv', extension: 'csv' };
  }

  if (format === 'xlsx') {
    const content = await buildExcelBuffer(UNIT_IMPORT_HEADERS, [sampleRow]);
    return {
      content,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      extension: 'xlsx',
    };
  }

  if (format === 'json') {
    const obj = {};
    UNIT_IMPORT_HEADERS.forEach((h, i) => {
      obj[h] = sampleRow[i];
    });
    return { content: JSON.stringify([obj], null, 2), mimeType: 'application/json', extension: 'json' };
  }

  throw new Error('Unsupported format');
}

module.exports = {
  startImport,
  getImportStatus,
  exportUnits,
  downloadTemplate,
  parseCSV,
  validateRow,
  transformRowToUnit,
  MAX_IMPORT_ROWS,
  MAX_EXPORT_ROWS,
};

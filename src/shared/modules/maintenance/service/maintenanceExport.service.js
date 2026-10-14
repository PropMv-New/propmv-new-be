/**
 * ------------------------------------------------------------------
 * File: maintenanceExport.service.js
 * Module: Maintenance Module
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * maintenance.controller
 * ------------------------------------------------------------------
 */

const ExcelJS = require('exceljs');
const maintenanceService = require('./maintenance.service');
const { resolveCreatedBy } = require('../../../../shared/utils/creatorScope.util');
const { ClockService, DateUtil } = require('../../../../common/date');

/**
 * format Requested By Export
 *
 * Performs logic operations for formatRequestedByExport.
 *
 * @param rb - Request/input argument
 * @returns Operations result
 */
function formatRequestedByExport(rb) {
  if (!rb) return '';
  if (Array.isArray(rb)) {
    return rb.map(u => `${u.firstName || ''} ${u.lastName || ''}`.trim()).filter(Boolean).join('; ');
  }
  return `${rb.firstName || ''} ${rb.lastName || ''}`.trim();
}

/** Consistent display labels for export (InProgress → "In Progress"). */
function formatStatusForExport(status) {
  const key = String(status || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  switch (key) {
    case 'open': return 'Open';
    case 'inprogress': return 'In Progress';
    case 'resolved': return 'Resolved';
    case 'rejected': return 'Rejected';
    case 'reopened': return 'Reopened';
    case 'completed': return 'Completed';
    case 'closed': return 'Closed';
    default: {
      const raw = String(status || '').trim();
      return raw ? raw.replace(/([a-z])([A-Z])/g, '$1 $2') : '';
    }
  }
}

/**
 * Export maintenance requests in CSV format
 */
function listOptionsFromExport(filters = {}, options = {}) {
  const pageSize = options.pageSize ?? filters.pageSize ?? 100;
  const pageNumber = options.pageNumber ?? filters.pageNumber ?? 1;
  return {
    pageNumber,
    pageSize,
    userContext: options.userContext || null,
  };
}

function sanitizeExportFilters(filters = {}) {
  const q = Object.assign({}, filters);
  delete q.pageNumber;
  delete q.pageSize;
  delete q.page;
  delete q.format;
  return q;
}

async function exportMaintenanceAsCSV(filters = {}, options = {}) {
  const result = await maintenanceService.listMaintenanceRequests(
    sanitizeExportFilters(filters),
    listOptionsFromExport(filters, options),
  );
  const data = (result && result.data) || [];

  if (!data || data.length === 0) {
    return { filename: `maintenance_export_${Date.now()}.csv`, content: 'No maintenance requests found', contentType: 'text/csv' };
  }

  const headers = ['title', 'property', 'unit', 'category', 'priority', 'status', 'requestDate', 'requestedBy', 'isUrgent'];

  /**
   * csv Escape
   *
   * Performs logic operations for csvEscape.
   *
   * @param val - Request/input argument
   * @returns Operations result
   */
  function csvEscape(val) {
    if (val === null || typeof val === 'undefined') return '""';
    if (typeof val === 'object') {
      try { val = JSON.stringify(val); } catch { val = String(val); }
    }
    let s = String(val);
    if (/^[+\-=@]/.test(s.charAt(0))) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  const rows = [headers.join(',')];
  for (const rowObj of data) {
    const requestedByName = formatRequestedByExport(rowObj.requestedBy);
    
    const mapped = {
      title: rowObj.title || '',
      property: rowObj.propertyName || '',
      unit: rowObj.unitName || rowObj.units || '',
      category: rowObj.category || '',
      priority: rowObj.priority || '',
      status: formatStatusForExport(rowObj.status),
      requestDate: rowObj.request_date ? (DateUtil.toEST(rowObj.request_date) || DateUtil.toDateOnlyISO(rowObj.request_date)) : '',
      requestedBy: requestedByName,
      isUrgent: rowObj.isUrgent ? 'Yes' : 'No'
    };
    const row = headers.map(h => csvEscape(mapped[h]));
    rows.push(row.join(','));
  }

  const csv = rows.join('\n');
  const ownerId = resolveCreatedBy(filters || {}) || 'all';
  const ts = DateUtil.buildExportFilenameTimestamp();
  const filename = `maintenance_${ownerId}_${ts}.csv`;

  return { filename, content: csv, contentType: 'text/csv' };
}

/**
 * Export maintenance requests in Excel format
 */
async function exportMaintenanceAsExcel(filters = {}, options = {}) {
  const result = await maintenanceService.listMaintenanceRequests(
    sanitizeExportFilters(filters),
    listOptionsFromExport(filters, options),
  );
  const data = (result && result.data) || [];

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Maintenance');

  // Define columns
  worksheet.columns = [
    { header: 'Title', key: 'title', width: 30 },
    { header: 'Property', key: 'property', width: 25 },
    { header: 'Unit', key: 'unit', width: 15 },
    { header: 'Category', key: 'category', width: 15 },
    { header: 'Priority', key: 'priority', width: 12 },
    { header: 'Status', key: 'status', width: 15 },
    { header: 'Request Date', key: 'requestDate', width: 15 },
    { header: 'Requested By', key: 'requestedBy', width: 25 },
    { header: 'Urgent', key: 'isUrgent', width: 10 }
  ];

  // Style header row
  worksheet.getRow(1).font = { bold: true };
  worksheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE0E0E0' }
  };

  // Add data rows
  for (const rowObj of data) {
    const requestedByName = formatRequestedByExport(rowObj.requestedBy);
    
    worksheet.addRow({
      title: rowObj.title || '',
      property: rowObj.propertyName || '',
      unit: rowObj.unitName || rowObj.units || '',
      category: rowObj.category || '',
      priority: rowObj.priority || '',
      status: formatStatusForExport(rowObj.status),
      requestDate: rowObj.request_date ? (DateUtil.toEST(rowObj.request_date) || DateUtil.toDateOnlyISO(rowObj.request_date)) : '',
      requestedBy: requestedByName,
      isUrgent: rowObj.isUrgent ? 'Yes' : 'No'
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  
  const ownerId = resolveCreatedBy(filters || {}) || 'all';
  const ts = DateUtil.buildExportFilenameTimestamp();
  const filename = `maintenance_${ownerId}_${ts}.xlsx`;

  return { filename, content: buffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
}

/**
 * Export maintenance requests in JSON format
 */
async function exportMaintenanceAsJSON(filters = {}, options = {}) {
  const result = await maintenanceService.listMaintenanceRequests(
    sanitizeExportFilters(filters),
    listOptionsFromExport(filters, options),
  );
  const data = (result && result.data) || [];

  const exportData = data.map(rowObj => {
    const requestedByName = formatRequestedByExport(rowObj.requestedBy);
    
    return {
      title: rowObj.title || '',
      property: rowObj.propertyName || '',
      unit: rowObj.unitName || rowObj.units || '',
      category: rowObj.category || '',
      priority: rowObj.priority || '',
      status: formatStatusForExport(rowObj.status),
      requestDate: rowObj.request_date || '',
      requestedBy: requestedByName,
      isUrgent: rowObj.isUrgent,
      description: rowObj.description || '',
      estimatedCost: rowObj.estimatedCost || 0,
      actualCost: rowObj.actualCost || 0,
      completedDate: rowObj.completedDate || null
    };
  });

  const json = JSON.stringify({ maintenanceRequests: exportData, total: data.length, exportedAt: DateUtil.toISO(ClockService.now()) }, null, 2);
  
  const ownerId = resolveCreatedBy(filters || {}) || 'all';
  const ts = DateUtil.buildExportFilenameTimestamp();
  const filename = `maintenance_${ownerId}_${ts}.json`;

  return { filename, content: json, contentType: 'application/json' };
}

/**
 * Main export function that routes to appropriate format handler
 */
async function exportMaintenance(filters = {}, format = 'csv', options = {}) {
  const formatLower = String(format).toLowerCase();
  
  switch (formatLower) {
    case 'xlsx':
    case 'excel':
      return await exportMaintenanceAsExcel(filters, options);
    case 'json':
      return await exportMaintenanceAsJSON(filters, options);
    case 'csv':
    default:
      return await exportMaintenanceAsCSV(filters, options);
  }
}

module.exports = {
  exportMaintenance,
  exportMaintenanceAsCSV,
  exportMaintenanceAsExcel,
  exportMaintenanceAsJSON
};



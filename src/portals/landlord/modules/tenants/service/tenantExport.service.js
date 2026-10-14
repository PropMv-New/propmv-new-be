/**
 * ------------------------------------------------------------------
 * File: tenantExport.service.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * tenant.controller
 * ------------------------------------------------------------------
 */

const ExcelJS = require('exceljs');
const tenantService = require('./tenant.service');
const { resolveCreatedBy } = require('../../../../../shared/utils/creatorScope.util');
const { ClockService, DateUtil } = require('../../../../../common/date');

/**
 * Export tenants in CSV format
 */
async function exportTenantsAsCSV(filters = {}) {
  const result = await tenantService.listTenantsWithDetails(filters, {});
  const data = (result && result.data) || [];

  if (!data || data.length === 0) {
    return { filename: `tenants_export_${Date.now()}.csv`, content: 'No tenants found', contentType: 'text/csv' };
  }

  const headers = ['name', 'email', 'phone', 'address', 'propertyName', 'unitName', 'tenantStatus', 'rent', 'roommates', 'leaseStart', 'leaseEnd'];

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
    const mapped = {
      name: rowObj.name || '',
      email: rowObj.email || '',
      phone: rowObj.phone || '',
      address: rowObj.address || '',
      propertyName: rowObj.propertyName || '',
      unitName: rowObj.unitName || '',
      tenantStatus: rowObj.tenantStatus || '',
      rent: rowObj.rent || 0,
      roommates: rowObj.roommates || 0,
      leaseStart: rowObj.leaseStart ? DateUtil.toDateOnlyISO(rowObj.leaseStart) : '',
      leaseEnd: rowObj.leaseEnd ? DateUtil.toDateOnlyISO(rowObj.leaseEnd) : ''
    };
    const row = headers.map(h => csvEscape(mapped[h]));
    rows.push(row.join(','));
  }

  const csv = rows.join('\n');
  const ownerId = resolveCreatedBy(filters || {}) || 'all';
  const ts = DateUtil.buildExportFilenameTimestamp();
  const filename = `tenants_${ownerId}_${ts}.csv`;

  return { filename, content: csv, contentType: 'text/csv' };
}

/**
 * Export tenants in Excel format
 */
async function exportTenantsAsExcel(filters = {}) {
  const result = await tenantService.listTenantsWithDetails(filters, {});
  const data = (result && result.data) || [];

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Tenants');

  // Define columns
  worksheet.columns = [
    { header: 'Tenant Name', key: 'name', width: 25 },
    { header: 'Email', key: 'email', width: 30 },
    { header: 'Phone', key: 'phone', width: 18 },
    { header: 'Address', key: 'address', width: 35 },
    { header: 'Property Name', key: 'propertyName', width: 25 },
    { header: 'Unit Name', key: 'unitName', width: 15 },
    { header: 'Status', key: 'tenantStatus', width: 15 },
    { header: 'Rent', key: 'rent', width: 12 },
    { header: 'Roommates', key: 'roommates', width: 12 },
    { header: 'Lease Start', key: 'leaseStart', width: 15 },
    { header: 'Lease End', key: 'leaseEnd', width: 15 }
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
    worksheet.addRow({
      name: rowObj.name || '',
      email: rowObj.email || '',
      phone: rowObj.phone || '',
      address: rowObj.address || '',
      propertyName: rowObj.propertyName || '',
      unitName: rowObj.unitName || '',
      tenantStatus: rowObj.tenantStatus || '',
      rent: rowObj.rent || 0,
      roommates: rowObj.roommates || 0,
      leaseStart: rowObj.leaseStart ? DateUtil.toDateOnlyISO(rowObj.leaseStart) : '',
      leaseEnd: rowObj.leaseEnd ? DateUtil.toDateOnlyISO(rowObj.leaseEnd) : ''
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  
  const ownerId = resolveCreatedBy(filters || {}) || 'all';
  const ts = DateUtil.buildExportFilenameTimestamp();
  const filename = `tenants_${ownerId}_${ts}.xlsx`;

  return { filename, content: buffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
}

/**
 * Export tenants in JSON format
 */
async function exportTenantsAsJSON(filters = {}) {
  const result = await tenantService.listTenantsWithDetails(filters, {});
  const data = (result && result.data) || [];

  const exportData = data.map(rowObj => ({
    tenantId: rowObj.tenantId,
    name: rowObj.name || '',
    email: rowObj.email || '',
    phone: rowObj.phone || '',
    address: rowObj.address || '',
    state: rowObj.state || '',
    zipCode: rowObj.zipCode || '',
    propertyName: rowObj.propertyName || '',
    unitName: rowObj.unitName || '',
    tenantStatus: rowObj.tenantStatus || '',
    rent: rowObj.rent || 0,
    roommates: rowObj.roommates || 0,
    leaseId: rowObj.leaseId,
    leaseStart: rowObj.leaseStart,
    leaseEnd: rowObj.leaseEnd
  }));

  const json = JSON.stringify({ tenants: exportData, total: data.length, exportedAt: DateUtil.toISO(ClockService.now()) }, null, 2);
  
  const ownerId = resolveCreatedBy(filters || {}) || 'all';
  const ts = DateUtil.buildExportFilenameTimestamp();
  const filename = `tenants_${ownerId}_${ts}.json`;

  return { filename, content: json, contentType: 'application/json' };
}

/**
 * Main export function that routes to appropriate format handler
 */
async function exportTenants(filters = {}, format = 'csv') {
  const formatLower = String(format).toLowerCase();
  
  switch (formatLower) {
    case 'xlsx':
    case 'excel':
      return await exportTenantsAsExcel(filters);
    case 'json':
      return await exportTenantsAsJSON(filters);
    case 'csv':
    default:
      return await exportTenantsAsCSV(filters);
  }
}

module.exports = {
  exportTenants,
  exportTenantsAsCSV,
  exportTenantsAsExcel,
  exportTenantsAsJSON
};

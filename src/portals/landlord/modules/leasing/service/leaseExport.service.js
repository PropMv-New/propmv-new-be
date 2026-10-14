/**
 * ------------------------------------------------------------------
 * File: leaseExport.service.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * lease.controller
 * ------------------------------------------------------------------
 */

const ExcelJS = require('exceljs');
const leaseService = require('./lease.service');
const { ClockService, DateUtil } = require('../../../../../common/date');

/**
 * Export leases in CSV format
 */
async function exportLeasesAsCSV(filters = {}) {
  const result = await leaseService.listLeasesByLandlordService({ ...filters, pageSize: 0 });
  const data = (result && result.data) || [];

  if (!data || data.length === 0) {
    return { filename: `leases_export_${Date.now()}.csv`, content: 'No leases found', contentType: 'text/csv' };
  }

  const headers = ['propertyName', 'unitName', 'tenants', 'status', 'rent', 'dates', 'documents'];

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
      propertyName: rowObj.propertyName || '',
      unitName: rowObj.unitName || '',
      tenants: rowObj.tenants || '',
      status: rowObj.status || '',
      rent: rowObj.rent || 0,
      dates: rowObj.dates || '',
      documents: rowObj.documents || 'Unsigned'
    };
    const row = headers.map(h => csvEscape(mapped[h]));
    rows.push(row.join(','));
  }

  const csv = rows.join('\n');
  const createdBy = filters && filters.createdBy ? String(filters.createdBy) : 'all';
  const dt = ClockService.now();
  const pad = (n) => (n < 10 ? '0' + n : n);
  const ts = `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}_${pad(dt.getHours())}${pad(dt.getMinutes())}${pad(dt.getSeconds())}`;
  const filename = `leases_${createdBy}_${ts}.csv`;

  return { filename, content: csv, contentType: 'text/csv' };
}

/**
 * Export leases in Excel format
 */
async function exportLeasesAsExcel(filters = {}) {
  const result = await leaseService.listLeasesByLandlordService({ ...filters, pageSize: 0 });
  const data = (result && result.data) || [];

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Leases');

  // Define columns
  worksheet.columns = [
    { header: 'Property Name', key: 'propertyName', width: 30 },
    { header: 'Unit Name', key: 'unitName', width: 20 },
    { header: 'Tenants', key: 'tenants', width: 35 },
    { header: 'Status', key: 'status', width: 15 },
    { header: 'Rent', key: 'rent', width: 15 },
    { header: 'Dates', key: 'dates', width: 30 },
    { header: 'Documents', key: 'documents', width: 15 }
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
      propertyName: rowObj.propertyName || '',
      unitName: rowObj.unitName || '',
      tenants: rowObj.tenants || '',
      status: rowObj.status || '',
      rent: rowObj.rent || 0,
      dates: rowObj.dates || '',
      documents: rowObj.documents || 'Unsigned'
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  
  const createdBy = filters && filters.createdBy ? String(filters.createdBy) : 'all';
  const dt = ClockService.now();
  const pad = (n) => (n < 10 ? '0' + n : n);
  const ts = `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}_${pad(dt.getHours())}${pad(dt.getMinutes())}${pad(dt.getSeconds())}`;
  const filename = `leases_${createdBy}_${ts}.xlsx`;

  return { filename, content: buffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
}

/**
 * Export leases in JSON format
 */
async function exportLeasesAsJSON(filters = {}) {
  const result = await leaseService.listLeasesByLandlordService({ ...filters, pageSize: 0 });
  const data = (result && result.data) || [];

  const exportData = data.map(rowObj => ({
    propertyName: rowObj.propertyName || '',
    unitName: rowObj.unitName || '',
    tenants: rowObj.tenants || '',
    tenantDetails: rowObj.tenantDetails || [],
    propertyAddress: rowObj.propertyAddress || '',
    status: rowObj.status || '',
    rent: rowObj.rent || 0,
    dates: rowObj.dates || '',
    documents: rowObj.documents || 'Unsigned'
  }));

  const json = JSON.stringify({ leases: exportData, total: data.length, exportedAt: DateUtil.toISO(ClockService.now()) }, null, 2);
  
  const createdBy = filters && filters.createdBy ? String(filters.createdBy) : 'all';
  const dt = ClockService.now();
  const pad = (n) => (n < 10 ? '0' + n : n);
  const ts = `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}_${pad(dt.getHours())}${pad(dt.getMinutes())}${pad(dt.getSeconds())}`;
  const filename = `leases_${createdBy}_${ts}.json`;

  return { filename, content: json, contentType: 'application/json' };
}

/**
 * Main export function that routes to appropriate format handler
 */
async function exportLeases(filters = {}, format = 'csv') {
  const formatLower = String(format).toLowerCase();
  
  switch (formatLower) {
    case 'xlsx':
    case 'excel':
      return await exportLeasesAsExcel(filters);
    case 'json':
      return await exportLeasesAsJSON(filters);
    case 'csv':
    default:
      return await exportLeasesAsCSV(filters);
  }
}

module.exports = {
  exportLeases,
  exportLeasesAsCSV,
  exportLeasesAsExcel,
  exportLeasesAsJSON
};

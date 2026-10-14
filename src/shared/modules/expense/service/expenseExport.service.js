/**
 * ------------------------------------------------------------------
 * File: expenseExport.service.js
 * Module: Expense Module
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * expense.controller
 * ------------------------------------------------------------------
 */

const ExcelJS = require('exceljs');
const expenseService = require('./expense.service');
const { resolveCreatedBy } = require('../../../../shared/utils/creatorScope.util');
const { ClockService, DateUtil } = require('../../../../common/date');

/**
 * Export expenses in CSV format
 */
async function exportExpensesAsCSV(filters = {}) {
  const result = await expenseService.listExpenses(filters);
  const data = (result && result.data) || [];

  if (!data || data.length === 0) {
    return { filename: `expenses_export_${Date.now()}.csv`, content: 'No expenses found', contentType: 'text/csv' };
  }

  const headers = ['property', 'unit', 'vendor', 'category', 'expenseDate', 'paymentDate', 'status', 'amount'];

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
    const propertyName = rowObj.property && rowObj.property.name ? rowObj.property.name : '';
    const category = rowObj.expenseItems && rowObj.expenseItems.length > 0 ? rowObj.expenseItems[0].category : '';
    
    const mapped = {
      property: propertyName,
      unit: rowObj.unit || '',
      vendor: rowObj.vendorPaidTo || '',
      category: category,
      expenseDate: rowObj.expenseDate ? DateUtil.toDateOnlyISO(rowObj.expenseDate) : '',
      paymentDate: rowObj.paymentDate ? DateUtil.toDateOnlyISO(rowObj.paymentDate) : '',
      status: rowObj.status || '',
      amount: rowObj.total || 0
    };
    const row = headers.map(h => csvEscape(mapped[h]));
    rows.push(row.join(','));
  }

  const csv = rows.join('\n');
  const ownerId = resolveCreatedBy(filters || {}) || 'all';
  const ts = DateUtil.buildExportFilenameTimestamp();
  const filename = `expenses_${ownerId}_${ts}.csv`;

  return { filename, content: csv, contentType: 'text/csv' };
}

/**
 * Export expenses in Excel format
 */
async function exportExpensesAsExcel(filters = {}) {
  const result = await expenseService.listExpenses(filters);
  const data = (result && result.data) || [];

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Expenses');

  // Define columns
  worksheet.columns = [
    { header: 'Property', key: 'property', width: 30 },
    { header: 'Unit', key: 'unit', width: 15 },
    { header: 'Vendor', key: 'vendor', width: 25 },
    { header: 'Category', key: 'category', width: 20 },
    { header: 'Expense Date', key: 'expenseDate', width: 15 },
    { header: 'Payment Date', key: 'paymentDate', width: 15 },
    { header: 'Status', key: 'status', width: 15 },
    { header: 'Amount', key: 'amount', width: 15 }
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
    const propertyName = rowObj.property && rowObj.property.name ? rowObj.property.name : '';
    const category = rowObj.expenseItems && rowObj.expenseItems.length > 0 ? rowObj.expenseItems[0].category : '';
    
    worksheet.addRow({
      property: propertyName,
      unit: rowObj.unit || '',
      vendor: rowObj.vendorPaidTo || '',
      category: category,
      expenseDate: rowObj.expenseDate ? DateUtil.toDateOnlyISO(rowObj.expenseDate) : '',
      paymentDate: rowObj.paymentDate ? DateUtil.toDateOnlyISO(rowObj.paymentDate) : '',
      status: rowObj.status || '',
      amount: rowObj.total || 0
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  
  const ownerId = resolveCreatedBy(filters || {}) || 'all';
  const ts = DateUtil.buildExportFilenameTimestamp();
  const filename = `expenses_${ownerId}_${ts}.xlsx`;

  return { filename, content: buffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
}

/**
 * Export expenses in JSON format
 */
async function exportExpensesAsJSON(filters = {}) {
  const result = await expenseService.listExpenses(filters);
  const data = (result && result.data) || [];

  const exportData = data.map(rowObj => {
    const propertyName = rowObj.property && rowObj.property.name ? rowObj.property.name : '';
    const category = rowObj.expenseItems && rowObj.expenseItems.length > 0 ? rowObj.expenseItems[0].category : '';
    
    return {
      property: propertyName,
      unit: rowObj.unit || '',
      vendor: rowObj.vendorPaidTo || '',
      category: category,
      expenseDate: rowObj.expenseDate || '',
      paymentDate: rowObj.paymentDate || '',
      status: rowObj.status || '',
      amount: rowObj.total || 0,
      taxableEntity: rowObj.taxableEntity || '',
      bankAccount: rowObj.bankAccount || '',
      payees: rowObj.payees || [],
      expenseItems: rowObj.expenseItems || []
    };
  });

  const json = JSON.stringify({ expenses: exportData, total: data.length, exportedAt: DateUtil.toISO(ClockService.now()) }, null, 2);
  
  const ownerId = resolveCreatedBy(filters || {}) || 'all';
  const ts = DateUtil.buildExportFilenameTimestamp();
  const filename = `expenses_${ownerId}_${ts}.json`;

  return { filename, content: json, contentType: 'application/json' };
}

/**
 * Main export function that routes to appropriate format handler
 */
async function exportExpenses(filters = {}, format = 'csv') {
  const formatLower = String(format).toLowerCase();
  
  switch (formatLower) {
    case 'xlsx':
    case 'excel':
      return await exportExpensesAsExcel(filters);
    case 'json':
      return await exportExpensesAsJSON(filters);
    case 'csv':
    default:
      return await exportExpensesAsCSV(filters);
  }
}

module.exports = {
  exportExpenses,
  exportExpensesAsCSV,
  exportExpensesAsExcel,
  exportExpensesAsJSON
};

/**
 * ------------------------------------------------------------------
 * File: propertyExport.service.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * property.controller
 * ------------------------------------------------------------------
 */

const ExcelJS = require('exceljs');
const propertyService = require('./property.service');
const { ClockService, DateUtil } = require('../../../../../common/date');

/**
 * Export properties in CSV format
 */
async function exportPropertiesAsCSV(filters = {}) {
  const result = await propertyService.getPropertiesService(filters);
  const data = (result && result.data) || [];

  if (!data || data.length === 0) {
    return { filename: `properties_export_${Date.now()}.csv`, content: 'No properties found', contentType: 'text/csv' };
  }

  const headers = ['name', 'address', 'rent', 'amountOverdue', 'leaseExpiration90', 'status', 'openMaintenance', 'closedMaintenance', 'tenants'];

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
    // Extract tenant names from units
    let tenantNames = '';
    if (Array.isArray(rowObj.units)) {
      const allTenants = [];
      rowObj.units.forEach(unit => {
        if (Array.isArray(unit.tenants)) {
          unit.tenants.forEach(t => {
            allTenants.push(t.name || 'Unknown');
          });
        }
      });
      tenantNames = allTenants.join('; ');
    }

    const mapped = {
      name: rowObj.name || '',
      address: rowObj.address || '',
      rent: rowObj.totalRent || 0,
      amountOverdue: rowObj.totalAmountOverdue || 0,
      leaseExpiration90: rowObj.leaseExpiration90 || 'Not Expiring',
      status: rowObj.occupancyStatus || rowObj.overallStatus || 'Vacant',
      openMaintenance: rowObj.totalOpenMaintenance || 0,
      closedMaintenance: rowObj.totalClosedMaintenance || 0,
      tenants: tenantNames
    };
    const row = headers.map(h => csvEscape(mapped[h]));
    rows.push(row.join(','));
  }

  const csv = rows.join('\n');
  const createdBy = filters && filters.createdBy ? String(filters.createdBy) : 'all';
  const ts = DateUtil.buildExportFilenameTimestamp();
  const filename = `properties_${createdBy}_${ts}.csv`;

  return { filename, content: csv, contentType: 'text/csv' };
}

/**
 * Export properties in Excel format
 */
async function exportPropertiesAsExcel(filters = {}) {
  const result = await propertyService.getPropertiesService(filters);
  const data = (result && result.data) || [];

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Properties');

  // Define columns
  worksheet.columns = [
    { header: 'Property Name', key: 'name', width: 30 },
    { header: 'Address', key: 'address', width: 40 },
    { header: 'Rent', key: 'rent', width: 15 },
    { header: 'Amount Overdue', key: 'amountOverdue', width: 15 },
    { header: 'Lease Status', key: 'leaseExpiration90', width: 20 },
    { header: 'Status', key: 'status', width: 15 },
    { header: 'Open Maintenance', key: 'openMaintenance', width: 18 },
    { header: 'Closed Maintenance', key: 'closedMaintenance', width: 18 },
    { header: 'Tenants', key: 'tenants', width: 30 }
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
    // Extract tenant names from units
    let tenantNames = '';
    if (Array.isArray(rowObj.units)) {
      const allTenants = [];
      rowObj.units.forEach(unit => {
        if (Array.isArray(unit.tenants)) {
          unit.tenants.forEach(t => {
            allTenants.push(t.name || 'Unknown');
          });
        }
      });
      tenantNames = allTenants.join(', ');
    }

    worksheet.addRow({
      name: rowObj.name || '',
      address: rowObj.address || '',
      rent: rowObj.totalRent || 0,
      amountOverdue: rowObj.totalAmountOverdue || 0,
      leaseExpiration90: rowObj.leaseExpiration90 || 'Not Expiring',
      status: rowObj.occupancyStatus || rowObj.overallStatus || 'Vacant',
      openMaintenance: rowObj.totalOpenMaintenance || 0,
      closedMaintenance: rowObj.totalClosedMaintenance || 0,
      tenants: tenantNames
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  
  const createdBy = filters && filters.createdBy ? String(filters.createdBy) : 'all';
  const ts = DateUtil.buildExportFilenameTimestamp();
  const filename = `properties_${createdBy}_${ts}.xlsx`;

  return { filename, content: buffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
}

/**
 * Export properties in JSON format
 */
async function exportPropertiesAsJSON(filters = {}) {
  const result = await propertyService.getPropertiesService(filters);
  const data = (result && result.data) || [];

  const exportData = data.map(rowObj => {
    // Extract tenant names from units
    const allTenants = [];
    if (Array.isArray(rowObj.units)) {
      rowObj.units.forEach(unit => {
        if (Array.isArray(unit.tenants)) {
          unit.tenants.forEach(t => {
            allTenants.push({
              id: t.id,
              name: t.name || 'Unknown',
              email: t.email,
              phone: t.phone
            });
          });
        }
      });
    }

    return {
      name: rowObj.name || '',
      address: rowObj.address || '',
      rent: rowObj.totalRent || 0,
      amountOverdue: rowObj.totalAmountOverdue || 0,
      leaseExpiration90: rowObj.leaseExpiration90 || 'Not Expiring',
      status: rowObj.occupancyStatus || rowObj.overallStatus || 'Vacant',
      openMaintenance: rowObj.totalOpenMaintenance || 0,
      closedMaintenance: rowObj.totalClosedMaintenance || 0,
      totalUnits: rowObj.totalUnits || 0,
      occupiedUnits: rowObj.occupiedUnits || 0,
      vacantUnits: rowObj.vacantUnits || 0,
      units: rowObj.units || [],
      tenants: allTenants
    };
  });

  const json = JSON.stringify({ properties: exportData, total: data.length, exportedAt: DateUtil.toISO(ClockService.now()) }, null, 2);
  
  const createdBy = filters && filters.createdBy ? String(filters.createdBy) : 'all';
  const ts = DateUtil.buildExportFilenameTimestamp();
  const filename = `properties_${createdBy}_${ts}.json`;

  return { filename, content: json, contentType: 'application/json' };
}

/**
 * Main export function that routes to appropriate format handler
 */
async function exportProperties(filters = {}, format = 'csv') {
  const formatLower = String(format).toLowerCase();
  
  switch (formatLower) {
    case 'xlsx':
    case 'excel':
      return await exportPropertiesAsExcel(filters);
    case 'json':
      return await exportPropertiesAsJSON(filters);
    case 'csv':
    default:
      return await exportPropertiesAsCSV(filters);
  }
}

/**
 * Generate import template for properties in CSV format
 */
async function generatePropertyTemplateCSV() {
  // Define the template columns matching the import structure
  const headers = [
    "Property Name",
    "Property Type",
    "Ownership Type",
    "Description",
    "Owner Name",
    "Owner Email",
    "Owner Phone",
    "Owner Type",
    "Address Street",
    "Address City",
    "Address State",
    "Address Zip",
    "Address Country",
    "Address Line 2",
    "Unit Name",
    "Unit Type",
    "Bedrooms",
    "Bathrooms",
    "Square Feet",
    "Unit Amenities",
    "Property Manager",
    "Has HOA",
    "Amenities",
    "Tags",
    "Bank Account Entity Type",
    "Bank Account First Name",
    "Bank Account Last Name",
    "Bank Account Email",
    "Bank Account Phone",
    "Bank Account SSN",
    "Bank Account Business Name",
    "Bank Account EIN",
    "Bank Account Bank Name",
    "Bank Account Account Type",
    "Bank Account Routing Number",
    "Bank Account Number",
    "Bank Account Address Street",
    "Bank Account Address City",
    "Bank Account Address State",
    "Bank Account Address Zip"
  ];

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

  // Create header row
  const rows = [headers.join(',')];

  // Create example row 1 - Downtown Loft
  const example1 = {
    "Property Name": "Downtown Loft",
    "Property Type": "Apartment",
    "Ownership Type": "Individual",
    "Description": "Modern downtown loft in prime location",
    "Owner Name": "John Smith",
    "Owner Email": "john.smith@example.com",
    "Owner Phone": "(555) 123-4567",
    "Owner Type": "Primary",
    "Address Street": "123 Main Street",
    "Address City": "New York",
    "Address State": "NY",
    "Address Zip": "10001",
    "Address Country": "USA",
    "Address Line 2": "Suite 500",
    "Unit Name": "Unit 501",
    "Unit Type": "2BR/1BA",
    "Bedrooms": "2",
    "Bathrooms": "1",
    "Square Feet": "850",
    "Unit Amenities": "Hardwood floors, Modern kitchen, High ceilings",
    "Property Manager": "Jane Doe",
    "Has HOA": "true",
    "Amenities": "Gym, Pool, Concierge, Parking",
    "Tags": "Downtown, Luxury, Modern",
    "Bank Account Entity Type": "Individual",
    "Bank Account First Name": "John",
    "Bank Account Last Name": "Smith",
    "Bank Account Email": "john.smith@example.com",
    "Bank Account Phone": "(555) 123-4567",
    "Bank Account SSN": "XXX-XX-1234",
    "Bank Account Business Name": "",
    "Bank Account EIN": "",
    "Bank Account Bank Name": "Chase Bank",
    "Bank Account Account Type": "Checking",
    "Bank Account Routing Number": "021000021",
    "Bank Account Number": "1234567890",
    "Bank Account Address Street": "123 Main Street",
    "Bank Account Address City": "New York",
    "Bank Account Address State": "NY",
    "Bank Account Address Zip": "10001"
  };

  const row1 = headers.map(h => csvEscape(example1[h] || ''));
  rows.push(row1.join(','));

  // Create example row 2 - Suburban Family Home
  const example2 = {
    "Property Name": "Suburban Family Home",
    "Property Type": "House",
    "Ownership Type": "LLC",
    "Description": "Spacious 4-bedroom house in quiet suburb",
    "Owner Name": "Sarah Johnson",
    "Owner Email": "sarah.johnson@example.com",
    "Owner Phone": "(555) 987-6543",
    "Owner Type": "Primary",
    "Address Street": "456 Oak Avenue",
    "Address City": "Los Angeles",
    "Address State": "CA",
    "Address Zip": "90001",
    "Address Country": "USA",
    "Address Line 2": "",
    "Unit Name": "Main House",
    "Unit Type": "4BR/3BA",
    "Bedrooms": "4",
    "Bathrooms": "3",
    "Square Feet": "2500",
    "Unit Amenities": "Backyard, Garage, Updated appliances",
    "Property Manager": "Bob Wilson",
    "Has HOA": "false",
    "Amenities": "Large yard, 2-car garage",
    "Tags": "Family-friendly, Suburban, Spacious",
    "Bank Account Entity Type": "Business",
    "Bank Account First Name": "",
    "Bank Account Last Name": "",
    "Bank Account Email": "info@sarahjohnson.com",
    "Bank Account Phone": "(555) 987-6543",
    "Bank Account SSN": "",
    "Bank Account Business Name": "Sarah Johnson LLC",
    "Bank Account EIN": "12-3456789",
    "Bank Account Bank Name": "Bank of America",
    "Bank Account Account Type": "Business Checking",
    "Bank Account Routing Number": "026009593",
    "Bank Account Number": "9876543210",
    "Bank Account Address Street": "456 Oak Avenue",
    "Bank Account Address City": "Los Angeles",
    "Bank Account Address State": "CA",
    "Bank Account Address Zip": "90001"
  };

  const row2 = headers.map(h => csvEscape(example2[h] || ''));
  rows.push(row2.join(','));

  const csv = rows.join('\n');
  const ts = DateUtil.buildExportFilenameTimestamp();
  const filename = `property_import_template_${ts}.csv`;

  return { filename, content: csv, contentType: 'text/csv' };
}

/**
 * Generate import template for properties in Excel format
 */
async function generatePropertyTemplateExcel() {
  const headers = [
    "Property Name",
    "Property Type",
    "Ownership Type",
    "Description",
    "Owner Name",
    "Owner Email",
    "Owner Phone",
    "Owner Type",
    "Address Street",
    "Address City",
    "Address State",
    "Address Zip",
    "Address Country",
    "Address Line 2",
    "Unit Name",
    "Unit Type",
    "Bedrooms",
    "Bathrooms",
    "Square Feet",
    "Unit Amenities",
    "Property Manager",
    "Has HOA",
    "Amenities",
    "Tags",
    "Bank Account Entity Type",
    "Bank Account First Name",
    "Bank Account Last Name",
    "Bank Account Email",
    "Bank Account Phone",
    "Bank Account SSN",
    "Bank Account Business Name",
    "Bank Account EIN",
    "Bank Account Bank Name",
    "Bank Account Account Type",
    "Bank Account Routing Number",
    "Bank Account Number",
    "Bank Account Address Street",
    "Bank Account Address City",
    "Bank Account Address State",
    "Bank Account Address Zip"
  ];

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Property Template');

  // Define columns
  worksheet.columns = headers.map((header, idx) => ({
    header: header,
    key: header,
    width: header.length > 20 ? 20 : 15
  }));

  // Style header row
  worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  worksheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF4472C4' }
  };

  // Add example data rows
  const examples = [
    {
      "Property Name": "Downtown Loft",
      "Property Type": "Apartment",
      "Ownership Type": "Individual",
      "Description": "Modern downtown loft in prime location",
      "Owner Name": "John Smith",
      "Owner Email": "john.smith@example.com",
      "Owner Phone": "(555) 123-4567",
      "Owner Type": "Primary",
      "Address Street": "123 Main Street",
      "Address City": "New York",
      "Address State": "NY",
      "Address Zip": "10001",
      "Address Country": "USA",
      "Address Line 2": "Suite 500",
      "Unit Name": "Unit 501",
      "Unit Type": "2BR/1BA",
      "Bedrooms": 2,
      "Bathrooms": 1,
      "Square Feet": 850,
      "Unit Amenities": "Hardwood floors, Modern kitchen, High ceilings",
      "Property Manager": "Jane Doe",
      "Has HOA": "true",
      "Amenities": "Gym, Pool, Concierge, Parking",
      "Tags": "Downtown, Luxury, Modern",
      "Bank Account Entity Type": "Individual",
      "Bank Account First Name": "John",
      "Bank Account Last Name": "Smith",
      "Bank Account Email": "john.smith@example.com",
      "Bank Account Phone": "(555) 123-4567",
      "Bank Account SSN": "XXX-XX-1234",
      "Bank Account Business Name": "",
      "Bank Account EIN": "",
      "Bank Account Bank Name": "Chase Bank",
      "Bank Account Account Type": "Checking",
      "Bank Account Routing Number": "021000021",
      "Bank Account Number": "1234567890",
      "Bank Account Address Street": "123 Main Street",
      "Bank Account Address City": "New York",
      "Bank Account Address State": "NY",
      "Bank Account Address Zip": "10001"
    },
    {
      "Property Name": "Suburban Family Home",
      "Property Type": "House",
      "Ownership Type": "LLC",
      "Description": "Spacious 4-bedroom house in quiet suburb",
      "Owner Name": "Sarah Johnson",
      "Owner Email": "sarah.johnson@example.com",
      "Owner Phone": "(555) 987-6543",
      "Owner Type": "Primary",
      "Address Street": "456 Oak Avenue",
      "Address City": "Los Angeles",
      "Address State": "CA",
      "Address Zip": "90001",
      "Address Country": "USA",
      "Address Line 2": "",
      "Unit Name": "Main House",
      "Unit Type": "4BR/3BA",
      "Bedrooms": 4,
      "Bathrooms": 3,
      "Square Feet": 2500,
      "Unit Amenities": "Backyard, Garage, Updated appliances",
      "Property Manager": "Bob Wilson",
      "Has HOA": "false",
      "Amenities": "Large yard, 2-car garage",
      "Tags": "Family-friendly, Suburban, Spacious",
      "Bank Account Entity Type": "Business",
      "Bank Account First Name": "",
      "Bank Account Last Name": "",
      "Bank Account Email": "info@sarahjohnson.com",
      "Bank Account Phone": "(555) 987-6543",
      "Bank Account SSN": "",
      "Bank Account Business Name": "Sarah Johnson LLC",
      "Bank Account EIN": "12-3456789",
      "Bank Account Bank Name": "Bank of America",
      "Bank Account Account Type": "Business Checking",
      "Bank Account Routing Number": "026009593",
      "Bank Account Number": "9876543210",
      "Bank Account Address Street": "456 Oak Avenue",
      "Bank Account Address City": "Los Angeles",
      "Bank Account Address State": "CA",
      "Bank Account Address Zip": "90001"
    }
  ];

  for (const example of examples) {
    worksheet.addRow(example);
  }

  // Auto-fit columns
  worksheet.columns.forEach(column => {
    column.width = Math.min(column.width, 30);
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const ts = DateUtil.buildExportFilenameTimestamp();
  const filename = `property_import_template_${ts}.xlsx`;

  return { filename, content: buffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
}

/**
 * Generate import template based on format
 */
async function generatePropertyTemplate(format = 'csv') {
  switch (format) {
    case 'xlsx':
    case 'excel':
      return await generatePropertyTemplateExcel();
    case 'csv':
    default:
      return await generatePropertyTemplateCSV();
  }
}

module.exports = {
  exportProperties,
  exportPropertiesAsCSV,
  exportPropertiesAsExcel,
  exportPropertiesAsJSON,
  generatePropertyTemplate,
  generatePropertyTemplateCSV,
  generatePropertyTemplateExcel
};

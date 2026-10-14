'use strict';

/**
 * Minimal single-page PDF builder for vendor invoice snapshots attached to expenses.
 * Avoids adding a PDF library dependency; content is plain Helvetica text.
 */

function escapePdfText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function formatMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '$0.00';
  return `$${n.toFixed(2)}`;
}

function buildVendorInvoicePdfLines(invoice = {}) {
  const lines = [];
  const invoiceNumber = String(invoice.invoiceNumber || invoice._id || 'Invoice').trim();
  const title = String(invoice.title || 'Vendor invoice').trim();
  lines.push('Vendor Invoice');
  lines.push(`Invoice #: ${invoiceNumber}`);
  lines.push(`Title: ${title}`);
  if (invoice.status) lines.push(`Status: ${invoice.status}`);
  if (invoice.dueDate) {
    const due = new Date(invoice.dueDate);
    if (!Number.isNaN(due.getTime())) {
      lines.push(`Due date: ${due.toISOString().slice(0, 10)}`);
    }
  }
  if (invoice.paidAt) {
    const paid = new Date(invoice.paidAt);
    if (!Number.isNaN(paid.getTime())) {
      lines.push(`Paid date: ${paid.toISOString().slice(0, 10)}`);
    }
  }
  lines.push('');
  lines.push('Line items');
  const items = Array.isArray(invoice.lineItems) ? invoice.lineItems : [];
  if (items.length === 0) {
    lines.push(`1. ${title} — ${formatMoney(invoice.subAmount)}`);
  } else {
    items.forEach((item, index) => {
      const desc = String(item.description || 'Line item').slice(0, 80);
      const qty = Number(item.quantity || 1);
      const rate = formatMoney(item.rate);
      const amount = formatMoney(item.amount != null ? item.amount : qty * Number(item.rate || 0));
      lines.push(`${index + 1}. ${desc}`);
      lines.push(`   Qty ${qty} x ${rate} = ${amount}`);
    });
  }
  lines.push('');
  lines.push(`Subtotal: ${formatMoney(invoice.subAmount)}`);
  lines.push(`Amount paid: ${formatMoney(invoice.amountPaid)}`);
  lines.push(`Balance due: ${formatMoney(invoice.balanceDue)}`);
  return lines;
}

/**
 * Build a valid PDF Buffer containing the invoice summary lines.
 */
function buildVendorInvoicePdfBuffer(invoice = {}) {
  const textLines = buildVendorInvoicePdfLines(invoice).slice(0, 40);
  const contentParts = ['BT', '/F1 11 Tf', '50 780 Td', '14 TL'];
  textLines.forEach((line, index) => {
    const escaped = escapePdfText(line);
    if (index === 0) {
      contentParts.push(`(${escaped}) Tj`);
    } else {
      contentParts.push('T*');
      contentParts.push(`(${escaped}) Tj`);
    }
  });
  contentParts.push('ET');
  const stream = contentParts.join('\n');
  const streamLength = Buffer.byteLength(stream, 'utf8');

  const objects = [];
  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  objects.push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  objects.push(
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
    + '/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n'
  );
  objects.push(
    `4 0 obj\n<< /Length ${streamLength} >>\nstream\n${stream}\nendstream\nendobj\n`
  );
  objects.push('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += obj;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'utf8');
}

function vendorInvoiceAttachmentFileName(invoice = {}) {
  const raw = String(invoice.invoiceNumber || invoice._id || 'invoice')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `VendorInvoice-${raw || 'invoice'}.pdf`;
}

module.exports = {
  buildVendorInvoicePdfLines,
  buildVendorInvoicePdfBuffer,
  vendorInvoiceAttachmentFileName,
  formatMoney,
};

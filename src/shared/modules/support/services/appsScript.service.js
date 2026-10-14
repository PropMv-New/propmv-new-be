/**
 * Google Apps Script Web App integration for support tickets.
 *
 * Instead of the Sheets API + service account, the sheet owns a small Apps
 * Script deployed as a Web App. We POST the ticket as JSON and the script
 * appends the row itself - no Google Cloud project, no keys to manage.
 *
 * Required env var:
 *   GOOGLE_APPS_SCRIPT_URL - the Web App deployment URL
 *     (looks like https://script.google.com/macros/s/AKfyc.../exec)
 *
 * Failures here are logged by the caller and never block the support flow.
 */
const axios = require('axios');

const REQUEST_TIMEOUT_MS = Number(process.env.APPS_SCRIPT_TIMEOUT_MS || 10000);

function isAppsScriptConfigured() {
  return Boolean(process.env.GOOGLE_APPS_SCRIPT_URL);
}

/**
 * Send one support ticket to the Apps Script Web App.
 * Payload mirrors the sheet columns:
 * Timestamp | Name | Email | Phone | Topic | Message | Role | User ID
 */
async function sendTicketToAppsScript(ticket) {
  await axios.post(
    process.env.GOOGLE_APPS_SCRIPT_URL,
    {
      timestamp: ticket.timestamp,
      name: ticket.name,
      email: ticket.email,
      phone: ticket.phone || '',
      topic: ticket.topic || '',
      message: ticket.message,
      role: ticket.role || '',
      userId: ticket.userId || '',
    },
    {
      timeout: REQUEST_TIMEOUT_MS,
      // Apps Script responds with a 302 to script.googleusercontent.com;
      // axios follows it by default, so a 2xx after redirect means success.
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

module.exports = { isAppsScriptConfigured, sendTicketToAppsScript };

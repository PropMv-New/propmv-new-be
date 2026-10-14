/**
 * ------------------------------------------------------------------
 * File: index.js
 * Module: Backend Integrations
 *
 * Purpose:
 * Backend utility/module providing helper functions for index.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

const notificationClient = require('./notificationClient');
const notify = require('./notify');
const EVENTS = require('./notificationEvents');

module.exports = { ...notificationClient, notify, EVENTS };

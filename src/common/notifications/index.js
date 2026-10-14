/**
 * ------------------------------------------------------------------
 * File: index.js
 * Module: Src Common Notifications
 *
 * Purpose:
 * Backend utility/module providing helper functions for index.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

const notify = require('./notify');
const EVENTS = require('./notificationEvents');

module.exports = { notify, EVENTS };

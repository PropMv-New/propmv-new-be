/**
 * ------------------------------------------------------------------
 * File: module.model.js
 * Module: Src Shared Modules Auth Models
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * add-hoa-modules, mark-hoa-specific-modules, roles.service, companyCreation.helper
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');

const moduleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String },
    functions: [{ type: String, trim: true }], // Array of function names (e.g., ['VIEW', 'CREATE', 'EDIT', 'DELETE'])
    isHoaSpecificModule: { type: Boolean, default: false }, // Flag to identify HOA-specific modules
  },
  { timestamps: true }
);

const Module = mongoose.models.Module || mongoose.model('Module', moduleSchema);

module.exports = Module;

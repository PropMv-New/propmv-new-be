/**
 * ------------------------------------------------------------------
 * File: function.model.js
 * Module: Src Shared Modules Auth Models
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * cleanup-old-modules, functions.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');

const functionSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String },
  },
  { timestamps: true }
);

const Function = mongoose.models.Function || mongoose.model('Function', functionSchema);

module.exports = Function;



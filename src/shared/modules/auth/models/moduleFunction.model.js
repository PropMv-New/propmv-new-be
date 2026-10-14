/**
 * ------------------------------------------------------------------
 * File: moduleFunction.model.js
 * Module: Src Shared Modules Auth Models
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');

const moduleFunctionSchema = new mongoose.Schema(
  {
    module: { type: mongoose.Schema.Types.ObjectId, ref: 'Module', required: true },
    function: { type: mongoose.Schema.Types.ObjectId, ref: 'Function', required: true },
  },
  { timestamps: true }
);

const ModuleFunction = mongoose.models.ModuleFunction || mongoose.model('ModuleFunction', moduleFunctionSchema);

module.exports = ModuleFunction;

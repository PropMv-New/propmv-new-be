/**
 * ------------------------------------------------------------------
 * File: auth-roles-functions.js
 * Module: Src Docs Api-schemas
 *
 * Purpose:
 * Backend utility/module providing helper functions for auth-roles-functions.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// Additional Auth Schemas for Roles and Functions
// This file contains schemas for auth role and function management APIs

const authRolesFunctionsSchemas = {
  "POST /api/v1/auth/role": {
    schema: {
      type: "object",
      required: ["name", "functions"],
      properties: {
        name: { type: "string", minLength: 1 },
        description: { type: "string" },
        functions: {
          type: "array",
          minItems: 1,
          items: { type: "string", pattern: "^[0-9a-fA-F]{24}$" }
        }
      },
      additionalProperties: false
    },
    example: {
      name: "Property Manager",
      description: "Manages properties and tenants",
      functions: ["60f7a0b8c2a3f2b1c0d4e5f6", "60f7a0b8c2a3f2b1c0d4e5f7"]
    }
  },
  "PUT /api/v1/auth/role/{id}": {
    schema: {
      type: "object",
      required: ["functions"],
      properties: {
        name: { type: "string", minLength: 1 },
        description: { type: "string" },
        functions: {
          type: "array",
          minItems: 1,
          items: { type: "string", pattern: "^[0-9a-fA-F]{24}$" }
        }
      },
      additionalProperties: false
    },
    example: {
      name: "Updated Property Manager",
      description: "Updated description",
      functions: ["60f7a0b8c2a3f2b1c0d4e5f6", "60f7a0b8c2a3f2b1c0d4e5f7"]
    }
  },
  "POST /api/v1/auth/function": {
    schema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1 },
        description: { type: "string" }
      },
      additionalProperties: false
    },
    example: {
      name: "Create Property",
      description: "Allows creating new properties"
    }
  },
  "PUT /api/v1/auth/function/{id}": {
    schema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1 },
        description: { type: "string" }
      },
      additionalProperties: false
    },
    example: {
      name: "Updated Function Name",
      description: "Updated function description"
    }
  }
};

module.exports = authRolesFunctionsSchemas;
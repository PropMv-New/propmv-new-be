/**
 * ------------------------------------------------------------------
 * File: verify-propmv-company.js
 * Module: Admin Scripts
 *
 * Purpose:
 * Administrative script for database sync, testing, or system maintenance tasks.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Company = require('../src/shared/modules/company/models/company.model');
const path = require('path');
const fs = require('fs');

// Load environment
const envPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
} else {
  require('dotenv').config();
}

async function verifyPropMvCompany() {
  try {
    console.log('═'.repeat(70));
    console.log('  Verify PropMv Company');
    console.log('═'.repeat(70));
    console.log('');

    const mongoUri = process.env.MONGODB_URI || process.env.DB_URL || 'mongodb://localhost:27017/propmv';
    console.log('📡 Connecting to MongoDB...\n');

    await mongoose.connect(mongoUri, {
      dbName: process.env.DB_NAME || 'PropMv'
    });

    // Find PropMv company
    const company = await Company.findOne({ name: 'PropMv', isDeleted: { $ne: true } });

    if (!company) {
      console.log(' PropMv company not found!\n');
      console.log('💡 Run: node scripts/create-propmv-company-with-roles.js\n');
      await mongoose.disconnect();
      process.exit(1);
    }

    console.log('PropMv Company Found!\n');
    console.log('═'.repeat(70));
    console.log('  Company Details');
    console.log('═'.repeat(70));
    console.log(`\nCompany ID: ${company._id}`);
    console.log(`Name: ${company.name}`);
    console.log(`Description: ${company.description}`);
    console.log(`Active: ${company.isActive}`);
    console.log(`Created: ${company.createdAt}`);
    console.log(`Total Roles: ${company.roles.length}`);
    console.log(`Active Roles: ${company.roles.filter(r => r.isActive).length}\n`);

    console.log('═'.repeat(70));
    console.log('  Roles and Privileges Detail');
    console.log('═'.repeat(70));

    company.roles.forEach((role, index) => {
      console.log(`\n${index + 1}. ${role.name}`);
      console.log('─'.repeat(70));
      console.log(`   Role ID: ${role._id}`);
      console.log(`   Description: ${role.description}`);
      console.log(`   Active: ${role.isActive}`);
      console.log(`   Total Privileges: ${role.privileges.length}`);
      console.log('\n   Privileges:');

      // Group privileges by category
      const privilegesByCategory = {};
      role.privileges.forEach(priv => {
        const parts = priv.split('_');
        const action = parts[0]; // VIEW, CREATE, EDIT, DELETE
        const category = parts.slice(1).join('_'); // PROPERTY, TENANT, etc.

        if (!privilegesByCategory[category]) {
          privilegesByCategory[category] = [];
        }
        privilegesByCategory[category].push(action);
      });

      Object.entries(privilegesByCategory).sort().forEach(([category, actions]) => {
        console.log(`     • ${category}: ${actions.join(', ')}`);
      });
    });

    console.log('\n' + '═'.repeat(70));
    console.log('  Privilege Summary');
    console.log('═'.repeat(70));
    console.log('');

    // Create privilege summary table
    const allPrivileges = new Set();
    company.roles.forEach(role => {
      role.privileges.forEach(priv => allPrivileges.add(priv));
    });

    const roleNames = company.roles.map(r => r.name);
    const privilegeMatrix = [];

    allPrivileges.forEach(priv => {
      const row = { privilege: priv };
      company.roles.forEach(role => {
        row[role.name] = role.privileges.includes(priv) ? '✓' : '✗';
      });
      privilegeMatrix.push(row);
    });

    // Display matrix header
    console.log('Privilege'.padEnd(30) + roleNames.map(name => name.padEnd(18)).join(''));
    console.log('─'.repeat(30 + (roleNames.length * 18)));

    // Sort and display privileges
    privilegeMatrix.sort((a, b) => a.privilege.localeCompare(b.privilege));
    privilegeMatrix.forEach(row => {
      const privilegeName = row.privilege.padEnd(30);
      const checks = roleNames.map(name => row[name].padEnd(18)).join('');
      console.log(privilegeName + checks);
    });

    console.log('\n' + '═'.repeat(70));
    console.log('Verification completed successfully!');
    console.log('═'.repeat(70));
    console.log('');

    console.log('\nPropMv company verification passed');
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('\n Error:', error.message);
    console.error(error.stack);

    if (mongoose.connection.readyState === 1) {
      await mongoose.disconnect();
    }
    process.exit(1);
  }
}

verifyPropMvCompany();

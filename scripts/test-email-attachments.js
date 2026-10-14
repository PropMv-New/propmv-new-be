/**
 * ------------------------------------------------------------------
 * File: test-email-attachments.js
 * Module: Admin Scripts
 *
 * Purpose:
 * Administrative script for database sync, testing, or system maintenance tasks.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

/**
 * Email Attachment Functionality Test Script
 * 
 * This script tests the email attachment functionality including:
 * - Uploading attachments
 * - Saving drafts with attachments
 * - Sending emails with attachments
 * - Downloading attachments
 * - Deleting attachments
 * 
 * Run this script after starting the backend server:
 * node propmv/scripts/test-email-attachments.js
 */

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

// Configuration
const BASE_URL = process.env.API_URL || 'http://localhost:3000';
const API_BASE = `${BASE_URL}/api/v1`;

// Test user credentials (update with valid credentials)
const TEST_USER = {
  email: process.env.TEST_USER_EMAIL || "user@domain.com",
  password: process.env.TEST_USER_PASSWORD || "",
};

let authToken = '';
let testDraftId = '';
let testAttachmentId = '';
let testEmailId = '';

// Helper function to create a test file
function createTestFile(filename, content) {
  const testDir = path.resolve(__dirname, 'test-files');
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }
  const safeName = path.basename(filename);
  const filePath = path.join(testDir, safeName);
  if (!filePath.startsWith(testDir + path.sep)) {
    throw new Error(`Invalid filename: ${filename}`);
  }
  fs.writeFileSync(filePath, content);
  return filePath;
}

// Helper function to login and get auth token
async function login() {
  try {
    console.log('🔐 Logging in...');
    const response = await axios.post(`${API_BASE}/auth/login`, TEST_USER);
    authToken = response.data.token || response.data.data?.token;
    console.log('Login successful');
    return authToken;
  } catch (error) {
    console.error(' Login failed:', error.response?.data || error.message);
    throw error;
  }
}

// Test 1: Upload attachments
async function testUploadAttachments() {
  try {
    console.log('\n📤 Test 1: Upload Attachments');

    // Create test files
    const file1Path = createTestFile('test-document.txt', 'This is a test document for email attachment.');
    const file2Path = createTestFile('test-image.txt', 'This is a test image file.');

    const formData = new FormData();
    formData.append('attachments', fs.createReadStream(file1Path));
    formData.append('attachments', fs.createReadStream(file2Path));

    const response = await axios.post(
      `${API_BASE}/email/upload-attachments`,
      formData,
      {
        headers: {
          ...formData.getHeaders(),
          'Authorization': `Bearer ${authToken}`
        }
      }
    );

    console.log('Attachments uploaded successfully');
    console.log('📎 Attachments:', JSON.stringify(response.data.data.attachments, null, 2));

    // Store first attachment ID for later tests
    if (response.data.data.attachments.length > 0) {
      testAttachmentId = response.data.data.attachments[0].documentMetadataId;
    }

    // Cleanup test files
    fs.unlinkSync(file1Path);
    fs.unlinkSync(file2Path);

    return response.data.data.attachments;
  } catch (error) {
    console.error(' Upload attachments failed:', error.response?.data || error.message);
    throw error;
  }
}

// Test 2: Save draft with attachments
async function testSaveDraftWithAttachments(attachments) {
  try {
    console.log('\n💾 Test 2: Save Draft with Attachments');

    const filePath = createTestFile('draft-attachment.txt', 'This is a draft attachment.');

    const formData = new FormData();
    formData.append('to', 'recipient@example.com');
    formData.append('subject', 'Test Draft with Attachments');
    formData.append('body', 'This is a test draft email with attachments.');
    formData.append('attachments', JSON.stringify(attachments));
    formData.append('attachments', fs.createReadStream(filePath));

    const response = await axios.post(
      `${API_BASE}/email/draft/save`,
      formData,
      {
        headers: {
          ...formData.getHeaders(),
          'Authorization': `Bearer ${authToken}`
        }
      }
    );

    console.log('Draft saved successfully');
    console.log('📧 Draft ID:', response.data.data.draft.id || response.data.data.draft._id);
    console.log('📎 Attachments:', response.data.data.draft.attachments?.length || 0);

    testDraftId = response.data.data.draft.id || response.data.data.draft._id;
    testEmailId = testDraftId;

    // Cleanup test file
    fs.unlinkSync(filePath);

    return response.data.data.draft;
  } catch (error) {
    console.error(' Save draft failed:', error.response?.data || error.message);
    throw error;
  }
}

// Test 3: List drafts with attachments
async function testListDrafts() {
  try {
    console.log('\n📋 Test 3: List Drafts with Attachments');

    const response = await axios.get(
      `${API_BASE}/email/draft/list`,
      {
        headers: {
          'Authorization': `Bearer ${authToken}`
        }
      }
    );

    console.log('Drafts retrieved successfully');
    console.log('📧 Total drafts:', response.data.data.drafts.length);

    response.data.data.drafts.forEach((draft, index) => {
      console.log(`\nDraft ${index + 1}:`);
      console.log('  Subject:', draft.subject);
      console.log('  Attachments:', draft.attachments?.length || 0);
      if (draft.attachments && draft.attachments.length > 0) {
        draft.attachments.forEach((att, attIndex) => {
          console.log(`    ${attIndex + 1}. ${att.originalName} (${(att.size / 1024).toFixed(2)} KB)`);
        });
      }
    });

    return response.data.data.drafts;
  } catch (error) {
    console.error(' List drafts failed:', error.response?.data || error.message);
    throw error;
  }
}

// Test 4: Download attachment
async function testDownloadAttachment() {
  try {
    console.log('\n⬇️ Test 4: Download Attachment');

    if (!testEmailId || !testAttachmentId) {
      console.log('⚠️ Skipping download test - no email or attachment ID available');
      return;
    }

    const response = await axios.get(
      `${API_BASE}/email/${testEmailId}/attachment/${testAttachmentId}/download`,
      {
        headers: {
          'Authorization': `Bearer ${authToken}`
        },
        responseType: 'arraybuffer'
      }
    );

    console.log('Attachment downloaded successfully');
    console.log('📦 Content-Type:', response.headers['content-type']);
    console.log('📦 Content-Length:', response.headers['content-length']);

    const downloadDir = path.resolve(__dirname, 'test-files');
    const downloadPath = path.join(downloadDir, 'downloaded-attachment.txt');
    if (!downloadPath.startsWith(downloadDir + path.sep)) {
      throw new Error('Invalid download path');
    }
    fs.writeFileSync(downloadPath, response.data);
    console.log('💾 Saved to:', downloadPath);

    return response.data;
  } catch (error) {
    console.error(' Download attachment failed:', error.response?.data || error.message);
    throw error;
  }
}

// Test 5: Delete attachment from draft
async function testDeleteAttachment() {
  try {
    console.log('\n🗑️ Test 5: Delete Attachment from Draft');

    if (!testEmailId || !testAttachmentId) {
      console.log('⚠️ Skipping delete test - no email or attachment ID available');
      return;
    }

    const response = await axios.delete(
      `${API_BASE}/email/${testEmailId}/attachment/${testAttachmentId}`,
      {
        headers: {
          'Authorization': `Bearer ${authToken}`
        }
      }
    );

    console.log('Attachment deleted successfully');

    return response.data;
  } catch (error) {
    console.error(' Delete attachment failed:', error.response?.data || error.message);
    throw error;
  }
}

// Test 6: Send email with attachments
async function testSendEmailWithAttachments() {
  try {
    console.log('\n📧 Test 6: Send Email with Attachments');

    const filePath = createTestFile('send-attachment.txt', 'This is an attachment for sent email.');

    const formData = new FormData();
    formData.append('to', 'recipient@example.com');
    formData.append('subject', 'Test Email with Attachments');
    formData.append('body', 'This is a test email with attachments sent via API.');
    formData.append('attachments', fs.createReadStream(filePath));

    const response = await axios.post(
      `${API_BASE}/email/send`,
      formData,
      {
        headers: {
          ...formData.getHeaders(),
          'Authorization': `Bearer ${authToken}`
        }
      }
    );

    console.log('Email sent successfully');
    console.log('📧 Message ID:', response.data.data.messageId);

    // Cleanup test file
    fs.unlinkSync(filePath);

    return response.data.data;
  } catch (error) {
    console.error(' Send email failed:', error.response?.data || error.message);
    // Don't throw - email sending might fail if SMTP is not configured
    console.log('⚠️ This is expected if SMTP is not configured');
  }
}

// Test 7: List sent emails with attachments
async function testListSentEmails() {
  try {
    console.log('\n📬 Test 7: List Sent Emails with Attachments');

    const response = await axios.get(
      `${API_BASE}/email/sent?maxResults=10`,
      {
        headers: {
          'Authorization': `Bearer ${authToken}`
        }
      }
    );

    console.log('Sent emails retrieved successfully');
    console.log('📧 Total sent emails:', response.data.data.emails.length);

    response.data.data.emails.forEach((email, index) => {
      console.log(`\nEmail ${index + 1}:`);
      console.log('  To:', email.to);
      console.log('  Subject:', email.subject);
      console.log('  Attachments:', email.attachments?.length || 0);
      if (email.attachments && email.attachments.length > 0) {
        email.attachments.forEach((att, attIndex) => {
          console.log(`    ${attIndex + 1}. ${att.originalName} (${(att.size / 1024).toFixed(2)} KB)`);
        });
      }
    });

    return response.data.data.emails;
  } catch (error) {
    console.error(' List sent emails failed:', error.response?.data || error.message);
    throw error;
  }
}

// Main test runner
async function runTests() {
  console.log('🚀 Starting Email Attachment Tests\n');
  console.log('='.repeat(60));

  try {
    // Login
    await login();

    // Run tests
    const attachments = await testUploadAttachments();
    await testSaveDraftWithAttachments(attachments);
    await testListDrafts();
    await testDownloadAttachment();
    await testDeleteAttachment();
    await testSendEmailWithAttachments();
    await testListSentEmails();

    console.log('\n' + '='.repeat(60));
    console.log('All tests completed successfully!');
    console.log('='.repeat(60));

  } catch (error) {
    console.log('\n' + '='.repeat(60));
    console.error(' Tests failed:', error.message);
    console.log('='.repeat(60));
    process.exit(1);
  }
}

// Run tests
runTests();

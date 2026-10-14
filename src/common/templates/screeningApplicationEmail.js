/**
 * ------------------------------------------------------------------
 * File: screeningApplicationEmail.js
 * Module: Src Common Templates
 *
 * Purpose:
 * Backend utility/module providing helper functions for screeningApplicationEmail.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

/**
 * Tenant Screening Application Invitation Email Template
 * Modern, attractive, and intuitive design for inviting tenants to complete screening
 */

function createScreeningApplicationEmailTemplate(tenantName, propertyName, landlordName, screensScreening = [], applicationLink) {
    const screeningLabels = {
        application: "Application Form",
        credit: "Credit Check",
        criminal: "Criminal Background Check"
    };

    const screeningDescriptions = {
        application: "Complete a detailed rental application to provide essential tenant information",
        credit: "Authorization for credit report review to assess financial responsibility",
        criminal: "Permission for comprehensive criminal background verification"
    };

    const screensHTML = screensScreening
        .map(screening => `
      <div style="background: #f8f9fa; border-left: 4px solid #0066cc; padding: 16px; margin: 12px 0; border-radius: 4px;">
        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 8px;">
          <div style="width: 24px; height: 24px; background: #0066cc; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; font-size: 14px;">✓</div>
          <h3 style="margin: 0; font-size: 16px; font-weight: 600; color: #1a1a1a;">${screeningLabels[screening] || screening}</h3>
        </div>
        <p style="margin: 0; font-size: 14px; color: #666; line-height: 1.5;">${screeningDescriptions[screening] || screening}</p>
      </div>
    `)
        .join('');

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Complete Your Tenant Screening</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
            padding: 20px;
            min-height: 100vh;
        }
        
        .email-container {
            max-width: 600px;
            margin: 0 auto;
            background: white;
            border-radius: 12px;
            overflow: hidden;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.1);
        }
        
        .header {
            background: linear-gradient(135deg, #0066cc 0%, #0052a3 100%);
            padding: 40px 30px;
            text-align: center;
            color: white;
        }
        
        .header h1 {
            font-size: 28px;
            margin-bottom: 8px;
            font-weight: 700;
            letter-spacing: -0.5px;
        }
        
        .header p {
            font-size: 14px;
            opacity: 0.95;
            font-weight: 500;
        }
        
        .content {
            padding: 40px 30px;
        }
        
        .greeting {
            font-size: 16px;
            color: #1a1a1a;
            margin-bottom: 24px;
            line-height: 1.6;
        }
        
        .greeting strong {
            color: #0066cc;
            font-weight: 600;
        }
        
        .info-box {
            background: #e8f0ff;
            border-left: 4px solid #0066cc;
            padding: 16px;
            margin: 24px 0;
            border-radius: 6px;
            font-size: 14px;
            color: #333;
            line-height: 1.6;
        }
        
        .screening-section {
            margin: 32px 0;
        }
        
        .screening-section h2 {
            font-size: 18px;
            color: #1a1a1a;
            margin-bottom: 20px;
            font-weight: 600;
        }
        
        .screening-item {
            background: #f8f9fa;
            border-left: 4px solid #0066cc;
            padding: 16px;
            margin: 12px 0;
            border-radius: 4px;
        }
        
        .screening-item-header {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 8px;
        }
        
        .screening-item-icon {
            width: 24px;
            height: 24px;
            background: #0066cc;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: bold;
            font-size: 14px;
            flex-shrink: 0;
        }
        
        .screening-item-title {
            margin: 0;
            font-size: 16px;
            font-weight: 600;
            color: #1a1a1a;
        }
        
        .screening-item-description {
            margin: 0;
            font-size: 14px;
            color: #666;
            line-height: 1.5;
        }
        
        .cta-section {
            margin: 32px 0;
            text-align: center;
        }
        
        .cta-button {
            display: inline-block;
            background: linear-gradient(135deg, #0066cc 0%, #0052a3 100%);
            color: white;
            text-decoration: none;
            padding: 14px 40px;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            transition: all 0.3s ease;
            box-shadow: 0 4px 12px rgba(0, 102, 204, 0.3);
        }
        
        .cta-button:hover {
            background: linear-gradient(135deg, #0052a3 0%, #003d7a 100%);
            box-shadow: 0 6px 16px rgba(0, 102, 204, 0.4);
            transform: translateY(-2px);
        }
        
        .steps-section {
            background: #f8f9fa;
            padding: 24px;
            border-radius: 8px;
            margin: 24px 0;
        }
        
        .steps-section h3 {
            font-size: 15px;
            color: #1a1a1a;
            font-weight: 600;
            margin-bottom: 16px;
        }
        
        .step {
            display: flex;
            gap: 12px;
            margin-bottom: 12px;
            font-size: 14px;
            color: #666;
            line-height: 1.5;
        }
        
        .step-number {
            min-width: 28px;
            width: 28px;
            height: 28px;
            background: #0066cc;
            color: white;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 600;
            font-size: 13px;
        }
        
        .footer {
            background: #f8f9fa;
            padding: 24px 30px;
            border-top: 1px solid #e5e7eb;
            font-size: 13px;
            color: #666;
            line-height: 1.6;
        }
        
        .footer-content {
            max-width: 100%;
        }
        
        .footer p {
            margin-bottom: 8px;
        }
        
        .footer a {
            color: #0066cc;
            text-decoration: none;
        }
        
        .footer a:hover {
            text-decoration: underline;
        }
        
        .divider {
            height: 1px;
            background: #e5e7eb;
            margin: 16px 0;
        }
        
        .property-info {
            background: #f0f4ff;
            padding: 16px;
            border-radius: 6px;
            margin: 16px 0;
            font-size: 14px;
        }
        
        .property-info strong {
            color: #0066cc;
        }
        
        @media (max-width: 600px) {
            .content {
                padding: 24px 20px;
            }
            
            .header {
                padding: 30px 20px;
            }
            
            .header h1 {
                font-size: 24px;
            }
            
            .footer {
                padding: 16px 20px;
            }
        }
    </style>
</head>
<body>
    <div class="email-container">
        <!-- Header -->
        <div class="header">
            <h1>📋 Tenant Screening Required</h1>
            <p>Complete Your Application</p>
        </div>
        
        <!-- Content -->
        <div class="content">
            <!-- Greeting -->
            <div class="greeting">
                Hello <strong>${tenantName}</strong>,<br><br>
                We're excited to move forward with your rental application for <strong>${propertyName}</strong>! 
                To complete the process, we need you to undergo screening to ensure a smooth leasing experience for everyone.
            </div>
            
            <!-- Property Info -->
            <div class="property-info">
                <strong>📍 Property:</strong> ${propertyName}<br>
                <strong>🏢 Landlord:</strong> ${landlordName}
            </div>
            
            <!-- Info Box -->
            <div class="info-box">
                ℹ️ <strong>What's Next?</strong> We've prepared a screening application tailored to your rental needs. 
                Your information will be kept confidential and used solely for tenant verification purposes.
            </div>
            
            <!-- Screening Section -->
            <div class="screening-section">
                <h2>📊 Screening Components</h2>
                ${screensHTML}
            </div>
            
            <!-- Steps Section -->
            <div class="steps-section">
                <h3>⏱️ How It Works</h3>
                <div class="step">
                    <div class="step-number">1</div>
                    <div>Click the button below to start your application</div>
                </div>
                <div class="step">
                    <div class="step-number">2</div>
                    <div>Fill in your information accurately and completely</div>
                </div>
                <div class="step">
                    <div class="step-number">3</div>
                    <div>Grant necessary permissions for background checks</div>
                </div>
                <div class="step">
                    <div class="step-number">4</div>
                    <div>Submit and we'll review your application promptly</div>
                </div>
            </div>
            
            <!-- CTA Button -->
            <div class="cta-section">
                <a href="${applicationLink}" class="cta-button">Start Screening Application</a>
            </div>
            
            <!-- Additional Info -->
            <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 16px; margin: 24px 0; border-radius: 4px; font-size: 14px; color: #856404;">
                <strong>⏰ Important:</strong> Please complete your screening within 5 business days to keep your application active. 
                If you have any questions, don't hesitate to reach out to us.
            </div>
        </div>
        
        <!-- Footer -->
        <div class="footer">
            <div class="footer-content">
                <p>
                    <strong>Questions?</strong> Contact us at <a href="mailto:support@propmv.com">support@propmv.com</a> 
                    or call us at 1-800-PROPMV (1-800-776-7688)
                </p>
                <div class="divider"></div>
                <p>
                    © 2026 PropMv. All rights reserved.<br>
                    <a href="#">Privacy Policy</a> | <a href="#">Terms of Service</a> | <a href="#">Contact Us</a>
                </p>
                <p style="margin-top: 12px; color: #999;">
                    This is an automated message. Please do not reply to this email.
                </p>
            </div>
        </div>
    </div>
</body>
</html>
  `;
}

module.exports = { createScreeningApplicationEmailTemplate };

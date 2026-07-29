const nodemailer = require('nodemailer');

const createTransporter = (emailConfig = {}) => {
  const host = emailConfig.emailHost || process.env.EMAIL_HOST;
  const port = emailConfig.emailPort ? parseInt(emailConfig.emailPort) : parseInt(process.env.EMAIL_PORT || '587');
  const user = emailConfig.emailUser || process.env.EMAIL_USER;
  const pass = emailConfig.emailPass || process.env.EMAIL_PASS;

  // Determine secure setting:
  // Port 465 requires secure: true (Implicit TLS/SSL)
  // Port 587 / 25 / 2525 require secure: false (Explicit STARTTLS)
  let secure;
  if (port === 465) {
    secure = true;
  } else if (typeof emailConfig.emailSecure === 'boolean') {
    secure = emailConfig.emailSecure;
  } else if (port === 587 || port === 25 || port === 2525) {
    secure = false;
  } else {
    secure = process.env.EMAIL_SECURE === 'true';
  }

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    tls: { rejectUnauthorized: false }, // needed for some cPanel mail setups
    connectionTimeout: 10000, // 10s connection timeout
    greetingTimeout: 10000,   // 10s greeting timeout
    socketTimeout: 15000,     // 15s socket timeout
  });
};

// ── Email Templates ──────────────────────────────────────────────────
const templates = {
  SUBMITTED: (req) => {
    const reqId = req.tempVendorNumber || req.crNumber || req._id;
    const vendorName = req.generalData?.vendorName || req.vendorName || 'N/A';
    const reqType = req.requestType || (req.crNumber ? 'Change Request' : 'New Request');
    const createdBy = req.createdByName || req.createdByName || 'User';
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    return {
      subject: `[VMM] New Request Submitted — ${reqId}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
          <div style="background:#1e40af;color:white;padding:20px;border-radius:8px 8px 0 0">
            <h2 style="margin:0">VMM — Request Submitted</h2>
          </div>
          <div style="background:#f8fafc;padding:24px;border:1px solid #e2e8f0">
            <p>A request is awaiting your review.</p>
            <table style="width:100%;border-collapse:collapse;margin:16px 0">
              <tr><td style="padding:8px;font-weight:bold;color:#475569">Request ID:</td>
                  <td style="padding:8px;color:#0f172a">${reqId}</td></tr>
              <tr style="background:#f1f5f9">
                  <td style="padding:8px;font-weight:bold;color:#475569">Vendor Name:</td>
                  <td style="padding:8px;color:#0f172a">${vendorName}</td></tr>
              <tr><td style="padding:8px;font-weight:bold;color:#475569">Type:</td>
                  <td style="padding:8px;color:#0f172a">${reqType}</td></tr>
              <tr style="background:#f1f5f9">
                  <td style="padding:8px;font-weight:bold;color:#475569">Submitted By:</td>
                  <td style="padding:8px;color:#0f172a">${createdBy}</td></tr>
            </table>
            <a href="${frontendUrl}/approvals" 
               style="background:#1e40af;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:8px">
              Review Request →
            </a>
          </div>
          <div style="padding:12px;text-align:center;color:#94a3b8;font-size:12px">
            VMM — Vendor Master Management System
          </div>
        </div>`,
    };
  },

  PENDING_APPROVAL: (req) => {
    const reqId = req.tempVendorNumber || req.crNumber || req._id;
    const vendorName = req.generalData?.vendorName || req.vendorName || 'N/A';
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    return {
      subject: `[VMM] Pending Approval — ${reqId}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
          <div style="background:#1e40af;color:white;padding:20px;border-radius:8px 8px 0 0">
            <h2 style="margin:0">VMM — Request Pending Your Approval</h2>
          </div>
          <div style="background:#f8fafc;padding:24px;border:1px solid #e2e8f0">
            <p>A request is waiting for your review and approval.</p>
            <table style="width:100%;border-collapse:collapse;margin:16px 0">
              <tr><td style="padding:8px;font-weight:bold;color:#475569">Request ID:</td>
                  <td style="padding:8px;color:#0f172a">${reqId}</td></tr>
              <tr style="background:#f1f5f9">
                  <td style="padding:8px;font-weight:bold;color:#475569">Vendor Name:</td>
                  <td style="padding:8px;color:#0f172a">${vendorName}</td></tr>
              <tr><td style="padding:8px;font-weight:bold;color:#475569">Current Stage:</td>
                  <td style="padding:8px;color:#0f172a">${req.currentLevel || req.status || 'Pending Review'}</td></tr>
            </table>
            <a href="${frontendUrl}/approvals" 
               style="background:#1e40af;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:8px">
              Review Request →
            </a>
          </div>
          <div style="padding:12px;text-align:center;color:#94a3b8;font-size:12px">
            VMM — Vendor Master Management System
          </div>
        </div>`,
    };
  },

  APPROVED: (req, level) => {
    const reqId = req.tempVendorNumber || req.crNumber || req._id;
    const vendorName = req.generalData?.vendorName || req.vendorName || 'N/A';
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    return {
      subject: `[VMM] Request ${reqId} — Approved at ${level}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#16a34a;color:white;padding:20px;border-radius:8px 8px 0 0">
          <h2 style="margin:0">✅ Request Approved — ${level}</h2>
        </div>
        <div style="background:#f8fafc;padding:24px;border:1px solid #e2e8f0">
          <p>Request <strong>${reqId}</strong> for <strong>${vendorName}</strong> has been approved at ${level} level.</p>
          <p>Current Status: <strong>${req.status}</strong></p>
          <a href="${frontendUrl}/vendors/${req._id}" 
             style="background:#16a34a;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block">
            View Request →
          </a>
        </div></div>`,
    };
  },

  REJECTED: (req, comments) => {
    const reqId = req.tempVendorNumber || req.crNumber || req._id;
    const vendorName = req.generalData?.vendorName || req.vendorName || 'N/A';
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    return {
      subject: `[VMM] Request ${reqId} — Rejected`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#dc2626;color:white;padding:20px;border-radius:8px 8px 0 0">
          <h2 style="margin:0">❌ Request Rejected</h2>
        </div>
        <div style="background:#f8fafc;padding:24px;border:1px solid #e2e8f0">
          <p>Request <strong>${reqId}</strong> for <strong>${vendorName}</strong> has been rejected.</p>
          ${comments ? `<div style="background:#fef2f2;border-left:4px solid #dc2626;padding:12px;margin:16px 0">
            <strong>Reason:</strong> ${comments}
          </div>` : ''}
          <a href="${frontendUrl}/vendors/${req._id}" 
             style="background:#dc2626;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block">
            View Request →
          </a>
        </div></div>`,
    };
  },

  SENT_BACK: (req, comments) => {
    const reqId = req.tempVendorNumber || req.crNumber || req._id;
    const vendorName = req.generalData?.vendorName || req.vendorName || 'N/A';
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    return {
      subject: `[VMM] Request ${reqId} — Sent Back for Revision`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#d97706;color:white;padding:20px;border-radius:8px 8px 0 0">
          <h2 style="margin:0">⚠ Request Sent Back for Revision</h2>
        </div>
        <div style="background:#f8fafc;padding:24px;border:1px solid #e2e8f0">
          <p>Request <strong>${reqId}</strong> for <strong>${vendorName}</strong> needs revision.</p>
          ${comments ? `<div style="background:#fffbeb;border-left:4px solid #d97706;padding:12px;margin:16px 0">
            <strong>Reviewer Comments:</strong> ${comments}
          </div>` : ''}
          <a href="${frontendUrl}/vendors/${req._id}/edit" 
             style="background:#d97706;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block">
            Edit &amp; Resubmit →
          </a>
        </div></div>`,
    };
  },

  SAP_PUSHED: (req) => {
    const reqId = req.tempVendorNumber || req.crNumber || req._id;
    const vendorName = req.generalData?.vendorName || req.vendorName || 'N/A';
    const sapNo = req.sapVendorNumber || req.sapResult?.vendorNumber || 'N/A';
    return {
      subject: `[VMM] ✅ SAP Vendor Created — ${sapNo}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#7c3aed;color:white;padding:20px;border-radius:8px 8px 0 0">
          <h2 style="margin:0">🎉 Vendor Successfully Created in SAP</h2>
        </div>
        <div style="background:#f8fafc;padding:24px;border:1px solid #e2e8f0">
          <p><strong>${vendorName}</strong> has been created in SAP.</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0">
            <tr style="background:#f3f4f6">
                <td style="padding:8px;font-weight:bold">Temp Request ID:</td>
                <td style="padding:8px">${reqId}</td></tr>
            <tr>
                <td style="padding:8px;font-weight:bold;color:#7c3aed">SAP Vendor Number:</td>
                <td style="padding:8px;font-size:1.2em;font-weight:bold;color:#7c3aed">${sapNo}</td></tr>
          </table>
          <p style="color:#64748b;font-size:0.9em">The SAP Vendor Number is now the permanent identifier for all procurement activities.</p>
        </div></div>`,
    };
  },

  SAP_FAILED: (req, error) => {
    const reqId = req.tempVendorNumber || req.crNumber || req._id;
    const vendorName = req.generalData?.vendorName || req.vendorName || 'N/A';
    return {
      subject: `[VMM] ❌ SAP Push Failed — ${reqId}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#991b1b;color:white;padding:20px;border-radius:8px 8px 0 0">
          <h2 style="margin:0">SAP Push Failed</h2>
        </div>
        <div style="background:#f8fafc;padding:24px;border:1px solid #e2e8f0">
          <p>SAP push for <strong>${vendorName}</strong> (${reqId}) failed.</p>
          <div style="background:#fef2f2;border-left:4px solid #dc2626;padding:12px">
            <strong>Error:</strong> ${error || 'Unknown error'}
          </div>
          <p style="margin-top:16px">The Master Data Team can retry the SAP push from the request detail page.</p>
        </div></div>`,
    };
  },

  USER_ONBOARDING: (data) => ({
    subject: `[VMM] Welcome to Vendor Master Management — Account Created`,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#1e40af;color:white;padding:20px;border-radius:8px 8px 0 0">
          <h2 style="margin:0">Welcome to VMM Portal!</h2>
        </div>
        <div style="background:#f8fafc;padding:24px;border:1px solid #e2e8f0">
          <p>Hello <strong>${data.fullName}</strong>,</p>
          <p>An account has been created for you on the Vendor Master Management portal.</p>
          
          <div style="background:#f1f5f9;padding:16px;border-radius:6px;margin:16px 0">
            <h3 style="margin-top:0">Your Login Credentials:</h3>
            <table style="width:100%; border-collapse: collapse;">
              <tr>
                <td style="padding:4px 0;font-weight:bold;color:#475569">Organisation ID:</td>
                <td style="padding:4px 8px;color:#0f172a">${data.tenantId}</td>
              </tr>
              <tr>
                <td style="padding:4px 0;font-weight:bold;color:#475569">Email:</td>
                <td style="padding:4px 8px;color:#0f172a">${data.email}</td>
              </tr>
              <tr>
                <td style="padding:4px 0;font-weight:bold;color:#475569">Password:</td>
                <td style="padding:4px 8px;color:#0f172a"><code>${data.password}</code></td>
              </tr>
            </table>
          </div>
          
          <p>Click the link below to access the login page:</p>
          <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/login" 
             style="background:#1e40af;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:8px">
            Login to Portal →
          </a>
          
          <p style="color:#ef4444;font-size:0.9em;margin-top:16px;border-top:1px solid #e2e8f0;padding-top:12px;">
            * For security reasons, please change your password after logging in for the first time.
          </p>
        </div>
        <div style="padding:12px;text-align:center;color:#94a3b8;font-size:12px">
          VMM — Vendor Master Management System
        </div>
      </div>`,
  }),

  UPDATE_REQUEST: (data) => ({
    subject: `[VMM] Action Required: Update your Business Partner Details`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#1e40af;color:white;padding:20px;border-radius:8px 8px 0 0">
          <h2 style="margin:0">Action Required: Details Update Requested</h2>
        </div>
        <div style="background:#f8fafc;padding:24px;border:1px solid #e2e8f0">
          <p>Hello <strong>${data.fullName}</strong>,</p>
          <p>An administrator has requested you to update your vendor details (Bank account, Address, or Tax details) in our system.</p>
          
          <div style="background:#f1f5f9;padding:16px;border-radius:6px;margin:16px 0">
            <strong>Message from Administrator:</strong><br/>
            ${data.comments || 'Please verify and update your latest details at your earliest convenience.'}
          </div>
          
          <p>Please log in to the VMM portal and submit your changes:</p>
          <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/change-requests/new" 
             style="background:#1e40af;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:8px">
            Submit Change Request →
          </a>
        </div>
        <div style="padding:12px;text-align:center;color:#94a3b8;font-size:12px">
          VMM — Vendor Master Management System
        </div>
      </div>`,
  }),

  VENDOR_INVITATION: (data) => ({
    subject: `[VMM] Invitation to Register on Vendor Portal`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#1e40af;color:white;padding:20px;border-radius:8px 8px 0 0">
          <h2 style="margin:0">Vendor Registration Invitation</h2>
        </div>
        <div style="background:#f8fafc;padding:24px;border:1px solid #e2e8f0">
          <p>Hello <strong>${data.vendorName}</strong>,</p>
          <p>You have been invited to register on the Vendor Master Management portal. Registering will allow you to securely update your business details (such as Bank account, Address, or Tax information).</p>
          
          <div style="background:#f1f5f9;padding:16px;border-radius:6px;margin:16px 0">
            <strong>SAP Vendor Number:</strong> ${data.sapVendorNumber}<br/>
            <strong>Email:</strong> ${data.email}
          </div>
          
          <p>Please click the link below to complete your registration and set up your password:</p>
          <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/vendor-register?token=${data.token}" 
             style="background:#1e40af;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:8px">
            Complete Registration →
          </a>
          
          <p style="color:#ef4444;font-size:0.9em;margin-top:16px;border-top:1px solid #e2e8f0;padding-top:12px;">
            * This link is valid for 7 days. Please do not share it with anyone.
          </p>
        </div>
        <div style="padding:12px;text-align:center;color:#94a3b8;font-size:12px">
          VMM — Vendor Master Management System
        </div>
      </div>`,
  }),
};

// ── sendEmail ──────────────────────────────────────────────────────────
// On failure, logs the error but does NOT throw — email issues must not crash workflows
const sendEmail = async ({ to, templateName, templateData, emailConfig = {}, replyTo, tenantId }) => {
  try {
    const template = templates[templateName];
    if (!template) throw new Error(`Unknown email template: ${templateName}`);

    let resolvedEmailConfig = { ...emailConfig };
    const resolvedTenantId = tenantId || templateData?.tenantId || templateData?.request?.tenantId;

    if (resolvedTenantId && Object.keys(emailConfig).length === 0) {
      try {
        const Tenant = require('../models/Tenant');
        const tenant = await Tenant.findOne({ tenantId: resolvedTenantId, isActive: true })
          .select('+emailConfig.emailPass');
        
        if (tenant && tenant.emailConfig && tenant.emailConfig.useDefault === false) {
          resolvedEmailConfig = {
            emailHost: tenant.emailConfig.emailHost,
            emailPort: tenant.emailConfig.emailPort,
            emailUser: tenant.emailConfig.emailUser,
            emailPass: tenant.emailConfig.emailPass,
            emailFrom: tenant.emailConfig.emailFrom,
            emailSecure: tenant.emailConfig.emailSecure,
          };
          console.log(`[Email] Using custom SMTP config for tenant: ${resolvedTenantId} (host: ${resolvedEmailConfig.emailHost}, port: ${resolvedEmailConfig.emailPort}, user: ${resolvedEmailConfig.emailUser}, passLength: ${resolvedEmailConfig.emailPass ? resolvedEmailConfig.emailPass.length : 0})`);
        }
      } catch (dbErr) {
        console.error(`[Email Config Lookup Error] Failed to fetch tenant email config for ${resolvedTenantId}:`, dbErr.message);
      }
    }

    const { subject, html } = template(templateData.request || templateData, templateData.extra);
    const from = resolvedEmailConfig.emailFrom || process.env.EMAIL_FROM || 'VMM System <noreply@vmm.app>';

    const transporter = createTransporter(resolvedEmailConfig);
    console.log(`[Email Debug] Connecting to ${resolvedEmailConfig.emailHost || process.env.EMAIL_HOST}:${resolvedEmailConfig.emailPort || process.env.EMAIL_PORT} (secure: ${transporter.options.secure})...`);
    const mailOptions = { from, to, subject, html };
    if (replyTo) {
      mailOptions.replyTo = replyTo;
    }
    
    await transporter.sendMail(mailOptions);
    console.log(`[Email] Sent "${templateName}" to ${to} (replyTo: ${replyTo || 'default'})`);
  } catch (err) {
    console.error(`[Email Error] Failed to send "${templateName}" to ${to}: ${err.message}`);
    // Do NOT re-throw — email failure is non-fatal
  }
};

module.exports = { sendEmail };

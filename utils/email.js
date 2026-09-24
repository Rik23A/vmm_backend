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

  // If host is Gmail, explicitly set secure and port
  if (host && host.includes('gmail.com')) {
    return nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user, pass },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
    });
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

  // ── Balance Confirmation (SA 505) Templates ────────────────────────
  BALANCE_CONFIRMATION_REQUEST: (data) => {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const verifyUrl = `${frontendUrl}/verify-balance?token=${data.token}`;
    const loginUrl = `${frontendUrl}/login`;
    const companyName = data.companyName || 'Accounts Payable Division';
    const formattedBalance = data.closingBalance ? Number(data.closingBalance).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00';

    const isDebit = data.balanceIndicator === 'Debit';
    const isNil = !data.closingBalance || Number(data.closingBalance) === 0;

    let balanceLabel = 'Credit (Payable to Vendor)';
    let balanceBadgeBg = '#ecfdf5';
    let balanceBadgeColor = '#047857';
    let balanceNarrative = `shows a Credit amount of Rs. ${formattedBalance} given as payable to you`;

    if (isNil) {
      balanceLabel = 'Nil / Fully Cleared';
      balanceBadgeBg = '#f1f5f9';
      balanceBadgeColor = '#475569';
      balanceNarrative = 'shows a Nil balance (Rs. 0.00) with no amount outstanding payable or receivable';
    } else if (isDebit) {
      balanceLabel = 'Debit (Advance / Recoverable from Vendor)';
      balanceBadgeBg = '#fffbeb';
      balanceBadgeColor = '#b45309';
      balanceNarrative = `shows a Debit amount of Rs. ${formattedBalance} given as receivable from you (representing advance payments made or deductions recoverable from you)`;
    }

    return {
      subject: `[Action Required] Statutory Balance Confirmation (SA 505) — ${companyName}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#1e293b">
          <div style="background:linear-gradient(135deg, #1e3a8a 0%, #0f766e 100%);color:white;padding:24px;border-radius:8px 8px 0 0">
            <h2 style="margin:0 0 6px 0;font-size:1.35rem">${companyName}</h2>
            <p style="margin:0;opacity:0.9;font-size:0.85rem">
              ${data.unitName ? `Unit: <strong>${data.unitName}</strong> • ` : ''}Statutory External Balance Confirmation Request under ICAI SA 505
            </p>
          </div>
          <div style="background:#ffffff;padding:24px;border:1px solid #e2e8f0;border-top:none">
            <p style="font-size:1rem;margin-top:0">Dear <strong>${data.vendorName}</strong> (Vendor Code: ${data.sapVendorNumber}),</p>
            <p style="line-height:1.5">
              In accordance with <strong>Standard on Auditing (SA) 505 (External Confirmations)</strong>, our statutory auditors require direct confirmation of the balance outstanding in our books of accounts as of the close of business on <strong>${data.cutOffDate}</strong>, which ${balanceNarrative}.
            </p>
            
            <div style="background:#f8fafc;border-left:4px solid #0f766e;padding:16px;border-radius:0 6px 6px 0;margin:18px 0">
              <table style="width:100%;border-collapse:collapse;font-size:0.9rem">
                <tr>
                  <td style="padding:5px 0;color:#64748b;font-weight:bold;width:38%">Audit Reference No:</td>
                  <td style="padding:5px 0;color:#0f172a;font-family:monospace"><strong>${data.referenceNumber}</strong></td>
                </tr>
                <tr>
                  <td style="padding:5px 0;color:#64748b;font-weight:bold">Audit Cut-Off Date:</td>
                  <td style="padding:5px 0;color:#0f172a"><strong>${data.cutOffDate}</strong></td>
                </tr>
                <tr>
                  <td style="padding:5px 0;color:#64748b;font-weight:bold">Our Books Ledger Balance:</td>
                  <td style="padding:5px 0;color:#0f766e;font-size:1.05rem">
                    <strong>₹ ${formattedBalance}</strong>
                    <span style="background:${balanceBadgeBg};color:${balanceBadgeColor};padding:3px 8px;border-radius:4px;font-size:0.75rem;font-weight:bold;margin-left:6px;display:inline-block">
                      ${balanceLabel}
                    </span>
                  </td>
                </tr>
                ${data.auditorFirmName || data.auditorGroupEmail ? `
                <tr>
                  <td style="padding:5px 0;color:#64748b;font-weight:bold">Statutory Auditors:</td>
                  <td style="padding:5px 0;color:#334155">${data.auditorFirmName || 'Auditor Group'}${data.auditorGroupEmail ? ` &lt;${data.auditorGroupEmail}&gt;` : ''}</td>
                </tr>` : ''}
                <tr>
                  <td style="padding:5px 0;color:#64748b;font-weight:bold">Response Deadline:</td>
                  <td style="padding:5px 0;color:#dc2626;font-weight:bold">${data.deadlineDays || 10} Days (Presumption clause applies thereafter)</td>
                </tr>
              </table>
            </div>

            <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:12px 16px;margin:18px 0;font-size:0.85rem;color:#1e40af">
              📄 <strong>Official Letter Attached:</strong> An official <strong>Creditors Balance Confirmation Letter (.PDF)</strong> is attached to this email. You may download, print, physically sign/stamp, and upload it back, or confirm directly online.
            </div>

            <p style="margin:20px 0 12px 0">Please click the button below to review your ledger items and submit your sign-off or report differences:</p>
            
            <div style="text-align:center;margin:24px 0">
              <a href="${verifyUrl}" 
                 style="background:linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);color:#ffffff;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;box-shadow:0 4px 10px rgba(37,99,235,0.25)">
                Review & Confirm Balance Online →
              </a>
            </div>

            <p style="font-size:0.85rem;color:#64748b;border-top:1px solid #f1f5f9;padding-top:14px;margin-top:20px">
              <strong>Existing Portal Users:</strong> You can also log in directly to your <a href="${loginUrl}" style="color:#2563eb;text-decoration:none">Vendor Portal account</a> to access this confirmation under your profile.
            </p>
          </div>
          <div style="padding:14px;text-align:center;color:#94a3b8;font-size:11px">
            Statutory Audit External Confirmation • ICAI SA 505 Compliance Engine • ${companyName}
          </div>
        </div>`,
    };
  },

  BALANCE_CONFIRMATION_REVERT_INITIATOR: (data) => {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const isDisputed = data.status === 'DISPUTED';
    const companyName = data.companyName || '';

    const balIndicatorDisplay = data.balanceIndicator === 'Debit'
      ? 'Debit / Advance Recoverable'
      : (data.balanceIndicator === 'Credit' ? 'Credit / Payable' : 'Nil');

    return {
      subject: `[Response Received] Balance Confirmation ${isDisputed ? 'DISPUTED' : 'CONFIRMED'} — ${data.vendorName} (${data.referenceNumber})${companyName ? ` • ${companyName}` : ''}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1e293b">
          <div style="background:${isDisputed ? '#dc2626' : '#16a34a'};color:white;padding:20px;border-radius:8px 8px 0 0">
            <h2 style="margin:0;font-size:1.25rem">Vendor Balance Confirmation ${isDisputed ? 'Disputed (Variance Reported)' : 'Agreed & Confirmed'}</h2>
            <p style="margin:4px 0 0 0;font-size:0.85rem">Reference No: <strong>${data.referenceNumber}</strong> • Status: <strong>${data.status}</strong></p>
          </div>
          <div style="background:#ffffff;padding:24px;border:1px solid #e2e8f0;border-top:none">
            <p>Hello <strong>${data.initiatorName || 'AP Team'}</strong>,</p>
            <p>Vendor <strong>${data.vendorName}</strong> (${data.sapVendorNumber}) has completed their balance confirmation review as of <strong>${data.cutOffDate || 'Audit Cut-Off'}</strong>.</p>
            
            <div style="background:#f8fafc;padding:16px;border-radius:6px;border:1px solid #e2e8f0;margin:16px 0">
              <table style="width:100%;font-size:0.9rem">
                <tr>
                  <td style="color:#64748b;padding:5px 0;width:42%">SAP Ledger Balance:</td>
                  <td style="padding:5px 0"><strong>₹ ${data.sapBalance}</strong> <span style="font-size:0.8rem;color:#475569">(${balIndicatorDisplay})</span></td>
                </tr>
                <tr>
                  <td style="color:#64748b;padding:5px 0">Vendor Reported Balance:</td>
                  <td style="padding:5px 0"><strong>₹ ${data.vendorBalance || data.sapBalance}</strong></td>
                </tr>
                <tr>
                  <td style="color:#64748b;padding:5px 0">Variance / Difference:</td>
                  <td style="padding:5px 0;color:${isDisputed ? '#dc2626' : '#16a34a'}"><strong>₹ ${data.differenceAmount || '0.00'}</strong></td>
                </tr>
                <tr>
                  <td style="color:#64748b;padding:5px 0">Vendor Signatory:</td>
                  <td style="padding:5px 0">${data.signatoryName || 'N/A'} (${data.signatoryDesignation || 'Finance'})</td>
                </tr>
                <tr>
                  <td style="color:#64748b;padding:5px 0">Signed Document Uploaded:</td>
                  <td style="padding:5px 0;font-weight:bold;color:${data.hasSignedDoc ? '#16a34a' : '#64748b'}">
                    ${data.hasSignedDoc ? '✓ Yes (Archived for Audit)' : 'No (Digital Sign-Off Only)'}
                  </td>
                </tr>
                ${data.hasStatement ? `
                <tr>
                  <td style="color:#64748b;padding:5px 0">Vendor Statement File:</td>
                  <td style="padding:5px 0;font-weight:bold;color:#0284c7">✓ Attached (${data.statementFileName || 'Ledger File'})</td>
                </tr>` : ''}
                ${data.disputeReason ? `
                <tr>
                  <td style="color:#64748b;padding:5px 0;vertical-align:top">Dispute Remarks:</td>
                  <td style="color:#b91c1c;padding:5px 0">${data.disputeReason}</td>
                </tr>` : ''}
              </table>
            </div>

            <p>This request has reverted back to your queue for review, reconciliation, and audit archival:</p>
            <div style="text-align:center;margin:22px 0">
              <a href="${frontendUrl}/balance-confirmations" 
                 style="background:#1e3a8a;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block">
                Open Confirmation in Portal →
              </a>
            </div>
          </div>
          <div style="padding:12px;text-align:center;color:#94a3b8;font-size:12px">
            VMM — Statutory Audit Reconciliation Pipeline • ${companyName || 'Accounts Payable'}
          </div>
        </div>`,
    };
  },

  BALANCE_CONFIRMATION_COMPLETED: (data) => {
    const companyName = data.companyName || 'Corporate Accounts Payable';
    return {
      subject: `[Audit Certificate Issued] SA 505 Balance Confirmation — ${data.vendorName} (${data.referenceNumber})${companyName ? ` • ${companyName}` : ''}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1e293b">
          <div style="background:#0f766e;color:white;padding:20px;border-radius:8px 8px 0 0">
            <h2 style="margin:0;font-size:1.25rem">Statutory Confirmation Certificate Issued</h2>
            <p style="margin:4px 0 0 0;font-size:0.85rem">Reference No: ${data.referenceNumber} • ${companyName}</p>
          </div>
          <div style="background:#ffffff;padding:24px;border:1px solid #e2e8f0;border-top:none">
            <p>Dear Partner & Audit Representative,</p>
            <p>The external balance confirmation for <strong>${data.vendorName}</strong> (Code: ${data.sapVendorNumber}) as of <strong>${data.cutOffDate}</strong> has been officially confirmed, verified, and sealed.</p>
            
            <div style="background:#f0fdf4;border:1px solid #bbf7d0;padding:16px;border-radius:6px;margin:16px 0;color:#166534">
              <strong>Outcome:</strong> ${data.status} (Variance: ₹ ${data.differenceAmount || '0.00'})<br/>
              <strong>Signed By:</strong> ${data.signatoryName || 'Authorized Signatory'} on ${data.signedDate || 'Today'}<br/>
              <strong>Integrity Seal:</strong> Cryptographically logged under SA 505 guidelines
            </div>

            <p>Attached to this email is the official, digitally sealed <strong>SA 505 Balance Confirmation Certificate</strong> for your statutory accounting records.</p>
          </div>
          <div style="padding:12px;text-align:center;color:#94a3b8;font-size:12px">
            VMM External Confirmations • ICAI SA 505 Compliance Record • ${companyName}
          </div>
        </div>`,
    };
  },
};

// ── sendEmail ──────────────────────────────────────────────────────────
// On failure, logs the error but does NOT throw — email issues must not crash workflows
const sendEmail = async ({ to, cc, templateName, templateData, emailConfig = {}, replyTo, attachments, tenantId }) => {
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
          console.log(`[Email] Using custom SMTP config for tenant: ${resolvedTenantId}`);
        }
      } catch (dbErr) {
        console.error(`[Email Config Lookup Error] Failed to fetch tenant email config for ${resolvedTenantId}:`, dbErr.message);
      }
    }

    const { subject, html } = template(templateData.request || templateData, templateData.extra);
    const from = resolvedEmailConfig.emailFrom || process.env.EMAIL_FROM || 'VMM System <noreply@vmm.app>';

    const transporter = createTransporter(resolvedEmailConfig);
    const mailOptions = { from, to, subject, html };
    if (cc) {
      mailOptions.cc = cc;
    }
    if (replyTo) {
      mailOptions.replyTo = replyTo;
    }
    if (attachments && Array.isArray(attachments) && attachments.length > 0) {
      mailOptions.attachments = attachments;
    }
    
    await transporter.sendMail(mailOptions);
    console.log(`[Email] Sent "${templateName}" to ${to}${cc ? ` (cc: ${cc})` : ''}`);
  } catch (err) {
    console.error(`[Email Error] Failed to send "${templateName}" to ${to}: ${err.message}`);
    // Do NOT re-throw — email failure is non-fatal
  }
};

module.exports = { sendEmail };

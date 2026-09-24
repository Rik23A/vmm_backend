'use strict';

const router = require('express').Router();
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const ConfirmationCampaign = require('../models/ConfirmationCampaign');
const VendorConfirmation = require('../models/VendorConfirmation');
const Tenant = require('../models/Tenant');
const Notification = require('../models/Notification');
const User = require('../models/User');
const VendorRequest = require('../models/VendorRequest');

const { requireLogin, requireRole } = require('../middleware/auth');
const { injectTenant, getSapConfig } = require('../middleware/tenant');
const { requireModule } = require('../middleware/moduleGuard');
const { secureUpload, getSafeAbsolutePath, getTenantUploadDir } = require('../config/storage');
const { fetchAndDeriveVendorBalance, generateCreditorBalanceConfirmationLetterPDF, formatDate, formatINR } = require('../utils/sapBalanceBridge');
const { fetchVendorsFromSAP } = require('../utils/sapBridge');
const { sendEmail } = require('../utils/email');

// ── Public Routes (Token-Authenticated Magic Link) ───────────────────────────
// These do not require user login, but require a valid, non-expired token

/**
 * GET /api/balance-confirmations/public/:token
 * Retrieves vendor master details, cut-off balance, and open invoice line items.
 */
router.get('/public/:token', async (req, res, next) => {
  try {
    const { token } = req.params;
    if (!token) return res.status(400).json({ message: 'Token is required' });

    const confirmation = await VendorConfirmation.findOne({ token });
    if (!confirmation) {
      return res.status(404).json({ message: 'Invalid balance confirmation link or record not found.' });
    }

    const isExpired = confirmation.tokenExpiresAt && new Date() > confirmation.tokenExpiresAt;

    // Check if tenant has module enabled
    const tenant = await Tenant.findOne({ tenantId: confirmation.tenantId, isActive: true });
    if (!tenant) {
      return res.status(403).json({ message: 'Organization account is inactive.' });
    }

    res.json({
      success: true,
      isExpired,
      status: confirmation.status,
      vendor: {
        sapVendorNumber: confirmation.sapVendorNumber,
        vendorName: confirmation.vendorName,
        vendorEmail: confirmation.vendorEmail,
        vendorAddress: confirmation.vendorAddress,
        companyCode: confirmation.companyCode,
        companyName: confirmation.companyName,
        unitName: confirmation.unitName,
      },
      confirmation: {
        id: confirmation._id,
        referenceNumber: confirmation.referenceNumber,
        keyCutOffDate: confirmation.keyCutOffDate,
        fiscalYear: confirmation.fiscalYear || '',
        tokenExpiresAt: confirmation.tokenExpiresAt,
        sapClosingBalance: confirmation.sapClosingBalance,
        openingBalance: confirmation.openingBalance || 0,
        totalCredit: confirmation.totalCredit || 0,
        totalDebit: confirmation.totalDebit || 0,
        balanceSource: confirmation.balanceSource || 'FAP_VENDOR_LINE_ITEMS_SRV',
        balanceIndicator: confirmation.balanceIndicator,
        currency: confirmation.currency,
        status: confirmation.status,
        vendorReportedBalance: confirmation.vendorReportedBalance,
        differenceAmount: confirmation.differenceAmount,
        disputeReason: confirmation.disputeReason,
        signatoryName: confirmation.signatoryName,
        signatoryDesignation: confirmation.signatoryDesignation,
        actionTimestamp: confirmation.actionTimestamp,
        sealedPdfUrl: confirmation.sealedPdfUrl,
        initialLetterPdfUrl: confirmation.initialLetterPdfUrl,
        vendorSignedDocumentUrl: confirmation.vendorSignedDocumentUrl,
        vendorSignedDocumentFileName: confirmation.vendorSignedDocumentFileName,
        vendorStatementFileName: confirmation.vendorStatementFileName,
        companyName: confirmation.companyName,
        companyAddress: confirmation.companyAddress,
        unitName: confirmation.unitName,
        unitAddress: confirmation.unitAddress,
        auditorFirmName: confirmation.auditorFirmName,
        auditorAddress: confirmation.auditorAddress,
        lineItems: confirmation.lineItems || [],
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/balance-confirmations/public/:token/letter-pdf
 * Downloads or views the official Creditors Balance Confirmation Notice PDF
 */
router.get('/public/:token/letter-pdf', async (req, res, next) => {
  try {
    const confirmation = await VendorConfirmation.findOne({ token: req.params.token });
    if (!confirmation) {
      return res.status(404).json({ message: 'Invalid confirmation token or record not found.' });
    }

    const tenant = await Tenant.findOne({ tenantId: confirmation.tenantId });

    // Generate if not already generated, missing on disk, or refresh requested
    const shouldRefresh = req.query.refresh === 'true' || req.query.force === 'true';
    let fullPath = (!shouldRefresh && confirmation.initialLetterPdfUrl) ? getSafeAbsolutePath(confirmation.initialLetterPdfUrl, confirmation.tenantId) : null;
    if (!fullPath || !fs.existsSync(fullPath)) {
      const relPath = await generateCreditorBalanceConfirmationLetterPDF(confirmation, tenant);
      confirmation.initialLetterPdfUrl = relPath;
      await confirmation.save();
      fullPath = getSafeAbsolutePath(relPath, confirmation.tenantId);
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Creditors_Balance_Confirmation_${confirmation.referenceNumber}.pdf"`);
    fs.createReadStream(fullPath).pipe(res);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/balance-confirmations/public/:token/audit-certificate
 * Public magic-token authenticated download of the sealed SA 505 Audit Certificate PDF
 */
router.get('/public/:token/audit-certificate', async (req, res, next) => {
  try {
    const confirmation = await VendorConfirmation.findOne({ token: req.params.token });
    if (!confirmation) return res.status(404).json({ message: 'Invalid confirmation link or record not found.' });

    const tenant = await Tenant.findOne({ tenantId: confirmation.tenantId });

    const shouldRefresh = req.query.refresh === 'true' || req.query.force === 'true';
    let fullPath = (!shouldRefresh && confirmation.sealedPdfUrl) ? getSafeAbsolutePath(confirmation.sealedPdfUrl, confirmation.tenantId) : null;
    if (!fullPath || !fs.existsSync(fullPath)) {
      const pdfPath = await generateCreditorBalanceConfirmationLetterPDF(confirmation, tenant, { sealed: true });
      confirmation.sealedPdfUrl = pdfPath;
      await confirmation.save();
      fullPath = getSafeAbsolutePath(pdfPath, confirmation.tenantId);
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="SA505_Confirmation_${confirmation.referenceNumber}.pdf"`);
    fs.createReadStream(fullPath).pipe(res);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/balance-confirmations/public/:token/signed-doc
 * Public magic-token authenticated download of the uploaded signed copy
 */
router.get('/public/:token/signed-doc', async (req, res, next) => {
  try {
    const confirmation = await VendorConfirmation.findOne({ token: req.params.token });
    if (!confirmation || !confirmation.vendorSignedDocumentUrl) {
      return res.status(404).json({ message: 'Signed document not found.' });
    }

    const fullPath = getSafeAbsolutePath(confirmation.vendorSignedDocumentUrl, confirmation.tenantId);
    if (!fullPath || !fs.existsSync(fullPath)) {
      return res.status(404).json({ message: 'File not found on storage.' });
    }

    const filename = confirmation.vendorSignedDocumentFileName || `Vendor_Signed_Notice_${confirmation.referenceNumber}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    fs.createReadStream(fullPath).pipe(res);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/balance-confirmations/public/:token/statement
 * Public magic-token authenticated download of the uploaded vendor statement ledger
 */
router.get('/public/:token/statement', async (req, res, next) => {
  try {
    const confirmation = await VendorConfirmation.findOne({ token: req.params.token });
    if (!confirmation || !confirmation.vendorStatementFileUrl) {
      return res.status(404).json({ message: 'Statement document not found.' });
    }

    const fullPath = getSafeAbsolutePath(confirmation.vendorStatementFileUrl, confirmation.tenantId);
    if (!fullPath || !fs.existsSync(fullPath)) {
      return res.status(404).json({ message: 'File not found on storage.' });
    }

    const filename = confirmation.vendorStatementFileName || `Vendor_Statement_${confirmation.referenceNumber}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    fs.createReadStream(fullPath).pipe(res);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/balance-confirmations/public/:token/submit
 * Vendor completes their response (Agree or Dispute, optionally uploading signed confirmation or statement).
 * Reverts back to initiator with in-app notification and email alerts.
 */
router.post('/public/:token/submit', (req, res, next) => {
  // Pre-resolve tenantId for multer disk storage
  VendorConfirmation.findOne({ token: req.params.token })
    .then(rec => {
      if (rec) req.tenantId = rec.tenantId;
      next();
    })
    .catch(next);
}, secureUpload.fields([{ name: 'signedDoc', maxCount: 1 }, { name: 'statement', maxCount: 1 }]), async (req, res, next) => {
  try {
    const { token } = req.params;
    const { isAgreed, reportedBalance, disputeReason, signatoryName, signatoryDesignation } = req.body;

    const confirmation = await VendorConfirmation.findOne({ token });
    if (!confirmation) {
      return res.status(404).json({ message: 'Invalid confirmation token.' });
    }

    if (confirmation.status !== 'PENDING_VENDOR') {
      return res.status(400).json({
        message: `This balance confirmation has already been submitted (Current status: ${confirmation.status}).`,
      });
    }

    if (confirmation.tokenExpiresAt && new Date() > confirmation.tokenExpiresAt) {
      return res.status(403).json({ message: 'This balance confirmation link has expired.' });
    }

    const agreed = isAgreed === 'true' || isAgreed === true;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';

    let diff = 0;
    let numericReported = confirmation.sapClosingBalance;

    if (!agreed) {
      numericReported = parseFloat(reportedBalance);
      if (isNaN(numericReported)) {
        return res.status(400).json({ message: 'Please enter a valid vendor ledger balance.' });
      }
      diff = Math.round(Math.abs(confirmation.sapClosingBalance - numericReported) * 100) / 100;
    }

    let statementRelativePath = confirmation.vendorStatementFileUrl;
    let statementOrigName = confirmation.vendorStatementFileName;
    let signedDocRelativePath = confirmation.vendorSignedDocumentUrl;
    let signedDocOrigName = confirmation.vendorSignedDocumentFileName;

    if (req.files) {
      if (req.files.statement && req.files.statement[0]) {
        statementRelativePath = path.join('uploads', String(confirmation.tenantId || 'default'), req.files.statement[0].filename).replace(/\\/g, '/');
        statementOrigName = req.files.statement[0].originalname;
      }
      if (req.files.signedDoc && req.files.signedDoc[0]) {
        signedDocRelativePath = path.join('uploads', String(confirmation.tenantId || 'default'), req.files.signedDoc[0].filename).replace(/\\/g, '/');
        signedDocOrigName = req.files.signedDoc[0].originalname;
      }
    } else if (req.file) {
      statementRelativePath = path.join('uploads', String(confirmation.tenantId || 'default'), req.file.filename).replace(/\\/g, '/');
      statementOrigName = req.file.originalname;
    }

    // Status transitions to PENDING_REVIEW (reverted to initiator) with agreement/dispute flag
    confirmation.status = 'PENDING_REVIEW';
    confirmation.vendorReportedBalance = numericReported;
    confirmation.differenceAmount = diff;
    confirmation.disputeReason = agreed ? '' : (disputeReason || 'Balance mismatch as per vendor books');
    confirmation.vendorStatementFileUrl = statementRelativePath;
    confirmation.vendorStatementFileName = statementOrigName;
    confirmation.vendorSignedDocumentUrl = signedDocRelativePath;
    confirmation.vendorSignedDocumentFileName = signedDocOrigName;
    confirmation.signatoryName = signatoryName || 'Authorized Signatory';
    confirmation.signatoryDesignation = signatoryDesignation || 'Accounts / Finance';
    confirmation.signatoryIp = String(clientIp);
    confirmation.actionTimestamp = new Date();

    const tenant = await Tenant.findOne({ tenantId: confirmation.tenantId });

    // Generate Creditors Balance Confirmation Certificate
    try {
      const pdfPath = await generateCreditorBalanceConfirmationLetterPDF(confirmation, tenant, { sealed: true });
      confirmation.sealedPdfUrl = pdfPath;
    } catch (pdfErr) {
      console.error('[Confirmation Certificate Generation Error]:', pdfErr.message);
    }

    await confirmation.save();

    // Update Campaign metrics
    if (confirmation.campaignId) {
      const campaign = await ConfirmationCampaign.findById(confirmation.campaignId);
      if (campaign) {
        if (agreed) {
          campaign.confirmedCount = (campaign.confirmedCount || 0) + 1;
        } else {
          campaign.disputedCount = (campaign.disputedCount || 0) + 1;
        }
        if (campaign.pendingCount > 0) {
          campaign.pendingCount -= 1;
        }
        await campaign.save();
      }
    }

    // ── 1. Create In-App Notification for Initiator (Revert to Initiator) ──
    if (confirmation.initiatedBy) {
      try {
        await Notification.create({
          userId: confirmation.initiatedBy,
          tenantId: confirmation.tenantId,
          title: `Balance Confirmation Received: ${confirmation.vendorName}`,
          message: `Vendor ${confirmation.vendorName} (${confirmation.sapVendorNumber}) has submitted response for ${confirmation.referenceNumber}. Outcome: ${agreed ? 'Agreed (No Variance)' : `Disputed (Variance: ₹${formatINR(diff)})`}. Reverted to your review queue.`,
        });
      } catch (notifErr) {
        console.error('[Notification Error]:', notifErr.message);
      }
    }

    // ── 2. Trigger Email Alert to Initiator ─────────────────────────────────
    const initiator = confirmation.initiatedBy ? await User.findById(confirmation.initiatedBy) : null;
    const initiatorEmail = confirmation.initiatorEmail || initiator?.email;

    // Build complete audit attachment bundle (Automated Sealed PDF + Uploaded Signed Doc + Uploaded Statement)
    const auditAttachments = [];
    if (confirmation.sealedPdfUrl) {
      const fullPdfPath = getSafeAbsolutePath(confirmation.sealedPdfUrl, confirmation.tenantId);
      if (fullPdfPath && fs.existsSync(fullPdfPath)) {
        auditAttachments.push({
          filename: `Creditors_Confirmation_Certificate_${confirmation.referenceNumber}.pdf`,
          path: fullPdfPath,
        });
      }
    }
    if (confirmation.vendorSignedDocumentUrl) {
      const signAbs = getSafeAbsolutePath(confirmation.vendorSignedDocumentUrl, confirmation.tenantId);
      if (signAbs && fs.existsSync(signAbs)) {
        auditAttachments.push({
          filename: confirmation.vendorSignedDocumentFileName || `Vendor_Signed_Confirmation_${confirmation.referenceNumber}.pdf`,
          path: signAbs,
        });
      }
    }
    if (confirmation.vendorStatementFileUrl) {
      const stmtAbs = getSafeAbsolutePath(confirmation.vendorStatementFileUrl, confirmation.tenantId);
      if (stmtAbs && fs.existsSync(stmtAbs)) {
        auditAttachments.push({
          filename: confirmation.vendorStatementFileName || `Vendor_Statement_${confirmation.referenceNumber}.pdf`,
          path: stmtAbs,
        });
      }
    }

    if (initiatorEmail) {
      sendEmail({
        to: initiatorEmail,
        templateName: 'BALANCE_CONFIRMATION_REVERT_INITIATOR',
        templateData: {
          initiatorName: initiator?.fullName || 'AP Admin',
          vendorName: confirmation.vendorName,
          sapVendorNumber: confirmation.sapVendorNumber,
          referenceNumber: confirmation.referenceNumber,
          status: agreed ? 'CONFIRMED' : 'DISPUTED',
          sapBalance: formatINR(confirmation.sapClosingBalance),
          balanceIndicator: confirmation.balanceIndicator,
          vendorBalance: formatINR(numericReported),
          differenceAmount: formatINR(diff),
          signatoryName: confirmation.signatoryName,
          signatoryDesignation: confirmation.signatoryDesignation,
          disputeReason: confirmation.disputeReason,
          hasSignedDoc: !!confirmation.vendorSignedDocumentUrl,
          hasStatement: !!confirmation.vendorStatementFileUrl,
          statementFileName: confirmation.vendorStatementFileName,
          companyName: confirmation.companyName || tenant?.companyName,
          unitName: confirmation.unitName,
          cutOffDate: formatDate(confirmation.keyCutOffDate),
          tenantId: confirmation.tenantId,
        },
        attachments: auditAttachments.length > 0 ? auditAttachments : undefined,
      });
    }

    // ── 3. Dual Dispatch Completion Email (Vendor + AP + Auditor) ──────────
    const campaignObj = confirmation.campaignId ? await ConfirmationCampaign.findById(confirmation.campaignId) : null;
    const auditorEmail = (confirmation.auditorEmails && confirmation.auditorEmails.length > 0)
      ? confirmation.auditorEmails.join(', ')
      : (campaignObj?.auditorGroupEmail || tenant?.balanceConfirmationConfig?.defaultAuditorGroupEmail);
    const clientApEmail = campaignObj?.clientApEmail || tenant?.balanceConfirmationConfig?.defaultClientApEmail || initiatorEmail;

    sendEmail({
      to: confirmation.vendorEmail,
      cc: [clientApEmail, auditorEmail].filter(Boolean).join(', '),
      templateName: 'BALANCE_CONFIRMATION_COMPLETED',
      templateData: {
        vendorName: confirmation.vendorName,
        sapVendorNumber: confirmation.sapVendorNumber,
        referenceNumber: confirmation.referenceNumber,
        cutOffDate: formatDate(confirmation.keyCutOffDate),
        status: agreed ? 'Agreed & Confirmed' : 'Disputed with Variance',
        differenceAmount: formatINR(diff),
        signatoryName: confirmation.signatoryName,
        signedDate: formatDate(confirmation.actionTimestamp),
        tenantId: confirmation.tenantId,
      },
      attachments: auditAttachments.length > 0 ? auditAttachments : undefined,
    });

    res.json({
      success: true,
      status: confirmation.status,
      sealedPdfUrl: confirmation.sealedPdfUrl,
      vendorSignedDocumentUrl: confirmation.vendorSignedDocumentUrl,
      message: 'Thank you! Your balance confirmation has been recorded and submitted to Accounts Payable.',
    });
  } catch (err) {
    next(err);
  }
});

// ── Requester (Vendor) Logged-in Portal Endpoints ────────────────────────────
// Accessible by logged-in users with role REQUESTOR

/**
 * GET /api/balance-confirmations/my-balance
 * Logged-in vendor portal endpoint:
 * - If AP Admin dispatched a request: returns active pending request + SAP open line items.
 * - If idle: returns previous completed confirmation history.
 */
router.get('/my-balance', requireLogin, injectTenant, requireModule('balanceConfirmation'), async (req, res, next) => {
  try {
    const sapVendorNumber = req.user.sapVendorNumber;
    const userEmail = req.user.email ? req.user.email.toLowerCase().trim() : '';

    const conditions = [];
    if (sapVendorNumber) conditions.push({ sapVendorNumber });
    if (userEmail) conditions.push({ vendorEmail: userEmail });

    if (conditions.length === 0) {
      return res.json({
        activeRequest: null,
        previousRequests: [],
        message: 'No SAP vendor mapping or email found for this account.',
      });
    }

    // Active request (awaiting vendor action or awaiting initiator review)
    const activeRequest = await VendorConfirmation.findOne({
      tenantId: req.tenantId,
      $or: conditions,
      status: { $in: ['PENDING_VENDOR', 'PENDING_REVIEW'] },
    }).sort({ createdAt: -1 });

    // Previous completed confirmation history
    const previousRequests = await VendorConfirmation.find({
      tenantId: req.tenantId,
      $or: conditions,
      status: { $in: ['CONFIRMED', 'DISPUTED', 'RECONCILED', 'PRESUMED_CONFIRMED'] },
    }).sort({ createdAt: -1 }).limit(10);

    res.json({
      activeRequest,
      previousRequests,
      hasActiveRequest: Boolean(activeRequest && activeRequest.status === 'PENDING_VENDOR'),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/balance-confirmations/my-balance/submit
 * Logged-in vendor submits confirmation directly from their portal profile.
 */
router.post('/my-balance/submit', requireLogin, injectTenant, requireModule('balanceConfirmation'), secureUpload.fields([{ name: 'statement', maxCount: 1 }, { name: 'signedDoc', maxCount: 1 }]), async (req, res, next) => {
  try {
    const sapVendorNumber = req.user.sapVendorNumber;
    const userEmail = req.user.email ? req.user.email.toLowerCase().trim() : '';

    const conditions = [];
    if (sapVendorNumber) conditions.push({ sapVendorNumber });
    if (userEmail) conditions.push({ vendorEmail: userEmail });

    if (conditions.length === 0) {
      return res.status(403).json({ message: 'Only mapped vendor requestors can submit balance confirmations.' });
    }

    const confirmation = await VendorConfirmation.findOne({
      tenantId: req.tenantId,
      $or: conditions,
      status: 'PENDING_VENDOR',
    }).sort({ createdAt: -1 });

    if (!confirmation) {
      return res.status(404).json({ message: 'No active pending balance confirmation request found.' });
    }

    const { isAgreed, reportedBalance, disputeReason, signatoryName, signatoryDesignation } = req.body;
    const agreed = isAgreed === 'true' || isAgreed === true;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';

    let diff = 0;
    let numericReported = confirmation.sapClosingBalance;

    if (!agreed) {
      numericReported = parseFloat(reportedBalance);
      if (isNaN(numericReported)) {
        return res.status(400).json({ message: 'Please enter a valid vendor ledger balance.' });
      }
      diff = Math.round(Math.abs(confirmation.sapClosingBalance - numericReported) * 100) / 100;
    }

    if (req.files?.statement?.[0]) {
      confirmation.vendorStatementFileUrl = path.join('uploads', String(confirmation.tenantId || 'default'), req.files.statement[0].filename).replace(/\\/g, '/');
      confirmation.vendorStatementFileName = req.files.statement[0].originalname;
    }
    if (req.files?.signedDoc?.[0]) {
      confirmation.vendorSignedDocumentUrl = path.join('uploads', String(confirmation.tenantId || 'default'), req.files.signedDoc[0].filename).replace(/\\/g, '/');
      confirmation.vendorSignedDocumentFileName = req.files.signedDoc[0].originalname;
    }

    confirmation.status = 'PENDING_REVIEW';
    confirmation.vendorReportedBalance = numericReported;
    confirmation.differenceAmount = diff;
    confirmation.disputeReason = agreed ? '' : (disputeReason || 'Discrepancy reported via Vendor Portal');
    confirmation.signatoryName = signatoryName || req.user.fullName;
    confirmation.signatoryDesignation = signatoryDesignation || 'Authorized Signatory';
    confirmation.signatoryIp = String(clientIp);
    confirmation.actionTimestamp = new Date();

    try {
      const pdfPath = await generateCreditorBalanceConfirmationLetterPDF(confirmation, req.tenant, { sealed: true });
      confirmation.sealedPdfUrl = pdfPath;
    } catch (pdfErr) {
      console.error('[PDF Gen Error]:', pdfErr.message);
    }

    await confirmation.save();

    // Update Campaign metrics
    if (confirmation.campaignId) {
      const campaign = await ConfirmationCampaign.findById(confirmation.campaignId);
      if (campaign) {
        if (agreed) {
          campaign.confirmedCount = (campaign.confirmedCount || 0) + 1;
        } else {
          campaign.disputedCount = (campaign.disputedCount || 0) + 1;
        }
        if (campaign.pendingCount > 0) {
          campaign.pendingCount -= 1;
        }
        await campaign.save();
      }
    }

    // ── 1. Create In-App Notification for Initiator (Revert to Initiator) ──
    if (confirmation.initiatedBy) {
      try {
        await Notification.create({
          userId: confirmation.initiatedBy,
          tenantId: req.tenantId,
          title: `Balance Confirmation Received: ${confirmation.vendorName}`,
          message: `Vendor ${confirmation.vendorName} (${confirmation.sapVendorNumber}) has submitted response for ${confirmation.referenceNumber}. Outcome: ${agreed ? 'Agreed (No Variance)' : `Disputed (Variance: ₹${formatINR(diff)})`}. Reverted to your review queue.`,
        });
      } catch (notifErr) {
        console.error('[Notification Error]:', notifErr.message);
      }
    }

    // ── 2. Trigger Email Alert to Initiator ─────────────────────────────────
    const initiator = confirmation.initiatedBy ? await User.findById(confirmation.initiatedBy) : null;
    const initiatorEmail = confirmation.initiatorEmail || initiator?.email;

    // Build complete audit attachment bundle (Automated Sealed PDF + Uploaded Signed Doc + Uploaded Statement)
    const auditAttachments = [];
    if (confirmation.sealedPdfUrl) {
      const fullPdfPath = getSafeAbsolutePath(confirmation.sealedPdfUrl, req.tenantId);
      if (fullPdfPath && fs.existsSync(fullPdfPath)) {
        auditAttachments.push({
          filename: `Creditors_Confirmation_Certificate_${confirmation.referenceNumber}.pdf`,
          path: fullPdfPath,
        });
      }
    }
    if (confirmation.vendorSignedDocumentUrl) {
      const absSignedDoc = getSafeAbsolutePath(confirmation.vendorSignedDocumentUrl, req.tenantId);
      if (absSignedDoc && fs.existsSync(absSignedDoc)) {
        auditAttachments.push({
          filename: confirmation.vendorSignedDocumentFileName || `Vendor_Signed_Notice_${confirmation.referenceNumber}.pdf`,
          path: absSignedDoc,
        });
      }
    }
    if (confirmation.vendorStatementFileUrl) {
      const absStmt = getSafeAbsolutePath(confirmation.vendorStatementFileUrl, req.tenantId);
      if (absStmt && fs.existsSync(absStmt)) {
        auditAttachments.push({
          filename: confirmation.vendorStatementFileName || `Vendor_Statement_${confirmation.referenceNumber}.pdf`,
          path: absStmt,
        });
      }
    }

    if (initiatorEmail) {
      sendEmail({
        to: initiatorEmail,
        templateName: 'BALANCE_CONFIRMATION_REVERT_INITIATOR',
        templateData: {
          initiatorName: initiator?.fullName || 'AP Admin',
          vendorName: confirmation.vendorName,
          sapVendorNumber: confirmation.sapVendorNumber,
          referenceNumber: confirmation.referenceNumber,
          status: agreed ? 'CONFIRMED' : 'DISPUTED',
          sapBalance: formatINR(confirmation.sapClosingBalance),
          balanceIndicator: confirmation.balanceIndicator,
          vendorBalance: formatINR(numericReported),
          differenceAmount: formatINR(diff),
          signatoryName: confirmation.signatoryName,
          signatoryDesignation: confirmation.signatoryDesignation,
          disputeReason: confirmation.disputeReason,
          hasSignedDoc: !!confirmation.vendorSignedDocumentUrl,
          hasStatement: !!confirmation.vendorStatementFileUrl,
          statementFileName: confirmation.vendorStatementFileName,
          companyName: confirmation.companyName || req.tenant?.companyName,
          unitName: confirmation.unitName,
          cutOffDate: formatDate(confirmation.keyCutOffDate),
          tenantId: req.tenantId,
        },
        attachments: auditAttachments.length > 0 ? auditAttachments : undefined,
      });
    }

    // ── 3. Dual Dispatch Completion Email (Vendor + AP + Auditor) ──────────
    const campaignObj = confirmation.campaignId ? await ConfirmationCampaign.findById(confirmation.campaignId) : null;
    const auditorEmail = (confirmation.auditorEmails && confirmation.auditorEmails.length > 0)
      ? confirmation.auditorEmails.join(', ')
      : (campaignObj?.auditorGroupEmail || req.tenant?.balanceConfirmationConfig?.defaultAuditorGroupEmail);
    const clientApEmail = campaignObj?.clientApEmail || req.tenant?.balanceConfirmationConfig?.defaultClientApEmail || initiatorEmail;

    sendEmail({
      to: confirmation.vendorEmail,
      cc: [clientApEmail, auditorEmail].filter(Boolean).join(', '),
      templateName: 'BALANCE_CONFIRMATION_COMPLETED',
      templateData: {
        vendorName: confirmation.vendorName,
        sapVendorNumber: confirmation.sapVendorNumber,
        referenceNumber: confirmation.referenceNumber,
        companyName: confirmation.companyName,
        status: agreed ? 'Agreed & Confirmed' : 'Disputed with Variance',
        differenceAmount: formatINR(diff),
        signatoryName: confirmation.signatoryName,
        signatoryDesignation: confirmation.signatoryDesignation,
        signedDate: formatDate(confirmation.actionTimestamp),
        tenantId: req.tenantId,
      },
      attachments: auditAttachments.length > 0 ? auditAttachments : undefined,
    });

    res.json({
      success: true,
      status: confirmation.status,
      sealedPdfUrl: confirmation.sealedPdfUrl,
      message: 'Balance confirmation submitted successfully.',
    });
  } catch (err) {
    next(err);
  }
});

// ── AP Admin & Initiator Management Endpoints ────────────────────────────────
// Accessible by ADMIN, MASTER_DATA, L1_APPROVER, L2_APPROVER

/**
 * POST /api/balance-confirmations/preview
 * Pre-Dispatch Inspection: AP Admin / Master Data fetches and reads live SAP balance & line items
 * without committing or dispatching to the vendor.
 */
router.post('/preview', requireLogin, injectTenant, requireRole('ADMIN', 'MASTER_DATA', 'L1_APPROVER', 'L2_APPROVER'), requireModule('balanceConfirmation'), async (req, res, next) => {
  try {
    const { sapVendorNumber, companyCode, keyCutOffDate, fiscalYear } = req.body;

    if (!sapVendorNumber || !companyCode || !keyCutOffDate) {
      return res.status(400).json({ message: 'SAP Vendor Number, Company Code, and Cut-Off Date are required.' });
    }

    // 1. Check if vendor details exist locally (User or VendorRequest)
    let vendorName = '';
    let vendorEmail = '';
    let vendorAddress = '';

    const userRec = await User.findOne({ tenantId: req.tenantId, sapVendorNumber, role: 'REQUESTOR' });
    if (userRec) {
      vendorName = userRec.fullName;
      vendorEmail = userRec.email;
    }

    if (!vendorEmail || !vendorName) {
      const vReq = await VendorRequest.findOne({ tenantId: req.tenantId, sapVendorNumber });
      if (vReq) {
        if (!vendorName) vendorName = vReq.vendorName || vReq.name;
        if (!vendorEmail) vendorEmail = vReq.email;
        if (!vendorAddress) vendorAddress = vReq.address || '';
      }
    }

    // 2. Fetch and derive balance & line items from SAP (optionally filtered by fiscalYear)
    const sapConfig = getSapConfig(req.tenant);
    const derived = await fetchAndDeriveVendorBalance(sapVendorNumber, companyCode, keyCutOffDate, sapConfig, fiscalYear);

    if ((!vendorName || vendorName.startsWith('Vendor ')) && derived.vendorNameFromSap) {
      vendorName = derived.vendorNameFromSap;
    }
    if (derived.vendorEmailFromSap) {
      vendorEmail = derived.vendorEmailFromSap;
    }
    if (derived.vendorAddressFromSap && !vendorAddress) {
      vendorAddress = derived.vendorAddressFromSap;
    }

    const totalCredit = derived.grossCredit !== undefined ? derived.grossCredit : (derived.lineItems || []).reduce((acc, it) => it.debitCreditCode === 'H' ? acc + it.amount : acc, 0);
    const totalDebit = derived.grossDebit !== undefined ? derived.grossDebit : (derived.lineItems || []).reduce((acc, it) => it.debitCreditCode !== 'H' ? acc + it.amount : acc, 0);

    res.json({
      success: true,
      vendor: {
        sapVendorNumber,
        vendorName: vendorName || `Vendor ${sapVendorNumber}`,
        vendorEmail: vendorEmail || '',
        vendorEmailFromSap: derived.vendorEmailFromSap || '',
        vendorAddress: vendorAddress || '',
        vendorAddressFromSap: derived.vendorAddressFromSap || '',
        companyCode,
        companyName: req.tenant?.companyName || 'Balrampur Chini Mills Ltd.',
      },
      keyCutOffDate,
      fiscalYear: derived.fiscalYear || fiscalYear || '',
      closingBalance: derived.closingBalance,
      openingBalance: derived.openingBalance || 0,
      balanceIndicator: derived.balanceIndicator,
      currency: derived.currency || 'INR',
      lineItems: derived.lineItems || [],
      totalCredit: derived.grossCredit !== undefined ? derived.grossCredit : (Math.round(totalCredit * 100) / 100),
      totalDebit: derived.grossDebit !== undefined ? derived.grossDebit : (Math.round(totalDebit * 100) / 100),
      source: derived.source,
      balanceSource: derived.balanceSource || (derived.openingBalance ? 'FAP_VENDOR_BALANCE_SRV' : 'FAP_VENDOR_LINE_ITEMS_SRV'),
      subledgerBreakdown: derived.subledgerBreakdown || null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/balance-confirmations/batch-preview
 * Batch Pre-Dispatch Inspection: Fetches and calculates live SAP balances, line items count,
 * vendor names, and email addresses for multiple vendors or a vendor range before campaign launch.
 */
router.post('/batch-preview', requireLogin, injectTenant, requireRole('ADMIN', 'MASTER_DATA', 'L1_APPROVER', 'L2_APPROVER'), requireModule('balanceConfirmation'), async (req, res, next) => {
  try {
    const { vendorCodes, fromVendor, toVendor, companyCode, keyCutOffDate, fiscalYear } = req.body;

    if (!companyCode || !keyCutOffDate) {
      return res.status(400).json({ message: 'Company Code and Cut-Off Date are required.' });
    }

    const sapConfig = getSapConfig(req.tenant);
    let targetCodes = [];

    // 1. Resolve Range (fromVendor / toVendor) if provided
    if (fromVendor && toVendor) {
      const cleanFrom = String(fromVendor).trim();
      const cleanTo = String(toVendor).trim();

      // Try SAP fetchVendorsFromSAP first
      try {
        const { vendors } = await fetchVendorsFromSAP(sapConfig, {
          fromVendor: cleanFrom,
          toVendor: cleanTo,
          companyCode: companyCode.trim(),
          top: 100,
        });
        if (Array.isArray(vendors) && vendors.length > 0) {
          vendors.forEach(v => {
            const code = v.BusinessPartner || v.Supplier;
            if (code) targetCodes.push(String(code).trim());
          });
        }
      } catch (sapErr) {
        console.warn('[Batch Preview] fetchVendorsFromSAP range query fallback:', sapErr.message);
      }

      // If SAP query returned nothing or STUB simulation, enumerate numeric range if reasonable
      if (targetCodes.length === 0) {
        const isNumFrom = /^\d+$/.test(cleanFrom);
        const isNumTo = /^\d+$/.test(cleanTo);
        if (isNumFrom && isNumTo) {
          const start = parseInt(cleanFrom, 10);
          const end = parseInt(cleanTo, 10);
          const padLen = Math.max(cleanFrom.length, cleanTo.length);
          if (start <= end && (end - start) <= 100) {
            for (let i = start; i <= end; i++) {
              targetCodes.push(String(i).padStart(padLen, '0'));
            }
          }
        }
      }
    }

    // 2. Resolve explicit / comma-separated vendor codes
    if (vendorCodes) {
      const manual = Array.isArray(vendorCodes)
        ? vendorCodes
        : String(vendorCodes).split(/[\n,;\s]+/).map(s => s.trim()).filter(Boolean);
      targetCodes = [...targetCodes, ...manual];
    }

    // Deduplicate and filter empty
    targetCodes = [...new Set(targetCodes.map(c => String(c).trim()).filter(Boolean))];

    if (targetCodes.length === 0) {
      return res.status(400).json({ message: 'Please provide at least one valid SAP Vendor Number or Range.' });
    }

    // Cap at 100 vendors per preview batch for performance
    const vendorsToProcess = targetCodes.slice(0, 100);

    // 3. Process each vendor's balance and contact details
    const results = await Promise.all(vendorsToProcess.map(async (cleanCode) => {
      try {
        // Query local DB records for vendor name and email (User or VendorRequest)
        let vendorName = '';
        let vendorEmail = '';
        let vendorAddress = '';

        const userRec = await User.findOne({
          tenantId: req.tenantId,
          $or: [
            { sapVendorNumber: cleanCode },
            { sapVendorNumber: cleanCode.replace(/^0+/, '') },
            { sapVendorNumber: cleanCode.padStart(10, '0') }
          ],
          role: 'REQUESTOR',
        });
        if (userRec) {
          vendorName = userRec.fullName;
          vendorEmail = userRec.email;
        }

        if (!vendorEmail || !vendorName) {
          const vReq = await VendorRequest.findOne({
            tenantId: req.tenantId,
            $or: [
              { sapVendorNumber: cleanCode },
              { sapVendorNumber: cleanCode.replace(/^0+/, '') },
              { sapVendorNumber: cleanCode.padStart(10, '0') }
            ],
          });
          if (vReq) {
            if (!vendorName) vendorName = vReq.vendorName || vReq.name;
            if (!vendorEmail) vendorEmail = vReq.email;
            if (!vendorAddress) vendorAddress = vReq.address || '';
          }
        }

        // Fetch live balance & line items from SAP
        const derived = await fetchAndDeriveVendorBalance(cleanCode, companyCode, keyCutOffDate, sapConfig, fiscalYear);

        if ((!vendorName || vendorName.startsWith('Vendor ')) && derived.vendorNameFromSap) {
          vendorName = derived.vendorNameFromSap;
        }
        if (!vendorEmail && derived.vendorEmailFromSap) {
          vendorEmail = derived.vendorEmailFromSap;
        }
        if (derived.vendorAddressFromSap && !vendorAddress) {
          vendorAddress = derived.vendorAddressFromSap;
        }

        const totalCredit = derived.grossCredit !== undefined ? derived.grossCredit : (derived.lineItems || []).reduce((acc, it) => it.debitCreditCode === 'H' ? acc + it.amount : acc, 0);
        const totalDebit = derived.grossDebit !== undefined ? derived.grossDebit : (derived.lineItems || []).reduce((acc, it) => it.debitCreditCode !== 'H' ? acc + it.amount : acc, 0);

        return {
          sapVendorNumber: cleanCode,
          vendorName: vendorName || `Vendor ${cleanCode}`,
          vendorEmail: vendorEmail || '',
          hasEmail: Boolean(vendorEmail && vendorEmail.includes('@')),
          vendorAddress: vendorAddress || '',
          closingBalance: derived.closingBalance,
          openingBalance: derived.openingBalance || 0,
          balanceIndicator: derived.balanceIndicator,
          currency: derived.currency || 'INR',
          lineItemsCount: (derived.lineItems || []).length,
          lineItems: derived.lineItems || [],
          totalCredit: derived.grossCredit !== undefined ? derived.grossCredit : (Math.round(totalCredit * 100) / 100),
          totalDebit: derived.grossDebit !== undefined ? derived.grossDebit : (Math.round(totalDebit * 100) / 100),
          balanceSource: derived.balanceSource || 'FAP_VENDOR_LINE_ITEMS_SRV',
          source: derived.source,
          subledgerBreakdown: derived.subledgerBreakdown || null,
          error: null,
        };
      } catch (err) {
        return {
          sapVendorNumber: cleanCode,
          vendorName: `Vendor ${cleanCode}`,
          vendorEmail: '',
          hasEmail: false,
          vendorAddress: '',
          closingBalance: 0,
          openingBalance: 0,
          balanceIndicator: 'Credit',
          currency: 'INR',
          lineItemsCount: 0,
          lineItems: [],
          totalCredit: 0,
          totalDebit: 0,
          error: err.message || 'Failed to fetch vendor balance',
        };
      }
    }));

    const withEmailCount = results.filter(r => r.hasEmail).length;
    const withoutEmailCount = results.filter(r => !r.hasEmail).length;
    const totalBalance = results.reduce((acc, r) => acc + (r.closingBalance || 0), 0);

    res.json({
      success: true,
      vendors: results,
      total: results.length,
      summary: {
        total: results.length,
        withEmailCount,
        withoutEmailCount,
        totalBalance: Math.round(totalBalance * 100) / 100,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/balance-confirmations/single-dispatch
 * Dispatches an individual balance confirmation request to a single vendor.
 * Saves initiatedBy as the current user, snapshots SAP balance & line items,
 * and sends action email to vendor.
 */
router.post('/single-dispatch', requireLogin, injectTenant, requireRole('ADMIN', 'MASTER_DATA', 'L1_APPROVER'), requireModule('balanceConfirmation'), async (req, res, next) => {
  try {
    const {
      sapVendorNumber,
      vendorName,
      vendorEmail,
      vendorAddress = '',
      companyCode,
      companyName,
      unitName = '',
      unitAddress = '',
      keyCutOffDate,
      fiscalYear = '',
      responseDeadlineDays = 10,
      auditorGroupEmail,
      clientApEmail,
    } = req.body;

    if (!sapVendorNumber || !vendorEmail || !companyCode || !keyCutOffDate) {
      return res.status(400).json({ message: 'Vendor code, notification email, company code, and cut-off date are required.' });
    }

    const sapConfig = getSapConfig(req.tenant);

    // 1. Ingest line items & derive balance from SAP (with fiscalYear support)
    const derived = await fetchAndDeriveVendorBalance(sapVendorNumber, companyCode, keyCutOffDate, sapConfig, fiscalYear);

    const yearStr = new Date(keyCutOffDate).getFullYear();
    const monthStr = String(new Date(keyCutOffDate).getMonth() + 1).padStart(2, '0');
    const refNo = `SC/CB/${yearStr}/${monthStr}/${String(Date.now()).slice(-6)}`;

    // Resolve matching company entity from tenant registry
    const matchingEntity = (req.tenant?.companyEntities && companyCode)
      ? req.tenant.companyEntities.find(c => String(c.companyCode).trim() === String(companyCode).trim())
      : null;

    // Resolve matching plant/unit from tenant registry
    const matchingPlant = (req.tenant?.plants && req.tenant.plants.length > 0)
      ? (req.tenant.plants.find(p => unitName && (p.name?.toLowerCase() === unitName.toLowerCase() || p.code === unitName))
        || req.tenant.plants.find(p => companyCode && String(p.companyCode).trim() === String(companyCode).trim()))
      : null;

    const resolvedCompanyName = (matchingEntity?.legalName || companyName || req.tenant?.companyName || 'Birla-sugar Ltd.').trim();
    const resolvedUnitName = (unitName || matchingPlant?.name || '').trim();
    const resolvedUnitAddress = (unitAddress || req.body.unitAddress || matchingPlant?.address || '').trim();
    const resolvedCompanyAddress = (matchingEntity?.regdOfficeAddress || req.tenant?.regdOfficeAddress || req.tenant?.companyAddress || '').trim();
    const resolvedCin = (matchingEntity?.cin || req.tenant?.cin || '').trim();
    const apEmail = clientApEmail || matchingPlant?.apEmail || req.tenant?.balanceConfirmationConfig?.defaultClientApEmail || req.user.email || 'ap@example.com';
    const auditorEmail = auditorGroupEmail || req.tenant?.balanceConfirmationConfig?.defaultAuditorGroupEmail || 'auditor@example.com';

    const finalVendorName = vendorName || derived.vendorNameFromSap || `Vendor ${sapVendorNumber}`;

    const auditorEmailsList = (typeof auditorEmail === 'string' ? auditorEmail.split(/[,;\s]+/) : (Array.isArray(auditorEmail) ? auditorEmail : []))
      .map(e => e.trim())
      .filter(Boolean);

    // 2. Create single campaign record for tracking
    const campaign = await ConfirmationCampaign.create({
      tenantId: req.tenantId,
      campaignTitle: `Single Dispatch: ${finalVendorName} (${sapVendorNumber})${fiscalYear ? ` [FY ${fiscalYear}]` : ''}`,
      companyCode,
      companyName: resolvedCompanyName,
      unitName: resolvedUnitName,
      keyCutOffDate: new Date(keyCutOffDate),
      fiscalYear: fiscalYear || derived.fiscalYear || '',
      responseDeadlineDays: parseInt(responseDeadlineDays, 10) || 10,
      auditorGroupEmail: auditorEmail,
      clientApEmail: apEmail,
      initiatedBy: req.user._id,
      totalVendors: 1,
      pendingCount: 1,
      status: 'DISPATCHED',
    });

    // 3. Generate cryptographic magic token
    const rawToken = crypto.randomBytes(24).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + (parseInt(responseDeadlineDays, 10) || 10) * 24 * 60 * 60 * 1000);

    // 4. Create Vendor Confirmation
    const confirmation = await VendorConfirmation.create({
      tenantId: req.tenantId,
      campaignId: campaign._id,
      sapVendorNumber,
      vendorName: finalVendorName,
      vendorEmail,
      vendorAddress,
      companyCode,
      companyName: resolvedCompanyName,
      companyAddress: resolvedCompanyAddress,
      unitName: resolvedUnitName,
      unitAddress: resolvedUnitAddress,
      cin: resolvedCin,
      referenceNumber: refNo,
      keyCutOffDate: new Date(keyCutOffDate),
      fiscalYear: fiscalYear || derived.fiscalYear || '',
      token: rawToken,
      tokenHash,
      tokenExpiresAt: expiresAt,
      auditorEmails: auditorEmailsList,
      auditorFirmName: req.tenant?.balanceConfirmationConfig?.auditorFirmName || '',
      auditorAddress: req.tenant?.balanceConfirmationConfig?.auditorAddress || '',
      initiatedBy: req.user._id,
      initiatorEmail: req.user.email,
      sapClosingBalance: derived.closingBalance,
      openingBalance: derived.openingBalance || 0,
      totalCredit: derived.grossCredit !== undefined ? derived.grossCredit : 0,
      totalDebit: derived.grossDebit !== undefined ? derived.grossDebit : 0,
      balanceSource: derived.balanceSource || 'FAP_VENDOR_LINE_ITEMS_SRV',
      balanceIndicator: derived.balanceIndicator,
      currency: derived.currency || 'INR',
      status: 'PENDING_VENDOR',
      lineItems: derived.lineItems || [],
      subledgerBreakdown: derived.subledgerBreakdown || null,
    });

    // 5. Generate initial Creditors Balance Confirmation letter PDF & store for audit
    let letterAttachment = null;
    try {
      const letterPdfRel = await generateCreditorBalanceConfirmationLetterPDF(confirmation, req.tenant);
      confirmation.initialLetterPdfUrl = letterPdfRel;
      await confirmation.save();

      const absLetterPath = getSafeAbsolutePath(letterPdfRel, req.tenantId);
      if (absLetterPath && fs.existsSync(absLetterPath)) {
        letterAttachment = [{
          filename: `Creditors_Balance_Confirmation_${refNo}.pdf`,
          path: absLetterPath,
        }];
      }
    } catch (pdfErr) {
      console.error('[Letter PDF Gen Error in single-request]:', pdfErr.message);
    }

    // 6. Trigger statutory email to vendor with attached confirmation letter
    sendEmail({
      to: vendorEmail,
      templateName: 'BALANCE_CONFIRMATION_REQUEST',
      templateData: {
        vendorName: confirmation.vendorName,
        sapVendorNumber,
        referenceNumber: refNo,
        companyName: finalCompanyName,
        unitName: confirmation.unitName,
        auditorGroupEmail: campaign?.auditorGroupEmail || req.tenant?.balanceConfirmationConfig?.defaultAuditorGroupEmail,
        auditorFirmName: req.tenant?.balanceConfirmationConfig?.auditorFirmName,
        cutOffDate: formatDate(keyCutOffDate),
        closingBalance: derived.closingBalance,
        balanceIndicator: derived.balanceIndicator,
        deadlineDays: responseDeadlineDays,
        token: rawToken,
        tenantId: req.tenantId,
      },
      attachments: letterAttachment,
    });

    res.json({
      success: true,
      message: `Balance confirmation request dispatched to ${confirmation.vendorName} (${sapVendorNumber}). Revert tracking active.`,
      confirmation,
      campaign,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/balance-confirmations/campaigns
 * Initiator creates & dispatches a balance confirmation campaign for SAP vendors.
 */
router.post('/campaigns', requireLogin, injectTenant, requireRole('ADMIN', 'MASTER_DATA', 'L1_APPROVER'), requireModule('balanceConfirmation'), async (req, res, next) => {
  try {
    const {
      campaignTitle,
      companyCode,
      companyName,
      unitName,
      keyCutOffDate,
      fiscalYear = '',
      responseDeadlineDays = 10,
      auditorGroupEmail,
      clientApEmail,
      vendors = [],
    } = req.body;

    if (!campaignTitle || !companyCode || !keyCutOffDate || !auditorGroupEmail) {
      return res.status(400).json({ message: 'Missing required campaign parameters.' });
    }

    if (!Array.isArray(vendors) || vendors.length === 0) {
      return res.status(400).json({ message: 'At least one vendor must be selected for the campaign.' });
    }

    const sapConfig = getSapConfig(req.tenant);

    // Resolve matching company entity from tenant registry
    const matchingEntity = (req.tenant?.companyEntities && companyCode)
      ? req.tenant.companyEntities.find(c => String(c.companyCode).trim() === String(companyCode).trim())
      : null;

    // Resolve matching plant/unit from tenant registry
    const matchingPlant = (req.tenant?.plants && req.tenant.plants.length > 0)
      ? (req.tenant.plants.find(p => unitName && (p.name?.toLowerCase() === unitName.toLowerCase() || p.code === unitName))
        || req.tenant.plants.find(p => companyCode && String(p.companyCode).trim() === String(companyCode).trim()))
      : null;

    const resolvedCompanyName = (matchingEntity?.legalName || companyName || req.tenant?.companyName || 'Birla-sugar Ltd.').trim();
    const resolvedUnitName = (unitName || matchingPlant?.name || '').trim();
    const resolvedUnitAddress = (req.body.unitAddress || matchingPlant?.address || '').trim();
    const resolvedCompanyAddress = (matchingEntity?.regdOfficeAddress || req.tenant?.regdOfficeAddress || req.tenant?.companyAddress || '').trim();
    const resolvedCin = (matchingEntity?.cin || req.tenant?.cin || '').trim();
    const resolvedClientApEmail = clientApEmail || matchingPlant?.apEmail || req.tenant?.balanceConfirmationConfig?.defaultClientApEmail || req.user.email || 'ap@example.com';

    const campaign = await ConfirmationCampaign.create({
      tenantId: req.tenantId,
      campaignTitle,
      companyCode,
      companyName: resolvedCompanyName,
      unitName: resolvedUnitName,
      keyCutOffDate: new Date(keyCutOffDate),
      fiscalYear: fiscalYear || '',
      responseDeadlineDays: parseInt(responseDeadlineDays, 10) || 10,
      auditorGroupEmail,
      clientApEmail: resolvedClientApEmail,
      initiatedBy: req.user._id,
      totalVendors: vendors.length,
      pendingCount: vendors.length,
      status: 'DISPATCHED',
    });

    const yearStr = new Date(keyCutOffDate).getFullYear();
    const monthStr = String(new Date(keyCutOffDate).getMonth() + 1).padStart(2, '0');
    const createdConfirmations = [];

    const auditorEmailsList = (typeof auditorGroupEmail === 'string' ? auditorGroupEmail.split(/[,;\s]+/) : (Array.isArray(auditorGroupEmail) ? auditorGroupEmail : []))
      .map(e => e.trim())
      .filter(Boolean);

    for (let i = 0; i < vendors.length; i++) {
      const v = vendors[i];
      const vendorCode = v.sapVendorNumber || v.code;
      let vendorEmail = v.email || v.vendorEmail;

      // 1. Ingest line items & derive balance from SAP (with fiscalYear support)
      const derived = await fetchAndDeriveVendorBalance(vendorCode, companyCode, keyCutOffDate, sapConfig, fiscalYear);
      if (!vendorEmail && derived.vendorEmailFromSap) {
        vendorEmail = derived.vendorEmailFromSap;
      }
      if (!vendorEmail) continue;

      const finalBatchVendorName = (v.vendorName && !v.vendorName.startsWith('Vendor '))
        ? v.vendorName
        : (derived.vendorNameFromSap || v.name || `Vendor ${vendorCode}`);

      // 2. Generate secure token
      const rawToken = crypto.randomBytes(24).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const expiresAt = new Date(Date.now() + (parseInt(responseDeadlineDays, 10) || 10) * 24 * 60 * 60 * 1000);

      const refNo = `SC/CB/${yearStr}/${monthStr}/${String(Date.now()).slice(-4)}${i + 1}`;

      const confirmation = await VendorConfirmation.create({
        tenantId: req.tenantId,
        campaignId: campaign._id,
        sapVendorNumber: vendorCode,
        vendorName: finalBatchVendorName,
        vendorEmail,
        vendorAddress: derived.vendorAddressFromSap || '',
        companyCode,
        companyName: resolvedCompanyName,
        companyAddress: resolvedCompanyAddress,
        unitName: resolvedUnitName,
        unitAddress: resolvedUnitAddress,
        cin: resolvedCin,
        referenceNumber: refNo,
        keyCutOffDate: new Date(keyCutOffDate),
        fiscalYear: fiscalYear || derived.fiscalYear || '',
        token: rawToken,
        tokenHash,
        tokenExpiresAt: expiresAt,
        auditorEmails: auditorEmailsList,
        auditorFirmName: req.tenant?.balanceConfirmationConfig?.auditorFirmName || '',
        auditorAddress: req.tenant?.balanceConfirmationConfig?.auditorAddress || '',
        initiatedBy: req.user._id,
        initiatorEmail: req.user.email,
        sapClosingBalance: derived.closingBalance,
        openingBalance: derived.openingBalance || 0,
        totalCredit: derived.grossCredit !== undefined ? derived.grossCredit : 0,
        totalDebit: derived.grossDebit !== undefined ? derived.grossDebit : 0,
        balanceSource: derived.balanceSource || 'FAP_VENDOR_LINE_ITEMS_SRV',
        balanceIndicator: derived.balanceIndicator,
        currency: derived.currency || 'INR',
        status: 'PENDING_VENDOR',
        lineItems: derived.lineItems || [],
        subledgerBreakdown: derived.subledgerBreakdown || null,
      });

      createdConfirmations.push(confirmation);

      // 3. Generate initial Creditors Balance Confirmation letter PDF & store for audit
      let letterAttachment = null;
      try {
        const letterPdfRel = await generateCreditorBalanceConfirmationLetterPDF(confirmation, req.tenant);
        confirmation.initialLetterPdfUrl = letterPdfRel;
        await confirmation.save();

        const absLetterPath = getSafeAbsolutePath(letterPdfRel, req.tenantId);
        if (absLetterPath && fs.existsSync(absLetterPath)) {
          letterAttachment = [{
            filename: `Creditors_Balance_Confirmation_${refNo}.pdf`,
            path: absLetterPath,
          }];
        }
      } catch (pdfErr) {
        console.error('[Letter PDF Gen Error in campaign]:', pdfErr.message);
      }

      // 4. Trigger statutory notification email to vendor with attached confirmation letter
      sendEmail({
        to: vendorEmail,
        templateName: 'BALANCE_CONFIRMATION_REQUEST',
        templateData: {
          vendorName: finalBatchVendorName,
          sapVendorNumber: vendorCode,
          referenceNumber: refNo,
          companyName: campaign.companyName,
          unitName: campaign.unitName,
          auditorGroupEmail: campaign.auditorGroupEmail,
          auditorFirmName: req.tenant?.balanceConfirmationConfig?.auditorFirmName,
          cutOffDate: formatDate(keyCutOffDate),
          closingBalance: derived.closingBalance,
          balanceIndicator: derived.balanceIndicator,
          deadlineDays: responseDeadlineDays,
          token: rawToken,
          tenantId: req.tenantId,
        },
        attachments: letterAttachment,
      });
    }

    // Sync actual total and pending counts if some vendors had no email
    campaign.totalVendors = createdConfirmations.length;
    campaign.pendingCount = createdConfirmations.length;
    await campaign.save();

    res.json({
      success: true,
      message: `Balance confirmation campaign created and dispatched to ${createdConfirmations.length} vendors.`,
      campaign,
      confirmationsCount: createdConfirmations.length,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/balance-confirmations/campaigns
 * Lists campaigns for tenant with real-time aggregated counts across all statuses
 */
router.get('/campaigns', requireLogin, injectTenant, requireRole('ADMIN', 'MASTER_DATA', 'L1_APPROVER', 'L2_APPROVER'), requireModule('balanceConfirmation'), async (req, res, next) => {
  try {
    const campaigns = await ConfirmationCampaign.find({ tenantId: req.tenantId })
      .sort({ createdAt: -1 })
      .populate('initiatedBy', 'fullName email')
      .lean();

    if (!campaigns.length) {
      return res.json({ campaigns: [] });
    }

    const campaignIds = campaigns.map(c => c._id);

    // Dynamic aggregation on VendorConfirmation by campaignId
    const statusCounts = await VendorConfirmation.aggregate([
      { $match: { tenantId: req.tenantId, campaignId: { $in: campaignIds } } },
      {
        $group: {
          _id: '$campaignId',
          total: { $sum: 1 },
          // Vendor Agreed: responded with 0 difference OR explicitly CONFIRMED / PRESUMED_CONFIRMED OR closed as RECONCILED with 0 diff
          confirmed: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $eq: ['$status', 'CONFIRMED'] },
                    { $eq: ['$status', 'PRESUMED_CONFIRMED'] },
                    {
                      $and: [
                        { $ne: ['$actionTimestamp', null] },
                        { $or: [{ $eq: ['$differenceAmount', 0] }, { $not: ['$differenceAmount'] }] },
                      ],
                    },
                    {
                      $and: [
                        { $eq: ['$status', 'RECONCILED'] },
                        { $or: [{ $eq: ['$differenceAmount', 0] }, { $not: ['$differenceAmount'] }] },
                      ],
                    },
                  ],
                },
                1,
                0,
              ],
            },
          },
          // Disputed / Variance: vendor reported variance > 0 OR status is DISPUTED
          disputed: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $eq: ['$status', 'DISPUTED'] },
                    {
                      $and: [
                        { $ne: ['$actionTimestamp', null] },
                        { $gt: ['$differenceAmount', 0] },
                      ],
                    },
                    { $gt: ['$differenceAmount', 0] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          // Reconciled by AP (with variance):
          reconciled: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$status', 'RECONCILED'] },
                    { $gt: ['$differenceAmount', 0] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          // Total AP Reconciled regardless of difference:
          totalReconciled: {
            $sum: {
              $cond: [{ $eq: ['$status', 'RECONCILED'] }, 1, 0],
            },
          },
          // Fully resolved items:
          resolved: {
            $sum: {
              $cond: [
                { $in: ['$status', ['CONFIRMED', 'RECONCILED', 'PRESUMED_CONFIRMED']] },
                1,
                0,
              ],
            },
          },
          // Pending Review (reverted to initiator queue):
          pendingReview: {
            $sum: {
              $cond: [{ $eq: ['$status', 'PENDING_REVIEW'] }, 1, 0],
            },
          },
          // Presumed Confirmed:
          presumed: {
            $sum: {
              $cond: [{ $eq: ['$status', 'PRESUMED_CONFIRMED'] }, 1, 0],
            },
          },
          // Awaiting Vendor:
          pendingVendor: {
            $sum: {
              $cond: [{ $eq: ['$status', 'PENDING_VENDOR'] }, 1, 0],
            },
          },
        },
      },
    ]);

    const countsMap = {};
    campaignIds.forEach(id => {
      countsMap[id.toString()] = {
        total: 0,
        confirmed: 0,
        reconciled: 0,
        totalReconciled: 0,
        disputed: 0,
        pendingReview: 0,
        pendingVendor: 0,
        presumed: 0,
        resolved: 0,
      };
    });

    statusCounts.forEach(sc => {
      const campIdStr = sc._id?.toString();
      if (countsMap[campIdStr]) {
        countsMap[campIdStr] = {
          total: sc.total || 0,
          confirmed: sc.confirmed || 0,
          reconciled: sc.reconciled || 0,
          totalReconciled: sc.totalReconciled || 0,
          disputed: sc.disputed || 0,
          pendingReview: sc.pendingReview || 0,
          pendingVendor: sc.pendingVendor || 0,
          presumed: sc.presumed || 0,
          resolved: sc.resolved || 0,
        };
      }
    });

    const enrichedCampaigns = await Promise.all(campaigns.map(async c => {
      const cid = c._id.toString();
      const live = countsMap[cid] || { total: c.totalVendors || 0, confirmed: 0, reconciled: 0, totalReconciled: 0, disputed: 0, pendingReview: 0, pendingVendor: 0, presumed: 0, resolved: 0 };

      const totalVendors = live.total > 0 ? live.total : (c.totalVendors || 0);
      const confirmedCount = live.confirmed;
      const reconciledCount = live.totalReconciled > 0 ? live.totalReconciled : live.reconciled;
      const disputedCount = live.disputed;
      const pendingReviewCount = live.pendingReview;
      const presumedCount = live.presumed;
      const pendingCount = live.pendingVendor;

      // Fully resolved = confirmed + reconciled + presumed (or live.resolved)
      const resolvedCount = live.resolved || (confirmedCount + reconciledCount + presumedCount);
      let status = c.status;
      if (totalVendors > 0 && resolvedCount >= totalVendors && status !== 'CLOSED') {
        status = 'COMPLETED';
        if (c.status !== 'COMPLETED') {
          await ConfirmationCampaign.updateOne(
            { _id: c._id },
            {
              status: 'COMPLETED',
              confirmedCount,
              reconciledCount,
              disputedCount,
              pendingCount: 0,
            }
          );
        }
      }

      return {
        ...c,
        totalVendors,
        confirmedCount,
        reconciledCount,
        disputedCount,
        pendingReviewCount,
        presumedCount,
        pendingCount,
        resolvedCount,
        status,
      };
    }));

    res.json({ campaigns: enrichedCampaigns });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/balance-confirmations/campaigns/:id
 * Campaign details & roster of vendor confirmations
 */
router.get('/campaigns/:id', requireLogin, injectTenant, requireRole('ADMIN', 'MASTER_DATA', 'L1_APPROVER', 'L2_APPROVER'), requireModule('balanceConfirmation'), async (req, res, next) => {
  try {
    let campaign = await ConfirmationCampaign.findOne({ _id: req.params.id, tenantId: req.tenantId })
      .populate('initiatedBy', 'fullName email')
      .lean();

    if (!campaign) return res.status(404).json({ message: 'Campaign not found' });

    const confirmations = await VendorConfirmation.find({ campaignId: campaign._id, tenantId: req.tenantId })
      .sort({ createdAt: -1 })
      .populate('reconciledBy', 'fullName email')
      .lean();

    // Check if all are resolved
    const resolvedCount = confirmations.filter(c => ['CONFIRMED', 'RECONCILED', 'PRESUMED_CONFIRMED'].includes(c.status)).length;
    if (confirmations.length > 0 && resolvedCount >= confirmations.length && campaign.status !== 'COMPLETED' && campaign.status !== 'CLOSED') {
      await ConfirmationCampaign.updateOne({ _id: campaign._id }, { status: 'COMPLETED' });
      campaign.status = 'COMPLETED';
    }

    res.json({ campaign, confirmations });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/balance-confirmations/review-queue
 * Closed-Loop Queue: Requests reverted back to the initiator for review and reconciliation.
 */
router.get('/review-queue', requireLogin, injectTenant, requireRole('ADMIN', 'MASTER_DATA', 'L1_APPROVER', 'L2_APPROVER'), requireModule('balanceConfirmation'), async (req, res, next) => {
  try {
    const query = {
      tenantId: req.tenantId,
      status: 'PENDING_REVIEW',
    };

    // If not full admin, optionally show only confirmations initiated by this user
    if (req.user.role === 'L1_APPROVER') {
      query.initiatedBy = req.user._id;
    }

    const items = await VendorConfirmation.find(query)
      .sort({ actionTimestamp: -1 })
      .populate('campaignId', 'campaignTitle keyCutOffDate')
      .populate('initiatedBy', 'fullName email')
      .lean();

    res.json({ items, count: items.length });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/balance-confirmations/:id/reconcile
 * Initiator completes final reconciliation and closes confirmation.
 */
router.post('/:id/reconcile', requireLogin, injectTenant, requireRole('ADMIN', 'MASTER_DATA', 'L1_APPROVER'), requireModule('balanceConfirmation'), async (req, res, next) => {
  try {
    const { reconciliationNotes, status } = req.body;

    const confirmation = await VendorConfirmation.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (!confirmation) {
      return res.status(404).json({ message: 'Confirmation record not found' });
    }

    const isAgreed = !confirmation.differenceAmount || confirmation.differenceAmount === 0;
    const finalStatus = status || (isAgreed ? 'CONFIRMED' : 'RECONCILED');

    confirmation.reconciliationNotes = reconciliationNotes || (isAgreed ? 'Verified and confirmed without variance.' : 'Reconciled & verified by Accounts Payable.');
    confirmation.reconciledBy = req.user._id;
    confirmation.reconciledAt = new Date();
    confirmation.status = finalStatus;

    // Regenerate sealed PDF to include reconciliation remarks in final certificate
    try {
      const pdfPath = await generateCreditorBalanceConfirmationLetterPDF(confirmation, req.tenant, { sealed: true });
      confirmation.sealedPdfUrl = pdfPath;
    } catch (pdfErr) {
      console.error('[PDF Gen Error]:', pdfErr.message);
    }

    await confirmation.save();

    // Update campaign counters and sync status
    if (confirmation.campaignId) {
      const allConfirmations = await VendorConfirmation.find({ campaignId: confirmation.campaignId, tenantId: req.tenantId }).lean();
      const total = allConfirmations.length;
      const resolved = allConfirmations.filter(c => ['CONFIRMED', 'RECONCILED', 'PRESUMED_CONFIRMED'].includes(c.status)).length;
      const confirmedCount = allConfirmations.filter(c => 
        c.status === 'CONFIRMED' || 
        c.status === 'PRESUMED_CONFIRMED' || 
        (!c.differenceAmount && (c.actionTimestamp || c.status === 'RECONCILED'))
      ).length;
      const reconciledCount = allConfirmations.filter(c => c.status === 'RECONCILED' && c.differenceAmount > 0).length;
      const disputedCount = allConfirmations.filter(c => c.status === 'DISPUTED' || (c.differenceAmount && c.differenceAmount > 0)).length;
      const pendingCount = allConfirmations.filter(c => c.status === 'PENDING_VENDOR').length;

      const updateFields = {
        confirmedCount,
        reconciledCount,
        disputedCount,
        pendingCount,
      };
      if (total > 0 && resolved >= total) {
        updateFields.status = 'COMPLETED';
      }
      await ConfirmationCampaign.findByIdAndUpdate(confirmation.campaignId, updateFields);
    }

    res.json({
      success: true,
      message: 'Balance confirmation reconciled and officially closed.',
      confirmation,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/balance-confirmations/:id/letter-pdf
 * Authenticated endpoint: Download initial Creditors Balance Confirmation Notice PDF
 */
router.get('/:id/letter-pdf', requireLogin, injectTenant, requireRole('ADMIN', 'MASTER_DATA', 'L1_APPROVER', 'L2_APPROVER', 'REQUESTOR', 'VENDOR'), requireModule('balanceConfirmation'), async (req, res, next) => {
  try {
    const confirmation = await VendorConfirmation.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (!confirmation) return res.status(404).json({ message: 'Confirmation record not found' });

    // RBAC ownership check for vendor roles
    if (['REQUESTOR', 'VENDOR'].includes(req.user.role)) {
      const matchesVendorNo = req.user.sapVendorNumber && req.user.sapVendorNumber === confirmation.sapVendorNumber;
      const matchesEmail = req.user.email && req.user.email.toLowerCase() === confirmation.vendorEmail.toLowerCase();
      const isInitiator = confirmation.initiatedBy && confirmation.initiatedBy.equals(req.user._id);
      if (!matchesVendorNo && !matchesEmail && !isInitiator) {
        return res.status(403).json({ message: 'Access denied: You are not authorized to view this document.' });
      }
    }

    const shouldRefresh = req.query.refresh === 'true' || req.query.force === 'true';
    let fullPath = (!shouldRefresh && confirmation.initialLetterPdfUrl) ? getSafeAbsolutePath(confirmation.initialLetterPdfUrl, req.tenantId) : null;
    if (!fullPath || !fs.existsSync(fullPath)) {
      const relPath = await generateCreditorBalanceConfirmationLetterPDF(confirmation, req.tenant);
      confirmation.initialLetterPdfUrl = relPath;
      await confirmation.save();
      fullPath = getSafeAbsolutePath(relPath, req.tenantId);
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Creditors_Balance_Confirmation_${confirmation.referenceNumber}.pdf"`);
    fs.createReadStream(fullPath).pipe(res);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/balance-confirmations/:id/audit-certificate
 * Authenticated endpoint: Download sealed SA 505 Audit Certificate PDF
 */
router.get('/:id/audit-certificate', requireLogin, injectTenant, requireRole('ADMIN', 'MASTER_DATA', 'L1_APPROVER', 'L2_APPROVER', 'REQUESTOR', 'VENDOR'), requireModule('balanceConfirmation'), async (req, res, next) => {
  try {
    const confirmation = await VendorConfirmation.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (!confirmation) return res.status(404).json({ message: 'Confirmation record not found' });

    if (['REQUESTOR', 'VENDOR'].includes(req.user.role)) {
      const matchesVendorNo = req.user.sapVendorNumber && req.user.sapVendorNumber === confirmation.sapVendorNumber;
      const matchesEmail = req.user.email && req.user.email.toLowerCase() === confirmation.vendorEmail.toLowerCase();
      const isInitiator = confirmation.initiatedBy && confirmation.initiatedBy.equals(req.user._id);
      if (!matchesVendorNo && !matchesEmail && !isInitiator) {
        return res.status(403).json({ message: 'Access denied: You are not authorized to view this document.' });
      }
    }

    const shouldRefresh = req.query.refresh === 'true' || req.query.force === 'true';
    let fullPath = (!shouldRefresh && confirmation.sealedPdfUrl) ? getSafeAbsolutePath(confirmation.sealedPdfUrl, req.tenantId) : null;
    if (!fullPath || !fs.existsSync(fullPath)) {
      const pdfPath = await generateCreditorBalanceConfirmationLetterPDF(confirmation, req.tenant, { sealed: true });
      confirmation.sealedPdfUrl = pdfPath;
      await confirmation.save();
      fullPath = getSafeAbsolutePath(pdfPath, req.tenantId);
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="SA505_Confirmation_${confirmation.referenceNumber}.pdf"`);
    fs.createReadStream(fullPath).pipe(res);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/balance-confirmations/:id/signed-doc
 * Authenticated endpoint: Download vendor uploaded signed confirmation document
 */
router.get('/:id/signed-doc', requireLogin, injectTenant, requireRole('ADMIN', 'MASTER_DATA', 'L1_APPROVER', 'L2_APPROVER', 'REQUESTOR', 'VENDOR'), requireModule('balanceConfirmation'), async (req, res, next) => {
  try {
    const confirmation = await VendorConfirmation.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (!confirmation || !confirmation.vendorSignedDocumentUrl) {
      return res.status(404).json({ message: 'Signed document not found.' });
    }

    if (['REQUESTOR', 'VENDOR'].includes(req.user.role)) {
      const matchesVendorNo = req.user.sapVendorNumber && req.user.sapVendorNumber === confirmation.sapVendorNumber;
      const matchesEmail = req.user.email && req.user.email.toLowerCase() === confirmation.vendorEmail.toLowerCase();
      const isInitiator = confirmation.initiatedBy && confirmation.initiatedBy.equals(req.user._id);
      if (!matchesVendorNo && !matchesEmail && !isInitiator) {
        return res.status(403).json({ message: 'Access denied: You are not authorized to view this document.' });
      }
    }

    const fullPath = getSafeAbsolutePath(confirmation.vendorSignedDocumentUrl, req.tenantId);
    if (!fullPath || !fs.existsSync(fullPath)) {
      return res.status(404).json({ message: 'File not found on storage.' });
    }

    const filename = confirmation.vendorSignedDocumentFileName || `Vendor_Signed_Notice_${confirmation.referenceNumber}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    fs.createReadStream(fullPath).pipe(res);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/balance-confirmations/:id/statement
 * Authenticated endpoint: Download vendor uploaded statement ledger
 */
router.get('/:id/statement', requireLogin, injectTenant, requireRole('ADMIN', 'MASTER_DATA', 'L1_APPROVER', 'L2_APPROVER', 'REQUESTOR', 'VENDOR'), requireModule('balanceConfirmation'), async (req, res, next) => {
  try {
    const confirmation = await VendorConfirmation.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (!confirmation || !confirmation.vendorStatementFileUrl) {
      return res.status(404).json({ message: 'Statement document not found.' });
    }

    if (['REQUESTOR', 'VENDOR'].includes(req.user.role)) {
      const matchesVendorNo = req.user.sapVendorNumber && req.user.sapVendorNumber === confirmation.sapVendorNumber;
      const matchesEmail = req.user.email && req.user.email.toLowerCase() === confirmation.vendorEmail.toLowerCase();
      const isInitiator = confirmation.initiatedBy && confirmation.initiatedBy.equals(req.user._id);
      if (!matchesVendorNo && !matchesEmail && !isInitiator) {
        return res.status(403).json({ message: 'Access denied: You are not authorized to view this document.' });
      }
    }

    const fullPath = getSafeAbsolutePath(confirmation.vendorStatementFileUrl, req.tenantId);
    if (!fullPath || !fs.existsSync(fullPath)) {
      return res.status(404).json({ message: 'File not found on storage.' });
    }

    const filename = confirmation.vendorStatementFileName || `Vendor_Statement_${confirmation.referenceNumber}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    fs.createReadStream(fullPath).pipe(res);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/balance-confirmations/:id/resend
 * Resends reminder email to pending vendor
 */
router.post('/:id/resend', requireLogin, injectTenant, requireRole('ADMIN', 'MASTER_DATA', 'L1_APPROVER'), requireModule('balanceConfirmation'), async (req, res, next) => {
  try {
    const confirmation = await VendorConfirmation.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (!confirmation) return res.status(404).json({ message: 'Confirmation record not found' });

    let letterAttachment = null;
    if (confirmation.initialLetterPdfUrl) {
      const absPath = getSafeAbsolutePath(confirmation.initialLetterPdfUrl, req.tenantId);
      if (absPath && fs.existsSync(absPath)) {
        letterAttachment = [{
          filename: `Creditors_Balance_Confirmation_${confirmation.referenceNumber}.pdf`,
          path: absPath,
        }];
      }
    }

    sendEmail({
      to: confirmation.vendorEmail,
      templateName: 'BALANCE_CONFIRMATION_REQUEST',
      templateData: {
        vendorName: confirmation.vendorName,
        sapVendorNumber: confirmation.sapVendorNumber,
        referenceNumber: confirmation.referenceNumber,
        companyName: confirmation.companyName,
        unitName: confirmation.unitName,
        cutOffDate: formatDate(confirmation.keyCutOffDate),
        closingBalance: confirmation.sapClosingBalance,
        balanceIndicator: confirmation.balanceIndicator,
        deadlineDays: 5,
        token: confirmation.token,
        tenantId: req.tenantId,
      },
      attachments: letterAttachment,
    });

    res.json({ success: true, message: `Reminder email sent to ${confirmation.vendorEmail}` });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

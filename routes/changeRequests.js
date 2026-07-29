const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const VendorChangeRequest = require('../models/VendorChangeRequest');
const VendorRequest = require('../models/VendorRequest');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const ApprovalSettings = require('../models/ApprovalSettings');
const { requireLogin, requireRole } = require('../middleware/auth');
const { injectTenant, getSapConfig, getGeminiConfig } = require('../middleware/tenant');
const { pushVendorChangeRequest } = require('../utils/sapBridge');
const { sendEmail } = require('../utils/email');

// Multer config for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads', req.tenantId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: parseInt(process.env.UPLOAD_MAX_SIZE || '5242880') },
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png'];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Only PDF, JPG, and PNG files are allowed'));
  },
});

// ── GET /api/change-requests ──────────────────────────────────────────
// List change requests scoped by Tenant
router.get('/', requireLogin, async (req, res, next) => {
  try {
    const { status, search, page = 1, limit = 20 } = req.query;
    const query = { tenantId: req.tenantId };

    const andConditions = [];

    if (req.user.role === 'REQUESTOR' || req.user.role === 'VENDOR') {
      query.createdBy = req.user._id;
    } else {
      // Approvers/Admins see all non-drafts, or drafts they created
      andConditions.push({
        $or: [
          { status: { $ne: 'DRAFT' } },
          { createdBy: req.user._id }
        ]
      });
    }

    if (req.user.role !== 'ADMIN' && req.user.plants && req.user.plants.length > 0) {
      query.plant = { $in: req.user.plants };
    }

    if (status) query.status = status;
    if (search) {
      query.sapVendorNumber = { $regex: search, $options: 'i' };
    }

    if (andConditions.length > 0) {
      query.$and = andConditions;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [requests, total] = await Promise.all([
      VendorChangeRequest.find(query)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .populate('createdBy', 'fullName email'),
      VendorChangeRequest.countDocuments(query),
    ]);

    res.json({
      requests,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit))
    });
  } catch (err) { next(err); }
});

// ── GET /api/change-requests/pending ──────────────────────────────────
// Returns pending queue for approvers
router.get('/pending', requireLogin, requireRole('L1_APPROVER', 'L2_APPROVER', 'MASTER_DATA', 'ADMIN'), async (req, res, next) => {
  try {
    const { search, page = 1, limit = 20 } = req.query;
    const query = { tenantId: req.tenantId };

    const andConditions = [];

    if (req.user.role === 'ADMIN') {
      query.status = { $in: ['PENDING_APPROVAL', 'SAP_PENDING', 'SAP_FAILED', 'PENDING_L1', 'PENDING_L2', 'PENDING_MDT'] };
    } else if (req.user.role === 'MASTER_DATA') {
      andConditions.push({
        $or: [
          { status: 'PENDING_APPROVAL', currentLevel: 'MASTER_DATA' },
          { status: 'PENDING_MDT' },
          { status: { $in: ['SAP_PENDING', 'SAP_FAILED'] } }
        ]
      });
    } else {
      const oldPending = {
        L1_APPROVER: 'PENDING_L1',
        L2_APPROVER: 'PENDING_L2',
      }[req.user.role];

      andConditions.push({
        $or: [
          { status: 'PENDING_APPROVAL', currentLevel: req.user.role },
          { status: oldPending }
        ]
      });
    }

    if (req.user.role !== 'ADMIN' && req.user.plants && req.user.plants.length > 0) {
      query.plant = { $in: req.user.plants };
    }

    if (search) {
      query.sapVendorNumber = { $regex: search, $options: 'i' };
    }

    if (andConditions.length > 0) {
      query.$and = andConditions;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [requests, total] = await Promise.all([
      VendorChangeRequest.find(query)
        .sort({ createdAt: 1 }) // FIFO
        .skip(skip)
        .limit(parseInt(limit)),
      VendorChangeRequest.countDocuments(query),
    ]);

    res.json({
      requests,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit))
    });
  } catch (err) { next(err); }
});

// ── GET /api/change-requests/:id ──────────────────────────────────────
// Details of a request
router.get('/:id', requireLogin, async (req, res, next) => {
  try {
    const request = await VendorChangeRequest.findOne({ _id: req.params.id, tenantId: req.tenantId })
      .populate('createdBy', 'fullName email');
    if (!request) return res.status(404).json({ message: 'Change request not found' });

    if (req.user.role !== 'ADMIN' && req.user.plants && req.user.plants.length > 0) {
      if (request.plant && !req.user.plants.includes(request.plant)) {
        return res.status(403).json({ message: 'Access denied' });
      }
    }

    res.json({ request });
  } catch (err) { next(err); }
});

// ── POST /api/change-requests/draft ───────────────────────────────────
// Save a draft
router.post('/draft', requireLogin, injectTenant, upload.array('files'), async (req, res, next) => {
  try {
    const { sapVendorNumber, proposedChanges } = req.body;
    if (!sapVendorNumber) return res.status(400).json({ message: 'SAP Vendor Number is required' });

    const parsedProposedChanges = typeof proposedChanges === 'string' ? JSON.parse(proposedChanges) : (proposedChanges || {});

    const originalVendor = await VendorRequest.findOne({ sapVendorNumber, tenantId: req.tenantId });
    const userPlant = originalVendor ? originalVendor.plant : (req.user.plants && req.user.plants.length > 0 ? req.user.plants[0] : null);
    const targetPlant = req.body.plant !== undefined ? req.body.plant : userPlant;

    if (req.user.role !== 'ADMIN' && req.user.plants && req.user.plants.length > 0) {
      if (targetPlant && !req.user.plants.includes(targetPlant)) {
        return res.status(403).json({ message: 'You are not authorized to create change requests for this plant.' });
      }
    }

    // Handle files & run OCR validation if enabled
    const geminiConfig = getGeminiConfig(req.tenant);
    const isOcrEnabled = (geminiConfig && geminiConfig.enableOcrValidation) || process.env.GEMINI_API_KEY;

    const vendorDataForOcr = {
      taxDetails: parsedProposedChanges?.taxDetails || {},
      bankDetails: parsedProposedChanges?.bankDetails || [],
      generalData: {
        vendorName: originalVendor?.generalData?.vendorName || ''
      }
    };

    const newDocs = [];
    if (req.files && req.files.length > 0) {
      for (const f of req.files) {
        const docType = f.fieldname || 'OTHER';
        const doc = {
          docType,
          fileName: f.originalname,
          storedName: f.filename,
          filePath: `uploads/${req.tenantId}/${f.filename}`,
          fileSize: f.size,
          mimeType: f.mimetype,
          uploadedBy: req.user._id,
        };

        if (isOcrEnabled && ['GST_CERTIFICATE', 'PAN_CARD', 'CANCELLED_CHEQUE'].includes(docType)) {
          try {
            const ocrService = require('../utils/ocrService');
            const fullPath = path.join(__dirname, '..', doc.filePath);
            const ocrResult = await ocrService.validateDocument(fullPath, doc.docType, doc.mimeType, vendorDataForOcr, geminiConfig, req.tenantId);
            if (ocrResult) {
              doc.ocrResult = ocrResult;
            }
          } catch (ocrErr) {
            console.error('[OCR CR DRAFT ERROR] Failed processing doc:', ocrErr);
          }
        }
        newDocs.push(doc);
      }
    }

    const request = await VendorChangeRequest.create({
      sapVendorNumber,
      tenantId: req.tenantId,
      plant: targetPlant,
      proposedChanges: parsedProposedChanges,
      documents: newDocs,
      status: 'DRAFT',
      createdBy: req.user._id,
      createdByName: req.user.fullName,
    });

    await AuditLog.log({
      tenantId: req.tenantId,
      action: 'CR_DRAFT_SAVED',
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      performedByRole: req.user.role,
    });

    res.status(201).json({ message: 'Draft saved', request });
  } catch (err) { next(err); }
});

// ── PUT /api/change-requests/:id ──────────────────────────────────────
// Update a draft or sent back request
router.put('/:id', requireLogin, injectTenant, upload.array('files'), async (req, res, next) => {
  try {
    const request = await VendorChangeRequest.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (!request) return res.status(404).json({ message: 'Request not found' });

    if (!['DRAFT', 'SENT_BACK'].includes(request.status) && req.user.role !== 'ADMIN') {
      return res.status(403).json({ message: 'You are not authorized to edit this request in its current status.' });
    }

    const { proposedChanges, plant } = req.body;
    if (req.user.role !== 'ADMIN' && req.user.plants && req.user.plants.length > 0) {
      if (request.plant && !req.user.plants.includes(request.plant)) {
        return res.status(403).json({ message: 'You are not authorized to update change requests for this plant.' });
      }
      if (plant && !req.user.plants.includes(plant)) {
        return res.status(403).json({ message: 'You are not authorized to set this change request to this plant.' });
      }
    }

    if (proposedChanges) {
      request.proposedChanges = typeof proposedChanges === 'string' ? JSON.parse(proposedChanges) : proposedChanges;
      request.markModified('proposedChanges');
    }
    if (plant !== undefined) {
      request.plant = plant;
    }

    // Append new files & run OCR validation if enabled
    const geminiConfig = getGeminiConfig(req.tenant);
    const isOcrEnabled = (geminiConfig && geminiConfig.enableOcrValidation) || process.env.GEMINI_API_KEY;

    const originalVendor = await VendorRequest.findOne({ sapVendorNumber: request.sapVendorNumber, tenantId: req.tenantId });
    const vendorDataForOcr = {
      taxDetails: request.proposedChanges?.taxDetails || {},
      bankDetails: request.proposedChanges?.bankDetails || [],
      generalData: {
        vendorName: originalVendor?.generalData?.vendorName || ''
      }
    };

    if (req.files && req.files.length > 0) {
      for (const f of req.files) {
        const docType = f.fieldname || 'OTHER';
        const doc = {
          docType,
          fileName: f.originalname,
          storedName: f.filename,
          filePath: `uploads/${req.tenantId}/${f.filename}`,
          fileSize: f.size,
          mimeType: f.mimetype,
          uploadedBy: req.user._id,
        };

        if (isOcrEnabled && ['GST_CERTIFICATE', 'PAN_CARD', 'CANCELLED_CHEQUE'].includes(docType)) {
          try {
            const ocrService = require('../utils/ocrService');
            const fullPath = path.join(__dirname, '..', doc.filePath);
            const ocrResult = await ocrService.validateDocument(fullPath, doc.docType, doc.mimeType, vendorDataForOcr, geminiConfig, req.tenantId);
            if (ocrResult) {
              doc.ocrResult = ocrResult;
            }
          } catch (ocrErr) {
            console.error('[OCR CR UPDATE ERROR] Failed processing doc:', ocrErr);
          }
        }
        request.documents.push(doc);
      }
    }

    await request.save();
    res.json({ message: 'Request updated', request });
  } catch (err) { next(err); }
});

// ── POST /api/change-requests/:id/submit ──────────────────────────────
// Submit for approval
router.post('/:id/submit', requireLogin, async (req, res, next) => {
  try {
    const request = await VendorChangeRequest.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (!request) return res.status(404).json({ message: 'Request not found' });
    if (!['DRAFT', 'SENT_BACK'].includes(request.status)) {
      return res.status(400).json({ message: `Cannot submit a request with status: ${request.status}` });
    }

    // Validate proposedChanges details
    const proposed = request.proposedChanges || {};
    const hasAddressChange = proposed.addressDetails && (proposed.addressDetails.street || proposed.addressDetails.city || proposed.addressDetails.state || proposed.addressDetails.postalCode);
    if (!proposed.bankDetails?.length && !proposed.taxDetails?.gstin && !proposed.taxDetails?.msmeStatus && !hasAddressChange) {
      return res.status(400).json({ message: 'At least one change (Bank details, GSTIN, MSME Status, or Address details) must be requested' });
    }

    // Check mandatory document uploads for proposed changes
    const uploadedTypes = (request.documents || []).map(d => d.docType);
    if (proposed.bankDetails?.length && proposed.bankDetails.some(b => b.accountNumber) && !uploadedTypes.includes('CANCELLED_CHEQUE') && !uploadedTypes.includes('BANK_LETTER')) {
      return res.status(400).json({ message: 'Cancelled Cheque or Bank Letter document upload is required for Bank details changes' });
    }
    if (proposed.taxDetails?.gstin && !uploadedTypes.includes('GST_CERTIFICATE')) {
      return res.status(400).json({ message: 'GST Certificate document upload is required for GSTIN changes' });
    }
    if ((proposed.taxDetails?.msmeStatus || proposed.taxDetails?.msmeNumber) && !uploadedTypes.includes('MSME_CERTIFICATE')) {
      return res.status(400).json({ message: 'MSME Certificate document upload is required for MSME changes' });
    }
    if (hasAddressChange && !uploadedTypes.includes('ADDRESS_PROOF')) {
      return res.status(400).json({ message: 'Address Proof document upload is required for Address changes' });
    }

    // Ensure plant is resolved if not already set
    if (!request.plant) {
      const originalVendor = await VendorRequest.findOne({ sapVendorNumber: request.sapVendorNumber, tenantId: req.tenantId });
      if (originalVendor) {
        request.plant = originalVendor.plant;
      }
    }

    if (req.user.role !== 'ADMIN' && req.user.plants && req.user.plants.length > 0) {
      if (request.plant && !req.user.plants.includes(request.plant)) {
        return res.status(403).json({ message: 'You are not authorized to submit change requests for this plant.' });
      }
    }

    // Load approval settings
    let settings = await ApprovalSettings.findOne({ tenantId: req.tenantId, plant: request.plant });
    if (!settings) {
      settings = await ApprovalSettings.findOne({ tenantId: req.tenantId, plant: 'DEFAULT' });
    }
    const steps = settings?.steps?.length ? settings.steps : ApprovalSettings.getDefaultSteps();

    request.status = 'PENDING_APPROVAL';
    request.currentStepIndex = 0;
    request.currentLevel = steps[0].role;
    request.submittedAt = new Date();
    await request.save();

    await AuditLog.log({
      tenantId: req.tenantId,
      action: 'CR_SUBMITTED',
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      performedByRole: req.user.role,
    });

    // Notify stage 1 approvers
    const notifyRole = steps[0].role;
    const queryNextUsers = { tenantId: req.tenantId, role: notifyRole, isActive: true };
    if (request.plant) {
      queryNextUsers.plants = request.plant;
    }
    const nextRoleUsers = await User.find(queryNextUsers).select('email');
    nextRoleUsers.forEach(u => sendEmail({ to: u.email, templateName: 'SUBMITTED', templateData: { request }, replyTo: req.user.email }));

    res.json({ message: 'Request submitted for approval', request });
  } catch (err) { next(err); }
});

// ── POST /api/change-requests/:id/approve ─────────────────────────────
// Approve change request
router.post('/:id/approve', requireLogin, requireRole('L1_APPROVER', 'L2_APPROVER', 'MASTER_DATA', 'ADMIN'), injectTenant, async (req, res, next) => {
  try {
    const request = await VendorChangeRequest.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (!request) return res.status(404).json({ message: 'Request not found' });

    if (req.user.role !== 'ADMIN' && req.user.plants && req.user.plants.length > 0) {
      if (request.plant && !req.user.plants.includes(request.plant)) {
        return res.status(403).json({ message: 'You are not authorized to perform actions on requests for this plant.' });
      }
    }

    const { comments = '' } = req.body;

    let settings = await ApprovalSettings.findOne({ tenantId: req.tenantId, plant: request.plant });
    if (!settings) {
      settings = await ApprovalSettings.findOne({ tenantId: req.tenantId, plant: 'DEFAULT' });
    }
    const steps = settings?.steps?.length ? settings.steps : ApprovalSettings.getDefaultSteps();

    const currentStep = steps[request.currentStepIndex];
    if (req.user.role !== 'ADMIN' && req.user.role !== currentStep.role) {
      return res.status(403).json({ message: 'You are not the designated approver for the current step' });
    }

    // Append to approval chain
    request.approvalChain.push({
      level: currentStep.role,
      action: 'APPROVED',
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      comments
    });

    // Advance flow
    const nextIndex = request.currentStepIndex + 1;
    if (nextIndex < steps.length) {
      // Move to next step
      request.currentStepIndex = nextIndex;
      request.currentLevel = steps[nextIndex].role;
      await request.save();

      // Notify next approvers
      const queryNextUsers = { tenantId: req.tenantId, role: steps[nextIndex].role, isActive: true };
      if (request.plant) {
        queryNextUsers.plants = request.plant;
      }
      const nextRoleUsers = await User.find(queryNextUsers).select('email');
      nextRoleUsers.forEach(u => sendEmail({ to: u.email, templateName: 'PENDING_APPROVAL', templateData: { request }, replyTo: req.user.email }));

      return res.json({ message: 'Request approved and forwarded to next step', request });
    }

    // All approval steps completed. Push to SAP
    request.status = 'SAP_PENDING';
    await request.save();

    const sapConfig = getSapConfig(req.tenant);
    try {
      const sapRes = await pushVendorChangeRequest(request.sapVendorNumber, request.proposedChanges, sapConfig);
      request.status = 'SAP_UPDATED';
      request.completedAt = new Date();
      request.sapResult = {
        pushedAt: new Date(),
        pushedBy: req.user._id,
        requestPayload: request.proposedChanges,
        responsePayload: sapRes.response || sapRes,
      };
      await request.save();

      await AuditLog.log({
        tenantId: req.tenantId,
        action: 'CR_SAP_UPDATED',
        performedBy: req.user._id,
        performedByName: req.user.fullName,
        performedByRole: req.user.role,
      });

      res.json({ message: 'Request fully approved and synced with SAP successfully', request });
    } catch (sapErr) {
      console.error(`[SAP PUSH ERR] Change request push failed: ${sapErr.message}`);
      request.status = 'SAP_FAILED';
      request.sapResult = {
        pushedAt: new Date(),
        pushedBy: req.user._id,
        errorMessage: sapErr.message,
      };
      await request.save();

      await AuditLog.log({
        tenantId: req.tenantId,
        action: 'CR_SAP_FAILED',
        performedBy: req.user._id,
        performedByName: req.user.fullName,
        performedByRole: req.user.role,
        comments: sapErr.message,
      });

      res.status(502).json({ message: `Approved, but SAP update failed: ${sapErr.message}`, request });
    }
  } catch (err) { next(err); }
});

// ── POST /api/change-requests/:id/reject ─────────────────────────────
// Reject change request
router.post('/:id/reject', requireLogin, requireRole('L1_APPROVER', 'L2_APPROVER', 'MASTER_DATA', 'ADMIN'), async (req, res, next) => {
  try {
    const request = await VendorChangeRequest.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (!request) return res.status(404).json({ message: 'Request not found' });

    if (req.user.role !== 'ADMIN' && req.user.plants && req.user.plants.length > 0) {
      if (request.plant && !req.user.plants.includes(request.plant)) {
        return res.status(403).json({ message: 'You are not authorized to perform actions on requests for this plant.' });
      }
    }

    const { comments = '' } = req.body;
    request.status = 'REJECTED';
    request.completedAt = new Date();
    request.approvalChain.push({
      level: req.user.role,
      action: 'REJECTED',
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      comments
    });
    await request.save();

    await AuditLog.log({
      tenantId: req.tenantId,
      action: 'CR_REJECTED',
      performedBy: req.user._id,
      performedByName: req.user.fullName,
    });

    res.json({ message: 'Request rejected', request });
  } catch (err) { next(err); }
});

module.exports = router;

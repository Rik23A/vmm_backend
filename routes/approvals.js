const router = require('express').Router();
const VendorRequest = require('../models/VendorRequest');
const AuditLog = require('../models/AuditLog');
const User = require('../models/User');
const Tenant = require('../models/Tenant');
const { requireLogin, requireRole } = require('../middleware/auth');
const { injectTenant, getSapConfig } = require('../middleware/tenant');
const { sendEmail } = require('../utils/email');
const { pushVendor, patchVendorInSAP } = require('../utils/sapBridge');
const { validateVendorSubmission } = require('../utils/validators');

// ── Role → Status mapping ───────────────────────────────────────────
// What status does each role see in their pending queue?
const ROLE_PENDING_STATUS = {
  L1_APPROVER: 'PENDING_L1',
  L2_APPROVER: 'PENDING_L2',
  MASTER_DATA: 'PENDING_MDT',
};
// What status does each role move the request to when they APPROVE?
const ROLE_NEXT_STATUS = {
  L1_APPROVER: 'PENDING_L2',
  L2_APPROVER: 'PENDING_MDT',
  MASTER_DATA: 'SAP_PENDING',  // MDT approval triggers SAP push queue
};
const ROLE_NEXT_LEVEL = {
  L1_APPROVER: 'L2',
  L2_APPROVER: 'MDT',
  MASTER_DATA: 'SAP',
};
const ROLE_AUDIT_ACTION = {
  approve: { L1_APPROVER: 'L1_APPROVED', L2_APPROVER: 'L2_APPROVED', MASTER_DATA: 'MDT_APPROVED' },
  reject:  { L1_APPROVER: 'L1_REJECTED', L2_APPROVER: 'L2_REJECTED', MASTER_DATA: 'MDT_REJECTED' },
  sendback:{ L1_APPROVER: 'L1_SENT_BACK', L2_APPROVER: 'L2_SENT_BACK', MASTER_DATA: 'MDT_SENT_BACK' },
};

// ── GET /api/approvals/pending ─────────────────────────────────────────
// Returns the pending queue for the logged-in approver's role
// ADMIN can see all
router.get('/pending', requireLogin,
  requireRole('L1_APPROVER', 'L2_APPROVER', 'MASTER_DATA', 'ADMIN'),
  async (req, res, next) => {
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
        andConditions.push({
          $or: [
            { 'generalData.vendorName': { $regex: search, $options: 'i' } },
            { tempVendorNumber: { $regex: search, $options: 'i' } },
          ]
        });
      }

      if (andConditions.length > 0) {
        query.$and = andConditions;
      }

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const [requests, total] = await Promise.all([
        VendorRequest.find(query)
          .select('tempVendorNumber sapVendorNumber generalData.vendorName requestType status createdByName submittedAt updatedAt currentLevel duplicateCheck')
          .sort({ submittedAt: 1 }) // Oldest first (FIFO)
          .skip(skip)
          .limit(parseInt(limit)),
        VendorRequest.countDocuments(query),
      ]);

      res.json({ requests, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
    } catch (err) { next(err); }
  }
);

// ── POST /api/approvals/:id/approve ────────────────────────────────────
router.post('/:id/approve', requireLogin,
  requireRole('L1_APPROVER', 'L2_APPROVER', 'MASTER_DATA', 'ADMIN'),
  async (req, res, next) => {
    try {
      const vendor = await VendorRequest.findOne({ _id: req.params.id, tenantId: req.tenantId });
      if (!vendor) return res.status(404).json({ message: 'Request not found' });

      if (req.user.role !== 'ADMIN' && req.user.plants && req.user.plants.length > 0) {
        if (vendor.plant && !req.user.plants.includes(vendor.plant)) {
          return res.status(403).json({ message: 'You are not authorized to perform actions on requests for this plant.' });
        }
      }

      const { comments = '', bpGrouping, legalForm } = req.body;
      if (bpGrouping || legalForm) {
        vendor.generalData = vendor.generalData || {};
        if (bpGrouping) vendor.generalData.bpGrouping = bpGrouping;
        if (legalForm) vendor.generalData.legalForm = legalForm;
        vendor.markModified('generalData');
      }

      // Validate required fields (Company Code & Reconciliation Account strictly checked for MDT/Admin)
      const isMdtOrAdmin = ['MASTER_DATA', 'ADMIN'].includes(req.user.role) || vendor.currentLevel === 'MASTER_DATA';
      const validationErrors = validateVendorSubmission(vendor, isMdtOrAdmin);
      if (validationErrors.length > 0) {
        console.warn(`⚠️ [APPROVAL VALIDATION FAILED] Vendor ${vendor.tempVendorNumber || vendor._id}:`, JSON.stringify(validationErrors, null, 2));
        return res.status(400).json({
          message: 'Approval rejected due to missing details. Please check required fields.',
          errors: validationErrors
        });
      }

      // Handle Dynamic Approval Workflow
      if (vendor.status === 'PENDING_APPROVAL') {
        if (req.user.role !== 'ADMIN' && vendor.currentLevel !== req.user.role) {
          return res.status(400).json({ message: `Only ${vendor.currentLevel} users can approve this stage. You are logged in as ${req.user.role}.` });
        }

        const ApprovalSettings = require('../models/ApprovalSettings');
        let settings = await ApprovalSettings.findOne({ tenantId: req.tenantId, plant: vendor.plant });
        if (!settings) {
          settings = await ApprovalSettings.findOne({ tenantId: req.tenantId, plant: 'DEFAULT' });
        }
        const steps = settings?.steps?.length ? settings.steps : ApprovalSettings.getDefaultSteps();

        const currentStep = steps[vendor.currentStepIndex];
        const stepLabel = currentStep ? currentStep.levelLabel : vendor.currentLevel;

        // Add to approval chain
        vendor.approvalChain.push({
          level: stepLabel,
          action: 'APPROVED',
          performedBy: req.user._id,
          performedByName: req.user.fullName,
          comments,
        });

        // Advance step
        const nextStepIndex = vendor.currentStepIndex + 1;
        if (nextStepIndex < steps.length) {
          vendor.currentStepIndex = nextStepIndex;
          vendor.status = 'PENDING_APPROVAL';
          vendor.currentLevel = steps[nextStepIndex].role;

          await vendor.save();

          // Notify next approvers
          const queryNextUsers = { tenantId: req.tenantId, role: steps[nextStepIndex].role, isActive: true };
          if (vendor.plant) {
            queryNextUsers.plants = vendor.plant;
          }
          const nextRoleUsers = await User.find(queryNextUsers).select('email');
          nextRoleUsers.forEach(u => sendEmail({ to: u.email, templateName: 'SUBMITTED', templateData: { request: vendor }, replyTo: req.user.email }));

          return res.json({ message: `Request approved and moved to ${steps[nextStepIndex].levelLabel}`, vendor });
        } else {
          // Complete dynamic approvals
          vendor.status = 'SAP_PENDING';
          vendor.currentLevel = 'SAP';
          await vendor.save();

          // Notify Master Data Team
          const queryMdtUsers = { tenantId: req.tenantId, role: 'MASTER_DATA', isActive: true };
          if (vendor.plant) {
            queryMdtUsers.plants = vendor.plant;
          }
          const nextRoleUsers = await User.find(queryMdtUsers).select('email');
          nextRoleUsers.forEach(u => sendEmail({ to: u.email, templateName: 'SUBMITTED', templateData: { request: vendor }, replyTo: req.user.email }));

          return res.json({ message: 'Request approved and ready for SAP push', vendor });
        }
      }

      // Static fallback for legacy requests
      const expectedStatus = ROLE_PENDING_STATUS[req.user.role];
      if (req.user.role !== 'ADMIN' && vendor.status !== expectedStatus) {
        return res.status(400).json({ message: `Your role can only approve ${expectedStatus} requests. This request is: ${vendor.status}` });
      }

      const roleLevel = req.user.role === 'ADMIN' ? vendor.currentLevel : ROLE_NEXT_LEVEL[req.user.role];
      const level = (roleLevel || 'L1').replace('PENDING_', '').replace('_APPROVER', '');

      // ── Add to approval chain
      vendor.approvalChain.push({
        level: level,
        action: 'APPROVED',
        performedBy: req.user._id,
        performedByName: req.user.fullName,
        comments,
      });

      // ── Advance status
      let nextStatus, nextLevel;
      if (req.user.role === 'ADMIN') {
        // Admin advances based on CURRENT status
        const adminNext = {
          PENDING_L1: { status: 'PENDING_L2', level: 'L2' },
          PENDING_L2: { status: 'PENDING_MDT', level: 'MDT' },
          PENDING_MDT: { status: 'SAP_PENDING', level: 'SAP' },
          SAP_FAILED: { status: 'SAP_PENDING', level: 'SAP' },
        }[vendor.status];
        nextStatus = adminNext?.status || vendor.status;
        nextLevel = adminNext?.level || vendor.currentLevel;
      } else {
        nextStatus = ROLE_NEXT_STATUS[req.user.role];
        nextLevel = ROLE_NEXT_LEVEL[req.user.role];
      }

      vendor.status = nextStatus;
      vendor.currentLevel = nextLevel;
      await vendor.save();

      const auditAction = ROLE_AUDIT_ACTION.approve[req.user.role] || 'MDT_APPROVED';
      await AuditLog.log({ tenantId: req.tenantId, requestId: vendor._id,
        tempVendorNumber: vendor.tempVendorNumber, action: auditAction,
        performedBy: req.user._id, performedByName: req.user.fullName, performedByRole: req.user.role,
        comments,
      });

      // ── Notify next level approvers
      const notifyLevel = nextStatus.replace('PENDING_', '');
      let nextRoleUsers = [];
      const queryNextUsers = { tenantId: req.tenantId, isActive: true };
      if (vendor.plant) {
        queryNextUsers.plants = vendor.plant;
      }
      if (nextStatus === 'PENDING_L2') {
        queryNextUsers.role = 'L2_APPROVER';
        nextRoleUsers = await User.find(queryNextUsers).select('email');
      }
      if (nextStatus === 'PENDING_MDT') {
        queryNextUsers.role = 'MASTER_DATA';
        nextRoleUsers = await User.find(queryNextUsers).select('email');
      }
      if (nextStatus === 'SAP_PENDING') {
        queryNextUsers.role = 'MASTER_DATA';
        nextRoleUsers = await User.find(queryNextUsers).select('email');
      }
      nextRoleUsers.forEach(u => sendEmail({ to: u.email, templateName: 'SUBMITTED', templateData: { request: vendor }, replyTo: req.user.email }));

      res.json({ message: `Request approved and moved to ${nextStatus}`, vendor });
    } catch (err) { next(err); }
  }
);

// ── POST /api/approvals/:id/reject ─────────────────────────────────────
router.post('/:id/reject', requireLogin,
  requireRole('L1_APPROVER', 'L2_APPROVER', 'MASTER_DATA', 'ADMIN'),
  async (req, res, next) => {
    try {
      const vendor = await VendorRequest.findOne({ _id: req.params.id, tenantId: req.tenantId });
      if (!vendor) return res.status(404).json({ message: 'Request not found' });

      if (req.user.role !== 'ADMIN' && req.user.plants && req.user.plants.length > 0) {
        if (vendor.plant && !req.user.plants.includes(vendor.plant)) {
          return res.status(403).json({ message: 'You are not authorized to perform actions on requests for this plant.' });
        }
      }

      const { comments } = req.body;
      if (!comments?.trim()) return res.status(400).json({ message: 'Rejection reason (comments) is required' });

      vendor.approvalChain.push({
        level: vendor.currentLevel || 'L1',
        action: 'REJECTED',
        performedBy: req.user._id,
        performedByName: req.user.fullName,
        comments,
      });
      vendor.status = 'REJECTED';
      vendor.currentLevel = 'DONE';
      vendor.currentStepIndex = 0;
      await vendor.save();

      const auditAction = ROLE_AUDIT_ACTION.reject[req.user.role] || 'L1_REJECTED';
      await AuditLog.log({ tenantId: req.tenantId, requestId: vendor._id,
        tempVendorNumber: vendor.tempVendorNumber, action: auditAction,
        performedBy: req.user._id, performedByName: req.user.fullName, performedByRole: req.user.role,
        comments,
      });

      // Notify requestor
      const requestor = await User.findById(vendor.createdBy).select('email');
      if (requestor) sendEmail({ to: requestor.email, templateName: 'REJECTED', templateData: { request: vendor, extra: comments }, replyTo: req.user.email });

      res.json({ message: 'Request rejected', vendor });
    } catch (err) { next(err); }
  }
);

// ── POST /api/approvals/:id/sendback ───────────────────────────────────
router.post('/:id/sendback', requireLogin,
  requireRole('L1_APPROVER', 'L2_APPROVER', 'MASTER_DATA', 'ADMIN'),
  async (req, res, next) => {
    try {
      const vendor = await VendorRequest.findOne({ _id: req.params.id, tenantId: req.tenantId });
      if (!vendor) return res.status(404).json({ message: 'Request not found' });

      if (req.user.role !== 'ADMIN' && req.user.plants && req.user.plants.length > 0) {
        if (vendor.plant && !req.user.plants.includes(vendor.plant)) {
          return res.status(403).json({ message: 'You are not authorized to perform actions on requests for this plant.' });
        }
      }

      const { comments } = req.body;
      if (!comments?.trim()) return res.status(400).json({ message: 'Send-back reason (comments) is required' });

      const ApprovalSettings = require('../models/ApprovalSettings');
      let settings = await ApprovalSettings.findOne({ tenantId: req.tenantId, plant: vendor.plant });
      if (!settings) {
        settings = await ApprovalSettings.findOne({ tenantId: req.tenantId, plant: 'DEFAULT' });
      }
      const steps = settings?.steps?.length ? settings.steps : ApprovalSettings.getDefaultSteps();

      // Find previous approver who approved the prior step, or fallback to original requestor
      const lastApproval = [...(vendor.approvalChain || [])].reverse().find(a => a.action === 'APPROVED');
      const recipientUserId = (lastApproval && lastApproval.performedBy) ? lastApproval.performedBy : vendor.createdBy;

      vendor.approvalChain.push({
        level: vendor.currentLevel || 'L1',
        action: 'SENT_BACK',
        performedBy: req.user._id,
        performedByName: req.user.fullName,
        comments,
      });
      vendor.status = 'SENT_BACK';
      vendor.currentLevel = null;
      vendor.currentStepIndex = 0;
      await vendor.save();

      const auditAction = ROLE_AUDIT_ACTION.sendback[req.user.role] || 'L1_SENT_BACK';
      await AuditLog.log({ tenantId: req.tenantId, requestId: vendor._id,
        tempVendorNumber: vendor.tempVendorNumber, action: auditAction,
        performedBy: req.user._id, performedByName: req.user.fullName, performedByRole: req.user.role,
        comments,
      });

      // Send email to the designated previous approver (or original requestor)
      if (recipientUserId) {
        const recipientUser = await User.findById(recipientUserId).select('email');
        if (recipientUser && recipientUser.email) {
          sendEmail({
            to: recipientUser.email,
            templateName: 'SENT_BACK',
            templateData: { request: vendor, extra: comments },
            replyTo: req.user.email,
            tenantId: req.tenantId
          });
        }
      }

      res.json({ message: 'Request sent back for revision', vendor });
    } catch (err) { next(err); }
  }
);

// ── POST /api/approvals/:id/sap-push ──────────────────────────────────
// Only MASTER_DATA and ADMIN can trigger SAP push
// This replaces tempVendorNumber with real SAP vendor number
router.post('/:id/sap-push', requireLogin, requireRole('MASTER_DATA', 'ADMIN'),
  injectTenant, async (req, res, next) => {
    try {
      const vendor = await VendorRequest.findOne({ _id: req.params.id, tenantId: req.tenantId });
      if (!vendor) return res.status(404).json({ message: 'Request not found' });

      if (!['SAP_PENDING', 'SAP_FAILED'].includes(vendor.status)) {
        return res.status(400).json({ message: `SAP push not available for status: ${vendor.status}. Must be SAP_PENDING or SAP_FAILED.` });
      }

      // ── Get SAP config for this tenant
      const sapConfig = getSapConfig(req.tenant);

      // ── Mark as in-progress
      vendor.status = 'SAP_PENDING';
      vendor.sapResult.retryCount = (vendor.sapResult.retryCount || 0) + (vendor.status === 'SAP_FAILED' ? 1 : 0);
      await vendor.save();

      await AuditLog.log({ tenantId: req.tenantId, requestId: vendor._id,
        tempVendorNumber: vendor.tempVendorNumber, action: 'SAP_PUSH_TRIGGERED',
        performedBy: req.user._id, performedByName: req.user.fullName,
        sapPayload: { sapVersion: sapConfig.sapVersion },
      });

      try {
        // ── Call SAP Bridge
        let result;
        if (vendor.requestType === 'MODIFY') {
          result = await patchVendorInSAP(vendor.sapVendorNumber, vendor.toObject(), null, sapConfig);
          result.vendorNumber = vendor.sapVendorNumber;
          result.payload = result.payload || vendor.toObject();
          result.response = result.response || { status: 'PATCHED' };
        } else {
          result = await pushVendor(vendor.toObject(), sapConfig);
        }

        // ── SUCCESS: Store real SAP vendor number — this replaces the temp number for all future work
        vendor.sapVendorNumber = result.vendorNumber;
        vendor.status = 'SAP_PUSHED';
        vendor.currentLevel = 'DONE';
        vendor.sapResult = {
          vendorNumber: result.vendorNumber,
          pushedAt: new Date(),
          pushedBy: req.user._id,
          sapVersion: sapConfig.sapVersion,
          requestPayload: result.payload,
          responsePayload: result.response,
          errorMessage: null,
        };
        await vendor.save();

        // Map the generated SAP Vendor Number to the vendor's user account
        if (vendor.createdBy) {
          const creatorUser = await User.findById(vendor.createdBy);
          if (creatorUser && creatorUser.sapVendorNumber) {
            await User.findByIdAndUpdate(vendor.createdBy, { sapVendorNumber: result.vendorNumber });
          }
        }

        await AuditLog.log({ tenantId: req.tenantId, requestId: vendor._id,
          tempVendorNumber: vendor.tempVendorNumber, sapVendorNumber: result.vendorNumber,
          action: 'SAP_PUSH_SUCCESS',
          performedBy: req.user._id, performedByName: req.user.fullName,
          sapPayload: result.payload, sapResponse: result.response,
        });

        // ── Notify requestor and MDT team for this vendor request only
        const queryMdtUsers = {
          tenantId: req.tenantId, role: 'MASTER_DATA', isActive: true,
        };
        if (vendor.plant) {
          queryMdtUsers.plants = vendor.plant;
        }
        const mdtUsers = await User.find(queryMdtUsers).select('email');
        const requestor = vendor.createdBy ? await User.findById(vendor.createdBy).select('email') : null;

        const recipientEmails = new Set();
        mdtUsers.forEach(u => { if (u.email) recipientEmails.add(u.email); });
        if (requestor && requestor.email) recipientEmails.add(requestor.email);

        recipientEmails.forEach(email =>
          sendEmail({ to: email, templateName: 'SAP_PUSHED', templateData: { request: vendor }, replyTo: req.user.email })
        );

        res.json({
          message: 'Vendor successfully created in SAP',
          tempVendorNumber: vendor.tempVendorNumber,
          sapVendorNumber: result.vendorNumber, // ← The real permanent SAP number
          vendor,
        });

      } catch (sapError) {
        // ── SAP FAILED: Record error, capture partial BP number if generated, allow manual link or retry
        vendor.status = 'SAP_FAILED';
        vendor.sapResult.errorMessage = sapError.message;

        // Catch BP / Vendor number from sapError object or error text if partially created in SAP
        const bpMatch = sapError.message && sapError.message.match(/\b(1\d{7,9}|2\d{7,9}|3\d{7,9}|10\d{5,7})\b/);
        const capturedBp = sapError.bpNumber || sapError.vendorNumber || (bpMatch ? bpMatch[1] : null);
        if (capturedBp) {
          vendor.sapVendorNumber = capturedBp; // Automatically attach generated SAP BP Number to vendor record
          vendor.sapResult.vendorNumber = capturedBp;
          vendor.sapResult.partialVendorNumber = capturedBp;
          console.log(`📌 [SAP PUSH CATCH] Captured & attached SAP BP Number '${capturedBp}' to vendor record in VMM DB.`);
        }

        await vendor.save();

        await AuditLog.log({ tenantId: req.tenantId, requestId: vendor._id,
          tempVendorNumber: vendor.tempVendorNumber, action: 'SAP_PUSH_FAILED',
          performedBy: req.user._id, performedByName: req.user.fullName,
          comments: sapError.message,
          sapPayload: { capturedBp: capturedBp || null }
        });

        const queryMdtUsers = { tenantId: req.tenantId, role: 'MASTER_DATA', isActive: true };
        if (vendor.plant) {
          queryMdtUsers.plants = vendor.plant;
        }
        const mdtUsers = await User.find(queryMdtUsers).select('email');
        mdtUsers.forEach(u => sendEmail({
          to: u.email,
          templateName: 'SAP_FAILED',
          templateData: { request: vendor, extra: sapError.message },
          replyTo: req.user.email
        }));

        res.status(502).json({
          message: 'SAP push failed',
          error: sapError.message,
          partialVendorNumber: capturedBp || null,
          vendor
        });
      }
    } catch (err) { next(err); }
  }
);

// ── POST /api/approvals/:id/manual-sap-sync ──────────────────────────────
// Manually link an existing or partially created SAP BP / Vendor number
router.post('/:id/manual-sap-sync', requireLogin, requireRole('MASTER_DATA', 'ADMIN'),
  injectTenant, async (req, res, next) => {
    try {
      const { sapVendorNumber, comments = '' } = req.body;
      if (!sapVendorNumber || !sapVendorNumber.trim()) {
        return res.status(400).json({ message: 'SAP Vendor / BP Number is required for manual linking.' });
      }

      const vendor = await VendorRequest.findOne({ _id: req.params.id, tenantId: req.tenantId });
      if (!vendor) return res.status(404).json({ message: 'Request not found' });

      const cleanBpNumber = sapVendorNumber.trim();
      vendor.sapVendorNumber = cleanBpNumber;
      vendor.status = 'SAP_PUSHED';
      vendor.currentLevel = 'DONE';
      vendor.sapResult = {
        vendorNumber: cleanBpNumber,
        pushedAt: new Date(),
        pushedBy: req.user._id,
        sapVersion: req.tenant?.sapConfig?.sapVersion || 'MANUAL',
        requestPayload: { manualSync: true, comments },
        responsePayload: { status: 'MANUALLY_LINKED', comments },
        errorMessage: null,
      };
      await vendor.save();

      if (vendor.createdBy) {
        const creatorUser = await User.findById(vendor.createdBy);
        if (creatorUser && creatorUser.sapVendorNumber) {
          await User.findByIdAndUpdate(vendor.createdBy, { sapVendorNumber: cleanBpNumber });
        }
      }

      await AuditLog.log({ tenantId: req.tenantId, requestId: vendor._id,
        tempVendorNumber: vendor.tempVendorNumber, sapVendorNumber: cleanBpNumber,
        action: 'SAP_MANUAL_LINK_SUCCESS',
        performedBy: req.user._id, performedByName: req.user.fullName,
        comments: `Manually linked to SAP BP/Vendor number: ${cleanBpNumber}. ${comments}`,
      });

      // Send SAP_PUSHED emails to MDT and requestor
      const queryMdtUsers = { tenantId: req.tenantId, role: 'MASTER_DATA', isActive: true };
      if (vendor.plant) queryMdtUsers.plants = vendor.plant;
      const mdtUsers = await User.find(queryMdtUsers).select('email');
      const requestor = vendor.createdBy ? await User.findById(vendor.createdBy).select('email') : null;

      const recipientEmails = new Set();
      mdtUsers.forEach(u => { if (u.email) recipientEmails.add(u.email); });
      if (requestor && requestor.email) recipientEmails.add(requestor.email);

      recipientEmails.forEach(email =>
        sendEmail({ to: email, templateName: 'SAP_PUSHED', templateData: { request: vendor }, replyTo: req.user.email })
      );

      res.json({
        message: `Successfully linked vendor to SAP BP Number: ${cleanBpNumber}`,
        sapVendorNumber: cleanBpNumber,
        vendor,
      });
    } catch (err) { next(err); }
  }
);

module.exports = router;

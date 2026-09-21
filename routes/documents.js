'use strict';

const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const { requireLogin } = require('../middleware/auth');
const { getSafeAbsolutePath, UPLOADS_DIR } = require('../config/storage');
const VendorRequest = require('../models/VendorRequest');
const VendorChangeRequest = require('../models/VendorChangeRequest');
const { getMimeType, getContentDisposition } = require('../utils/mimeHelper');

/**
 * ── GET /uploads/:tenantId/:filename ──────────────────────────────────────────
 * Secure Document Serving Endpoint (Replaces public express.static)
 *
 * Security Protections:
 * 1. Authentication Required: Valid JWT token (via Bearer header or ?token= query parameter).
 * 2. Tenant Isolation: Strictly prevents users from accessing files of other tenants.
 * 3. Path Traversal Defense: Sanitizes tenantId and filename, checks resolved path bounds.
 * 4. RBAC & Ownership: Requestors can only access their own documents; approvers check plant scope.
 * 5. Security Headers: nosniff, CSP default-src none, proper MIME type and Content-Disposition.
 */
router.get('/:tenantId/:filename', requireLogin, async (req, res, next) => {
  try {
    const { tenantId, filename } = req.params;

    // ── 1. Parameter Validation & Path Traversal Guard ───────────────────────
    if (!/^[a-zA-Z0-9_-]+$/.test(tenantId)) {
      return res.status(400).json({ message: 'Invalid tenant identifier.' });
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(filename)) {
      return res.status(400).json({ message: 'Invalid filename parameter.' });
    }

    // ── 2. Tenant Isolation Check ───────────────────────────────────────────
    if (req.user.role !== 'SUPER_ADMIN' && req.tenantId !== tenantId) {
      console.warn(`🚨 [SECURITY ALERT] Cross-tenant access attempt by user ${req.user.email} (Tenant: ${req.tenantId}) to file in Tenant: ${tenantId}`);
      return res.status(403).json({ message: 'Access denied: Cross-tenant document access is strictly prohibited.' });
    }

    // ── 3. Ownership & Role-Based Access Control ────────────────────────────
    if (req.user.role === 'REQUESTOR' || req.user.role === 'VENDOR') {
      const isOwnerVendor = await VendorRequest.exists({
        tenantId,
        $or: [
          { createdBy: req.user._id, 'documents.storedName': filename },
          { 'documents.storedName': filename, ...(req.user.sapVendorNumber ? { sapVendorNumber: req.user.sapVendorNumber } : {}) }
        ]
      });

      if (!isOwnerVendor) {
        const isOwnerCr = await VendorChangeRequest.exists({
          tenantId,
          createdBy: req.user._id,
          'documents.storedName': filename,
        });

        if (!isOwnerCr) {
          console.warn(`🚨 [SECURITY ALERT] User ${req.user.email} attempted to access unauthorized document: ${filename}`);
          return res.status(403).json({ message: 'Access denied: You are not authorized to view this document.' });
        }
      }
    } else if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN' && req.user.plants && req.user.plants.length > 0) {
      // Approver plant scope check
      const docRequest = await VendorRequest.findOne({
        tenantId,
        'documents.storedName': filename,
      }).select('plant');

      if (docRequest && docRequest.plant && !req.user.plants.includes(docRequest.plant)) {
        return res.status(403).json({ message: 'Access denied: Document belongs to a plant outside your authorized scope.' });
      }

      const crRequest = await VendorChangeRequest.findOne({
        tenantId,
        'documents.storedName': filename,
      }).select('plant');

      if (crRequest && crRequest.plant && !req.user.plants.includes(crRequest.plant)) {
        return res.status(403).json({ message: 'Access denied: Document belongs to a plant outside your authorized scope.' });
      }
    }

    // ── 4. Safe Path Resolution ─────────────────────────────────────────────
    let targetPath;
    try {
      targetPath = getSafeAbsolutePath(filename, tenantId);
    } catch (pathErr) {
      console.warn(`🚨 [SECURITY ALERT] Path traversal blocked: ${pathErr.message}`);
      return res.status(403).json({ message: 'Access denied: Invalid path.' });
    }

    if (!targetPath || !fs.existsSync(targetPath)) {
      return res.status(404).json({ message: 'Document not found on storage.' });
    }

    // ── 5. Security Response Headers ────────────────────────────────────────
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('Cache-Control', 'private, max-age=3600');

    const contentType = getMimeType(filename);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', getContentDisposition(filename, contentType));

    // ── 6. Stream File ──────────────────────────────────────────────────────
    return res.sendFile(targetPath);

  } catch (err) {
    next(err);
  }
});

module.exports = router;

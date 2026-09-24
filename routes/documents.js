'use strict';

const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { getSafeAbsolutePath, UPLOADS_DIR } = require('../config/storage');
const VendorRequest = require('../models/VendorRequest');
const VendorChangeRequest = require('../models/VendorChangeRequest');
const VendorConfirmation = require('../models/VendorConfirmation');
const User = require('../models/User');
const SuperAdmin = require('../models/SuperAdmin');
const { getMimeType, getContentDisposition } = require('../utils/mimeHelper');

/**
 * Custom authentication middleware for document serving.
 * Supports:
 *  1. JWT via Authorization header ('Bearer <token>')
 *  2. JWT via URL query parameter ('?token=<jwt>')
 *  3. Cryptographic Magic Token for Balance Confirmations ('?magicToken=<token>' or '?token=<magicToken>')
 */
const authenticateDocumentRequest = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    let token = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    } else if (req.query && req.query.token) {
      token = req.query.token;
    }

    const magicToken = req.query.magicToken || req.query.token;

    // 1. Attempt JWT verification if token is present
    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        let user = await User.findById(decoded.userId).select('-password');
        if (!user && decoded.role === 'SUPER_ADMIN') {
          user = await SuperAdmin.findById(decoded.userId).select('-password');
        }
        if (user && user.isActive) {
          req.user = user;
          req.tenantId = user.tenantId || (decoded.role === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : null);
          return next();
        }
      } catch (jwtErr) {
        // Not a valid JWT, proceed to check magic token fallback
      }
    }

    // 2. Attempt Cryptographic Magic Token verification (for external vendors accessing balance confirmations)
    if (magicToken) {
      const { tenantId, filename } = req.params;
      const tokenHash = crypto.createHash('sha256').update(magicToken).digest('hex');
      const filenameRegex = new RegExp(filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

      const confirmation = await VendorConfirmation.findOne({
        tenantId,
        $or: [{ token: magicToken }, { tokenHash }],
        $and: [
          {
            $or: [
              { vendorStatementFileUrl: filenameRegex },
              { vendorSignedDocumentUrl: filenameRegex },
              { sealedPdfUrl: filenameRegex },
              { initialLetterPdfUrl: filenameRegex },
            ],
          },
        ],
      });

      if (confirmation) {
        if (confirmation.tokenExpiresAt && new Date() > confirmation.tokenExpiresAt) {
          return res.status(401).json({ message: 'Balance confirmation access link has expired.' });
        }
        req.isMagicTokenAuth = true;
        req.confirmation = confirmation;
        req.tenantId = confirmation.tenantId;
        return next();
      }
    }

    // 3. Neither valid JWT nor valid Magic Token was supplied
    return res.status(401).json({ message: 'Access denied. No token provided.' });
  } catch (err) {
    next(err);
  }
};

/**
 * ── GET /uploads/:tenantId/:filename ──────────────────────────────────────────
 * Secure Document Serving Endpoint (Replaces public express.static)
 *
 * Security Protections:
 * 1. Authentication Required: Valid JWT token (via Bearer header or ?token= query parameter) OR valid magic token.
 * 2. Tenant Isolation: Strictly prevents users from accessing files of other tenants.
 * 3. Path Traversal Defense: Sanitizes tenantId and filename, checks resolved path bounds.
 * 4. RBAC & Ownership: Requestors / Vendors can only access their own documents; approvers check plant scope.
 * 5. Security Headers: nosniff, CSP default-src none, proper MIME type and Content-Disposition.
 */
router.get('/:tenantId/:filename', authenticateDocumentRequest, async (req, res, next) => {
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
    if (!req.isMagicTokenAuth) {
      if (req.user.role !== 'SUPER_ADMIN' && req.tenantId !== tenantId) {
        console.warn(`🚨 [SECURITY ALERT] Cross-tenant access attempt by user ${req.user.email} (Tenant: ${req.tenantId}) to file in Tenant: ${tenantId}`);
        return res.status(403).json({ message: 'Access denied: Cross-tenant document access is strictly prohibited.' });
      }
    }

    // ── 3. Ownership & Role-Based Access Control ────────────────────────────
    if (!req.isMagicTokenAuth && (req.user.role === 'REQUESTOR' || req.user.role === 'VENDOR')) {
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
          // Check VendorConfirmation records
          const filenameRegex = new RegExp(filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
          const isOwnerConf = await VendorConfirmation.exists({
            tenantId,
            $or: [
              ...(req.user.sapVendorNumber ? [{ sapVendorNumber: req.user.sapVendorNumber }] : []),
              ...(req.user.email ? [{ vendorEmail: req.user.email.toLowerCase() }] : []),
              { initiatedBy: req.user._id },
            ],
            $and: [
              {
                $or: [
                  { vendorStatementFileUrl: filenameRegex },
                  { vendorSignedDocumentUrl: filenameRegex },
                  { sealedPdfUrl: filenameRegex },
                  { initialLetterPdfUrl: filenameRegex },
                ],
              },
            ],
          });

          if (!isOwnerConf) {
            console.warn(`🚨 [SECURITY ALERT] User ${req.user.email} attempted to access unauthorized document: ${filename}`);
            return res.status(403).json({ message: 'Access denied: You are not authorized to view this document.' });
          }
        }
      }
    } else if (!req.isMagicTokenAuth && req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN' && req.user.plants && req.user.plants.length > 0) {
      // Approver plant scope check for onboarding documents
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

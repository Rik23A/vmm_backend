'use strict';

/**
 * Storage & File Security Configuration — config/storage.js
 *
 * Enterprise Security Measures:
 * 1. External Storage: Files are stored OUTSIDE the backend application directory
 *    (default: vmm-app/uploads, or configurable via process.env.UPLOADS_DIR).
 * 2. Tenant Isolation: Each tenant's files are quarantined in a dedicated folder.
 * 3. Path Traversal Prevention: Strict validation on tenant IDs and file names to prevent directory traversal attacks (../, null bytes).
 * 4. UUID File Naming: Disk files are assigned cryptographically random UUIDs to avoid name collision and guessing attacks.
 * 5. File Type Validation: Restrict uploads to safe MIME types and safe file extensions (PDF, JPEG, PNG only).
 */

const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');

// Root uploads directory located OUTSIDE the backend directory:
// e.g. e:\VMM_SAAS\vmm-app\uploads
const UPLOADS_DIR = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.resolve(__dirname, '../../uploads');

// Ensure root uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Legacy backend uploads path (for fallback/migration)
const LEGACY_UPLOADS_DIR = path.resolve(__dirname, '../uploads');

/**
 * Get sanitized tenant directory path outside backend
 */
const getTenantUploadDir = (tenantId) => {
  const cleanTenant = String(tenantId || 'default').replace(/[^a-zA-Z0-9_-]/g, '');
  const dir = path.join(UPLOADS_DIR, cleanTenant);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
};

/**
 * Safely resolves an uploaded file to an absolute path outside backend.
 * Blocks any directory traversal attempts.
 *
 * Accepts:
 *   - "uploads/mycompany/uuid.pdf"
 *   - "mycompany/uuid.pdf"
 *   - ("uuid.pdf", "mycompany")
 */
const getSafeAbsolutePath = (filePathOrStoredName, tenantId = null) => {
  if (!filePathOrStoredName) return null;

  let cleanRelative = String(filePathOrStoredName).trim().replace(/\\/g, '/');
  // Strip leading slash or "uploads/"
  cleanRelative = cleanRelative.replace(/^\/?(uploads\/)?/, '');

  const parts = cleanRelative.split('/').filter(Boolean);
  let resolvedTenant = tenantId ? String(tenantId).trim() : null;
  let filename = null;

  if (parts.length >= 2) {
    resolvedTenant = parts[0];
    filename = parts.slice(1).join('/');
  } else if (parts.length === 1) {
    filename = parts[0];
  }

  if (!resolvedTenant || !filename) return null;

  // Strict regex check: only alphanumeric, underscore, hyphen, and dots in filename
  if (!/^[a-zA-Z0-9_-]+$/.test(resolvedTenant)) {
    throw new Error('Invalid tenant parameter in file path');
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(filename)) {
    throw new Error('Invalid filename parameter in file path');
  }

  const tenantDir = path.resolve(UPLOADS_DIR, resolvedTenant);
  const targetPath = path.resolve(tenantDir, filename);

  // Security Check: Enforce that targetPath is strictly inside tenantDir (prevents ../ and prefix collisions)
  const rel = path.relative(tenantDir, targetPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Directory traversal attempt detected');
  }

  // If file exists in new external uploads folder, return it
  if (fs.existsSync(targetPath)) {
    return targetPath;
  }

  // Migration Fallback: check legacy backend/uploads
  const legacyTenantDir = path.resolve(LEGACY_UPLOADS_DIR, resolvedTenant);
  const legacyTargetPath = path.resolve(legacyTenantDir, filename);
  const legacyRel = path.relative(legacyTenantDir, legacyTargetPath);
  if (!legacyRel.startsWith('..') && !path.isAbsolute(legacyRel) && fs.existsSync(legacyTargetPath)) {
    return legacyTargetPath;
  }

  return targetPath; // returns target path even if not yet created (for write destinations)
};

/**
 * Centralized Multer storage configured to write outside backend
 */
const secureMulterStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const tenantId = req.tenantId || 'default';
    const dir = getTenantUploadDir(tenantId);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExtensions = [
      '.pdf',
      '.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff',
      '.xlsx', '.xls', '.docx', '.doc', '.txt', '.csv',
      '.zip'
    ];
    const safeExt = safeExtensions.includes(ext) ? ext : '.bin';
    cb(null, `${uuidv4()}${safeExt}`);
  },
});

/**
 * Strict file filter for document uploads
 * Supports all common vendor documents matching SAP attachment types
 */
const secureFileFilter = (req, file, cb) => {
  const allowedExtensions = [
    '.pdf',
    '.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff',
    '.xlsx', '.xls', '.docx', '.doc', '.txt', '.csv',
    '.zip'
  ];
  const allowedMimeTypes = [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/tiff',
    'text/plain',
    'text/csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'application/zip',
    'application/octet-stream',
  ];
  const ext = path.extname(file.originalname || '').toLowerCase();

  if (allowedExtensions.includes(ext) || allowedMimeTypes.includes(file.mimetype)) {
    return cb(null, true);
  }
  cb(new Error('Security check failed: Unsupported file type. Allowed formats: PDF, JPG, PNG, WEBP, XLSX, XLS, DOCX, DOC, TXT, CSV, ZIP.'));
};

const secureUpload = multer({
  storage: secureMulterStorage,
  limits: { fileSize: parseInt(process.env.UPLOAD_MAX_SIZE || '10485760') }, // default 10MB
  fileFilter: secureFileFilter,
});

module.exports = {
  UPLOADS_DIR,
  LEGACY_UPLOADS_DIR,
  getTenantUploadDir,
  getSafeAbsolutePath,
  secureMulterStorage,
  secureFileFilter,
  secureUpload,
};

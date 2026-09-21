'use strict';

/**
 * Universal MIME Type & File Format Utilities — utils/mimeHelper.js
 *
 * Supports all common vendor documents, SAP BP attachments, images,
 * spreadsheets, word documents, text files, and archives.
 */

const path = require('path');

const MIME_MAP = {
  // Documents
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  rtf: 'application/rtf',

  // Images
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',

  // Microsoft Office & Modern OpenXML
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',

  // Archives & Compressed
  zip: 'application/zip',
  rar: 'application/x-rar-compressed',
  '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar',
  gz: 'application/gzip',
};

// Reverse lookup: MIME type -> preferred file extension
const EXTENSION_MAP = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/webp': 'webp',
  'image/tiff': 'tif',
  'image/svg+xml': 'svg',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/zip': 'zip',
};

// MIME types that browsers natively render inline in tabs
const INLINE_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
  'text/plain',
]);

/**
 * Returns normalized MIME type for any filename, path, or extension.
 * @param {string} fileNameOrExt - e.g. "GST_Cert.pdf", "image/png", ".xlsx", "JPG"
 * @param {string} fallback - fallback MIME type if unknown (default: application/octet-stream)
 */
function getMimeType(fileNameOrExt, fallback = 'application/octet-stream') {
  if (!fileNameOrExt) return fallback;

  const raw = String(fileNameOrExt).trim().toLowerCase();

  // If already a valid MIME string with slash, return it
  if (raw.includes('/') && !raw.includes('.')) {
    return raw;
  }

  // Extract extension
  const ext = raw.includes('.')
    ? raw.split('.').pop().replace(/[^a-z0-9]/g, '')
    : raw.replace(/[^a-z0-9]/g, '');

  return MIME_MAP[ext] || fallback;
}

/**
 * Returns preferred file extension (without dot) for a MIME type or filename.
 * @param {string} mimeOrFileName - e.g. "application/pdf" or "cheque.jpg"
 * @param {string} fallbackExt - default: "bin"
 */
function getFileExtension(mimeOrFileName, fallbackExt = 'bin') {
  if (!mimeOrFileName) return fallbackExt;

  const raw = String(mimeOrFileName).trim().toLowerCase();

  if (raw.includes('/')) {
    const cleanMime = raw.split(';')[0].trim();
    return EXTENSION_MAP[cleanMime] || fallbackExt;
  }

  if (raw.includes('.')) {
    return raw.split('.').pop().replace(/[^a-z0-9]/g, '') || fallbackExt;
  }

  return raw.replace(/[^a-z0-9]/g, '') || fallbackExt;
}

/**
 * Determines whether a given MIME type should be served as inline or attachment.
 * Browsers can view PDFs and common images inline, whereas Office documents and ZIPs
 * trigger a direct download prompt.
 */
function getContentDisposition(fileName, mimeType) {
  const cleanMime = (mimeType || '').split(';')[0].trim().toLowerCase();
  const safeName = (fileName || 'document').replace(/["\r\n\\]/g, '_');
  const isInline = INLINE_MIME_TYPES.has(cleanMime);
  const disposition = isInline ? 'inline' : 'attachment';

  return `${disposition}; filename="${safeName}"`;
}

module.exports = {
  MIME_MAP,
  EXTENSION_MAP,
  INLINE_MIME_TYPES,
  getMimeType,
  getFileExtension,
  getContentDisposition,
};

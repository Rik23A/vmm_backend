const jwt = require('jsonwebtoken');
const User = require('../models/User');
const SuperAdmin = require('../models/SuperAdmin');

// ── requireLogin ─────────────────────────────────────────────────────
// Verifies JWT from Authorization header. Attaches req.user and req.tenantId.
const requireLogin = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    let token = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    } else if (req.query && req.query.token) {
      token = req.query.token;
    }

    if (!token) {
      return res.status(401).json({ message: 'Access denied. No token provided.' });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    let user = await User.findById(decoded.userId).select('-password');
    if (!user && decoded.role === 'SUPER_ADMIN') {
      user = await SuperAdmin.findById(decoded.userId).select('-password');
    }
    if (!user) {
      return res.status(401).json({ message: 'User not found. Token invalid.' });
    }
    if (!user.isActive) {
      return res.status(403).json({ message: 'Account is deactivated. Contact your administrator.' });
    }

    req.user = user;
    req.tenantId = user.tenantId || (decoded.role === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : null);
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Session expired. Please log in again.' });
    }
    return res.status(401).json({ message: 'Invalid token.' });
  }
};

// ── requireRole ──────────────────────────────────────────────────────
// Usage: requireRole('ADMIN') or requireRole('L1_APPROVER', 'L2_APPROVER', 'ADMIN')
const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Not authenticated.' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        message: `Access denied. Required role: ${roles.join(' or ')}. Your role: ${req.user.role}`,
      });
    }
    next();
  };
};

// ── optionalLogin ──────────────────────────────────────────────────────
// Attaches req.user if token present, but doesn't fail if absent
const optionalLogin = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.userId).select('-password');
      if (user && user.isActive) {
        req.user = user;
        req.tenantId = user.tenantId;
      }
    }
  } catch (_) {
    // silently ignore — this is optional auth
  }
  next();
};

// ── requireSuperAdminLogin ─────────────────────────────────────────────
const requireSuperAdminLogin = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    let token = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    } else if (req.query && req.query.token) {
      token = req.query.token;
    }
    if (!token) {
      return res.status(401).json({ message: 'Access denied. No token provided.' });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ message: 'Access denied. Super Admin only.' });
    }

    const superAdmin = await SuperAdmin.findById(decoded.userId).select('-password');
    if (!superAdmin) {
      return res.status(401).json({ message: 'Super Admin not found. Token invalid.' });
    }
    if (!superAdmin.isActive) {
      return res.status(403).json({ message: 'Account is deactivated.' });
    }

    req.user = superAdmin;
    // Note: No req.tenantId is set because SuperAdmins manage the platform globally
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Session expired. Please log in again.' });
    }
    return res.status(401).json({ message: 'Invalid token.' });
  }
};

module.exports = { requireLogin, requireRole, optionalLogin, requireSuperAdminLogin };

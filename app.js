require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/db');

const app = express();

// Trust proxy to get correct client IP address
app.set('trust proxy', 1);

// ── Connect to MongoDB Atlas ────────────────────────────────────────
connectDB();

// ── Security Middleware ─────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

const jwt = require('jsonwebtoken');

// Rate limiting: 1000 requests per 15 minutes, tracked by User ID (if authenticated) or IP address
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  keyGenerator: (req) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      try {
        const decoded = jwt.decode(token);
        if (decoded && decoded.userId) {
          return `user_${decoded.userId}`;
        }
      } catch (err) {
        // Fallback on error
      }
    }
    return req.ip;
  },
  message: { message: 'Too many requests, please try again later.' },
});
app.use('/api/', limiter);

// ── CORS ────────────────────────────────────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL || 'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:5173',
];
app.use(cors({
  origin: (origin, callback) => {
    // In development mode, allow any local network/Wi-Fi origin
    if (!origin || process.env.NODE_ENV !== 'production' || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

// ── Body Parsers ────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Logger (only in dev) ────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'));
}

// ── Serve uploaded files ─────────────────────────────────────────────
// Documents stored in /uploads folder in app root — accessible via /uploads/filename
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── Health Check ─────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const mongoose = require('mongoose');
  res.json({
    status: 'ok',
    db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    tenantMode: process.env.TENANT_MODE || 'MULTI',
    sapVersion: process.env.SAP_VERSION || 'STUB',
    timestamp: new Date().toISOString(),
  });
});

// ── API Routes ────────────────────────────────────────────────────────
app.use('/api/auth',            require('./routes/auth'));
app.use('/api/super-admin',     require('./routes/superAdmin'));
app.use('/api/vendors',         require('./routes/vendors'));
app.use('/api/change-requests', require('./routes/changeRequests'));
app.use('/api/approvals',       require('./routes/approvals'));
app.use('/api/admin',           require('./routes/admin'));
app.use('/api/reports',         require('./routes/reports'));
app.use('/api/notifications',   require('./routes/notifications'));

// ── Trust Reverse Proxy (Render / Heroku / AWS ALB) ─────────────────
app.set('trust proxy', 1);

// ── Serve React Frontend (Production) ────────────────────────────────
// If client dist exists on the server, serve it; otherwise backend acts purely as API server
if (process.env.NODE_ENV === 'production') {
  const fs = require('fs');
  const distPath = path.join(__dirname, '..', 'client', 'dist');
  if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get('*', (req, res, next) => {
      if (!req.path.startsWith('/api') && !req.path.startsWith('/uploads')) {
        res.sendFile(path.join(distPath, 'index.html'));
      } else {
        next();
      }
    });
  }
}

// ── Global Error Handler ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${err.message}`);

  // Handle Mongoose validation errors
  if (err.name === 'ValidationError') {
    const errors = Object.values(err.errors).map(e => ({
      field: e.path,
      message: e.message,
    }));
    return res.status(400).json({
      message: `Validation failed: ${errors.map(e => e.message).join(', ')}`,
      errors,
    });
  }

  const status = err.status || 500;
  res.status(status).json({
    message: err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

// ── 404 handler ───────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ message: `Route ${req.originalUrl} not found` });
});

// ── Start Server ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`\n✅ VMM Server running on port ${PORT}`);
  console.log(`   Mode: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Tenant: ${process.env.TENANT_MODE || 'MULTI'}`);
  console.log(`   SAP: ${process.env.SAP_VERSION || 'STUB'}\n`);
});

module.exports = app;

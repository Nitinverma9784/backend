require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const authRoutes = require('./routes/auth.routes');
const whatsappRoutes = require('./routes/whatsapp.routes');
const onboardingRoutes = require('./routes/onboarding.routes');
const { initBaileys, getStatus } = require('./services/baileys.service');
const { migrateMultiSession } = require('./lib/migrate-multisession');
const { migrateTenants } = require('./lib/migrate-tenants');
const User = require('./models/user.model');
const WaSession = require('./models/wa-session.model');

const app = express();
const server = http.createServer(app);

const parseAllowedOrigins = () =>
  String(process.env.FRONTEND_URL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const allowedOrigins = parseAllowedOrigins();

const normalizeOrigin = (origin) => {
  if (!origin) return '';
  try {
    return new URL(origin).origin;
  } catch {
    return '';
  }
};

const isAllowedOrigin = (origin) => {
  if (!origin) return true; // non-browser or same-origin tools
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  if (allowedOrigins.length === 0) return true;

  for (const rule of allowedOrigins) {
    const r = rule.trim();
    if (!r) continue;
    if (r === '*') return true;

    // Exact origin match
    if (normalizeOrigin(r) === normalized) return true;

    // Wildcard suffix, e.g. https://*.vercel.app
    if (r.includes('*')) {
      const pattern = r
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');
      const regex = new RegExp(`^${pattern}$`, 'i');
      if (regex.test(origin) || regex.test(normalized)) return true;
    }
  }
  return false;
};

const corsOrigin = (origin, callback) => {
  if (isAllowedOrigin(origin)) return callback(null, true);
  return callback(new Error(`CORS blocked for origin: ${origin}`), false);
};

const io = socketIo(server, {
  cors: {
    origin: corsOrigin,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
  })
);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use('/api/auth', authRoutes);
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/whatsapp', whatsappRoutes);

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
  });
});

io.use((socket, next) => {
  try {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.query?.token ||
      '';
    if (!token) return next(new Error('Unauthorized'));
    socket.user = jwt.verify(token, process.env.JWT_SECRET);
    if (!socket.user?.tenantId) return next(new Error('Unauthorized'));
    next();
  } catch {
    next(new Error('Unauthorized'));
  }
});

io.on('connection', (socket) => {
  console.log('[Socket] Connected:', socket.id);

  socket.on('joinWaSessions', async (sessionIds) => {
    try {
      const ids = Array.isArray(sessionIds) ? sessionIds.map(String) : [];
      const userRow = await User.findById(socket.user.id).lean();
      const role = socket.user.role;

      for (const sid of ids) {
        if (!mongoose.Types.ObjectId.isValid(sid)) continue;
        const exists = await WaSession.exists({ _id: sid, tenantId: socket.user.tenantId });
        if (!exists) continue;

        let ok = role === 'master';
        if (!ok && userRow?.assignedSessions?.length) {
          ok = userRow.assignedSessions.map(String).includes(sid);
        }
        if (ok) {
          socket.join(`session:${sid}`);
          socket.emit('connectionStatus', {
            ...getStatus(sid),
            sessionId: sid,
          });
        }
      }
    } catch (err) {
      console.error('[Socket] joinWaSessions:', err.message);
    }
  });

  socket.on('requestStatus', (payload) => {
    const sessionId = payload?.sessionId;
    if (!sessionId || !mongoose.Types.ObjectId.isValid(sessionId)) return;
    socket.emit('connectionStatus', {
      ...getStatus(sessionId),
      sessionId: String(sessionId),
    });
  });

  socket.on('joinGroup', (groupId) => {
    if (typeof groupId === 'string' && groupId.length > 0) {
      socket.join(groupId);
    }
  });

  socket.on('leaveGroup', (groupId) => {
    socket.leave(groupId);
  });

  socket.on('disconnect', (reason) => {
    console.log(`[Socket] Disconnected: ${socket.id} (${reason})`);
  });
});

const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp-crm';

mongoose
  .connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
  })
  .then(async () => {
    console.log('[DB] Connected to MongoDB');
    const { defaultTenantId } = await migrateTenants();
    await migrateMultiSession(defaultTenantId);

    server.listen(PORT, () => {
      console.log(`[Server] Running on port ${PORT}`);
      initBaileys(io).catch((err) => {
        console.error('[Baileys] Init error:', err.message);
      });
    });
  })
  .catch((err) => {
    console.error('[DB] Connection error:', err.message);
    process.exit(1);
  });

const gracefulShutdown = async (signal) => {
  console.log(`\n[Server] ${signal} received. Shutting down gracefully...`);
  server.close(() => {
    mongoose.connection.close().then(() => {
      console.log('[Server] MongoDB connection closed');
      process.exit(0);
    });
  });
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

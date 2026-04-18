const jwt = require('jsonwebtoken');
const User = require('../models/user.model');
const WaSession = require('../models/wa-session.model');

const authMiddleware = async (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ message: 'No token, authorization denied' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET) || {};
    if (!decoded.id || !decoded.role) {
      return res.status(401).json({ message: 'Token is not valid' });
    }

    // Backward compatibility: hydrate tenantId/username for old tokens.
    if (!decoded.tenantId || !decoded.username) {
      const user = await User.findById(decoded.id).select('tenantId username').lean();
      if (!user) return res.status(401).json({ message: 'User not found for token' });

      let tenantId = user.tenantId;
      if (!tenantId) {
        const firstSession = await WaSession.findOne({ tenantId: { $exists: true, $ne: null } })
          .sort({ createdAt: 1 })
          .select('tenantId')
          .lean();
        tenantId = firstSession?.tenantId || user._id;
      }

      req.user = {
        ...decoded,
        username: decoded.username || user.username,
        tenantId: String(tenantId),
      };
      return next();
    }

    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ message: 'Token is not valid' });
  }
};

const masterMiddleware = (req, res, next) => {
  if (req.user.role !== 'master') return res.status(403).json({ message: 'Access denied. Master admin only.' });
  next();
};

module.exports = { authMiddleware, masterMiddleware };

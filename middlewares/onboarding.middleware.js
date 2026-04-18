const jwt = require('jsonwebtoken');

/**
 * Expects Authorization: Bearer <token> with payload { purpose: 'share_onboard', sessionId }.
 * Must match :sessionId in the route.
 */
const onboardingTokenMiddleware = (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ message: 'Missing onboarding token' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.purpose !== 'share_onboard' || !decoded.sessionId) {
      return res.status(401).json({ message: 'Invalid onboarding token' });
    }
    if (String(decoded.sessionId) !== String(req.params.sessionId)) {
      return res.status(403).json({ message: 'Token does not match this session' });
    }
    req.shareOnboardingSessionId = String(decoded.sessionId);
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired onboarding token' });
  }
};

module.exports = { onboardingTokenMiddleware };

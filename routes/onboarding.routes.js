const express = require('express');
const router = express.Router();
const {
  shareStart,
  getShareStatus,
  shareConnect,
  shareComplete,
} = require('../controllers/onboarding.controller');
const { onboardingTokenMiddleware } = require('../middlewares/onboarding.middleware');

router.post('/share/start', shareStart);
router.get('/share/:sessionId/status', onboardingTokenMiddleware, getShareStatus);
router.post('/share/:sessionId/connect', onboardingTokenMiddleware, shareConnect);
router.post('/share/:sessionId/complete', onboardingTokenMiddleware, shareComplete);

module.exports = router;

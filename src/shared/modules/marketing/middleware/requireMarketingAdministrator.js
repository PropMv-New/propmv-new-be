function requireMarketingAdministrator(req, res, next) {
  if (req.user?.isAdministrator) {
    return next();
  }
  return res.status(403).json({
    message: 'Administrator access is required for marketing subscriber management.',
    statuscode: 403,
    data: null,
  });
}

module.exports = { requireMarketingAdministrator };

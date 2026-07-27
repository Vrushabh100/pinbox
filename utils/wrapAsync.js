// Wraps async route handlers to forward errors to Express error handler
module.exports = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Wrap async route handlers so rejections return JSON via Express error middleware.
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    try {
      Promise.resolve(fn(req, res, next)).catch(next);
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { asyncHandler };

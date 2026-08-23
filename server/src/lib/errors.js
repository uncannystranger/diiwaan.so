export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const notFound = (req, res, next) => next(new HttpError(404, 'Not found.'));

/* eslint-disable no-unused-vars */
export function errorHandler(error, req, res, _next) {
  const status = error.status || (error.name === 'ZodError' ? 422 : 500);
  const payload = {
    // Anything 5xx may carry upstream detail; never pass that to the browser.
    error: status >= 500 ? 'Something went wrong on our side.' : error.message,
    ...(error.details ? { details: error.details } : {}),
    ...(error.name === 'ZodError' ? { details: error.issues } : {})
  };
  if (status >= 500) console.error('[error]', error);
  res.status(status).json(payload);
}

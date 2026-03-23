import { AppError } from '../../shared/errors.js';
import { errorBus } from '../../shared/error-bus.js';

export function registerErrorHandler(app) {
  app.setErrorHandler((error, request, reply) => {
    const appErr = AppError.wrap(error);
    errorBus.report(appErr, {
      context: { method: request.method, url: request.url },
    });
    reply.status(appErr.httpStatus).send({
      error: { code: appErr.code, message: appErr.message, traceId: appErr.traceId },
    });
  });
}

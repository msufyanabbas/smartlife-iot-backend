import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { QueryFailedError } from 'typeorm';

/**
 * Global exception filter to handle all exceptions
 * Provides consistent error responses across the application
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error';
    let error = 'Internal Server Error';
    let validationErrors: any = null;
    /**
     * Field-level detail from a thrown `BadRequestException({ message, errors })`.
     *
     * Without this the array was silently dropped: the filter copied only
     * `message` and `error` off the exception response, so a caller that
     * reported every invalid field at once — the integration config validator
     * and the rule-chain graph validator both do — arrived at the client as a
     * single sentence with no indication of WHICH field was wrong. The form had
     * nothing to highlight and the user had nothing to fix.
     */
    let errors: string[] | null = null;
    /**
     * A machine-readable error code from a thrown
     * `BadRequestException({ code, message, details })`.
     *
     * Dropped for the same reason `errors` was: the filter copied only a
     * fixed set of fields off the exception response. Services already throw
     * codes — NO_TELEMETRY_IN_WINDOW, NOT_ENOUGH_READINGS,
     * NO_AI_MODEL_CONFIGURED — and every one of them arrived at the client as
     * an English sentence and nothing else.
     *
     * The cost was not theoretical. The AI insights tab had to classify
     * failures by substring-matching the server's prose, with a comment
     * conceding there was "nothing machine-readable to switch on" — so
     * rewording a message silently reclassified the error and showed the
     * wrong empty state.
     */
    let code: string | null = null;
    let details: unknown = null;

    // Handle different types of exceptions
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
        error = exception.name;
      } else if (typeof exceptionResponse === 'object') {
        const responseObj = exceptionResponse as any;
        message = responseObj.message || message;
        error = responseObj.error || exception.name;
        validationErrors = responseObj.validationErrors || null;
        errors = Array.isArray(responseObj.errors) ? responseObj.errors : null;
        code = typeof responseObj.code === 'string' ? responseObj.code : null;
        details = responseObj.details ?? null;
      }
    } else if (exception instanceof QueryFailedError) {
      // Handle database errors
      status = HttpStatus.BAD_REQUEST;
      message = 'Database query failed';
      error = 'Database Error';

      // Handle specific database errors
      const dbError = exception as any;
      if (dbError.code === '23505') {
        // Unique constraint violation
        message = 'Duplicate entry. This record already exists.';
        error = 'Duplicate Entry';
        status = HttpStatus.CONFLICT;
      } else if (dbError.code === '23503') {
        // Foreign key constraint violation
        message = 'Related record not found or still in use.';
        error = 'Constraint Violation';
      } else if (dbError.code === '23502') {
        // Not null violation
        message = 'Required field is missing.';
        error = 'Missing Required Field';
      }
    } else if (exception instanceof Error) {
      message = exception.message;
      error = exception.name;
    }

    // Log the exception
    this.logger.error(
      `${request.method} ${request.url} - Status: ${status} - Error: ${error}`,
      exception instanceof Error ? exception.stack : String(exception),
    );

    // Build error response
    const errorResponse: any = {
      success: false,
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      method: request.method,
      error,
      message,
    };

    // Add validation errors if present
    if (validationErrors) {
      errorResponse.validationErrors = validationErrors;
    }

    // `errors` is the preferred shape for new code: throw
    // `new BadRequestException({ message, errors: string[] })` and the client
    // receives every problem at once instead of one per round trip.
    if (errors) {
      errorResponse.errors = errors;
    }

    // Machine-readable code and its structured context. A client should
    // switch on `code` and render `message`; `details` carries whatever the
    // thrower thought the caller would need (which keys, which window).
    if (code) {
      errorResponse.code = code;
    }
    if (details !== null && details !== undefined) {
      errorResponse.details = details;
    }

    // Add stack trace in development
    if (process.env.NODE_ENV === 'development' && exception instanceof Error) {
      errorResponse.stack = exception.stack;
    }

    response.status(status).json(errorResponse);
  }
}

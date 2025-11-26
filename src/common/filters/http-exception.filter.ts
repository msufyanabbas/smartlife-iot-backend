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

    // Add stack trace in development
    if (process.env.NODE_ENV === 'development' && exception instanceof Error) {
      errorResponse.stack = exception.stack;
    }

    response.status(status).json(errorResponse);
  }
}

// src/common/middleware/request-id.middleware.ts
import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    // If request already has an ID (from API gateway or frontend), use it
    // Otherwise, generate a new one
    req.id = (req.headers['x-request-id'] as string) || uuidv4();
    
    // Send it back in the response header so frontend can log it too
    res.setHeader('x-request-id', req.id);
    
    next();
  }
}
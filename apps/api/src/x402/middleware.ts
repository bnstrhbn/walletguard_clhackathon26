import type { NextFunction, Request, Response } from 'express';

export function requireX402Payment(req: Request, _res: Response, next: NextFunction): void {
  void req;
  next();
}

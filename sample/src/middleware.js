import { findUser } from './user-service.js';
export function withAuth(req) { return findUser(req.userId); }

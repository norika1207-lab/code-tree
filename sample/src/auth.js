import { getSession } from './session-store.js';
import { withAuth } from './middleware.js';
export function login(user) { return getSession(user.id); }

const store = new Map();
export function getSession(id) { return store.get(id); }
export function setSession(id, v) { store.set(id, v); }

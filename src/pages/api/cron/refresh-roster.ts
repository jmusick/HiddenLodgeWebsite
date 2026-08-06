// Legacy alias for the renamed /api/cron/refresh endpoint. This route now covers
// roster, raiders, attendance, professions, and trinkets — not just the roster —
// but the old path is kept working in case an external scheduler still targets it
// directly. Safe to delete once nothing points here anymore.
export { GET } from './refresh';

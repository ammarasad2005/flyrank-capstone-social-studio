import pino from 'pino';

// One structured (JSON) logger for the whole app. Level comes from LOG_LEVEL; tests
// run silent so the suite output stays clean. In prod this emits one JSON object per
// line — ready to ship to Better Stack / Grafana Loki / Render's log drain.
const level = process.env.NODE_ENV === 'test' ? 'silent' : process.env.LOG_LEVEL || 'info';

export const logger = pino({
  level,
  base: { service: 'social-media-studio' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
});

// Minimal shape the queue/publish paths log through — satisfied by both `logger`
// (pino) and a test's console-like stub.
export interface Log {
  info?: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

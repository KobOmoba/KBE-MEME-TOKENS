/**
 * Logger — structured console logging with timestamps and levels.
 * Simple by design: one dependency fewer, no crash risk from logging itself.
 */

const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LEVELS.INFO;

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

function fmt(level, tag, msg, ...args) {
  if (LEVELS[level] < MIN_LEVEL) return;
  const prefix = `[${timestamp()}] [${level}] ${tag ? `[${tag}] ` : ''}`;
  const argsStr = args.length ? ' ' + args.map(a =>
    typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)
  ).join(' ') : '';
  const line = `${prefix}${msg}${argsStr}`;
  if (level === 'ERROR') {
    console.error(line);
  } else {
    console.log(line);
  }
}

// Factory: logger.forTag('SCANNER') returns a bound logger
function forTag(tag) {
  return {
    debug: (msg, ...a) => fmt('DEBUG', tag, msg, ...a),
    info:  (msg, ...a) => fmt('INFO',  tag, msg, ...a),
    warn:  (msg, ...a) => fmt('WARN',  tag, msg, ...a),
    error: (msg, ...a) => fmt('ERROR', tag, msg, ...a),
  };
}

// Root logger (no tag)
module.exports = {
  debug: (msg, ...a) => fmt('DEBUG', null, msg, ...a),
  info:  (msg, ...a) => fmt('INFO',  null, msg, ...a),
  warn:  (msg, ...a) => fmt('WARN',  null, msg, ...a),
  error: (msg, ...a) => fmt('ERROR', null, msg, ...a),
  forTag,
};

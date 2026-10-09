// GET /api/health -> { ok, database } : is the lyrics database reachable?
// No data is returned, only whether a trivial query works.

const { configured, q } = require('../lib/db');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  let database = 'not configured';
  if (configured()) {
    try {
      await q('SELECT 1');
      database = 'ok';
    } catch (err) {
      database = err.code === '28P01' ? 'password rejected (redeploy needed)' : `unreachable (${err.code || 'error'})`;
    }
  }
  res.statusCode = database === 'ok' ? 200 : 503;
  res.end(JSON.stringify({ ok: database === 'ok', database }));
};

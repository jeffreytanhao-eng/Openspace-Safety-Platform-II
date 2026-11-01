/**
 * Trigger ephemeris index rebuild via API (increment scan → MySQL → index.json export).
 * The parse/ingest logic now lives in the API server (api/src/ephem/); this script
 * only calls POST /cgi/ephemerides/rebuild.
 *
 * Usage: node data/ephemerides/scripts/rebuild-index.mjs   (server must be running)
 * Env:   EPH_API (default http://127.0.0.1:1234)
 */
const BASE = process.env.EPH_API || 'http://127.0.0.1:1234'

try {
  const res = await fetch(`${BASE}/cgi/ephemerides/rebuild`, { method: 'POST' })
  const body = await res.json()
  if (body.code !== 0) {
    console.error(`rebuild failed: ${body.msg}`)
    process.exit(1)
  }
  const d = body.data
  console.log(
    `rebuild ok: added=${d.added} updated=${d.updated} skipped=${d.skipped} removed=${d.removed} total=${d.total} (db=${d.db})`
  )
} catch (e) {
  console.error(`rebuild failed: cannot reach ${BASE} — ${(e && e.message) || e}`)
  console.error('start the api first: cd api && npm run dev   (or docker compose up api)')
  process.exit(1)
}

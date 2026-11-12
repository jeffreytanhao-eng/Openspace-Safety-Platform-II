# Local public catalog cache (GCAT)

Internal data directory for the object-dossier baseline. Do **not** display
this source name in the product UI.

Source (for attribution in code and this file only):

> McDowell, Jonathan C., 2020. General Catalog of Artificial Space Objects,
> Release 1.8.9, https://planet4589.org/space/gcat

Files expected in this directory (tab-separated, first line is the header,
second line is `# Updated …`):

| File | Official URL | Used for |
| --- | --- | --- |
| `satcat.tsv` | https://planet4589.org/space/gcat/tsv/cat/satcat.tsv | Object identity, operator, state, manufacturer, size, dates |
| `satcat100k.tsv` | https://planet4589.org/space/gcat/tsv/cat/satcat100k.tsv | Same, NORAD ≥ 100000 |
| `psatcat.tsv` | https://planet4589.org/space/gcat/tsv/cat/psatcat.tsv | Payload category → 用途 |
| `orgs.tsv` | https://planet4589.org/space/gcat/tsv/tables/orgs.tsv | Resolve operator / country / manufacturer codes |
| `sites.tsv` | https://planet4589.org/space/gcat/tsv/tables/sites.tsv | Resolve launch-site codes |
| `launchlog.tsv` | https://planet4589.org/space/gcat/tsv/derived/launchlog.tsv | Launch vehicle and launch site (join by JCAT / COSPAR) |

## Ingest (local API database only)

From the `api/` directory (uses `api/.env` DB settings; does not call Space-Track):

```
npm run ingest:gcat
npx tsx src/jobs/ingestGcat.ts --download
npx tsx src/jobs/ingestGcat.ts --dir "D:\项目\Openspace Safety\data\gcat"
```

`--download` re-fetches the TSV files above, then upserts. The job is
idempotent (`INSERT … ON DUPLICATE KEY UPDATE` on `jcat`). It is **not**
wired into the production daily-fetch cron (that job already does 1 GP + 1
CDM per day and must not grow Space-Track traffic).

Recommended refresh: **weekly** (or daily only if launch-day dossier
freshness matters). New GP objects appear from the existing Space-Track
day-cut; dossier slots stay at “暂无” until the next local catalog refresh.

Path override: `GCAT_DATA_DIR` (a filesystem path, not a secret).

Catalog mass and dimensions are stored only in `sat_catalog_profile` and
must never overwrite `objects.mass_kg` / `objects.cross_section_m2`.
Photos are not provided by this catalog; the photo slot stays empty.

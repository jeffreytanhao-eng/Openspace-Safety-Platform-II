# Database

Local MySQL is provided by Docker container `openspace-mysql` (image mysql:8):

- Host port: **13306** → container 3306
- Database: `openspace`
- User/pass: see `api/.env` / container env
- Already contains Space-Track synced tables (`sat_tle`, `sat_cdm`, …)

If the container is missing, from repo root:

```bash
cd deploy
cp .env.example .env
# set DB_* and MYSQL_ROOT_PASSWORD, map host port 13306 if preferred
docker compose --profile mysql up -d mysql
```

Then apply reference schema:

```bash
docker exec -i openspace-mysql mysql -uopenspace -p openspace < ../.reference/server/db/schema.sql
```

Space-Track GP/CDM import is done by the heat-sidecar sync (`spacetrackGp` / `spacetrackCdm`) using `SAT_USERNAME` / `SAT_PASSWORD` in that project's `.env` (do not commit secrets).

#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
COMPOSE_FILE="$ROOT/compose.yaml"
ENV_FILE="$ROOT/.env"
DOCKER_BIN="${DOCKER_BIN:-docker}"
INIT_VOLUME=0
ARG_PROJECT=""
ARG_VOLUME=""
ARG_ORIGIN=""
ARG_PORT=""
ARG_COOKIE_SECURE=""
ARG_BACKUP_DIR=""

usage() {
  cat <<'USAGE'
Usage: bash deploy/source-up.sh --project NAME --volume NAME --backup-dir ABSOLUTE_PATH [--origin URL] [--port PORT] [--cookie-secure true|false] [--init-volume]

First run requires --origin and --init-volume. The launcher creates .env only
when absent, builds from this checkout, and updates the selected Docker volume.
Existing .env files are never rewritten. Backups stay outside this checkout.
USAGE
}
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

while (($#)); do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --project) (($# >= 2)) || fail "--project requires a value"; ARG_PROJECT="$2"; shift 2 ;;
    --volume) (($# >= 2)) || fail "--volume requires a value"; ARG_VOLUME="$2"; shift 2 ;;
    --origin) (($# >= 2)) || fail "--origin requires a value"; ARG_ORIGIN="$2"; shift 2 ;;
    --port) (($# >= 2)) || fail "--port requires a value"; ARG_PORT="$2"; shift 2 ;;
    --cookie-secure) (($# >= 2)) || fail "--cookie-secure requires true or false"; ARG_COOKIE_SECURE="$2"; shift 2 ;;
    --backup-dir) (($# >= 2)) || fail "--backup-dir requires a value"; ARG_BACKUP_DIR="$2"; shift 2 ;;
    --init-volume) INIT_VOLUME=1; shift ;;
    *) usage >&2; fail "unknown argument: $1" ;;
  esac
done

for command in bash awk realpath stat date; do command -v "$command" >/dev/null 2>&1 || fail "required command missing: $command"; done
command -v "$DOCKER_BIN" >/dev/null 2>&1 || fail 'Docker CLI not found'
"$DOCKER_BIN" compose version >/dev/null 2>&1 || fail 'Docker Compose v2 is unavailable'
[[ -f "$COMPOSE_FILE" ]] || fail 'compose.yaml is missing'

# Parse exact dotenv keys without sourcing the file or printing secret values.
read_env() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || { printf ''; return 0; }
  awk -v key="$key" '
    index($0,key "=")==1 { count++; value=substr($0,length(key)+2); sub(/\r$/, "", value); if(length(value)>=2 && substr(value,1,1)=="\"" && substr(value,length(value),1)=="\"") value=substr(value,2,length(value)-2); if(length(value)>=2 && substr(value,1,1)=="\047" && substr(value,length(value),1)=="\047") value=substr(value,2,length(value)-2) }
    END { if(count>1) exit 2; if(count==1) print value; else exit 0 }
  ' "$ENV_FILE"
}
choose() {
  local explicit="$1" env_name="$2" key="$3" from_file=""
  if [[ -n "$explicit" ]]; then printf '%s' "$explicit"; return; fi
  if [[ -n "${!env_name:-}" ]]; then printf '%s' "${!env_name}"; return; fi
  from_file="$(read_env "$key")" || return $?
  printf '%s' "$from_file"
}
PROJECT="$(choose "$ARG_PROJECT" TEAMSHELF_COMPOSE_PROJECT TEAMSHELF_COMPOSE_PROJECT)"
VOLUME="$(choose "$ARG_VOLUME" TEAMSHELF_DATA_VOLUME TEAMSHELF_DATA_VOLUME)"
BACKUP_DIR="$(choose "$ARG_BACKUP_DIR" TEAMSHELF_BACKUP_DIR TEAMSHELF_BACKUP_DIR)"
ORIGIN="$(choose "$ARG_ORIGIN" APP_ORIGIN APP_ORIGIN)"
PORT_VALUE="$(choose "$ARG_PORT" PORT PORT)"
COOKIE_VALUE="$(choose "$ARG_COOKIE_SECURE" COOKIE_SECURE COOKIE_SECURE)"
PORT_VALUE="${PORT_VALUE:-8080}"
COOKIE_VALUE="${COOKIE_VALUE:-false}"

[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail 'provide --project with lowercase letters, numbers, dash, or underscore'
[[ "$VOLUME" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || fail 'provide --volume with Docker volume-name characters'
[[ "$BACKUP_DIR" == /* ]] || fail '--backup-dir must be an absolute persistent host path outside this checkout'
[[ "$BACKUP_DIR" != *$'\n'* && "$BACKUP_DIR" != *$'\r'* && "$BACKUP_DIR" != *'"'* ]] || fail 'backup path contains unsupported characters'
[[ "$PORT_VALUE" =~ ^[0-9]{1,5}$ ]] && (( PORT_VALUE >= 1 && PORT_VALUE <= 65535 )) || fail 'port must be an integer between 1 and 65535'
[[ "$COOKIE_VALUE" == true || "$COOKIE_VALUE" == false ]] || fail '--cookie-secure must be true or false'
[[ "$ORIGIN" =~ ^https?://([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(:[0-9]{1,5})?$ ]] || fail 'provide an exact http(s) --origin without a path or trailing slash'
if [[ "$ORIGIN" =~ :([0-9]+)$ ]]; then (( BASH_REMATCH[1] >= 1 && BASH_REMATCH[1] <= 65535 )) || fail 'origin port is out of range'; fi
[[ -f "$ENV_FILE" || -n "$ARG_ORIGIN" || -n "${APP_ORIGIN:-}" ]] || fail 'first run requires --origin URL so the one-time .env can be configured safely'

# Avoid accidental MSYS argument rewriting. Convert host paths explicitly for Docker Desktop.
DOCKER_ROOT="$ROOT"
DOCKER_BACKUP_DIR="$BACKUP_DIR"
case "${OSTYPE:-}" in
  msys*|cygwin*)
    command -v cygpath >/dev/null 2>&1 || fail 'Git Bash cygpath is required on Windows'
    DOCKER_ROOT="$(cygpath -m -- "$ROOT")"
    DOCKER_BACKUP_DIR="$(cygpath -m -- "$BACKUP_DIR")"
    export MSYS_NO_PATHCONV=1
    ;;
esac
BACKUP_LEXICAL="$(realpath -m -s -- "$BACKUP_DIR")" || fail 'cannot normalize backup path'
BACKUP_RESOLVED="$(realpath -m -- "$BACKUP_DIR")" || fail 'cannot resolve backup path'
[[ "$BACKUP_LEXICAL" == "$BACKUP_RESOLVED" ]] || fail 'backup directory path must not contain symlinks'
BACKUP_DIR="$BACKUP_RESOLVED"
if [[ -f "$ENV_FILE" ]]; then
  FILE_PROJECT="$(read_env TEAMSHELF_COMPOSE_PROJECT)" || fail '.env must contain at most one TEAMSHELF_COMPOSE_PROJECT'
  FILE_VOLUME="$(read_env TEAMSHELF_DATA_VOLUME)" || fail '.env must contain at most one TEAMSHELF_DATA_VOLUME'
  FILE_BACKUP="$(read_env TEAMSHELF_BACKUP_DIR)" || fail '.env must contain at most one TEAMSHELF_BACKUP_DIR'
  [[ -z "$FILE_PROJECT" || "$FILE_PROJECT" == "$PROJECT" ]] || fail 'selected Compose project differs from existing .env; refusing to switch project'
  [[ -z "$FILE_VOLUME" || "$FILE_VOLUME" == "$VOLUME" ]] || fail 'selected data volume differs from existing .env; refusing to switch databases'
  if [[ -n "$FILE_BACKUP" ]]; then
    [[ "$FILE_BACKUP" == /* ]] || fail 'existing .env backup path must be absolute'
    FILE_BACKUP_RESOLVED="$(realpath -m -- "$FILE_BACKUP")" || fail 'cannot resolve existing .env backup path'
    [[ "$FILE_BACKUP_RESOLVED" == "$BACKUP_DIR" ]] || fail 'selected backup directory differs from existing .env; preserve the configured backup target'
  fi
fi
case "$BACKUP_DIR" in /tmp|/tmp/*|/var/tmp|/var/tmp/*) fail 'backup directory must be persistent, not temporary' ;; esac
case "$BACKUP_DIR" in "$ROOT"|"$ROOT"/*) fail 'backup directory must be outside the checkout' ;; esac
BACKUP_DIR_CREATED=0
if [[ ! -e "$BACKUP_DIR" && ! -L "$BACKUP_DIR" ]]; then
  mkdir -p -- "$(dirname -- "$BACKUP_DIR")"
  if mkdir -m 700 -- "$BACKUP_DIR" 2>/dev/null; then BACKUP_DIR_CREATED=1
  elif [[ ! -d "$BACKUP_DIR" ]]; then fail 'cannot create backup directory'; fi
fi
[[ -d "$BACKUP_DIR" && ! -L "$BACKUP_DIR" ]] || fail 'backup path must be a real directory'
if (( BACKUP_DIR_CREATED )); then
  case "${OSTYPE:-}" in
    msys*|cygwin*) ;;
    *)
      HOST_UID="$(id -u)"
      "$DOCKER_BIN" run --rm --network none --user 0:0 --mount "type=bind,source=$BACKUP_DIR,target=/backup" --env "HOST_UID=$HOST_UID" --entrypoint node node:24-bookworm-slim -e "import('node:fs/promises').then(async fs=>{if((await fs.readdir('/backup')).length)throw new Error('new backup directory is not empty');await fs.chown('/backup',Number(process.env.HOST_UID),1000);await fs.chmod('/backup',0o770)})" || fail 'cannot prepare new backup directory for the host user and container group 1000'
      BACKUP_OWNER="$(stat -c '%u:%g:%a' -- "$BACKUP_DIR")" || fail 'cannot inspect initialized backup directory ownership'
      [[ "$BACKUP_OWNER" == "$HOST_UID:1000:770" ]] || fail 'new backup directory must remain host-owned and writable by container group 1000'
      ;;
  esac
fi
BACKUP_MODE="$(stat -c %a -- "$BACKUP_DIR")" || fail 'cannot inspect backup directory mode'
if (( BACKUP_DIR_CREATED )); then
  case "${OSTYPE:-}" in
    msys*|cygwin*) ;;
    *) [[ "$BACKUP_OWNER" == "$(id -u):1000:770" ]] || fail 'new backup directory permissions are invalid' ;;
  esac
else
  case "${OSTYPE:-}" in
    msys*|cygwin*) ;;
    *)
      BACKUP_OWNER="$(stat -c '%u:%g:%a' -- "$BACKUP_DIR")" || fail 'cannot inspect backup directory ownership'
      [[ "$BACKUP_OWNER" == "$(id -u):1000:770" ]] || (( (8#$BACKUP_MODE & 0022) == 0 || (8#$BACKUP_MODE & 01000) != 0 )) || fail 'backup directory must not be group/world writable unless sticky-bit protected'
      ;;
  esac
fi

LOCK_DIR="$BACKUP_DIR/.teamshelf-release-volume-$VOLUME.lock"
mkdir -m 700 -- "$LOCK_DIR" 2>/dev/null || fail 'another deployment is running or a stale lock exists; inspect the shared volume lock before retrying'
trap 'rmdir -- "$LOCK_DIR" 2>/dev/null || true' EXIT
# Build an exact external-volume Compose config; no project/volume is inferred.
export TEAMSHELF_COMPOSE_PROJECT="$PROJECT" TEAMSHELF_DATA_VOLUME="$VOLUME" TEAMSHELF_BACKUP_DIR="$BACKUP_DIR"
export APP_ORIGIN="$ORIGIN" PORT="$PORT_VALUE" COOKIE_SECURE="$COOKIE_VALUE"
COMPOSE=("$DOCKER_BIN" compose --env-file "$ENV_FILE" -p "$PROJECT" -f "$COMPOSE_FILE")

# Preflight TeamShelf containers before creating .env or touching any volume.
ALL_IDS="$("$DOCKER_BIN" ps -aq --filter 'label=com.docker.compose.service=teamshelf')" || fail 'cannot enumerate TeamShelf containers'
mapfile -t ALL_CONTAINERS <<< "$ALL_IDS"
PROJECT_IDS="$("$DOCKER_BIN" ps -aq --filter "label=com.docker.compose.project=$PROJECT" --filter 'label=com.docker.compose.service=teamshelf')" || fail 'cannot enumerate selected project containers'
mapfile -t PROJECT_CONTAINERS <<< "$PROJECT_IDS"
OLD_CONTAINER="${PROJECT_CONTAINERS[0]:-}"
for candidate in "${ALL_CONTAINERS[@]}"; do [[ -z "$candidate" || "$candidate" == "$OLD_CONTAINER" ]] || fail 'another TeamShelf container belongs to a different Compose project; refusing to select another database'; done
(( ${#PROJECT_CONTAINERS[@]} <= 1 )) || fail 'multiple TeamShelf containers use the selected Compose project'
OLD_IMAGE=""; OLD_RUNNING=0
if [[ -n "$OLD_CONTAINER" ]]; then
  LABEL_PROJECT="$("$DOCKER_BIN" inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$OLD_CONTAINER")" || fail 'cannot inspect existing container project label'
  LABEL_SERVICE="$("$DOCKER_BIN" inspect -f '{{ index .Config.Labels "com.docker.compose.service" }}' "$OLD_CONTAINER")" || fail 'cannot inspect existing container service label'
  OLD_VOLUME="$("$DOCKER_BIN" inspect -f '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}' "$OLD_CONTAINER")" || fail 'cannot inspect existing container data mount'
  [[ "$LABEL_PROJECT" == "$PROJECT" && "$LABEL_SERVICE" == teamshelf ]] || fail 'existing TeamShelf container identity differs from selected project'
  [[ "$OLD_VOLUME" == "$VOLUME" ]] || fail "existing TeamShelf container uses another data volume; refusing to switch databases"
  OLD_IMAGE="$("$DOCKER_BIN" inspect -f '{{.Image}}' "$OLD_CONTAINER")"
  [[ "$("$DOCKER_BIN" inspect -f '{{.State.Status}}' "$OLD_CONTAINER")" == running ]] && OLD_RUNNING=1
fi

VOLUME_IDS="$("$DOCKER_BIN" volume ls -q)" || fail 'cannot list Docker volumes'
VOLUME_EXISTS=0
while IFS= read -r item; do [[ "$item" == "$VOLUME" ]] && VOLUME_EXISTS=1; done <<< "$VOLUME_IDS"
if (( VOLUME_EXISTS )); then
  VOLUME_PROJECT="$("$DOCKER_BIN" volume inspect -f '{{if .Labels}}{{index .Labels "com.docker.compose.project"}}{{end}}' "$VOLUME")" || fail 'cannot inspect selected Docker volume project label'
  VOLUME_KEY="$("$DOCKER_BIN" volume inspect -f '{{if .Labels}}{{index .Labels "com.docker.compose.volume"}}{{end}}' "$VOLUME")" || fail 'cannot inspect selected Docker volume key label'
  [[ -z "$VOLUME_PROJECT" || "$VOLUME_PROJECT" == "$PROJECT" ]] || fail 'selected volume has a different Compose project label'
  [[ -z "$VOLUME_KEY" || "$VOLUME_KEY" == teamshelf-data ]] || fail 'selected volume has a different Compose volume label'
else
  (( INIT_VOLUME == 1 )) || fail "Docker volume '$VOLUME' is missing; first install requires --init-volume"
fi
ATTACHED_IDS="$("$DOCKER_BIN" ps -aq --filter "volume=$VOLUME")" || fail 'cannot enumerate selected volume users'
mapfile -t ATTACHED_CONTAINERS <<< "$ATTACHED_IDS"
for candidate in "${ATTACHED_CONTAINERS[@]}"; do [[ -z "$candidate" || "$candidate" == "$OLD_CONTAINER" ]] || fail 'selected data volume is attached to another container'; done

# Create initial .env only after all user inputs and identity checks pass.
if [[ ! -f "$ENV_FILE" ]]; then
  [[ -n "$ARG_ORIGIN" || -n "${APP_ORIGIN:-}" ]] || fail 'initial configuration needs an explicit --origin URL'
  CONFIGURE_USER=()
  case "${OSTYPE:-}" in msys*|cygwin*) ;; *) CONFIGURE_USER=(--user "$(id -u):$(id -g)") ;; esac
  (cd -- "$ROOT" && MSYS_NO_PATHCONV=1 "$DOCKER_BIN" run --rm "${CONFIGURE_USER[@]}" --mount "type=bind,source=$DOCKER_ROOT,target=/work" --workdir /work \
    --env "APP_ORIGIN=$ORIGIN" --env "PORT=$PORT_VALUE" --env "COOKIE_SECURE=$COOKIE_VALUE" --env DATA_DIR=./data \
    node:24-bookworm-slim node scripts/configure.mjs) || fail 'Docker could not create the private .env; no existing config was replaced'
  printf 'TEAMSHELF_COMPOSE_PROJECT=%s\nTEAMSHELF_DATA_VOLUME=%s\nTEAMSHELF_BACKUP_DIR="%s"\n' "$PROJECT" "$VOLUME" "$BACKUP_DIR" >> "$ENV_FILE"
  chmod 600 "$ENV_FILE" 2>/dev/null || true
else
  FILE_ORIGIN="$(read_env APP_ORIGIN)" || fail '.env must contain exactly one APP_ORIGIN'
  [[ "$ORIGIN" == "$FILE_ORIGIN" ]] || fail 'selected APP_ORIGIN differs from existing .env; preserve and correct the configuration explicitly'
fi

"${COMPOSE[@]}" config --quiet >/dev/null 2>&1 || fail 'source Compose config is invalid; existing service was not stopped'
CONFIG_JSON="$("${COMPOSE[@]}" config --format json 2>/dev/null)" || fail 'cannot resolve source Compose configuration'
printf '%s' "$CONFIG_JSON" | "$DOCKER_BIN" run --rm -i --network none --env "EXPECTED_PROJECT=$PROJECT" --env "EXPECTED_VOLUME=$VOLUME" --entrypoint node node:24-bookworm-slim --input-type=module -e '
  let input = ""; for await (const chunk of process.stdin) input += chunk;
  const config = JSON.parse(input);
  const mount = config.services?.teamshelf?.volumes?.find((item) => item.target === "/app/data" && item.type === "volume");
  const volume = config.volumes?.["teamshelf-data"];
  if (config.name !== process.env.EXPECTED_PROJECT || mount?.source !== "teamshelf-data" || volume?.name !== process.env.EXPECTED_VOLUME || volume?.external !== true) process.exit(1);
' || fail 'resolved Compose project/volume differs from explicit selections'
unset CONFIG_JSON

# Build before stopping an existing service; verify the image and backup mount before downtime.
"${COMPOSE[@]}" build teamshelf || fail 'Docker image build failed; existing service remains running'
if (( ! VOLUME_EXISTS )); then
  (( INIT_VOLUME == 1 )) || fail 'volume disappeared before explicit initialization'
  "$DOCKER_BIN" volume create "$VOLUME" >/dev/null || fail 'could not create explicitly requested data volume'
fi
DB_EXISTS="$("$DOCKER_BIN" run --rm --network none --user 0:0 --mount "type=volume,src=$VOLUME,dst=/app/data" --entrypoint node node:24-bookworm-slim -e "import('node:fs').then(fs=>process.stdout.write(fs.existsSync('/app/data/teamshelf.sqlite')?'yes':'no'))")" || fail 'cannot inspect selected data volume'
if [[ "$DB_EXISTS" != yes ]]; then
  EMPTY_DIR="$("$DOCKER_BIN" run --rm --network none --user 0:0 --mount "type=volume,src=$VOLUME,dst=/app/data" --entrypoint node node:24-bookworm-slim -e "import('node:fs').then(fs=>process.stdout.write(fs.readdirSync('/app/data').length?'no':'yes'))")" || fail 'cannot inspect selected volume contents'
  [[ "$EMPTY_DIR" == yes && "$INIT_VOLUME" == 1 && -z "$OLD_CONTAINER" ]] || fail 'selected volume lacks a database and is not an explicitly authorized empty first install'
  "$DOCKER_BIN" run --rm --network none --user 0:0 --mount "type=volume,src=$VOLUME,dst=/app/data" --entrypoint node node:24-bookworm-slim -e "import('node:fs/promises').then(fs=>fs.chown('/app/data',1000,1000))" || fail 'cannot prepare initialized volume ownership'
  printf 'First initialization: empty volume explicitly authorized.\n'
else
  ATTACHED_LOCK="$("$DOCKER_BIN" run --rm --network none --user 0:0 --mount "type=volume,src=$VOLUME,dst=/app/data" --entrypoint node node:24-bookworm-slim -e "import('node:fs').then(fs=>process.stdout.write(fs.existsSync('/app/data/.teamshelf.lock')?'yes':'no'))")" || fail 'cannot inspect selected volume lock'
  [[ "$ATTACHED_LOCK" == no || "$OLD_RUNNING" == 1 ]] || fail 'database lock exists; verify no instance is active before retrying'
fi

mkdir -p -- "$BACKUP_DIR"
BACKUP_DOCKER_DIR="$DOCKER_BACKUP_DIR"
PROBE=".teamshelf-source-probe-$$"
"$DOCKER_BIN" run --rm --network none --user 1000:1000 --mount "type=bind,source=$BACKUP_DOCKER_DIR,target=/backup" --entrypoint node node:24-bookworm-slim -e "import('node:fs/promises').then(async fs=>{await fs.writeFile('/backup/$PROBE','ok',{flag:'wx'});await fs.unlink('/backup/$PROBE')})" || fail 'backup path is not writable by the container app user; old service was not stopped'

if [[ "$DB_EXISTS" == yes ]]; then
  if (( OLD_RUNNING )); then "${COMPOSE[@]}" stop teamshelf >/dev/null || fail 'old service did not stop cleanly; backup/replacement not attempted'; fi
  STOPPED_LOCK="$("$DOCKER_BIN" run --rm --network none --user 0:0 --mount "type=volume,src=$VOLUME,dst=/app/data" --entrypoint node node:24-bookworm-slim -e "import('node:fs').then(fs=>process.stdout.write(fs.existsSync('/app/data/.teamshelf.lock')?'yes':'no'))")" || {
    if (( OLD_RUNNING )); then "${COMPOSE[@]}" start teamshelf >/dev/null || printf 'WARNING: old service did not restart; inspect Docker state.\n' >&2; fi
    fail 'could not verify lock release after stopping; old service restart attempted'
  }
  [[ "$STOPPED_LOCK" == no ]] || {
    if (( OLD_RUNNING )); then "${COMPOSE[@]}" start teamshelf >/dev/null || printf 'WARNING: old service did not restart; inspect Docker state.\n' >&2; fi
    fail 'stopped service still has a database lock; old service restart attempted'
  }
  if "$DOCKER_BIN" run --rm --network none --user 1000:1000 --mount "type=volume,src=$VOLUME,dst=/app/data" --mount "type=bind,source=$DOCKER_BACKUP_DIR,target=/backup" --mount "type=bind,source=$DOCKER_ROOT/scripts,dst=/workspace/scripts,readonly" --env DATA_DIR=/app/data --entrypoint node node:24-bookworm-slim /workspace/scripts/backup.mjs "/backup/teamshelf-$(date -u +%Y%m%dT%H%M%SZ)-$$.sqlite" >/dev/null; then
    printf 'Consistent SQLite backup created under %s\n' "$BACKUP_DIR"
  else
    if (( OLD_RUNNING )); then "${COMPOSE[@]}" start teamshelf >/dev/null || printf 'WARNING: old service did not restart; inspect Docker state.\n' >&2; fi
    fail 'consistent backup failed; old service restart attempted, replacement was not started'
  fi
fi

"${COMPOSE[@]}" up -d --force-recreate --no-deps teamshelf >/dev/null || fail 'new service failed to start; data volume was retained and no automatic restore was attempted'
DEADLINE=$((SECONDS + 180))
while (( SECONDS < DEADLINE )); do
  CID="$("${COMPOSE[@]}" ps -q teamshelf 2>/dev/null || true)"
  if [[ -n "$CID" ]]; then
    HEALTH="$("$DOCKER_BIN" inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CID" 2>/dev/null || true)"
    [[ "$HEALTH" == healthy ]] && { printf 'TeamShelf is healthy at %s\n' "$ORIGIN"; exit 0; }
    STATE="$("$DOCKER_BIN" inspect -f '{{.State.Status}}' "$CID" 2>/dev/null || true)"
    [[ "$STATE" == exited || "$STATE" == dead ]] && break
  fi
  sleep 3
done
DIAG_DIR="$BACKUP_DIR"
DIAG_FILE="$DIAG_DIR/source-deploy-failure-$(date -u +%Y%m%dT%H%M%SZ)-$$.log"
: > "$DIAG_FILE"; chmod 600 "$DIAG_FILE"
"${COMPOSE[@]}" ps -a >>"$DIAG_FILE" 2>&1 || true
"${COMPOSE[@]}" logs --no-color --tail=200 teamshelf >>"$DIAG_FILE" 2>&1 || true
"${COMPOSE[@]}" stop teamshelf >/dev/null 2>&1 || true
printf 'ERROR: health check failed; new service stopped, volume and backup retained; no automatic restore/rollback. Diagnostics: %s\n' "$DIAG_FILE" >&2
exit 1

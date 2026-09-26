#!/usr/bin/env bash
set -Eeuo pipefail
trap 'status=$?; printf "source-up test failed at line %s (exit %s)\n" "$LINENO" "$status" >&2; exit "$status"' ERR
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP" "$BACKUP_DIR"' EXIT
TEST_ROOT="$TMP/project with spaces"
BACKUP_DIR="$HOME/.teamshelf-source-test-$$"
mkdir -p "$TEST_ROOT/deploy" "$TEST_ROOT/scripts" "$TMP/bin" "$BACKUP_DIR"
cp "$ROOT/deploy/source-up.sh" "$TEST_ROOT/deploy/source-up.sh"
cp "$ROOT/compose.yaml" "$TEST_ROOT/compose.yaml"
cp "$ROOT/scripts/configure.mjs" "$TEST_ROOT/scripts/configure.mjs"
cp "$ROOT/scripts/backup.mjs" "$TEST_ROOT/scripts/backup.mjs"
cat >"$TEST_ROOT/.env" <<ENV
TEAMSHELF_COMPOSE_PROJECT=teamshelf-mock
TEAMSHELF_DATA_VOLUME=teamshelf-mock-data
TEAMSHELF_BACKUP_DIR="$BACKUP_DIR"
APP_ORIGIN=http://localhost:8080
ENV
printf '%s\n' "SETUP_TOKEN='\$(touch $TMP/dotenv-was-executed)'" >> "$TEST_ROOT/.env"
cp "$TEST_ROOT/.env" "$TMP/env.before"

cat >"$TMP/bin/docker-mock" <<'MOCK'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >>"$MOCK_LOG"
if [[ "$1" == compose ]]; then
  case "$*" in
    *'version'*) exit 0 ;;
    *'config --quiet'*) exit 0 ;;
    *'config --format json'*) printf '{"name":"teamshelf-mock","services":{"teamshelf":{"volumes":[{"type":"volume","source":"teamshelf-data","target":"/app/data"}]}},"volumes":{"teamshelf-data":{"name":"teamshelf-mock-data","external":true}}}\n'; exit 0 ;;
    *' build '*) printf 'compose-build\n' >>"$MOCK_EVENTS"; exit 0 ;;
    *' stop teamshelf'*) printf 'compose-stop\n' >>"$MOCK_EVENTS"; exit 0 ;;
    *' start teamshelf'*) printf 'compose-start\n' >>"$MOCK_EVENTS"; exit 0 ;;
    *' up -d '*) printf 'compose-up\n' >>"$MOCK_EVENTS"; exit 0 ;;
    *' ps -q teamshelf'*) printf 'new-container\n'; exit 0 ;;
    *' ps -a'*) printf 'teamshelf state\n'; exit 0 ;;
    *' logs '*) printf 'controlled test diagnostic\n'; exit 0 ;;
    *) exit 0 ;;
  esac
fi
case "$1" in
  ps)
    if [[ "$MOCK_OLD_CONTAINER" == 1 && "$*" == *'label=com.docker.compose.project=teamshelf-mock'* ]]; then printf 'old-container\n'; elif [[ "$MOCK_OLD_CONTAINER" == 1 && "$*" == *'label=com.docker.compose.service=teamshelf'* ]]; then printf 'old-container\n'; fi
    exit 0 ;;
  inspect)
    case "$*" in
      *com.docker.compose.project*) if [[ -n "${MOCK_BAD_PROJECT:-}" ]]; then printf 'wrong-project\n'; else printf 'teamshelf-mock\n'; fi ;;
      *com.docker.compose.service*) printf 'teamshelf\n' ;;
      *Destination*) printf 'teamshelf-mock-data\n' ;;
      *'.Image'*) printf 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' ;;
      *'.State.Health'*) printf 'unhealthy\n' ;;
      *'.State.Status'*new-container*) printf 'exited\n' ;;
      *'.State.Status'*) printf 'running\n' ;;
      *) exit 1 ;;
    esac
    ;;
  volume)
    case "$2" in
      ls) [[ "$MOCK_VOLUME_EXISTS" == 1 ]] && printf 'teamshelf-mock-data\n'; exit 0 ;;
      inspect) [[ "$MOCK_VOLUME_EXISTS" == 1 ]] && { printf '\n'; exit 0; }; exit 1 ;;
      create) printf 'volume-create\n' >>"$MOCK_EVENTS"; exit 0 ;;
    esac ;;
  run)
    case "$*" in
      *'--input-type=module'*) cat >/dev/null; exit 0 ;;
      *''.teamshelf.lock''*)
        if grep -q ''^compose-stop$'' "$MOCK_EVENTS" && [[ "${MOCK_LOCK_CHECK_FAIL:-0}" == 1 ]]; then exit 7; fi
        if grep -q ''^compose-stop$'' "$MOCK_EVENTS" && [[ "${MOCK_LOCK_REMAINS:-0}" == 1 ]]; then printf ''yes''; else printf ''%s'' "${MOCK_LOCK:-no}"; fi
        exit 0 ;;
      *'fs.existsSync'*) [[ "${MOCK_DB_EXISTS}" == 1 ]] && printf 'yes' || printf 'no'; exit 0 ;;
      *'readdirSync'*) printf 'yes'; exit 0 ;;
      *'backup.mjs'*)
        if [[ "$MOCK_BACKUP_FAIL" == 1 ]]; then exit 1; fi
        for arg in "$@"; do [[ "$arg" == /backup/* ]] && : >"$MOCK_BACKUP_DIR/${arg##*/}"; done
        exit 0 ;;
      *'fs.writeFile'*) exit 0 ;;
      *) exit 0 ;;
    esac ;;
esac
exit 0
MOCK
chmod +x "$TMP/bin/docker-mock"
export PATH="$TMP/bin:$PATH" DOCKER_BIN="$TMP/bin/docker-mock"
export MOCK_LOG="$TMP/docker.log" MOCK_EVENTS="$TMP/events" MOCK_BACKUP_DIR="$BACKUP_DIR"
: >"$MOCK_LOG"; : >"$MOCK_EVENTS"

run_case() { (cd "$TEST_ROOT" && bash "$TEST_ROOT/deploy/source-up.sh" --project teamshelf-mock --volume teamshelf-mock-data --backup-dir "$BACKUP_DIR" --origin http://localhost:8080 "$@"); }

# Missing volume without explicit initialization must fail before build/stop/up.
export MOCK_OLD_CONTAINER=0 MOCK_VOLUME_EXISTS=0 MOCK_DB_EXISTS=0 MOCK_BACKUP_FAIL=0
if run_case >"$TMP/missing-init.out" 2>&1; then echo 'expected missing volume rejection' >&2; exit 1; fi
grep -q 'requires --init-volume' "$TMP/missing-init.out"
! grep -Eq 'compose-(stop|up)|volume-create' "$MOCK_EVENTS"

# Existing container identity mismatch must fail before stop.
export MOCK_OLD_CONTAINER=1 MOCK_VOLUME_EXISTS=1 MOCK_BAD_PROJECT=1
: >"$MOCK_EVENTS"
if run_case >"$TMP/project-mismatch.out" 2>&1; then echo 'expected project mismatch rejection' >&2; exit 1; fi
grep -q 'identity differs' "$TMP/project-mismatch.out"
! grep -q '^compose-stop$' "$MOCK_EVENTS"
unset MOCK_BAD_PROJECT
# Existing env cannot silently switch the named data volume.
cp "$TMP/env.before" "$TEST_ROOT/.env"
sed -i 's/TEAMSHELF_DATA_VOLUME=teamshelf-mock-data/TEAMSHELF_DATA_VOLUME=other-volume/' "$TEST_ROOT/.env"
: >"$MOCK_EVENTS"
if run_case >"$TMP/env-volume-mismatch.out" 2>&1; then echo 'expected .env volume mismatch rejection' >&2; exit 1; fi
grep -q 'differs from existing .env' "$TMP/env-volume-mismatch.out"
! grep -Eq '^compose-(stop|up)$|^volume-create$' "$MOCK_EVENTS"
cp "$TMP/env.before" "$TEST_ROOT/.env"

# Source and release entry points share the same atomic deployment lock.
SHARED_LOCK="$BACKUP_DIR/.teamshelf-release-volume-teamshelf-mock-data.lock"
mkdir "$SHARED_LOCK"
: >"$MOCK_LOG"
if run_case >"$TMP/shared-lock.out" 2>&1; then echo 'expected shared lock rejection' >&2; exit 1; fi
grep -q 'another deployment is running' "$TMP/shared-lock.out"
! grep -Eq 'stop|up|volume create' "$MOCK_LOG"
rmdir "$SHARED_LOCK"

# A failed consistent backup restarts the old service and never brings up replacement.
export MOCK_OLD_CONTAINER=1 MOCK_VOLUME_EXISTS=1 MOCK_DB_EXISTS=1 MOCK_BACKUP_FAIL=1
: >"$MOCK_EVENTS"
if run_case >"$TMP/backup-failure.out" 2>&1; then echo 'expected backup failure' >&2; exit 1; fi
grep -q 'consistent backup failed' "$TMP/backup-failure.out"
grep -q '^compose-stop$' "$MOCK_EVENTS"
grep -q '^compose-start$' "$MOCK_EVENTS"
! grep -q '^compose-up$' "$MOCK_EVENTS"

# A failed post-stop lock check restarts the prior running instance.
export MOCK_BACKUP_FAIL=0 MOCK_LOCK_CHECK_FAIL=1
: >"$MOCK_EVENTS"
if run_case >"$TMP/lock-check-failure.out" 2>&1; then echo 'expected post-stop lock query failure' >&2; exit 1; fi
grep -q 'lock release after stopping' "$TMP/lock-check-failure.out"
grep -q '^compose-stop$' "$MOCK_EVENTS"
grep -q '^compose-start$' "$MOCK_EVENTS"
! grep -q '^compose-up$' "$MOCK_EVENTS"
unset MOCK_LOCK_CHECK_FAIL

# A lock that remains after stop also restarts the prior running instance.
export MOCK_LOCK_REMAINS=1
: >"$MOCK_EVENTS"
if run_case >"$TMP/stale-lock.out" 2>&1; then echo 'expected remaining lock rejection' >&2; exit 1; fi
grep -q 'still has a database lock' "$TMP/stale-lock.out"
grep -q '^compose-start$' "$MOCK_EVENTS"
! grep -q '^compose-up$' "$MOCK_EVENTS"
unset MOCK_LOCK_REMAINS
# Health failure stops the new instance and retains backup/volume without restore/delete.
export MOCK_BACKUP_FAIL=0
: >"$MOCK_EVENTS"; : >"$MOCK_LOG"
if run_case >"$TMP/health-failure.out" 2>&1; then echo 'expected health failure' >&2; exit 1; fi
grep -q 'health check failed' "$TMP/health-failure.out"
grep -q '^compose-up$' "$MOCK_EVENTS"
[[ "$(grep -c '^compose-stop$' "$MOCK_EVENTS")" -eq 2 ]]
! grep -Eq 'volume rm|down -v|restore.mjs' "$MOCK_LOG"
compgen -G "$BACKUP_DIR/teamshelf-*.sqlite" >/dev/null

# Dotenv is parsed as data, not executed; secret-like marker never appears in output.
[[ ! -e "$TMP/dotenv-was-executed" ]]
! grep -R -F '$(touch' "$TMP"/*.out >/dev/null
cmp -s "$TMP/env.before" "$TEST_ROOT/.env"
printf 'source-up mocks passed: missing-init, project-mismatch, backup recovery, health failure, dotenv literal\n'

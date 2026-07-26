# Bublik Bot

Модульный Discord-бот для EREZ на TypeScript: полковые бои War Thunder, экономика,
онбординг, временные голосовые каналы, отпуска, команды и локализация. PostgreSQL
хранит постоянное состояние, Redis — временное и координационное.

## Возможности

- Полковые бои: отряды, панели управления, пинги, приказы, выговоры и апелляции.
- Экономика: шекели, задания, магазин, казино, ограбления, крафт и рейтинги.
- Онбординг: правила, приветствия, роли, напоминания и переход к рекрутингу.
- Временные войсы: создание каналов, права, лимиты, переносы и награды за время.
- Отпуска: заявки, модерация, личные уведомления и восстановление ролей.
- Локализация: русский и английский языки с настройкой для каждого сервера.

Продуктовая дорожная карта находится в
[docs/PRODUCT_ROADMAP.md](docs/PRODUCT_ROADMAP.md). Запланированные функции по
умолчанию выключены и не входят в текущий reliability-релиз.

## Локальный запуск

~~~bash
set -euo pipefail
cd "/absolute/path/to/Bublik n"
cp .env.example .env
printf '%s\n' 'Заполните DISCORD_TOKEN, DISCORD_CLIENT_ID и пароли в .env перед запуском.'
docker compose -p bublik-n config --quiet
docker compose -p bublik-n up -d --build
~~~

Для запуска без Docker:

~~~bash
set -euo pipefail
cd "/absolute/path/to/Bublik n"
npm ci
npm run db:generate
npm run db:migrate:deploy
npm run dev
~~~

Production-entrypoint применяет только версионированные Prisma-миграции. Старый
production, ранее созданный через prisma db push, разрешено базировать ровно один
раз флагом PRISMA_BASELINE_EXISTING=1 в отдельном migration-only контейнере.
Обычный запуск всегда выполняется со значением 0.

## Безопасная production-выкладка

Этот runbook предназначен только для TypeScript-бота в /opt/bublik-n и Compose
project bublik-n с контейнерами bublik-bot, bublik-postgres и bublik-redis. Python-
бота с похожим именем он не затрагивает.

Ниже описан повторный upgrade уже мигрированного production: для текущего
перехода с четырёх применённых миграций на шесть все data-gate вызовы используют
явные `--preflight-operational`, `--snapshot-operational` и
`--postflight-operational`, а migration-only контейнер — только
`PRISMA_BASELINE_EXISTING=0`. Строгие режимы без суффикса `-operational` и
одноразовый baseline resolve относятся лишь к первоначальному legacy cutover и
не должны подменять команды повторного upgrade.

Никогда не используй docker compose down, ключ -v, неявное имя Compose project,
сборку на production из активного каталога или плавающий образ при восстановлении.
Не изменяй /opt/bublik-n/docker-compose.yml и /opt/bublik-n/locales, пока старый
бот работает. Все секретные отчёты, дампы и env ниже имеют владельца root:root и
режим 0600; каталоги — 0700.

Оператор выполняет maintenance-этапы из tmux. Маркеры состояния лишь помогают
ориентироваться после разрыва SSH; источником истины остаются checksum-манифесты,
точные image ID и фактическое состояние контейнеров.

### 0. Собрать immutable linux/amd64 артефакт вне production

Этот блок выполняется от root на доверенном Linux build-host, не на работающем
VPS. Исходный checkout должен быть чистым и указывать на проверенный commit.
Артефакт содержит образ, Compose и locales; .env в него не входит.

~~~bash
set -euo pipefail
umask 077
test "$(id -u)" -eq 0
test -n "$BUBLIK_RELEASE_SOURCE"

source_root="$(readlink -f -- "$BUBLIK_RELEASE_SOURCE")"
test -d "$source_root/.git"
cd "$source_root"
test -z "$(git status --porcelain)"
if git ls-files --eol | grep -Eq 'w/(crlf|mixed)'; then
  echo 'tracked release files must use canonical LF line endings' >&2
  exit 1
fi

source_commit="$(git rev-parse HEAD)"
printf '%s\n' "$source_commit" | grep -Eq '^[0-9a-f]{40}$'
source_tree="$(git rev-parse "$source_commit^{tree}")"
printf '%s\n' "$source_tree" | grep -Eq '^[0-9a-f]{40}$'
source_epoch="$(git show -s --format=%ct "$source_commit")"
printf '%s\n' "$source_epoch" | grep -Eq '^[1-9][0-9]{9,}$'
release_created="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
printf '%s\n' "$release_created" |
  grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
release_timestamp="${release_created//-/}"
release_timestamp="${release_timestamp//:/}"
release_id="$release_timestamp-${source_commit:0:12}"
test "${release_id##*-}" = "${source_commit:0:12}"
release_source="$(git remote get-url origin)"
case "$release_source" in
  git@github.com:*) release_source="https://github.com/${release_source#git@github.com:}" ;;
  https://github.com/*) ;;
  *) echo 'origin должен указывать на GitHub без встроенных credentials' >&2; exit 1 ;;
esac
printf '%s\n' "$release_source" |
  grep -Eq '^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+(\.git)?$'
release_root=/root/releases/bublik-ts
release_dir="$release_root/$release_id"
release_image="bublik-n-bot:release-$release_id"
baseline_sha=747765d336220ebc34616d425f7566fba238c1ed7f5866c6f63d2f326bdb6d0a

test ! -e "$release_dir"
install -d -o root -g root -m 0700 "$release_root" "$release_dir"

release_image_tar="$release_dir/bublik-image.tar"
repro_image_tar="$release_dir/bublik-image.repro.tar"
test ! -e "$release_image_tar"
test ! -e "$repro_image_tar"

build_release_image() {
  output="$1"
  docker buildx build \
    --platform linux/amd64 \
    --no-cache \
    --provenance=false \
    --sbom=false \
    --output "type=docker,dest=$output,rewrite-timestamp=true" \
    --tag "$release_image" \
    --build-arg SOURCE_DATE_EPOCH="$source_epoch" \
    --build-arg BUBLIK_RELEASE_REVISION="$source_commit" \
    --build-arg BUBLIK_RELEASE_CREATED="$release_created" \
    --build-arg BUBLIK_RELEASE_VERSION="$release_id" \
    --build-arg BUBLIK_RELEASE_SOURCE="$release_source" \
    --build-arg BUBLIK_RELEASE_SOURCE_TREE="$source_tree" \
    --build-arg BUBLIK_RELEASE_BASE_COMMIT="$source_commit" \
    "$source_root"
}

build_release_image "$release_image_tar"
docker load --input "$release_image_tar" >/dev/null
release_image_id="$(docker image inspect -f '{{.Id}}' "$release_image")"
printf '%s\n' "$release_image_id" | grep -Eq '^sha256:[0-9a-f]{64}$'
build_release_image "$repro_image_tar"
docker load --input "$repro_image_tar" >/dev/null
test "$(docker image inspect -f '{{.Id}}' "$release_image")" = "$release_image_id"
cmp -- "$release_image_tar" "$repro_image_tar"
rm -- "$repro_image_tar"
test ! -e "$repro_image_tar"
test "$(docker image inspect -f '{{.Os}}/{{.Architecture}}' "$release_image")" = linux/amd64
test "$(docker image inspect -f '{{.Config.User}}' "$release_image")" = node
docker image inspect "$release_image" |
  docker run --rm -i --platform linux/amd64 --entrypoint node "$release_image" -e '
    let input="";
    process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{
      const image=JSON.parse(input)[0];
      const health=image.Config.Healthcheck;
      const env=new Set(image.Config.Env);
      const labels=image.Config.Labels||{};
      const [revision,sourceTree,version,created,source]=process.argv.slice(1);
      if(JSON.stringify(health.Test)!==JSON.stringify([
           "CMD","node","dist/core/HealthMarker.js","--check"
         ])||health.Interval!==15000000000||health.Timeout!==5000000000||
         health.StartPeriod!==60000000000||health.Retries!==3||
         !env.has("BUBLIK_HEALTH_FILE=/tmp/bublik-health.json")||
         !env.has("BUBLIK_HEALTH_MAX_AGE_MS=75000")||
         labels["org.opencontainers.image.revision"]!==revision||
         labels["org.opencontainers.image.created"]!==created||
         labels["org.opencontainers.image.version"]!==version||
         labels["org.opencontainers.image.source"]!==source||
         labels["org.opencontainers.image.base.name"]!=="docker.io/library/node:24-alpine"||
         labels["org.opencontainers.image.base.digest"]!=="sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd"||
         labels["io.bublik.release.source-tree"]!==sourceTree||
         labels["io.bublik.release.base-commit"]!==revision||
         labels["io.bublik.build.obfuscator-seed"]!=="1112883788")process.exit(1);
    });
  ' "$source_commit" "$source_tree" "$release_id" "$release_created" "$release_source"

docker run --rm --platform linux/amd64 --entrypoint node "$release_image" -e '
  const fs = require("node:fs");
  if (process.getuid() === 0) process.exit(1);
  for (const file of [
    "/app/dist/index.js",
    "/app/dist/core/HealthMarker.js",
    "/app/scripts/verify-baseline-target.js",
    "/app/scripts/snapshot-baseline-data.js",
    "/app/scripts/snapshot-redis-data.js",
    "/app/scripts/verify-pb-idle.js"
  ]) fs.accessSync(file, fs.constants.R_OK);
'
if docker run --rm --platform linux/amd64 --entrypoint node "$release_image" \
  dist/core/HealthMarker.js --check >/dev/null 2>&1; then
  echo 'Healthcheck без PID 1 и свежего marker неожиданно успешен' >&2
  exit 1
fi

test "$(
  docker run --rm --platform linux/amd64 --entrypoint sha256sum "$release_image" \
    prisma/migrations/20260719000000_baseline/migration.sql |
    awk '{print $1}'
)" = "$baseline_sha"

test -f docker-compose.yml
test -d locales
test -z "$(find locales -type l -print -quit)"
test -f "$release_image_tar"
tar --sort=name --numeric-owner --owner=0 --group=0 \
  -cf "$release_dir/release-files.tar" docker-compose.yml locales

cat > "$release_dir/deployment.env" <<ENV
RELEASE_ID=$release_id
RELEASE_IMAGE=$release_image
RELEASE_IMAGE_ID=$release_image_id
CHECKPOINT_DIR=/root/backups/bublik-ts/cutover-$release_id
SOURCE_COMMIT=$source_commit
SOURCE_TREE=$source_tree
BASELINE_SHA256=$baseline_sha
ENV

chown root:root "$release_dir"/*
chmod 0600 "$release_dir"/*
(
  cd "$release_dir"
  sha256sum deployment.env bublik-image.tar release-files.tar > SHA256SUMS.release
  chmod 0600 SHA256SUMS.release
  sha256sum -c SHA256SUMS.release
)

test "$(stat -c '%U:%G:%a' "$release_dir")" = root:root:700
test -z "$(find "$release_dir" -maxdepth 1 -type f ! -user root -o -maxdepth 1 -type f ! -group root)"
test -z "$(find "$release_dir" -maxdepth 1 -type f ! -perm 0600 -print)"
printf 'RELEASE_ID=%s\nRELEASE_DIR=%s\n' "$release_id" "$release_dir"
~~~

Передача на VPS выполняется только после завершения предыдущего блока. Укажи
VPS_HOST в форме host или user@host и тот же RELEASE_ID, который напечатала сборка.

~~~bash
set -euo pipefail
umask 077
test "$(id -u)" -eq 0
test -n "$RELEASE_ID"
test -n "$VPS_HOST"
printf '%s\n' "$RELEASE_ID" | grep -Eq '^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$'
printf '%s\n' "$VPS_HOST" | grep -Eq '^([A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*$'

release_dir="/root/releases/bublik-ts/$RELEASE_ID"
test "$(readlink -f -- "$release_dir")" = "$release_dir"
test "$(stat -c '%U:%G:%a' "$release_dir")" = root:root:700
test "$(stat -c '%U:%G:%a' "$release_dir/deployment.env")" = root:root:600
test "$(stat -c '%U:%G:%a' "$release_dir/SHA256SUMS.release")" = root:root:600
(cd "$release_dir" && sha256sum -c SHA256SUMS.release)
test "$(find "$release_dir" -mindepth 1 -maxdepth 1 -type f | wc -l)" -eq 4
manifest_sha="$(sha256sum "$release_dir/SHA256SUMS.release" | awk '{print $1}')"

remote_state="$(
ssh "$VPS_HOST" bash -se -- "$RELEASE_ID" "$manifest_sha" <<'REMOTE'
set -euo pipefail
umask 077
test "$(id -u)" -eq 0
release_id="$1"
expected_manifest_sha="$2"
printf '%s\n' "$release_id" | grep -Eq '^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$'
printf '%s\n' "$expected_manifest_sha" | grep -Eq '^[0-9a-f]{64}$'
release_root=/root/releases/bublik-ts
final="$release_root/$release_id"
incoming="$release_root/.$release_id.incoming"
install -d -o root -g root -m 0700 "$release_root"
if test -e "$final"; then
  test "$(readlink -f -- "$final")" = "$final"
  test "$(stat -c '%U:%G:%a' "$final")" = root:root:700
  test "$(find "$final" -mindepth 1 -maxdepth 1 -type f | wc -l)" -eq 4
  test -z "$(find "$final" -mindepth 1 -maxdepth 1 ! -type f -print -quit)"
  test "$(sha256sum "$final/SHA256SUMS.release" | awk '{print $1}')" = "$expected_manifest_sha"
  (cd "$final" && sha256sum -c SHA256SUMS.release >/dev/null)
  printf '%s\n' final
else
  if test -e "$incoming"; then
    test "$(readlink -f -- "$incoming")" = "$incoming"
    test "$(stat -c '%U:%G:%a' "$incoming")" = root:root:700
  else
    install -d -o root -g root -m 0700 "$incoming"
  fi
  printf '%s\n' incoming
fi
REMOTE
)"
case "$remote_state" in
  final|incoming) ;;
  *) exit 1 ;;
esac

if test "$remote_state" = incoming; then
  rsync --archive --delete --chown=root:root --chmod=D700,F600 \
    "$release_dir/" "$VPS_HOST:/root/releases/bublik-ts/.$RELEASE_ID.incoming/"
  ssh "$VPS_HOST" bash -se -- "$RELEASE_ID" "$manifest_sha" <<'REMOTE'
set -euo pipefail
umask 077
release_id="$1"
expected_manifest_sha="$2"
release_root=/root/releases/bublik-ts
incoming="$release_root/.$release_id.incoming"
final="$release_root/$release_id"
test ! -e "$final"
test "$(readlink -f -- "$incoming")" = "$incoming"
test "$(stat -c '%U:%G:%a' "$incoming")" = root:root:700
test "$(find "$incoming" -mindepth 1 -maxdepth 1 -type f | wc -l)" -eq 4
test -z "$(find "$incoming" -mindepth 1 -maxdepth 1 ! -type f -print -quit)"
test "$(sha256sum "$incoming/SHA256SUMS.release" | awk '{print $1}')" = "$expected_manifest_sha"
(cd "$incoming" && sha256sum -c SHA256SUMS.release)
mv "$incoming" "$final"
test "$(readlink -f -- "$final")" = "$final"
REMOTE
fi
printf 'На VPS: export RELEASE_ID=%s\n' "$RELEASE_ID"
~~~

### 1. Проверить release и точную БД без остановки старого бота

На VPS сначала открой защищённую сессию:

~~~bash
set -euo pipefail
test -n "$RELEASE_ID"
printf '%s\n' "$RELEASE_ID" | grep -Eq '^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$'
exec tmux new -As "bublik-$RELEASE_ID"
~~~

Следующий gate ничего не собирает и не меняет в active compose/locales. Он
проверяет подпись артефакта до source, архитектуру, реальные контейнеры и тома,
затем доказывает без вывода логина или пароля, что старый и новый runtime смотрят
строго в postgres:5432/bublik?schema=public и что DNS ведёт именно в
bublik-postgres. В конце запускается operational read-only preflight всех 40
исходных таблиц.

~~~bash
set -euo pipefail
umask 077
test "$(id -u)" -eq 0
test -n "$RELEASE_ID"
release_id="$RELEASE_ID"
printf '%s\n' "$release_id" | grep -Eq '^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$'

project=bublik-n
active=/opt/bublik-n
release_dir="/root/releases/bublik-ts/$release_id"
state_dir="/root/deploy-state/bublik-ts/$release_id"
env_file="$release_dir/deployment.env"

test "$(readlink -f -- "$release_dir")" = "$release_dir"
test "$(stat -c '%U:%G:%a' "$release_dir")" = root:root:700
for file in deployment.env bublik-image.tar release-files.tar SHA256SUMS.release; do
  test "$(stat -c '%U:%G:%a' "$release_dir/$file")" = root:root:600
done
(cd "$release_dir" && sha256sum -c SHA256SUMS.release)
test "$(wc -l < "$env_file")" -eq 7
if grep -Evq '^(RELEASE_ID=[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|RELEASE_IMAGE=bublik-n-bot:release-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|RELEASE_IMAGE_ID=sha256:[0-9a-f]{64}|CHECKPOINT_DIR=/root/backups/bublik-ts/cutover-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|SOURCE_COMMIT=[0-9a-f]{40}|SOURCE_TREE=[0-9a-f]{40}|BASELINE_SHA256=[0-9a-f]{64})$' "$env_file"; then
  echo 'deployment.env содержит недопустимую строку' >&2
  exit 1
fi
for key in RELEASE_ID RELEASE_IMAGE RELEASE_IMAGE_ID CHECKPOINT_DIR SOURCE_COMMIT SOURCE_TREE BASELINE_SHA256; do
  test "$(grep -c "^$key=" "$env_file")" -eq 1
done
. "$env_file"
test "$RELEASE_ID" = "$release_id"
test "$RELEASE_IMAGE" = "bublik-n-bot:release-$release_id"
test "$CHECKPOINT_DIR" = "/root/backups/bublik-ts/cutover-$release_id"
test "$BASELINE_SHA256" = 747765d336220ebc34616d425f7566fba238c1ed7f5866c6f63d2f326bdb6d0a
test "${release_id##*-}" = "${SOURCE_COMMIT:0:12}"
expected_created="${release_id:0:4}-${release_id:4:2}-${release_id:6:2}T${release_id:9:2}:${release_id:11:2}:${release_id:13:2}Z"
printf '%s\n' "$expected_created" |
  grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'

install -d -o root -g root -m 0700 "$(dirname "$state_dir")" "$state_dir"
docker load --input "$release_dir/bublik-image.tar" >/dev/null
test "$(docker image inspect -f '{{.Id}}' "$RELEASE_IMAGE")" = "$RELEASE_IMAGE_ID"
test "$(docker image inspect -f '{{.Os}}/{{.Architecture}}' "$RELEASE_IMAGE_ID")" = linux/amd64
test "$(docker image inspect -f '{{.Config.User}}' "$RELEASE_IMAGE_ID")" = node
docker image inspect "$RELEASE_IMAGE_ID" |
  docker run --rm -i --entrypoint node "$RELEASE_IMAGE_ID" -e '
    let input="";
    process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{
      const image=JSON.parse(input)[0];
      const health=image.Config.Healthcheck;
      const env=new Set(image.Config.Env);
      const labels=image.Config.Labels||{};
      const [revision,sourceTree,version,created]=process.argv.slice(1);
      const source=labels["org.opencontainers.image.source"];
      if(JSON.stringify(health.Test)!==JSON.stringify([
           "CMD","node","dist/core/HealthMarker.js","--check"
         ])||health.Interval!==15000000000||health.Timeout!==5000000000||
         health.StartPeriod!==60000000000||health.Retries!==3||
         !env.has("BUBLIK_HEALTH_FILE=/tmp/bublik-health.json")||
         !env.has("BUBLIK_HEALTH_MAX_AGE_MS=75000")||
         labels["org.opencontainers.image.revision"]!==revision||
         labels["org.opencontainers.image.created"]!==created||
         labels["org.opencontainers.image.version"]!==version||
         typeof source!=="string"||
         !/^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\.git)?$/.test(source)||
         labels["org.opencontainers.image.base.name"]!=="docker.io/library/node:24-alpine"||
         labels["org.opencontainers.image.base.digest"]!=="sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd"||
         labels["io.bublik.release.source-tree"]!==sourceTree||
         labels["io.bublik.release.base-commit"]!==revision||
         labels["io.bublik.build.obfuscator-seed"]!=="1112883788")process.exit(1);
    });
  ' "$SOURCE_COMMIT" "$SOURCE_TREE" "$release_id" "$expected_created"
if docker run --rm --entrypoint node "$RELEASE_IMAGE_ID" \
  dist/core/HealthMarker.js --check >/dev/null 2>&1; then
  echo 'Release healthcheck прошёл без PID 1 и свежего marker' >&2
  exit 1
fi

validation="$(mktemp -d "/root/bublik-validation.$release_id.XXXXXX")"
printf '%s\n' "$validation" |
  grep -Eq "^/root/bublik-validation\.$release_id\.[A-Za-z0-9]{6}$"
test "$(readlink -f -- "$validation")" = "$validation"
cleanup_validation() {
  test ! -e "$validation" && return 0
  printf '%s\n' "$validation" |
    grep -Eq "^/root/bublik-validation\.$release_id\.[A-Za-z0-9]{6}$"
  test "$(readlink -f -- "$validation")" = "$validation"
  rm -rf -- "$validation"
}
trap cleanup_validation EXIT
chmod 0700 "$validation"
tar -tf "$release_dir/release-files.tar" > "$validation/members.txt"
while IFS= read -r member; do
  test -n "$member"
  case "$member" in
    /*|..|../*|*/../*|*/..|*\\*) echo "Опасный tar path: $member" >&2; exit 1 ;;
    docker-compose.yml|locales|locales/|locales/*) ;;
    *) echo "Лишний release-файл: $member" >&2; exit 1 ;;
  esac
done < "$validation/members.txt"
tar -tvf "$release_dir/release-files.tar" |
  awk 'substr($1,1,1) != "-" && substr($1,1,1) != "d" { exit 1 }'
tar -xf "$release_dir/release-files.tar" -C "$validation"
test -f "$validation/docker-compose.yml"
test -f "$validation/locales/ru.json"
test -f "$validation/locales/en.json"

test "$(readlink -f -- "$active")" = "$active"
test "$(readlink -f -- "$active/.env")" = "$active/.env"
test -f "$active/.env"
test ! -L "$active/.env"
chown root:root "$active/.env"
chmod 0600 "$active/.env"
test "$(stat -c '%U:%G:%a' "$active/.env")" = root:root:600
cp "$active/.env" "$validation/.env"
chown root:root "$validation/.env"
chmod 0600 "$validation/.env"

cd "$active"
docker compose -p "$project" config --quiet
test "$(docker inspect -f '{{.Name}}' bublik-bot)" = /bublik-bot
test "$(docker inspect -f '{{.Name}}' bublik-postgres)" = /bublik-postgres
test "$(docker inspect -f '{{.Name}}' bublik-redis)" = /bublik-redis
for container in bublik-bot bublik-postgres bublik-redis; do
  test "$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$container")" = "$project"
done
test "$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.service" }}' bublik-bot)" = bot
test "$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.service" }}' bublik-postgres)" = postgres
test "$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.service" }}' bublik-redis)" = redis
test "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' bublik-postgres)" = bublik-n_pg_data
test "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' bublik-redis)" = bublik-n_redis_data
test "$(docker inspect -f '{{with index .NetworkSettings.Networks "bublik-n_default"}}{{.IPAddress}}{{end}}' bublik-postgres)" != ""

target_identity_file="$state_dir/target-identities.env"
target_identity_sum="$state_dir/target-identities.env.sha256"
test ! -e "$target_identity_file"
test ! -e "$target_identity_sum"
BOT_CONTAINER_ID="$(docker inspect -f '{{.Id}}' bublik-bot)"
POSTGRES_CONTAINER_ID="$(docker inspect -f '{{.Id}}' bublik-postgres)"
REDIS_CONTAINER_ID="$(docker inspect -f '{{.Id}}' bublik-redis)"
BOT_IMAGE_ID="$(docker inspect -f '{{.Image}}' bublik-bot)"
POSTGRES_TARGET_IMAGE_ID="$(docker inspect -f '{{.Image}}' bublik-postgres)"
REDIS_IMAGE_ID="$(docker inspect -f '{{.Image}}' bublik-redis)"
TARGET_NETWORK_ID="$(docker network inspect -f '{{.Id}}' bublik-n_default)"
for container_id in "$BOT_CONTAINER_ID" "$POSTGRES_CONTAINER_ID" "$REDIS_CONTAINER_ID" "$TARGET_NETWORK_ID"; do
  printf '%s\n' "$container_id" | grep -Eq '^[0-9a-f]{64}$'
done
for image_id in "$BOT_IMAGE_ID" "$POSTGRES_TARGET_IMAGE_ID" "$REDIS_IMAGE_ID"; do
  printf '%s\n' "$image_id" | grep -Eq '^sha256:[0-9a-f]{64}$'
done
cat > "$target_identity_file" <<ENV
BOT_CONTAINER_ID=$BOT_CONTAINER_ID
POSTGRES_CONTAINER_ID=$POSTGRES_CONTAINER_ID
REDIS_CONTAINER_ID=$REDIS_CONTAINER_ID
BOT_IMAGE_ID=$BOT_IMAGE_ID
POSTGRES_TARGET_IMAGE_ID=$POSTGRES_TARGET_IMAGE_ID
REDIS_IMAGE_ID=$REDIS_IMAGE_ID
TARGET_NETWORK_ID=$TARGET_NETWORK_ID
ENV
chmod 0600 "$target_identity_file"
(
  cd "$state_dir"
  sha256sum target-identities.env > target-identities.env.sha256
  chmod 0600 target-identities.env.sha256
  sha256sum -c target-identities.env.sha256
)

docker exec bublik-bot node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const argv = fs.readFileSync("/proc/1/cmdline").toString().split(String.fromCharCode(0)).filter(Boolean);
  if (path.basename(argv[0]) !== "node" || argv[1] !== "dist/index.js") process.exit(1);
'

BUBLIK_IMAGE="$RELEASE_IMAGE" PRISMA_BASELINE_EXISTING=0 \
docker compose -p "$project" --project-directory "$validation" \
  -f "$validation/docker-compose.yml" --env-file "$validation/.env" \
  config --quiet
BUBLIK_IMAGE="$RELEASE_IMAGE" PRISMA_BASELINE_EXISTING=0 \
docker compose -p "$project" --project-directory "$validation" \
  -f "$validation/docker-compose.yml" --env-file "$validation/.env" \
  config > "$state_dir/effective-new-compose.yaml"
BUBLIK_IMAGE="$RELEASE_IMAGE" PRISMA_BASELINE_EXISTING=0 \
docker compose -p "$project" --project-directory "$validation" \
  -f "$validation/docker-compose.yml" --env-file "$validation/.env" \
  config --format json > "$state_dir/effective-new-compose.json"
chmod 0600 "$state_dir/effective-new-compose.yaml"
chmod 0600 "$state_dir/effective-new-compose.json"
docker run --rm -i --entrypoint node "$RELEASE_IMAGE_ID" -e '
  let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
    const r=JSON.parse(s);
    const ok=r.name==="bublik-n"&&
      r.services.bot.container_name==="bublik-bot"&&
      r.services.postgres.container_name==="bublik-postgres"&&
      r.services.redis.container_name==="bublik-redis"&&
      r.volumes.pg_data.name==="bublik-n_pg_data"&&
      r.volumes.redis_data.name==="bublik-n_redis_data"&&
      r.networks.default.name==="bublik-n_default";
    if(!ok)process.exit(1);
  });
' < "$state_dir/effective-new-compose.json"

descriptor_js='const u=new URL(process.env.DATABASE_URL);const schemas=u.searchParams.getAll("schema");if(!["postgres:","postgresql:"].includes(u.protocol)||schemas.length>1||(schemas.length===1&&!schemas[0]))process.exit(1);const d={host:u.hostname,port:u.port||"5432",database:u.pathname.replace(/^\/+/,""),schema:schemas[0]||"public"};process.stdout.write(JSON.stringify(d)+"\n")'
expected_descriptor='{"host":"postgres","port":"5432","database":"bublik","schema":"public"}'
docker exec bublik-bot node -e "$descriptor_js" > "$state_dir/target-old.json"
BUBLIK_IMAGE="$RELEASE_IMAGE" PRISMA_BASELINE_EXISTING=0 \
docker compose -p "$project" --project-directory "$validation" \
  -f "$validation/docker-compose.yml" --env-file "$validation/.env" \
  run --rm --no-deps --entrypoint node bot -e "$descriptor_js" \
  > "$state_dir/target-new.json"
test "$(tr -d '\r\n' < "$state_dir/target-old.json")" = "$expected_descriptor"
test "$(tr -d '\r\n' < "$state_dir/target-new.json")" = "$expected_descriptor"
cmp "$state_dir/target-old.json" "$state_dir/target-new.json"

postgres_ip="$(docker inspect -f '{{with index .NetworkSettings.Networks "bublik-n_default"}}{{.IPAddress}}{{end}}' bublik-postgres)"
printf '%s\n' "$postgres_ip" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'
query_js='const{PrismaClient}=require("@prisma/client");const p=new PrismaClient();p.$queryRawUnsafe("SELECT current_database() AS database, inet_server_addr()::text AS server").then(r=>{console.log("database="+r[0].database+" server="+r[0].server)}).finally(()=>p.$disconnect())'
docker exec bublik-bot node -e "$query_js" > "$state_dir/connection-old.txt"
BUBLIK_IMAGE="$RELEASE_IMAGE" PRISMA_BASELINE_EXISTING=0 \
docker compose -p "$project" --project-directory "$validation" \
  -f "$validation/docker-compose.yml" --env-file "$validation/.env" \
  run --rm --no-deps --entrypoint node bot -e "$query_js" \
  > "$state_dir/connection-new.txt"
test "$(tr -d '\r\n' < "$state_dir/connection-old.txt")" = "database=bublik server=$postgres_ip"
test "$(tr -d '\r\n' < "$state_dir/connection-new.txt")" = "database=bublik server=$postgres_ip"
cmp "$state_dir/connection-old.txt" "$state_dir/connection-new.txt"

test ! -e "$state_dir/preflight-live.json"
BUBLIK_IMAGE="$RELEASE_IMAGE" PRISMA_BASELINE_EXISTING=0 \
docker compose -p "$project" --project-directory "$validation" \
  -f "$validation/docker-compose.yml" --env-file "$validation/.env" \
  run --rm --no-deps --user 0:0 -v "$state_dir:/release-state" \
  --entrypoint node bot scripts/snapshot-baseline-data.js \
  --preflight-operational --output /release-state/preflight-live.json
docker run --rm -i --entrypoint node "$RELEASE_IMAGE_ID" -e '
  let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
    const r=JSON.parse(s);
    if(r.format!=="bublik-baseline-data-preflight/v1"||
       r.profile!=="operational"||r.status!=="ok"||r.tableCount!==40||
       r.checks.length!==9||new Set(r.checks.map(c=>c.id)).size!==9||
       r.checks.some(c=>c.violations!=="0"))process.exit(1);
  });
' < "$state_dir/preflight-live.json"

chown -R root:root "$state_dir"
find "$state_dir" -type d -exec chmod 0700 {} +
find "$state_dir" -type f -exec chmod 0600 {} +
install -o root -g root -m 0600 /dev/null "$state_dir/01-preflight-ok"
printf 'Preflight OK. Бот всё ещё работает; active compose/locales не изменены.\n'
~~~

### 2. Остановить запись и создать единый checkpoint

Этот блок запускается в той же tmux-сессии. Сначала останавливается только bot,
после чего фиксируются старые образы, effective Compose, root-only .env, locales,
runtime metadata, логи, снимок всех 40 таблиц и PostgreSQL dump. Затем успешно
завершаются BGREWRITEAOF и BGSAVE, создаётся логический Redis snapshot, Redis
останавливается и копируется весь /data, включая multipart AOF. RDB, AOF manifest
и полная копия проверяются до sealing checkpoint. `redis-check-aof` может открыть AOF
на запись даже без repair-флага, поэтому он получает только одноразовый byte-for-byte
клон. Исходный checkpoint после копирования остаётся неизменным и перепроверяется по SHA-256.
Повторный запуск поверх частичного checkpoint запрещён.

С момента остановки bot до завершения after-snapshot запрещены второй replica,
cron/worker, Prisma Studio и любые ручные SQL-записи. Gate требует ноль иных
сессий в БД, а на длительные rehearsal/off-host этапы останавливает и PostgreSQL:
sequence не является MVCC-объектом и иначе сравнение было бы недостоверным.

Остановка разрешена только в полуоткрытом maintenance-окне 10:15–16:15 МСК.
Перед блоком явно задай бюджет простоя, который целиком помещается в оставшуюся
часть окна, например `export BUBLIK_DOWNTIME_BUDGET_MINUTES=300`. Gate также
требует хотя бы одну настроенную PB master-конфигурацию, ноль tracked PB squads,
ноль незавершённых team PB sessions и достаточный запас места/inodes как на
backup filesystem, так и в Docker data-root. Любое несоответствие запрещает stop.

~~~bash
set -euo pipefail
umask 077
test "$(id -u)" -eq 0
test -n "$TMUX"
test -n "$RELEASE_ID"
release_id="$RELEASE_ID"
printf '%s\n' "$release_id" | grep -Eq '^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$'

project=bublik-n
active=/opt/bublik-n
release_dir="/root/releases/bublik-ts/$release_id"
state_dir="/root/deploy-state/bublik-ts/$release_id"
env_file="$release_dir/deployment.env"

test -f "$state_dir/01-preflight-ok"
test "$(readlink -f -- "$release_dir")" = "$release_dir"
test "$(stat -c '%U:%G:%a' "$release_dir")" = root:root:700
for file in deployment.env bublik-image.tar release-files.tar SHA256SUMS.release; do
  test "$(stat -c '%U:%G:%a' "$release_dir/$file")" = root:root:600
done
(cd "$release_dir" && sha256sum -c SHA256SUMS.release)
test "$(wc -l < "$env_file")" -eq 7
if grep -Evq '^(RELEASE_ID=[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|RELEASE_IMAGE=bublik-n-bot:release-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|RELEASE_IMAGE_ID=sha256:[0-9a-f]{64}|CHECKPOINT_DIR=/root/backups/bublik-ts/cutover-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|SOURCE_COMMIT=[0-9a-f]{40}|SOURCE_TREE=[0-9a-f]{40}|BASELINE_SHA256=[0-9a-f]{64})$' "$env_file"; then
  exit 1
fi
for key in RELEASE_ID RELEASE_IMAGE RELEASE_IMAGE_ID CHECKPOINT_DIR SOURCE_COMMIT SOURCE_TREE BASELINE_SHA256; do
  test "$(grep -c "^$key=" "$env_file")" -eq 1
done
. "$env_file"
test "$RELEASE_ID" = "$release_id"
test "$CHECKPOINT_DIR" = "/root/backups/bublik-ts/cutover-$release_id"
test "$(docker image inspect -f '{{.Id}}' "$RELEASE_IMAGE")" = "$RELEASE_IMAGE_ID"
test ! -e "$CHECKPOINT_DIR"
checkpoint_parent="$(dirname -- "$CHECKPOINT_DIR")"
test "$checkpoint_parent" = /root/backups/bublik-ts
install -d -o root -g root -m 0700 "$checkpoint_parent"
test "$(readlink -f -- "$checkpoint_parent")" = "$checkpoint_parent"
test "$(stat -c '%U:%G:%a' "$checkpoint_parent")" = root:root:700

target_identity_file="$state_dir/target-identities.env"
target_identity_sum="$state_dir/target-identities.env.sha256"
test "$(stat -c '%U:%G:%a' "$target_identity_file")" = root:root:600
test "$(stat -c '%U:%G:%a' "$target_identity_sum")" = root:root:600
test "$(wc -l < "$target_identity_file")" -eq 7
if grep -Evq '^(BOT_CONTAINER_ID=[0-9a-f]{64}|POSTGRES_CONTAINER_ID=[0-9a-f]{64}|REDIS_CONTAINER_ID=[0-9a-f]{64}|BOT_IMAGE_ID=sha256:[0-9a-f]{64}|POSTGRES_TARGET_IMAGE_ID=sha256:[0-9a-f]{64}|REDIS_IMAGE_ID=sha256:[0-9a-f]{64}|TARGET_NETWORK_ID=[0-9a-f]{64})$' "$target_identity_file"; then
  exit 1
fi
for key in BOT_CONTAINER_ID POSTGRES_CONTAINER_ID REDIS_CONTAINER_ID BOT_IMAGE_ID POSTGRES_TARGET_IMAGE_ID REDIS_IMAGE_ID TARGET_NETWORK_ID; do
  test "$(grep -c "^$key=" "$target_identity_file")" -eq 1
done
(cd "$state_dir" && sha256sum -c target-identities.env.sha256)
. "$target_identity_file"

assert_exact_pre_cutover_targets() {
  test "$(docker inspect -f '{{.Id}}' bublik-bot)" = "$BOT_CONTAINER_ID"
  test "$(docker inspect -f '{{.Id}}' bublik-postgres)" = "$POSTGRES_CONTAINER_ID"
  test "$(docker inspect -f '{{.Id}}' bublik-redis)" = "$REDIS_CONTAINER_ID"
  test "$(docker inspect -f '{{.Image}}' bublik-bot)" = "$BOT_IMAGE_ID"
  test "$(docker inspect -f '{{.Image}}' bublik-postgres)" = "$POSTGRES_TARGET_IMAGE_ID"
  test "$(docker inspect -f '{{.Image}}' bublik-redis)" = "$REDIS_IMAGE_ID"
  test "$(docker network inspect -f '{{.Id}}' bublik-n_default)" = "$TARGET_NETWORK_ID"
  test "$(docker network inspect -f '{{ index .Labels "com.docker.compose.project" }}' bublik-n_default)" = "$project"
  test "$(docker network inspect -f '{{ index .Labels "com.docker.compose.network" }}' bublik-n_default)" = default
  test "$(docker volume inspect -f '{{ index .Labels "com.docker.compose.project" }}' bublik-n_pg_data)" = "$project"
  test "$(docker volume inspect -f '{{ index .Labels "com.docker.compose.volume" }}' bublik-n_pg_data)" = pg_data
  test "$(docker volume inspect -f '{{ index .Labels "com.docker.compose.project" }}' bublik-n_redis_data)" = "$project"
  test "$(docker volume inspect -f '{{ index .Labels "com.docker.compose.volume" }}' bublik-n_redis_data)" = redis_data
  for spec in bublik-bot:bot bublik-postgres:postgres bublik-redis:redis; do
    container="${spec%%:*}"
    service="${spec#*:}"
    test "$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$container")" = "$project"
    test "$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.service" }}' "$container")" = "$service"
    test "$(docker inspect -f '{{with index .NetworkSettings.Networks "bublik-n_default"}}{{.NetworkID}}{{end}}' "$container")" = "$TARGET_NETWORK_ID"
  done
  test "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' bublik-postgres)" = bublik-n_pg_data
  test "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' bublik-redis)" = bublik-n_redis_data
}
assert_exact_pre_cutover_targets

printf '%s\n' "${BUBLIK_DOWNTIME_BUDGET_MINUTES:-}" | grep -Eq '^[1-9][0-9]*$'
test "$BUBLIK_DOWNTIME_BUDGET_MINUTES" -ge 30
test "$BUBLIK_DOWNTIME_BUDGET_MINUTES" -le 360

pg_database_bytes="$(docker exec bublik-postgres psql -X -U bublik -d bublik -Atqc \
  "SELECT pg_database_size('bublik')")"
printf '%s\n' "$pg_database_bytes" | grep -Eq '^[1-9][0-9]*$'
redis_data_kib="$(docker exec bublik-redis du -sk /data | awk '{print $1}')"
printf '%s\n' "$redis_data_kib" | grep -Eq '^[0-9]+$'
redis_data_bytes=$((redis_data_kib * 1024))

pg_volume_kib="$(docker run --rm --user 0:0 \
  --mount type=volume,src=bublik-n_pg_data,dst=/pg,readonly \
  --entrypoint du "$POSTGRES_TARGET_IMAGE_ID" -sk /pg | awk '{print $1}')"
pg_file_count="$(docker run --rm --user 0:0 \
  --mount type=volume,src=bublik-n_pg_data,dst=/pg,readonly \
  --entrypoint sh "$POSTGRES_TARGET_IMAGE_ID" -ec 'find /pg -xdev -type f | wc -l')"
redis_file_count="$(docker exec bublik-redis sh -ec 'find /data -xdev -type f | wc -l')"
for value in "$pg_volume_kib" "$pg_file_count" "$redis_file_count"; do
  printf '%s\n' "$value" | grep -Eq '^[0-9]+$'
done
pg_volume_bytes=$((pg_volume_kib * 1024))

active_payload_bytes=0
for payload in "$active/locales" "$active/logs"; do
  if test -e "$payload"; then
    payload_kib="$(du -sk -- "$payload" | awk '{print $1}')"
    printf '%s\n' "$payload_kib" | grep -Eq '^[0-9]+$'
    active_payload_bytes=$((active_payload_bytes + payload_kib * 1024))
  fi
done
old_bot_image_bytes="$(docker image inspect -f '{{.Size}}' "$BOT_IMAGE_ID")"
old_redis_image_bytes="$(docker image inspect -f '{{.Size}}' "$REDIS_IMAGE_ID")"
postgres_image_bytes="$(docker image inspect -f '{{.Size}}' "$POSTGRES_TARGET_IMAGE_ID")"
for value in "$old_bot_image_bytes" "$old_redis_image_bytes" "$postgres_image_bytes"; do
  printf '%s\n' "$value" | grep -Eq '^[1-9][0-9]*$'
done

safety_bytes=$((2 * 1024 * 1024 * 1024))
checkpoint_estimate_bytes=$((old_bot_image_bytes + old_redis_image_bytes +
  postgres_image_bytes + 2 * pg_database_bytes + redis_data_bytes + active_payload_bytes))
host_required_bytes=$((2 * checkpoint_estimate_bytes + safety_bytes))
docker_required_bytes=$((2 * pg_volume_bytes + safety_bytes))
host_required_inodes=$((redis_file_count + 10000))
docker_required_inodes=$((pg_file_count + 10000))
docker_root_reported="$(docker info -f '{{.DockerRootDir}}')"
test "${docker_root_reported#/}" != "$docker_root_reported"
docker_root="$(readlink -f -- "$docker_root_reported")"
test "${docker_root#/}" != "$docker_root"
test -d "$docker_root"
host_free_bytes="$(df -B1 --output=avail "$checkpoint_parent" | awk 'NR == 2 {print $1}')"
host_free_inodes="$(df -i --output=iavail "$checkpoint_parent" | awk 'NR == 2 {print $1}')"
docker_free_bytes="$(df -B1 --output=avail "$docker_root" | awk 'NR == 2 {print $1}')"
docker_free_inodes="$(df -i --output=iavail "$docker_root" | awk 'NR == 2 {print $1}')"
for value in "$host_free_bytes" "$host_free_inodes" "$docker_free_bytes" "$docker_free_inodes"; do
  printf '%s\n' "$value" | grep -Eq '^[0-9]+$'
done
if test "$(stat -c %d "$checkpoint_parent")" = "$(stat -c %d "$docker_root")"; then
  combined_required_bytes=$((host_required_bytes + docker_required_bytes))
  combined_required_inodes=$((host_required_inodes + docker_required_inodes))
  test "$host_free_bytes" -ge "$combined_required_bytes"
  test "$host_free_inodes" -ge "$combined_required_inodes"
else
  test "$host_free_bytes" -ge "$host_required_bytes"
  test "$host_free_inodes" -ge "$host_required_inodes"
  test "$docker_free_bytes" -ge "$docker_required_bytes"
  test "$docker_free_inodes" -ge "$docker_required_inodes"
fi

capacity_report="$state_dir/capacity-before-stop.txt"
test ! -e "$capacity_report"
{
  printf 'checkpoint_filesystem_path=%s\n' "$checkpoint_parent"
  printf 'docker_filesystem_path=%s\n' "$docker_root"
  printf 'pg_database_bytes=%s\n' "$pg_database_bytes"
  printf 'pg_volume_bytes=%s\n' "$pg_volume_bytes"
  printf 'redis_data_bytes=%s\n' "$redis_data_bytes"
  printf 'checkpoint_estimate_bytes=%s\n' "$checkpoint_estimate_bytes"
  printf 'host_required_bytes=%s\n' "$host_required_bytes"
  printf 'docker_required_bytes=%s\n' "$docker_required_bytes"
  printf 'host_free_bytes=%s\n' "$host_free_bytes"
  printf 'docker_free_bytes=%s\n' "$docker_free_bytes"
  printf 'host_required_inodes=%s\n' "$host_required_inodes"
  printf 'docker_required_inodes=%s\n' "$docker_required_inodes"
  printf 'host_free_inodes=%s\n' "$host_free_inodes"
  printf 'docker_free_inodes=%s\n' "$docker_free_inodes"
} > "$capacity_report"
chmod 0600 "$capacity_report"

msk_now="$(TZ=Europe/Moscow date '+%Y-%m-%d|%H|%M|%z')"
IFS='|' read -r msk_date msk_hour msk_minute msk_offset <<< "$msk_now"
printf '%s\n' "$msk_date" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
printf '%s\n' "$msk_hour" | grep -Eq '^[0-2][0-9]$'
printf '%s\n' "$msk_minute" | grep -Eq '^[0-5][0-9]$'
test "$msk_offset" = +0300
msk_minute_of_day=$((10#$msk_hour * 60 + 10#$msk_minute))
test "$msk_minute_of_day" -ge 615
test "$msk_minute_of_day" -lt 975
maintenance_started_at_epoch="$(date +%s)"
window_deadline_epoch="$(TZ=Europe/Moscow date -d "$msk_date 16:15:00" +%s)"
maintenance_deadline_epoch=$((maintenance_started_at_epoch + BUBLIK_DOWNTIME_BUDGET_MINUTES * 60))
test "$maintenance_deadline_epoch" -le "$window_deadline_epoch"

read_pb_activity() {
  pb_activity_row="$(docker exec bublik-postgres psql -X -v ON_ERROR_STOP=1 \
    -U bublik -d bublik -A -t -F '|' -c '
      SELECT
        (SELECT count(*) FROM "regbattle_configs" WHERE "masterChannelId" IS NOT NULL),
        (SELECT count(*) FROM "regbattle_squads"),
        (SELECT count(*) FROM "team_sessions" WHERE "endedAt" IS NULL)
    ')" || return 1
  test -n "$pb_activity_row" || return 1
  IFS='|' read -r pb_configured_guilds pb_tracked_squads pb_open_team_sessions <<< "$pb_activity_row"
  for value in "$pb_configured_guilds" "$pb_tracked_squads" "$pb_open_team_sessions"; do
    printf '%s\n' "$value" | grep -Eq '^[0-9]+$' || return 1
  done
  test "$pb_configured_guilds" -ge 1 || return 1
  test "$pb_tracked_squads" -eq 0 || return 1
  test "$pb_open_team_sessions" -eq 0 || return 1
}
read_pb_activity

pb_evidence_before="$state_dir/pb-maintenance-evidence.before-stop.txt"
pb_idle_stdout="$state_dir/pb-idle.release-after-stop.txt"
pb_idle_stderr="$state_dir/pb-idle.release-after-stop.stderr.txt"
pg_freeze_report="$state_dir/postgres-sessions.cross-store-freeze.txt"
redis_freeze_report="$state_dir/redis-clients.cross-store-freeze.txt"
redis_healthcheck_report="$state_dir/redis-healthcheck.cross-store-freeze.txt"
cross_store_freeze_report="$state_dir/cross-store-freeze.txt"
maintenance_budget_file="$state_dir/maintenance-budget.env"
test ! -e "$pb_evidence_before"
for report in "$pb_idle_stdout" "$pb_idle_stderr" "$pg_freeze_report" \
  "$redis_freeze_report" "$redis_healthcheck_report" "$cross_store_freeze_report"; do
  test ! -e "$report"
done
test ! -e "$maintenance_budget_file"
{
  printf 'checked_at_msk=%s %s:%s %s\n' "$msk_date" "$msk_hour" "$msk_minute" "$msk_offset"
  printf 'configured_pb_guilds=%s\n' "$pb_configured_guilds"
  printf 'tracked_pb_squads=%s\n' "$pb_tracked_squads"
  printf 'open_team_pb_sessions=%s\n' "$pb_open_team_sessions"
} > "$pb_evidence_before"
cat > "$maintenance_budget_file" <<ENV
MAINTENANCE_WINDOW_DATE=$msk_date
MAINTENANCE_STARTED_AT_EPOCH=$maintenance_started_at_epoch
MAINTENANCE_DEADLINE_EPOCH=$maintenance_deadline_epoch
MAINTENANCE_WINDOW_DEADLINE_EPOCH=$window_deadline_epoch
DOWNTIME_BUDGET_MINUTES=$BUBLIK_DOWNTIME_BUDGET_MINUTES
ENV
chmod 0600 "$pb_evidence_before" "$maintenance_budget_file"
(
  cd "$state_dir"
  sha256sum maintenance-budget.env > maintenance-budget.env.sha256
  chmod 0600 maintenance-budget.env.sha256
  sha256sum -c maintenance-budget.env.sha256
)

assert_exact_pre_cutover_targets

cd "$active"
assert_exact_pre_cutover_targets
restart_old_bot_after_failed_pb_gate() {
  restart_healthy=0
  if docker compose -p "$project" start bot >/dev/null; then
    for attempt in $(seq 1 60); do
      restart_status="$(
        docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' \
          bublik-bot 2>/dev/null || true
      )"
      if test "$restart_status" = healthy &&
         test "$(docker inspect -f '{{.Id}}' bublik-bot)" = "$BOT_CONTAINER_ID" &&
         test "$(docker inspect -f '{{.Image}}' bublik-bot)" = "$BOT_IMAGE_ID" &&
         test "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' bublik-postgres)" = healthy &&
         test "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' bublik-redis)" = healthy; then
        restart_healthy=1
        break
      fi
      sleep 2
    done
  fi
  test "$restart_healthy" -eq 1
}

abort_pre_checkpoint_gate() {
  gate_rc=$?
  trap - ERR
  set +e
  if restart_old_bot_after_failed_pb_gate; then
    printf '%s\n' 'Pre-checkpoint gate failed; exact old bot restarted healthy; cutover aborted.' \
      > "$state_dir/pre-checkpoint.abort-status.txt"
  else
    printf '%s\n' 'Pre-checkpoint gate failed; old bot restart also failed; cutover aborted.' \
      > "$state_dir/pre-checkpoint.abort-status.txt"
  fi
  chmod 0600 "$state_dir/pre-checkpoint.abort-status.txt" 2>/dev/null
  test "$gate_rc" -ne 0 || gate_rc=1
  exit "$gate_rc"
}

docker compose -p "$project" stop bot
trap abort_pre_checkpoint_gate ERR
test "$(docker inspect -f '{{.State.Running}}' bublik-bot)" = false
test "$(docker inspect -f '{{.State.Running}}' bublik-postgres)" = true
test "$(docker inspect -f '{{.State.Running}}' bublik-redis)" = true

pb_probe_rc=0
docker run --rm --user 0:0 --network bublik-n_default \
  --env-file "$active/.env" --env REDIS_URL=redis://redis:6379 \
  --entrypoint node "$RELEASE_IMAGE_ID" scripts/verify-pb-idle.js \
  > "$pb_idle_stdout.partial" 2> "$pb_idle_stderr.partial" || pb_probe_rc=$?
mv "$pb_idle_stdout.partial" "$pb_idle_stdout"
mv "$pb_idle_stderr.partial" "$pb_idle_stderr"
chmod 0600 "$pb_idle_stdout" "$pb_idle_stderr"
test "$pb_probe_rc" -eq 0
grep -Eq '^PB idle verified: configs=[1-9][0-9]* squads=[0-9]+ guilds=[1-9][0-9]* channels=[1-9][0-9]* redisSessions=0 occupants=0\.$' \
  "$pb_idle_stdout"
test ! -s "$pb_idle_stderr"
test "$(docker inspect -f '{{.State.Running}}' bublik-bot)" = false
test "$(docker inspect -f '{{.Id}}' bublik-bot)" = "$BOT_CONTAINER_ID"
test "$(docker inspect -f '{{.Image}}' bublik-bot)" = "$BOT_IMAGE_ID"

if ! read_pb_activity; then
  false
fi
pb_evidence_after="$state_dir/pb-maintenance-evidence.after-stop.txt"
test ! -e "$pb_evidence_after"
{
  printf 'checked_at_epoch=%s\n' "$(date +%s)"
  printf 'configured_pb_guilds=%s\n' "$pb_configured_guilds"
  printf 'tracked_pb_squads=%s\n' "$pb_tracked_squads"
  printf 'open_team_pb_sessions=%s\n' "$pb_open_team_sessions"
} > "$pb_evidence_after"
chmod 0600 "$pb_evidence_after"

# pg_isready/redis-cli ping из Docker healthcheck являются только короткими
# read-only probes. Freeze принимается лишь на попытке, где PostgreSQL не видит
# ни одной внешней session, а Redis CLIENT LIST видит только выполняющий его
# loopback redis-cli; healthcheck-команда сохраняется как обоснование retry.
docker inspect -f '{{json .Config.Healthcheck.Test}}' bublik-redis \
  > "$redis_healthcheck_report"
grep -Fxq '["CMD","redis-cli","ping"]' "$redis_healthcheck_report"

pg_freeze_ok=0
for attempt in $(seq 1 10); do
  docker exec bublik-postgres psql -X -U bublik -d bublik -Atqc \
    "SELECT 'external_sessions=' || count(*) FROM pg_stat_activity WHERE datname='bublik' AND pid <> pg_backend_pid()" \
    > "$pg_freeze_report.partial"
  if grep -Fxq 'external_sessions=0' "$pg_freeze_report.partial"; then
    pg_freeze_ok=1
    break
  fi
  sleep 1
done
test "$pg_freeze_ok" -eq 1
mv "$pg_freeze_report.partial" "$pg_freeze_report"

redis_freeze_ok=0
for attempt in $(seq 1 10); do
  docker exec bublik-redis redis-cli --raw CLIENT LIST \
    > "$redis_freeze_report.partial"
  if test "$(grep -c '^id=' "$redis_freeze_report.partial")" -eq 1 &&
     grep -Eq '(^| )addr=127\.0\.0\.1:[0-9]+( |$)' "$redis_freeze_report.partial" &&
     grep -Eq '(^| )flags=N( |$)' "$redis_freeze_report.partial" &&
     grep -Eq '(^| )db=0( |$)' "$redis_freeze_report.partial" &&
     grep -Eq '(^| )cmd=client\|list( |$)' "$redis_freeze_report.partial" &&
     grep -Eq '(^| )user=default( |$)' "$redis_freeze_report.partial"; then
    redis_freeze_ok=1
    break
  fi
  sleep 1
done
test "$redis_freeze_ok" -eq 1
mv "$redis_freeze_report.partial" "$redis_freeze_report"
{
  printf 'captured_at_epoch=%s\n' "$(date +%s)"
  printf 'bot_running=false\n'
  printf 'postgres_external_sessions=0\n'
  printf 'redis_clients_all_types=1\n'
  printf 'redis_accepted_client=current_loopback_redis_cli_client_list\n'
  printf 'redis_healthcheck=CMD_redis-cli_ping_read_only\n'
} > "$cross_store_freeze_report"
chmod 0600 "$pb_evidence_after" "$pg_freeze_report" "$redis_freeze_report" \
  "$redis_healthcheck_report" "$cross_store_freeze_report"
(
  cd "$state_dir"
  sha256sum target-identities.env capacity-before-stop.txt \
    pb-maintenance-evidence.before-stop.txt pb-maintenance-evidence.after-stop.txt \
    pb-idle.release-after-stop.txt pb-idle.release-after-stop.stderr.txt \
    postgres-sessions.cross-store-freeze.txt redis-clients.cross-store-freeze.txt \
    redis-healthcheck.cross-store-freeze.txt cross-store-freeze.txt \
    maintenance-budget.env > maintenance-gate.sha256
  chmod 0600 maintenance-gate.sha256
  sha256sum -c maintenance-gate.sha256
)
grep -Fxq 'external_sessions=0' "$pg_freeze_report"
trap - ERR

install -d -o root -g root -m 0700 "$(dirname "$CHECKPOINT_DIR")" "$CHECKPOINT_DIR"
test "$(readlink -f -- "$CHECKPOINT_DIR")" = "$CHECKPOINT_DIR"
install -d -o root -g root -m 0700 "$CHECKPOINT_DIR/active" "$CHECKPOINT_DIR/redis-data"
test "$(readlink -f -- "$active/.env")" = "$active/.env"
chown root:root "$active/.env"
chmod 0600 "$active/.env"
test -f "$active/docker-compose.yml"
test ! -L "$active/docker-compose.yml"
test "$(readlink -f -- "$active/docker-compose.yml")" = "$active/docker-compose.yml"
test -d "$active/locales"
test ! -L "$active/locales"
test "$(readlink -f -- "$active/locales")" = "$active/locales"
test -z "$(find "$active/locales" -type l -print -quit)"

cp --no-dereference "$active/docker-compose.yml" "$CHECKPOINT_DIR/active/docker-compose.yml"
cp --no-dereference "$active/.env" "$CHECKPOINT_DIR/active/.env"
tar --numeric-owner -C "$active" -cf "$CHECKPOINT_DIR/active/locales.tar" locales
if test -d "$active/logs"; then
  test "$(readlink -f -- "$active/logs")" = "$active/logs"
  tar --numeric-owner -C "$active" -cf "$CHECKPOINT_DIR/active/logs.tar" logs
fi
find "$active/locales" -printf '%y %m %U:%G %p\n' > "$CHECKPOINT_DIR/active/locales-metadata.txt"
docker compose -p "$project" config > "$CHECKPOINT_DIR/effective-old-compose.yaml"

old_bot_image_id="$(docker inspect -f '{{.Image}}' bublik-bot)"
old_bot_image_ref="$(docker inspect -f '{{.Config.Image}}' bublik-bot)"
old_redis_image_id="$(docker inspect -f '{{.Image}}' bublik-redis)"
old_redis_image_ref="$(docker inspect -f '{{.Config.Image}}' bublik-redis)"
postgres_image_id="$(docker inspect -f '{{.Image}}' bublik-postgres)"
postgres_image_ref="$(docker inspect -f '{{.Config.Image}}' bublik-postgres)"
old_bot_tag="bublik-checkpoint-bot:$release_id"
old_redis_tag="bublik-checkpoint-redis:$release_id"

for image_id in "$old_bot_image_id" "$old_redis_image_id" "$postgres_image_id"; do
  printf '%s\n' "$image_id" | grep -Eq '^sha256:[0-9a-f]{64}$'
done
for image_ref in "$old_bot_image_ref" "$old_redis_image_ref" "$postgres_image_ref"; do
  printf '%s\n' "$image_ref" | grep -Eq '^[A-Za-z0-9._/@:+-]+$'
done
test "$(docker exec bublik-postgres printenv POSTGRES_USER)" = bublik
test "$(docker exec bublik-postgres printenv POSTGRES_DB)" = bublik
docker exec bublik-postgres postgres --version | grep -Eq ' 16\.'

docker image tag "$old_bot_image_id" "$old_bot_tag"
docker image tag "$old_redis_image_id" "$old_redis_tag"
docker save --output "$CHECKPOINT_DIR/old-bot-image.tar" "$old_bot_tag"
docker save --output "$CHECKPOINT_DIR/old-redis-image.tar" "$old_redis_tag"
docker save --output "$CHECKPOINT_DIR/postgres-image.tar" "$postgres_image_id"
docker inspect bublik-bot bublik-postgres bublik-redis > "$CHECKPOINT_DIR/containers.before.json"
docker image inspect "$old_bot_image_id" "$old_redis_image_id" "$postgres_image_id" > "$CHECKPOINT_DIR/images.before.json"
docker volume inspect bublik-n_pg_data bublik-n_redis_data > "$CHECKPOINT_DIR/volumes.before.json"
docker network inspect bublik-n_default > "$CHECKPOINT_DIR/network.before.json"
docker version > "$CHECKPOINT_DIR/docker-version.txt"
docker compose version > "$CHECKPOINT_DIR/compose-version.txt"
uname -a > "$CHECKPOINT_DIR/uname.txt"
locale > "$CHECKPOINT_DIR/locale.txt"
docker logs --timestamps bublik-bot > "$CHECKPOINT_DIR/bot.before.log" 2>&1
docker logs --timestamps bublik-postgres > "$CHECKPOINT_DIR/postgres.before.log" 2>&1
docker logs --timestamps bublik-redis > "$CHECKPOINT_DIR/redis.before.log" 2>&1

test ! -e "$CHECKPOINT_DIR/baseline-preflight.json"
test ! -e "$CHECKPOINT_DIR/baseline-before.json"
docker run --rm --user 0:0 --network bublik-n_default \
  --env-file "$active/.env" -v "$CHECKPOINT_DIR:/checkpoint" \
  --entrypoint node "$RELEASE_IMAGE_ID" \
  scripts/snapshot-baseline-data.js --preflight-operational \
  --output /checkpoint/baseline-preflight.json
docker run --rm --user 0:0 --network bublik-n_default \
  --env-file "$active/.env" -v "$CHECKPOINT_DIR:/checkpoint" \
  --entrypoint node "$RELEASE_IMAGE_ID" \
  scripts/snapshot-baseline-data.js --snapshot-operational \
  --output /checkpoint/baseline-before.json
docker run --rm -i --entrypoint node "$RELEASE_IMAGE_ID" -e '
  let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
    const r=JSON.parse(s);
    if(r.format!=="bublik-baseline-data-snapshot/v2"||r.status!=="ok"||
       r.profile!=="operational"||r.tableCount!==40||r.sequenceCount!==1||
       r.invariants.length!==9||
       new Set(r.invariants.map(c=>c.id)).size!==9||
       r.invariants.some(c=>c.violations!=="0")||
       r.fingerprintAlgorithm!=="postgres-sha256-canonical-json/v1"||
       r.consistency?.writerStateRequired!=="stopped"||
       r.tables.some(t=>!/^([0-9a-f]{64})$/.test(t.fingerprint))||
       r.sequences.length!==1||r.sequences[0].sequence!=="br_tech_entries_id_seq")process.exit(1);
  });
' < "$CHECKPOINT_DIR/baseline-before.json"

docker exec bublik-postgres sh -ec \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
  > "$CHECKPOINT_DIR/postgres.dump"
docker exec bublik-postgres sh -ec \
  'pg_dumpall -U "$POSTGRES_USER" --globals-only' \
  > "$CHECKPOINT_DIR/postgres-globals.sql"
test -s "$CHECKPOINT_DIR/postgres.dump"
docker exec -i bublik-postgres pg_restore --list \
  < "$CHECKPOINT_DIR/postgres.dump" \
  > "$CHECKPOINT_DIR/postgres.restore-list.txt"
test -s "$CHECKPOINT_DIR/postgres.restore-list.txt"

assert_exact_pre_cutover_targets
docker compose -p "$project" stop postgres
test "$(docker inspect -f '{{.State.Running}}' bublik-postgres)" = false

docker exec bublik-redis redis-cli --raw INFO keyspace |
  tr -d '\r' | sed -E 's/,avg_ttl=[0-9]+//' \
  > "$CHECKPOINT_DIR/redis-keyspace.before"
docker exec bublik-redis redis-cli --raw INFO persistence |
  tr -d '\r' > "$CHECKPOINT_DIR/redis-persistence.before"
docker exec bublik-redis redis-cli --raw CONFIG GET '*' |
  tr -d '\r' > "$CHECKPOINT_DIR/redis-config.before"
docker exec bublik-redis redis-cli --raw INFO persistence |
  tr -d '\r' | grep -q '^aof_enabled:1$'

docker exec bublik-redis redis-cli BGREWRITEAOF
aof_rewrite_ok=0
for attempt in $(seq 1 300); do
  if docker exec bublik-redis redis-cli --raw INFO persistence |
     tr -d '\r' | grep -q '^aof_rewrite_in_progress:0$'; then
    aof_rewrite_ok=1
    break
  fi
  sleep 1
done
test "$aof_rewrite_ok" -eq 1
docker exec bublik-redis redis-cli --raw INFO persistence |
  tr -d '\r' | grep -q '^aof_last_bgrewrite_status:ok$'

docker exec bublik-redis redis-cli BGSAVE
bgsave_ok=0
for attempt in $(seq 1 120); do
  if docker exec bublik-redis redis-cli --raw INFO persistence |
     tr -d '\r' | grep -q '^rdb_bgsave_in_progress:0$'; then
    bgsave_ok=1
    break
  fi
  sleep 1
done
test "$bgsave_ok" -eq 1
docker exec bublik-redis redis-cli --raw INFO persistence |
  tr -d '\r' | grep -q '^rdb_last_bgsave_status:ok$'

test ! -e "$CHECKPOINT_DIR/redis-before.json"
docker run --rm --user 0:0 --network bublik-n_default \
  --env REDIS_URL=redis://redis:6379/0 \
  -v "$CHECKPOINT_DIR:/checkpoint" --entrypoint node "$RELEASE_IMAGE_ID" \
  scripts/snapshot-redis-data.js --snapshot \
  --output /checkpoint/redis-before.json
docker run --rm -i --entrypoint node "$RELEASE_IMAGE_ID" -e '
  let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
    const r=JSON.parse(s);
    if(r.format!=="bublik-redis-data-snapshot/v1"||r.version!==1||
       r.status!=="ok"||r.database!==0||
       r.fingerprintAlgorithm!=="redis-dump-sha256/v1"||
       r.consistency?.writerStateRequired!=="stopped"||
       r.keyCount!==r.keys.length)process.exit(1);
  });
' < "$CHECKPOINT_DIR/redis-before.json"

redis_before_stop_clients="$CHECKPOINT_DIR/redis-clients.before-stop.txt"
test ! -e "$redis_before_stop_clients"
redis_before_stop_ok=0
for attempt in $(seq 1 10); do
  docker exec bublik-redis redis-cli --raw CLIENT LIST \
    > "$redis_before_stop_clients.partial"
  if test "$(grep -c '^id=' "$redis_before_stop_clients.partial")" -eq 1 &&
     grep -Eq '(^| )addr=127\.0\.0\.1:[0-9]+( |$)' "$redis_before_stop_clients.partial" &&
     grep -Eq '(^| )flags=N( |$)' "$redis_before_stop_clients.partial" &&
     grep -Eq '(^| )db=0( |$)' "$redis_before_stop_clients.partial" &&
     grep -Eq '(^| )cmd=client\|list( |$)' "$redis_before_stop_clients.partial" &&
     grep -Eq '(^| )user=default( |$)' "$redis_before_stop_clients.partial"; then
    redis_before_stop_ok=1
    break
  fi
  sleep 1
done
test "$redis_before_stop_ok" -eq 1
mv "$redis_before_stop_clients.partial" "$redis_before_stop_clients"

assert_exact_pre_cutover_targets
docker compose -p "$project" stop redis
test "$(docker inspect -f '{{.State.Running}}' bublik-redis)" = false
docker cp --help | grep -Fq -- '--archive'
docker cp -a bublik-redis:/data/. "$CHECKPOINT_DIR/redis-data"
test -s "$CHECKPOINT_DIR/redis-data/dump.rdb"
test -f "$CHECKPOINT_DIR/redis-data/appendonlydir/appendonly.aof.manifest"
test ! -L "$CHECKPOINT_DIR/redis-data/appendonlydir/appendonly.aof.manifest"
(
  cd "$CHECKPOINT_DIR/redis-data"
  find . -xdev -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum \
    > "$CHECKPOINT_DIR/redis-data.before-validation.sha256"
)
redis_validation="$(mktemp -d "/root/bublik-redis-validation.$release_id.XXXXXX")"
printf '%s\n' "$redis_validation" |
  grep -Eq "^/root/bublik-redis-validation\.$release_id\.[A-Za-z0-9]{6}$"
test "$(readlink -f -- "$redis_validation")" = "$redis_validation"
(
  set -e
  cleanup_redis_validation() {
    test ! -e "$redis_validation" && return 0
    printf '%s\n' "$redis_validation" |
      grep -Eq "^/root/bublik-redis-validation\.$release_id\.[A-Za-z0-9]{6}$"
    test "$(readlink -f -- "$redis_validation")" = "$redis_validation"
    rm -rf -- "$redis_validation"
  }
  trap cleanup_redis_validation EXIT
  cp -a "$CHECKPOINT_DIR/redis-data/." "$redis_validation/"
  docker run --rm --user 0:0 --entrypoint redis-check-rdb \
    -v "$redis_validation/dump.rdb:/backup/dump.rdb:ro" \
    "$old_redis_image_id" /backup/dump.rdb \
    > "$CHECKPOINT_DIR/redis-rdb-check.txt" 2>&1
  grep -Fq 'RDB looks OK!' "$CHECKPOINT_DIR/redis-rdb-check.txt"
  # redis-check-aof may repair files even without --fix on some releases.
  # It therefore receives only a disposable byte-for-byte clone.
  docker run --rm --user 0:0 --entrypoint redis-check-aof \
    -v "$redis_validation:/backup" \
    "$old_redis_image_id" /backup/appendonlydir/appendonly.aof.manifest \
    > "$CHECKPOINT_DIR/redis-aof-check.txt" 2>&1
  grep -Fq 'All AOF files and manifest are valid' "$CHECKPOINT_DIR/redis-aof-check.txt"
)
(
  cd "$CHECKPOINT_DIR/redis-data"
  find . -xdev -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum \
    > "$CHECKPOINT_DIR/redis-data.after-validation.sha256"
)
cmp "$CHECKPOINT_DIR/redis-data.before-validation.sha256" \
  "$CHECKPOINT_DIR/redis-data.after-validation.sha256"

active_env_sha="$(sha256sum "$active/.env" | awk '{print $1}')"
cat > "$CHECKPOINT_DIR/checkpoint.env" <<ENV
OLD_BOT_IMAGE_ID=$old_bot_image_id
OLD_BOT_IMAGE_REF=$old_bot_image_ref
OLD_BOT_CHECKPOINT_TAG=$old_bot_tag
OLD_REDIS_IMAGE_ID=$old_redis_image_id
OLD_REDIS_IMAGE_REF=$old_redis_image_ref
OLD_REDIS_CHECKPOINT_TAG=$old_redis_tag
POSTGRES_IMAGE_ID=$postgres_image_id
POSTGRES_IMAGE_REF=$postgres_image_ref
POSTGRES_USER=bublik
POSTGRES_DB=bublik
ACTIVE_ENV_SHA256=$active_env_sha
ENV

chown -R root:root "$CHECKPOINT_DIR"
find "$CHECKPOINT_DIR" -type d -exec chmod 0700 {} +
find "$CHECKPOINT_DIR" -type f -exec chmod 0600 {} +
(
  cd "$CHECKPOINT_DIR"
  find . -type f ! -name 'SHA256SUMS.*' -print0 |
    LC_ALL=C sort -z |
    xargs -0 sha256sum > SHA256SUMS.capture
  chmod 0600 SHA256SUMS.capture
  sha256sum -c SHA256SUMS.capture
)
test "$(stat -c '%U:%G:%a' "$CHECKPOINT_DIR")" = root:root:700
test "$(stat -c '%U:%G:%a' "$CHECKPOINT_DIR/checkpoint.env")" = root:root:600
install -o root -g root -m 0600 /dev/null "$state_dir/02-checkpoint-captured"
printf 'Checkpoint captured. bot, Redis и production PostgreSQL остановлены.\n'
~~~

### 3. Проверить полный Redis restore и миграцию в изолированном PostgreSQL 16

Сначала весь Redis /data восстанавливается в отдельный volume на том же old image ID
и с точными production Cmd/config, без опубликованных портов. Snapshot после запуска
сравнивается с before при expiry tolerance/grace 0; разрешены только строго доказанные
естественные истечения абсолютных TTL, но не иные различия. Затем dump восстанавливается
в одноразовый PostgreSQL из точного production image ID, также без host-портов и вне
production volume. Восстановленный снимок обязан совпасть со всеми 40 таблицами
pre-cutover. После этого именно release image через свой production entrypoint выполняет
`MIGRATE_ONLY=1` с `PRISMA_BASELINE_EXISTING=0`: это повторный переход с четырёх
уже применённых миграций на шесть, поэтому baseline resolve запрещён. Обязательны
operational-профиль и точные 19/19 postflight checks, пустой schema diff через
datasource и повторное полное совпадение 40 таблиц и sequence.

~~~bash
set -euo pipefail
umask 077
test "$(id -u)" -eq 0
test -n "$TMUX"
test -n "$RELEASE_ID"
release_id="$RELEASE_ID"
printf '%s\n' "$release_id" | grep -Eq '^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$'

release_dir="/root/releases/bublik-ts/$release_id"
state_dir="/root/deploy-state/bublik-ts/$release_id"
env_file="$release_dir/deployment.env"
test "$(stat -c '%U:%G:%a' "$release_dir")" = root:root:700
test "$(stat -c '%U:%G:%a' "$env_file")" = root:root:600
test "$(stat -c '%U:%G:%a' "$release_dir/SHA256SUMS.release")" = root:root:600
(cd "$release_dir" && sha256sum -c SHA256SUMS.release)
if grep -Evq '^(RELEASE_ID=[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|RELEASE_IMAGE=bublik-n-bot:release-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|RELEASE_IMAGE_ID=sha256:[0-9a-f]{64}|CHECKPOINT_DIR=/root/backups/bublik-ts/cutover-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|SOURCE_COMMIT=[0-9a-f]{40}|SOURCE_TREE=[0-9a-f]{40}|BASELINE_SHA256=[0-9a-f]{64})$' "$env_file"; then
  exit 1
fi
test "$(wc -l < "$env_file")" -eq 7
for key in RELEASE_ID RELEASE_IMAGE RELEASE_IMAGE_ID CHECKPOINT_DIR SOURCE_COMMIT SOURCE_TREE BASELINE_SHA256; do
  test "$(grep -c "^$key=" "$env_file")" -eq 1
done
. "$env_file"
test "$RELEASE_ID" = "$release_id"
test "$CHECKPOINT_DIR" = "/root/backups/bublik-ts/cutover-$release_id"
test "$(readlink -f -- "$release_dir")" = "$release_dir"
test -f "$state_dir/02-checkpoint-captured"
test "$(readlink -f -- "$CHECKPOINT_DIR")" = "$CHECKPOINT_DIR"
test "$(stat -c '%U:%G:%a' "$CHECKPOINT_DIR")" = root:root:700
test "$(stat -c '%U:%G:%a' "$CHECKPOINT_DIR/SHA256SUMS.capture")" = root:root:600
(cd "$CHECKPOINT_DIR" && sha256sum -c SHA256SUMS.capture)

checkpoint_env="$CHECKPOINT_DIR/checkpoint.env"
test "$(stat -c '%U:%G:%a' "$checkpoint_env")" = root:root:600
test "$(wc -l < "$checkpoint_env")" -eq 11
if grep -Evq '^(OLD_BOT_IMAGE_ID=sha256:[0-9a-f]{64}|OLD_BOT_IMAGE_REF=[A-Za-z0-9._/@:+-]+|OLD_BOT_CHECKPOINT_TAG=bublik-checkpoint-bot:[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|OLD_REDIS_IMAGE_ID=sha256:[0-9a-f]{64}|OLD_REDIS_IMAGE_REF=[A-Za-z0-9._/@:+-]+|OLD_REDIS_CHECKPOINT_TAG=bublik-checkpoint-redis:[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|POSTGRES_IMAGE_ID=sha256:[0-9a-f]{64}|POSTGRES_IMAGE_REF=[A-Za-z0-9._/@:+-]+|POSTGRES_USER=bublik|POSTGRES_DB=bublik|ACTIVE_ENV_SHA256=[0-9a-f]{64})$' "$checkpoint_env"; then
  exit 1
fi
for key in OLD_BOT_IMAGE_ID OLD_BOT_IMAGE_REF OLD_BOT_CHECKPOINT_TAG OLD_REDIS_IMAGE_ID OLD_REDIS_IMAGE_REF OLD_REDIS_CHECKPOINT_TAG POSTGRES_IMAGE_ID POSTGRES_IMAGE_REF POSTGRES_USER POSTGRES_DB ACTIVE_ENV_SHA256; do
  test "$(grep -c "^$key=" "$checkpoint_env")" -eq 1
done
. "$checkpoint_env"
docker load --input "$CHECKPOINT_DIR/old-redis-image.tar" >/dev/null
docker load --input "$CHECKPOINT_DIR/postgres-image.tar" >/dev/null
test "$(docker image inspect -f '{{.Id}}' "$OLD_REDIS_CHECKPOINT_TAG")" = "$OLD_REDIS_IMAGE_ID"
test "$(docker image inspect -f '{{.Id}}' "$POSTGRES_IMAGE_ID")" = "$POSTGRES_IMAGE_ID"
test "$(docker inspect -f '{{.State.Running}}' bublik-bot)" = false
test "$(docker inspect -f '{{.State.Running}}' bublik-redis)" = false
test "$(docker inspect -f '{{.State.Running}}' bublik-postgres)" = false

network="bublik-rehearsal-net-$release_id"
volume="bublik-rehearsal-pg-$release_id"
container="bublik-rehearsal-pg-$release_id"
redis_volume="bublik-rehearsal-redis-$release_id"
redis_container="bublik-rehearsal-redis-$release_id"
test -z "$(docker ps -aq --filter "name=^/$container$")"
test -z "$(docker ps -aq --filter "name=^/$redis_container$")"
test -z "$(docker network ls -q --filter "name=^$network$")"
test -z "$(docker volume ls -q --filter "name=^$volume$")"
test -z "$(docker volume ls -q --filter "name=^$redis_volume$")"

cleanup() {
  set +e
  for owned_container in "$redis_container" "$container"; do
    if docker inspect "$owned_container" >/dev/null 2>&1; then
      if test "$(docker inspect -f '{{ index .Config.Labels "bublik.release" }}' "$owned_container" 2>/dev/null)" = "$release_id" &&
         test "$(docker inspect -f '{{ index .Config.Labels "bublik.purpose" }}' "$owned_container" 2>/dev/null)" = rehearsal; then
        docker rm -f "$owned_container" >/dev/null 2>&1
      else
        printf 'Refusing cleanup of unowned container %s\n' "$owned_container" >&2
      fi
    fi
  done
  for owned_volume in "$redis_volume" "$volume"; do
    if docker volume inspect "$owned_volume" >/dev/null 2>&1; then
      if test "$(docker volume inspect -f '{{ index .Labels "bublik.release" }}' "$owned_volume" 2>/dev/null)" = "$release_id" &&
         test "$(docker volume inspect -f '{{ index .Labels "bublik.purpose" }}' "$owned_volume" 2>/dev/null)" = rehearsal &&
         test -z "$(docker ps -aq --filter "volume=$owned_volume")"; then
        docker volume rm "$owned_volume" >/dev/null 2>&1
      else
        printf 'Refusing cleanup of unowned/in-use volume %s\n' "$owned_volume" >&2
      fi
    fi
  done
  if docker network inspect "$network" >/dev/null 2>&1; then
    if test "$(docker network inspect -f '{{ index .Labels "bublik.release" }}' "$network" 2>/dev/null)" = "$release_id" &&
       test "$(docker network inspect -f '{{ index .Labels "bublik.purpose" }}' "$network" 2>/dev/null)" = rehearsal &&
       test "$(docker network inspect -f '{{len .Containers}}' "$network" 2>/dev/null)" = 0; then
      docker network rm "$network" >/dev/null 2>&1
    else
      printf 'Refusing cleanup of unowned/in-use network %s\n' "$network" >&2
    fi
  fi
  set -e
}
trap cleanup EXIT

docker network create --internal \
  --label "bublik.release=$release_id" --label bublik.purpose=rehearsal \
  "$network" >/dev/null
docker volume create \
  --label "bublik.release=$release_id" --label bublik.purpose=rehearsal \
  "$volume" >/dev/null
docker volume create \
  --label "bublik.release=$release_id" --label bublik.purpose=rehearsal \
  "$redis_volume" >/dev/null

# Тот же image/entrypoint/env и тот же массив Cmd; после старта полный Redis
# CONFIG GET дополнительно обязан побайтно совпасть с production capture.
test "$(docker inspect -f '{{json .Config.Entrypoint}}' bublik-redis)" = \
  "$(docker image inspect -f '{{json .Config.Entrypoint}}' "$OLD_REDIS_IMAGE_ID")"
test "$(docker inspect -f '{{json .Config.Env}}' bublik-redis)" = \
  "$(docker image inspect -f '{{json .Config.Env}}' "$OLD_REDIS_IMAGE_ID")"
test "$(docker inspect -f '{{json .Config.User}}' bublik-redis)" = \
  "$(docker image inspect -f '{{json .Config.User}}' "$OLD_REDIS_IMAGE_ID")"
test "$(docker inspect -f '{{json .Config.WorkingDir}}' bublik-redis)" = \
  "$(docker image inspect -f '{{json .Config.WorkingDir}}' "$OLD_REDIS_IMAGE_ID")"
mapfile -t redis_cmd < <(
  docker inspect -f '{{range .Config.Cmd}}{{println .}}{{end}}' bublik-redis
)
test "${#redis_cmd[@]}" -ge 1
test -n "${redis_cmd[0]}"

docker run --rm --user 0:0 \
  --label "bublik.release=$release_id" --label bublik.purpose=rehearsal \
  --mount type=bind,src="$CHECKPOINT_DIR/redis-data",dst=/checkpoint,readonly \
  --mount type=volume,src="$redis_volume",dst=/data \
  --entrypoint sh "$OLD_REDIS_IMAGE_ID" -ec '
    test -z "$(find /data -mindepth 1 -print -quit)"
    cp -a /checkpoint/. /data/
  '
docker run --rm --user 0:0 \
  --label "bublik.release=$release_id" --label bublik.purpose=rehearsal \
  --mount type=volume,src="$redis_volume",dst=/data,readonly \
  --entrypoint sh "$OLD_REDIS_IMAGE_ID" -ec '
    cd /data
    find . -xdev -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum
  ' > "$CHECKPOINT_DIR/redis-restored-volume.before-start.sha256"
cmp "$CHECKPOINT_DIR/redis-data.after-validation.sha256" \
  "$CHECKPOINT_DIR/redis-restored-volume.before-start.sha256"

docker create --name "$redis_container" \
  --label "bublik.release=$release_id" --label bublik.purpose=rehearsal \
  --network "$network" --network-alias redis-restore \
  --mount type=volume,src="$redis_volume",dst=/data \
  "$OLD_REDIS_IMAGE_ID" "${redis_cmd[@]}" >/dev/null
test "$(docker inspect -f '{{.Image}}' "$redis_container")" = "$OLD_REDIS_IMAGE_ID"
test "$(docker inspect -f '{{json .Config.Cmd}}' "$redis_container")" = \
  "$(docker inspect -f '{{json .Config.Cmd}}' bublik-redis)"
test "$(docker inspect -f '{{json .Config.Entrypoint}}' "$redis_container")" = \
  "$(docker inspect -f '{{json .Config.Entrypoint}}' bublik-redis)"
test "$(docker inspect -f '{{json .Config.Env}}' "$redis_container")" = \
  "$(docker inspect -f '{{json .Config.Env}}' bublik-redis)"
test "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$redis_container")" = "$redis_volume"
test "$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$redis_container")" = null
test -z "$(docker port "$redis_container")"

docker start "$redis_container" >/dev/null
redis_ready=0
for attempt in $(seq 1 60); do
  if docker exec "$redis_container" redis-cli --raw PING 2>/dev/null | grep -Fxq PONG; then
    redis_ready=1
    break
  fi
  test "$(docker inspect -f '{{.State.Running}}' "$redis_container")" = true
  sleep 1
done
test "$redis_ready" -eq 1
test -z "$(docker port "$redis_container")"
docker exec "$redis_container" redis-cli --raw CONFIG GET '*' |
  tr -d '\r' > "$CHECKPOINT_DIR/redis-config.rehearsal"
diff -u "$CHECKPOINT_DIR/redis-config.before" \
  "$CHECKPOINT_DIR/redis-config.rehearsal"

test ! -e "$CHECKPOINT_DIR/redis-after.json"
test ! -e "$CHECKPOINT_DIR/redis-comparison.json"
docker run --rm --user 0:0 --network "$network" \
  --env REDIS_URL=redis://redis-restore:6379/0 \
  -v "$CHECKPOINT_DIR:/checkpoint" --entrypoint node "$RELEASE_IMAGE_ID" \
  scripts/snapshot-redis-data.js --snapshot \
  --output /checkpoint/redis-after.json
docker run --rm --user 0:0 \
  -v "$CHECKPOINT_DIR:/checkpoint" --entrypoint node "$RELEASE_IMAGE_ID" \
  scripts/snapshot-redis-data.js \
  --compare /checkpoint/redis-before.json /checkpoint/redis-after.json \
  --expiry-tolerance-ms 0 --expiry-grace-ms 0 \
  --output /checkpoint/redis-comparison.json
docker run --rm -i --entrypoint node "$RELEASE_IMAGE_ID" -e '
  let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
    const r=JSON.parse(s);
    if(r.format!=="bublik-redis-data-comparison/v1"||
       r.status!=="identical"||r.expiryToleranceMs!==0||r.expiryGraceMs!==0||
       r.differences.length!==0||
       r.beforeKeyCount-r.afterKeyCount!==r.expectedExpired.length||
       r.expectedExpired.some(e=>BigInt(e.expireAtMs)>
         BigInt(new Date(e.afterCapturedAt).getTime())))process.exit(1);
  });
' < "$CHECKPOINT_DIR/redis-comparison.json"

test "$(docker inspect -f '{{ index .Config.Labels "bublik.release" }}' "$redis_container")" = "$release_id"
test "$(docker inspect -f '{{ index .Config.Labels "bublik.purpose" }}' "$redis_container")" = rehearsal
test "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$redis_container")" = "$redis_volume"
docker stop --time 30 "$redis_container" >/dev/null
test "$(docker inspect -f '{{.State.Running}}' "$redis_container")" = false
docker rm "$redis_container" >/dev/null
test "$(docker volume inspect -f '{{ index .Labels "bublik.release" }}' "$redis_volume")" = "$release_id"
test "$(docker volume inspect -f '{{ index .Labels "bublik.purpose" }}' "$redis_volume")" = rehearsal
test -z "$(docker ps -aq --filter "volume=$redis_volume")"
docker volume rm "$redis_volume" >/dev/null

docker run -d --name "$container" \
  --label "bublik.release=$release_id" --label bublik.purpose=rehearsal \
  --network "$network" --network-alias postgres \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=bublik \
  -v "$volume:/var/lib/postgresql/data" \
  "$POSTGRES_IMAGE_ID" >/dev/null

test "$(docker inspect -f '{{.Image}}' "$container")" = "$POSTGRES_IMAGE_ID"
test "$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$container")" = null
docker exec "$container" postgres --version | grep -Eq ' 16\.'
pg_ready=0
for attempt in $(seq 1 90); do
  if docker exec "$container" pg_isready -U postgres -d bublik >/dev/null 2>&1; then
    pg_ready=1
    break
  fi
  test "$(docker inspect -f '{{.State.Running}}' "$container")" = true
  sleep 1
done
test "$pg_ready" -eq 1

docker exec -i "$container" pg_restore \
  -U postgres -d bublik --exit-on-error --no-owner --no-acl \
  < "$CHECKPOINT_DIR/postgres.dump"
docker exec "$container" psql -U postgres -d bublik -Atqc \
  'SELECT current_database(), current_setting('\''server_version_num'\'')::int / 10000' |
  grep -Fx 'bublik|16'

export DATABASE_URL='postgresql://postgres@postgres:5432/bublik?schema=public'
test ! -e "$CHECKPOINT_DIR/rehearsal-preflight.json"
test ! -e "$CHECKPOINT_DIR/rehearsal-snapshot.json"
test ! -e "$CHECKPOINT_DIR/rehearsal-comparison.json"
test ! -e "$CHECKPOINT_DIR/rehearsal-migrate.log"
test ! -e "$CHECKPOINT_DIR/rehearsal-postflight.json"
test ! -e "$CHECKPOINT_DIR/rehearsal-after-snapshot.json"
test ! -e "$CHECKPOINT_DIR/rehearsal-after-comparison.json"
docker run --rm --user 0:0 --network "$network" \
  -e DATABASE_URL -v "$CHECKPOINT_DIR:/checkpoint" \
  --entrypoint node "$RELEASE_IMAGE_ID" \
  scripts/snapshot-baseline-data.js --preflight-operational \
  --output /checkpoint/rehearsal-preflight.json
docker run --rm --user 0:0 --network "$network" \
  -e DATABASE_URL -v "$CHECKPOINT_DIR:/checkpoint" \
  --entrypoint node "$RELEASE_IMAGE_ID" \
  scripts/snapshot-baseline-data.js --snapshot-operational \
  --output /checkpoint/rehearsal-snapshot.json
docker run --rm --user 0:0 --entrypoint node \
  -v "$CHECKPOINT_DIR:/checkpoint" "$RELEASE_IMAGE_ID" \
  scripts/snapshot-baseline-data.js \
  --compare /checkpoint/baseline-before.json /checkpoint/rehearsal-snapshot.json \
  --output /checkpoint/rehearsal-comparison.json
docker run --rm -i --entrypoint node "$RELEASE_IMAGE_ID" -e '
  let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
    const r=JSON.parse(s);
    if(r.format!=="bublik-baseline-data-comparison/v1"||r.status!=="identical"||
       r.profile!=="operational"||r.tableCount!==40||r.sequenceCount!==1||
       r.differences.length!==0)process.exit(1);
  });
' < "$CHECKPOINT_DIR/rehearsal-comparison.json"

docker run --rm --network "$network" \
  -e DATABASE_URL \
  -e MIGRATE_ONLY=1 -e PRISMA_BASELINE_EXISTING=0 \
  "$RELEASE_IMAGE_ID" > "$CHECKPOINT_DIR/rehearsal-migrate.log" 2>&1
grep -Fq 'database migration completed; migration-only mode requested' \
  "$CHECKPOINT_DIR/rehearsal-migrate.log"
if grep -Fq 'ok, starting bot' "$CHECKPOINT_DIR/rehearsal-migrate.log"; then
  exit 1
fi

docker run --rm --user 0:0 --network "$network" \
  -e DATABASE_URL -v "$CHECKPOINT_DIR:/checkpoint" \
  --entrypoint node "$RELEASE_IMAGE_ID" \
  scripts/snapshot-baseline-data.js --postflight-operational \
  --output /checkpoint/rehearsal-postflight.json
docker run --rm -i --entrypoint node "$RELEASE_IMAGE_ID" -e '
  let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
    const r=JSON.parse(s);
    const gate=require("/app/scripts/snapshot-baseline-data.js");
    const requiredChecks=gate.expectedPostflightCheckIds(
      r.schema,
      gate.POSTFLIGHT_PROFILE.OPERATIONAL
    );
    const checkIds=r.checks.map(check=>check.id);
    const countIds=r.counts.map(count=>count.id);
    if(r.format!=="bublik-hardening-data-postflight/v1"||r.status!=="ok"||
       r.profile!=="operational"||
       r.hardeningMigration!=="20260719010000_hardening"||r.tableCount!==40||
       requiredChecks.length!==19||r.checks.length!==19||
       new Set(checkIds).size!==19||
       JSON.stringify(checkIds)!==JSON.stringify(requiredChecks)||
       r.checks.some(check=>check.violations!=="0")||r.skippedChecks.length!==0||
       r.counts.length!==3||new Set(countIds).size!==3||
       r.counts.some(count=>!/^(0|[1-9][0-9]*)$/.test(count.count)))process.exit(1);
  });
' < "$CHECKPOINT_DIR/rehearsal-postflight.json"

docker run --rm --network "$network" -e DATABASE_URL \
  --entrypoint sh "$RELEASE_IMAGE_ID" -ec \
  './node_modules/.bin/prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code'

docker run --rm --user 0:0 --network "$network" \
  -e DATABASE_URL -v "$CHECKPOINT_DIR:/checkpoint" \
  --entrypoint node "$RELEASE_IMAGE_ID" \
  scripts/snapshot-baseline-data.js --snapshot-operational \
  --output /checkpoint/rehearsal-after-snapshot.json
docker run --rm --user 0:0 --entrypoint node \
  -v "$CHECKPOINT_DIR:/checkpoint" "$RELEASE_IMAGE_ID" \
  scripts/snapshot-baseline-data.js \
  --compare /checkpoint/baseline-before.json /checkpoint/rehearsal-after-snapshot.json \
  --output /checkpoint/rehearsal-after-comparison.json
docker run --rm -i --entrypoint node "$RELEASE_IMAGE_ID" -e '
  let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
    const r=JSON.parse(s);
    if(r.format!=="bublik-baseline-data-comparison/v1"||r.status!=="identical"||
       r.profile!=="operational"||r.tableCount!==40||r.sequenceCount!==1||
       r.differences.length!==0)process.exit(1);
  });
' < "$CHECKPOINT_DIR/rehearsal-after-comparison.json"
unset DATABASE_URL

cleanup
trap - EXIT
test -z "$(docker ps -aq --filter "name=^/$container$")"
test -z "$(docker ps -aq --filter "name=^/$redis_container$")"
test -z "$(docker volume ls -q --filter "name=^$volume$")"
test -z "$(docker volume ls -q --filter "name=^$redis_volume$")"
test -z "$(docker network ls -q --filter "name=^$network$")"

chown -R root:root "$CHECKPOINT_DIR"
find "$CHECKPOINT_DIR" -type d -exec chmod 0700 {} +
find "$CHECKPOINT_DIR" -type f -exec chmod 0600 {} +
(
  cd "$CHECKPOINT_DIR"
  find . -type f ! -name SHA256SUMS.final -print0 |
    LC_ALL=C sort -z |
    xargs -0 sha256sum > SHA256SUMS.final
  chmod 0600 SHA256SUMS.final
  sha256sum -c SHA256SUMS.final
)
install -o root -g root -m 0600 /dev/null "$state_dir/03-checkpoint-sealed"
printf 'Redis full restore exact; PostgreSQL restore + migration passed: operational postflight 19/19; baseline 40/40 + sequence identical.\n'
~~~

### 4. Зашифровать checkpoint и проверить off-host копию

AGE_RECIPIENT — публичный age-recipient, AGE_IDENTITY_FILE — отдельный root-only
ключ для локальной проверки расшифрования. OFFSITE_SSH задаётся как user@host,
OFFSITE_DIR — абсолютный каталог на другом хосте. До подтверждённой удалённой
checksum выкладка блокируется.

~~~bash
set -euo pipefail
umask 077
test "$(id -u)" -eq 0
test -n "$RELEASE_ID"
test -n "$AGE_RECIPIENT"
test -n "$AGE_IDENTITY_FILE"
test -n "$OFFSITE_SSH"
test -n "$OFFSITE_DIR"
release_id="$RELEASE_ID"
printf '%s\n' "$release_id" | grep -Eq '^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$'
printf '%s\n' "$OFFSITE_SSH" | grep -Eq '^([A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*$'
printf '%s\n' "$OFFSITE_DIR" | grep -Eq '^/[A-Za-z0-9._/-]+$'
case "/$OFFSITE_DIR/" in
  *"/../"*|*"/./"*|*"//"*) exit 1 ;;
esac
command -v age >/dev/null
test "$(readlink -f -- "$AGE_IDENTITY_FILE")" = "$AGE_IDENTITY_FILE"
test "$(stat -c '%U:%G:%a' "$AGE_IDENTITY_FILE")" = root:root:600

release_dir="/root/releases/bublik-ts/$release_id"
state_dir="/root/deploy-state/bublik-ts/$release_id"
env_file="$release_dir/deployment.env"
test "$(stat -c '%U:%G:%a' "$release_dir")" = root:root:700
test "$(stat -c '%U:%G:%a' "$env_file")" = root:root:600
test "$(stat -c '%U:%G:%a' "$release_dir/SHA256SUMS.release")" = root:root:600
(cd "$release_dir" && sha256sum -c SHA256SUMS.release)
if grep -Evq '^(RELEASE_ID=[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|RELEASE_IMAGE=bublik-n-bot:release-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|RELEASE_IMAGE_ID=sha256:[0-9a-f]{64}|CHECKPOINT_DIR=/root/backups/bublik-ts/cutover-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|SOURCE_COMMIT=[0-9a-f]{40}|SOURCE_TREE=[0-9a-f]{40}|BASELINE_SHA256=[0-9a-f]{64})$' "$env_file"; then
  exit 1
fi
test "$(wc -l < "$env_file")" -eq 7
for key in RELEASE_ID RELEASE_IMAGE RELEASE_IMAGE_ID CHECKPOINT_DIR SOURCE_COMMIT SOURCE_TREE BASELINE_SHA256; do
  test "$(grep -c "^$key=" "$env_file")" -eq 1
done
. "$env_file"
test "$RELEASE_ID" = "$release_id"
test "$(readlink -f -- "$release_dir")" = "$release_dir"
test -f "$state_dir/03-checkpoint-sealed"
test "$(readlink -f -- "$CHECKPOINT_DIR")" = "$CHECKPOINT_DIR"
test "$(stat -c '%U:%G:%a' "$CHECKPOINT_DIR")" = root:root:700
test "$(stat -c '%U:%G:%a' "$CHECKPOINT_DIR/SHA256SUMS.final")" = root:root:600
(cd "$CHECKPOINT_DIR" && sha256sum -c SHA256SUMS.final)
test "$(docker inspect -f '{{.State.Running}}' bublik-bot)" = false
test "$(docker inspect -f '{{.State.Running}}' bublik-redis)" = false
test "$(docker inspect -f '{{.State.Running}}' bublik-postgres)" = false

staging=/root/offsite-staging/bublik-ts
archive="cutover-$release_id.tar.age"
install -d -o root -g root -m 0700 "$staging"
if test ! -e "$staging/$archive"; then
  archive_tmp="$(mktemp "$staging/.$archive.tmp.XXXXXX")"
  cleanup_archive_tmp() { rm -f -- "$archive_tmp"; }
  trap cleanup_archive_tmp EXIT
  tar --numeric-owner -C "$(dirname "$CHECKPOINT_DIR")" \
    -cf - "$(basename "$CHECKPOINT_DIR")" |
    age --recipient "$AGE_RECIPIENT" > "$archive_tmp"
  test -s "$archive_tmp"
  chmod 0600 "$archive_tmp"
  test ! -e "$staging/$archive"
  mv "$archive_tmp" "$staging/$archive"
  trap - EXIT
fi
test "$(stat -c '%U:%G:%a' "$staging/$archive")" = root:root:600
if test ! -e "$staging/$archive.sha256"; then
  (cd "$staging" && sha256sum "$archive" > "$archive.sha256")
fi
chmod 0600 "$staging/$archive.sha256"
(cd "$staging" && sha256sum -c "$archive.sha256")

age --decrypt --identity "$AGE_IDENTITY_FILE" "$staging/$archive" |
  tar -tf - > "$state_dir/offsite-archive.list"
grep -Fxq "cutover-$release_id/postgres.dump" "$state_dir/offsite-archive.list"
grep -Fxq "cutover-$release_id/SHA256SUMS.final" "$state_dir/offsite-archive.list"
chmod 0600 "$state_dir/offsite-archive.list"
checkpoint_manifest_sha="$(sha256sum "$CHECKPOINT_DIR/SHA256SUMS.final" | awk '{print $1}')"
archive_manifest_sha="$(
  age --decrypt --identity "$AGE_IDENTITY_FILE" "$staging/$archive" |
    tar -xOf - "cutover-$release_id/SHA256SUMS.final" |
    sha256sum | awk '{print $1}'
)"
test "$archive_manifest_sha" = "$checkpoint_manifest_sha"

ssh "$OFFSITE_SSH" bash -se -- "$OFFSITE_DIR" <<'REMOTE'
set -euo pipefail
umask 077
target_dir="$1"
test "$(printf '%s\n' "$target_dir" | grep -Ec '^/[A-Za-z0-9._/-]+$')" -eq 1
case "/$target_dir/" in
  *"/../"*|*"/./"*|*"//"*) exit 1 ;;
esac
install -d -m 0700 "$target_dir"
REMOTE

scp -p "$staging/$archive" \
  "$OFFSITE_SSH:$OFFSITE_DIR/.$archive.incoming"
scp -p "$staging/$archive.sha256" \
  "$OFFSITE_SSH:$OFFSITE_DIR/.$archive.sha256.incoming"
ssh "$OFFSITE_SSH" bash -se -- "$OFFSITE_DIR" "$archive" <<'REMOTE'
set -euo pipefail
umask 077
target_dir="$1"
archive="$2"
test "$(printf '%s\n' "$target_dir" | grep -Ec '^/[A-Za-z0-9._/-]+$')" -eq 1
case "/$target_dir/" in
  *"/../"*|*"/./"*|*"//"*) exit 1 ;;
esac
printf '%s\n' "$archive" | grep -Eq '^cutover-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}\.tar\.age$'
cd "$target_dir"
incoming=".$archive.incoming"
incoming_sum=".$archive.sha256.incoming"
test -s "$incoming"
test -s "$incoming_sum"
expected="$(awk 'NR == 1 { print $1 }' "$incoming_sum")"
printf '%s\n' "$expected" | grep -Eq '^[0-9a-f]{64}$'
test "$(sha256sum "$incoming" | awk '{print $1}')" = "$expected"
if test -e "$archive"; then
  test "$(sha256sum "$archive" | awk '{print $1}')" = "$expected"
  rm -f -- "$incoming"
else
  mv "$incoming" "$archive"
fi
printf '%s  %s\n' "$expected" "$archive" > "$archive.sha256.tmp"
mv "$archive.sha256.tmp" "$archive.sha256"
rm -f -- "$incoming_sum"
chmod 0600 "$archive" "$archive.sha256"
sha256sum -c "$archive.sha256"
test -s "$archive"
REMOTE

install -o root -g root -m 0600 /dev/null "$state_dir/04-offsite-verified"
printf 'Encrypted off-host checkpoint verified.\n'
~~~

### 5. Атомарно применить release, миграцию и запустить сервисы

Только теперь, когда bot, Redis и production PostgreSQL остановлены, меняются active Compose/locales.
.env остаётся побайтно тем же. Перед миграцией повторно проверяются DB target и
operational baseline snapshot. Текущий повторный upgrade применяет миграции
4→6 только с `PRISMA_BASELINE_EXISTING=0`. После миграции все 40 исходных таблиц
и исходная sequence должны иметь то же состояние; сравнение количества нескольких
таблиц недостаточно.

~~~bash
set -euo pipefail
umask 077
test "$(id -u)" -eq 0
test -n "$TMUX"
test -n "$RELEASE_ID"
release_id="$RELEASE_ID"
printf '%s\n' "$release_id" | grep -Eq '^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$'

project=bublik-n
active=/opt/bublik-n
release_dir="/root/releases/bublik-ts/$release_id"
state_dir="/root/deploy-state/bublik-ts/$release_id"
env_file="$release_dir/deployment.env"
test "$(stat -c '%U:%G:%a' "$release_dir")" = root:root:700
test "$(stat -c '%U:%G:%a' "$env_file")" = root:root:600
test "$(stat -c '%U:%G:%a' "$release_dir/SHA256SUMS.release")" = root:root:600
(cd "$release_dir" && sha256sum -c SHA256SUMS.release)
if grep -Evq '^(RELEASE_ID=[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|RELEASE_IMAGE=bublik-n-bot:release-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|RELEASE_IMAGE_ID=sha256:[0-9a-f]{64}|CHECKPOINT_DIR=/root/backups/bublik-ts/cutover-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|SOURCE_COMMIT=[0-9a-f]{40}|SOURCE_TREE=[0-9a-f]{40}|BASELINE_SHA256=[0-9a-f]{64})$' "$env_file"; then
  exit 1
fi
test "$(wc -l < "$env_file")" -eq 7
for key in RELEASE_ID RELEASE_IMAGE RELEASE_IMAGE_ID CHECKPOINT_DIR SOURCE_COMMIT SOURCE_TREE BASELINE_SHA256; do
  test "$(grep -c "^$key=" "$env_file")" -eq 1
done
. "$env_file"
test "$RELEASE_ID" = "$release_id"
test "$(readlink -f -- "$release_dir")" = "$release_dir"
test "$(docker image inspect -f '{{.Id}}' "$RELEASE_IMAGE")" = "$RELEASE_IMAGE_ID"
test -f "$state_dir/04-offsite-verified"
test "$(readlink -f -- "$CHECKPOINT_DIR")" = "$CHECKPOINT_DIR"
test "$(stat -c '%U:%G:%a' "$CHECKPOINT_DIR")" = root:root:700
test "$(stat -c '%U:%G:%a' "$CHECKPOINT_DIR/SHA256SUMS.final")" = root:root:600
(cd "$CHECKPOINT_DIR" && sha256sum -c SHA256SUMS.final)

checkpoint_env="$CHECKPOINT_DIR/checkpoint.env"
test "$(stat -c '%U:%G:%a' "$checkpoint_env")" = root:root:600
test "$(wc -l < "$checkpoint_env")" -eq 11
if grep -Evq '^(OLD_BOT_IMAGE_ID=sha256:[0-9a-f]{64}|OLD_BOT_IMAGE_REF=[A-Za-z0-9._/@:+-]+|OLD_BOT_CHECKPOINT_TAG=bublik-checkpoint-bot:[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|OLD_REDIS_IMAGE_ID=sha256:[0-9a-f]{64}|OLD_REDIS_IMAGE_REF=[A-Za-z0-9._/@:+-]+|OLD_REDIS_CHECKPOINT_TAG=bublik-checkpoint-redis:[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|POSTGRES_IMAGE_ID=sha256:[0-9a-f]{64}|POSTGRES_IMAGE_REF=[A-Za-z0-9._/@:+-]+|POSTGRES_USER=bublik|POSTGRES_DB=bublik|ACTIVE_ENV_SHA256=[0-9a-f]{64})$' "$checkpoint_env"; then
  exit 1
fi
for key in OLD_BOT_IMAGE_ID OLD_BOT_IMAGE_REF OLD_BOT_CHECKPOINT_TAG OLD_REDIS_IMAGE_ID OLD_REDIS_IMAGE_REF OLD_REDIS_CHECKPOINT_TAG POSTGRES_IMAGE_ID POSTGRES_IMAGE_REF POSTGRES_USER POSTGRES_DB ACTIVE_ENV_SHA256; do
  test "$(grep -c "^$key=" "$checkpoint_env")" -eq 1
done
. "$checkpoint_env"
target_identity_file="$state_dir/target-identities.env"
target_identity_sum="$state_dir/target-identities.env.sha256"
maintenance_budget_file="$state_dir/maintenance-budget.env"
test "$(stat -c '%U:%G:%a' "$target_identity_file")" = root:root:600
test "$(stat -c '%U:%G:%a' "$target_identity_sum")" = root:root:600
test "$(stat -c '%U:%G:%a' "$maintenance_budget_file")" = root:root:600
test "$(stat -c '%U:%G:%a' "$state_dir/maintenance-budget.env.sha256")" = root:root:600
test "$(stat -c '%U:%G:%a' "$state_dir/maintenance-gate.sha256")" = root:root:600
(cd "$state_dir" && sha256sum -c target-identities.env.sha256)
(cd "$state_dir" && sha256sum -c maintenance-budget.env.sha256)
(cd "$state_dir" && sha256sum -c maintenance-gate.sha256)
test "$(wc -l < "$target_identity_file")" -eq 7
if grep -Evq '^(BOT_CONTAINER_ID=[0-9a-f]{64}|POSTGRES_CONTAINER_ID=[0-9a-f]{64}|REDIS_CONTAINER_ID=[0-9a-f]{64}|BOT_IMAGE_ID=sha256:[0-9a-f]{64}|POSTGRES_TARGET_IMAGE_ID=sha256:[0-9a-f]{64}|REDIS_IMAGE_ID=sha256:[0-9a-f]{64}|TARGET_NETWORK_ID=[0-9a-f]{64})$' "$target_identity_file"; then
  exit 1
fi
for key in BOT_CONTAINER_ID POSTGRES_CONTAINER_ID REDIS_CONTAINER_ID BOT_IMAGE_ID POSTGRES_TARGET_IMAGE_ID REDIS_IMAGE_ID TARGET_NETWORK_ID; do
  test "$(grep -c "^$key=" "$target_identity_file")" -eq 1
done
. "$target_identity_file"
test "$BOT_IMAGE_ID" = "$OLD_BOT_IMAGE_ID"
test "$POSTGRES_TARGET_IMAGE_ID" = "$POSTGRES_IMAGE_ID"
test "$REDIS_IMAGE_ID" = "$OLD_REDIS_IMAGE_ID"

test "$(wc -l < "$maintenance_budget_file")" -eq 5
if grep -Evq '^(MAINTENANCE_WINDOW_DATE=[0-9]{4}-[0-9]{2}-[0-9]{2}|MAINTENANCE_STARTED_AT_EPOCH=[0-9]{10,}|MAINTENANCE_DEADLINE_EPOCH=[0-9]{10,}|MAINTENANCE_WINDOW_DEADLINE_EPOCH=[0-9]{10,}|DOWNTIME_BUDGET_MINUTES=[1-9][0-9]*)$' "$maintenance_budget_file"; then
  exit 1
fi
for key in MAINTENANCE_WINDOW_DATE MAINTENANCE_STARTED_AT_EPOCH MAINTENANCE_DEADLINE_EPOCH MAINTENANCE_WINDOW_DEADLINE_EPOCH DOWNTIME_BUDGET_MINUTES; do
  test "$(grep -c "^$key=" "$maintenance_budget_file")" -eq 1
done
. "$maintenance_budget_file"
test "$DOWNTIME_BUDGET_MINUTES" -ge 30
test "$DOWNTIME_BUDGET_MINUTES" -le 360
test "$MAINTENANCE_DEADLINE_EPOCH" -le "$MAINTENANCE_WINDOW_DEADLINE_EPOCH"
test "$(date +%s)" -lt "$MAINTENANCE_DEADLINE_EPOCH"
test "$(date +%s)" -lt "$MAINTENANCE_WINDOW_DEADLINE_EPOCH"
current_msk="$(TZ=Europe/Moscow date '+%Y-%m-%d|%H|%M|%z')"
IFS='|' read -r current_msk_date current_msk_hour current_msk_minute current_msk_offset <<< "$current_msk"
test "$current_msk_date" = "$MAINTENANCE_WINDOW_DATE"
test "$current_msk_offset" = +0300
printf '%s\n' "$current_msk_hour" | grep -Eq '^[0-2][0-9]$'
printf '%s\n' "$current_msk_minute" | grep -Eq '^[0-5][0-9]$'
current_msk_minute_of_day=$((10#$current_msk_hour * 60 + 10#$current_msk_minute))
test "$current_msk_minute_of_day" -ge 615
test "$current_msk_minute_of_day" -lt 975

assert_exact_pre_cutover_targets() {
  test "$(docker inspect -f '{{.Id}}' bublik-bot)" = "$BOT_CONTAINER_ID"
  test "$(docker inspect -f '{{.Id}}' bublik-postgres)" = "$POSTGRES_CONTAINER_ID"
  test "$(docker inspect -f '{{.Id}}' bublik-redis)" = "$REDIS_CONTAINER_ID"
  test "$(docker inspect -f '{{.Image}}' bublik-bot)" = "$BOT_IMAGE_ID"
  test "$(docker inspect -f '{{.Image}}' bublik-postgres)" = "$POSTGRES_TARGET_IMAGE_ID"
  test "$(docker inspect -f '{{.Image}}' bublik-redis)" = "$REDIS_IMAGE_ID"
  test "$(docker network inspect -f '{{.Id}}' bublik-n_default)" = "$TARGET_NETWORK_ID"
  test "$(docker network inspect -f '{{ index .Labels "com.docker.compose.project" }}' bublik-n_default)" = "$project"
  test "$(docker network inspect -f '{{ index .Labels "com.docker.compose.network" }}' bublik-n_default)" = default
  test "$(docker volume inspect -f '{{ index .Labels "com.docker.compose.project" }}' bublik-n_pg_data)" = "$project"
  test "$(docker volume inspect -f '{{ index .Labels "com.docker.compose.volume" }}' bublik-n_pg_data)" = pg_data
  test "$(docker volume inspect -f '{{ index .Labels "com.docker.compose.project" }}' bublik-n_redis_data)" = "$project"
  test "$(docker volume inspect -f '{{ index .Labels "com.docker.compose.volume" }}' bublik-n_redis_data)" = redis_data
  for spec in bublik-bot:bot bublik-postgres:postgres bublik-redis:redis; do
    container="${spec%%:*}"
    service="${spec#*:}"
    test "$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$container")" = "$project"
    test "$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.service" }}' "$container")" = "$service"
    test "$(docker inspect -f '{{with index .NetworkSettings.Networks "bublik-n_default"}}{{.NetworkID}}{{end}}' "$container")" = "$TARGET_NETWORK_ID"
  done
  test "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' bublik-postgres)" = bublik-n_pg_data
  test "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' bublik-redis)" = bublik-n_redis_data
}
assert_exact_pre_cutover_targets
test "$(readlink -f -- "$active")" = "$active"
test "$(readlink -f -- "$active/.env")" = "$active/.env"
test ! -L "$active/.env"
test "$(sha256sum "$active/.env" | awk '{print $1}')" = "$ACTIVE_ENV_SHA256"
test "$(stat -c '%U:%G:%a' "$active/.env")" = root:root:600
test "$(docker inspect -f '{{.State.Running}}' bublik-bot)" = false
test "$(docker inspect -f '{{.State.Running}}' bublik-redis)" = false
test "$(docker inspect -f '{{.State.Running}}' bublik-postgres)" = false
test "$(docker inspect -f '{{.Image}}' bublik-postgres)" = "$POSTGRES_IMAGE_ID"

staged="$(mktemp -d "/root/bublik-cutover.$release_id.XXXXXX")"
printf '%s\n' "$staged" |
  grep -Eq "^/root/bublik-cutover\.$release_id\.[A-Za-z0-9]{6}$"
test "$(readlink -f -- "$staged")" = "$staged"
cleanup_staged() {
  test ! -e "$staged" && return 0
  printf '%s\n' "$staged" |
    grep -Eq "^/root/bublik-cutover\.$release_id\.[A-Za-z0-9]{6}$"
  test "$(readlink -f -- "$staged")" = "$staged"
  rm -rf -- "$staged"
}
trap cleanup_staged EXIT
chmod 0700 "$staged"
tar -xf "$release_dir/release-files.tar" -C "$staged"
test -f "$staged/docker-compose.yml"
test -f "$staged/locales/ru.json"
test -f "$staged/locales/en.json"

assert_exact_pre_cutover_targets
test ! -e "$active/.docker-compose.pre-$release_id.yml"
test ! -e "$active/.locales.pre-$release_id"
test ! -e "$active/.locales.release-$release_id"
test -f "$active/docker-compose.yml"
test ! -L "$active/docker-compose.yml"
test "$(readlink -f -- "$active/docker-compose.yml")" = "$active/docker-compose.yml"
test -d "$active/locales"
test ! -L "$active/locales"
test "$(readlink -f -- "$active/locales")" = "$active/locales"
test -z "$(find "$active/locales" -type l -print -quit)"
cp "$active/docker-compose.yml" "$active/.docker-compose.pre-$release_id.yml"
chmod 0600 "$active/.docker-compose.pre-$release_id.yml"
cp -a "$staged/locales" "$active/.locales.release-$release_id"
chown -R root:root "$active/.locales.release-$release_id"
find "$active/.locales.release-$release_id" -type d -exec chmod 0755 {} +
find "$active/.locales.release-$release_id" -type f -exec chmod 0644 {} +
mv "$active/locales" "$active/.locales.pre-$release_id"
mv "$active/.locales.release-$release_id" "$active/locales"
install -o root -g root -m 0644 "$staged/docker-compose.yml" "$active/docker-compose.yml.next"
mv "$active/docker-compose.yml.next" "$active/docker-compose.yml"
test "$(sha256sum "$active/.env" | awk '{print $1}')" = "$ACTIVE_ENV_SHA256"
if grep -Eq '^PRISMA_BASELINE_EXISTING=1([[:space:]]*)$' "$active/.env"; then
  echo 'В active .env запрещено постоянное PRISMA_BASELINE_EXISTING=1' >&2
  exit 1
fi

release_env="$active/release.env"
test ! -e "$release_env"
test "$(docker image inspect -f '{{.Id}}' "$OLD_REDIS_CHECKPOINT_TAG")" = "$OLD_REDIS_IMAGE_ID"
cat > "$release_env" <<ENV
BUBLIK_IMAGE=$RELEASE_IMAGE
BUBLIK_REDIS_IMAGE=$OLD_REDIS_CHECKPOINT_TAG
PRISMA_BASELINE_EXISTING=0
ENV
chown root:root "$release_env"
chmod 0600 "$release_env"
test "$(wc -l < "$release_env")" -eq 3
if grep -Evq '^(BUBLIK_IMAGE=bublik-n-bot:release-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|BUBLIK_REDIS_IMAGE=bublik-checkpoint-redis:[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|PRISMA_BASELINE_EXISTING=0)$' "$release_env"; then
  exit 1
fi
(cd "$active" && sha256sum release.env > release.env.sha256)
chown root:root "$active/release.env.sha256"
chmod 0600 "$active/release.env.sha256"
(cd "$active" && sha256sum -c release.env.sha256)
cp "$release_env" "$state_dir/release.env.applied"
chmod 0600 "$state_dir/release.env.applied"

cd "$active"
compose_release() {
  docker compose -p "$project" \
    --env-file "$active/.env" --env-file "$release_env" "$@"
}
compose_release config --quiet
compose_release config > "$state_dir/effective-applied-compose.yaml"
compose_release config --format json > "$state_dir/effective-applied-compose.json"
chmod 0600 "$state_dir/effective-applied-compose.yaml"
chmod 0600 "$state_dir/effective-applied-compose.json"
docker run --rm -i --entrypoint node "$RELEASE_IMAGE_ID" -e '
  let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
    const r=JSON.parse(s);
    if(r.services.bot.image!==process.argv[1]||r.services.redis.image!==process.argv[2]||
       r.services.postgres.container_name!=="bublik-postgres")process.exit(1);
  });
' "$RELEASE_IMAGE" "$OLD_REDIS_CHECKPOINT_TAG" < "$state_dir/effective-applied-compose.json"

test "$(date +%s)" -lt "$MAINTENANCE_DEADLINE_EPOCH"
test "$(date +%s)" -lt "$MAINTENANCE_WINDOW_DEADLINE_EPOCH"
assert_exact_pre_cutover_targets
compose_release start postgres
pg_healthy=0
for attempt in $(seq 1 60); do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' bublik-postgres)"
  if test "$status" = healthy; then pg_healthy=1; break; fi
  test "$(docker inspect -f '{{.State.Running}}' bublik-postgres)" = true
  sleep 2
done
test "$pg_healthy" -eq 1
test "$(docker inspect -f '{{.Image}}' bublik-postgres)" = "$POSTGRES_IMAGE_ID"
test "$(
  docker exec bublik-postgres psql -U bublik -d bublik -Atqc \
    "SELECT count(*) FROM pg_stat_activity WHERE datname='bublik' AND pid <> pg_backend_pid()"
)" = 0

descriptor_js='const u=new URL(process.env.DATABASE_URL);const schemas=u.searchParams.getAll("schema");if(!["postgres:","postgresql:"].includes(u.protocol)||schemas.length>1||(schemas.length===1&&!schemas[0]))process.exit(1);const d={host:u.hostname,port:u.port||"5432",database:u.pathname.replace(/^\/+/,""),schema:schemas[0]||"public"};process.stdout.write(JSON.stringify(d)+"\n")'
docker run --rm --network bublik-n_default --env-file "$active/.env" \
  --entrypoint node "$RELEASE_IMAGE_ID" -e "$descriptor_js" \
  > "$state_dir/target-before-migration.json"
test "$(tr -d '\r\n' < "$state_dir/target-before-migration.json")" = '{"host":"postgres","port":"5432","database":"bublik","schema":"public"}'
cmp "$state_dir/target-old.json" "$state_dir/target-before-migration.json"

postgres_ip="$(docker inspect -f '{{with index .NetworkSettings.Networks "bublik-n_default"}}{{.IPAddress}}{{end}}' bublik-postgres)"
query_js='const{PrismaClient}=require("@prisma/client");const p=new PrismaClient();p.$queryRawUnsafe("SELECT current_database() AS database, inet_server_addr()::text AS server").then(r=>{console.log("database="+r[0].database+" server="+r[0].server)}).finally(()=>p.$disconnect())'
docker run --rm --network bublik-n_default --env-file "$active/.env" \
  --entrypoint node "$RELEASE_IMAGE_ID" -e "$query_js" \
  > "$state_dir/connection-before-migration.txt"
test "$(tr -d '\r\n' < "$state_dir/connection-before-migration.txt")" = "database=bublik server=$postgres_ip"

test ! -e "$state_dir/preflight-before-migration.json"
test ! -e "$state_dir/snapshot-before-migration.json"
test ! -e "$state_dir/comparison-before-migration.json"
docker run --rm --user 0:0 --network bublik-n_default \
  --env-file "$active/.env" -v "$state_dir:/state" \
  --entrypoint node "$RELEASE_IMAGE_ID" \
  scripts/snapshot-baseline-data.js --preflight-operational \
  --output /state/preflight-before-migration.json
docker run --rm --user 0:0 --network bublik-n_default \
  --env-file "$active/.env" -v "$state_dir:/state" \
  --entrypoint node "$RELEASE_IMAGE_ID" \
  scripts/snapshot-baseline-data.js --snapshot-operational \
  --output /state/snapshot-before-migration.json
docker run --rm --user 0:0 --entrypoint node \
  -v "$CHECKPOINT_DIR:/checkpoint:ro" -v "$state_dir:/state" \
  "$RELEASE_IMAGE_ID" scripts/snapshot-baseline-data.js \
  --compare /checkpoint/baseline-before.json /state/snapshot-before-migration.json \
  --output /state/comparison-before-migration.json
docker run --rm -i --entrypoint node "$RELEASE_IMAGE_ID" -e '
  let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
    const r=JSON.parse(s);
    if(r.format!=="bublik-baseline-data-comparison/v1"||r.status!=="identical"||
       r.profile!=="operational"||r.tableCount!==40||r.sequenceCount!==1||
       r.differences.length!==0)process.exit(1);
  });
' < "$state_dir/comparison-before-migration.json"

pb_activity_row="$(docker exec bublik-postgres psql -X -v ON_ERROR_STOP=1 \
  -U bublik -d bublik -A -t -F '|' -c '
    SELECT
      (SELECT count(*) FROM "regbattle_configs" WHERE "masterChannelId" IS NOT NULL),
      (SELECT count(*) FROM "regbattle_squads"),
      (SELECT count(*) FROM "team_sessions" WHERE "endedAt" IS NULL)
  ')"
IFS='|' read -r pb_configured_guilds pb_tracked_squads pb_open_team_sessions <<< "$pb_activity_row"
for value in "$pb_configured_guilds" "$pb_tracked_squads" "$pb_open_team_sessions"; do
  printf '%s\n' "$value" | grep -Eq '^[0-9]+$'
done
test "$pb_configured_guilds" -ge 1
test "$pb_tracked_squads" -eq 0
test "$pb_open_team_sessions" -eq 0
pb_evidence_migration="$state_dir/pb-maintenance-evidence.before-migration.txt"
test ! -e "$pb_evidence_migration"
{
  printf 'checked_at_epoch=%s\n' "$(date +%s)"
  printf 'configured_pb_guilds=%s\n' "$pb_configured_guilds"
  printf 'tracked_pb_squads=%s\n' "$pb_tracked_squads"
  printf 'open_team_pb_sessions=%s\n' "$pb_open_team_sessions"
} > "$pb_evidence_migration"
chmod 0600 "$pb_evidence_migration"
test "$(date +%s)" -lt "$MAINTENANCE_DEADLINE_EPOCH"
test "$(date +%s)" -lt "$MAINTENANCE_WINDOW_DEADLINE_EPOCH"
assert_exact_pre_cutover_targets
compose_release run --rm --no-deps \
  -e MIGRATE_ONLY=1 -e PRISMA_BASELINE_EXISTING=0 bot

test ! -e "$state_dir/postflight-after-migration.json"
docker run --rm --user 0:0 --network bublik-n_default \
  --env-file "$active/.env" -v "$state_dir:/state" \
  --entrypoint node "$RELEASE_IMAGE_ID" \
  scripts/snapshot-baseline-data.js --postflight-operational \
  --output /state/postflight-after-migration.json
docker run --rm -i --entrypoint node "$RELEASE_IMAGE_ID" -e '
  let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
    const r=JSON.parse(s);
    const gate=require("/app/scripts/snapshot-baseline-data.js");
    const requiredChecks=gate.expectedPostflightCheckIds(
      r.schema,
      gate.POSTFLIGHT_PROFILE.OPERATIONAL
    );
    const requiredCounts=[
      "operation_claims_rows",
      "team_poll_votes_rows",
      "economy_black_market_deals_rows"
    ];
    const exactIds=(rows,required)=>{
      const ids=rows.map(row=>row.id);
      return ids.length===required.length&&new Set(ids).size===ids.length&&
        required.every(id=>ids.includes(id));
    };
    if(r.format!=="bublik-hardening-data-postflight/v1"||r.status!=="ok"||
       r.profile!=="operational"||requiredChecks.length!==19||
       r.hardeningMigration!=="20260719010000_hardening"||r.tableCount!==40||
       r.skippedChecks.length!==0||r.checks.length!==19||
       r.checks.some(c=>c.violations!=="0")||
       r.counts.some(c=>!/^(0|[1-9][0-9]*)$/.test(c.count))||
       !exactIds(r.checks,requiredChecks)||
       !exactIds(r.counts,requiredCounts))process.exit(1);
  });
' < "$state_dir/postflight-after-migration.json"

compose_release run --rm --no-deps --entrypoint sh bot -ec \
  './node_modules/.bin/prisma migrate status'
compose_release run --rm --no-deps --entrypoint sh bot -ec \
  './node_modules/.bin/prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code'
test "$(
  docker exec bublik-postgres psql -U bublik -d bublik -Atqc \
    "SELECT count(*) FROM pg_stat_activity WHERE datname='bublik' AND pid <> pg_backend_pid()"
)" = 0

test ! -e "$state_dir/snapshot-after-migration.json"
test ! -e "$state_dir/comparison-after-migration.json"
docker run --rm --user 0:0 --network bublik-n_default \
  --env-file "$active/.env" -v "$state_dir:/state" \
  --entrypoint node "$RELEASE_IMAGE_ID" \
  scripts/snapshot-baseline-data.js --snapshot-operational \
  --output /state/snapshot-after-migration.json
docker run --rm --user 0:0 --entrypoint node \
  -v "$CHECKPOINT_DIR:/checkpoint:ro" -v "$state_dir:/state" \
  "$RELEASE_IMAGE_ID" scripts/snapshot-baseline-data.js \
  --compare /checkpoint/baseline-before.json /state/snapshot-after-migration.json \
  --output /state/comparison-after-migration.json
docker run --rm -i --entrypoint node "$RELEASE_IMAGE_ID" -e '
  let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
    const r=JSON.parse(s);
    if(r.format!=="bublik-baseline-data-comparison/v1"||r.status!=="identical"||
       r.profile!=="operational"||r.tableCount!==40||r.sequenceCount!==1||
       r.differences.length!==0)process.exit(1);
  });
' < "$state_dir/comparison-after-migration.json"
test "$(
  docker exec bublik-postgres psql -U bublik -d bublik -Atqc \
    "SELECT count(*) FROM pg_stat_activity WHERE datname='bublik' AND pid <> pg_backend_pid()"
)" = 0
install -o root -g root -m 0600 /dev/null "$state_dir/05-migration-identical"

assert_exact_pre_cutover_targets
test "$(docker volume inspect -f '{{.Name}}' bublik-n_redis_data)" = bublik-n_redis_data
compose_release up -d --no-deps --force-recreate --pull never redis
redis_healthy=0
for attempt in $(seq 1 60); do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' bublik-redis)"
  if test "$status" = healthy; then redis_healthy=1; break; fi
  test "$(docker inspect -f '{{.State.Running}}' bublik-redis)" = true
  sleep 2
done
test "$redis_healthy" -eq 1
test "$(docker inspect -f '{{.Image}}' bublik-redis)" = "$OLD_REDIS_IMAGE_ID"
test "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' bublik-redis)" = bublik-n_redis_data
test "$(docker exec bublik-redis redis-cli --raw CONFIG GET appendonly | tail -n 1 | tr -d '\r')" = yes
test "$(docker exec bublik-redis redis-cli --raw CONFIG GET maxmemory-policy | tail -n 1 | tr -d '\r')" = noeviction
docker exec bublik-redis redis-cli --raw INFO keyspace |
  tr -d '\r' | sed -E 's/,avg_ttl=[0-9]+//' \
  > "$state_dir/redis-keyspace.after"
test ! -e "$state_dir/redis-snapshot.after.json"
test ! -e "$state_dir/redis-comparison.after.json"
docker run --rm --user 0:0 --network bublik-n_default \
  --env REDIS_URL=redis://redis:6379/0 -v "$state_dir:/state" \
  --entrypoint node "$RELEASE_IMAGE_ID" scripts/snapshot-redis-data.js \
  --snapshot --output /state/redis-snapshot.after.json
docker run --rm --user 0:0 \
  -v "$CHECKPOINT_DIR:/checkpoint:ro" -v "$state_dir:/state" \
  --entrypoint node "$RELEASE_IMAGE_ID" scripts/snapshot-redis-data.js \
  --compare /checkpoint/redis-before.json /state/redis-snapshot.after.json \
  --expiry-tolerance-ms 0 --expiry-grace-ms 0 \
  --output /state/redis-comparison.after.json
docker run --rm -i --entrypoint node "$RELEASE_IMAGE_ID" -e '
  let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
    const r=JSON.parse(s);
    if(r.format!=="bublik-redis-data-comparison/v1"||
       r.status!=="identical"||r.expiryToleranceMs!==0||r.expiryGraceMs!==0||
       r.differences.length!==0||
       r.beforeKeyCount-r.afterKeyCount!==r.expectedExpired.length||
       r.expectedExpired.some(e=>BigInt(e.expireAtMs)>
         BigInt(new Date(e.afterCapturedAt).getTime())))process.exit(1);
  });
' < "$state_dir/redis-comparison.after.json"
docker logs --timestamps --tail 300 bublik-redis > "$state_dir/redis-startup.log" 2>&1

logs_dir="$active/logs"
install -d -m 0750 "$logs_dir"
test "$(readlink -f -- "$logs_dir")" = "$logs_dir"
test ! -L "$logs_dir"
chown -R 1000:1000 "$logs_dir"
docker run --rm --entrypoint sh -v "$logs_dir:/app/logs" "$RELEASE_IMAGE_ID" -ec '
  test "$(id -u)" = 1000
  touch /app/logs/.bublik-write-probe
  rm /app/logs/.bublik-write-probe
'

test "$(docker inspect -f '{{.Id}}' bublik-bot)" = "$BOT_CONTAINER_ID"
test "$(docker inspect -f '{{.Image}}' bublik-bot)" = "$BOT_IMAGE_ID"
test "$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' bublik-bot)" = "$project"
test "$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.service" }}' bublik-bot)" = bot
test "$(docker inspect -f '{{with index .NetworkSettings.Networks "bublik-n_default"}}{{.NetworkID}}{{end}}' bublik-bot)" = "$TARGET_NETWORK_ID"
test "$(docker inspect -f '{{.Id}}' bublik-postgres)" = "$POSTGRES_CONTAINER_ID"
test "$(docker inspect -f '{{.Image}}' bublik-postgres)" = "$POSTGRES_TARGET_IMAGE_ID"
test "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' bublik-postgres)" = bublik-n_pg_data
test "$(docker inspect -f '{{.Image}}' bublik-redis)" = "$REDIS_IMAGE_ID"
test "$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' bublik-redis)" = "$project"
test "$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.service" }}' bublik-redis)" = redis
test "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' bublik-redis)" = bublik-n_redis_data
test "$(docker inspect -f '{{with index .NetworkSettings.Networks "bublik-n_default"}}{{.NetworkID}}{{end}}' bublik-redis)" = "$TARGET_NETWORK_ID"
compose_release up -d --no-deps --force-recreate --no-build --pull never bot
bot_healthy=0
for attempt in $(seq 1 60); do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' bublik-bot)"
  if test "$status" = healthy; then bot_healthy=1; break; fi
  test "$(docker inspect -f '{{.State.Running}}' bublik-bot)" = true
  sleep 3
done
test "$bot_healthy" -eq 1
test "$(docker inspect -f '{{.Image}}' bublik-bot)" = "$RELEASE_IMAGE_ID"
test "$(docker inspect -f '{{.RestartCount}}' bublik-bot)" = 0
test "$(docker inspect -f '{{.Config.User}}' bublik-bot)" = node
docker exec bublik-bot node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const argv = fs.readFileSync("/proc/1/cmdline").toString().split(String.fromCharCode(0)).filter(Boolean);
  if (path.basename(argv[0]) !== "node" || argv[1] !== "dist/index.js") process.exit(1);
'
health_checked_at() {
  docker exec bublik-bot node dist/core/HealthMarker.js --check >/dev/null
  docker exec bublik-bot node -e '
    const fs=require("node:fs");
    const markerPath=process.env.BUBLIK_HEALTH_FILE;
    const maxAge=Number(process.env.BUBLIK_HEALTH_MAX_AGE_MS);
    if(markerPath!=="/tmp/bublik-health.json"||maxAge!==75000)process.exit(1);
    const marker=JSON.parse(fs.readFileSync(markerPath,"utf8"));
    const age=Date.now()-marker.checkedAt;
    if(marker.version!==1||marker.pid!==1||marker.ready!==true||
       marker.checks?.discord!==true||marker.checks?.database!==true||
       marker.checks?.redis!==true||!Number.isSafeInteger(marker.checkedAt)||
       age < -5000||age > maxAge)process.exit(1);
    process.stdout.write(String(marker.checkedAt));
  '
}
heartbeat_before="$(health_checked_at)"
compose_release logs --tail 400 bot > "$state_dir/bot-startup.log"
grep -Eq 'Бот .* запущен! Гильдий:' "$state_dir/bot-startup.log"

bot_started_at="$(docker inspect -f '{{.State.StartedAt}}' bublik-bot)"
for stable_tick in $(seq 1 8); do
  sleep 5
  test "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' bublik-postgres)" = healthy
  test "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' bublik-redis)" = healthy
  test "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' bublik-bot)" = healthy
  test "$(docker inspect -f '{{.RestartCount}}' bublik-redis)" = 0
  test "$(docker inspect -f '{{.RestartCount}}' bublik-bot)" = 0
  test "$(docker inspect -f '{{.State.StartedAt}}' bublik-bot)" = "$bot_started_at"
  test "$(docker inspect -f '{{.Image}}' bublik-redis)" = "$OLD_REDIS_IMAGE_ID"
  test "$(docker inspect -f '{{.Image}}' bublik-bot)" = "$RELEASE_IMAGE_ID"
done
heartbeat_after="$(health_checked_at)"
test "$heartbeat_after" -gt "$heartbeat_before"

chown -R root:root "$state_dir"
find "$state_dir" -type d -exec chmod 0700 {} +
find "$state_dir" -type f -exec chmod 0600 {} +
install -o root -g root -m 0600 /dev/null "$state_dir/06-release-healthy"
printf 'Release healthy. Выполните ручные Discord smoke checks перед закрытием окна.\n'
~~~

Ручной smoke check не должен изменять боевые данные: проверь /ping, ожидаемое число
серверов, чтение существующих PB/BR, экономики и onboarding-конфигурации, обработку
одного безопасного interaction и отсутствие Prisma, Redis, permission и fatal
ошибок. Не создавай тестовый PB-войс и не меняй роли на production ради проверки.

release.env — постоянный несекретный pin точных bot/Redis tags. Он отделён от
production-секретов в .env и защищён собственным checksum. Обычный docker restart
использует уже созданный контейнер; любой будущий compose up/recreate выполняется
только с обоими env-файлами:

~~~bash
set -euo pipefail
umask 077
test "$(id -u)" -eq 0
project=bublik-n
active=/opt/bublik-n
test "$(readlink -f -- "$active")" = "$active"
test "$(stat -c '%U:%G:%a' "$active/.env")" = root:root:600
test "$(stat -c '%U:%G:%a' "$active/release.env")" = root:root:600
test "$(stat -c '%U:%G:%a' "$active/release.env.sha256")" = root:root:600
(cd "$active" && sha256sum -c release.env.sha256)
test "$(wc -l < "$active/release.env")" -eq 3
if grep -Evq '^(BUBLIK_IMAGE=bublik-n-bot:release-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|BUBLIK_REDIS_IMAGE=bublik-checkpoint-redis:[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|PRISMA_BASELINE_EXISTING=0)$' "$active/release.env"; then
  exit 1
fi
bot_image="$(awk -F= '$1=="BUBLIK_IMAGE"{print $2}' "$active/release.env")"
redis_image="$(awk -F= '$1=="BUBLIK_REDIS_IMAGE"{print $2}' "$active/release.env")"
bot_image_id="$(docker image inspect -f '{{.Id}}' "$bot_image")"
redis_image_id="$(docker image inspect -f '{{.Id}}' "$redis_image")"

cd "$active"
docker compose -p "$project" \
  --env-file "$active/.env" --env-file "$active/release.env" \
  config --quiet
docker compose -p "$project" \
  --env-file "$active/.env" --env-file "$active/release.env" \
  up -d --no-build --pull never

for container in bublik-postgres bublik-redis bublik-bot; do
  healthy=0
  for attempt in $(seq 1 60); do
    if test "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")" = healthy; then
      healthy=1
      break
    fi
    test "$(docker inspect -f '{{.State.Running}}' "$container")" = true
    sleep 2
  done
  test "$healthy" -eq 1
done
test "$(docker inspect -f '{{.Image}}' bublik-bot)" = "$bot_image_id"
test "$(docker inspect -f '{{.Image}}' bublik-redis)" = "$redis_image_id"
test "$(docker inspect -f '{{.RestartCount}}' bublik-bot)" = 0
test "$(docker inspect -f '{{.RestartCount}}' bublik-redis)" = 0
~~~

### Возобновление после потери SSH

Сначала переподключись к tmux; если процесс там ещё выполняется, не запускай второй.

~~~bash
set -euo pipefail
test -n "$RELEASE_ID"
printf '%s\n' "$RELEASE_ID" | grep -Eq '^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$'
exec tmux attach -t "bublik-$RELEASE_ID"
~~~

Если tmux-процесс завершился, этот read-only status gate показывает последнюю
доказанную фазу. Он повторно проверяет manifests и ничего не восстанавливает.

~~~bash
set -euo pipefail
umask 077
test "$(id -u)" -eq 0
test -n "$RELEASE_ID"
release_id="$RELEASE_ID"
printf '%s\n' "$release_id" | grep -Eq '^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$'
release_dir="/root/releases/bublik-ts/$release_id"
state_dir="/root/deploy-state/bublik-ts/$release_id"
env_file="$release_dir/deployment.env"

test "$(stat -c '%U:%G:%a' "$release_dir")" = root:root:700
test "$(stat -c '%U:%G:%a' "$env_file")" = root:root:600
test "$(stat -c '%U:%G:%a' "$release_dir/SHA256SUMS.release")" = root:root:600
(cd "$release_dir" && sha256sum -c SHA256SUMS.release)
if grep -Evq '^(RELEASE_ID=[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|RELEASE_IMAGE=bublik-n-bot:release-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|RELEASE_IMAGE_ID=sha256:[0-9a-f]{64}|CHECKPOINT_DIR=/root/backups/bublik-ts/cutover-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|SOURCE_COMMIT=[0-9a-f]{40}|SOURCE_TREE=[0-9a-f]{40}|BASELINE_SHA256=[0-9a-f]{64})$' "$env_file"; then
  exit 1
fi
test "$(wc -l < "$env_file")" -eq 7
for key in RELEASE_ID RELEASE_IMAGE RELEASE_IMAGE_ID CHECKPOINT_DIR SOURCE_COMMIT SOURCE_TREE BASELINE_SHA256; do
  test "$(grep -c "^$key=" "$env_file")" -eq 1
done
. "$env_file"
test "$RELEASE_ID" = "$release_id"
test "$(readlink -f -- "$release_dir")" = "$release_dir"

find "$state_dir" -maxdepth 1 -type f -printf '%f\n' 2>/dev/null | LC_ALL=C sort
docker ps -a --filter name=bublik-bot --filter name=bublik-postgres --filter name=bublik-redis \
  --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
if test -f "$CHECKPOINT_DIR/SHA256SUMS.final"; then
  test "$(readlink -f -- "$CHECKPOINT_DIR")" = "$CHECKPOINT_DIR"
  test "$(stat -c '%U:%G:%a' "$CHECKPOINT_DIR")" = root:root:700
  test "$(stat -c '%U:%G:%a' "$CHECKPOINT_DIR/SHA256SUMS.final")" = root:root:600
  (cd "$CHECKPOINT_DIR" && sha256sum -c SHA256SUMS.final)
elif test -f "$CHECKPOINT_DIR/SHA256SUMS.capture"; then
  test "$(stat -c '%U:%G:%a' "$CHECKPOINT_DIR/SHA256SUMS.capture")" = root:root:600
  (cd "$CHECKPOINT_DIR" && sha256sum -c SHA256SUMS.capture)
fi
if test -f "$state_dir/comparison-after-migration.json"; then
  docker run --rm -i --entrypoint node "$RELEASE_IMAGE_ID" -e '
    let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
      const r=JSON.parse(s);
      console.log("comparison="+r.status+" tables="+r.tableCount+" differences="+r.differences.length);
      if(r.status!=="identical"||r.tableCount!==40||r.sequenceCount!==1||
         r.differences.length!==0)process.exit(1);
    });
  ' < "$state_dir/comparison-after-migration.json"
fi
~~~

Правила продолжения:

- Нет 02-checkpoint-captured — миграция не начиналась; не удаляй частичный каталог,
  сначала расследуй его и при необходимости запусти сохранённый старый Redis/bot.
- Есть 02, но нет 03/04 — закончи rehearsal и off-host gate; миграцию не запускай.
- Есть 04, но нет 05 — сначала проверь наличие active .locales.pre-RELEASE_ID и
  эксклюзивных JSON-отчётов. Целый cutover gate повторяют только если swap ещё не
  начинался; после частичного swap/migrate продолжают с точно доказанной команды
  либо выполняют Rollback A/B. Prisma deploy идемпотентен, остальной блок — нет.
- Есть 05, но нет 06 — не запускай старый image поверх migrated DB; закончи проверки
  Redis/bot либо выполни полный rollback ниже.
- Один marker без валидного checksum-манифеста никогда не является разрешением.

### Rollback A: сначала сохранить failed state

Rollback состоит из двух раздельных gates. Первый не удаляет БД и тома: он
останавливает записи, сохраняет логи/config, логический (если сервер доступен) и raw PostgreSQL state,
полный Redis /data и проверяет их. Если этот gate не завершён checksum-манифестом,
деструктивное восстановление запрещено.

~~~bash
set -euo pipefail
umask 077
test "$(id -u)" -eq 0
test -n "$TMUX"
test -n "$RELEASE_ID"
release_id="$RELEASE_ID"
printf '%s\n' "$release_id" | grep -Eq '^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$'

project=bublik-n
active=/opt/bublik-n
release_dir="/root/releases/bublik-ts/$release_id"
state_dir="/root/deploy-state/bublik-ts/$release_id"
env_file="$release_dir/deployment.env"
test "$(stat -c '%U:%G:%a' "$release_dir")" = root:root:700
test "$(stat -c '%U:%G:%a' "$env_file")" = root:root:600
test "$(stat -c '%U:%G:%a' "$release_dir/SHA256SUMS.release")" = root:root:600
(cd "$release_dir" && sha256sum -c SHA256SUMS.release)
if grep -Evq '^(RELEASE_ID=[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|RELEASE_IMAGE=bublik-n-bot:release-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|RELEASE_IMAGE_ID=sha256:[0-9a-f]{64}|CHECKPOINT_DIR=/root/backups/bublik-ts/cutover-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|SOURCE_COMMIT=[0-9a-f]{40}|SOURCE_TREE=[0-9a-f]{40}|BASELINE_SHA256=[0-9a-f]{64})$' "$env_file"; then
  exit 1
fi
test "$(wc -l < "$env_file")" -eq 7
for key in RELEASE_ID RELEASE_IMAGE RELEASE_IMAGE_ID CHECKPOINT_DIR SOURCE_COMMIT SOURCE_TREE BASELINE_SHA256; do
  test "$(grep -c "^$key=" "$env_file")" -eq 1
done
. "$env_file"
test "$RELEASE_ID" = "$release_id"
test "$(readlink -f -- "$release_dir")" = "$release_dir"
test -f "$state_dir/03-checkpoint-sealed"
test "$(readlink -f -- "$CHECKPOINT_DIR")" = "$CHECKPOINT_DIR"
test "$(stat -c '%U:%G:%a' "$CHECKPOINT_DIR")" = root:root:700
test "$(stat -c '%U:%G:%a' "$CHECKPOINT_DIR/SHA256SUMS.final")" = root:root:600
(cd "$CHECKPOINT_DIR" && sha256sum -c SHA256SUMS.final)
checkpoint_env="$CHECKPOINT_DIR/checkpoint.env"
test "$(stat -c '%U:%G:%a' "$checkpoint_env")" = root:root:600
test "$(grep -c '^OLD_REDIS_IMAGE_ID=' "$checkpoint_env")" -eq 1
test "$(grep -c '^POSTGRES_IMAGE_ID=' "$checkpoint_env")" -eq 1
rollback_old_redis_image_id="$(awk -F= '$1=="OLD_REDIS_IMAGE_ID"{print $2}' "$checkpoint_env")"
rollback_postgres_image_id="$(awk -F= '$1=="POSTGRES_IMAGE_ID"{print $2}' "$checkpoint_env")"
for image_id in "$rollback_old_redis_image_id" "$rollback_postgres_image_id"; do
  printf '%s\n' "$image_id" | grep -Eq '^sha256:[0-9a-f]{64}$'
done
docker load --input "$CHECKPOINT_DIR/old-redis-image.tar" >/dev/null
docker load --input "$CHECKPOINT_DIR/postgres-image.tar" >/dev/null
test "$(docker image inspect -f '{{.Id}}' "$rollback_old_redis_image_id")" = "$rollback_old_redis_image_id"
test "$(docker image inspect -f '{{.Id}}' "$rollback_postgres_image_id")" = "$rollback_postgres_image_id"

failed="/root/backups/bublik-ts/failed-$release_id-$(date -u +%Y%m%dT%H%M%SZ)"
test ! -e "$failed"
install -d -o root -g root -m 0700 "$failed" "$failed/active" "$failed/redis-data"

container_exists() { docker inspect "$1" >/dev/null 2>&1; }
volume_exists() { docker volume inspect "$1" >/dev/null 2>&1; }

docker logs --timestamps bublik-bot > "$failed/bot.failed.log" 2>&1 || true
docker logs --timestamps bublik-postgres > "$failed/postgres.failed.log" 2>&1 || true
docker logs --timestamps bublik-redis > "$failed/redis.failed.log" 2>&1 || true
present_containers=()
present_image_ids=()
for target in bublik-bot bublik-postgres bublik-redis; do
  if container_exists "$target"; then
    present_containers+=("$target")
    image_id="$(docker inspect -f '{{.Image}}' "$target")"
    printf '%s\n' "$image_id" | grep -Eq '^sha256:[0-9a-f]{64}$'
    present_image_ids+=("$image_id")
    printf '%s=present\n' "$target"
  else
    printf '%s=absent\n' "$target"
  fi
done > "$failed/container-presence.status"
if test "${#present_containers[@]}" -gt 0; then
  docker inspect "${present_containers[@]}" > "$failed/containers.failed.json"
  if docker image inspect "${present_image_ids[@]}" > "$failed/images.failed.json.partial" 2>&1; then
    mv "$failed/images.failed.json.partial" "$failed/images.failed.json"
  else
    mv "$failed/images.failed.json.partial" "$failed/images.failed.invalid.txt"
  fi
else
  printf '[]\n' > "$failed/containers.failed.json"
  printf '[]\n' > "$failed/images.failed.json"
fi

present_volumes=()
for target in bublik-n_pg_data bublik-n_redis_data; do
  if volume_exists "$target"; then
    present_volumes+=("$target")
    printf '%s=present\n' "$target"
  else
    printf '%s=absent\n' "$target"
  fi
done > "$failed/volume-presence.status"
if test "${#present_volumes[@]}" -gt 0; then
  docker volume inspect "${present_volumes[@]}" > "$failed/volumes.failed.json"
else
  printf '[]\n' > "$failed/volumes.failed.json"
fi
if docker network inspect bublik-n_default > "$failed/network.failed.json.partial" 2>&1; then
  mv "$failed/network.failed.json.partial" "$failed/network.failed.json"
  printf '%s\n' present > "$failed/network-presence.status"
else
  mv "$failed/network.failed.json.partial" "$failed/network.failed.invalid.txt"
  printf '%s\n' absent > "$failed/network-presence.status"
fi

compose_safe=0
if test -f "$active/docker-compose.yml" && test ! -L "$active/docker-compose.yml" &&
   test "$(readlink -f -- "$active/docker-compose.yml")" = "$active/docker-compose.yml"; then
  cp --no-dereference "$active/docker-compose.yml" "$failed/active/docker-compose.yml"
  printf '%s\n' captured > "$failed/active/docker-compose.status"
  compose_safe=1
else
  printf '%s\n' absent-or-unsafe > "$failed/active/docker-compose.status"
fi
active_env_safe=0
if test -f "$active/.env" && test ! -L "$active/.env" &&
   test "$(readlink -f -- "$active/.env")" = "$active/.env"; then
  cp --no-dereference "$active/.env" "$failed/active/.env"
  printf '%s\n' captured > "$failed/active/env.status"
  active_env_safe=1
else
  printf '%s\n' absent-or-unsafe > "$failed/active/env.status"
fi

release_env_status=absent
release_env_safe=0
release_env_sum_safe=0
release_env_unsafe=0
if test -f "$active/release.env" && test ! -L "$active/release.env" &&
   test "$(readlink -f -- "$active/release.env")" = "$active/release.env"; then
  cp --no-dereference "$active/release.env" "$failed/active/release.env"
  release_env_safe=1
elif test -e "$active/release.env" || test -L "$active/release.env"; then
  release_env_unsafe=1
fi
if test -f "$active/release.env.sha256" && test ! -L "$active/release.env.sha256" &&
   test "$(readlink -f -- "$active/release.env.sha256")" = "$active/release.env.sha256"; then
  cp --no-dereference "$active/release.env.sha256" "$failed/active/release.env.sha256"
  release_env_sum_safe=1
elif test -e "$active/release.env.sha256" || test -L "$active/release.env.sha256"; then
  release_env_unsafe=1
fi
if test "$release_env_unsafe" -eq 1; then
  release_env_status=partial-or-unsafe
elif test "$release_env_safe" -eq 1 && test "$release_env_sum_safe" -eq 1; then
  if (cd "$active" && sha256sum -c release.env.sha256 >/dev/null 2>&1); then
    release_env_status=verified
  else
    release_env_status=partial-unverified
  fi
elif test $((release_env_safe + release_env_sum_safe)) -eq 1; then
  release_env_status=partial-safe
fi
printf '%s\n' "$release_env_status" > "$failed/release-env.status"

if test -d "$active/locales" && test ! -L "$active/locales" &&
   test "$(readlink -f -- "$active/locales")" = "$active/locales" &&
   test -z "$(find "$active/locales" -type l -print -quit)"; then
  tar --numeric-owner -C "$active" -cf "$failed/active/locales.tar" locales
else
  printf '%s\n' 'active locales path was absent or unsafe at failed-state capture' \
    > "$failed/active/locales.missing.txt"
fi
if test -d "$active/logs" && test ! -L "$active/logs" &&
   test "$(readlink -f -- "$active/logs")" = "$active/logs"; then
  tar --numeric-owner -C "$active" -cf "$failed/active/logs.tar" logs
else
  printf '%s\n' 'active logs path was absent or unsafe at failed-state capture' \
    > "$failed/active/logs.missing.txt"
fi
if test "$compose_safe" -eq 1 && test "$active_env_safe" -eq 1; then
  if test "$release_env_status" = verified && docker compose -p "$project" \
       --project-directory "$active" -f "$active/docker-compose.yml" \
       --env-file "$active/.env" --env-file "$active/release.env" \
       config > "$failed/effective-failed-compose.yaml.partial"; then
    mv "$failed/effective-failed-compose.yaml.partial" "$failed/effective-failed-compose.yaml"
  elif BUBLIK_IMAGE="$RELEASE_IMAGE" PRISMA_BASELINE_EXISTING=0 \
       docker compose -p "$project" --project-directory "$active" \
       -f "$active/docker-compose.yml" --env-file "$active/.env" \
       config > "$failed/effective-failed-compose.yaml.partial"; then
    mv "$failed/effective-failed-compose.yaml.partial" "$failed/effective-failed-compose.yaml"
  else
    mv "$failed/effective-failed-compose.yaml.partial" "$failed/effective-failed-compose.invalid"
  fi
else
  printf '%s\n' 'active Compose or .env absent/unsafe; effective config unavailable' \
    > "$failed/effective-failed-compose.unavailable.txt"
fi

container_is_owned_service() {
  test "$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$1" 2>/dev/null)" = "$project" &&
    test "$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.service" }}' "$1" 2>/dev/null)" = "$2"
}

bot_stop_status=absent
if container_exists bublik-bot; then
  if container_is_owned_service bublik-bot bot; then
    if test "$(docker inspect -f '{{.State.Running}}' bublik-bot)" = true; then
      if docker stop --time 30 bublik-bot >/dev/null 2>&1; then
        bot_stop_status=stopped
      else
        bot_stop_status=stop-failed
      fi
    else
      bot_stop_status=already-stopped
    fi
  else
    bot_stop_status=identity-mismatch-not-stopped
  fi
fi
printf '%s\n' "$bot_stop_status" > "$failed/bot-stop.status"

postgres_logical_status=absent
if container_exists bublik-postgres; then
  postgres_logical_status=unavailable
  if container_is_owned_service bublik-postgres postgres &&
     test "$(docker inspect -f '{{.State.Running}}' bublik-postgres)" = true &&
     docker exec bublik-postgres pg_isready -U bublik -d bublik >/dev/null 2>&1; then
    if docker exec bublik-postgres sh -ec \
         'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
         > "$failed/postgres.failed.dump.partial"; then
      mv "$failed/postgres.failed.dump.partial" "$failed/postgres.failed.dump"
      if docker exec bublik-postgres sh -ec \
           'pg_dumpall -U "$POSTGRES_USER" --globals-only' \
           > "$failed/postgres-globals.failed.sql.partial" &&
         docker exec -i bublik-postgres pg_restore --list \
           < "$failed/postgres.failed.dump" \
           > "$failed/postgres.failed.restore-list.txt.partial"; then
        mv "$failed/postgres-globals.failed.sql.partial" "$failed/postgres-globals.failed.sql"
        mv "$failed/postgres.failed.restore-list.txt.partial" "$failed/postgres.failed.restore-list.txt"
        if test -s "$failed/postgres.failed.restore-list.txt"; then
          postgres_logical_status=verified
        else
          postgres_logical_status=captured-unverified
        fi
      else
        postgres_logical_status=partial-unverified
      fi
    else
      postgres_logical_status=failed
    fi
  fi
fi
printf '%s\n' "$postgres_logical_status" > "$failed/postgres-logical.status"

redis_bgsave_status=absent
if container_exists bublik-redis; then
  redis_bgsave_status=unavailable
  if container_is_owned_service bublik-redis redis &&
     test "$(docker inspect -f '{{.State.Running}}' bublik-redis)" = true &&
     docker exec bublik-redis redis-cli PING >/dev/null 2>&1; then
    if docker exec bublik-redis redis-cli BGSAVE >/dev/null 2>&1; then
      bgsave_ok=0
      for attempt in $(seq 1 120); do
        if docker exec bublik-redis redis-cli --raw INFO persistence |
           tr -d '\r' | grep -q '^rdb_bgsave_in_progress:0$'; then
          bgsave_ok=1
          break
        fi
        sleep 1
      done
      if test "$bgsave_ok" -eq 1 &&
         docker exec bublik-redis redis-cli --raw INFO persistence |
           tr -d '\r' | grep -q '^rdb_last_bgsave_status:ok$'; then
        redis_bgsave_status=verified
      fi
    fi
  fi
fi
printf '%s\n' "$redis_bgsave_status" > "$failed/redis-bgsave.status"
redis_stop_status=absent
redis_capture_image_id="$rollback_old_redis_image_id"
if container_exists bublik-redis; then
  if container_is_owned_service bublik-redis redis; then
    redis_capture_image_id="$(docker inspect -f '{{.Image}}' bublik-redis)"
    if test "$(docker inspect -f '{{.State.Running}}' bublik-redis)" = true; then
      if docker stop --time 30 bublik-redis >/dev/null 2>&1; then
        redis_stop_status=stopped
      else
        redis_stop_status=stop-failed
      fi
    else
      redis_stop_status=already-stopped
    fi
  else
    redis_stop_status=identity-mismatch-not-stopped
  fi
fi
printf '%s\n' "$redis_stop_status" > "$failed/redis-stop.status"

redis_volume_status=absent
if volume_exists bublik-n_redis_data; then
  if test "$(docker volume inspect -f '{{ index .Labels "com.docker.compose.project" }}' bublik-n_redis_data)" = "$project" &&
     test "$(docker volume inspect -f '{{ index .Labels "com.docker.compose.volume" }}' bublik-n_redis_data)" = redis_data; then
    if test -z "$(docker ps -q --filter volume=bublik-n_redis_data)"; then
      if docker run --rm --user 0:0 \
           --mount type=volume,src=bublik-n_redis_data,dst=/data,readonly \
           --mount type=bind,src="$failed/redis-data",dst=/backup \
           --entrypoint sh "$redis_capture_image_id" -ec 'cp -a /data/. /backup/'; then
        redis_volume_status=captured
      else
        redis_volume_status=capture-failed
      fi
    else
      redis_volume_status=running-consumer-not-copied
    fi
  else
    redis_volume_status=identity-mismatch-not-copied
  fi
fi
printf '%s\n' "$redis_volume_status" > "$failed/redis-volume.status"

(
  cd "$failed/redis-data"
  find . -xdev -type f -printf '%s %P\0' | LC_ALL=C sort -z \
    > "$failed/redis-data.before-validation.sizes0"
  find . -xdev -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum \
    > "$failed/redis-data.before-validation.sha256"
)

redis_rdb_status=absent
if test "$redis_volume_status" = captured; then
  if test -e "$failed/redis-data/dump.rdb" ||
     test -L "$failed/redis-data/dump.rdb"; then
    redis_rdb_status=unavailable
  fi
  if test -s "$failed/redis-data/dump.rdb" &&
     test -f "$failed/redis-data/dump.rdb" &&
     test ! -L "$failed/redis-data/dump.rdb"; then
    if docker run --rm --user 0:0 --entrypoint redis-check-rdb \
         -v "$failed/redis-data/dump.rdb:/backup/dump.rdb:ro" \
         "$redis_capture_image_id" /backup/dump.rdb \
         > "$failed/redis.failed.rdb-check.txt" 2>&1; then
      redis_rdb_status=verified
    else
      redis_rdb_status=failed-but-preserved
    fi
  fi
elif test "$redis_volume_status" != absent; then
  redis_rdb_status=unavailable
fi
printf '%s\n' "$redis_rdb_status" > "$failed/redis-rdb.status"

redis_aof_status=absent
if test "$redis_volume_status" = captured; then
  redis_aof_manifest="$failed/redis-data/appendonlydir/appendonly.aof.manifest"
  redis_aof_dir="$failed/redis-data/appendonlydir"
  if test -e "$redis_aof_manifest" || test -L "$redis_aof_manifest"; then
    redis_aof_status=unavailable
  fi
  if test -f "$redis_aof_manifest" && test ! -L "$redis_aof_manifest" &&
     test -d "$redis_aof_dir" && test ! -L "$redis_aof_dir" &&
     test -z "$(find "$redis_aof_dir" -xdev -type l -print -quit)"; then
    if docker run --rm --user 0:0 --entrypoint redis-check-aof \
         -v "$failed/redis-data:/backup" "$redis_capture_image_id" \
         /backup/appendonlydir/appendonly.aof.manifest \
         > "$failed/redis.failed.aof-check.txt" 2>&1; then
      redis_aof_status=verified
    else
      redis_aof_status=failed-but-preserved
    fi
  elif test -e "$redis_aof_dir" || test -L "$redis_aof_dir" ||
       test -e "$failed/redis-data/appendonly.aof" ||
       test -L "$failed/redis-data/appendonly.aof"; then
    if test -d "$redis_aof_dir" && test ! -L "$redis_aof_dir" &&
       test -z "$(find "$redis_aof_dir" -mindepth 1 -print -quit)" &&
       test ! -e "$failed/redis-data/appendonly.aof" &&
       test ! -L "$failed/redis-data/appendonly.aof"; then
      redis_aof_status=absent
    else
      redis_aof_status=unavailable
    fi
  fi
elif test "$redis_volume_status" != absent; then
  redis_aof_status=unavailable
fi
printf '%s\n' "$redis_aof_status" > "$failed/redis-aof.status"
(
  cd "$failed/redis-data"
  find . -xdev -type f -printf '%s %P\0' | LC_ALL=C sort -z \
    > "$failed/redis-data.after-validation.sizes0"
  find . -xdev -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum \
    > "$failed/redis-data.after-validation.sha256"
)
cmp "$failed/redis-data.before-validation.sizes0" \
  "$failed/redis-data.after-validation.sizes0"
cmp "$failed/redis-data.before-validation.sha256" \
  "$failed/redis-data.after-validation.sha256"

postgres_stop_status=absent
postgres_capture_image_id="$rollback_postgres_image_id"
if container_exists bublik-postgres; then
  if container_is_owned_service bublik-postgres postgres; then
    postgres_capture_image_id="$(docker inspect -f '{{.Image}}' bublik-postgres)"
    if test "$(docker inspect -f '{{.State.Running}}' bublik-postgres)" = true; then
      if docker stop --time 60 bublik-postgres >/dev/null 2>&1; then
        postgres_stop_status=stopped
      else
        postgres_stop_status=stop-failed
      fi
    else
      postgres_stop_status=already-stopped
    fi
  else
    postgres_stop_status=identity-mismatch-not-stopped
  fi
fi
printf '%s\n' "$postgres_stop_status" > "$failed/postgres-stop.status"

postgres_raw_status=absent
if volume_exists bublik-n_pg_data; then
  if test "$(docker volume inspect -f '{{ index .Labels "com.docker.compose.project" }}' bublik-n_pg_data)" = "$project" &&
     test "$(docker volume inspect -f '{{ index .Labels "com.docker.compose.volume" }}' bublik-n_pg_data)" = pg_data; then
    if test -z "$(docker ps -q --filter volume=bublik-n_pg_data)"; then
      if docker run --rm --user 0:0 \
           --mount type=volume,src=bublik-n_pg_data,dst=/pg,readonly \
           --entrypoint tar "$postgres_capture_image_id" \
           --numeric-owner -C /pg -cf - . \
           > "$failed/postgres-data.failed.tar.partial"; then
        mv "$failed/postgres-data.failed.tar.partial" "$failed/postgres-data.failed.tar"
        if tar -tf "$failed/postgres-data.failed.tar" > "$failed/postgres-data.failed.list" &&
           grep -Eq '^\./PG_VERSION$' "$failed/postgres-data.failed.list" &&
           test "$(tar -xOf "$failed/postgres-data.failed.tar" ./PG_VERSION | tr -d '\r\n')" = 16; then
          postgres_raw_status=verified
        else
          postgres_raw_status=captured-unverified
        fi
      else
        postgres_raw_status=capture-failed
      fi
    else
      postgres_raw_status=running-consumer-not-copied
    fi
  else
    postgres_raw_status=identity-mismatch-not-copied
  fi
fi
printf '%s\n' "$postgres_raw_status" > "$failed/postgres-raw.status"

cat > "$failed/capture-summary.status" <<STATUS
bot_stop=$bot_stop_status
postgres_stop=$postgres_stop_status
redis_stop=$redis_stop_status
postgres_logical=$postgres_logical_status
postgres_raw=$postgres_raw_status
redis_bgsave=$redis_bgsave_status
redis_volume=$redis_volume_status
redis_rdb=$redis_rdb_status
redis_aof=$redis_aof_status
release_env=$release_env_status
STATUS

chown -R root:root "$failed"
find "$failed" -type d -exec chmod 0700 {} +
find "$failed" -type f -exec chmod 0600 {} +

validate_failed_capture_summary() {
  local root="$1"
  local summary="$root/capture-summary.status"
  local container_presence="$root/container-presence.status"
  local volume_presence="$root/volume-presence.status"
  local spec key status_file summary_value status_value
  local bot_presence postgres_presence redis_presence
  local pg_volume_presence redis_volume_presence
  local bot_stop postgres_stop redis_stop postgres_logical postgres_raw
  local redis_bgsave redis_volume redis_rdb redis_aof release_env
  local release_env_file_safe release_env_sum_file_safe

  test -d "$root/redis-data" && test ! -L "$root/redis-data" || return 1
  for status_file in \
    "$summary" "$container_presence" "$volume_presence" \
    "$root/bot-stop.status" "$root/postgres-stop.status" \
    "$root/redis-stop.status" "$root/postgres-logical.status" \
    "$root/postgres-raw.status" "$root/redis-bgsave.status" \
    "$root/redis-volume.status" "$root/redis-rdb.status" \
    "$root/redis-aof.status" "$root/release-env.status" \
    "$root/redis-data.before-validation.sizes0" \
    "$root/redis-data.before-validation.sha256" \
    "$root/redis-data.after-validation.sizes0" \
    "$root/redis-data.after-validation.sha256"; do
    test -f "$status_file" && test ! -L "$status_file" || return 1
  done
  test -z "$(find "$root/redis-data" -xdev -type l -print -quit)" || return 1

  test "$(wc -l < "$summary")" -eq 10 || return 1
  if grep -Evq '^(bot_stop=(absent|stopped|already-stopped|stop-failed|identity-mismatch-not-stopped)|postgres_stop=(absent|stopped|already-stopped|stop-failed|identity-mismatch-not-stopped)|redis_stop=(absent|stopped|already-stopped|stop-failed|identity-mismatch-not-stopped)|postgres_logical=(absent|verified|unavailable|captured-unverified|partial-unverified|failed)|postgres_raw=(absent|verified|captured-unverified|capture-failed|running-consumer-not-copied|identity-mismatch-not-copied)|redis_bgsave=(absent|verified|unavailable)|redis_volume=(absent|captured|capture-failed|running-consumer-not-copied|identity-mismatch-not-copied)|redis_rdb=(absent|verified|unavailable|failed-but-preserved)|redis_aof=(absent|verified|unavailable|failed-but-preserved)|release_env=(absent|verified|partial-safe|partial-or-unsafe|partial-unverified))$' "$summary"; then
    return 1
  fi
  for key in bot_stop postgres_stop redis_stop postgres_logical postgres_raw \
    redis_bgsave redis_volume redis_rdb redis_aof release_env; do
    test "$(grep -c "^$key=" "$summary")" -eq 1 || return 1
  done

  test "$(wc -l < "$container_presence")" -eq 3 || return 1
  if grep -Evq '^(bublik-bot|bublik-postgres|bublik-redis)=(present|absent)$' \
       "$container_presence"; then
    return 1
  fi
  for key in bublik-bot bublik-postgres bublik-redis; do
    test "$(grep -c "^$key=" "$container_presence")" -eq 1 || return 1
  done
  test "$(wc -l < "$volume_presence")" -eq 2 || return 1
  if grep -Evq '^(bublik-n_pg_data|bublik-n_redis_data)=(present|absent)$' \
       "$volume_presence"; then
    return 1
  fi
  for key in bublik-n_pg_data bublik-n_redis_data; do
    test "$(grep -c "^$key=" "$volume_presence")" -eq 1 || return 1
  done

  for spec in \
    bot_stop:bot-stop.status postgres_stop:postgres-stop.status \
    redis_stop:redis-stop.status postgres_logical:postgres-logical.status \
    postgres_raw:postgres-raw.status redis_bgsave:redis-bgsave.status \
    redis_volume:redis-volume.status redis_rdb:redis-rdb.status \
    redis_aof:redis-aof.status release_env:release-env.status; do
    key="${spec%%:*}"
    status_file="$root/${spec#*:}"
    test "$(wc -l < "$status_file")" -eq 1 || return 1
    summary_value="$(awk -F= -v wanted="$key" '$1==wanted {print $2}' "$summary")"
    status_value="$(cat "$status_file")"
    test "$status_value" = "$summary_value" || return 1
  done

  bot_presence="$(awk -F= '$1=="bublik-bot" {print $2}' "$container_presence")"
  postgres_presence="$(awk -F= '$1=="bublik-postgres" {print $2}' "$container_presence")"
  redis_presence="$(awk -F= '$1=="bublik-redis" {print $2}' "$container_presence")"
  pg_volume_presence="$(awk -F= '$1=="bublik-n_pg_data" {print $2}' "$volume_presence")"
  redis_volume_presence="$(awk -F= '$1=="bublik-n_redis_data" {print $2}' "$volume_presence")"
  bot_stop="$(awk -F= '$1=="bot_stop" {print $2}' "$summary")"
  postgres_stop="$(awk -F= '$1=="postgres_stop" {print $2}' "$summary")"
  redis_stop="$(awk -F= '$1=="redis_stop" {print $2}' "$summary")"
  postgres_logical="$(awk -F= '$1=="postgres_logical" {print $2}' "$summary")"
  postgres_raw="$(awk -F= '$1=="postgres_raw" {print $2}' "$summary")"
  redis_bgsave="$(awk -F= '$1=="redis_bgsave" {print $2}' "$summary")"
  redis_volume="$(awk -F= '$1=="redis_volume" {print $2}' "$summary")"
  redis_rdb="$(awk -F= '$1=="redis_rdb" {print $2}' "$summary")"
  redis_aof="$(awk -F= '$1=="redis_aof" {print $2}' "$summary")"
  release_env="$(awk -F= '$1=="release_env" {print $2}' "$summary")"

  case "$bot_presence:$bot_stop" in
    present:stopped|present:already-stopped|absent:absent) ;;
    *) return 1 ;;
  esac
  case "$postgres_presence:$postgres_stop:$postgres_logical" in
    present:stopped:verified|present:already-stopped:verified|absent:absent:absent) ;;
    present:already-stopped:unavailable)
      test "$pg_volume_presence:$postgres_raw" = present:verified || return 1
      ;;
    *) return 1 ;;
  esac
  case "$pg_volume_presence:$postgres_raw" in
    present:verified|absent:absent) ;;
    *) return 1 ;;
  esac
  case "$redis_presence:$redis_stop:$redis_bgsave" in
    present:stopped:verified|present:already-stopped:verified|absent:absent:absent) ;;
    present:already-stopped:unavailable)
      test "$redis_volume_presence:$redis_volume" = present:captured || return 1
      ;;
    *) return 1 ;;
  esac
  if test "$redis_presence" = present; then
    test "$redis_volume_presence:$redis_volume" = present:captured || return 1
  fi
  case "$redis_volume_presence:$redis_volume" in
    present:captured|absent:absent) ;;
    *) return 1 ;;
  esac

  if test "$redis_volume_presence" = absent; then
    test "$redis_rdb" = absent && test "$redis_aof" = absent || return 1
    test -z "$(find "$root/redis-data" -mindepth 1 -print -quit)" || return 1
  else
    case "$redis_rdb" in
      verified)
        test -s "$root/redis-data/dump.rdb" &&
          test -f "$root/redis-data/dump.rdb" &&
          test ! -L "$root/redis-data/dump.rdb" || return 1
        ;;
      absent)
        test ! -e "$root/redis-data/dump.rdb" &&
          test ! -L "$root/redis-data/dump.rdb" || return 1
        ;;
      *) return 1 ;;
    esac
    case "$redis_aof" in
      verified)
        test -f "$root/redis-data/appendonlydir/appendonly.aof.manifest" &&
          test ! -L "$root/redis-data/appendonlydir/appendonly.aof.manifest" &&
          test -d "$root/redis-data/appendonlydir" &&
          test ! -L "$root/redis-data/appendonlydir" || return 1
        ;;
      absent)
        test ! -e "$root/redis-data/appendonlydir/appendonly.aof.manifest" &&
          test ! -L "$root/redis-data/appendonlydir/appendonly.aof.manifest" &&
          test ! -e "$root/redis-data/appendonly.aof" &&
          test ! -L "$root/redis-data/appendonly.aof" || return 1
        if test -e "$root/redis-data/appendonlydir" ||
           test -L "$root/redis-data/appendonlydir"; then
          test -d "$root/redis-data/appendonlydir" &&
            test ! -L "$root/redis-data/appendonlydir" &&
            test -z "$(find "$root/redis-data/appendonlydir" -mindepth 1 -print -quit)" ||
            return 1
        fi
        ;;
      *) return 1 ;;
    esac
  fi

  case "$release_env" in
    verified)
      test -f "$root/active/release.env" && test ! -L "$root/active/release.env" &&
        test -f "$root/active/release.env.sha256" &&
        test ! -L "$root/active/release.env.sha256" || return 1
      (cd "$root/active" && sha256sum -c release.env.sha256 >/dev/null) || return 1
      ;;
    absent)
      test ! -e "$root/active/release.env" && test ! -L "$root/active/release.env" &&
        test ! -e "$root/active/release.env.sha256" &&
        test ! -L "$root/active/release.env.sha256" || return 1
      ;;
    partial-safe)
      release_env_file_safe=0
      release_env_sum_file_safe=0
      if test -f "$root/active/release.env" &&
         test ! -L "$root/active/release.env"; then
        release_env_file_safe=1
      else
        test ! -e "$root/active/release.env" &&
          test ! -L "$root/active/release.env" || return 1
      fi
      if test -f "$root/active/release.env.sha256" &&
         test ! -L "$root/active/release.env.sha256"; then
        release_env_sum_file_safe=1
      else
        test ! -e "$root/active/release.env.sha256" &&
          test ! -L "$root/active/release.env.sha256" || return 1
      fi
      test $((release_env_file_safe + release_env_sum_file_safe)) -eq 1 || return 1
      ;;
    *) return 1 ;;
  esac

  cmp "$root/redis-data.before-validation.sizes0" \
    "$root/redis-data.after-validation.sizes0" >/dev/null || return 1
  cmp "$root/redis-data.before-validation.sha256" \
    "$root/redis-data.after-validation.sha256" >/dev/null || return 1
  cmp "$root/redis-data.after-validation.sizes0" <(
    cd "$root/redis-data"
    find . -xdev -type f -printf '%s %P\0' | LC_ALL=C sort -z
  ) >/dev/null || return 1
  cmp "$root/redis-data.after-validation.sha256" <(
    cd "$root/redis-data"
    find . -xdev -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum
  ) >/dev/null || return 1
}

validate_failed_capture_summary "$failed"
(
  cd "$failed"
  sha256sum \
    capture-summary.status container-presence.status volume-presence.status \
    bot-stop.status postgres-stop.status redis-stop.status \
    postgres-logical.status postgres-raw.status redis-bgsave.status \
    redis-volume.status redis-rdb.status redis-aof.status release-env.status \
    redis-data.before-validation.sizes0 \
    redis-data.before-validation.sha256 \
    redis-data.after-validation.sizes0 \
    redis-data.after-validation.sha256 \
    > capture-summary.manifest.sha256
  chmod 0600 capture-summary.manifest.sha256
  sha256sum -c capture-summary.manifest.sha256
)
(
  cd "$failed"
  find . -type f ! -name SHA256SUMS.failed -print0 |
    LC_ALL=C sort -z |
    xargs -0 sha256sum > SHA256SUMS.failed
  chmod 0600 SHA256SUMS.failed
  sha256sum -c SHA256SUMS.failed
  sha256sum -c capture-summary.manifest.sha256
)
validate_failed_capture_summary "$failed"
printf '%s\n' "$failed" > "$state_dir/failed-state.path"
chmod 0600 "$state_dir/failed-state.path"
install -o root -g root -m 0600 /dev/null "$state_dir/rollback-A-failed-state-verified"
printf 'Failed state sealed at %s; inspect capture-summary.status before Rollback B.\n' "$failed"
~~~

### Rollback B: восстановить точный pre-cutover checkpoint

Этот gate деструктивен, но начинает работу только после проверки release,
pre-cutover checkpoint и failed-state manifest. Он восстанавливает старые
Compose/.env/locales, точные old bot/Redis image IDs, целевую БД bublik и только
том bublik-n_redis_data. Перед запуском старого bot PostgreSQL, Redis и все 40
baseline-таблиц проверяются повторно. Отсутствующие контейнеры допустимы и создаются
заново; существующий Redis-контейнер и том удаляются только после совпадения exact
name, Compose project/service/volume labels, mount `/data` и нулевого списка иных
consumers. Любое расхождение останавливает rollback до удаления.

~~~bash
set -euo pipefail
umask 077
test "$(id -u)" -eq 0
test -n "$TMUX"
test -n "$RELEASE_ID"
release_id="$RELEASE_ID"
printf '%s\n' "$release_id" | grep -Eq '^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$'

project=bublik-n
active=/opt/bublik-n
release_dir="/root/releases/bublik-ts/$release_id"
state_dir="/root/deploy-state/bublik-ts/$release_id"
env_file="$release_dir/deployment.env"
test "$(stat -c '%U:%G:%a' "$release_dir")" = root:root:700
test "$(stat -c '%U:%G:%a' "$env_file")" = root:root:600
test "$(stat -c '%U:%G:%a' "$release_dir/SHA256SUMS.release")" = root:root:600
(cd "$release_dir" && sha256sum -c SHA256SUMS.release)
if grep -Evq '^(RELEASE_ID=[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|RELEASE_IMAGE=bublik-n-bot:release-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|RELEASE_IMAGE_ID=sha256:[0-9a-f]{64}|CHECKPOINT_DIR=/root/backups/bublik-ts/cutover-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|SOURCE_COMMIT=[0-9a-f]{40}|SOURCE_TREE=[0-9a-f]{40}|BASELINE_SHA256=[0-9a-f]{64})$' "$env_file"; then
  exit 1
fi
test "$(wc -l < "$env_file")" -eq 7
for key in RELEASE_ID RELEASE_IMAGE RELEASE_IMAGE_ID CHECKPOINT_DIR SOURCE_COMMIT SOURCE_TREE BASELINE_SHA256; do
  test "$(grep -c "^$key=" "$env_file")" -eq 1
done
. "$env_file"
test "$RELEASE_ID" = "$release_id"
test "$(readlink -f -- "$release_dir")" = "$release_dir"
test -f "$state_dir/rollback-A-failed-state-verified"
test -f "$state_dir/failed-state.path"
failed="$(cat "$state_dir/failed-state.path")"
printf '%s\n' "$failed" | grep -Eq "^/root/backups/bublik-ts/failed-$release_id-[0-9]{8}T[0-9]{6}Z$"
test "$(readlink -f -- "$failed")" = "$failed"
test "$(stat -c '%U:%G:%a' "$failed")" = root:root:700
test "$(stat -c '%U:%G:%a' "$failed/SHA256SUMS.failed")" = root:root:600
(cd "$failed" && sha256sum -c SHA256SUMS.failed)
test "$(stat -c '%U:%G:%a' "$failed/capture-summary.manifest.sha256")" = root:root:600
(cd "$failed" && sha256sum -c capture-summary.manifest.sha256)

validate_failed_capture_summary() {
  local root="$1"
  local summary="$root/capture-summary.status"
  local container_presence="$root/container-presence.status"
  local volume_presence="$root/volume-presence.status"
  local spec key status_file summary_value status_value
  local bot_presence postgres_presence redis_presence
  local pg_volume_presence redis_volume_presence
  local bot_stop postgres_stop redis_stop postgres_logical postgres_raw
  local redis_bgsave redis_volume redis_rdb redis_aof release_env
  local release_env_file_safe release_env_sum_file_safe

  test -d "$root/redis-data" && test ! -L "$root/redis-data" || return 1
  for status_file in \
    "$summary" "$container_presence" "$volume_presence" \
    "$root/bot-stop.status" "$root/postgres-stop.status" \
    "$root/redis-stop.status" "$root/postgres-logical.status" \
    "$root/postgres-raw.status" "$root/redis-bgsave.status" \
    "$root/redis-volume.status" "$root/redis-rdb.status" \
    "$root/redis-aof.status" "$root/release-env.status" \
    "$root/redis-data.before-validation.sizes0" \
    "$root/redis-data.before-validation.sha256" \
    "$root/redis-data.after-validation.sizes0" \
    "$root/redis-data.after-validation.sha256"; do
    test -f "$status_file" && test ! -L "$status_file" || return 1
  done
  test -z "$(find "$root/redis-data" -xdev -type l -print -quit)" || return 1

  test "$(wc -l < "$summary")" -eq 10 || return 1
  if grep -Evq '^(bot_stop=(absent|stopped|already-stopped|stop-failed|identity-mismatch-not-stopped)|postgres_stop=(absent|stopped|already-stopped|stop-failed|identity-mismatch-not-stopped)|redis_stop=(absent|stopped|already-stopped|stop-failed|identity-mismatch-not-stopped)|postgres_logical=(absent|verified|unavailable|captured-unverified|partial-unverified|failed)|postgres_raw=(absent|verified|captured-unverified|capture-failed|running-consumer-not-copied|identity-mismatch-not-copied)|redis_bgsave=(absent|verified|unavailable)|redis_volume=(absent|captured|capture-failed|running-consumer-not-copied|identity-mismatch-not-copied)|redis_rdb=(absent|verified|unavailable|failed-but-preserved)|redis_aof=(absent|verified|unavailable|failed-but-preserved)|release_env=(absent|verified|partial-safe|partial-or-unsafe|partial-unverified))$' "$summary"; then
    return 1
  fi
  for key in bot_stop postgres_stop redis_stop postgres_logical postgres_raw \
    redis_bgsave redis_volume redis_rdb redis_aof release_env; do
    test "$(grep -c "^$key=" "$summary")" -eq 1 || return 1
  done

  test "$(wc -l < "$container_presence")" -eq 3 || return 1
  if grep -Evq '^(bublik-bot|bublik-postgres|bublik-redis)=(present|absent)$' \
       "$container_presence"; then
    return 1
  fi
  for key in bublik-bot bublik-postgres bublik-redis; do
    test "$(grep -c "^$key=" "$container_presence")" -eq 1 || return 1
  done
  test "$(wc -l < "$volume_presence")" -eq 2 || return 1
  if grep -Evq '^(bublik-n_pg_data|bublik-n_redis_data)=(present|absent)$' \
       "$volume_presence"; then
    return 1
  fi
  for key in bublik-n_pg_data bublik-n_redis_data; do
    test "$(grep -c "^$key=" "$volume_presence")" -eq 1 || return 1
  done

  for spec in \
    bot_stop:bot-stop.status postgres_stop:postgres-stop.status \
    redis_stop:redis-stop.status postgres_logical:postgres-logical.status \
    postgres_raw:postgres-raw.status redis_bgsave:redis-bgsave.status \
    redis_volume:redis-volume.status redis_rdb:redis-rdb.status \
    redis_aof:redis-aof.status release_env:release-env.status; do
    key="${spec%%:*}"
    status_file="$root/${spec#*:}"
    test "$(wc -l < "$status_file")" -eq 1 || return 1
    summary_value="$(awk -F= -v wanted="$key" '$1==wanted {print $2}' "$summary")"
    status_value="$(cat "$status_file")"
    test "$status_value" = "$summary_value" || return 1
  done

  bot_presence="$(awk -F= '$1=="bublik-bot" {print $2}' "$container_presence")"
  postgres_presence="$(awk -F= '$1=="bublik-postgres" {print $2}' "$container_presence")"
  redis_presence="$(awk -F= '$1=="bublik-redis" {print $2}' "$container_presence")"
  pg_volume_presence="$(awk -F= '$1=="bublik-n_pg_data" {print $2}' "$volume_presence")"
  redis_volume_presence="$(awk -F= '$1=="bublik-n_redis_data" {print $2}' "$volume_presence")"
  bot_stop="$(awk -F= '$1=="bot_stop" {print $2}' "$summary")"
  postgres_stop="$(awk -F= '$1=="postgres_stop" {print $2}' "$summary")"
  redis_stop="$(awk -F= '$1=="redis_stop" {print $2}' "$summary")"
  postgres_logical="$(awk -F= '$1=="postgres_logical" {print $2}' "$summary")"
  postgres_raw="$(awk -F= '$1=="postgres_raw" {print $2}' "$summary")"
  redis_bgsave="$(awk -F= '$1=="redis_bgsave" {print $2}' "$summary")"
  redis_volume="$(awk -F= '$1=="redis_volume" {print $2}' "$summary")"
  redis_rdb="$(awk -F= '$1=="redis_rdb" {print $2}' "$summary")"
  redis_aof="$(awk -F= '$1=="redis_aof" {print $2}' "$summary")"
  release_env="$(awk -F= '$1=="release_env" {print $2}' "$summary")"

  case "$bot_presence:$bot_stop" in
    present:stopped|present:already-stopped|absent:absent) ;;
    *) return 1 ;;
  esac
  case "$postgres_presence:$postgres_stop:$postgres_logical" in
    present:stopped:verified|present:already-stopped:verified|absent:absent:absent) ;;
    present:already-stopped:unavailable)
      test "$pg_volume_presence:$postgres_raw" = present:verified || return 1
      ;;
    *) return 1 ;;
  esac
  case "$pg_volume_presence:$postgres_raw" in
    present:verified|absent:absent) ;;
    *) return 1 ;;
  esac
  case "$redis_presence:$redis_stop:$redis_bgsave" in
    present:stopped:verified|present:already-stopped:verified|absent:absent:absent) ;;
    present:already-stopped:unavailable)
      test "$redis_volume_presence:$redis_volume" = present:captured || return 1
      ;;
    *) return 1 ;;
  esac
  if test "$redis_presence" = present; then
    test "$redis_volume_presence:$redis_volume" = present:captured || return 1
  fi
  case "$redis_volume_presence:$redis_volume" in
    present:captured|absent:absent) ;;
    *) return 1 ;;
  esac

  if test "$redis_volume_presence" = absent; then
    test "$redis_rdb" = absent && test "$redis_aof" = absent || return 1
    test -z "$(find "$root/redis-data" -mindepth 1 -print -quit)" || return 1
  else
    case "$redis_rdb" in
      verified)
        test -s "$root/redis-data/dump.rdb" &&
          test -f "$root/redis-data/dump.rdb" &&
          test ! -L "$root/redis-data/dump.rdb" || return 1
        ;;
      absent)
        test ! -e "$root/redis-data/dump.rdb" &&
          test ! -L "$root/redis-data/dump.rdb" || return 1
        ;;
      *) return 1 ;;
    esac
    case "$redis_aof" in
      verified)
        test -f "$root/redis-data/appendonlydir/appendonly.aof.manifest" &&
          test ! -L "$root/redis-data/appendonlydir/appendonly.aof.manifest" &&
          test -d "$root/redis-data/appendonlydir" &&
          test ! -L "$root/redis-data/appendonlydir" || return 1
        ;;
      absent)
        test ! -e "$root/redis-data/appendonlydir/appendonly.aof.manifest" &&
          test ! -L "$root/redis-data/appendonlydir/appendonly.aof.manifest" &&
          test ! -e "$root/redis-data/appendonly.aof" &&
          test ! -L "$root/redis-data/appendonly.aof" || return 1
        if test -e "$root/redis-data/appendonlydir" ||
           test -L "$root/redis-data/appendonlydir"; then
          test -d "$root/redis-data/appendonlydir" &&
            test ! -L "$root/redis-data/appendonlydir" &&
            test -z "$(find "$root/redis-data/appendonlydir" -mindepth 1 -print -quit)" ||
            return 1
        fi
        ;;
      *) return 1 ;;
    esac
  fi

  case "$release_env" in
    verified)
      test -f "$root/active/release.env" && test ! -L "$root/active/release.env" &&
        test -f "$root/active/release.env.sha256" &&
        test ! -L "$root/active/release.env.sha256" || return 1
      (cd "$root/active" && sha256sum -c release.env.sha256 >/dev/null) || return 1
      ;;
    absent)
      test ! -e "$root/active/release.env" && test ! -L "$root/active/release.env" &&
        test ! -e "$root/active/release.env.sha256" &&
        test ! -L "$root/active/release.env.sha256" || return 1
      ;;
    partial-safe)
      release_env_file_safe=0
      release_env_sum_file_safe=0
      if test -f "$root/active/release.env" &&
         test ! -L "$root/active/release.env"; then
        release_env_file_safe=1
      else
        test ! -e "$root/active/release.env" &&
          test ! -L "$root/active/release.env" || return 1
      fi
      if test -f "$root/active/release.env.sha256" &&
         test ! -L "$root/active/release.env.sha256"; then
        release_env_sum_file_safe=1
      else
        test ! -e "$root/active/release.env.sha256" &&
          test ! -L "$root/active/release.env.sha256" || return 1
      fi
      test $((release_env_file_safe + release_env_sum_file_safe)) -eq 1 || return 1
      ;;
    *) return 1 ;;
  esac

  cmp "$root/redis-data.before-validation.sizes0" \
    "$root/redis-data.after-validation.sizes0" >/dev/null || return 1
  cmp "$root/redis-data.before-validation.sha256" \
    "$root/redis-data.after-validation.sha256" >/dev/null || return 1
  cmp "$root/redis-data.after-validation.sizes0" <(
    cd "$root/redis-data"
    find . -xdev -type f -printf '%s %P\0' | LC_ALL=C sort -z
  ) >/dev/null || return 1
  cmp "$root/redis-data.after-validation.sha256" <(
    cd "$root/redis-data"
    find . -xdev -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum
  ) >/dev/null || return 1
}
validate_failed_capture_summary "$failed"
test "$(readlink -f -- "$CHECKPOINT_DIR")" = "$CHECKPOINT_DIR"
test "$(stat -c '%U:%G:%a' "$CHECKPOINT_DIR")" = root:root:700
test "$(stat -c '%U:%G:%a' "$CHECKPOINT_DIR/SHA256SUMS.final")" = root:root:600
(cd "$CHECKPOINT_DIR" && sha256sum -c SHA256SUMS.final)

checkpoint_env="$CHECKPOINT_DIR/checkpoint.env"
test "$(stat -c '%U:%G:%a' "$checkpoint_env")" = root:root:600
test "$(wc -l < "$checkpoint_env")" -eq 11
if grep -Evq '^(OLD_BOT_IMAGE_ID=sha256:[0-9a-f]{64}|OLD_BOT_IMAGE_REF=[A-Za-z0-9._/@:+-]+|OLD_BOT_CHECKPOINT_TAG=bublik-checkpoint-bot:[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|OLD_REDIS_IMAGE_ID=sha256:[0-9a-f]{64}|OLD_REDIS_IMAGE_REF=[A-Za-z0-9._/@:+-]+|OLD_REDIS_CHECKPOINT_TAG=bublik-checkpoint-redis:[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}|POSTGRES_IMAGE_ID=sha256:[0-9a-f]{64}|POSTGRES_IMAGE_REF=[A-Za-z0-9._/@:+-]+|POSTGRES_USER=bublik|POSTGRES_DB=bublik|ACTIVE_ENV_SHA256=[0-9a-f]{64})$' "$checkpoint_env"; then
  exit 1
fi
for key in OLD_BOT_IMAGE_ID OLD_BOT_IMAGE_REF OLD_BOT_CHECKPOINT_TAG OLD_REDIS_IMAGE_ID OLD_REDIS_IMAGE_REF OLD_REDIS_CHECKPOINT_TAG POSTGRES_IMAGE_ID POSTGRES_IMAGE_REF POSTGRES_USER POSTGRES_DB ACTIVE_ENV_SHA256; do
  test "$(grep -c "^$key=" "$checkpoint_env")" -eq 1
done
. "$checkpoint_env"
test "$POSTGRES_USER" = bublik
test "$POSTGRES_DB" = bublik
for spec in bublik-bot:bot bublik-redis:redis bublik-postgres:postgres; do
  target="${spec%%:*}"
  service="${spec#*:}"
  if docker inspect "$target" >/dev/null 2>&1; then
    test "$(docker inspect -f '{{.Name}}' "$target")" = "/$target"
    test "$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$target")" = "$project"
    test "$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.service" }}' "$target")" = "$service"
    test "$(docker inspect -f '{{.State.Running}}' "$target")" = false
  fi
done

test "$(readlink -f -- "$active")" = "$active"
docker load --input "$CHECKPOINT_DIR/old-bot-image.tar" >/dev/null
docker load --input "$CHECKPOINT_DIR/old-redis-image.tar" >/dev/null
docker load --input "$CHECKPOINT_DIR/postgres-image.tar" >/dev/null
postgres_checkpoint_tag="bublik-checkpoint-postgres:$release_id"
docker image tag "$POSTGRES_IMAGE_ID" "$postgres_checkpoint_tag"
test "$(docker image inspect -f '{{.Id}}' "$OLD_BOT_CHECKPOINT_TAG")" = "$OLD_BOT_IMAGE_ID"
test "$(docker image inspect -f '{{.Id}}' "$OLD_REDIS_CHECKPOINT_TAG")" = "$OLD_REDIS_IMAGE_ID"
test "$(docker image inspect -f '{{.Id}}' "$postgres_checkpoint_tag")" = "$POSTGRES_IMAGE_ID"

install -o root -g root -m 0644 \
  "$CHECKPOINT_DIR/active/docker-compose.yml" "$active/docker-compose.yml.restore"
mv "$active/docker-compose.yml.restore" "$active/docker-compose.yml"
install -o root -g root -m 0600 \
  "$CHECKPOINT_DIR/active/.env" "$active/.env.restore"
mv "$active/.env.restore" "$active/.env"
test "$(sha256sum "$active/.env" | awk '{print $1}')" = "$ACTIVE_ENV_SHA256"
if test -e "$active/locales" || test -L "$active/locales"; then
  test -d "$active/locales"
  test ! -L "$active/locales"
  test "$(readlink -f -- "$active/locales")" = "$active/locales"
  test -z "$(find "$active/locales" -type l -print -quit)"
  test ! -e "$active/.locales.failed-$release_id"
  mv "$active/locales" "$active/.locales.failed-$release_id"
fi
tar --numeric-owner -C "$active" -xf "$CHECKPOINT_DIR/active/locales.tar"
for release_pin in release.env release.env.sha256; do
  if test -e "$active/$release_pin" || test -L "$active/$release_pin"; then
    test -f "$active/$release_pin"
    test ! -L "$active/$release_pin"
    test "$(readlink -f -- "$active/$release_pin")" = "$active/$release_pin"
    test ! -e "$active/.$release_pin.failed-$release_id"
    mv "$active/$release_pin" "$active/.$release_pin.failed-$release_id"
  fi
done

rollback_override="$state_dir/rollback-images.yml"
cat > "$rollback_override" <<YAML
services:
  bot:
    image: $OLD_BOT_CHECKPOINT_TAG
  postgres:
    image: $postgres_checkpoint_tag
  redis:
    image: $OLD_REDIS_CHECKPOINT_TAG
YAML
chown root:root "$rollback_override"
chmod 0600 "$rollback_override"

cd "$active"
compose_rollback() {
  BUBLIK_REDIS_IMAGE="$OLD_REDIS_CHECKPOINT_TAG" \
    docker compose -p "$project" -f docker-compose.yml -f "$rollback_override" "$@"
}
compose_rollback config --quiet

assert_rollback_redis_target() {
  redis_volume=bublik-n_redis_data
  redis_container_id=
  if docker inspect bublik-redis >/dev/null 2>&1; then
    test "$(docker inspect -f '{{.Name}}' bublik-redis)" = /bublik-redis || return 1
    test "$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' bublik-redis)" = "$project" || return 1
    test "$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.service" }}' bublik-redis)" = redis || return 1
    test "$(docker inspect -f '{{.State.Running}}' bublik-redis)" = false || return 1
    test "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' bublik-redis)" = "$redis_volume" || return 1
    redis_container_id="$(docker inspect -f '{{.Id}}' bublik-redis)" || return 1
    printf '%s\n' "$redis_container_id" | grep -Eq '^[0-9a-f]{64}$' || return 1
  fi
  if docker volume inspect "$redis_volume" >/dev/null 2>&1; then
    test "$(docker volume inspect -f '{{.Name}}' "$redis_volume")" = "$redis_volume" || return 1
    test "$(docker volume inspect -f '{{ index .Labels "com.docker.compose.project" }}' "$redis_volume")" = "$project" || return 1
    test "$(docker volume inspect -f '{{ index .Labels "com.docker.compose.volume" }}' "$redis_volume")" = redis_data || return 1
    redis_volume_consumers="$(docker ps -aq --no-trunc --filter "volume=$redis_volume")" || return 1
    if test -n "$redis_container_id"; then
      test "$redis_volume_consumers" = "$redis_container_id" || return 1
    else
      test -z "$redis_volume_consumers" || return 1
    fi
  elif test -n "$redis_container_id"; then
    return 1
  fi
}

# Этот read-only exact-target gate идёт до start/drop/create PostgreSQL, чтобы
# известный Redis mismatch не оставил cross-store rollback наполовину выполненным.
assert_rollback_redis_target

if ! docker volume inspect bublik-n_pg_data >/dev/null 2>&1; then
  test -z "$(docker ps -aq --filter 'name=^/bublik-postgres$')"
  compose_rollback up --no-start --no-deps --pull never postgres
fi
test "$(docker volume inspect -f '{{.Name}}' bublik-n_pg_data)" = bublik-n_pg_data
test "$(docker volume inspect -f '{{ index .Labels "com.docker.compose.project" }}' bublik-n_pg_data)" = "$project"
test "$(docker volume inspect -f '{{ index .Labels "com.docker.compose.volume" }}' bublik-n_pg_data)" = pg_data
if docker inspect bublik-postgres >/dev/null 2>&1; then
  test "$(docker inspect -f '{{.Image}}' bublik-postgres)" = "$POSTGRES_IMAGE_ID"
  test "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' bublik-postgres)" = bublik-n_pg_data
else
  compose_rollback up --no-start --no-deps --pull never postgres
  test "$(docker inspect -f '{{.Image}}' bublik-postgres)" = "$POSTGRES_IMAGE_ID"
  test "$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' bublik-postgres)" = "$project"
  test "$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.service" }}' bublik-postgres)" = postgres
  test "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' bublik-postgres)" = bublik-n_pg_data
fi
compose_rollback start postgres
pg_healthy=0
for attempt in $(seq 1 60); do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' bublik-postgres)"
  if test "$status" = healthy; then pg_healthy=1; break; fi
  test "$(docker inspect -f '{{.State.Running}}' bublik-postgres)" = true
  sleep 2
done
test "$pg_healthy" -eq 1
test "$(docker inspect -f '{{.Image}}' bublik-postgres)" = "$POSTGRES_IMAGE_ID"
test "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' bublik-postgres)" = bublik-n_pg_data

docker exec bublik-postgres psql -U "$POSTGRES_USER" -d postgres \
  -v ON_ERROR_STOP=1 -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$POSTGRES_DB' AND pid <> pg_backend_pid();"
docker exec bublik-postgres dropdb --force --if-exists -U "$POSTGRES_USER" "$POSTGRES_DB"
docker exec bublik-postgres createdb -U "$POSTGRES_USER" -O "$POSTGRES_USER" "$POSTGRES_DB"
docker exec -i bublik-postgres pg_restore \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --exit-on-error --no-owner --no-acl \
  < "$CHECKPOINT_DIR/postgres.dump"
docker exec bublik-postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
test "$(docker exec bublik-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc 'SELECT current_database()')" = bublik

assert_rollback_redis_target

if test -n "$redis_container_id"; then
  test "$(docker inspect -f '{{.Id}}' bublik-redis)" = "$redis_container_id"
  docker rm bublik-redis >/dev/null
fi
if docker volume inspect "$redis_volume" >/dev/null 2>&1; then
  test "$(docker volume inspect -f '{{ index .Labels "com.docker.compose.project" }}' "$redis_volume")" = "$project"
  test "$(docker volume inspect -f '{{ index .Labels "com.docker.compose.volume" }}' "$redis_volume")" = redis_data
  redis_volume_consumers="$(docker ps -aq --no-trunc --filter "volume=$redis_volume")"
  test -z "$redis_volume_consumers"
  docker volume rm "$redis_volume" >/dev/null
fi
if docker volume inspect "$redis_volume" >/dev/null 2>&1; then
  exit 1
fi

compose_rollback up --no-start --no-deps --pull never redis
test "$(docker inspect -f '{{.Image}}' bublik-redis)" = "$OLD_REDIS_IMAGE_ID"
test "$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' bublik-redis)" = "$project"
test "$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.service" }}' bublik-redis)" = redis
test "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' bublik-redis)" = "$redis_volume"
test "$(docker volume inspect -f '{{.Name}}' "$redis_volume")" = "$redis_volume"
test "$(docker volume inspect -f '{{ index .Labels "com.docker.compose.project" }}' "$redis_volume")" = "$project"
test "$(docker volume inspect -f '{{ index .Labels "com.docker.compose.volume" }}' "$redis_volume")" = redis_data
test "$(docker ps -aq --no-trunc --filter "volume=$redis_volume")" = "$(docker inspect -f '{{.Id}}' bublik-redis)"
docker run --rm --user 0:0 --entrypoint sh \
  --mount type=volume,src="$redis_volume",dst=/data,readonly \
  "$OLD_REDIS_IMAGE_ID" -ec 'test -z "$(find /data -mindepth 1 -print -quit)"'
docker cp -a "$CHECKPOINT_DIR/redis-data/." bublik-redis:/data
docker run --rm --user 0:0 --entrypoint sh \
  --mount type=volume,src="$redis_volume",dst=/data,readonly \
  "$OLD_REDIS_IMAGE_ID" -ec '
    cd /data
    find . -xdev -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum
  ' > "$state_dir/redis-data.rollback.sha256"
cmp "$CHECKPOINT_DIR/redis-data.after-validation.sha256" \
  "$state_dir/redis-data.rollback.sha256"
docker run --rm --user 0:0 --entrypoint sh \
  --mount type=volume,src=bublik-n_redis_data,dst=/data \
  "$OLD_REDIS_IMAGE_ID" -ec '
    redis_uid="$(id -u redis)"
    redis_gid="$(id -g redis)"
    chown -R redis:redis /data
    unexpected="$(find /data \( ! -user "$redis_uid" -o ! -group "$redis_gid" \) -print -quit)"
    test -z "$unexpected"
  '
docker run --rm --user redis:redis --entrypoint sh \
  --mount type=volume,src=bublik-n_redis_data,dst=/data \
  "$OLD_REDIS_IMAGE_ID" -ec '
    touch /data/.bublik-write-probe
    rm /data/.bublik-write-probe
  '
compose_rollback start redis
redis_healthy=0
for attempt in $(seq 1 60); do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' bublik-redis)"
  if test "$status" = healthy; then redis_healthy=1; break; fi
  test "$(docker inspect -f '{{.State.Running}}' bublik-redis)" = true
  sleep 2
done
test "$redis_healthy" -eq 1
test "$(docker inspect -f '{{.Image}}' bublik-redis)" = "$OLD_REDIS_IMAGE_ID"
test "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' bublik-redis)" = bublik-n_redis_data
docker exec bublik-redis redis-cli --raw INFO keyspace |
  tr -d '\r' | sed -E 's/,avg_ttl=[0-9]+//' \
  > "$state_dir/redis-keyspace.rollback"
test ! -e "$state_dir/redis-snapshot.rollback.json"
test ! -e "$state_dir/redis-comparison.rollback.json"
docker run --rm --user 0:0 --network bublik-n_default \
  --env REDIS_URL=redis://redis:6379/0 -v "$state_dir:/state" \
  --entrypoint node "$RELEASE_IMAGE_ID" scripts/snapshot-redis-data.js \
  --snapshot --output /state/redis-snapshot.rollback.json
docker run --rm --user 0:0 \
  -v "$CHECKPOINT_DIR:/checkpoint:ro" -v "$state_dir:/state" \
  --entrypoint node "$RELEASE_IMAGE_ID" scripts/snapshot-redis-data.js \
  --compare /checkpoint/redis-before.json /state/redis-snapshot.rollback.json \
  --expiry-tolerance-ms 0 --expiry-grace-ms 0 \
  --output /state/redis-comparison.rollback.json
docker run --rm -i --entrypoint node "$RELEASE_IMAGE_ID" -e '
  let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
    const r=JSON.parse(s);
    if(r.format!=="bublik-redis-data-comparison/v1"||
       r.status!=="identical"||r.expiryToleranceMs!==0||r.expiryGraceMs!==0||
       r.differences.length!==0||
       r.beforeKeyCount-r.afterKeyCount!==r.expectedExpired.length||
       r.expectedExpired.some(e=>BigInt(e.expireAtMs)>
         BigInt(new Date(e.afterCapturedAt).getTime())))process.exit(1);
  });
' < "$state_dir/redis-comparison.rollback.json"

test ! -e "$state_dir/preflight.rollback.json"
test ! -e "$state_dir/snapshot.rollback.json"
test ! -e "$state_dir/comparison.rollback.json"
docker run --rm --user 0:0 --network bublik-n_default \
  --env-file "$active/.env" -v "$state_dir:/state" \
  --entrypoint node "$RELEASE_IMAGE_ID" \
  scripts/snapshot-baseline-data.js --preflight-operational \
  --output /state/preflight.rollback.json
docker run --rm --user 0:0 --network bublik-n_default \
  --env-file "$active/.env" -v "$state_dir:/state" \
  --entrypoint node "$RELEASE_IMAGE_ID" \
  scripts/snapshot-baseline-data.js --snapshot-operational \
  --output /state/snapshot.rollback.json
docker run --rm --user 0:0 --entrypoint node \
  -v "$CHECKPOINT_DIR:/checkpoint:ro" -v "$state_dir:/state" \
  "$RELEASE_IMAGE_ID" scripts/snapshot-baseline-data.js \
  --compare /checkpoint/baseline-before.json /state/snapshot.rollback.json \
  --output /state/comparison.rollback.json
docker run --rm -i --entrypoint node "$RELEASE_IMAGE_ID" -e '
  let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
    const r=JSON.parse(s);
    if(r.status!=="identical"||r.profile!=="operational"||
       r.tableCount!==40||r.sequenceCount!==1||
       r.differences.length!==0)process.exit(1);
  });
' < "$state_dir/comparison.rollback.json"

test "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' bublik-postgres)" = healthy
test "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' bublik-redis)" = healthy
compose_rollback up -d --no-deps --force-recreate --no-build --pull never bot
old_bot_healthy=0
for attempt in $(seq 1 60); do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' bublik-bot)"
  if test "$status" = healthy; then old_bot_healthy=1; break; fi
  test "$(docker inspect -f '{{.State.Running}}' bublik-bot)" = true
  sleep 3
done
test "$old_bot_healthy" -eq 1
test "$(docker inspect -f '{{.Image}}' bublik-bot)" = "$OLD_BOT_IMAGE_ID"
test "$(docker inspect -f '{{.RestartCount}}' bublik-bot)" = 0
docker exec bublik-bot node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const argv = fs.readFileSync("/proc/1/cmdline").toString().split(String.fromCharCode(0)).filter(Boolean);
  if (path.basename(argv[0]) !== "node" || argv[1] !== "dist/index.js") process.exit(1);
'
old_bot_started_at="$(docker inspect -f '{{.State.StartedAt}}' bublik-bot)"
sleep 35
test "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' bublik-postgres)" = healthy
test "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' bublik-redis)" = healthy
test "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' bublik-bot)" = healthy
test "$(docker inspect -f '{{.RestartCount}}' bublik-redis)" = 0
test "$(docker inspect -f '{{.RestartCount}}' bublik-bot)" = 0
test "$(docker inspect -f '{{.State.StartedAt}}' bublik-bot)" = "$old_bot_started_at"
compose_rollback logs --tail 400 bot > "$state_dir/bot.rollback.log"

chown -R root:root "$state_dir"
find "$state_dir" -type d -exec chmod 0700 {} +
find "$state_dir" -type f -exec chmod 0600 {} +
install -o root -g root -m 0600 /dev/null "$state_dir/rollback-B-healthy"
printf 'Rollback healthy. Проверьте Discord /ping и внешние side effects вручную.\n'
~~~

Rollback возвращает PostgreSQL и Redis, но не отменяет автоматически уже
выполненные изменения Discord-ролей, каналов или отправленных сообщений. Их
проверяют отдельно по failed-state логам. Не удаляй checkpoint, failed-state и
зашифрованную off-host копию до завершения расследования.

## Команды

/info и /ping глобальные; остальные команды регистрируются для разрешённых
серверов. Основные группы: /economy, /regbattle, /br, /team, /welcome, /voice,
/vacation, /language, /reload, /setup и /whitelist.

## Проверки и сборка

~~~bash
set -euo pipefail
cd "/absolute/path/to/Bublik n"
npm ci
npm run check
npm run test:baseline
docker compose config --quiet
docker build --check .
~~~

Исходники в src являются источником истины. dist и dist-protected — только
генерируемые артефакты, которые не копируются с host в production image.

## Инварианты ролей полковых боёв

Ротация ролей запускается только при доказанной роли на момент входа: ping или уже
существующей played today. Членство в отряде, приглашение в закрытый войс и права
командира разрешают доступ к каналу, но сами не выдают in battle, ping или played
today. Короткая сессия возвращает исходную роль; длинная переводит только
доказанный ping в played today; суточный reset восстанавливает сохранённый источник.

ALLOWED_GUILDS используется один раз для заполнения пустой БД. Затем whitelist
управляется /whitelist и удаление последнего сервера не отменяется рестартом.

---

NaveLIL for EREZ, 2024–2026

#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <archive-path> <status-json-path> <dataset-json-path>" >&2
  exit 1
fi

archive_path="$1"
status_json_path="$2"
dataset_json_path="$3"

: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

artifact_branch="${DB_ARTIFACTS_BRANCH:-levi/db-artifacts}"
archive_name="${DB_ARTIFACT_NAME:-gnaf.sqlite.zst}"
repo_url="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
work_dir="$(mktemp -d)"

cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

version="$(
  bun -e '
    const status = JSON.parse(await Bun.file(process.argv[1]).text());
    const meta = status.database?.metadata ?? {};
    const resourceId = meta.resource_id ?? "unknown-resource";
    const schemaVersion = meta.schema_version ?? "unknown-schema";
    const importedAt = String(meta.imported_at ?? new Date().toISOString()).replaceAll(":", "-");
    process.stdout.write(`${schemaVersion}/${resourceId}/${importedAt}`);
  ' "$status_json_path"
)"

git init "$work_dir" >/dev/null
cd "$work_dir"
git remote add origin "$repo_url"

if git ls-remote --exit-code --heads origin "$artifact_branch" >/dev/null 2>&1; then
  git fetch --depth=1 origin "$artifact_branch"
  git checkout -B "$artifact_branch" FETCH_HEAD
else
  git checkout --orphan "$artifact_branch"
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git lfs install --local >/dev/null

mkdir -p artifacts
rm -rf artifacts/previous
if [[ -d artifacts/latest ]]; then
  mv artifacts/latest artifacts/previous
fi

mkdir -p artifacts/latest
cp "$archive_path" "artifacts/latest/${archive_name}"
cp "$status_json_path" artifacts/latest/status.json
cp "$dataset_json_path" artifacts/latest/dataset.json
printf '%s\n' "$version" > artifacts/latest/version.txt
(cd artifacts/latest && sha256sum "${archive_name}" > "${archive_name}.sha256")

cat > .gitattributes <<'EOF'
artifacts/**/*.zst filter=lfs diff=lfs merge=lfs -text
EOF

git add .gitattributes artifacts

if git diff --cached --quiet; then
  echo "artifact_branch=${artifact_branch}" >> "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
  echo "artifact_path=artifacts/latest/${archive_name}" >> "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
  echo "artifact_version=${version}" >> "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
  exit 0
fi

git commit -m "Update DB artifact ${version}" >/dev/null
git push origin "HEAD:${artifact_branch}" >/dev/null

{
  echo "artifact_branch=${artifact_branch}"
  echo "artifact_path=artifacts/latest/${archive_name}"
  echo "artifact_version=${version}"
} >> "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

# Legacy credentials import

How to seed `profiles.jsonl` (PrivateProfile) + `legacy-passwords.jsonl`
(LegacyPasswordCredential) into a deployment's private store from a
laddr MySQL export.

The public-side importer ([`script:import-laddr`](../../apps/api/scripts/import-laddr.ts))
deliberately handles only public data — laddr's public JSON API doesn't
expose emails or password hashes. This second importer fills the
private-side gap.

It runs **once per environment** at cutover. After legacy users start
signing in, the in-app rehash-on-login flow gradually rotates SHA-1 /
bcrypt hashes to argon2id; re-running this importer would clobber those
rehashed credentials with the originals. The script is re-runnable
shape-wise (it always produces a complete replacement), but in practice
it's run once per env unless something went wrong with the first run.

## What you need

### CSV export from laddr

A CSV with header `Username,Email,Password`, one row per active laddr
user. Each cell is double-quoted; embedded quotes use `""` escape.

```csv
"Username","Email","Password"
"chris","chris@codeforphilly.org","$2y$10$LinW…"
"hhutch","hunter.hutchinson@gmail.com","7746451fd8c30b5b4068cd45fa7b1052cef54068"
```

- **Username** — laddr `User.Handle` (= the slug that became `Person.slug`).
- **Email** — required; rows with empty Email are skipped (warned).
- **Password** — the raw `PasswordHash` column from laddr's `users` table.
  Mixed algorithms in the wild: older users are unsalted SHA-1 (40 lowercase
  hex chars, no prefix); newer users are bcrypt (`$2a$ / $2b$ / $2y$`).
  Empty Password is allowed — emits a PrivateProfile but no
  LegacyPasswordCredential; user will have to use the password-reset
  flow if they ever want one. The runtime verifier handles all three
  formats; see [specs/behaviors/password-hash-rotation.md](../../specs/behaviors/password-hash-rotation.md).

Produce the file with:

```bash
mysql -h <host> -u <user> -p<password> laddr \
  -B -e "SELECT Handle AS Username, Email, PasswordHash AS Password
         FROM users WHERE Email IS NOT NULL AND PasswordHash IS NOT NULL" \
  | sed 's/"/\\\\"/g' | awk -F'\t' 'BEGIN{print "\"Username\",\"Email\",\"Password\""} NR>1 {printf "\"%s\",\"%s\",\"%s\"\n", $1, $2, $3}' \
  > .scratch/legacy-logins-export.csv
```

(Or use whatever extract tooling you prefer — the importer just needs
the CSV shape above. Land the file in `.scratch/` which is gitignored.)

### A bare clone of `codeforphilly-data`

The importer reads Person records (for the `slug → personId` map) via
the same `openPublicStore` interface the runtime uses, which requires a
bare clone. If your dev sibling clone is a working tree, make a
side-clone for the importer:

```bash
git clone --bare --branch published \
  ~/Repositories/codeforphilly-data \
  /tmp/codeforphilly-data-bare-published.git
```

## Run

```bash
npm run -w apps/api script:import-laddr-credentials -- \
  --input=/absolute/path/to/.scratch/legacy-logins-export.csv \
  --data-repo=/tmp/codeforphilly-data-bare-published.git \
  --output-dir=/absolute/path/to/.scratch/private-import \
  [--dry-run] [--verbose]
```

Defaults (when flags are omitted):

| Flag           | Default                                  |
|----------------|-------------------------------------------|
| `--input`      | `.scratch/legacy-logins-export.csv` (resolved from `apps/api/`) |
| `--data-repo`  | `$CFP_DATA_REPO_PATH` (required if unset) |
| `--output-dir` | `.scratch/private-import` (resolved from `apps/api/`) |

**Pass absolute paths** when running via npm — `npm run -w` changes
directory into the workspace and relative paths resolve from there.

The report prints input row count, write counts, and a breakdown of
skip reasons (no-username / no-email / no-person-match / deleted-person
/ duplicate-person). Expect a ~95% match rate on a healthy laddr corpus
— the missing 5% are typically deleted laddr users that didn't survive
the public-data import.

## Deploy to sandbox (FilesystemPrivateStore on a PVC)

The sandbox uses `STORAGE_BACKEND=filesystem` with `/app/private-storage`
mounted to a PersistentVolumeClaim (see `deploy/kustomize/base/`).

1. **Copy the files into the pod:**

   ```bash
   POD=$(kubectl -n codeforphilly-rewrite-sandbox get pods -o jsonpath='{.items[0].metadata.name}')
   kubectl -n codeforphilly-rewrite-sandbox cp \
     .scratch/private-import/profiles.jsonl "$POD:/app/private-storage/profiles.jsonl"
   kubectl -n codeforphilly-rewrite-sandbox cp \
     .scratch/private-import/legacy-passwords.jsonl "$POD:/app/private-storage/legacy-passwords.jsonl"
   ```

2. **Restart the pod** to reload the private store into memory. The
   `POST /api/_internal/reload-data` webhook **does not** cover the
   private store — it only reloads public + FTS. A full pod restart
   is the supported path.

   ```bash
   kubectl -n codeforphilly-rewrite-sandbox rollout restart deployment
   ```

3. **Verify** the new pod sees the credentials:

   ```bash
   curl -sS https://next-v2.codeforphilly.org/api/health/ready  # waits until private store is loaded
   ```

## Deploy to production (S3PrivateStore on GCS or S3)

Production uses `STORAGE_BACKEND=s3` with `S3_ENDPOINT` pointing at
either GCS's XML API (`https://storage.googleapis.com`) or an actual
S3 bucket. Upload the two files to the bucket at the configured
`keyPrefix` (default empty):

```bash
# GCS via gsutil
gsutil cp .scratch/private-import/profiles.jsonl \
  gs://<bucket>/profiles.jsonl
gsutil cp .scratch/private-import/legacy-passwords.jsonl \
  gs://<bucket>/legacy-passwords.jsonl

# OR: any S3 endpoint via awscli
aws s3 cp .scratch/private-import/profiles.jsonl \
  s3://<bucket>/profiles.jsonl --endpoint-url <S3_ENDPOINT>
aws s3 cp .scratch/private-import/legacy-passwords.jsonl \
  s3://<bucket>/legacy-passwords.jsonl --endpoint-url <S3_ENDPOINT>
```

Then restart the prod pod the same way (private-store reload is
not in the hot-reload path; see above).

## Safety notes

- **The script never writes credentials to git.** Output goes to a local
  directory you control. Upload to the runtime backend is a separate
  manual step.
- **`.scratch/` is gitignored.** Keep the CSV and the generated JSONL
  files there. Never commit either.
- **Re-running the importer overwrites the output files** locally, but
  does not touch the runtime backend until you deploy the new files.
- **Re-deploying overwrites the runtime files in full.** If users have
  already signed in and their credentials have been rehashed to
  argon2id (via the in-app rehash-on-login flow), a re-deploy would
  revert those to the SHA-1/bcrypt originals. After cutover, only
  re-run + re-deploy if you've confirmed nobody has signed in (or
  you're OK with the rotation reset).
- **PII risk.** The generated JSONL files contain every legacy user's
  email and password hash. Treat them as you would the source MySQL
  dump — never paste into chat, never check into git, delete from
  local disk after deploy if you don't need them retained.

## Cross-references

- [specs/behaviors/private-storage.md](../../specs/behaviors/private-storage.md) — what these files store and the rules around them.
- [specs/behaviors/password-hash-rotation.md](../../specs/behaviors/password-hash-rotation.md) — how the verifier handles SHA-1 / bcrypt / argon2id and rehashes on login.
- [docs/operations/cutover.md](./cutover.md) — full cutover sequence; this importer fits between the public-data import and the DNS flip.

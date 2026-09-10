# Legacy credentials import

How to seed `profiles.jsonl` (PrivateProfile) + `legacy-passwords.jsonl`
(LegacyPasswordCredential) into a deployment's private store from the
laddr MySQL database.

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

The first production load ran **2026-09-10**: 21,761 profiles/credentials
landed on the prod PVC.

## What you need

### CSV export from laddr

A CSV with header `Username,Email,Password`, one row per laddr user with
both a username and an email. Each cell is double-quoted; embedded quotes
use `""` escape.

```csv
"Username","Email","Password"
"chris","chris@codeforphilly.org","$2y$10$LinW…"
"hhutch","hunter.hutchinson@gmail.com","7746451fd8c30b5b4068cd45fa7b1052cef54068"
```

- **Username** — laddr `people.Username` (= the handle that became `Person.slug`).
- **Email** — required; rows with empty Email are skipped (warned).
- **Password** — the raw `people.Password` column. Mixed algorithms in the
  wild: older users are unsalted SHA-1 (40 lowercase hex chars, no prefix);
  newer users are bcrypt (`$2a$ / $2b$ / $2y$`). Empty Password is allowed —
  emits a PrivateProfile but no LegacyPasswordCredential; user will have
  to use the password-reset flow if they ever want one. The runtime
  verifier handles all three formats; see
  [specs/behaviors/password-hash-rotation.md](../../specs/behaviors/password-hash-rotation.md).

#### Where the data actually is

The live laddr site runs in the live cluster, namespace `code-for-philly`,
as an Emergence/Habitat pod with MySQL alongside. The database is
**`emergence-site`**. The same server also has a `codeforphilly` schema —
that is a **stale 2024 copy**; don't export from it. The table is `people`
(not `users`), columns `Username`, `Email`, `Password`.

#### Produce the file

Run the export *inside* the laddr pod with the Habitat-packaged mysql
client, reading the socket credentials from the service's client config:

```bash
# from your machine, against the live cluster kubeconfig
POD=$(kubectl -n code-for-philly get pods -l app.kubernetes.io/name=code-for-philly -o jsonpath='{.items[0].metadata.name}')
# (adjust the label selector if it doesn't match; `kubectl -n code-for-philly get pods` and pick the site pod)

kubectl -n code-for-philly exec "$POD" -- sh -c '
  M=$(ls -d /hab/pkgs/core/mysql/*/*/bin/mysql | tail -1);
  $M --defaults-extra-file=/hab/svc/mysql/config/client.cnf emergence-site -N -B -e \
    "SELECT Username, Email, Password FROM people
     WHERE Email IS NOT NULL AND Email<>'"'"''"'"' AND Username IS NOT NULL AND Username<>'"'"''"'"'"
' > .scratch/legacy-logins-export.tsv

# TSV -> quoted CSV in the shape the importer wants
awk -F'\t' '
  BEGIN { print "\"Username\",\"Email\",\"Password\"" }
  { for (i = 1; i <= 3; i++) gsub(/"/, "\"\"", $i);
    printf "\"%s\",\"%s\",\"%s\"\n", $1, $2, $3 }
' .scratch/legacy-logins-export.tsv > .scratch/legacy-logins-export.csv

wc -l .scratch/legacy-logins-export.csv    # expect ~21.8k rows + header
```

If the nested quoting in the `exec` line fights you, `kubectl exec -it` into
the pod, run the two-line `M=…; $M …` command there redirecting to
`/tmp/export.tsv`, then `kubectl cp` it out. Land the file in `.scratch/`,
which is gitignored.

### A bare clone of `codeforphilly-data`

The importer reads Person records (for the `slug → personId` map) via
the same `openPublicStore` interface the runtime uses, which requires a
bare clone on the **`published`** branch (the runtime branch — the data
repo has no `main`). If your dev sibling clone is a working tree, make a
side-clone for the importer:

```bash
git clone --bare --branch published \
  git@github.com:CodeForPhilly/codeforphilly-data.git \
  /tmp/codeforphilly-data-bare-published.git
```

Make sure it's at the tip you just pushed in the public-data refresh
([cutover.md → T-1](cutover.md#t-1-day-data-refresh--credentials)) —
a Person that isn't on `published` can't be matched.

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
/ duplicate-person). A large `no-person-match` count is expected when
`published` has been spam-pruned — the pruned people are exactly the ones
that shouldn't get a credential.

## Deploy (FilesystemPrivateStore on a PVC — sandbox and production)

Both environments use `STORAGE_BACKEND=filesystem` with
`/app/private-storage` mounted from the `codeforphilly-private`
PersistentVolumeClaim ([deploy.md → Private storage](deploy.md#private-storage)).
The procedure is identical; only the namespace differs:

| | Namespace | Health URL |
| --- | --- | --- |
| Production | `codeforphilly-ng` | `https://next.codeforphilly.org/api/health/ready` (apex after cutover) |
| Sandbox | `codeforphilly-rewrite-sandbox` | `https://next-v2.codeforphilly.org/api/health/ready` |

1. **Snapshot what's there** (skip on a first load into an empty PVC):

   ```bash
   NS=codeforphilly-ng
   POD=$(kubectl -n "$NS" get pods -l app.kubernetes.io/name=codeforphilly -o jsonpath='{.items[0].metadata.name}')
   kubectl -n "$NS" exec "$POD" -- sh -c 'cd /app/private-storage && for f in *.jsonl; do cp "$f" "$f.bak-$(date +%Y%m%dT%H%M%S)"; done; ls -la'
   ```

   The PVC has no versioning; the `.bak` copy on the volume is your undo.

2. **Copy the files into the pod:**

   ```bash
   kubectl -n "$NS" cp \
     .scratch/private-import/profiles.jsonl "$POD:/app/private-storage/profiles.jsonl"
   kubectl -n "$NS" cp \
     .scratch/private-import/legacy-passwords.jsonl "$POD:/app/private-storage/legacy-passwords.jsonl"
   ```

3. **Restart the pod** to reload the private store into memory. The
   `POST /api/_internal/reload-data` webhook **does not** cover the
   private store — it only reloads public + FTS. A full pod restart
   is the supported path.

   ```bash
   kubectl -n "$NS" rollout restart deploy/codeforphilly
   kubectl -n "$NS" rollout status deploy/codeforphilly
   ```

4. **Verify** the new pod sees the credentials: `/api/health/ready`
   returns 200, and a known legacy user can sign in with their laddr
   password.

### If the private store is ever moved to S3

The `s3` backend ([specs/behaviors/private-storage.md](../../specs/behaviors/private-storage.md#backends))
is supported but **not in use anywhere today**. If a deployment is ever
switched to it, the equivalent of step 2 is uploading the two files to the
bucket root (or the configured `keyPrefix`) with `aws s3 cp
--endpoint-url "$S3_ENDPOINT"`, then restarting the pod as above.

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
  revert those to the SHA-1/bcrypt originals. Production has been
  accepting sign-ins at `next.codeforphilly.org` since the first load, so
  **do not repeat the prod load casually** — only if you've confirmed
  nobody has signed in since, or you're OK with the rotation reset.
- **PII risk.** The generated JSONL files contain every legacy user's
  email and password hash. Treat them as you would the source MySQL
  dump — never paste into chat, never check into git, delete from
  local disk after deploy if you don't need them retained.

## Cross-references

- [specs/behaviors/private-storage.md](../../specs/behaviors/private-storage.md) — what these files store and the rules around them.
- [specs/behaviors/password-hash-rotation.md](../../specs/behaviors/password-hash-rotation.md) — how the verifier handles SHA-1 / bcrypt / argon2id and rehashes on login.
- [docs/operations/cutover.md](./cutover.md) — full cutover sequence; this importer runs at T-1, after the public-data refresh and before the gateway hostname move.

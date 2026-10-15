# Principles

The project's philosophy, written down as principles. Each is decisive: it
picks a side of a real trade-off so an implementer can resolve an
unspecified case the way the author would. Feature specs reference the
entries that govern them from their own `## Principles` sections.

## A record holds everything its path needs

Every field a sheet's path template names is a field of the record itself,
required by its schema. Nothing is spliced onto a record just before it's
written to make the path render. A record whose path is keyed by a
parent's handle (`project-memberships/${projectSlug}/${personSlug}`)
**references that parent by the handle**, not by the parent's id: the
path and the reference are the same fact, stored once.

Why: a path that can't be computed from the stored record is a write that
can fail for reasons the record doesn't show. Two production outages came
from path templates naming fields their records didn't carry. With the
path a pure function of the record, gitsheets can check at open time that
every template field is required, and the record on disk explains where it
lives.

The cost, accepted: renaming a parent rewrites every record that references
its handle (the files move anyway, since the handle is in their path).
References are declared in the schemas so that set is computable rather
than remembered. See [behaviors/slug-handles.md](behaviors/slug-handles.md).

References that are not part of a path (an update's author, a role's
poster) stay ids: they survive renames untouched.

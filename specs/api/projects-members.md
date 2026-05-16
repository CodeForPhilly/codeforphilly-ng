# API: Project Memberships

Manage the roster of people on a project. See [data-model.md](../data-model.md#projectmembership).

## Endpoints

| Method | Path | Auth | Summary |
| ------ | ---- | ---- | ------- |
| `POST` | `/api/projects/:slug/members` | maintainer \| staff | Add a member by person slug. |
| `PATCH` | `/api/projects/:slug/members/:personSlug` | maintainer \| staff | Update role. |
| `DELETE` | `/api/projects/:slug/members/:personSlug` | maintainer \| staff | Remove a member. |
| `POST` | `/api/projects/:slug/members/join` | user | Join the project as the current user. |
| `POST` | `/api/projects/:slug/members/leave` | user (self) | Leave the project. |

Listing memberships is part of `GET /api/projects/:slug` — there is no separate `GET /api/projects/:slug/members` for v1.

## POST /api/projects/:slug/members

Add an existing person to the project. The person must already have an account.

### Request

```json
{
  "personSlug": "newperson",
  "role": "Backend Engineer"
}
```

| Field | Required | Notes |
| ----- | -------- | ----- |
| personSlug | yes | Existing person's slug. |
| role | no | Freeform string, ≤ 80 chars. Null/missing means no role label. |

### Response — 201

```json
{ "success": true, "data": ProjectMembership }
```

### Errors

- `404 not_found` — person doesn't exist
- `409 conflict` with `error.code = "already_member"` — person is already on the project

## PATCH /api/projects/:slug/members/:personSlug

Update the membership row. Only `role` is editable; transferring the maintainer flag is done via `POST /api/projects/:slug/change-maintainer`.

### Request

```json
{ "role": "Designer" }
```

### Response — 200

```json
{ "success": true, "data": ProjectMembership }
```

## DELETE /api/projects/:slug/members/:personSlug

Remove the member. Cannot remove the current maintainer — respond `409 conflict` with `error.code = "cannot_remove_maintainer"`. Use `change-maintainer` first.

### Response — 204

## POST /api/projects/:slug/members/join

Add the current user to the project. No body. Used by the "Join project" affordance on the project page.

### Response — 201

```json
{ "success": true, "data": ProjectMembership }
```

`role` is null on self-join. The user can then `PATCH` their own membership to set a role, or the maintainer can.

### Errors

- `409 conflict` with `error.code = "already_member"`

## POST /api/projects/:slug/members/leave

Remove the current user. The current user cannot leave if they are the maintainer; transfer first.

### Response — 204

### Errors

- `409 conflict` with `error.code = "cannot_remove_maintainer"`
- `404 not_found` — user is not a member

## ProjectMembership response shape

```json
{
  "id": "<uuid>",
  "projectSlug": "squadquest",
  "person": PersonAvatar,
  "role": "Designer",
  "isMaintainer": true,
  "joinedAt": "..."
}
```

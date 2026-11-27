# Security Specification (Phase 0)

## 1. Data Invariants
1. A `UserProfile` document at `/users/{userId}` can only be read, created, or updated by the authenticated user whose `request.auth.uid == userId`, with `uid == request.auth.uid`, valid bounded string lengths, `storageTier == "free_10gb"`, `storageLimitBytes == 10737418240` (10 GB), `0 <= storageUsedBytes <= 10737418240`, and server-verified timestamps (`request.time`).
2. `UserProfile` documents cannot be listed (`allow list: if false`) to prevent PII harvesting or user enumeration.
3. A `UserFileRecord` document at `/users/{userId}/files/{fileId}` belongs strictly to the parent user (`userId == request.auth.uid`), requires `isValidId(userId)` and `isValidId(fileId)` on single-doc operations, enforces `0 <= sizeBytes <= 524288000` (500 MB per file), enforces `resource.data.userId == request.auth.uid` on `list`, verifies parent existence and atomic quota (`getAfter` user `storageUsedBytes <= 10737418240`), and isolates `deleteToken` solely inside the owner's private subcollection.
4. No shadow/ghost fields are accepted on `create` or `update` (`keys().hasOnly(...)` + `affectedKeys().hasOnly(...)`). Optional `hasPassword` (boolean) and `expiresAt` (string <= 64 chars) metadata are strictly type-and-length validated.
5. `createdAt`, `uid`, and `userId` are immutable once created.

## 2. Adversarial Payloads ("Dirty Dozen")
1. Unauthenticated read of `/users/u1` -> PERMISSION_DENIED
2. Cross-user read of `/users/u2` while signed in as `u1` -> PERMISSION_DENIED
3. List query on `/users` -> PERMISSION_DENIED
4. Create `/users/u1` with `uid: "u2"` (identity spoofing) -> PERMISSION_DENIED
5. Create `/users/u1` with forged quota `storageLimitBytes: 999999999999` -> PERMISSION_DENIED
6. Create `/users/u1` with extra ghost field `isAdmin: true` -> PERMISSION_DENIED
7. Create `/users/u1` with client-forged `createdAt` not equal to `request.time` -> PERMISSION_DENIED
8. Update `/users/u1` setting `storageUsedBytes: -1` or above `10737418240` -> PERMISSION_DENIED
9. Cross-user list on `/users/u2/files` while signed in as `u1` -> PERMISSION_DENIED
10. Create `/users/u1/files/bad..id` (invalid path ID) -> PERMISSION_DENIED
11. Create `/users/u1/files/f1` with `sizeBytes: -50` or > 500 MB -> PERMISSION_DENIED
12. Create `/users/u1/files/f1` pushing `users/u1.storageUsedBytes` past `10737418240` -> PERMISSION_DENIED

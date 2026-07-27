-- The production database recorded the vacation seal migration while the
-- roleSnapshotAt column was absent. Reconcile that drift without replacing or
-- deleting any existing request, role snapshot, or Minecraft data.

ALTER TABLE "vacation_requests"
ADD COLUMN IF NOT EXISTS "roleSnapshotAt" TIMESTAMP(3);

UPDATE "vacation_requests"
SET "roleSnapshotAt" = COALESCE("updatedAt", "createdAt", CURRENT_TIMESTAMP)
WHERE "status" IN ('activating', 'active', 'restoring')
  AND "roleSnapshotAt" IS NULL;

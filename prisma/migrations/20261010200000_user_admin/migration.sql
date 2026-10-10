-- Admin-managed accounts: temporary passwords must be changed on first sign-in.
ALTER TABLE "User" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

-- Session expiry is filtered by the retention purge.
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

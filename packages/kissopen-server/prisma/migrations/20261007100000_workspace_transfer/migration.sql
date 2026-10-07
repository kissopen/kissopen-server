CREATE TABLE "CommunityWorkspaceTransfer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "identityId" TEXT NOT NULL,
    "sessionHash" TEXT NOT NULL,
    "recipientKey" TEXT NOT NULL,
    "workspacePublicKey" TEXT,
    "challenge" TEXT NOT NULL,
    "envelope" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "CommunityWorkspaceTransfer_identityId_expiresAt_idx" ON "CommunityWorkspaceTransfer"("identityId", "expiresAt");
CREATE INDEX "CommunityWorkspaceTransfer_sessionHash_idx" ON "CommunityWorkspaceTransfer"("sessionHash");

CREATE TABLE "CommunityIdentity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CommunityIdentity_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CommunityIdentity_provider_subject_key" ON "CommunityIdentity"("provider", "subject");
CREATE TABLE "CommunityOAuthLogin" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "pollTokenHash" TEXT NOT NULL,
    "browserProofHash" TEXT NOT NULL,
    "browserCookieHash" TEXT,
    "verifier" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "challenge" TEXT NOT NULL,
    "identityId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommunityOAuthLogin_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "CommunityIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CommunityOAuthLogin_stateHash_key" ON "CommunityOAuthLogin"("stateHash");
CREATE INDEX "CommunityOAuthLogin_expiresAt_idx" ON "CommunityOAuthLogin"("expiresAt");
CREATE TABLE "CommunityAccountSession" (
    "tokenHash" TEXT NOT NULL PRIMARY KEY,
    "identityId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommunityAccountSession_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "CommunityIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CommunityAccountSession_expiresAt_idx" ON "CommunityAccountSession"("expiresAt");

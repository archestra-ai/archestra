-- Custom SQL migration file, put your code below! --
-- Fix SSO providers that have domain_verified as null or false
-- This is required for account linking to work with non-trusted providers
-- See: https://github.com/better-auth/better-auth/issues/6481
UPDATE sso_provider SET domain_verified = true WHERE domain_verified IS NULL OR domain_verified = false;

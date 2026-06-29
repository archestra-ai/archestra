UPDATE "identity_provider"
SET "oidc_config" = jsonb_set(
  "oidc_config"::jsonb #- '{enterpriseManagedCredentials,providerType}',
  '{enterpriseManagedCredentials,exchangeStrategy}',
  to_jsonb(
    CASE
      WHEN "oidc_config"::jsonb #>> '{enterpriseManagedCredentials,providerType}' = 'okta'
        THEN 'okta_managed'
      WHEN "oidc_config"::jsonb #>> '{enterpriseManagedCredentials,providerType}' = 'keycloak'
        THEN 'rfc8693'
      WHEN "oidc_config"::jsonb #>> '{enterpriseManagedCredentials,providerType}' = 'generic_oidc'
        THEN 'rfc8693'
      ELSE 'rfc8693'
    END
  )::jsonb
)::text
WHERE "oidc_config" IS NOT NULL
  AND "oidc_config"::jsonb -> 'enterpriseManagedCredentials' ? 'providerType';

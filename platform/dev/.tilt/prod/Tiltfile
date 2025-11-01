# Production build resources

# prod bundle
if is_prod:
  local_resource(
    'pnpm-prod',
    cmd='rm -rf frontend/.next && pnpm build',
    serve_cmd='pnpm start',
    labels=['prod'],
    resource_deps=['db-migrate']
  )

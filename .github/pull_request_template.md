## Summary

This PR configures the macOS DMG packaging for Archestra desktop app, enabling creation of disk image installers for distribution.

## Changes

- Added DMG background image for custom installer appearance
- Reorganized app icons from root `assets/` to `assets/icons/` directory for better organization
- Updated forge.config.ts to:
  - Enable MakerDMG with custom background and ULFO compression format
  - Update icon paths to reflect new directory structure
- Updated main.ts icon loading logic to reference new `assets/icons/` path
- Updated package dependencies for DMG maker support

## Testing

- [ ] DMG builds successfully with `pnpm make`
- [ ] Custom background appears correctly in installer
- [ ] App icon displays properly after installation
- [ ] App launches successfully from installed location
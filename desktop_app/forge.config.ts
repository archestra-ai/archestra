import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerZIP } from '@electron-forge/maker-zip';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { PublisherGitHubConfig } from '@electron-forge/publisher-github';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

import config from './src/config';

const {
  build: { productName, description, authors, appBundleId, github },
} = config;

const forgeConfig: ForgeConfig = {
  packagerConfig: {
    /**
     * Whether to package the application's source code into an archive, using Electron's archive format.
     * Reasons why you may want to enable this feature include mitigating issues around long path names on
     * Windows, slightly speeding up require, and concealing your source code from cursory inspection.
     * When the value is true, it passes the default configuration to the asar module
     * https://electron.github.io/packager/main/interfaces/Options.html#asar
     */
    asar: true,
    /**
     * One or more files to be copied directly into the app's Contents/Resources directory for macOS target
     * platforms, and the resources directory for other target platforms. The resources directory can be
     * referenced in the packaged app via the process.resourcesPath value.
     * https://electron.github.io/packager/main/interfaces/Options.html#extraResource
     *
     * IMPORTANT: We only include binaries for the specific platform and architecture being built.
     * This prevents RPM/DEB build failures on Linux where the strip command fails when it
     * encounters binaries from different architectures. It also reduces the final package size
     * by not including unnecessary binaries for other platforms.
     */
    extraResource:
      process.platform === 'darwin'
        ? [`./resources/bin/mac/${process.arch === 'x64' ? 'x86_64' : process.arch}`]
        : process.platform === 'win32'
          ? [`./resources/bin/windows/${process.arch === 'x64' ? 'x86_64' : process.arch}`]
          : [`./resources/bin/linux/${process.arch === 'x64' ? 'x86_64' : process.arch}`],
    icon: './icons/icon',
    name: productName,
    appBundleId,

    /**
     * Only enable signing/notarization in CI or when explicitly requested
     *
     * For the full list of configuration options for `osxSign`, see the following resources:
     * https://js.electronforge.io/modules/_electron_forge_shared_types.InternalOptions.html#OsxSignOptions
     * https://github.com/electron/osx-sign
     *
     * A common use case for modifying the default osxSign configuration is to customize its entitlements.
     * In macOS, entitlements are privileges that grant apps certain capabilities (e.g. access to the camera, microphone, or USB devices).
     * These are stored within the code signature in an app's executable file.
     *
     * By default, the @electron/osx-sign tool comes with a set of entitlements that should work on both MAS or direct
     * distribution targets. See the complete set of default entitlement files here👇
     * https://github.com/electron/osx-sign/tree/main/entitlements
     * https://developer.apple.com/documentation/bundleresources/entitlements
     * https://developer.apple.com/documentation/security/hardened_runtime
     */
    ...(process.env.APPLE_ID && process.env.APPLE_PASSWORD && process.env.APPLE_TEAM_ID
      ? {
          osxSign: {},
          /**
           * We are currently using the "app-specific password" method for "notarizing" the macOS app
           *
           * https://www.electronforge.io/guides/code-signing/code-signing-macos#option-1-using-an-app-specific-password
           */
          osxNotarize: {
            /**
             * Apple ID associated with your Apple Developer account
             * (aka the email address you used to create your Apple account)
             */
            appleId: process.env.APPLE_ID,
            /**
             * App-specific password
             *
             * Was generated following the instructions here https://support.apple.com/en-us/102654
             */
            appleIdPassword: process.env.APPLE_PASSWORD,
            /**
             * The Apple Team ID you want to notarize under. You can find Team IDs for team you belong to by going to
             * https://developer.apple.com/account/#/membership
             */
            teamId: process.env.APPLE_TEAM_ID,
          },
        }
      : {
          /**
           * Explicitly disable signing when credentials are not available (e.g., for PRs from forks)
           * This prevents the default ad-hoc signing that causes failures
           *
           * By not setting osxSign at all (undefined), Electron Packager skips signing entirely
           */
          osxSign: undefined,
        }),
  },
  // https://github.com/WiseLibs/better-sqlite3/issues/1171#issuecomment-2186895668
  rebuildConfig: {
    extraModules: ['better-sqlite3'],
    force: true,
  },
  makers: [
    /**
     * TODO: Re-enable Squirrel for Windows once we have proper code signing setup
     * For now, just create ZIP files for Windows to avoid build failures
     */
    // new MakerSquirrel({
    //   name: productName,
    //   authors,
    //   description,
    //   setupIcon: './icons/icon.ico',
    // }),
    /**
     * ZIP for macOS and Windows
     */
    new MakerZIP({}, ['darwin', 'win32']),
    new MakerRpm({
      options: {
        name: productName,
        productName,
        description,
      },
    }),
    new MakerDeb({
      options: {
        name: productName,
        productName,
        description,
      },
    }),
  ],
  plugins: [
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        {
          // Server process entry point - built separately from main process
          // This creates server-process.js that runs our Fastify server
          // in an isolated Node.js process (not Electron)
          entry: 'src/server-process.ts',
          config: 'vite.server.config.ts',
          target: 'main',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.mts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        repository: {
          owner: github.owner,
          name: github.repoName,
        },

        /**
         * The desktop app release-please generated GitHub releases have a tag prefix of `desktop_app-v<version>`,
         * so we need to match that here.
         *
         * Otherwise, the electron-forge publisher will try to create a release with a tag of `v<version>` and the
         * build assets will not get attached to the proper GitHub Release.
         *
         * The alternative is to set "include-component-in-tag" to "false" in the release-please config
         * (specifically for the "desktop_app" 'component') but there is a bug that we ran into with release-please
         * that was causing issues (https://github.com/googleapis/release-please/issues/2214)
         */
        tagPrefix: 'desktop_app-v',
        prerelease: true,
        draft: false,
      } as PublisherGitHubConfig,
    },
  ],
};

export default forgeConfig;

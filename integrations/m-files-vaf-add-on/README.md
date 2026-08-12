# Archestra VAF Add On

The GA add-on v1.0 is the server-side half of the Archestra M-Files knowledge connector. MFWS continues to carry object metadata and file content. This VAF application exposes only the vault operations needed for complete enumeration, durable content/security deltas, exact effective read audiences, and group membership.

- Extension method: `ArchestraKnowledgePermissionSnapshot`
- Wire schema: `2`
- Minimum declared M-Files version: `25.3`
- Compatibility build target: `26.6.16115.13`

The public architecture and operations guide is [M-Files Connector Engineering Guide](../../docs/pages/platform-mfiles-connector.md).

## Security model

- M-Files is the sole authentication and authorization layer: every operation requires `MFVaultAccessChangeFullControlRole`, enforced by the server before the add-on runs. The connector identity must hold that administrative access; the add-on keeps no caller state of its own.
- JSON uses opt-in fields and rejects unknown members, operations, schema versions, malformed cursors, duplicate keys, and out-of-range limits.
- Request bodies are limited to 64 KiB; object/group batches are limited to 250 and object-type sets to 32.
- Only managed object types are accepted. External-repository object types fail preflight.
- Effective users are calculated at the exact requested object versions. Active permission components restrict one another; explicit denies remove principals; nested groups and supported pseudo-users are expanded.
- Latest and cached-version audiences are intersected. Any missing component, identity, group, historical version, cycle, or COM error returns an empty, `audienceResolutionFailed` result.
- Disabled users are omitted. Login email can be null so Archestra can apply a manual account-ID mapping; if neither exists, Archestra fails the entire object audience closed.
- `isPublic` is always false. The add-on never converts a vault-wide principal into access for users who are not represented in the vault.
- The add-on returns no file content, arbitrary object metadata, secrets, or ACL diagnostics.

## Build

A pre-built `Archestra.MFiles.VAFAddOn.mfappx` is attached to every
platform release by `.github/workflows/build-m-files-vaf-add-on.yml`: a
plain `dotnet build -c Release` of this project on a Windows runner, using
the official M-Files VAF project packaging (the MSBuild target below zips
the build output into the `.mfappx`, exactly as the `MFiles.ProjectTemplates`
template does) with all M-Files assemblies coming from the MIT-licensed
`MFiles.VAF` NuGet package.

The guided path for operators is `install-m-files-vaf-add-on.ps1`, served by the
platform at `/scripts/install-m-files-vaf-add-on.ps1` and linked from the M-Files
connector create/edit form (source: `platform/frontend/public/scripts/`). It
downloads the pre-built package (or builds from source with
`-BuildFromSource`) and installs it into the vault over the COM API. The
manual steps below remain for development, per-version certification, and
troubleshooting.

Build on Windows with M-Files Server or Server Tools installed. Compile against the same installation used by the target server:

```powershell
./build-package.ps1 -Configuration Release
```

To select a side-by-side version explicitly:

```powershell
./build-package.ps1 `
  -Configuration Release `
  -MFilesInstallDirectory "C:\Program Files\M-Files\26.6.16115.13"
```

The builder invokes the installed .NET Framework compiler and exact M-Files assemblies, then produces:

```text
bin/Release/net472/Archestra.MFiles.VAFAddOn.mfappx
```

The package includes the application assembly, `appdef.xml`, M-Files VAF/configuration/COM interop assemblies, and Newtonsoft.Json. The SDK-style project remains available for IDE/static analysis.

## Install and preflight

1. Open M-Files Admin and connect to the server.
2. Expand **Document Vaults**, right-click the target vault, and open **Applications**.
3. Install the generated `.mfappx` and restart the vault when prompted.
4. Give the connector identity the **Change full control of vault** administrative access; M-Files enforces it on every extension-method call.
5. Authenticate as the connector identity and preflight:

```http
POST /REST/vault/extensionmethod/ArchestraKnowledgePermissionSnapshot
Content-Type: text/plain; charset=utf-8
X-Authentication: <connector-token>

{"schemaVersion":2,"operation":"getCapabilities"}
```

Verify `vaultGuid`, `callerUserId`, `addOnVersion`, `addOnInstanceId`, journal bounds, and all advertised capabilities.

## Operations

| Operation | Bounds | Result |
| --- | --- | --- |
| `getCapabilities` | none | instance, vault, caller, journal bounds, flags, permission-policy fingerprint |
| `readChanges` | limit 1-250, cursor, optional pinned head | ordered change records or explicit full-required reason |
| `enumerateObjects` | 1-32 object types, limit 1-250 | stable object keys and latest versions |
| `getObjectPermissionsByKeys` | 1-250 unique keys and cached version arrays | latest-plus-cached effective audiences |
| `listGroups` | full cursor page or at most 250 exact group IDs | stable IDs, names, flattened membership, resolution status |

Object changes, deletions, permission changes, group changes, and identity changes are journaled in vault admin named-value storage. The add-on retains 20,000 events. Head/event writes use compare-and-swap; readers pin the head across pages. A retention gap, missing/invalid entry, or invalid cursor returns `fullRequired` instead of a partial delta.

Object enumeration recursively bisects object-ID ranges whenever M-Files reports truncation. A truncated single-ID range aborts rather than omitting content.

## Upgrade and recovery

- Back up the vault according to the normal M-Files procedure before upgrading an application.
- Build the package against the target M-Files assemblies and compile it before installation.
- Reinstalling with a new add-on instance makes Archestra run an authoritative baseline/full permission reconcile.
- Do not edit journal named values manually. If storage is damaged, reinstall/upgrade the add-on and allow Archestra to rebuild.
- A group event is journaled with its stable group ID. Login/user-account changes emit a global security event because they can affect direct principals and many group results.
- If an event cannot be journaled, the handler throws. Investigate the M-Files application log and named-value storage health before retrying the source operation.

## Release verification

For every supported M-Files release:

1. compile against its exact assemblies;
2. install/upgrade and restart the fixture vault;
3. preflight the connector identity;
4. run a multi-page baseline and two clean delta passes;
5. verify object create/update/file removal/delete;
6. verify direct grant/revoke, explicit deny, automatic components, historical-version intersection, group create/rename/delete, and membership changes;
7. verify ordinary allow and deny users through Archestra retrieval;
8. verify a journal gap promotes a full rebuild and never commits a partial cursor.

M-Files Cloud uses the same schema-v2 contract, but live Cloud deployment certification is tracked separately from the Windows/IIS compatibility fixture.

The 2026-08-11 compatibility run built and installed this package against M-Files Community Edition `26.6.16115.13` on Windows 11 Pro with IIS Classic Web. Schema/caller preflight, a 267-object full permission pass, two zero-work clean deltas, named and nested groups, direct allow, explicit deny, ordinary-user query visibility, and a reversible one-object journal delta all passed. The source fixture was restored after the mutation. OAuth Application Accounts and M-Files Cloud are regression-tested/prepared respectively, but still require live Cloud certification.

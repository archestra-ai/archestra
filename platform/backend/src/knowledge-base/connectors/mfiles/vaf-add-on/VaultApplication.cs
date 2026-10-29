using System;
using MFiles.VAF;
using MFiles.VAF.Common;
using MFilesAPI;
using Newtonsoft.Json;

namespace Archestra.MFiles.VAFAddOn
{
    public sealed class VaultApplication : VaultApplicationBase, IUsesVaultExtensionMethods
    {
        private const int MaximumInputLength = 65536;

        [VaultExtensionMethod(
            "ArchestraKnowledgePermissionSnapshot",
            RequiredVaultAccess = MFVaultAccess.MFVaultAccessChangeFullControlRole)]
        private string PermissionSnapshot(EventHandlerEnvironment environment)
        {
            if (environment == null || environment.Vault == null)
                throw new InvalidOperationException("A vault session is required.");
            if (environment.Input == null || environment.Input.Length == 0)
                throw new ArgumentException("The request body is required.");
            if (environment.Input.Length > MaximumInputLength)
                throw new ArgumentException("The request body is too large.");

            var request = JsonConvert.DeserializeObject<AddOnRequest>(
                environment.Input,
                JsonSettings.Input);
            if (request == null)
                throw new ArgumentException("The request body is invalid.");
            if (request.SchemaVersion != PermissionSnapshotService.SchemaVersion)
                throw new ArgumentException("The schema version is not supported.");

            var journal = new ChangeJournal(environment.Vault);
            var service = new PermissionSnapshotService(environment.Vault);
            object response;
            switch (request.Operation)
            {
                case "getCapabilities":
                    response = service.GetCapabilities(journal, environment.CurrentUserID);
                    break;
                case "readChanges":
                    response = journal.ReadChanges(
                        request,
                        service.GetPermissionPolicyFingerprint());
                    break;
                case "enumerateObjects":
                    response = service.EnumerateObjects(request);
                    break;
                case "getObjectPermissionsByKeys":
                    response = service.GetObjectPermissionsByKeys(request);
                    break;
                case "listGroups":
                    response = service.ListGroups(request);
                    break;
                default:
                    throw new ArgumentException("The requested operation is not supported.");
            }

            return JsonConvert.SerializeObject(response, JsonSettings.Output);
        }

        [EventHandler(MFEventHandlerType.MFEventHandlerAfterCreateNewObjectFinalize)]
        [EventHandler(MFEventHandlerType.MFEventHandlerAfterCheckInChangesFinalize)]
        [EventHandler(MFEventHandlerType.MFEventHandlerAfterSetProperties)]
        [EventHandler(MFEventHandlerType.MFEventHandlerAfterUndeleteObjectFinalize)]
        public void JournalObjectUpsert(EventHandlerEnvironment environment)
        {
            AppendObject(environment, "object-upsert");
        }

        [EventHandler(MFEventHandlerType.MFEventHandlerAfterSetObjectPermissions)]
        public void JournalObjectPermission(EventHandlerEnvironment environment)
        {
            AppendObject(environment, "object-permission");
        }

        [EventHandler(MFEventHandlerType.MFEventHandlerAfterDeleteObject)]
        [EventHandler(MFEventHandlerType.MFEventHandlerAfterDestroyObject)]
        public void JournalObjectDelete(EventHandlerEnvironment environment)
        {
            AppendObject(environment, "object-delete");
        }

        [EventHandler(MFEventHandlerType.MFEventHandlerAfterCreateLoginAccount)]
        [EventHandler(MFEventHandlerType.MFEventHandlerAfterModifyLoginAccount)]
        [EventHandler(MFEventHandlerType.MFEventHandlerAfterRemoveLoginAccount)]
        [EventHandler(MFEventHandlerType.MFEventHandlerAfterCreateUserAccount)]
        [EventHandler(MFEventHandlerType.MFEventHandlerAfterModifyUserAccount)]
        [EventHandler(MFEventHandlerType.MFEventHandlerAfterRemoveUserAccount)]
        public void JournalGlobalSecurityChange(EventHandlerEnvironment environment)
        {
            if (environment == null || environment.Vault == null)
                throw new InvalidOperationException("A transactional vault session is required.");
            new ChangeJournal(environment.Vault).Append("security-full", null, null, null);
        }

        [EventHandler(MFEventHandlerType.MFEventHandlerAfterCreateUserGroup)]
        [EventHandler(MFEventHandlerType.MFEventHandlerAfterModifyUserGroup)]
        public void JournalGroupUpsert(EventHandlerEnvironment environment)
        {
            AppendGroup(environment, "group-upsert");
        }

        [EventHandler(MFEventHandlerType.MFEventHandlerAfterRemoveUserGroup)]
        public void JournalGroupDelete(EventHandlerEnvironment environment)
        {
            AppendGroup(environment, "group-delete");
        }

        private static void AppendObject(EventHandlerEnvironment environment, string kind)
        {
            if (environment == null || environment.Vault == null || environment.ObjVer == null)
                throw new InvalidOperationException("An object event context is required.");
            new ChangeJournal(environment.Vault).Append(
                kind,
                environment.ObjVer.Type,
                environment.ObjVer.ID,
                null);
        }

        private static void AppendGroup(EventHandlerEnvironment environment, string kind)
        {
            if (environment == null || environment.Vault == null)
                throw new InvalidOperationException("A group event context is required.");
            if (environment.GroupID < 0)
                throw new InvalidOperationException("The group event did not include a valid group ID.");
            new ChangeJournal(environment.Vault).Append(
                kind,
                null,
                null,
                environment.GroupID);
        }
    }
}

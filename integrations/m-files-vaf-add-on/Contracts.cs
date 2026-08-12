using System.Collections.Generic;
using Newtonsoft.Json;

namespace Archestra.MFiles.VAFAddOn
{
    [JsonObject(MemberSerialization.OptIn)]
    internal sealed class AddOnRequest
    {
        [JsonProperty("schemaVersion", Required = Required.Always)]
        public int SchemaVersion { get; set; }

        [JsonProperty("operation", Required = Required.Always)]
        public string Operation { get; set; }

        [JsonProperty("cursor", Required = Required.Default)]
        public string Cursor { get; set; }

        [JsonProperty("pinnedHeadCursor", Required = Required.Default)]
        public string PinnedHeadCursor { get; set; }

        [JsonProperty("limit", Required = Required.Default)]
        public int Limit { get; set; }

        [JsonProperty("objectTypeIds", Required = Required.Default)]
        public int[] ObjectTypeIds { get; set; }

        [JsonProperty("objects", Required = Required.Default)]
        public ObjectPermissionRequest[] Objects { get; set; }

        [JsonProperty("groupIds", Required = Required.Default)]
        public int[] GroupIds { get; set; }
    }

    [JsonObject(MemberSerialization.OptIn)]
    internal sealed class CapabilitiesResponse
    {
        [JsonProperty("schemaVersion", Required = Required.Always)]
        public int SchemaVersion { get; set; }

        [JsonProperty("addOnVersion", Required = Required.Always)]
        public string AddOnVersion { get; set; }

        [JsonProperty("addOnInstanceId", Required = Required.Always)]
        public string AddOnInstanceId { get; set; }

        [JsonProperty("vaultGuid", Required = Required.Always)]
        public string VaultGuid { get; set; }

        [JsonProperty("callerUserId", Required = Required.Always)]
        public int CallerUserId { get; set; }

        [JsonProperty("journal", Required = Required.Always)]
        public JournalPosition Journal { get; set; }

        [JsonProperty("capabilities", Required = Required.Always)]
        public AddOnCapabilities Capabilities { get; set; }

        [JsonProperty("permissionPolicyFingerprint", Required = Required.Always)]
        public string PermissionPolicyFingerprint { get; set; }
    }

    [JsonObject(MemberSerialization.OptIn)]
    internal sealed class AddOnCapabilities
    {
        [JsonProperty("contentDelta", Required = Required.Always)]
        public bool ContentDelta { get; set; }

        [JsonProperty("permissionDelta", Required = Required.Always)]
        public bool PermissionDelta { get; set; }

        [JsonProperty("groupDelta", Required = Required.Always)]
        public bool GroupDelta { get; set; }

        [JsonProperty("managedObjectsOnly", Required = Required.Always)]
        public bool ManagedObjectsOnly { get; set; }
    }

    [JsonObject(MemberSerialization.OptIn)]
    internal sealed class JournalPosition
    {
        [JsonProperty("headCursor", Required = Required.Always)]
        public string HeadCursor { get; set; }

        [JsonProperty("floorCursor", Required = Required.Always)]
        public string FloorCursor { get; set; }
    }

    [JsonObject(MemberSerialization.OptIn)]
    internal sealed class ChangePage
    {
        [JsonProperty("schemaVersion", Required = Required.Always)]
        public int SchemaVersion { get; set; }

        [JsonProperty("addOnInstanceId", Required = Required.Always)]
        public string AddOnInstanceId { get; set; }

        [JsonProperty("nextCursor", Required = Required.Always)]
        public string NextCursor { get; set; }

        [JsonProperty("pinnedHeadCursor", Required = Required.Always)]
        public string PinnedHeadCursor { get; set; }

        [JsonProperty("hasMore", Required = Required.Always)]
        public bool HasMore { get; set; }

        [JsonProperty("fullRequired", Required = Required.Always)]
        public ChangeFullRequired FullRequired { get; set; }

        [JsonProperty("changes", Required = Required.Always)]
        public IList<ChangeItem> Changes { get; set; }

        [JsonProperty("permissionPolicyFingerprint", Required = Required.Always)]
        public string PermissionPolicyFingerprint { get; set; }
    }

    [JsonObject(MemberSerialization.OptIn)]
    internal sealed class ChangeFullRequired
    {
        [JsonProperty("content", Required = Required.Always)]
        public bool Content { get; set; }

        [JsonProperty("permissions", Required = Required.Always)]
        public bool Permissions { get; set; }

        [JsonProperty("groups", Required = Required.Always)]
        public bool Groups { get; set; }

        [JsonProperty("reasons", Required = Required.Always)]
        public IList<string> Reasons { get; set; }
    }

    [JsonObject(MemberSerialization.OptIn)]
    internal sealed class ChangeItem
    {
        [JsonProperty("sequence", Required = Required.Always)]
        public string Sequence { get; set; }

        [JsonProperty("kind", Required = Required.Always)]
        public string Kind { get; set; }

        [JsonProperty("objectTypeId", Required = Required.Default)]
        public int? ObjectTypeId { get; set; }

        [JsonProperty("objectId", Required = Required.Default)]
        public int? ObjectId { get; set; }

        [JsonProperty("groupId", Required = Required.Default)]
        public int? GroupId { get; set; }
    }

    [JsonObject(MemberSerialization.OptIn)]
    internal sealed class ObjectPage
    {
        [JsonProperty("schemaVersion", Required = Required.Always)]
        public int SchemaVersion { get; set; }

        [JsonProperty("items", Required = Required.Always)]
        public IList<ObjectItem> Items { get; set; }

        [JsonProperty("nextCursor", Required = Required.AllowNull)]
        public string NextCursor { get; set; }
    }

    [JsonObject(MemberSerialization.OptIn)]
    internal sealed class ObjectItem
    {
        [JsonProperty("objectTypeId", Required = Required.Always)]
        public int ObjectTypeId { get; set; }

        [JsonProperty("objectId", Required = Required.Always)]
        public int ObjectId { get; set; }

        [JsonProperty("latestVersion", Required = Required.Always)]
        public int LatestVersion { get; set; }
    }

    [JsonObject(MemberSerialization.OptIn)]
    internal sealed class ObjectPermissionRequest
    {
        [JsonProperty("objectTypeId", Required = Required.Always)]
        public int ObjectTypeId { get; set; }

        [JsonProperty("objectId", Required = Required.Always)]
        public int ObjectId { get; set; }

        [JsonProperty("cachedVersions", Required = Required.Always)]
        public int[] CachedVersions { get; set; }
    }

    [JsonObject(MemberSerialization.OptIn)]
    internal sealed class PermissionPage
    {
        [JsonProperty("schemaVersion", Required = Required.Always)]
        public int SchemaVersion { get; set; }

        [JsonProperty("items", Required = Required.Always)]
        public IList<PermissionItem> Items { get; set; }
    }

    [JsonObject(MemberSerialization.OptIn)]
    internal sealed class PermissionItem
    {
        [JsonProperty("objectTypeId", Required = Required.Always)]
        public int ObjectTypeId { get; set; }

        [JsonProperty("objectId", Required = Required.Always)]
        public int ObjectId { get; set; }

        [JsonProperty("latestVersion", Required = Required.Default)]
        public int? LatestVersion { get; set; }

        [JsonProperty("state", Required = Required.Always)]
        public string State { get; set; }

        [JsonProperty("users", Required = Required.Always)]
        public IList<UserPrincipal> Users { get; set; }

        [JsonProperty("groups", Required = Required.Always)]
        public IList<string> Groups { get; set; }

        [JsonProperty("isPublic", Required = Required.Always)]
        public bool IsPublic { get; set; }

        [JsonProperty("fingerprint", Required = Required.Always)]
        public string Fingerprint { get; set; }

        [JsonProperty("audienceResolutionFailed", Required = Required.Always)]
        public bool AudienceResolutionFailed { get; set; }
    }

    [JsonObject(MemberSerialization.OptIn)]
    internal sealed class UserPrincipal
    {
        [JsonProperty("accountId", Required = Required.Always)]
        public string AccountId { get; set; }

        [JsonProperty("email", Required = Required.AllowNull)]
        public string Email { get; set; }
    }

    [JsonObject(MemberSerialization.OptIn)]
    internal sealed class GroupPage
    {
        [JsonProperty("schemaVersion", Required = Required.Always)]
        public int SchemaVersion { get; set; }

        [JsonProperty("groups", Required = Required.Always)]
        public IList<GroupItem> Groups { get; set; }

        [JsonProperty("nextCursor", Required = Required.AllowNull)]
        public string NextCursor { get; set; }
    }

    [JsonObject(MemberSerialization.OptIn)]
    internal sealed class GroupItem
    {
        [JsonProperty("groupId", Required = Required.Always)]
        public string GroupId { get; set; }

        [JsonProperty("name", Required = Required.AllowNull)]
        public string Name { get; set; }

        [JsonProperty("members", Required = Required.Always)]
        public IList<GroupMember> Members { get; set; }

        [JsonProperty("membershipResolutionFailed", Required = Required.Always)]
        public bool MembershipResolutionFailed { get; set; }
    }

    [JsonObject(MemberSerialization.OptIn)]
    internal sealed class GroupMember
    {
        [JsonProperty("accountId", Required = Required.Always)]
        public string AccountId { get; set; }

        [JsonProperty("displayName", Required = Required.AllowNull)]
        public string DisplayName { get; set; }

        [JsonProperty("email", Required = Required.AllowNull)]
        public string Email { get; set; }

        [JsonProperty("accountType", Required = Required.AllowNull)]
        public string AccountType { get; set; }
    }

    internal static class JsonSettings
    {
        internal static readonly JsonSerializerSettings Input =
            new JsonSerializerSettings
            {
                MissingMemberHandling = MissingMemberHandling.Error,
                DateParseHandling = DateParseHandling.None,
                MaxDepth = 24
            };

        internal static readonly JsonSerializerSettings Output =
            new JsonSerializerSettings
            {
                Formatting = Formatting.None,
                NullValueHandling = NullValueHandling.Include
            };
    }
}

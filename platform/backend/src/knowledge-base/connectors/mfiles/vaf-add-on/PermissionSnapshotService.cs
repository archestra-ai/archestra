using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Mail;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using MFilesAPI;

namespace Archestra.MFiles.VAFAddOn
{
    internal sealed class PermissionSnapshotService
    {
        internal const int SchemaVersion = 2;
        internal const string AddOnVersion = "1.0.0";
        private const int MaximumPageSize = 250;
        private const int MaximumObjectTypes = 32;
        private const int MaximumExactObjects = 250;
        private static readonly Regex ObjectCursorPattern = new Regex(
            "^object:[0-9]{10}:[0-9]{20}$",
            RegexOptions.CultureInvariant);
        private static readonly Regex GroupCursorPattern = new Regex(
            "^[0-9]+$",
            RegexOptions.CultureInvariant);

        private readonly Vault vault;

        internal PermissionSnapshotService(Vault vault)
        {
            this.vault = vault;
        }

        internal CapabilitiesResponse GetCapabilities(ChangeJournal journal, int callerUserId)
        {
            var position = journal.GetPosition();
            return new CapabilitiesResponse
            {
                SchemaVersion = SchemaVersion,
                AddOnVersion = AddOnVersion,
                AddOnInstanceId = position.InstanceId,
                VaultGuid = vault.GetGUID(),
                CallerUserId = callerUserId,
                Journal = new JournalPosition
                {
                    HeadCursor = position.Head.ToString(CultureInfo.InvariantCulture),
                    FloorCursor = position.Floor.ToString(CultureInfo.InvariantCulture)
                },
                Capabilities = new AddOnCapabilities
                {
                    ContentDelta = true,
                    PermissionDelta = true,
                    GroupDelta = true,
                    ManagedObjectsOnly = true
                },
                PermissionPolicyFingerprint = GetPermissionPolicyFingerprint()
            };
        }

        internal ObjectPage EnumerateObjects(AddOnRequest request)
        {
            ValidateCommonRequest(request, true);
            var objectTypeIds = ValidateObjectTypes(request.ObjectTypeIds);
            int cursorType;
            int cursorId;
            ParseObjectCursor(request.Cursor, out cursorType, out cursorId);

            var candidates = new List<ObjectVersion>();
            foreach (var objectTypeId in objectTypeIds)
            {
                if (request.Cursor != null && objectTypeId < cursorType)
                    continue;
                var low = request.Cursor != null && objectTypeId == cursorType
                    ? cursorId
                    : 0;
                CollectRange(objectTypeId, low, int.MaxValue, request.Limit + 1, candidates);
                if (candidates.Count >= request.Limit + 1)
                    break;
            }

            candidates.Sort(CompareObjects);
            var page = candidates.Take(request.Limit).ToList();
            return new ObjectPage
            {
                SchemaVersion = SchemaVersion,
                Items = page.Select(item => new ObjectItem
                {
                    ObjectTypeId = item.ObjVer.Type,
                    ObjectId = item.ObjVer.ID,
                    LatestVersion = item.ObjVer.Version
                }).ToList(),
                NextCursor = candidates.Count > request.Limit
                    ? BuildObjectCursor(
                        candidates[request.Limit].ObjVer.Type,
                        candidates[request.Limit].ObjVer.ID)
                    : null
            };
        }

        internal PermissionPage GetObjectPermissionsByKeys(AddOnRequest request)
        {
            ValidateSchema(request);
            if (request.Objects == null || request.Objects.Length == 0)
                throw new ArgumentException("At least one object is required.");
            if (request.Objects.Length > MaximumExactObjects)
                throw new ArgumentException("At most 250 objects can be requested.");
            var duplicate = request.Objects
                .GroupBy(item => item.ObjectTypeId + ":" + item.ObjectId)
                .Any(group => group.Count() > 1);
            if (duplicate)
                throw new ArgumentException("Object keys must be unique.");

            return new PermissionPage
            {
                SchemaVersion = SchemaVersion,
                Items = request.Objects
                    .OrderBy(item => item.ObjectTypeId)
                    .ThenBy(item => item.ObjectId)
                    .Select(BuildPermissionItem)
                    .ToList()
            };
        }

        internal GroupPage ListGroups(AddOnRequest request)
        {
            ValidateCommonRequest(request, request.GroupIds == null);
            if (request.Cursor != null && !GroupCursorPattern.IsMatch(request.Cursor))
                throw new ArgumentException("The group cursor is invalid.");

            var groupsById = ReadGroupsById();
            var usersById = ReadUsersById();
            IEnumerable<UserGroup> eligibleGroups;
            if (request.GroupIds != null)
            {
                if (request.GroupIds.Length > MaximumPageSize)
                    throw new ArgumentException("At most 250 group IDs can be requested.");
                if (request.GroupIds.Any(id => id < 0) ||
                    request.GroupIds.Distinct().Count() != request.GroupIds.Length)
                    throw new ArgumentException("Group IDs must be unique and non-negative.");
                eligibleGroups = request.GroupIds
                    .Where(groupsById.ContainsKey)
                    .Select(id => groupsById[id]);
            }
            else
            {
                eligibleGroups = groupsById.Values.Where(group =>
                    request.Cursor == null ||
                    string.CompareOrdinal(
                        group.ID.ToString(CultureInfo.InvariantCulture),
                        request.Cursor) >= 0);
            }

            var ordered = eligibleGroups
                .OrderBy(group => group.ID.ToString(CultureInfo.InvariantCulture), StringComparer.Ordinal)
                .ToList();
            var pageGroups = ordered.Take(request.Limit).ToList();
            var output = pageGroups
                .Select(group => BuildGroup(group, groupsById, usersById))
                .ToList();
            return new GroupPage
            {
                SchemaVersion = SchemaVersion,
                Groups = output,
                NextCursor = request.GroupIds == null && ordered.Count > request.Limit
                    ? ordered[request.Limit].ID.ToString(CultureInfo.InvariantCulture)
                    : null
            };
        }

        internal string GetPermissionPolicyFingerprint()
        {
            return "metadata-structure:" +
                vault.GetMetadataStructureVersionID().ToString(CultureInfo.InvariantCulture);
        }

        private PermissionItem BuildPermissionItem(ObjectPermissionRequest request)
        {
            if (request.ObjectTypeId < 0 || request.ObjectId < 0)
                throw new ArgumentException("Object keys must be non-negative.");
            if (request.CachedVersions == null)
                throw new ArgumentException("cachedVersions is required for every object.");
            if (request.CachedVersions.Any(version => version < 1))
                throw new ArgumentException("Cached object versions must be positive.");

            ObjVer latest;
            try
            {
                var objectId = new ObjID();
                objectId.SetIDs(request.ObjectTypeId, request.ObjectId);
                latest = vault.ObjectOperations.GetLatestObjVer(objectId, false, true);
            }
            catch
            {
                // The object cannot be located at all — destroyed, deleted, or
                // otherwise not readable. Report it missing with an empty
                // audience; the journal drives deletion. This is deliberately
                // distinct from an ACL that exists but cannot be resolved
                // (below), which is a fault worth surfacing rather than hiding.
                return BuildFailedPermission(request, null, "missing");
            }

            try
            {
                SortedSet<int> effectiveUsers = null;
                var versions = request.CachedVersions
                    .Concat(new[] { latest.Version })
                    .Distinct()
                    .OrderBy(version => version);
                foreach (var version in versions)
                {
                    var objVer = new ObjVer();
                    objVer.SetIDs(request.ObjectTypeId, request.ObjectId, version);
                    var atVersion = ResolveEffectiveUsers(objVer);
                    if (atVersion.ResolutionFailed)
                        return BuildFailedPermission(request, latest.Version, "unreadable");
                    if (effectiveUsers == null)
                        effectiveUsers = atVersion.UserIds;
                    else
                        effectiveUsers.IntersectWith(atVersion.UserIds);
                }

                effectiveUsers = effectiveUsers ?? new SortedSet<int>();
                var principals = new List<UserPrincipal>();
                foreach (var userId in effectiveUsers)
                {
                    try
                    {
                        var user = vault.UserOperations.GetUserAccount(userId);
                        if (!user.Enabled)
                            continue;
                        var login = vault.UserOperations.GetLoginAccountOfUser(userId);
                        var email = NormalizeEmail(login.EmailAddress);
                        principals.Add(new UserPrincipal
                        {
                            AccountId = userId.ToString(CultureInfo.InvariantCulture),
                            Email = email
                        });
                    }
                    catch
                    {
                        // A read-principal we cannot expand to a concrete
                        // account is dropped, not allowed to fail the whole
                        // object closed. It came from the allow set after denies
                        // were applied, so dropping it only narrows the audience.
                        continue;
                    }
                }

                return new PermissionItem
                {
                    ObjectTypeId = request.ObjectTypeId,
                    ObjectId = request.ObjectId,
                    LatestVersion = latest.Version,
                    State = "active",
                    Users = principals,
                    Groups = new List<string>(),
                    IsPublic = false,
                    Fingerprint = BuildFingerprint(principals, false),
                    AudienceResolutionFailed = false
                };
            }
            catch
            {
                // The object exists but its ACL could not be resolved. Surface
                // it as a real fault (fail-closed, empty audience) instead of
                // masking a live object as deleted.
                return BuildFailedPermission(request, latest.Version, "unreadable");
            }
        }

        private PermissionItem BuildFailedPermission(
            ObjectPermissionRequest request,
            int? latestVersion,
            string state)
        {
            return new PermissionItem
            {
                ObjectTypeId = request.ObjectTypeId,
                ObjectId = request.ObjectId,
                LatestVersion = latestVersion,
                State = state,
                Users = new List<UserPrincipal>(),
                Groups = new List<string>(),
                IsPublic = false,
                Fingerprint = BuildFingerprint(new List<UserPrincipal>(), true),
                AudienceResolutionFailed = true
            };
        }

        private ResolvedAudience ResolveEffectiveUsers(ObjVer objVer)
        {
            var permissions = vault.ObjectOperations.GetObjectPermissions(objVer);
            SortedSet<int> effective = null;
            var components = new List<AccessControlListComponent>();
            if (permissions.AccessControlList.CustomComponent != null &&
                permissions.AccessControlList.CustomComponent.IsActive)
                components.Add(permissions.AccessControlList.CustomComponent);
            var automatic = permissions.AccessControlList.AutomaticComponents;
            var componentKeys = automatic.GetKeys();
            for (var index = 1; index <= componentKeys.Count; index++)
            {
                var component = automatic.At(componentKeys[index]);
                if (component != null && component.IsActive)
                    components.Add(component);
            }

            foreach (var component in components)
            {
                var audience = ResolveComponent(component);
                if (audience.ResolutionFailed)
                    return audience;
                if (effective == null)
                    effective = audience.UserIds;
                else
                    effective.IntersectWith(audience.UserIds);
            }
            return new ResolvedAudience
            {
                UserIds = effective ?? new SortedSet<int>(),
                ResolutionFailed = false
            };
        }

        private ResolvedAudience ResolveComponent(AccessControlListComponent component)
        {
            var allowed = new SortedSet<int>();
            var denied = new SortedSet<int>();
            var groupsById = ReadGroupsById();
            var entries = component.AccessControlEntries;
            var keys = entries.GetKeysWithPseudoUserDefinitions();
            for (var index = 1; index <= keys.Count; index++)
            {
                var key = keys[index];
                // Resolve each entry defensively. A grantee we cannot expand —
                // an unsupported pseudo-user, an unreadable group, a COM error —
                // must not sink the whole object: for an Allow we drop it
                // (under-granting only ever narrows who can read, never widens
                // it), and only for a Deny do we fail closed, because a Deny we
                // cannot apply could leave a principal readable that the source
                // denies (an over-grant).
                var isDeny = false;
                var resolved = true;
                try
                {
                    var permission = entries.At(key).ReadPermission;
                    if (permission != MFPermission.MFPermissionAllow &&
                        permission != MFPermission.MFPermissionDeny)
                        continue;
                    isDeny = permission == MFPermission.MFPermissionDeny;
                    var target = isDeny ? denied : allowed;

                    if (key.IsPseudoUser)
                    {
                        var pseudo = key.GetResolvedPseudoUserOrGroupIDs();
                        if (pseudo == null)
                        {
                            resolved = false;
                        }
                        else
                        {
                            for (var resolvedIndex = 1; resolvedIndex <= pseudo.Count; resolvedIndex++)
                            {
                                var principal = pseudo[resolvedIndex];
                                if (!AddPrincipal(
                                    principal.UserOrGroupID,
                                    principal.UserOrGroupType == MFUserOrUserGroupType.MFUserOrUserGroupTypeUserGroup,
                                    groupsById,
                                    target))
                                {
                                    resolved = false;
                                    break;
                                }
                            }
                        }
                    }
                    else if (!key.HasConcreteUserOrGroupID ||
                        !AddPrincipal(key.UserOrGroupID, key.IsGroup, groupsById, target))
                    {
                        resolved = false;
                    }
                }
                catch
                {
                    // Could not even read this entry's intent; without knowing
                    // whether it was an Allow or a Deny, fail closed.
                    return ResolvedAudience.Failed();
                }

                if (!resolved && isDeny)
                    return ResolvedAudience.Failed();
            }
            allowed.ExceptWith(denied);
            return new ResolvedAudience { UserIds = allowed, ResolutionFailed = false };
        }

        private static bool AddPrincipal(
            int id,
            bool isGroup,
            IDictionary<int, UserGroup> groupsById,
            ISet<int> output)
        {
            if (!isGroup)
            {
                output.Add(id);
                return true;
            }
            try
            {
                ExpandGroup(id, groupsById, output, new HashSet<int>());
                return true;
            }
            catch
            {
                return false;
            }
        }

        private GroupItem BuildGroup(
            UserGroup group,
            IDictionary<int, UserGroup> groupsById,
            IDictionary<int, UserAccount> usersById)
        {
            try
            {
                var userIds = new SortedSet<int>();
                ExpandGroup(group.ID, groupsById, userIds, new HashSet<int>());
                var members = new List<GroupMember>();
                foreach (var userId in userIds)
                {
                    UserAccount user;
                    if (!usersById.TryGetValue(userId, out user) || !user.Enabled)
                        continue;
                    var login = vault.UserOperations.GetLoginAccountOfUser(userId);
                    members.Add(new GroupMember
                    {
                        AccountId = userId.ToString(CultureInfo.InvariantCulture),
                        DisplayName = EmptyToNull(login.FullName) ?? EmptyToNull(login.AccountName),
                        Email = NormalizeEmail(login.EmailAddress),
                        AccountType = "vault-user"
                    });
                }
                return new GroupItem
                {
                    GroupId = group.ID.ToString(CultureInfo.InvariantCulture),
                    Name = EmptyToNull(group.Name),
                    Members = members,
                    MembershipResolutionFailed = false
                };
            }
            catch
            {
                return new GroupItem
                {
                    GroupId = group.ID.ToString(CultureInfo.InvariantCulture),
                    Name = EmptyToNull(group.Name),
                    Members = new List<GroupMember>(),
                    MembershipResolutionFailed = true
                };
            }
        }

        private int[] ValidateObjectTypes(int[] requested)
        {
            if (requested == null || requested.Length == 0)
                throw new ArgumentException("At least one object type ID is required.");
            if (requested.Length > MaximumObjectTypes)
                throw new ArgumentException("Too many object type IDs were requested.");
            if (requested.Any(id => id < 0) || requested.Distinct().Count() != requested.Length)
                throw new ArgumentException("Object type IDs must be unique and non-negative.");
            foreach (var objectTypeId in requested)
            {
                if (vault.ObjectTypeOperations.GetObjectType(objectTypeId).External)
                    throw new InvalidOperationException(
                        "External-repository object types are not supported by this add-on release.");
            }
            return requested.OrderBy(id => id).ToArray();
        }

        private void CollectRange(
            int objectTypeId,
            int low,
            int high,
            int maximum,
            IList<ObjectVersion> output)
        {
            if (low > high || output.Count >= maximum)
                return;
            var results = SearchRange(objectTypeId, low, high, maximum);
            if (!results.MoreResults)
            {
                var sorted = new List<ObjectVersion>();
                for (var index = 1; index <= results.Count; index++)
                    sorted.Add(results[index]);
                sorted.Sort(CompareObjects);
                foreach (var item in sorted)
                {
                    if (output.Count >= maximum)
                        break;
                    output.Add(item);
                }
                return;
            }
            if (low == high)
                throw new InvalidOperationException("M-Files returned a truncated single-object ID range.");
            var midpoint = low + (int)(((long)high - low) / 2L);
            CollectRange(objectTypeId, low, midpoint, maximum, output);
            CollectRange(objectTypeId, midpoint + 1, high, maximum, output);
        }

        private ObjectSearchResults SearchRange(
            int objectTypeId,
            int low,
            int high,
            int maximum)
        {
            var conditions = new SearchConditions();
            AddStatusCondition(
                conditions,
                MFStatusType.MFStatusTypeObjectTypeID,
                MFConditionType.MFConditionTypeEqual,
                MFDataType.MFDatatypeLookup,
                objectTypeId);
            AddStatusCondition(
                conditions,
                MFStatusType.MFStatusTypeDeleted,
                MFConditionType.MFConditionTypeEqual,
                MFDataType.MFDatatypeBoolean,
                false);
            AddStatusCondition(
                conditions,
                MFStatusType.MFStatusTypeObjectID,
                MFConditionType.MFConditionTypeGreaterThanOrEqual,
                MFDataType.MFDatatypeInteger,
                low);
            AddStatusCondition(
                conditions,
                MFStatusType.MFStatusTypeObjectID,
                MFConditionType.MFConditionTypeLessThanOrEqual,
                MFDataType.MFDatatypeInteger,
                high);
            return vault.ObjectSearchOperations.SearchForObjectsByConditionsEx(
                conditions,
                MFSearchFlags.MFSearchFlagDisableRelevancyRanking,
                false,
                maximum,
                60);
        }

        private static void AddStatusCondition(
            SearchConditions conditions,
            MFStatusType status,
            MFConditionType conditionType,
            MFDataType dataType,
            object value)
        {
            var condition = new SearchCondition();
            condition.Expression.SetStatusValueExpression(status);
            condition.ConditionType = conditionType;
            condition.TypedValue.SetValue(dataType, value);
            conditions.Add(-1, condition);
        }

        private void ValidateCommonRequest(AddOnRequest request, bool requireLimit)
        {
            ValidateSchema(request);
            if (requireLimit && (request.Limit < 1 || request.Limit > MaximumPageSize))
                throw new ArgumentException("The page size must be between 1 and 250.");
        }

        private static void ValidateSchema(AddOnRequest request)
        {
            if (request.SchemaVersion != SchemaVersion)
                throw new ArgumentException("The schema version is not supported.");
        }

        private static void ParseObjectCursor(string cursor, out int objectTypeId, out int objectId)
        {
            objectTypeId = 0;
            objectId = 0;
            if (cursor == null)
                return;
            if (!ObjectCursorPattern.IsMatch(cursor))
                throw new ArgumentException("The object cursor is invalid.");
            objectTypeId = int.Parse(cursor.Substring(7, 10), CultureInfo.InvariantCulture);
            objectId = int.Parse(cursor.Substring(18, 20), CultureInfo.InvariantCulture);
        }

        private IDictionary<int, UserGroup> ReadGroupsById()
        {
            var output = new Dictionary<int, UserGroup>();
            var groups = vault.UserGroupOperations.GetUserGroups();
            for (var index = 1; index <= groups.Count; index++)
                output[groups[index].ID] = groups[index];
            return output;
        }

        private IDictionary<int, UserAccount> ReadUsersById()
        {
            var output = new Dictionary<int, UserAccount>();
            var users = vault.UserOperations.GetUserAccounts();
            for (var index = 1; index <= users.Count; index++)
                output[users[index].ID] = users[index];
            return output;
        }

        private static void ExpandGroup(
            int groupId,
            IDictionary<int, UserGroup> groupsById,
            ISet<int> userIds,
            ISet<int> activeGroups)
        {
            if (!activeGroups.Add(groupId))
                throw new InvalidOperationException("A cycle was found in M-Files group membership.");
            UserGroup group;
            if (!groupsById.TryGetValue(groupId, out group))
                throw new InvalidOperationException("A nested M-Files group could not be resolved.");
            for (var index = 1; index <= group.Members.Count; index++)
            {
                var memberId = group.Members[index];
                if (memberId < 0)
                    ExpandGroup(-memberId, groupsById, userIds, activeGroups);
                else
                    userIds.Add(memberId);
            }
            activeGroups.Remove(groupId);
        }

        internal static string BuildObjectCursor(int objectTypeId, int objectId)
        {
            return string.Format(
                CultureInfo.InvariantCulture,
                "object:{0:D10}:{1:D20}",
                objectTypeId,
                objectId);
        }

        private static int CompareObjects(ObjectVersion left, ObjectVersion right)
        {
            var byType = left.ObjVer.Type.CompareTo(right.ObjVer.Type);
            return byType != 0 ? byType : left.ObjVer.ID.CompareTo(right.ObjVer.ID);
        }

        private static string BuildFingerprint(
            IEnumerable<UserPrincipal> principals,
            bool resolutionFailed)
        {
            var users = principals
                .OrderBy(item => item.AccountId, StringComparer.Ordinal)
                .Select(item => item.AccountId + "=" + item.Email);
            var canonical = "users=" + string.Join(",", users) +
                "\npublic=false\nresolutionFailed=" +
                resolutionFailed.ToString().ToLowerInvariant();
            using (var sha256 = SHA256.Create())
            {
                var digest = sha256.ComputeHash(Encoding.UTF8.GetBytes(canonical));
                return "sha256:" + BitConverter.ToString(digest)
                    .Replace("-", string.Empty)
                    .ToLowerInvariant();
            }
        }

        private static string NormalizeEmail(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
                return null;
            var trimmed = value.Trim();
            try
            {
                var parsed = new MailAddress(trimmed);
                if (!string.Equals(parsed.Address, trimmed, StringComparison.OrdinalIgnoreCase))
                    return null;
                return parsed.Address.ToLowerInvariant();
            }
            catch (FormatException)
            {
                return null;
            }
        }

        private static string EmptyToNull(string value)
        {
            return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
        }

        private sealed class ResolvedAudience
        {
            internal SortedSet<int> UserIds { get; set; }
            internal bool ResolutionFailed { get; set; }

            internal static ResolvedAudience Failed()
            {
                return new ResolvedAudience
                {
                    UserIds = new SortedSet<int>(),
                    ResolutionFailed = true
                };
            }
        }
    }
}

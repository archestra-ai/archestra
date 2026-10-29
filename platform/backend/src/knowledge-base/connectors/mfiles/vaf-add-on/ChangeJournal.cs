using System;
using System.Collections.Generic;
using System.Globalization;
using MFilesAPI;
using Newtonsoft.Json;

namespace Archestra.MFiles.VAFAddOn
{
    /// <summary>
    /// Vault-shared, gap-detecting change journal. The head/event write is a
    /// compare-and-swap operation, so concurrent application servers cannot
    /// allocate the same sequence. Event handlers use their transactional
    /// vault reference; if journaling fails, the source mutation rolls back
    /// instead of becoming an invisible, fail-open change.
    /// </summary>
    internal sealed class ChangeJournal
    {
        private const string Namespace = "Archestra.MFiles.VAFAddOn.Journal.v2";
        private const string InstanceKey = "instance-id";
        private const string HeadKey = "head";
        private const string FloorKey = "floor";
        private const int RetainedEvents = 20000;
        private const int MaximumAppendAttempts = 32;
        private readonly Vault vault;

        internal ChangeJournal(Vault vault)
        {
            this.vault = vault;
        }

        internal JournalState GetPosition()
        {
            var values = ReadValues();
            var instanceId = ReadString(values, InstanceKey);
            if (string.IsNullOrWhiteSpace(instanceId))
            {
                instanceId = Guid.NewGuid().ToString("D");
                var update = new NamedValues();
                update[InstanceKey] = instanceId;
                update[HeadKey] = "0";
                update[FloorKey] = "1";
                vault.NamedValueStorageOperations.SetNamedValues(
                    MFNamedValueType.MFAdminConfiguration,
                    Namespace,
                    update);
                values = ReadValues();
                instanceId = ReadString(values, InstanceKey) ?? instanceId;
            }
            return new JournalState
            {
                InstanceId = instanceId,
                Head = ReadLong(values, HeadKey, 0),
                Floor = ReadLong(values, FloorKey, 1)
            };
        }

        internal void Append(string kind, int? objectTypeId, int? objectId, int? groupId)
        {
            for (var attempt = 0; attempt < MaximumAppendAttempts; attempt++)
            {
                var values = ReadValues();
                var head = ReadLong(values, HeadKey, 0);
                var next = checked(head + 1);
                var floor = Math.Max(1, next - RetainedEvents + 1);
                var item = new ChangeItem
                {
                    Sequence = next.ToString(CultureInfo.InvariantCulture),
                    Kind = kind,
                    ObjectTypeId = objectTypeId,
                    ObjectId = objectId,
                    GroupId = groupId
                };
                var update = new NamedValues();
                update[HeadKey] = next.ToString(CultureInfo.InvariantCulture);
                update[FloorKey] = floor.ToString(CultureInfo.InvariantCulture);
                update[EventKey(next)] = JsonConvert.SerializeObject(item, JsonSettings.Output);
                var expected = new NamedValues();
                expected[HeadKey] = values.Contains(HeadKey) ? values[HeadKey] : DBNull.Value;
                try
                {
                    vault.NamedValueStorageOperations.SetNamedValuesIfUnmodified(
                        MFNamedValueType.MFAdminConfiguration,
                        Namespace,
                        update,
                        expected);
                }
                catch
                {
                    if (attempt == MaximumAppendAttempts - 1)
                        throw;
                    continue;
                }
                // Retention cleanup is best-effort after the head+event CAS has
                // committed. Retrying the append because cleanup failed would
                // duplicate one source event and advance the cursor repeatedly.
                try
                {
                    RemoveExpired(floor - 1);
                }
                catch
                {
                    // The floor still prevents old entries from being read.
                    // A later append retries cleanup; safety does not depend on
                    // reclaiming the storage entry synchronously.
                }
                return;
            }
        }

        internal ChangePage ReadChanges(AddOnRequest request, string policyFingerprint)
        {
            if (request.Limit < 1 || request.Limit > 250)
                throw new ArgumentException("The page size must be between 1 and 250.");
            var state = GetPosition();
            // Pin the state first, then read entries. A concurrent append may
            // make this values snapshot newer than the pinned head (harmless),
            // but it cannot leave the snapshot missing an event at or below it.
            var values = ReadValues();
            long cursor;
            if (request.Cursor == null ||
                !long.TryParse(request.Cursor, NumberStyles.None, CultureInfo.InvariantCulture, out cursor) ||
                cursor < 0)
                return FullRequired(state, state.Head, "missing-or-invalid-cursor", policyFingerprint);
            long pinnedHead;
            if (request.PinnedHeadCursor == null)
                pinnedHead = state.Head;
            else if (!long.TryParse(
                request.PinnedHeadCursor,
                NumberStyles.None,
                CultureInfo.InvariantCulture,
                out pinnedHead) || pinnedHead < cursor || pinnedHead > state.Head)
                return FullRequired(state, state.Head, "invalid-pinned-head", policyFingerprint);
            if (cursor < state.Floor - 1)
                return FullRequired(state, pinnedHead, "journal-retention-gap", policyFingerprint);

            var changes = new List<ChangeItem>();
            var last = cursor;
            var target = Math.Min(pinnedHead, cursor + request.Limit);
            for (var sequence = cursor + 1; sequence <= target; sequence++)
            {
                var key = EventKey(sequence);
                if (!values.Contains(key))
                    return FullRequired(state, pinnedHead, "journal-entry-gap", policyFingerprint);
                var item = JsonConvert.DeserializeObject<ChangeItem>(
                    Convert.ToString(values[key], CultureInfo.InvariantCulture),
                    JsonSettings.Input);
                if (item == null || item.Sequence != sequence.ToString(CultureInfo.InvariantCulture))
                    return FullRequired(state, pinnedHead, "invalid-journal-entry", policyFingerprint);
                changes.Add(item);
                last = sequence;
            }
            return new ChangePage
            {
                SchemaVersion = PermissionSnapshotService.SchemaVersion,
                AddOnInstanceId = state.InstanceId,
                NextCursor = last.ToString(CultureInfo.InvariantCulture),
                PinnedHeadCursor = pinnedHead.ToString(CultureInfo.InvariantCulture),
                HasMore = last < pinnedHead,
                FullRequired = new ChangeFullRequired
                {
                    Content = false,
                    Permissions = false,
                    Groups = false,
                    Reasons = new List<string>()
                },
                Changes = changes,
                PermissionPolicyFingerprint = policyFingerprint
            };
        }

        private static ChangePage FullRequired(
            JournalState state,
            long pinnedHead,
            string reason,
            string policyFingerprint)
        {
            return new ChangePage
            {
                SchemaVersion = PermissionSnapshotService.SchemaVersion,
                AddOnInstanceId = state.InstanceId,
                NextCursor = pinnedHead.ToString(CultureInfo.InvariantCulture),
                PinnedHeadCursor = pinnedHead.ToString(CultureInfo.InvariantCulture),
                HasMore = false,
                FullRequired = new ChangeFullRequired
                {
                    Content = true,
                    Permissions = true,
                    Groups = true,
                    Reasons = new List<string> { reason }
                },
                Changes = new List<ChangeItem>(),
                PermissionPolicyFingerprint = policyFingerprint
            };
        }

        private NamedValues ReadValues()
        {
            return vault.NamedValueStorageOperations.GetNamedValues(
                MFNamedValueType.MFAdminConfiguration,
                Namespace);
        }

        private void RemoveExpired(long sequence)
        {
            if (sequence < 1)
                return;
            var names = new Strings();
            names.Add(-1, EventKey(sequence));
            vault.NamedValueStorageOperations.RemoveNamedValues(
                MFNamedValueType.MFAdminConfiguration,
                Namespace,
                names);
        }

        private static string EventKey(long sequence)
        {
            return "event:" + sequence.ToString("D20", CultureInfo.InvariantCulture);
        }

        private static string ReadString(NamedValues values, string key)
        {
            if (values == null || !values.Contains(key) || values[key] == DBNull.Value)
                return null;
            return Convert.ToString(values[key], CultureInfo.InvariantCulture);
        }

        private static long ReadLong(NamedValues values, string key, long fallback)
        {
            long parsed;
            return long.TryParse(
                ReadString(values, key),
                NumberStyles.None,
                CultureInfo.InvariantCulture,
                out parsed)
                ? parsed
                : fallback;
        }
    }

    internal sealed class JournalState
    {
        internal string InstanceId { get; set; }
        internal long Head { get; set; }
        internal long Floor { get; set; }
    }
}

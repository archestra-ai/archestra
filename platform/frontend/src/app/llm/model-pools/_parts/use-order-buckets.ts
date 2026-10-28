"use client";

import { useFieldArray } from "react-hook-form";
import { suggestModelId } from "./model-name";
import {
  denseOrders,
  memberKey,
  orderShare,
  type PoolForm,
  type PoolFormMember,
  type PoolOptions,
  type SavedMember,
} from "./pool-form";

export type OrderMember = {
  /** Stable React key and drag id. */
  id: string;
  /** The member's index in the form's members. */
  index: number;
  member: PoolFormMember;
  /** Percent of the order's traffic, or null when alone or off. */
  share: number | null;
  saved: SavedMember | null;
  /** The order of an earlier member with the same key and model id. */
  repeatsOrder: number | null;
};

export type OrderBucket = { order: number; members: OrderMember[] };

/**
 * The pool's members grouped by order, and the moves between orders. The form
 * keeps one flat list sorted by order; an order exists while it has a member.
 */
export function useOrderBuckets({
  form,
  options,
  savedMembers,
}: {
  form: PoolForm;
  options: PoolOptions;
  savedMembers: SavedMember[];
}) {
  const { fields, move, insert, append, remove } = useFieldArray({
    control: form.control,
    name: "members",
  });
  const members = form.watch("members");
  const name = form.watch("name").trim();

  const buckets: OrderBucket[] = [];
  fields.forEach((field, index) => {
    const member = members[index];
    if (!member) return;
    const order = member.priority;
    const first = members.findIndex(
      (other) => memberKey(other) === memberKey(member),
    );
    buckets[order - 1] ??= { order, members: [] };
    buckets[order - 1]?.members.push({
      id: field.id,
      index,
      member,
      share: orderShare(members, index),
      saved:
        savedMembers.find(
          (row) =>
            row.providerApiKeyId === member.providerApiKeyId &&
            row.modelId === member.modelId,
        ) ?? null,
      repeatsOrder: first < index ? (members[first]?.priority ?? 1) : null,
    });
  });

  const setOrders = (priorities: number[]) => {
    priorities.forEach((value, index) => {
      if (form.getValues(`members.${index}.priority`) !== value) {
        form.setValue(`members.${index}.priority`, value, {
          shouldDirty: true,
        });
      }
    });
  };

  /** Move one member so the orders read `groups` (lists of member indexes). */
  const arrange = (from: number, groups: number[][]) => {
    const kept = groups.filter((group) => group.length > 0);
    const to = kept.flat().indexOf(from);
    if (to !== from) move(from, to);
    setOrders(kept.flatMap((group, order) => group.map(() => order + 1)));
  };

  /** Every order's member indexes, without `from`. */
  const groupsWithout = (from: number) =>
    buckets.map((bucket) =>
      bucket.members
        .map((member) => member.index)
        .filter((index) => index !== from),
    );

  /** A new member on the next unused shared key, named after the pool. */
  const newMember = (priority: number): PoolFormMember | null => {
    const key =
      options.sharedKeys.find(
        (candidate) =>
          !members.some((member) => member.providerApiKeyId === candidate.id),
      ) ?? options.sharedKeys[0];
    if (!key) return null;
    return {
      providerApiKeyId: key.id,
      modelId: suggestModelId(
        name,
        key.provider,
        options.modelIdsByKey.get(key.id),
      ),
      priority,
      weight: 1,
      enabled: true,
    };
  };

  return {
    buckets,
    count: fields.length,
    canAdd: options.sharedKeys.length > 0,
    /**
     * Into order `order` (1-based) at `position` (default last); one past the
     * last order makes a new one. Orders left empty close up.
     */
    moveToOrder: (from: number, order: number, position?: number) => {
      const groups = groupsWithout(from);
      const group = groups[order - 1];
      if (group) group.splice(position ?? group.length, 0, from);
      else groups.push([from]);
      arrange(from, groups);
    },
    /** Into a new order of its own, just before order `order`. */
    moveToNewOrderBefore: (from: number, order: number) => {
      const groups = groupsWithout(from);
      groups.splice(order - 1, 0, [from]);
      arrange(from, groups);
    },
    /** A new member at the end of `order`, or in a new last order. */
    addToOrder: (order: number) => {
      const last = buckets[order - 1]?.members.at(-1);
      const member = newMember(last ? order : buckets.length + 1);
      if (!member) return;
      if (last) insert(last.index + 1, member);
      else append(member);
    },
    removeAt: (index: number) => {
      const rest = form.getValues("members").filter((_, at) => at !== index);
      remove(index);
      setOrders(denseOrders(rest));
    },
  };
}

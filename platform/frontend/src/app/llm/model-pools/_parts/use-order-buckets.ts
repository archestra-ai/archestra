"use client";

import { useFieldArray } from "react-hook-form";
import type { ModelPool } from "@/lib/model-pools.query";
import { suggestModelId } from "./model-name";
import {
  memberOrders,
  orderShare,
  type PoolForm,
  type PoolFormMember,
  type PoolOptions,
  removeMember,
} from "./pool-form";

type SavedMember = ModelPool["members"][number];

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
 * keeps one flat list where a linked member shares the order above it; this
 * hook hides that. An order exists while it has a member.
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
  const orders = memberOrders(members);
  const memberKey = (member: PoolFormMember) =>
    `${member.providerApiKeyId}|${member.modelId.trim()}`;

  const buckets: OrderBucket[] = [];
  fields.forEach((field, index) => {
    const member = members[index];
    if (!member) return;
    const order = orders[index] ?? 1;
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
      repeatsOrder: first < index ? (orders[first] ?? 1) : null,
    });
  });

  const relink = (linked: boolean[]) => {
    linked.forEach((value, index) => {
      if (form.getValues(`members.${index}.linked`) !== value) {
        form.setValue(`members.${index}.linked`, value, { shouldDirty: true });
      }
    });
  };

  /** Move one member so the orders read `groups` (lists of member indexes). */
  const arrange = (from: number, groups: number[][]) => {
    const kept = groups.filter((group) => group.length > 0);
    const to = kept.flat().indexOf(from);
    if (to !== from) move(from, to);
    relink(kept.flatMap((group) => group.map((_, at) => at > 0)));
  };

  /** Every order's member indexes, without `from`. */
  const groupsWithout = (from: number) =>
    buckets.map((bucket) =>
      bucket.members
        .map((member) => member.index)
        .filter((index) => index !== from),
    );

  /** A new member on the next unused shared key, named after the pool. */
  const newMember = (linked: boolean): PoolFormMember | null => {
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
      linked,
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
      const member = newMember(last !== undefined);
      if (!member) return;
      if (last) insert(last.index + 1, member);
      else append(member);
    },
    removeAt: (index: number) => {
      const next = removeMember(form.getValues("members"), index);
      remove(index);
      relink(next.map((member) => member.linked));
    },
  };
}

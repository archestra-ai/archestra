import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  type NativeProvider,
  type NativeReaders,
  type NativeRoomFacts,
  type NativeSnapshot,
  type NativeTrust,
  nativeRoomId,
  normalizeEmails,
  sameFacts,
} from "@/openappa/native-contract";

const rooms = schema.openappaNativeRoomsTable;
const deliveries = schema.openappaNativeDeliveriesTable;

type NativeRegistration =
  | { status: "registered"; snapshot: NativeSnapshot }
  | { status: "conflict" };

class OpenAppaNativeRoomModel {
  static async register(params: {
    organizationId: string;
    facts: NativeRoomFacts;
  }): Promise<NativeRegistration> {
    const roomId = nativeRoomId(params);
    const readers = storedReaders(params.facts.readers);
    await db
      .insert(rooms)
      .values({
        roomId,
        organizationId: params.organizationId,
        provider: params.facts.ref.provider,
        workspaceId: params.facts.ref.workspaceId,
        channelId: params.facts.ref.channelId,
        threadId: params.facts.ref.threadId,
        trust: params.facts.trust,
        readersStatus: readers.status,
        readers: readers.emails,
      })
      .onConflictDoNothing();
    const stored = await OpenAppaNativeRoomModel.findByRoomId(roomId);
    if (!stored) return { status: "conflict" };
    if (
      stored.organizationId !== params.organizationId ||
      !sameFacts(snapshotFacts(stored), params.facts)
    ) {
      return { status: "conflict" };
    }
    return { status: "registered", snapshot: stored };
  }

  static async findByRoomId(roomId: string): Promise<NativeSnapshot | null> {
    const [row] = await db
      .select()
      .from(rooms)
      .where(eq(rooms.roomId, roomId))
      .limit(1);
    if (!row) return null;
    return {
      roomId: row.roomId,
      organizationId: row.organizationId,
      ref: {
        provider: row.provider as NativeProvider,
        workspaceId: row.workspaceId,
        channelId: row.channelId,
        threadId: row.threadId,
      },
      trust: row.trust as NativeTrust,
      readers: rowReaders(row.readersStatus, row.readers),
    };
  }

  static async findDelivery(params: {
    organizationId: string;
    sessionId: string;
    eventId: string;
  }): Promise<{
    roomId: string;
    contentDigest: string;
    status: "pending" | "delivered" | "failed";
  } | null> {
    const [row] = await db
      .select()
      .from(deliveries)
      .where(
        and(
          eq(deliveries.organizationId, params.organizationId),
          eq(deliveries.sessionId, params.sessionId),
          eq(deliveries.eventId, params.eventId),
        ),
      )
      .limit(1);
    if (!row) return null;
    return {
      roomId: row.roomId,
      contentDigest: row.contentDigest,
      status:
        row.status === "delivered"
          ? "delivered"
          : row.status === "failed"
            ? "failed"
            : "pending",
    };
  }

  static async claimDelivery(params: {
    organizationId: string;
    sessionId: string;
    eventId: string;
    roomId: string;
    contentDigest: string;
  }): Promise<boolean> {
    const claimed = await db
      .insert(deliveries)
      .values({ ...params, status: "pending" })
      .onConflictDoNothing()
      .returning({ eventId: deliveries.eventId });
    return claimed.length === 1;
  }

  static async recordDelivery(params: {
    organizationId: string;
    sessionId: string;
    eventId: string;
    roomId: string;
    contentDigest: string;
    status: "delivered" | "failed";
  }): Promise<void> {
    const updated = await db
      .update(deliveries)
      .set({ status: params.status })
      .where(
        and(
          eq(deliveries.organizationId, params.organizationId),
          eq(deliveries.sessionId, params.sessionId),
          eq(deliveries.eventId, params.eventId),
          eq(deliveries.roomId, params.roomId),
          eq(deliveries.contentDigest, params.contentDigest),
          eq(deliveries.status, "pending"),
        ),
      )
      .returning({ eventId: deliveries.eventId });
    if (updated.length !== 1) {
      throw new Error("Native delivery claim is no longer pending");
    }
  }
}

function storedReaders(readers: NativeReaders): {
  status: "resolved" | "unresolved";
  emails: string[] | null;
} {
  if (readers.status === "unresolved") {
    return { status: "unresolved", emails: null };
  }
  return { status: "resolved", emails: normalizeEmails(readers.emails) };
}

function rowReaders(status: string, emails: string[] | null): NativeReaders {
  if (status === "resolved" && emails) {
    return { status: "resolved", emails };
  }
  return { status: "unresolved" };
}

function snapshotFacts(snapshot: NativeSnapshot): NativeRoomFacts {
  return {
    ref: snapshot.ref,
    trust: snapshot.trust,
    readers: snapshot.readers,
  };
}

export default OpenAppaNativeRoomModel;

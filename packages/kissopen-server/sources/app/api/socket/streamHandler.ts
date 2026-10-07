/*
A byte stream between one of an account's clients and one of its machines.

The relay already carries questions and answers. A terminal is neither: it is
two flows of bytes that outlive any one message, produced faster than a
question-and-answer shape can carry them, and ordered — a chunk applied out of
turn is a corrupted screen rather than a late one.

So this is a pipe, and deliberately only a pipe. It does not know what a
terminal is; what rides it is the daemon's own attach protocol, unchanged,
which is the whole point. A second terminal protocol written for the relay
would be a second thing to keep in step with the first.

Routing reuses the RPC registration: a machine that will answer a stream
registers a method the ordinary way, and opening a stream finds that socket in
the same room an rpc-call would. Nothing here can address a socket outside the
account that opened it, because nothing here is ever told about one.
*/
import { log } from "@/utils/log";
import { Server, Socket } from "socket.io";
import { randomUUID } from "node:crypto";
import { Counter, register } from "prom-client";
import { StreamRegistry, type StreamPeers } from "./streamRegistry";

/*
The largest chunk this will carry.

Bounded because the sender is on the other side of a network and the cost of
a chunk is paid here, in memory, before anyone has agreed to receive it. The
attach protocol frames well below this; a message above it is a caller that
has stopped speaking it.
*/
const STREAM_CHUNK_LIMIT = 1024 * 1024;

/** How long the machine has to accept an open before the client is told no. */
const STREAM_OPEN_TIMEOUT_MS = 15_000;

/**
 * How long one chunk may take to be accepted by the far end.
 *
 * This is the backpressure: the sender waits for its ack, so a reader that
 * has stopped reading stops the writer rather than filling this process with
 * what it has not read. Generous, because the far end may be a laptop that
 * just woke up, and short enough that a dead peer is noticed.
 */
const STREAM_CHUNK_TIMEOUT_MS = 30_000;

const streamCounter = new Counter({
    name: "relay_streams_total",
    help: "Byte streams opened between a client and a machine, by outcome",
    labelNames: ["result"] as const,
    registers: [register],
});

const streamChunkCounter = new Counter({
    name: "relay_stream_chunks_total",
    help: "Chunks carried between the two ends of a stream, by outcome",
    labelNames: ["result"] as const,
    registers: [register],
});

const streams = new StreamRegistry();

/*
One stream's chunks, carried in the order they arrived.

Each handler awaits the far end's ack, so without this a sender that put two
chunks on the wire before the first was acknowledged would have both forwarded
at once and either could land first. For a terminal that is not a late chunk,
it is a corrupted screen — and the sender would have no way to know.

A promise chain per stream, dropped when the stream goes. The wait is the far
end's, so this does not hold anything of its own: it only keeps the order the
sender put them in.
*/
const order = new Map<string, Promise<unknown>>();

function inOrder<T>(id: string, work: () => Promise<T>): Promise<T> {
    const queued = (order.get(id) ?? Promise.resolve()).then(work, work);
    // The tail every later chunk queues behind. It never rejects, so one
    // failed chunk does not poison the ones behind it; whether that chunk
    // worked is answered to its own sender through `queued`.
    const tail = queued.then(
        () => undefined,
        () => undefined,
    );
    order.set(id, tail);
    void tail.then(() => {
        // Only if nothing queued behind it in the meantime.
        if (order.get(id) === tail) order.delete(id);
    });
    return queued;
}

/** Forgets one stream's ordering, once it can carry nothing more. */
function orderForget(id: string): void {
    order.delete(id);
}

/** The room a machine's registered method lives in; the same one RPC uses. */
function rpcRoom(userId: string, method: string): string {
    return `rpc:${userId}:${method}`;
}

/** The chunk as it arrived, or nothing when it is not one. */
function chunkOf(value: unknown): Uint8Array | undefined {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return undefined;
}

export function streamHandler(userId: string, socket: Socket, io: Server) {
    /*
     * Opening: the client names a method its machine registered, the machine
     * is asked whether it will take the stream, and only an acceptance makes
     * one. The machine is given the stream's id so its own end can speak
     * about it without having to be told again.
     */
    socket.on("stream-open", async (data: unknown, callback?: (answer: unknown) => void) => {
        const { method, params } = (data ?? {}) as { method?: unknown; params?: unknown };
        try {
            if (typeof method !== "string" || !method) {
                streamCounter.inc({ result: "invalid" });
                callback?.({ ok: false, error: "Invalid parameters: method is required" });
                return;
            }

            const targets = await io.in(rpcRoom(userId, method)).fetchSockets();
            const target = targets[0];
            if (!target || target.id === socket.id) {
                streamCounter.inc({ result: "not_available" });
                callback?.({ ok: false, error: "Stream method not available" });
                return;
            }

            const id = randomUUID();
            /*
             * Recorded before the machine is asked, so a machine that starts
             * writing the instant it accepts has somewhere to write to. A
             * refusal takes it straight back out.
             */
            const peers: StreamPeers = {
                userId,
                clientId: socket.id,
                targetId: target.id,
                method,
            };
            if (!streams.open(id, peers)) {
                streamCounter.inc({ result: "limit" });
                callback?.({ ok: false, error: "Too many open streams" });
                return;
            }

            const accepted = (await target
                .timeout(STREAM_OPEN_TIMEOUT_MS)
                .emitWithAck("stream-opened", { id, method, params })
                .catch(() => undefined)) as { ok?: boolean; error?: string } | undefined;

            if (accepted?.ok !== true) {
                streams.close(id);
                streamCounter.inc({ result: "refused" });
                callback?.({ ok: false, error: accepted?.error ?? "The machine did not answer" });
                return;
            }

            streamCounter.inc({ result: "opened" });
            callback?.({ ok: true, id });
        } catch (error) {
            streamCounter.inc({ result: "error" });
            log({ module: "websocket", level: "error" }, `Error in stream-open: ${error}`);
            callback?.({ ok: false, error: "Internal error" });
        }
    });

    /*
     * Carrying: one chunk to the other end, acknowledged only once that end
     * has taken it. The ack is what lets a slow reader slow its writer down,
     * so a terminal nobody is reading stops being produced rather than piling
     * up in this process.
     */
    socket.on("stream-data", async (data: unknown, callback?: (answer: unknown) => void) => {
        const { id, chunk } = (data ?? {}) as { id?: unknown; chunk?: unknown };
        try {
            const bytes = chunkOf(chunk);
            if (typeof id !== "string" || !bytes) {
                streamChunkCounter.inc({ result: "invalid" });
                callback?.({ ok: false, error: "Invalid parameters" });
                return;
            }
            if (bytes.byteLength > STREAM_CHUNK_LIMIT) {
                streamChunkCounter.inc({ result: "too_large" });
                callback?.({ ok: false, error: "Chunk too large" });
                return;
            }

            const route = streams.route(id, socket.id);
            if (!route.ok) {
                streamChunkCounter.inc({ result: route.error === "unknown" ? "unknown" : "denied" });
                callback?.({ ok: false, error: "No such stream" });
                return;
            }

            const carried = await inOrder(id, async () => {
                const [peer] = await io.in(route.to).fetchSockets();
                if (!peer) return false;
                await peer
                    .timeout(STREAM_CHUNK_TIMEOUT_MS)
                    .emitWithAck("stream-data", { id, chunk: bytes });
                return true;
            });
            if (!carried) {
                // The far end left. Closing here rather than letting the
                // writer keep talking to nobody.
                streamClose(io, id, "The other end went away");
                streamChunkCounter.inc({ result: "gone" });
                callback?.({ ok: false, error: "The other end went away" });
                return;
            }
            streamChunkCounter.inc({ result: "carried" });
            callback?.({ ok: true });
        } catch (error) {
            /*
             * The far end did not take it in time. That is a stream that has
             * stopped working, not a chunk to retry: the bytes after it would
             * arrive out of order, and an out-of-order chunk is a corrupted
             * screen rather than a late one.
             */
            streamChunkCounter.inc({ result: "timeout" });
            if (typeof id === "string") streamClose(io, id, "The other end stopped reading");
            callback?.({ ok: false, error: "The other end stopped reading" });
        }
    });

    socket.on("stream-close", (data: unknown, callback?: (answer: unknown) => void) => {
        const { id, error } = (data ?? {}) as { id?: unknown; error?: unknown };
        if (typeof id !== "string") {
            callback?.({ ok: false, error: "Invalid parameters" });
            return;
        }
        const route = streams.route(id, socket.id);
        if (!route.ok) {
            callback?.({ ok: false, error: "No such stream" });
            return;
        }
        io.to(route.to).emit("stream-closed", {
            id,
            ...(typeof error === "string" ? { error } : {}),
        });
        streams.close(id);
        orderForget(id);
        callback?.({ ok: true });
    });

    /*
     * A socket leaving takes its streams with it. A stream with one end gone
     * is not a stream, and the surviving end is told rather than left waiting
     * for bytes from somewhere that is no longer there.
     */
    socket.on("disconnect", () => {
        for (const { id, peers } of streams.closeSocket(socket.id)) {
            const other = peers.clientId === socket.id ? peers.targetId : peers.clientId;
            io.to(other).emit("stream-closed", { id, error: "disconnected" });
            orderForget(id);
        }
    });
}

/** Closes one stream and tells whichever end is still there. */
function streamClose(io: Server, id: string, error: string): void {
    const peers = streams.close(id);
    orderForget(id);
    if (!peers) return;
    io.to(peers.clientId).emit("stream-closed", { id, error });
    io.to(peers.targetId).emit("stream-closed", { id, error });
}

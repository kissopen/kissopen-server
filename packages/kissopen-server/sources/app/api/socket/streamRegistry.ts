/*
Who is at each end of a stream, and what may be said to it.

The relay's RPC is one question and one answer. A terminal is neither: it is
two byte flows that outlive any single message, and the thing that has to be
decided on every chunk is only "whose stream is this, and where does the other
end live". That decision is here, away from socket.io, because it is the part
worth testing — the wiring around it is the part that needs a real cluster.

Everything is scoped to the account. A stream is opened by a socket that has
already authenticated as one user, against a method that user's own machine
registered; nothing here can address a socket of another account, because
nothing here is ever told about one.
*/

/** One live stream: a client on one side, a machine on the other. */
export interface StreamPeers {
    readonly userId: string;
    /** The socket that opened it. */
    readonly clientId: string;
    /** The socket that answered — the machine, or the session on it. */
    readonly targetId: string;
    /** The method it was opened against, for logging and metrics. */
    readonly method: string;
}

/** Where a chunk is going, or why it is going nowhere. */
export type StreamRoute =
    | { readonly ok: true; readonly to: string; readonly peers: StreamPeers }
    | { readonly ok: false; readonly error: "unknown" | "not-yours" };

/**
 * How many streams one account may hold open at once.
 *
 * A bound rather than a promise of plenty: every open stream is a socket held
 * on a machine somewhere, and an account that has lost track of a few hundred
 * of them is not doing anything a person asked for.
 */
export const STREAM_LIMIT_PER_USER = 64;

export class StreamRegistry {
    readonly #streams = new Map<string, StreamPeers>();
    /** Streams each socket is an end of, so a disconnect can close them all. */
    readonly #bySocket = new Map<string, Set<string>>();
    readonly #countByUser = new Map<string, number>();

    /**
     * Records a new stream.
     *
     * Refused rather than queued when the account is already holding its
     * limit: a stream that exists but never carries anything is worse than
     * one that was not opened, because the reader is left waiting on it.
     */
    open(id: string, peers: StreamPeers): boolean {
        if (this.#streams.has(id)) return false;
        const held = this.#countByUser.get(peers.userId) ?? 0;
        if (held >= STREAM_LIMIT_PER_USER) return false;
        this.#streams.set(id, peers);
        this.#countByUser.set(peers.userId, held + 1);
        this.#attach(peers.clientId, id);
        this.#attach(peers.targetId, id);
        return true;
    }

    /**
     * Where a chunk from `fromSocket` should go.
     *
     * A socket that is not one of the two ends is told the stream is not
     * theirs, in the same words as one that does not exist: the two are the
     * same fact from where the asker stands, and telling them apart would say
     * that somebody else's stream has this id.
     */
    route(id: string, fromSocket: string): StreamRoute {
        const peers = this.#streams.get(id);
        if (!peers) return { ok: false, error: "unknown" };
        if (fromSocket === peers.clientId) return { ok: true, to: peers.targetId, peers };
        if (fromSocket === peers.targetId) return { ok: true, to: peers.clientId, peers };
        return { ok: false, error: "not-yours" };
    }

    /** Forgets one stream. Answers who was on it, so both ends can be told. */
    close(id: string): StreamPeers | undefined {
        const peers = this.#streams.get(id);
        if (!peers) return undefined;
        this.#streams.delete(id);
        this.#detach(peers.clientId, id);
        this.#detach(peers.targetId, id);
        const held = (this.#countByUser.get(peers.userId) ?? 1) - 1;
        if (held <= 0) this.#countByUser.delete(peers.userId);
        else this.#countByUser.set(peers.userId, held);
        return peers;
    }

    /**
     * Every stream one socket was an end of, now closed.
     *
     * Called when that socket goes: a stream with one end gone is not a
     * stream, and leaving it open would leave the surviving end waiting for
     * bytes from a machine that is no longer there.
     */
    closeSocket(socketId: string): { id: string; peers: StreamPeers }[] {
        const ids = this.#bySocket.get(socketId);
        if (!ids) return [];
        const closed: { id: string; peers: StreamPeers }[] = [];
        for (const id of [...ids]) {
            const peers = this.close(id);
            if (peers) closed.push({ id, peers });
        }
        return closed;
    }

    /** How many streams this account is holding. */
    held(userId: string): number {
        return this.#countByUser.get(userId) ?? 0;
    }

    #attach(socketId: string, id: string): void {
        const ids = this.#bySocket.get(socketId) ?? new Set<string>();
        ids.add(id);
        this.#bySocket.set(socketId, ids);
    }

    #detach(socketId: string, id: string): void {
        const ids = this.#bySocket.get(socketId);
        if (!ids) return;
        ids.delete(id);
        if (ids.size === 0) this.#bySocket.delete(socketId);
    }
}

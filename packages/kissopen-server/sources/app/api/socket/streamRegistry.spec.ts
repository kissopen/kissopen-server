/*
The part of a stream worth testing without a cluster: who is on it.

A terminal rides these streams, so the failures that matter are the quiet
ones — a chunk delivered to the wrong socket, a stream left open after the
machine holding it went away, an account able to hold as many as it likes.
*/
import { describe, expect, it } from "vitest";
import { StreamRegistry, STREAM_LIMIT_PER_USER } from "./streamRegistry";

const peers = (over: Partial<Parameters<StreamRegistry["open"]>[1]> = {}) => ({
    userId: "u1",
    clientId: "client-socket",
    targetId: "machine-socket",
    method: "m1:terminalAttach",
    ...over,
});

describe("a stream's two ends", () => {
    it("sends what the client writes to the machine, and back again", () => {
        const streams = new StreamRegistry();
        expect(streams.open("s1", peers())).toBe(true);
        expect(streams.route("s1", "client-socket")).toMatchObject({
            ok: true,
            to: "machine-socket",
        });
        expect(streams.route("s1", "machine-socket")).toMatchObject({
            ok: true,
            to: "client-socket",
        });
    });

    /*
     * A socket that is on neither end is told the same thing as one asking
     * about a stream that does not exist. Telling those apart would confirm
     * that somebody else holds this id.
     */
    it("refuses a socket that is on neither end", () => {
        const streams = new StreamRegistry();
        streams.open("s1", peers());
        expect(streams.route("s1", "someone-else")).toEqual({ ok: false, error: "not-yours" });
        expect(streams.route("s-nothing", "client-socket")).toEqual({
            ok: false,
            error: "unknown",
        });
    });

    it("refuses to open the same stream twice", () => {
        const streams = new StreamRegistry();
        expect(streams.open("s1", peers())).toBe(true);
        expect(streams.open("s1", peers({ clientId: "other" }))).toBe(false);
        // The first pair is still the one on it.
        expect(streams.route("s1", "client-socket")).toMatchObject({ ok: true });
    });

    /*
     * A stream with one end gone is not a stream. Both are closed together so
     * the surviving end stops waiting for bytes from a machine that left.
     */
    it("closes every stream a departing socket was an end of", () => {
        const streams = new StreamRegistry();
        streams.open("s1", peers());
        streams.open("s2", peers({ targetId: "another-machine" }));
        streams.open("s3", peers({ clientId: "another-client" }));

        const closed = streams.closeSocket("client-socket");
        expect(closed.map((entry) => entry.peers.targetId).sort()).toEqual([
            "another-machine",
            "machine-socket",
        ]);
        // The ids come back too, because the surviving end is told which
        // stream went — it may be holding several.
        expect(closed.map((entry) => entry.id).sort()).toEqual(["s1", "s2"]);
        expect(streams.route("s1", "machine-socket")).toEqual({ ok: false, error: "unknown" });
        // The one it was not on is untouched.
        expect(streams.route("s3", "another-client")).toMatchObject({ ok: true });
    });

    it("says who was on a stream it closes, so both can be told", () => {
        const streams = new StreamRegistry();
        streams.open("s1", peers());
        expect(streams.close("s1")).toMatchObject({
            clientId: "client-socket",
            targetId: "machine-socket",
        });
        expect(streams.close("s1")).toBeUndefined();
    });

    /*
     * The count is what the limit is enforced on, so it has to come back down
     * — an account that opened and closed its limit once must not be locked
     * out for the life of the process.
     */
    it("stops one account at the limit, and lets it back in after a close", () => {
        const streams = new StreamRegistry();
        for (let index = 0; index < STREAM_LIMIT_PER_USER; index++)
            expect(streams.open(`s${String(index)}`, peers())).toBe(true);
        expect(streams.held("u1")).toBe(STREAM_LIMIT_PER_USER);
        expect(streams.open("one-too-many", peers())).toBe(false);

        streams.close("s0");
        expect(streams.open("one-too-many", peers())).toBe(true);
    });

    // One account filling its allowance says nothing about another's.
    it("counts each account separately", () => {
        const streams = new StreamRegistry();
        for (let index = 0; index < STREAM_LIMIT_PER_USER; index++)
            streams.open(`s${String(index)}`, peers());
        expect(streams.open("other", peers({ userId: "u2" }))).toBe(true);
        expect(streams.held("u2")).toBe(1);
    });

    it("forgets an account once its last stream goes", () => {
        const streams = new StreamRegistry();
        streams.open("s1", peers());
        streams.close("s1");
        expect(streams.held("u1")).toBe(0);
    });
});

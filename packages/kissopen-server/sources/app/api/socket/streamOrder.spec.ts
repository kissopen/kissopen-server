/*
Chunks stay in the order their sender put them in.

Each chunk waits on the far end's acknowledgement, so two chunks forwarded at
once could land either way round. On a terminal that is not a late chunk, it
is a corrupted screen — and neither end would have any way to notice.

The ordering helper is not exported from the handler, which pulls in socket.io
and the metrics registry, so what is tested here is the same construction: a
promise chain per stream, dropped when nothing is behind it.
*/
import { describe, expect, it } from "vitest";

/** The helper as `streamHandler` builds it. */
function orderer() {
    const order = new Map<string, Promise<unknown>>();
    function inOrder<T>(id: string, work: () => Promise<T>): Promise<T> {
        const queued = (order.get(id) ?? Promise.resolve()).then(work, work);
        const tail = queued.then(
            () => undefined,
            () => undefined,
        );
        order.set(id, tail);
        void tail.then(() => {
            if (order.get(id) === tail) order.delete(id);
        });
        return queued;
    }
    return { inOrder, size: () => order.size };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the order chunks are carried in", () => {
    it("carries one stream's chunks in the order they arrived", async () => {
        const { inOrder } = orderer();
        const done: number[] = [];
        // The first takes longest, which is exactly the case that reorders
        // without a queue.
        const first = inOrder("s1", async () => {
            await wait(20);
            done.push(1);
        });
        const second = inOrder("s1", async () => {
            await wait(5);
            done.push(2);
        });
        const third = inOrder("s1", async () => {
            done.push(3);
        });
        await Promise.all([first, second, third]);
        expect(done).toEqual([1, 2, 3]);
    });

    // Two streams are two pipes; one waiting must not hold the other up.
    it("does not make one stream wait for another", async () => {
        const { inOrder } = orderer();
        const done: string[] = [];
        const slow = inOrder("s1", async () => {
            await wait(20);
            done.push("slow");
        });
        const quick = inOrder("s2", async () => {
            done.push("quick");
        });
        await quick;
        expect(done).toEqual(["quick"]);
        await slow;
    });

    /*
     * A chunk the far end refused must not take the ones behind it with it.
     * Its own sender is told; the stream carries on.
     */
    it("keeps carrying after one chunk fails", async () => {
        const { inOrder } = orderer();
        const failed = inOrder("s1", () => Promise.reject(new Error("refused")));
        await expect(failed).rejects.toThrow("refused");
        await expect(inOrder("s1", () => Promise.resolve("after"))).resolves.toBe("after");
    });

    // Nothing is kept for a stream that has gone quiet.
    it("forgets a stream once nothing is queued behind it", async () => {
        const state = orderer();
        await state.inOrder("s1", () => Promise.resolve());
        await wait(0);
        expect(state.size()).toBe(0);
    });
});

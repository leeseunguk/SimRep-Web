import { describe, expect, it } from "vitest";
import { memoryStore } from "./storage";
import { crc32, readZip, writeZip } from "./zip";

const enc = new TextEncoder();

describe("zip", () => {
  it("crc32 matches the reference value", () => {
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
  });

  for (const deflate of [false, true]) {
    it(`round-trips entries (${deflate ? "deflated" : "stored"})`, async () => {
      const entries = [
        { path: "projects/a/a.simrep", bytes: enc.encode('{"format":"simrep-project"}') },
        { path: "files/x/einzel.pa#", bytes: Uint8Array.from({ length: 4096 }, (_, i) => i % 7) },
        { path: "files/x/empty", bytes: new Uint8Array() },
      ];
      const back = await readZip(await writeZip(entries, deflate));
      expect(back.map((e) => e.path)).toEqual(entries.map((e) => e.path));
      back.forEach((e, i) => expect([...e.bytes]).toEqual([...entries[i]!.bytes]));
    });
  }

  it("rejects a damaged entry", async () => {
    const zip = await writeZip([{ path: "a", bytes: enc.encode("hello") }], false);
    zip[31] = zip[31]! ^ 0xff; // first data byte after the 30-byte local header and the 1-byte name
    await expect(readZip(zip)).rejects.toThrow(/checksum/);
  });

  it("rejects bytes that are not a ZIP", async () => {
    await expect(readZip(enc.encode("not a zip at all, just text"))).rejects.toThrow(/not a ZIP/);
  });
});

describe("memory store", () => {
  it("lists and deletes folders, not name prefixes", async () => {
    const s = memoryStore();
    await s.put("/p/a.simrep", enc.encode("1"));
    await s.put("/p/a.simrep.d/runs/r1/run.json", enc.encode("22"));
    await s.put("/p/a.simrep.dx", enc.encode("333"));
    expect(await s.keys("/p/a.simrep.d")).toEqual(["/p/a.simrep.d/runs/r1/run.json"]);
    expect(await s.list("/p")).toEqual([
      { path: "/p/a.simrep", size: 1 },
      { path: "/p/a.simrep.d/runs/r1/run.json", size: 2 },
      { path: "/p/a.simrep.dx", size: 3 },
    ]);
    await s.delete("/p/a.simrep.d");
    expect(await s.keys("")).toEqual(["/p/a.simrep", "/p/a.simrep.dx"]);
    expect(await s.get("/p/missing")).toBeNull();
  });

  it("returns copies, so callers cannot change stored bytes", async () => {
    const s = memoryStore();
    const b = enc.encode("abc");
    await s.put("/f", b);
    b[0] = 0;
    const got = (await s.get("/f"))!;
    got[1] = 0;
    expect(new TextDecoder().decode((await s.get("/f"))!)).toBe("abc");
  });
});

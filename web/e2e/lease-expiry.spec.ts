import { expect, test } from "@playwright/test";

test("expired reader rejects an obsolete manifest instead of reporting missing", async ({ context, page }, testInfo) => {
  console.log("Surface: two real browser tabs, real IndexedDB, production read_text/write_text IPC. Invocation: drain startup reads, isolate UI publication listeners, pause the file read's manifest completion, advance injected clocks beyond lease expiry, replace /files/lease.txt, resume read.");
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "locks", { value: undefined });
    localStorage.setItem("simrep.tour", "seen");
    Date.now = () => 1_000_000 + Number(sessionStorage.getItem("qa-clock-offset") ?? 0);
    // The host's recent-project refresh also reads manifests. Isolate that
    // unrelated subscriber so the paused snapshot belongs to read_text, while
    // retaining the real lease-release channel and native IndexedDB operations.
    Object.defineProperty(BroadcastChannel.prototype, "addEventListener", {
      value(this: BroadcastChannel, type: string, listener: EventListener, options?: boolean | AddEventListenerOptions) {
        if (this.name === "simrep-web:store" && type === "message") return;
        EventTarget.prototype.addEventListener.call(this, type, listener, options);
      },
    });
  });
  const writer = await context.newPage();
  await Promise.all([page, writer].map(async tab => {
    await tab.goto("/");
    await expect(tab.getByTestId("web-compute")).toBeVisible();
    // With publication refreshes isolated, this native lease round trip follows
    // the one startup refresh and drains it before arming the snapshot barrier.
    await tab.evaluate(async () => {
      const ipc = (window as unknown as { __TAURI_INTERNALS__: { invoke(cmd: string, args: unknown): Promise<unknown> } }).__TAURI_INTERNALS__;
      await ipc.invoke("path_info", { paths: ["/files/startup-barrier"] });
    });
  }));
  await writer.evaluate(async () => {
    const ipc = (window as unknown as { __TAURI_INTERNALS__: { invoke(cmd: string, args: unknown): Promise<unknown> } }).__TAURI_INTERNALS__;
    await ipc.invoke("write_text", { path: "/files/lease.txt", contents: "old" });
  });
  await page.evaluate(() => {
    type Probe = Window & { paused: Promise<void>; resume: () => void; readResult: Promise<unknown> };
    const win = window as unknown as Probe;
    let signal!: () => void;
    win.paused = new Promise<void>(resolve => { signal = resolve; });
    const get = IDBObjectStore.prototype.get;
    let armed = true;
    IDBObjectStore.prototype.get = function (key: IDBValidKey | IDBKeyRange) {
      const req = get.call(this, key);
      if (armed && key === "/.storage/manifest.json") {
        armed = false;
        const tx = this.transaction;
        const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, "oncomplete")!;
        Object.defineProperty(tx, "oncomplete", {
          set(handler: (event: Event) => void) {
            descriptor.set!.call(tx, (event: Event) => {
              win.resume = () => handler.call(tx, event);
              signal();
            });
          },
        });
      }
      return req;
    };
    const ipc = (window as unknown as { __TAURI_INTERNALS__: { invoke(cmd: string, args: unknown): Promise<unknown> } }).__TAURI_INTERNALS__;
    win.readResult = ipc.invoke("read_text", { path: "/files/lease.txt" }).then(value => ({ value }), error => ({ error }));
  });
  await page.evaluate(async () => { await (window as unknown as { paused: Promise<void> }).paused; });
  await Promise.all([page, writer].map(tab => tab.evaluate(() => sessionStorage.setItem("qa-clock-offset", "31000"))));
  await writer.evaluate(async () => {
    const ipc = (window as unknown as { __TAURI_INTERNALS__: { invoke(cmd: string, args: unknown): Promise<unknown> } }).__TAURI_INTERNALS__;
    await ipc.invoke("write_text", { path: "/files/lease.txt", contents: "new" });
  });
  const result = await page.evaluate(async () => {
    const win = window as unknown as { resume: () => void; readResult: Promise<unknown> };
    win.resume();
    return await win.readResult;
  });
  expect(JSON.stringify(result)).toMatch(/lease expired/);
  expect(JSON.stringify(result)).not.toMatch(/notFound/);
  const committed = await page.evaluate(async () => {
    const ipc = (window as unknown as { __TAURI_INTERNALS__: { invoke(cmd: string, args: unknown): Promise<unknown> } }).__TAURI_INTERNALS__;
    return await ipc.invoke("read_text", { path: "/files/lease.txt" });
  });
  expect(committed).toBe("new");
  await testInfo.attach("expired-reader-and-retry", { body: JSON.stringify({ result, committed }), contentType: "application/json" });
  await writer.close();
});

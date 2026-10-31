# Browser storage concurrency

Every persistent namespace read and read-modify-write uses the exclusive origin-wide
Web Lock `simrep-web:store`. Each transaction reloads the committed manifest under
that lock. Immutable objects, manifest publication, and obsolete-object collection
belong to the same transaction; a reader cannot race collection. `storeTransaction`
passes a scoped store to compound operations so they do not reacquire the lock.

The existing global manifest remains the atomic commit record because batches can
span project documents, their resources, generated PA families, and recovery data.
Splitting these into per-project manifests would remove that existing cross-family
atomicity. The manifest is no longer a cached global blob owned by each tab.

On browsers without `navigator.locks`, storage uses IndexedDB rather than OPFS.
A lease record at `/.storage/lease` in the existing `simrep-web` database is acquired
with one read-write transaction, renewed every 10 seconds, and expires after
30 seconds. Contenders subscribe to the release BroadcastChannel before acquisition
and retry on release or the lease deadline. A crashed owner is recoverable after
expiration. Manifest publication checks the lease owner and expiration in the same
IndexedDB transaction that writes the manifest. A suspended old writer cannot
publish after another tab acquires the lease. Failure leaves the previous manifest
intact. OPFS is selected only when Web Locks are available; existing Safari IDB
files need no migration. The in-memory fallback coordinates instances sharing the
same raw store within one JavaScript realm and does not claim persistence.

A publication on `simrep-web:store` BroadcastChannel tells other tabs to rebuild
their recent-project UI from the authoritative namespace. The originating tab gets
`simrep-storage-change`. The native recent-project localStorage value is only a UI
hint; it cannot hide a committed browser project on refresh or reload.

Archive decoding and validation happen before the transaction. Namespace allocation,
reference rewriting, and publication happen inside it. Imports never replace an
existing namespace: collisions use `NAME-imported-2`, `NAME-imported-3`, and so on,
selecting the first free suffix under the same lock. This also applies to sequential
imports; replacement dialogs are no longer needed. Both concurrent callers receive
the distinct committed paths.

Regression scenarios live in `web/src/concurrency.test.ts` and
`web/e2e/concurrency.spec.ts`. The browser scenarios use two pages in one context,
real production IPC and drag/drop imports, both with Web Locks and with Web Locks
removed to exercise the IDB lease. They verify other-tab refresh, same-path
replacement consistency, preserved import contents, reload, and expired-lease
recovery. No fixed sleep or timing-based assertion is used.

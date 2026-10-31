import { Archive, Cpu, Globe, HardDrive, PackageOpen } from "lucide-react";
import { registerHost, type Host, type HostFeature } from "../.app-src/host";
import { addMessages, useI18n, type Message } from "../.app-src/i18n";
import type { MessageKey } from "../.app-src/i18n/en";
import type { Refusal } from "../.app-src/refusals";
import { openProject } from "../.app-src/state/project";
import { useApp } from "../.app-src/state/store";
import { download, pickFiles } from "./pickers";
import type { Boot } from "./main";
import { messages } from "./messages";
import styles from "./host.module.css";

/**
 * The SimRep-Web host (app/src/host.ts): its own start-up and status, a browser-storage panel on the
 * start screen, project archives in the Export menu, and refusals for what a browser cannot do.
 * Features backed by worker commands follow the worker's capabilities at runtime, so a command the
 * backend gains later switches its UI on without a change here.
 */

const DESKTOP = "https://github.com/leeseunguk/SimRep/releases";
const k = (key: string) => key as MessageKey;
const msg = (key: string, params?: Message["params"]): Message => ({ key: k(key), params });
const desktopLink = { href: DESKTOP, label: msg("web.desktop.link") };
const refusal = (what: string, why: string, link = true): Refusal => ({ what: msg(what), why: msg(why), ...(link && { link: desktopLink }) });

/** Worker commands each feature needs. */
const NEEDS: Partial<Record<HostFeature, string[]>> = {
  templates: ["create_template", "refine_start", "fly"],
  refine: ["refine_start"],
  voltages: ["fast_adjust"],
  fly: ["fly"],
  wizard: ["inspect_geometry", "build_geometry"],
  iob: ["open_iob"],
  exportData: ["export_array", "export_trajectories"],
  tour: ["create_template", "refine_start", "fly"],
};

export function installHost(boot: Boot) {
  addMessages(messages);
  const supported = new Set(boot.backend?.capabilities.supportedCommands ?? []);
  const unavailable = (feature: HostFeature): Refusal | null => {
    switch (feature) {
      case "ai":
        return refusal("web.ai.title", "web.ai.why");
      case "cad":
        return refusal("web.cad.title", "web.cad.why");
      case "folders":
        return refusal("web.folders.title", "web.folders.why", false);
      case "gpu":
        return refusal("web.gpu.title", "web.gpu.why");
    }
    const needs = NEEDS[feature] ?? [];
    if (needs.every((c) => supported.has(c))) return null;
    if (!boot.backend) return { what: msg("web.backend.title"), why: msg("web.backend.why", { detail: boot.backendError ?? "" }), link: desktopLink };
    return { what: msg("web.missing.title"), why: msg("web.missing.why", { commands: needs.filter((c) => !supported.has(c)).join(", ") }), link: desktopLink };
  };

  const host: Host = {
    unavailable,
    async connect() {
      const app = useApp.getState();
      const version = __SIMREP_WEB_VERSION__;
      app.setRuntime({ kind: "web", version });
      app.log("info", { key: "log.appStarted", params: { runtime: msg("web.runtime", { version }) } });
      app.log("info", msg("web.log.storage", { kind: msg(`web.storage.${boot.store.kind}`) }));
      if (!boot.backend) {
        app.setCompute({ state: "cpu", name: "CPU", reason: msg("web.backend.why", { detail: boot.backendError ?? "" }) });
        app.log("error", { key: "log.backendFailed", params: { reason: boot.backendError ?? "" } });
        return;
      }
      const c = boot.backend.capabilities;
      app.setCompute({ state: "cpu", name: "CPU", reason: msg(c.multicore ? "web.compute.threads" : "web.compute.single", { threads: c.threads }) });
      app.log("success", msg("web.log.backend", { threads: c.threads, unsupported: c.unsupportedCommands.join(", ") || "-" }));
      if (boot.store.kind === "memory") app.toast("warning", msg("web.storage.memory.title"), msg("web.storage.memory.why"));
    },
    StatusItems() {
      const { t, tm } = useI18n();
      const compute = useApp((s) => s.compute);
      const threads = boot.backend?.capabilities.threads ?? 0;
      return (
        <>
          <span className={styles.item} title={compute.state === "cpu" ? tm(compute.reason) : undefined} data-testid="web-compute">
            <Cpu aria-hidden />
            {boot.backend ? t(k("web.status.compute"), { threads }) : t(k("web.status.noCompute"))}
          </span>
          <span className={styles.item} title={t(k(`web.storage.${boot.store.kind}.title`))} data-testid="web-storage" data-kind={boot.store.kind}>
            <HardDrive aria-hidden />
            {t(k(`web.storage.${boot.store.kind}`))}
          </span>
          <span className={styles.item}>
            <Globe aria-hidden />
            {t(k("web.runtime"), { version: __SIMREP_WEB_VERSION__ })}
          </span>
        </>
      );
    },
    StartPanel() {
      const { t } = useI18n();
      const importArchive = () => {
        // Started inside the click: the picker needs its user activation.
        void pickFiles([".zip"], false).then(async (files) => {
          if (!files?.[0]) return;
          try {
            const project = await boot.shim.importArchive(new Uint8Array(await files[0].arrayBuffer()));
            await openProject(project);
          } catch (err) {
            const detail = err && typeof err === "object" && "detail" in err ? String((err as { detail: unknown }).detail) : String(err);
            useApp.getState().toast("error", msg("web.archive.failed"), msg("web.archive.failedWhy", { detail }));
          }
        });
      };
      return (
        <div className={styles.panel} data-testid="web-start-panel">
          <p className={styles.title}>{t(k("web.start.title"))}</p>
          <p className={styles.body}>{t(k(`web.start.body.${boot.store.kind}`))}</p>
          <button type="button" className={styles.link} onClick={importArchive} data-testid="web-import-archive">
            <PackageOpen aria-hidden />
            {t(k("web.archive.import"))}
          </button>
          <a className={styles.link} href={DESKTOP} target="_blank" rel="noreferrer">
            {t(k("web.desktop.link"))}
          </a>
        </div>
      );
    },
    ExportMenuItems({ close }) {
      const { t } = useI18n();
      const path = useApp((s) => s.project.path);
      return (
        <button
          type="button"
          role="menuitem"
          className={styles.menuItem}
          disabled={!path}
          title={path ? undefined : t(k("web.archive.saveFirst"))}
          data-testid="web-export-archive"
          onClick={() => {
            close();
            if (!path) return;
            void boot.shim.projectArchive(path).then(
              ({ name, bytes }) => download(name, bytes, "application/zip"),
              (err: unknown) => useApp.getState().toast("error", msg("web.archive.failed"), msg("web.archive.failedWhy", { detail: String(err) })),
            );
          }}
        >
          <Archive aria-hidden />
          <span className={styles.menuText}>
            <span>{t(k("web.archive.export"))}</span>
            <span className={styles.menuSub}>{t(k("web.archive.exportSub"))}</span>
          </span>
        </button>
      );
    },
  };
  registerHost(host);
}

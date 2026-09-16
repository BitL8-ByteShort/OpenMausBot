import { useEffect, useState } from "react";
import { Loader2, Tablet } from "lucide-react";
import { usePageVisible } from "@/lib/page-visible";
import { t } from "@/lib/i18n";
import { api } from "@/state/store";
import type { IpadStatusView } from "@/lib/ipad-place";

const STATUS_POLL_MS = 2_000;
const FRAME_POLL_MS = 2_000;

/** Polls the harness's iPad status while the page is visible. Null until
 * the first answer, and null again when the harness cannot be reached. */
export function useIpadDevice(): IpadStatusView | null {
  const [status, setStatus] = useState<IpadStatusView | null>(null);
  const pageVisible = usePageVisible();
  useEffect(() => {
    if (!pageVisible) return;
    let alive = true;
    const refresh = async () => {
      try {
        const next = (await api("/api/ipad/status")) as IpadStatusView;
        if (alive) setStatus(next);
      } catch {
        if (alive) setStatus(null);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), STATUS_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [pageVisible]);
  return status;
}

/** The iPad mirror: the bot drives, the person watches. Frames come from
 * the harness's session-less WebDriverAgent screenshot, so watching never
 * disturbs the session a turn holds. */
export function IpadDevicePanel({ status }: { status: IpadStatusView | null }) {
  const pageVisible = usePageVisible();
  const [frame, setFrame] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reachable = status?.reachable === true;

  useEffect(() => {
    // one WebDriverAgent screenshot per tick — nothing to show while hidden
    if (!reachable || !pageVisible) return;
    let alive = true;
    let timer: number | null = null;
    let url: string | null = null;
    const capture = async () => {
      try {
        const response = await fetch(`/api/ipad/frame?t=${Date.now()}`, { credentials: "include" });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${response.status}`);
        }
        const blob = await response.blob();
        if (!alive) return;
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(blob);
        setFrame(url);
        setStale(false);
        setError(null);
      } catch (cause) {
        if (alive) {
          setStale(true);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (alive) timer = window.setTimeout(() => void capture(), FRAME_POLL_MS);
      }
    };
    void capture();
    return () => {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
      if (url) URL.revokeObjectURL(url);
    };
  }, [reachable, pageVisible]);

  const control = async (action: "start" | "stop") => {
    setPending(true);
    setError(null);
    try {
      await api(`/api/ipad/${action}`, { method: "POST" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center gap-2 text-[12.5px] text-ink-secondary">
        <Tablet size={14} />
        <span>
          {reachable
            ? t("computer.ipad.connected", { device: status?.device ?? "iPad", os: status?.os ?? "" })
            : t("computer.ipad.unreachable")}
        </span>
        {status?.running && <Loader2 size={13} className="animate-spin" />}
        <span className="ml-auto flex gap-2">
          {!reachable && status?.startable && !status.running && (
            <button type="button" disabled={pending} onClick={() => void control("start")} className="rounded-md bg-control px-2 py-1 text-ink hover:bg-control/80">
              {t("computer.ipad.start")}
            </button>
          )}
          {status?.running && (
            <button type="button" disabled={pending} onClick={() => void control("stop")} className="rounded-md bg-control px-2 py-1 text-ink hover:bg-control/80">
              {t("computer.ipad.stop")}
            </button>
          )}
        </span>
      </div>
      {!reachable && status?.running && <p className="text-[12px] text-ink-secondary">{t("computer.ipad.starting")}</p>}
      {!reachable && status && !status.startable && !status.running && (
        <p className="text-[12px] text-ink-secondary">{t("computer.ipad.notStartable")}</p>
      )}
      {frame ? (
        <img
          src={frame}
          alt={t("computer.ipad.screenAlt")}
          className={stale ? "min-h-0 w-full flex-1 rounded-lg object-contain opacity-50" : "min-h-0 w-full flex-1 rounded-lg object-contain"}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center rounded-lg bg-card p-4 text-center text-[12px] text-ink-secondary">{t("computer.ipad.hint")}</div>
      )}
      {status?.log && status.log.length > 0 && !reachable && (
        <pre className="max-h-32 overflow-auto rounded-lg bg-card p-2 text-[11px] leading-4 text-ink-secondary">{status.log.join("\n")}</pre>
      )}
      {error && (
        <div role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>
      )}
    </div>
  );
}

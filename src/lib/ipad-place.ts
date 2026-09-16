// Pure decisions for the iPad tile and tab, kept out of the panel so they
// can be tested without rendering.
export interface IpadStatusView {
  reachable: boolean;
  startable: boolean;
  running: boolean;
  instruction: string;
  device?: string | null;
  os?: string | null;
  log?: string[];
}

export function ipadTileState(status: IpadStatusView | null): { enabled: boolean; reason: string | null } {
  if (!status) return { enabled: false, reason: null };
  if (status.reachable || status.startable) return { enabled: true, reason: null };
  return { enabled: false, reason: status.instruction };
}

export function ipadTabVisible(status: IpadStatusView | null, computer: string | undefined): boolean {
  if (computer === "ipad") return true;
  return status?.reachable === true;
}

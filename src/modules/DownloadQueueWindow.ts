import { getString } from "../utils/locale";

export type DownloadQueueStatus =
  | "downloaded"
  | "pending"
  | "verification"
  | "failed";

export interface DownloadQueueEntry {
  id: string;
  item: Zotero.Item;
  title: string;
  status: DownloadQueueStatus;
  url?: string;
  error?: string;
  detail?: string;
  verificationStarted?: boolean;
}

/**
 * Interactive queue window. It is intentionally independent from the
 * network code so that a verification row can be retried after the user
 * completes a browser challenge.
 */
export class DownloadQueueWindow {
  private readonly bodyID = `sci-pdf-queue-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  private dialog?: { window: Window };
  private interactive = false;
  private disposed = false;

  constructor(
    private readonly entries: DownloadQueueEntry[],
    private readonly onVerify: (entry: DownloadQueueEntry) => void,
  ) {}

  open(): boolean {
    if (
      typeof ztoolkit === "undefined" ||
      typeof ztoolkit.Dialog !== "function"
    ) {
      return false;
    }

    const dialog = new ztoolkit.Dialog(1, 1);
    dialog
      .addCell(0, 0, {
        tag: "div",
        namespace: "html",
        styles: {
          width: "760px",
          height: "500px",
          overflow: "auto",
          padding: "12px",
          boxSizing: "border-box",
        },
        children: [
          {
            tag: "p",
            namespace: "html",
            properties: { textContent: getString("queue-instructions") },
          },
          {
            tag: "table",
            namespace: "html",
            attributes: {
              cellpadding: "6",
              cellspacing: "0",
              width: "100%",
            },
            styles: { borderCollapse: "collapse" },
            children: [
              {
                tag: "thead",
                namespace: "html",
                children: [
                  {
                    tag: "tr",
                    namespace: "html",
                    children: [
                      {
                        tag: "th",
                        namespace: "html",
                        properties: { textContent: getString("queue-column-status") },
                      },
                      {
                        tag: "th",
                        namespace: "html",
                        properties: { textContent: getString("queue-column-title") },
                      },
                      {
                        tag: "th",
                        namespace: "html",
                        properties: { textContent: getString("queue-column-detail") },
                      },
                      {
                        tag: "th",
                        namespace: "html",
                        properties: { textContent: getString("queue-column-action") },
                      },
                    ],
                  },
                ],
              },
              {
                tag: "tbody",
                namespace: "html",
                id: this.bodyID,
              },
            ],
          },
        ],
      })
      .addButton(getString("queue-close"), "close")
      .setDialogData({
        loadCallback: () => this.render(),
        beforeUnloadCallback: () => {
          this.disposed = true;
        },
      })
      .open(getString("queue-title"), {
        width: 800,
        height: 560,
        centerscreen: true,
        resizable: true,
      });
    this.dialog = dialog;
    this.interactive = true;
    return true;
  }

  isInteractive() {
    return this.interactive && !this.disposed;
  }

  update(entry: DownloadQueueEntry) {
    const current = this.entries.find((candidate) => candidate.id === entry.id);
    if (current) Object.assign(current, entry);
    this.render();
  }

  private render() {
    if (!this.isInteractive() || !this.dialog) return;
    const body = this.dialog.window.document.getElementById(this.bodyID);
    if (!body) return;
    while (body.firstChild) body.removeChild(body.firstChild);

    const groups: Array<[DownloadQueueStatus, string]> = [
      ["downloaded", getString("queue-status-downloaded")],
      ["pending", getString("queue-status-pending")],
      ["verification", getString("queue-status-verification")],
      ["failed", getString("queue-status-failed")],
    ];
    for (const [status, label] of groups) {
      const groupEntries = this.entries.filter(
        (entry) => entry.status === status,
      );
      const heading = this.dialog.window.document.createElement("tr");
      const headingCell = this.dialog.window.document.createElement("td");
      headingCell.colSpan = 4;
      headingCell.textContent = `${label} (${groupEntries.length})`;
      headingCell.style.fontWeight = "bold";
      headingCell.style.backgroundColor = "var(--material-background)";
      heading.appendChild(headingCell);
      body.appendChild(heading);

      if (groupEntries.length === 0) {
        const row = this.dialog.window.document.createElement("tr");
        const cell = this.dialog.window.document.createElement("td");
        cell.colSpan = 4;
        cell.textContent = getString("queue-empty");
        cell.style.color = "GrayText";
        row.appendChild(cell);
        body.appendChild(row);
        continue;
      }

      for (const entry of groupEntries) {
        const row = this.dialog.window.document.createElement("tr");
        const statusCell = this.dialog.window.document.createElement("td");
        const titleCell = this.dialog.window.document.createElement("td");
        const detailCell = this.dialog.window.document.createElement("td");
        const actionCell = this.dialog.window.document.createElement("td");
        statusCell.textContent = label;
        titleCell.textContent = entry.title;
        detailCell.textContent = entry.detail || entry.error || "";
        titleCell.title = entry.error || entry.url || "";
        detailCell.title = entry.error || "";
        row.append(statusCell, titleCell, detailCell, actionCell);

        if (status === "verification") {
          const button = this.dialog.window.document.createElement("button");
          button.type = "button";
          button.textContent = entry.verificationStarted
            ? getString("queue-verifying")
            : getString("queue-verify");
          button.disabled = Boolean(entry.verificationStarted);
          button.addEventListener("click", () => {
            this.onVerify(entry);
          });
          actionCell.appendChild(button);
        } else if (status === "failed" && entry.url) {
          const button = this.dialog.window.document.createElement("button");
          button.type = "button";
          button.textContent = getString("queue-retry");
          button.addEventListener("click", () => this.onVerify(entry));
          actionCell.appendChild(button);
        }
        body.appendChild(row);
      }
    }
  }
}

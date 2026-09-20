import { getString } from "../utils/locale";
import { Utils } from "../utils/utils";
import { CustomResolverManager } from "./CustomResolverManager";
import { DownloadQueueEntry, DownloadQueueWindow } from "./DownloadQueueWindow";

class PDFNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfNotFoundError";
    Object.setPrototypeOf(this, PDFNotFoundError.prototype);
  }
}

class VerificationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationRequiredError";
    Object.setPrototypeOf(this, VerificationRequiredError.prototype);
  }
}

export class SciHubFetcher {
  private static readonly pdfNotAvailableRegexes = [
    /Please try to search again using DOI/im,
    /статья не найдена в базе/im,
  ];

  static async updateItems(
    items: Zotero.Item[],
    skipIfExistPDF: boolean = true,
  ) {
    const regularItems = items.filter((item) => item.isRegularItem());
    const queueEntries: DownloadQueueEntry[] = regularItems.map(
      (item, index) => ({
        id: `${index}`,
        item,
        title: item.getDisplayTitle(),
        status: "pending",
      }),
    );
    const queueEntryByItem = new Map<Zotero.Item, DownloadQueueEntry>();
    regularItems.forEach((item, index) =>
      queueEntryByItem.set(item, queueEntries[index]),
    );

    const queue = new DownloadQueueWindow(
      queueEntries,
      (entry) => {
        void this.startVerification(entry, queue);
      },
      (entry) => {
        void this.importLocalPDF(entry, queue);
      },
    );

    const filtered: Zotero.Item[] = [];
    for (const item of regularItems) {
      const entry = queueEntryByItem.get(item);
      let hasPDF = false;
      if (skipIfExistPDF && typeof item.getBestAttachment === "function") {
        const attachment = await item.getBestAttachment();
        hasPDF = Boolean(attachment && attachment.isPDFAttachment());
      }
      if (hasPDF) {
        entry!.status = "downloaded";
      } else {
        filtered.push(item);
      }
    }

    const interactiveQueue = queue.open();
    queueEntries.forEach((entry) => queue.update(entry));

    if (filtered.length <= 0) return;

    const state = {
      cancelled: false,
      cancelRequest: undefined as (() => void) | undefined,
    };
    // Do not retry a throttled host again in this batch.
    const throttledHosts = new Set<string>();
    // Verification is user-gated. Avoid reopening the same host for every item.
    const verificationHosts = new Set<string>();
    for (const [itemIndex, item] of filtered.entries()) {
      if (state.cancelled) break;
      const scihubUrls = await this.buildSciHubURLs(item);
      const queueEntry = queueEntryByItem.get(item);
      if (!scihubUrls.length) {
        if (queueEntry) {
          queueEntry.status = "failed";
          queueEntry.error = getString("popwin-doimissing");
          queueEntry.detail = getString("popwin-doimissing");
          queue.update(queueEntry);
        }
        if (!interactiveQueue) {
          Utils.showPopWin(
            getString("popwin-doimissing"),
            item.getDisplayTitle(),
            "fail",
          );
        }
        continue;
      }
      if (queueEntry) {
        queueEntry.detail = getString("popwin-fetching");
        queue.update(queueEntry);
      }
      const win = interactiveQueue
        ? {
            addDescription() {},
            changeLine() {},
            win: { close() {} },
          }
        : Utils.showPopWin(
            getString("popwin-fetching"),
            item.getDisplayTitle(),
            "default",
            0,
          );
      win.addDescription(getString("popwin-cancelhint"));
      const close = win.win.close.bind(win.win);
      // Zotero's close-on-click calls this method. Programmatic cleanup uses close directly.
      win.win.close = () => {
        state.cancelled = true;
        state.cancelRequest?.();
        close();
      };
      let success = false;
      let allNotFound = true;
      let verificationRequired = false;
      try {
        for (const [mirrorIndex, scihubUrl] of scihubUrls.entries()) {
          if (state.cancelled) break;
          if (throttledHosts.has(scihubUrl.host)) {
            allNotFound = false;
            continue;
          }
          if (verificationHosts.has(scihubUrl.host)) {
            allNotFound = false;
            continue;
          }
          win.changeLine({
            text: getString("popwin-fetchprogress", {
              args: {
                item: itemIndex + 1,
                items: filtered.length,
                mirror: mirrorIndex + 1,
                mirrors: scihubUrls.length,
                host: scihubUrl.host,
                title: item.getDisplayTitle(),
              },
            }),
            progress: (mirrorIndex / scihubUrls.length) * 100,
          });
          if (queueEntry) {
            queueEntry.detail = getString("popwin-fetchprogress", {
              args: {
                item: itemIndex + 1,
                items: filtered.length,
                mirror: mirrorIndex + 1,
                mirrors: scihubUrls.length,
                host: scihubUrl.host,
                title: item.getDisplayTitle(),
              },
            });
            queue.update(queueEntry);
          }
          try {
            await this.fetchPDF(scihubUrl, item, state);
            success = !state.cancelled;
            if (success && queueEntry) {
              queueEntry.status = "downloaded";
              queueEntry.url = scihubUrl.href;
              queueEntry.detail = getString("popwin-fetchsuccess");
              queue.update(queueEntry);
            }
            break;
          } catch (error) {
            if (state.cancelled) break;
            if (error instanceof VerificationRequiredError) {
              allNotFound = false;
              verificationRequired = true;
              if (queueEntry) {
                queueEntry.status = "verification";
                queueEntry.url ??= scihubUrl.href;
                queueEntry.error = String(error);
                queueEntry.detail = getString("popwin-verification");
                queue.update(queueEntry);
              }
              if (!queue.isInteractive()) {
                try {
                  // Fallback for environments without the interactive queue.
                  Zotero.launchURL(scihubUrl.href);
                } catch (launchError) {
                  Zotero.debug(
                    `[Sci-PDF] failed to open verification page: ${String(launchError)}`,
                  );
                }
              }
              verificationHosts.add(scihubUrl.host);
              continue;
            }
            const status = (error as { status?: number } | null)?.status;
            if (status === 429 || status === 503)
              throttledHosts.add(scihubUrl.host);
            allNotFound &&= error instanceof PDFNotFoundError;
            if (queueEntry) {
              queueEntry.error = String(error);
              queueEntry.detail = String(error);
              queue.update(queueEntry);
            }
            Zotero.debug(`[Sci-PDF] ${scihubUrl.href}: ${String(error)}`);
          } finally {
            state.cancelRequest = undefined;
          }
        }
      } finally {
        win.win.close = close;
        close();
      }
      if (state.cancelled) {
        if (queueEntry) {
          queueEntry.status = "failed";
          queueEntry.detail = getString("popwin-cancelled");
          queue.update(queueEntry);
        }
        if (!interactiveQueue) {
          Utils.showPopWin(
            getString("popwin-cancelled"),
            item.getDisplayTitle(),
          );
        }
        break;
      }
      if (!success && !verificationRequired && queueEntry) {
        queueEntry.status = "failed";
        queueEntry.detail = getString(
          allNotFound ? "popwin-pdfnotavaliable" : "popwin-fetchfailed",
        );
        queue.update(queueEntry);
      }
      if (!interactiveQueue) {
        Utils.showPopWin(
          getString(
            success
              ? "popwin-fetchsuccess"
              : verificationRequired
                ? "popwin-verification"
                : allNotFound
                  ? "popwin-pdfnotavaliable"
                  : "popwin-fetchfailed",
          ),
          item.getDisplayTitle(),
          success ? "success" : "fail",
          5000,
        );
      }
    }
  }

  private static async startVerification(
    entry: DownloadQueueEntry,
    queue: DownloadQueueWindow,
  ) {
    if (!entry.url || entry.verificationStarted) return;
    entry.status = "verification";
    entry.verificationStarted = true;
    entry.error = undefined;
    entry.detail = getString("queue-verification-opening");
    queue.update(entry);

    try {
      // Zotero 7's visible document viewer uses the same CookieSandbox for the
      // challenge page and the resulting PDF request. Its MIME handler captures
      // the PDF blob as soon as it appears, so no polling of an external browser
      // or manual file import is required after the user completes the challenge.
      await this.downloadPDFViaVerificationViewer(entry);
      entry.status = "downloaded";
      entry.verificationStarted = false;
      entry.error = undefined;
      entry.detail = getString("popwin-fetchsuccess");
      queue.update(entry);
    } catch (error) {
      Zotero.debug(`[Sci-PDF] verification viewer: ${String(error)}`);
      entry.status = "verification";
      entry.verificationStarted = false;
      entry.error = String(error);
      entry.detail = /User closed the document viewer/i.test(String(error))
        ? getString("queue-verification-closed")
        : String(error);
      queue.update(entry);
    }
  }

  private static async downloadPDFViaVerificationViewer(
    entry: DownloadQueueEntry,
  ) {
    if (!entry.url) throw new Error("Verification URL is missing");

    const zotero = Zotero as typeof Zotero & {
      BrowserDownload?: {
        downloadPDFViaViewer?: (
          url: string,
          path: string,
          options: { cookieSandbox?: Zotero.CookieSandbox },
        ) => Promise<void>;
      };
    };
    const downloadPDFViaViewer =
      zotero.BrowserDownload?.downloadPDFViaViewer?.bind(
        zotero.BrowserDownload,
      );
    if (!downloadPDFViaViewer) {
      throw new Error(getString("queue-verification-unsupported"));
    }

    const directory =
      await Zotero.Attachments.createTemporaryStorageDirectory();
    const file = directory.clone();
    file.append(`sci-pdf-${entry.item.id}-${Date.now()}.pdf`);
    const CookieSandbox = (
      Zotero as unknown as {
        CookieSandbox: new () => Zotero.CookieSandbox;
      }
    ).CookieSandbox;
    const cookieSandbox = new CookieSandbox();

    await downloadPDFViaViewer(entry.url, file.path, { cookieSandbox });
    if (!file.exists() || file.fileSize <= 0) {
      throw new Error("Zotero verification viewer did not return a PDF file");
    }
    await Zotero.Attachments.importFromFile({
      file,
      libraryID: entry.item.libraryID,
      parentItemID: entry.item.id,
      title: entry.item.getField("title"),
      contentType: "application/pdf",
    });
  }

  private static async importLocalPDF(
    entry: DownloadQueueEntry,
    queue: DownloadQueueWindow,
  ) {
    try {
      const path = await new ztoolkit.FilePicker(
        getString("queue-import-title"),
        "open",
        [[getString("queue-import-filter"), "*.pdf"]],
      ).open();
      if (!path) return;
      await Zotero.Attachments.importFromFile({
        file: path,
        libraryID: entry.item.libraryID,
        parentItemID: entry.item.id,
        title: entry.item.getField("title"),
        contentType: "application/pdf",
      });
      entry.status = "downloaded";
      entry.verificationStarted = false;
      entry.error = undefined;
      entry.detail = getString("popwin-fetchsuccess");
      queue.update(entry);
    } catch (error) {
      entry.status = "failed";
      entry.verificationStarted = false;
      entry.error = String(error);
      entry.detail = String(error);
      queue.update(entry);
    }
  }

  private static async buildSciHubURLs(item: Zotero.Item): Promise<URL[]> {
    const dois = await Utils.extractDOIs(item);
    const baseURLs = this.baseSciHubURLs;
    const urls: URL[] = [];
    for (const doi of dois) {
      for (const base of baseURLs) {
        try {
          urls.push(new URL(doi, base));
        } catch {
          // skip invalid URLs
        }
      }
    }
    return urls;
  }

  private static get baseSciHubURLs(): string[] {
    const resolvers = CustomResolverManager.shared.customResolvers;
    if (resolvers.length <= 0) {
      return ["https://sci-hub.se/"];
    }
    return resolvers.map((r) => {
      // resolver.url is like "https://sci-hub.se/{doi}", extract the base
      return r.url.replace(/\{doi\}.*$/, "");
    });
  }

  private static async fetchPDF(
    scihubUrl: URL,
    item: Zotero.Item,
    state: { cancelled: boolean; cancelRequest?: () => void },
  ) {
    const xhr = await Zotero.HTTP.request("GET", scihubUrl.href, {
      responseType: "document",
      timeout: 15000,
      errorDelayMax: 0,
      // Handle status codes ourselves, avoiding automatic Retry-After waits on Z7 too.
      successCodes: false,
      cancellerReceiver: (cancel: () => void) => {
        state.cancelRequest = cancel;
        if (state.cancelled) cancel();
      },
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 11_3_1 like Mac OS X) AppleWebKit/603.1.30 (KHTML, like Gecko) Version/10.0 Mobile/14E304 Safari/602.1",
      },
    });
    state.cancelRequest = undefined;
    if (state.cancelled) return;
    if (xhr.status !== 200) {
      throw Object.assign(new Error(`HTTP ${xhr.status} ${xhr.statusText}`), {
        status: xhr.status,
      });
    }
    if (this.isVerificationPage(xhr.responseXML)) {
      throw new VerificationRequiredError(
        `Human verification required at ${scihubUrl.host}`,
      );
    }
    const rawPDFUrl = xhr.responseXML
      ?.querySelector("#pdf")
      ?.getAttribute("src");
    const body = xhr.responseXML?.querySelector("body");

    if (xhr.status === 200 && rawPDFUrl) {
      // new URL() handles absolute, protocol-relative, root-relative,
      // and relative paths correctly using scihubUrl as the base.
      const pdfUrl = new URL(rawPDFUrl, scihubUrl.href);
      pdfUrl.protocol = "https:";
      await Utils.attachRemotePDF(pdfUrl, item);
    } else if (xhr.status === 200 && this.pdfNotAvailable(body)) {
      ztoolkit.log(`scihub: PDF is not available at the moment "${scihubUrl}"`);
      throw new PDFNotFoundError(`PDF is not available: ${scihubUrl}`);
    } else {
      ztoolkit.log(`scihub: failed to fetch PDF from "${scihubUrl}"`);
      throw new Error(xhr.statusText);
    }
  }

  private static pdfNotAvailable(body?: Element | null): boolean {
    const innerHTML = (body as HTMLElement)?.innerHTML as string | undefined;
    if (!innerHTML || innerHTML.trim() === "") {
      return true;
    }
    return this.pdfNotAvailableRegexes.some((regex) => regex.test(innerHTML));
  }

  private static isVerificationPage(document?: Document | null): boolean {
    if (!document) return false;
    const title = document.querySelector("title")?.textContent ?? "";
    const body = document.querySelector("body")?.textContent ?? "";
    const hasChallengeElement = Boolean(
      document.querySelector(
        "#captcha, [id*='captcha' i], iframe[src*='captcha' i], iframe[src*='challenge' i]",
      ),
    );
    return (
      hasChallengeElement ||
      /captcha|are you (a )?robot|verify (that )?you('|’)?re human|human verification|你是机器人|验证码|验证中|人类验证/i.test(
        `${title}\n${body}`,
      )
    );
  }
}

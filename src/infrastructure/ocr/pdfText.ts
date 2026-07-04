/**
 * Client-side PDF text extraction using pdfjs-dist, so uploaded statements
 * never need to leave the browser.
 */
import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export async function extractPdfText(buffer: ArrayBuffer): Promise<string> {
  const doc = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pageTexts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();

    // Joining every item on the page with a single space collapses the
    // whole table into one line, which breaks row-based parsing. Start a
    // new line whenever an item's baseline y-coordinate jumps — that's a
    // new table row.
    let lastY: number | null = null;
    let line = "";
    const lines: string[] = [];
    for (const item of content.items) {
      if (!("str" in item)) continue;
      const y = item.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        lines.push(line.trim());
        line = "";
      }
      line += item.str + " ";
      lastY = y;
    }
    if (line.trim()) lines.push(line.trim());
    pageTexts.push(lines.join("\n"));
  }
  return pageTexts.join("\n");
}

type WordDocumentElement = {
  type: string;
  value?: string;
  children?: WordDocumentElement[];
};

function extractElementText(element: WordDocumentElement): string {
  if (element.type === "text") return element.value ?? "";
  if (element.type === "tab") return "\t";
  if (element.type === "table") return extractTableText(element);
  const text = (element.children ?? []).map(extractElementText).join("");
  return element.type === "paragraph" ? `${text}\n\n` : text;
}

function extractTableText(table: WordDocumentElement): string {
  let hasQuestionNumber = false;
  let readingOptions = false;
  return (table.children ?? []).map((row) => {
    const cells = (row.children ?? []).map(extractElementText);
    const nonEmptyCells = cells.map((cell) => cell.trim()).filter(Boolean);
    const numberRow = nonEmptyCells.length === 1 && /^\d{1,3}$/.test(nonEmptyCells[0]);
    if (numberRow) {
      hasQuestionNumber = true;
      readingOptions = false;
    }
    if (hasQuestionNumber && /^[a-d]\)$/i.test(cells[0]?.trim() ?? "")) {
      readingOptions = true;
      return cells.join("") + "\n\n";
    }
    if (readingOptions && nonEmptyCells.length > 0 && !/^correcta$/i.test(nonEmptyCells[0])) {
      readingOptions = false;
      const feedback = cells.join("").trim();
      const labeledFeedback = /^(?:retroalimentaci[oó]n|explicaci[oó]n|feedback)\s*:/i.test(feedback);
      return `${labeledFeedback ? "" : "Retroalimentación:\n\n"}${feedback}\n\n`;
    }
    return cells.join("") + "\n\n";
  }).join("");
}

export async function extractWordCourseTemplateText(
  input: Parameters<typeof import("mammoth").extractRawText>[0],
) {
  const mammothImport = await import("mammoth");
  const mammoth = mammothImport.default ?? mammothImport;
  let value = "";
  const result = await mammoth.convertToHtml(input, {
    transformDocument: (document: WordDocumentElement) => {
      value = extractElementText(document);
      return { ...document, children: [] };
    },
  });
  return { value, messages: result.messages };
}

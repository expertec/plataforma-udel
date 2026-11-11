import type { GlobalExamQuestion } from "./types";
import { parseWordCourseTemplate, type WordImportedQuizQuestion } from "../course-word-template-parser";

type MammothResult = { value: string; messages: Array<{ type: string; message: string }> };
type MammothModule = { extractRawText: (input: { arrayBuffer: ArrayBuffer }) => Promise<MammothResult> };
type ExamTemplatePreviewQuestion = {
  id: string;
  prompt: string;
  options: Array<{ id: string; text: string }>;
  feedback?: string;
};
const OPTION_LETTERS = ["A", "B", "C", "D", "E", "F"];

const normalizeExamPreviewLine = (value: string): string =>
  value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

const htmlDocumentToPlainText = (html: string): string => {
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|table)>/gi, "\n")
    .replace(/<td[^>]*>/gi, "\t")
    .replace(/<[^>]+>/g, " ");
  if (typeof window === "undefined") return withBreaks;
  const textarea = window.document.createElement("textarea");
  textarea.innerHTML = withBreaks;
  return textarea.value;
};

async function extractRawTextFromExamTemplateFile(file: File): Promise<string> {
  const signature = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if ([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((byte, index) => signature[index] === byte)) {
    throw new Error("Este archivo usa el formato Word antiguo (.doc). Ábrelo en Word y guárdalo como Documento de Word (.docx) antes de subirlo.");
  }

  if (file.name.toLowerCase().endsWith(".docx")) {
    const mammothImport = (await import("mammoth")) as unknown as {
      default?: MammothModule;
    } & MammothModule;
    const mammoth = mammothImport.default ?? mammothImport;
    const result = await mammoth.extractRawText({
      arrayBuffer: await file.arrayBuffer(),
    });
    return result.value;
  }

  const rawText = await file.text();
  return /<html|<body|<p|<table|<br/i.test(rawText)
    ? htmlDocumentToPlainText(rawText)
    : rawText;
}

const isExamQuestionStartLine = (line: string): { prompt: string; consumesNextPrompt: boolean } | null => {
  const inline = line.match(/^(\d{1,3})[\).]\s+(.+)$/);
  if (inline) return { prompt: inline[2].trim(), consumesNextPrompt: false };
  if (/^\d{1,3}$/.test(line)) return { prompt: "", consumesNextPrompt: true };
  return null;
};

const parseExamOptionLine = (line: string): { letter: string; text: string } | null => {
  const match = line.match(/^([A-Fa-f])[\).]\s*(.*)$/);
  if (!match) return null;
  return {
    letter: match[1].toUpperCase(),
    text: match[2].trim(),
  };
};

const parseFeedbackLine = (line: string): string | null => {
  const match = line.match(/^(retroalimentaci[oó]n|retro|feedback|explicaci[oó]n)\s*:\s*(.*)$/i);
  if (!match) return null;
  return match[2].trim();
};

const isFeedbackLine = (line: string): boolean => parseFeedbackLine(line) !== null;

const isAnswerOrScoreLine = (line: string): boolean =>
  /^respuesta\s+correcta\s*:/i.test(line) ||
  /^puntaje\s*:/i.test(line) ||
  /^tipo\s+admitido\s*:/i.test(line) ||
  isFeedbackLine(line) ||
  /^correcta$/i.test(line) ||
  /^\d+(?:[.,]\d+)?\s*(puntos?)?$/i.test(line);

const normalizePreviewOptionId = (index: number): string => OPTION_LETTERS[index]?.toLowerCase() ?? `opcion_${index + 1}`;

function parseExamQuestionsFromLines(lines: string[]): ExamTemplatePreviewQuestion[] {
  const questions: ExamTemplatePreviewQuestion[] = [];
  let i = 0;

  while (i < lines.length) {
    const start = isExamQuestionStartLine(lines[i] ?? "");
    if (!start) {
      i += 1;
      continue;
    }

    i += 1;
    const promptLines: string[] = [];
    if (start.prompt) {
      promptLines.push(start.prompt);
    } else if (start.consumesNextPrompt) {
      while (i < lines.length) {
        const nextLine = lines[i] ?? "";
        if (!nextLine || parseExamOptionLine(nextLine) || isAnswerOrScoreLine(nextLine)) break;
        if (isExamQuestionStartLine(nextLine)) break;
        promptLines.push(nextLine);
        i += 1;
        if (nextLine.includes("?") || nextLine.endsWith(":")) break;
      }
    }

    while (i < lines.length) {
      const line = lines[i] ?? "";
      if (parseExamOptionLine(line) || isAnswerOrScoreLine(line) || isExamQuestionStartLine(line)) break;
      promptLines.push(line);
      i += 1;
    }

    // El puntaje institucional (por ejemplo «1») no es otra pregunta.
    if (/^\d+(?:[.,]\d+)?(?:\s*puntos?)?$/i.test(lines[i] ?? "") && parseExamOptionLine(lines[i + 1] ?? "")) {
      i += 1;
    }

    const options: Array<{ id: string; text: string }> = [];
    const feedbackLines: string[] = [];
    while (i < lines.length) {
      const line = lines[i] ?? "";
      if (isExamQuestionStartLine(line)) break;
      const feedbackStart = parseFeedbackLine(line);
      if (feedbackStart !== null) {
        if (feedbackStart) feedbackLines.push(feedbackStart);
        i += 1;
        while (i < lines.length) {
          const feedbackLine = lines[i] ?? "";
          if (isExamQuestionStartLine(feedbackLine) || parseExamOptionLine(feedbackLine) || isAnswerOrScoreLine(feedbackLine)) {
            break;
          }
          feedbackLines.push(feedbackLine);
          i += 1;
        }
        continue;
      }
      if (isAnswerOrScoreLine(line)) {
        i += 1;
        continue;
      }

      const optionStart = parseExamOptionLine(line);
      if (!optionStart) {
        i += 1;
        continue;
      }

      i += 1;
      const optionTextLines = optionStart.text ? [optionStart.text] : [];
      while (i < lines.length) {
        const optionLine = lines[i] ?? "";
        if (
          parseExamOptionLine(optionLine) ||
          isAnswerOrScoreLine(optionLine) ||
          isExamQuestionStartLine(optionLine)
        ) {
          break;
        }
        optionTextLines.push(optionLine);
        i += 1;
      }

      const optionText = optionTextLines.join(" ").trim();
      if (optionText) {
        options.push({
          id: normalizePreviewOptionId(options.length),
          text: optionText,
        });
      }
    }

    const prompt = promptLines.join(" ").trim();
    if (prompt && options.length > 0) {
      questions.push({
        id: `preview_question_${questions.length + 1}`,
        prompt,
        options,
        feedback: feedbackLines.join(" ").trim() || undefined,
      });
    }
  }

  return questions;
}

function quizQuestionsToPreviewQuestions(quizQuestions: WordImportedQuizQuestion[]): ExamTemplatePreviewQuestion[] {
  return quizQuestions
    .filter((question) => question.prompt.trim() && question.options.length > 0)
    .map((question, questionIndex) => ({
      id: `preview_question_${questionIndex + 1}`,
      prompt: question.prompt.trim(),
      options: question.options
        .filter((option) => option.text.trim())
        .map((option, optionIndex) => ({
          id: normalizePreviewOptionId(optionIndex),
          text: option.text.trim(),
        })),
      feedback: question.explanation?.trim() || undefined,
    }));
}

export async function parseExamTemplatePreviewQuestions(file: File): Promise<ExamTemplatePreviewQuestion[]> {
  const rawText = await extractRawTextFromExamTemplateFile(file);
  const normalizedLines = rawText
    .split(/\r?\n/)
    .map(normalizeExamPreviewLine)
    .filter(Boolean);

  const parsedByExamFormat = parseExamQuestionsFromLines(normalizedLines);
  if (parsedByExamFormat.length > 0) return parsedByExamFormat;

  const lessons = parseWordCourseTemplate(rawText, "Plantilla de examen");
  const quizQuestions = lessons.flatMap((lesson) =>
    lesson.classes.flatMap((classItem) => classItem.quizQuestions ?? []),
  );
  return quizQuestionsToPreviewQuestions(quizQuestions);
}

function parseStructuredExamQuestionsFromLines(lines: string[]): GlobalExamQuestion[] {
  const questions: GlobalExamQuestion[] = [];
  let i = 0;

  while (i < lines.length) {
    const start = isExamQuestionStartLine(lines[i] ?? "");
    if (!start) {
      i += 1;
      continue;
    }

    i += 1;
    const promptLines: string[] = [];
    if (start.prompt) {
      promptLines.push(start.prompt);
    } else {
      while (i < lines.length) {
        const line = lines[i] ?? "";
        if (!line || parseExamOptionLine(line) || isAnswerOrScoreLine(line) || isExamQuestionStartLine(line)) break;
        promptLines.push(line);
        i += 1;
        if (line.includes("?") || line.endsWith(":")) break;
      }
    }

    while (i < lines.length) {
      const line = lines[i] ?? "";
      if (parseExamOptionLine(line) || isAnswerOrScoreLine(line) || isExamQuestionStartLine(line)) break;
      promptLines.push(line);
      i += 1;
    }

    // El puntaje institucional (por ejemplo «1») no es otra pregunta.
    if (/^\d+(?:[.,]\d+)?(?:\s*puntos?)?$/i.test(lines[i] ?? "") && parseExamOptionLine(lines[i + 1] ?? "")) {
      i += 1;
    }

    const options: Array<{ id: string; text: string; sourceLetter: string }> = [];
    let correctLetter = "";
    const feedbackLines: string[] = [];
    while (i < lines.length) {
      const line = lines[i] ?? "";
      const nextQuestion = isExamQuestionStartLine(line);
      if (nextQuestion) break;

      const feedbackStart = parseFeedbackLine(line);
      if (feedbackStart !== null) {
        if (feedbackStart) feedbackLines.push(feedbackStart);
        i += 1;
        while (i < lines.length) {
          const feedbackLine = lines[i] ?? "";
          if (
            isExamQuestionStartLine(feedbackLine) ||
            parseExamOptionLine(feedbackLine) ||
            /^respuesta\s+correcta\s*:/i.test(feedbackLine) ||
            isAnswerOrScoreLine(feedbackLine)
          ) {
            break;
          }
          feedbackLines.push(feedbackLine);
          i += 1;
        }
        continue;
      }

      const answerMatch = line.match(/^respuesta\s+correcta\s*:\s*([A-Fa-f])/i);
      if (answerMatch) {
        correctLetter = answerMatch[1].toUpperCase();
        i += 1;
        continue;
      }

      const optionStart = parseExamOptionLine(line);
      if (!optionStart) {
        i += 1;
        continue;
      }

      i += 1;
      const optionTextLines = optionStart.text ? [optionStart.text] : [];
      while (i < lines.length) {
        const optionLine = lines[i] ?? "";
        if (
          parseExamOptionLine(optionLine) ||
          /^respuesta\s+correcta\s*:/i.test(optionLine) ||
          isAnswerOrScoreLine(optionLine) ||
          isExamQuestionStartLine(optionLine)
        ) {
          break;
        }
        optionTextLines.push(optionLine);
        i += 1;
      }

      if (/^correcta$/i.test(lines[i] ?? "")) {
        correctLetter = optionStart.letter;
        i += 1;
      }

      const optionText = optionTextLines.join(" ").trim();
      if (optionText) {
        options.push({
          id: normalizePreviewOptionId(options.length),
          text: optionText,
          sourceLetter: optionStart.letter,
        });
      }
    }

    const prompt = promptLines.join(" ").trim();
    const correctOption =
      options.find((option) => option.sourceLetter === correctLetter) ?? options[0] ?? null;
    if (prompt && options.length > 0 && correctOption) {
      questions.push({
        id: `question_${questions.length + 1}`,
        prompt,
        options: options.map(({ id, text }) => ({ id, text })),
        correctOptionId: correctOption.id,
        feedback: feedbackLines.join(" ").trim(),
      });
    }
  }

  return questions;
}

function quizQuestionsToGlobalExamQuestions(quizQuestions: WordImportedQuizQuestion[]): GlobalExamQuestion[] {
  return quizQuestions
    .map((question, questionIndex): GlobalExamQuestion | null => {
      const options = question.options
        .filter((option) => option.text.trim())
        .map((option, optionIndex) => ({
          id: normalizePreviewOptionId(optionIndex),
          text: option.text.trim(),
          isCorrect: option.isCorrect,
        }));
      const correctOption = options.find((option) => option.isCorrect) ?? options[0] ?? null;
      if (!question.prompt.trim() || options.length === 0 || !correctOption) return null;
      return {
        id: `question_${questionIndex + 1}`,
        prompt: question.prompt.trim(),
        options: options.map(({ id, text }) => ({ id, text })),
        correctOptionId: correctOption.id,
        feedback: question.explanation?.trim() || "",
      };
    })
    .filter((question): question is GlobalExamQuestion => question !== null);
}

export async function parseGlobalExamQuestionsFromTemplateFile(file: File): Promise<GlobalExamQuestion[]> {
  const rawText = await extractRawTextFromExamTemplateFile(file);
  const normalizedLines = rawText
    .split(/\r?\n/)
    .map(normalizeExamPreviewLine)
    .filter(Boolean);

  const parsedByExamFormat = parseStructuredExamQuestionsFromLines(normalizedLines);
  if (parsedByExamFormat.length > 0) return parsedByExamFormat;

  const lessons = parseWordCourseTemplate(rawText, "Plantilla de examen");
  const quizQuestions = lessons.flatMap((lesson) =>
    lesson.classes.flatMap((classItem) => classItem.quizQuestions ?? []),
  );
  return quizQuestionsToGlobalExamQuestions(quizQuestions);
}


export type WordImportedClass = {
  title: string;
  type: "video" | "text" | "quiz";
  videoUrl?: string;
  content?: string;
  quizQuestions?: WordImportedQuizQuestion[];
  hasAssignment?: boolean;
  assignmentSubmissionType?: "file" | "audio";
  forumEnabled?: boolean;
  forumRequiredFormat?: "text" | "audio" | "video" | null;
};

export type WordImportedLesson = {
  title: string;
  classes: WordImportedClass[];
};

export type WordImportedQuizQuestion = {
  prompt: string;
  options: Array<{
    text: string;
    isCorrect: boolean;
  }>;
  explanation?: string;
  pointValue?: number;
  type?: "multiple" | "truefalse" | "open";
  answerText?: string;
};

type LessonSection = {
  title: string;
  lines: string[];
};

const WEEK_HEADING_REGEX = /^semana\s*\d+/i;
const URL_REGEX = /https?:\/\/[^\s<>()]+/i;
const VIDEO_HOSTS = new Set(["vimeo.com", "www.vimeo.com", "youtu.be", "youtube.com", "www.youtube.com"]);
const ASSIGNMENT_KEYWORDS_REGEX =
  /\b(tarea|trabajo\s+final|actividad\s+integradora|proyecto\s+final|entrega|evidencia)\b/i;
const FORUM_KEYWORDS_REGEX = /\b(foro|discusion|debate)\b/i;
const AUDIO_KEYWORDS_REGEX = /\b(audio|podcast|nota\s+de\s+voz|grabacion\s+de\s+voz)\b/i;
const VIDEO_KEYWORDS_REGEX = /\b(video|vimeo|youtube|camara|grabacion\s+en\s+video)\b/i;

function normalizeLine(line: string): string {
  return line.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeForKeywordSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function inferClassEngagementFlags(params: {
  title: string;
  lines?: string[];
}): Pick<
  WordImportedClass,
  "hasAssignment" | "assignmentSubmissionType" | "forumEnabled" | "forumRequiredFormat"
> {
  const combinedText = normalizeForKeywordSearch(
    [params.title, ...(params.lines ?? [])].filter(Boolean).join("\n"),
  );

  const hasAssignment = ASSIGNMENT_KEYWORDS_REGEX.test(combinedText);
  const forumEnabled = FORUM_KEYWORDS_REGEX.test(combinedText);

  const flags: Pick<
    WordImportedClass,
    "hasAssignment" | "assignmentSubmissionType" | "forumEnabled" | "forumRequiredFormat"
  > = {};

  if (hasAssignment) {
    flags.hasAssignment = true;
    flags.assignmentSubmissionType = AUDIO_KEYWORDS_REGEX.test(combinedText) ? "audio" : "file";
  }

  if (forumEnabled) {
    flags.forumEnabled = true;
    if (AUDIO_KEYWORDS_REGEX.test(combinedText)) {
      flags.forumRequiredFormat = "audio";
    } else if (VIDEO_KEYWORDS_REGEX.test(combinedText)) {
      flags.forumRequiredFormat = "video";
    } else {
      flags.forumRequiredFormat = "text";
    }
  }

  return flags;
}

function cleanupUrl(value: string): string {
  return value.replace(/[),.;]+$/g, "").trim();
}

function extractUrl(line: string): string | null {
  const match = line.match(URL_REGEX);
  if (!match) return null;
  return cleanupUrl(match[0]);
}

function isVideoUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return VIDEO_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return /vimeo\.com|youtu\.be|youtube\.com/i.test(url);
  }
}

function isLikelyHeading(line: string): boolean {
  if (!line || line.length > 90) return false;
  if (extractUrl(line)) return false;
  if (/^semana\s*\d+/i.test(line)) return true;
  if (/^tarea\b/i.test(line)) return true;
  if (/^trabajo final\b/i.test(line)) return true;
  if (/^instrucciones:?$/i.test(line)) return true;
  if (line.endsWith(":")) return true;
  const alpha = line.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g, "");
  if (!alpha) return false;
  return alpha === alpha.toUpperCase();
}

function splitIntoSections(lines: string[], fallbackTitle: string): LessonSection[] {
  const headingIndexes = lines
    .map((line, index) => (WEEK_HEADING_REGEX.test(line) ? index : -1))
    .filter((value) => value >= 0);

  if (headingIndexes.length === 0) {
    return [{ title: fallbackTitle, lines }];
  }

  const sections: LessonSection[] = [];
  let cursor = 0;
  for (let i = 0; i < headingIndexes.length; i += 1) {
    const headingIndex = headingIndexes[i];
    const nextHeading = headingIndexes[i + 1] ?? lines.length;

    if (cursor < headingIndex) {
      const preamble = lines.slice(cursor, headingIndex).filter(Boolean);
      if (preamble.length > 0) {
        sections.push({
          title: fallbackTitle,
          lines: preamble,
        });
      }
    }

    const heading = lines[headingIndex] ?? "";
    const blockLines = lines.slice(headingIndex + 1, nextHeading).filter(Boolean);
    sections.push({
      title: heading || fallbackTitle,
      lines: blockLines,
    });
    cursor = nextHeading;
  }

  return sections.filter((section) => section.lines.length > 0);
}

function isOptionMarker(line: string): boolean {
  return /^[a-d]\)$/i.test(line);
}

function isPointValueLine(line: string): boolean {
  return /^\d+(?:[.,]\d+)?$/.test(line);
}

function parsePointValue(line: string): number | undefined {
  if (!isPointValueLine(line)) return undefined;
  const value = Number(line.replace(",", "."));
  if (!Number.isFinite(value)) return undefined;
  return value;
}

function isQuestionStart(lines: string[], index: number): boolean {
  const current = lines[index] ?? "";
  if (!/^\d{1,3}$/.test(current)) return false;
  const next = lines[index + 1] ?? "";
  if (!next) return false;
  if (isOptionMarker(next) || isPointValueLine(next) || /^correcta$/i.test(next)) return false;
  const hasLetters = /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ¿?]/.test(next);
  if (!hasLetters) return false;
  if (next.includes("?") || next.includes("¿") || next.endsWith(":")) return true;
  return next.length >= 12;
}

function findFirstQuestionStart(lines: string[]): number {
  for (let i = 0; i < lines.length; i += 1) {
    if (isQuestionStart(lines, i)) return i;
  }
  return -1;
}

function pickTitleBeforeUrl(buffer: string[]): { title: string | null; remaining: string[] } {
  for (let i = buffer.length - 1; i >= 0; i -= 1) {
    const candidate = buffer[i] ?? "";
    if (!candidate) continue;
    if (extractUrl(candidate)) continue;
    if (/^\d+(\.\d+)?$/.test(candidate)) continue;
    if (candidate.length > 80) continue;
    const wordCount = candidate.split(/\s+/).filter(Boolean).length;
    if (wordCount > 10 && !isLikelyHeading(candidate)) continue;
    if (i < buffer.length - 2) continue;

    if (isLikelyHeading(candidate) || !/[.!?]$/.test(candidate)) {
      const remaining = [...buffer];
      remaining.splice(i, 1);
      return { title: candidate.replace(/:$/, "").trim(), remaining };
    }
    break;
  }
  return { title: null, remaining: [...buffer] };
}

function buildTextClass(lines: string[], textIndex: number): WordImportedClass | null {
  const normalized = lines.map(normalizeLine).filter(Boolean);
  if (normalized.length === 0) return null;

  let title = `Lectura ${textIndex}`;
  let contentLines = normalized;

  const first = normalized[0] ?? "";
  if (/^tarea\b/i.test(first)) {
    title = first.replace(/:$/, "");
    contentLines = normalized.slice(1);
  } else if (/^trabajo final\b/i.test(first)) {
    title = first.replace(/:$/, "");
    contentLines = normalized.slice(1);
  } else if (isLikelyHeading(first) && normalized.length > 1) {
    title = first.replace(/:$/, "");
    contentLines = normalized.slice(1);
  }

  const content = (contentLines.length > 0 ? contentLines : normalized).join("\n\n").trim();
  const engagementFlags = inferClassEngagementFlags({
    title,
    lines: normalized,
  });
  if (!content && !engagementFlags.hasAssignment && !engagementFlags.forumEnabled) return null;

  return {
    title,
    type: "text",
    content: content || "Actividad importada desde plantilla Word",
    ...engagementFlags,
  };
}

function buildVideoClass(params: {
  title: string;
  videoUrl: string;
  descriptionLines: string[];
  videoIndex: number;
}): WordImportedClass {
  const { title, videoUrl, descriptionLines, videoIndex } = params;
  const description = descriptionLines.join("\n\n").trim();
  const engagementFlags = inferClassEngagementFlags({
    title,
    lines: descriptionLines.length > 0 ? descriptionLines : [videoUrl],
  });

  return {
    title: title || `Video ${videoIndex}`,
    type: "video",
    videoUrl,
    content: description || undefined,
    ...engagementFlags,
  };
}

function parseQuizQuestions(lines: string[]): WordImportedQuizQuestion[] {
  const questions: WordImportedQuizQuestion[] = [];
  let i = 0;

  while (i < lines.length) {
    while (i < lines.length && !isQuestionStart(lines, i)) i += 1;
    if (i >= lines.length) break;

    i += 1; // saltar número de pregunta

    const promptLines: string[] = [];
    while (i < lines.length) {
      const line = lines[i] ?? "";
      if (isPointValueLine(line) || isOptionMarker(line) || isQuestionStart(lines, i)) break;
      promptLines.push(line);
      i += 1;
    }

    const pointValue = parsePointValue(lines[i] ?? "");
    if (pointValue !== undefined) i += 1;

    const options: Array<{ text: string; isCorrect: boolean }> = [];
    while (i < lines.length && isOptionMarker(lines[i] ?? "")) {
      i += 1; // saltar marcador a)/b)/c)
      const optionTextLines: string[] = [];
      let isCorrect = false;

      while (i < lines.length) {
        const line = lines[i] ?? "";
        if (/^correcta$/i.test(line)) {
          isCorrect = true;
          i += 1;
          break;
        }
        if (isOptionMarker(line) || isQuestionStart(lines, i)) break;
        optionTextLines.push(line);
        i += 1;

        const nextLine = lines[i] ?? "";
        if (
          nextLine &&
          !/^correcta$/i.test(nextLine) &&
          !isOptionMarker(nextLine) &&
          !isQuestionStart(lines, i) &&
          optionTextLines.length > 0
        ) {
          const lastLine = optionTextLines[optionTextLines.length - 1] ?? "";
          const looksLikeExplanationStart = /^[A-ZÁÉÍÓÚÜÑ¿]/.test(nextLine) && /[.!?]$/.test(lastLine);
          if (looksLikeExplanationStart) break;
        }
      }

      const optionText = optionTextLines.join(" ").trim();
      if (optionText) {
        options.push({ text: optionText, isCorrect });
      }
    }

    const explanationLines: string[] = [];
    while (i < lines.length && !isQuestionStart(lines, i)) {
      const line = lines[i] ?? "";
      if (isOptionMarker(line)) break;
      explanationLines.push(line);
      i += 1;
    }

    const prompt = promptLines.join(" ").trim();
    const explanation = explanationLines.join(" ").trim();
    if (!prompt) continue;

    const filteredOptions = options.filter((option) => option.text.trim().length > 0);
    const hasCorrect = filteredOptions.some((option) => option.isCorrect);
    if (!hasCorrect && filteredOptions.length > 0) {
      filteredOptions[0]!.isCorrect = true;
    }

    const maybeTrueFalse =
      filteredOptions.length === 2 &&
      filteredOptions.every((option) =>
        /^(verdadero|falso|true|false)\b/i.test(option.text),
      );

    questions.push({
      prompt,
      options: filteredOptions,
      explanation: explanation || undefined,
      pointValue,
      type: maybeTrueFalse ? "truefalse" : "multiple",
    });
  }

  return questions;
}

function splitBufferIntoTextAndQuiz(
  lines: string[],
  textCounter: number,
): { classes: WordImportedClass[]; nextTextCounter: number } {
  const normalized = lines.map(normalizeLine).filter(Boolean);
  if (normalized.length === 0) {
    return { classes: [], nextTextCounter: textCounter };
  }

  const firstQuestionIndex = findFirstQuestionStart(normalized);
  if (firstQuestionIndex === -1) {
    const textClass = buildTextClass(normalized, textCounter);
    return {
      classes: textClass ? [textClass] : [],
      nextTextCounter: textClass ? textCounter + 1 : textCounter,
    };
  }

  const classes: WordImportedClass[] = [];
  let nextTextCounter = textCounter;

  const preQuizLines = normalized.slice(0, firstQuestionIndex);
  const preQuizClass = buildTextClass(preQuizLines, nextTextCounter);
  if (preQuizClass) {
    classes.push(preQuizClass);
    nextTextCounter += 1;
  }

  const quizLines = normalized.slice(firstQuestionIndex);
  const questions = parseQuizQuestions(quizLines);
  if (questions.length > 0) {
    const quizFlags = inferClassEngagementFlags({
      title: "Cuestionario",
      lines: quizLines,
    });
    classes.push({
      title: "Cuestionario",
      type: "quiz",
      content: "Cuestionario importado desde plantilla Word",
      quizQuestions: questions,
      ...quizFlags,
    });
    return { classes, nextTextCounter };
  }

  const fallbackClass = buildTextClass(normalized, nextTextCounter);
  return {
    classes: fallbackClass ? [fallbackClass] : [],
    nextTextCounter: fallbackClass ? nextTextCounter + 1 : nextTextCounter,
  };
}

function buildClasses(sectionLines: string[]): WordImportedClass[] {
  const classes: WordImportedClass[] = [];
  let buffer: string[] = [];
  let textCounter = 1;
  let videoCounter = 1;
  let resourceCounter = 1;

  const flushTextBuffer = () => {
    const result = splitBufferIntoTextAndQuiz(buffer, textCounter);
    buffer = [];
    if (result.classes.length === 0) return;
    classes.push(...result.classes);
    textCounter = result.nextTextCounter;
  };

  for (const rawLine of sectionLines) {
    const line = normalizeLine(rawLine);
    if (!line) continue;
    const url = extractUrl(line);
    if (!url) {
      buffer.push(line);
      continue;
    }

    const { title, remaining } = pickTitleBeforeUrl(buffer);

    if (isVideoUrl(url)) {
      classes.push(
        buildVideoClass({
          title: title || `Video ${videoCounter}`,
          videoUrl: url,
          descriptionLines: remaining,
          videoIndex: videoCounter,
        }),
      );
      buffer = [];
      videoCounter += 1;
      continue;
    }

    buffer = remaining;
    flushTextBuffer();

    const resolvedTitle = title ? `Recurso: ${title}` : `Recurso externo ${resourceCounter}`;
    const engagementFlags = inferClassEngagementFlags({
      title: resolvedTitle,
      lines: [line],
    });
    classes.push({
      title: resolvedTitle,
      type: "text",
      content: url,
      ...engagementFlags,
    });
    resourceCounter += 1;
  }

  flushTextBuffer();
  return classes;
}

export function parseWordCourseTemplate(rawText: string, fallbackLessonTitle: string): WordImportedLesson[] {
  const lines = rawText
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter(Boolean);

  if (lines.length === 0) return [];

  const sections = splitIntoSections(lines, fallbackLessonTitle);
  const lessons = sections
    .map((section, index) => {
      const classes = buildClasses(section.lines);
      return {
        title: section.title || `${fallbackLessonTitle} ${index + 1}`,
        classes,
      };
    })
    .filter((lesson) => lesson.classes.length > 0);

  if (lessons.length > 0) return lessons;

  const singleLessonClasses = buildClasses(lines);
  if (singleLessonClasses.length === 0) return [];
  return [
    {
      title: fallbackLessonTitle,
      classes: singleLessonClasses,
    },
  ];
}

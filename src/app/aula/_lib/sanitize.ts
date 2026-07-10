import sanitizeHtml from "sanitize-html";

/** Mismas reglas de saneado que aplica el feed clásico al contenido de la clase. */
const options = {
  allowedTags: [
    "p",
    "br",
    "strong",
    "em",
    "u",
    "s",
    "ul",
    "ol",
    "li",
    "blockquote",
    "a",
    "img",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "span",
    "div",
  ],
  allowedAttributes: {
    a: ["href", "target", "rel"],
    img: ["src", "alt", "title", "width", "height", "style"],
    span: ["style"],
    div: ["style"],
    p: ["style"],
    h1: ["style"],
    h2: ["style"],
    h3: ["style"],
    h4: ["style"],
    h5: ["style"],
    h6: ["style"],
  },
  allowedStyles: {
    "*": {
      "text-align": [/^left$|^right$|^center$|^justify$/],
      "margin-left": [/^auto$|^[0-9.]+(px|%|rem|em)$/],
      "margin-right": [/^auto$|^[0-9.]+(px|%|rem|em)$/],
      width: [/^(auto|[0-9.]+(px|%|rem|em))$/],
      height: [/^(auto|[0-9.]+(px|%|rem|em))$/],
      display: [/^block$|^inline-block$|^inline$|^flex$/],
      "object-fit": [/^contain$|^cover$|^fill$|^none$/],
    },
  },
  allowedSchemes: ["http", "https", "data", "mailto"],
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noopener noreferrer" }),
  },
};

export const sanitizeClassContent = (html: string) => sanitizeHtml(html, options);
